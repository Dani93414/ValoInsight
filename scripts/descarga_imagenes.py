#!/usr/bin/env python3
import argparse
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from pymongo import MongoClient
from PIL import Image, ImageOps, UnidentifiedImageError


TIMEOUT = 10
OVERWRITE = False
DEFAULT_DOWNLOAD_WORKERS = int(os.getenv("IMAGE_DOWNLOAD_WORKERS", "8"))
CONTENT_COLLECTION_NAME = "content"
DEFAULT_CHANGES_FILE = Path(__file__).resolve().parent / "last_incremental_content_changes.json"

IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
    ".bmp", ".ico", ".tif", ".tiff", ".avif"
}

CONTENT_TYPE_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "image/tiff": ".tif",
    "image/avif": ".avif",
}

stats = {
    "documents_scanned": 0,
    "collections_found": 0,
    "found_urls": 0,
    "downloaded": 0,
    "skipped_existing": 0,
    "skipped_non_image": 0,
    "errors": 0,
    "derivatives": 0,
}

jobs = []
queued_targets = set()
ONLY_CHANGED_IDS_BY_COLLECTION = {}
CHANGED_SKINS_BY_WEAPON = {}
OVERWRITE_RUNTIME = OVERWRITE
GENERATE_DERIVATIVES_RUNTIME = True
STATS_LOCK = Lock()

DERIVATIVE_SIZES = {"thumb": 384, "medium": 960}


def increment_stat(name, amount=1):
    with STATS_LOCK:
        stats[name] += amount


def generate_image_derivatives(path: str | Path, *, overwrite: bool = False) -> int:
    """Create responsive WebP assets while preserving the original image."""
    source = Path(path)
    supported = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
    if source.suffix.lower() not in supported:
        return 0
    created = 0
    try:
        with Image.open(source) as opened:
            if getattr(opened, "is_animated", False):
                return 0
            base = ImageOps.exif_transpose(opened)
            for label, max_dimension in DERIVATIVE_SIZES.items():
                target = source.with_name(f"{source.stem}.{label}.webp")
                if target.exists() and not overwrite:
                    continue
                image = base.copy()
                image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
                if image.mode not in {"RGB", "RGBA"}:
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                image.save(target, "WEBP", quality=82, method=4)
                created += 1
    except (UnidentifiedImageError, OSError, ValueError):
        return 0
    return created


def generate_existing_derivatives(root: Path, *, workers: int, overwrite: bool) -> None:
    candidates = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and ".thumb." not in path.name
        and ".medium." not in path.name
        and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
    ]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(generate_image_derivatives, path, overwrite=overwrite)
            for path in candidates
        ]
        for future in as_completed(futures):
            increment_stat("derivatives", future.result())


def is_plain_object(value):
    return isinstance(value, dict)


def sanitize_segment(value):
    text = str(value if value is not None else "item").strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text)
    text = text.strip("._")
    return text[:120] if text else "item"


def pick_object_folder_name(obj, index=0):
    if not is_plain_object(obj):
        return f"item_{index}"

    candidate = (
        obj.get("uuid")
        or obj.get("id")
        or obj.get("_id")
        or obj.get("relationUuid")
        or obj.get("levelUuid")
        or obj.get("themeUuid")
        or obj.get("displayName")
        or obj.get("name")
        or obj.get("tierName")
        or obj.get("divisionName")
        or obj.get("displayNameAllCaps")
        or obj.get("developerName")
        or obj.get("assetObjectName")
    )

    return sanitize_segment(candidate) if candidate else f"item_{index}"


def build_file_base_name(field_name, index=None):
    base = sanitize_segment(field_name or "image")
    return base if index is None else f"{base}__{index}"


def content_type_to_extension(content_type):
    if not content_type:
        return None
    content_type = content_type.split(";")[0].strip().lower()
    return CONTENT_TYPE_TO_EXT.get(content_type)


