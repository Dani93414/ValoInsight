from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "backend"

for path in (PROJECT_ROOT, BACKEND_ROOT):
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)

from modules.economy_ml.dataset_builder import (  # noqa: E402
    build_player_economy_dataset_from_matches,
    build_economy_dataset_from_matches,
    save_dataset,
    validate_dataset,
)
from modules.economy_ml.content_catalog import build_content_report  # noqa: E402
from modules.economy_ml.model_registry import status  # noqa: E402
from modules.economy_ml.train import train_models  # noqa: E402
from modules.economy_ml.round_win_dataset import build_round_win_dataset  # noqa: E402
from modules.economy_ml.train_round_win_model import train_round_win_model  # noqa: E402
from modules.matches.infrastructure import mongo_match_repo  # noqa: E402

CANDIDATE_DATASET_PATH = (
    BACKEND_ROOT / "modules" / "economy_ml" / "artifacts"
    / "v12_candidate" / "economy_round_dataset.parquet"
)

def _print_validation(validation: dict) -> None:
    print("Validacion del dataset:")
    print(f"  valido: {validation.get('valid')}")
    print(f"  filas: {validation.get('rows')}")
    print(f"  partidas: {validation.get('matches')}")
    print(f"  cobertura timestamps: {validation.get('timestamp_coverage')}")
    print(f"  unknown_action_rate: {validation.get('unknown_action_rate')}")
    missing = validation.get("missing_model_columns") or []
    forbidden = validation.get("forbidden_model_features") or []
    if missing:
        print(f"  columnas faltantes: {missing}")
    if forbidden:
        print(f"  features prohibidas: {forbidden}")


def _print_training_summary(metadata: dict) -> None:
    models = metadata.get("models") or {}
    print("Entrenamiento completado:")
    print(f"  filas entrenadas: {metadata.get('dataset_rows')}")
    print(f"  modelo global: {bool(models.get('global'))}")
    print(f"  modelos por grupo de rango: {len(models.get('rank_groups') or {})}")
    print(f"  modelos por rango exacto: {len(models.get('rank_names') or {})}")


def _print_status() -> None:
    current = status()
    print("Estado publicado:")
    print(f"  available: {current.get('available')}")
    print(f"  artefactos: {len(current.get('artifacts') or [])}")
    metadata = current.get("metadata") or {}
    if metadata:
        models = metadata.get("models") or {}
        print(f"  dataset_rows: {metadata.get('dataset_rows')}")
        print(f"  rank_groups: {len(models.get('rank_groups') or {})}")
        print(f"  rank_names: {len(models.get('rank_names') or {})}")
    elif current.get("reason"):
        print(f"  motivo: {current.get('reason')}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Entrena el modelo de economia desde las partidas ranked guardadas "
            "en MongoDB."
        )
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10000,
        help="Maximo de partidas ranked con economia a leer desde MongoDB.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Solo construye y valida el dataset; no guarda ni entrena.",
    )
    parser.add_argument(
        "--allow-invalid",
        action="store_true",
        help="Permite intentar entrenar aunque validate_dataset marque invalid.",
    )
    parser.add_argument(
        "--scoped-models",
        action="store_true",
        help="Entrena además modelos separados por rango; es más lento y no es necesario para v12.",
    )
    args = parser.parse_args()

    print("Leyendo partidas desde MongoDB...")
    content_report = build_content_report()
    if not content_report.get("available"):
        print(content_report.get("reason") or "No hay contenido de Valorant disponible.")
        return 1
    print(
        "Contenido Valorant: "
        f"{content_report.get('weapons_found')} armas, "
        f"{content_report.get('gear_found')} gear, "
        f"{content_report.get('maps_found')} mapas"
    )
    matches = mongo_match_repo.list_training_matches(args.limit)
    print(f"Partidas encontradas: {len(matches)}")
    if not matches:
        print("No hay partidas ranked con economia para entrenar.")
        return 1

    print("Construyendo dataset de economia...")
    dataset = build_economy_dataset_from_matches(matches)
    player_dataset = build_player_economy_dataset_from_matches(matches)
    validation = validate_dataset(dataset)
    _print_validation(validation)
    print(f"Dataset jugador-ronda: {len(player_dataset)} filas")

    if not validation.get("valid") and not args.allow_invalid:
        print("Dataset invalido. No se entrena el modelo.")
        return 1

    if args.validate_only:
        print("Validacion finalizada. No se ha entrenado por --validate-only.")
        return 0

    print("Guardando dataset parquet...")
    save_dataset(dataset, CANDIDATE_DATASET_PATH)

    print("Entrenando modelos y guardando artefactos candidatos v12...")
    try:
        metadata = train_models(dataset, train_scoped_models=args.scoped_models)
    except ValueError as exc:
        print(f"No se pudo entrenar el modelo: {exc}")
        print("Los modelos anteriores se conservan si existian.")
        return 1

    _print_training_summary(metadata)
    print("Entrenando modelo opcional de victoria por equipamiento...")
    round_win_result = train_round_win_model(build_round_win_dataset(dataset))
    if round_win_result.get("available"):
        print(f"  artifact: {round_win_result.get('artifact_path')}")
        print(f"  samples: {round_win_result.get('samples')}")
    else:
        print(f"  no disponible: {round_win_result.get('reason')}")
    _print_status()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
