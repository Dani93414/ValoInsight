from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import joblib

from .schemas import SCHEMA_VERSION

ARTIFACTS_DIR = Path(__file__).parent / "artifacts"
METADATA_PATH = ARTIFACTS_DIR / "metadata.json"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def model_path(scope: str, value: str | None = None, artifacts_dir: Path | None = None) -> Path:
    root = artifacts_dir or ARTIFACTS_DIR
    if scope == "global":
        return root / "global_model.joblib"
    return root / f"{scope}_{_slug(value or 'unknown')}.joblib"


def save_model(
    bundle: dict, scope: str, value: str | None = None, artifacts_dir: Path | None = None
) -> Path:
    path = model_path(scope, value, artifacts_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path)
    return path


def load_metadata() -> dict:
    if not METADATA_PATH.exists():
        return {}
    try:
        return json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_metadata(metadata: dict, artifacts_dir: Path | None = None) -> None:
    root = artifacts_dir or ARTIFACTS_DIR
    root.mkdir(parents=True, exist_ok=True)
    target = root / "metadata.json"
    temporary = root / ".metadata.json.tmp"
    temporary.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    # Atomic replacement also avoids retaining a broken ACL from an older
    # metadata file, which can make a successfully activated model invisible
    # to the registry on Windows.
    temporary.replace(target)


def clear_model_artifacts(artifacts_dir: Path | None = None) -> None:
    root = artifacts_dir or ARTIFACTS_DIR
    root.mkdir(parents=True, exist_ok=True)
    for path in root.glob("*.joblib"):
        path.unlink()
    metadata_path = root / "metadata.json"
    if metadata_path.exists():
        metadata_path.unlink()


def publish_model_artifacts(staging_dir: Path) -> None:
    """Publish a validated v12 candidate without replacing live artifacts."""
    metadata_path = staging_dir / "metadata.json"
    staged_models = list(staging_dir.glob("*.joblib"))
    if not staged_models or not metadata_path.exists():
        raise ValueError("No hay modelos entrenados para publicar")

    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    candidate_dir = ARTIFACTS_DIR / "v12_candidate"
    candidate_dir.mkdir(parents=True, exist_ok=True)
    candidate_snapshot = candidate_dir / ".previous"
    if candidate_snapshot.exists():
        shutil.rmtree(candidate_snapshot)
    current_candidate_files = list(candidate_dir.glob("*.joblib"))
    candidate_metadata = candidate_dir / "metadata.json"
    if current_candidate_files or candidate_metadata.exists():
        candidate_snapshot.mkdir()
        for path in current_candidate_files + [candidate_metadata]:
            if path.exists():
                shutil.move(str(path), str(candidate_snapshot / path.name))
    for path in staged_models + [metadata_path]:
        shutil.copy2(path, candidate_dir / path.name)
    # v12 remains a candidate until validation explicitly activates it. The
    # current live artifacts and their snapshot are intentionally untouched.


def activate_v12_candidate(*, deployment_mode: str = "full") -> dict[str, Any]:
    if deployment_mode not in {"full", "prediction_only", "experimental_full"}:
        raise ValueError(f"Modo de despliegue no soportado: {deployment_mode}")
    candidate_dir = ARTIFACTS_DIR / "v12_candidate"
    candidate_metadata = candidate_dir / "metadata.json"
    candidate_models = list(candidate_dir.glob("*.joblib"))
    if not candidate_models or not candidate_metadata.exists():
        raise ValueError("No existe un candidato v12 completo")
    metadata = json.loads(candidate_metadata.read_text(encoding="utf-8"))
    if metadata.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("El candidato no coincide con el contrato económico activo")
    snapshot_dir = ARTIFACTS_DIR / ".pre_v12_activation"
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    snapshot_dir.mkdir(parents=True)
    for path in list(ARTIFACTS_DIR.glob("*.joblib")) + [METADATA_PATH]:
        if path.exists():
            shutil.copy2(path, snapshot_dir / path.name)
    for path in list(ARTIFACTS_DIR.glob("*.joblib")):
        path.unlink()
    for path in candidate_models:
        shutil.copy2(path, ARTIFACTS_DIR / path.name)
    active_metadata = dict(metadata)
    active_metadata["deployment_mode"] = deployment_mode
    active_metadata["policy_enabled"] = deployment_mode in {"full", "experimental_full"}
    active_metadata["policy_validation_passed"] = deployment_mode == "full"
    active_metadata["experimental_policy_override"] = deployment_mode == "experimental_full"
    if deployment_mode == "prediction_only":
        active_metadata["policy_block_reason"] = (
            "La politica no supera el intervalo de mejora; el artefacto se usa solo para prediccion."
        )
    elif deployment_mode == "experimental_full":
        active_metadata["policy_warning"] = (
            "Politica experimental activada por solicitud explicita; no ha demostrado mejora "
            "doubly robust frente a las reglas."
        )
    save_metadata(active_metadata, ARTIFACTS_DIR)
    return {
        "activated": True,
        "schema_version": SCHEMA_VERSION,
        "deployment_mode": deployment_mode,
        "policy_enabled": active_metadata["policy_enabled"],
        "snapshot": str(snapshot_dir),
        "artifacts": [path.name for path in candidate_models],
    }


def load_model_candidates(rank_name: str | None, rank_group: str | None) -> list[tuple[dict, str]]:
    metadata = load_metadata()
    if metadata.get("schema_version") != SCHEMA_VERSION:
        return []
    loaded: list[tuple[dict, str]] = []
    candidates = [
        ("rank_name", rank_name), ("rank_group", rank_group), ("global", None),
    ]
    for scope, value in candidates:
        path = model_path(scope, value)
        if path.exists():
            try:
                bundle = joblib.load(path)
                if bundle.get("schema_version") == SCHEMA_VERSION:
                    bundle["deployment_mode"] = metadata.get("deployment_mode", "full")
                    bundle["deployment_policy_enabled"] = bool(metadata.get("policy_enabled", True))
                    bundle["experimental_policy_override"] = bool(
                        metadata.get("experimental_policy_override", False)
                    )
                    loaded.append((bundle, scope))
            except Exception:
                continue
    return loaded


def load_best_model(rank_name: str | None, rank_group: str | None) -> tuple[dict | None, str | None]:
    candidates = load_model_candidates(rank_name, rank_group)
    return candidates[0] if candidates else (None, None)


def status() -> dict[str, Any]:
    metadata = load_metadata()
    paths = list(ARTIFACTS_DIR.glob("*.joblib")) if ARTIFACTS_DIR.exists() else []
    candidate_dir = ARTIFACTS_DIR / "v12_candidate"
    candidate_ready = bool(list(candidate_dir.glob("*.joblib"))) and (candidate_dir / "metadata.json").exists()
    if not paths or metadata.get("schema_version") != SCHEMA_VERSION:
        return {
            "available": False,
            "reason": "No hay un modelo v12 activado todavía",
            "candidate_v12_ready": candidate_ready,
        }
    return {
        "available": True,
        "metadata": metadata,
        "deployment_mode": metadata.get("deployment_mode", "full"),
        "policy_enabled": bool(metadata.get("policy_enabled", True)),
        "artifacts": [path.name for path in paths],
        "candidate_v12_ready": candidate_ready,
    }