def url_to_extension(url):
    try:
        parsed = urlparse(url)
        ext = Path(parsed.path).suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
        if ext in IMAGE_EXTENSIONS:
            return ext
    except Exception:
        pass
    return ".img"


def looks_like_image_url(value):
    if not isinstance(value, str):
        return False

    value = value.strip()
    if not value.lower().startswith("https://"):
        return False

    try:
        parsed = urlparse(value)
        ext = Path(parsed.path).suffix.lower()

        if ext == ".jpeg":
            ext = ".jpg"

        # Si la URL trae una extensión de imagen conocida, aceptamos
        if ext in IMAGE_EXTENSIONS:
            return True

        # Si trae otra extensión (.mp4, .json, etc.), descartamos
        if ext:
            return False

        # Si no trae extensión, la dejamos pasar y validamos luego por Content-Type
        return True

    except Exception:
        return True


def already_downloaded(file_base_path):
    parent = Path(file_base_path).parent
    stem = Path(file_base_path).name

    if not parent.exists():
        return False

    return any(parent.glob(f"{stem}.*"))


def enqueue_download(url, file_base_path):
    unique_key = f"{url} -> {file_base_path}"
    if unique_key in queued_targets:
        return

    queued_targets.add(unique_key)
    jobs.append((url, file_base_path))
    stats["found_urls"] += 1


def load_changes_filter(path: Path) -> tuple[dict[str, set[str]], dict[str, dict]]:
    if not path.exists():
        return {}, {}

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}, {}

    changed = payload.get("changed_items") or {}
    result: dict[str, set[str]] = {}
    for collection_name, data in changed.items():
        ids = set((data or {}).get("added", []) + (data or {}).get("updated", []))
        if ids:
            result[str(collection_name)] = ids

    weapon_details = (payload.get("changed_children") or {}).get("weapons") or {}
    return result, weapon_details


def walk_changed_weapon_skins(weapon, weapon_dir, change_detail):
    if change_detail.get("parent_updated"):
        walk_node(weapon, str(weapon_dir))
        return

    skin_changes = change_detail.get("skins") or {}
    changed_skin_ids = set(skin_changes.get("added", []) + skin_changes.get("updated", []))
    for index, skin in enumerate(weapon.get("skins") or []):
        if not isinstance(skin, dict):
            continue
        skin_id = skin.get("uuid") or skin.get("id") or skin.get("_id")
        if not skin_id or str(skin_id) not in changed_skin_ids:
            continue
        skin_dir = weapon_dir / "skins" / pick_object_folder_name(skin, index)
        walk_node(skin, str(skin_dir))


def walk_node(node, current_dir, field_name=None, index_in_array=None):
    if node is None:
        return

    if isinstance(node, str):
        if looks_like_image_url(node):
            file_base_name = build_file_base_name(field_name, index_in_array)
            enqueue_download(node, os.path.join(current_dir, file_base_name))
        return

    if isinstance(node, list):
        for i, item in enumerate(node):
            if item is None:
                continue

            if isinstance(item, str):
                walk_node(item, current_dir, field_name, i)

            elif isinstance(item, list):
                nested_dir = os.path.join(
                    current_dir,
                    sanitize_segment(field_name or "items"),
                    f"item_{i}"
                )
                walk_node(item, nested_dir, field_name, i)

            elif isinstance(item, dict):
                item_dir = os.path.join(
                    current_dir,
                    sanitize_segment(field_name or "items"),
                    pick_object_folder_name(item, i)
                )
                walk_node(item, item_dir)
        return

    if isinstance(node, dict):
        for key, value in node.items():
            if value is None:
                continue

            if isinstance(value, str):
                walk_node(value, current_dir, key)

            elif isinstance(value, list):
                walk_node(value, current_dir, key)

            elif isinstance(value, dict):
                nested_dir = os.path.join(current_dir, sanitize_segment(key))
                walk_node(value, nested_dir)


def download_image(url, file_base_path):
    try:
        if not OVERWRITE_RUNTIME and already_downloaded(file_base_path):
            increment_stat("skipped_existing")
            return

        response = requests.get(url, allow_redirects=True, timeout=TIMEOUT, stream=True)
        response.raise_for_status()

        content_type = response.headers.get("Content-Type", "")
        if content_type and not content_type.lower().startswith("image/"):
            increment_stat("skipped_non_image")
            response.close()
            return

        final_ext = (
            content_type_to_extension(content_type)
            or url_to_extension(response.url or url)
            or ".img"
        )

        output_path = f"{file_base_path}{final_ext}"

        if not OVERWRITE_RUNTIME and already_downloaded(file_base_path):
            increment_stat("skipped_existing")
            response.close()
            return

        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        with open(output_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        response.close()

        increment_stat("downloaded")
        if GENERATE_DERIVATIVES_RUNTIME:
            increment_stat(
                "derivatives",
                generate_image_derivatives(
                    output_path,
                    overwrite=OVERWRITE_RUNTIME,
                ),
            )
        print(f"✅ {os.path.relpath(output_path)}")

    except requests.RequestException as e:
        increment_stat("errors")
        print(f"❌ Error descargando {url}")
        print(f"   {e}")

    except Exception as e:
        increment_stat("errors")
        print(f"❌ Error inesperado con {url}")
        print(f"   {e}")


def get_database():
    load_dotenv()

    db_uri = os.getenv("DB_URI")
    db_name = os.getenv("DB_NAME")

    if not db_uri:
        raise RuntimeError("Falta DB_URI en el archivo .env")
    if not db_name:
        raise RuntimeError("Falta DB_NAME en el archivo .env")

    client = MongoClient(db_uri)
    db = client[db_name]
    return client, db


def collect_all_content_from_content_collection(db):
    """
    Lee todos los documentos de la colección 'content' y junta
    todos los campos raíz (agents, maps, weapons, buddies, etc.).
    """
    content_collection = db[CONTENT_COLLECTION_NAME]

    aggregated = {}

    for doc in content_collection.find({}):
        stats["documents_scanned"] += 1

        for key, value in doc.items():
            if key == "_id":
                continue

            if isinstance(value, (list, dict)):
                aggregated[key] = value

    return aggregated


def main():
    global ONLY_CHANGED_IDS_BY_COLLECTION, CHANGED_SKINS_BY_WEAPON
    global OVERWRITE_RUNTIME, GENERATE_DERIVATIVES_RUNTIME
    parser = argparse.ArgumentParser(description="Descarga imágenes referenciadas desde content en MongoDB.")
    parser.add_argument(
        "--only-changed",
        action="store_true",
        help="Descarga solo para elementos changed (added/updated) del reporte incremental.",
    )
    parser.add_argument(
        "--changes-file",
        default=str(DEFAULT_CHANGES_FILE),
        help="Ruta al JSON de cambios generado por fetch_data_incremental.py.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sobrescribe imágenes ya existentes.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_DOWNLOAD_WORKERS,
        help=f"Descargas de imágenes simultáneas (default: {DEFAULT_DOWNLOAD_WORKERS}).",
    )
    parser.add_argument(
        "--no-derivatives",
        action="store_true",
        help="No genera variantes WebP thumb/medium tras cada descarga.",
    )
    parser.add_argument(
        "--derivatives-only",
        action="store_true",
        help="Genera variantes para imagenes existentes sin consultar Mongo.",
    )
    args = parser.parse_args()

    if args.workers <= 0:
        parser.error("--workers debe ser mayor que 0")

    OVERWRITE_RUNTIME = bool(args.overwrite)
    GENERATE_DERIVATIVES_RUNTIME = not args.no_derivatives
    if args.only_changed:
        ONLY_CHANGED_IDS_BY_COLLECTION, CHANGED_SKINS_BY_WEAPON = load_changes_filter(Path(args.changes_file))
        OVERWRITE_RUNTIME = True

    project_root = Path(__file__).resolve().parent.parent
    public_path = (project_root / "frontend" / "public").resolve()
    output_root = public_path / "content"

    if args.derivatives_only:
        print(f"Generando variantes WebP en {output_root}...")
        generate_existing_derivatives(
            output_root,
            workers=args.workers,
            overwrite=OVERWRITE_RUNTIME,
        )
        print(f"Variantes generadas: {stats['derivatives']}")
        return

    print("Cargando .env y conectando a MongoDB...")

    client, db = get_database()

    try:
        print(f"Base de datos: {db.name}")
        print(f"Colección origen: {CONTENT_COLLECTION_NAME}")

        if CONTENT_COLLECTION_NAME not in db.list_collection_names():
            print(f"No existe la colección '{CONTENT_COLLECTION_NAME}' en la base de datos.")
            return

        collections = collect_all_content_from_content_collection(db)

        if not collections:
            print("No se encontraron campos tipo agents/maps/weapons/etc dentro de la colección content.")
            return

        stats["collections_found"] = len(collections)
        print(f"Bloques encontrados dentro de content: {list(collections.keys())}")
        if args.only_changed:
            print(f"Filtro cambios activo (archivo): {args.changes_file}")

        for collection_name, collection_value in collections.items():
            if collection_value is None:
                continue

            collection_dir = output_root / sanitize_segment(collection_name)
            allowed_ids = ONLY_CHANGED_IDS_BY_COLLECTION.get(collection_name, set()) if args.only_changed else set()

            if isinstance(collection_value, list):
                print(f"\n📁 Procesando colección: {collection_name} ({len(collection_value)} elementos)")
                for index, item in enumerate(collection_value):
                    if isinstance(item, dict):
                        if args.only_changed:
                            identity_value = (
                                item.get("uuid")
                                or item.get("id")
                                or item.get("_id")
                                or item.get("relationUuid")
                                or item.get("levelUuid")
                                or item.get("themeUuid")
                                or item.get("assetObjectName")
                            )
                            if not identity_value or str(identity_value) not in allowed_ids:
                                continue
                        object_dir = collection_dir / pick_object_folder_name(item, index)
                        if (
                            args.only_changed
                            and collection_name == "weapons"
                            and str(identity_value) in CHANGED_SKINS_BY_WEAPON
                        ):
                            walk_changed_weapon_skins(
                                item,
                                object_dir,
                                CHANGED_SKINS_BY_WEAPON[str(identity_value)],
                            )
                            continue
                        walk_node(item, str(object_dir))
                    else:
                        if args.only_changed:
                            continue
                        walk_node(item, str(collection_dir), collection_name, index)

            elif isinstance(collection_value, dict):
                if args.only_changed:
                    continue
                print(f"\n📁 Procesando objeto raíz: {collection_name}")
                walk_node(collection_value, str(collection_dir))

        print(f"\nURLs encontradas: {stats['found_urls']}")
        print(f"Iniciando descargas con {args.workers} workers...\n")

        total_jobs = len(jobs)
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [
                executor.submit(download_image, url, file_base_path)
                for url, file_base_path in jobs
            ]

            for i, future in enumerate(as_completed(futures), start=1):
                future.result()

                if i % 100 == 0 or i == total_jobs:
                    print(
                        f"[{i}/{total_jobs}] "
                        f"descargadas={stats['downloaded']} "
                        f"existentes={stats['skipped_existing']} "
                        f"no_imagen={stats['skipped_non_image']} "
                        f"errores={stats['errors']}"
                    )

        print("\n----- RESUMEN -----")
        print(f"Documentos revisados:    {stats['documents_scanned']}")
        print(f"Bloques detectados:      {stats['collections_found']}")
        print(f"URLs detectadas:         {stats['found_urls']}")
        print(f"Imágenes descargadas:    {stats['downloaded']}")
        print(f"Ya existentes:           {stats['skipped_existing']}")
        print(f"No eran imagen:          {stats['skipped_non_image']}")
        print(f"Errores:                 {stats['errors']}")
        print(f"Variantes WebP:          {stats['derivatives']}")

    finally:
        client.close()


if __name__ == "__main__":
    main()
