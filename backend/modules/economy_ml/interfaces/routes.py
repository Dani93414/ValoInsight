from __future__ import annotations

import os
import secrets
from threading import Lock

from fastapi import APIRouter, Header, HTTPException

from modules.economy_ml.analysis_reports import build_map_rank_report
from modules.economy_ml.ability_catalog import (
    build_ability_catalog_report,
    load_ability_catalog,
)
from modules.economy_ml.content_catalog import build_content_report
from modules.economy_ml.data_availability import build_data_availability_report
from modules.economy_ml.dataset_builder import (
    build_economy_dataset_from_matches, build_player_economy_dataset_from_matches,
    save_dataset, validate_dataset,
)
from modules.economy_ml.economy_ledger import build_economy_ledger_report
from modules.economy_ml.model_registry import status
from modules.economy_ml.match_analysis_cache import (
    clear_match_economy_analysis_cache,
    get_match_economy_analysis,
)
from modules.economy_ml.train import train_models
from modules.economy_ml.round_win_dataset import build_round_win_dataset
from modules.economy_ml.train_round_win_model import train_round_win_model
from modules.matches.infrastructure import mongo_match_repo
from pathlib import Path

router = APIRouter()
_training_lock = Lock()
_V12_CANDIDATE_DATASET = (
    Path(__file__).resolve().parents[1] / "artifacts"
    / "v12_candidate" / "economy_round_dataset.parquet"
)


@router.get("/status")
def economy_ml_status():
    return status()


@router.get("/content-report")
def economy_ml_content_report():
    return build_content_report()


@router.get("/data-availability")
def economy_ml_data_availability():
    return build_data_availability_report()


@router.get("/ability-catalog")
def economy_ml_ability_catalog():
    return load_ability_catalog()


@router.get("/ability-catalog/report")
def economy_ml_ability_catalog_report():
    return build_ability_catalog_report()


@router.post("/build-dataset")
def build_economy_ml_dataset():
    limit = int(os.getenv("ECONOMY_ML_TRAIN_MATCH_LIMIT", "10000"))
    matches = mongo_match_repo.list_training_matches(limit)
    team_dataset = build_economy_dataset_from_matches(matches)
    player_dataset = build_player_economy_dataset_from_matches(matches)
    validation = validate_dataset(team_dataset)
    if validation["valid"]:
        save_dataset(team_dataset)
    return {
        "saved": bool(validation["valid"]),
        "team_dataset": validation,
        "player_dataset": {
            "rows": len(player_dataset),
            "matches": int(player_dataset["match_id"].nunique()) if "match_id" in player_dataset else 0,
        },
    }


@router.get("/economy-ledger-report")
def economy_ml_ledger_report():
    limit = int(os.getenv("ECONOMY_ML_TRAIN_MATCH_LIMIT", "10000"))
    matches = mongo_match_repo.list_training_matches(limit)
    return build_economy_ledger_report(matches)


@router.get("/map-rank-report")
def economy_ml_map_rank_report():
    return build_map_rank_report()


@router.post("/train")
def train_economy_ml(x_economy_ml_train_token: str | None = Header(default=None)):
    expected_token = os.getenv("ECONOMY_ML_TRAIN_TOKEN")
    if not expected_token:
        raise HTTPException(status_code=503, detail="Entrenamiento por API deshabilitado")
    if not x_economy_ml_train_token or not secrets.compare_digest(x_economy_ml_train_token, expected_token):
        raise HTTPException(status_code=403, detail="Token de entrenamiento inválido")
    if not _training_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Ya hay un entrenamiento en curso")
    limit = int(os.getenv("ECONOMY_ML_TRAIN_MATCH_LIMIT", "10000"))
    try:
        matches = mongo_match_repo.list_training_matches(limit)
        dataset = build_economy_dataset_from_matches(matches)
        validation = validate_dataset(dataset)
        if not validation["valid"]:
            raise HTTPException(
                status_code=422,
                detail={"message": "Dataset inválido", "validation": validation},
            )
        save_dataset(dataset, _V12_CANDIDATE_DATASET)
        try:
            main_result = train_models(dataset)
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={"message": "No se pudo entrenar el modelo", "error": str(exc)},
            ) from exc
        try:
            round_win_result = train_round_win_model(build_round_win_dataset(dataset))
        except Exception as exc:
            round_win_result = {
                "available": False, "reason": "round_win_training_failed", "error": str(exc),
            }
        clear_match_economy_analysis_cache()
        return {**main_result, "round_win_loadout": round_win_result}
    finally:
        _training_lock.release()


@router.get("/matches/{match_id}")
def match_economy_ml(match_id: str):
    match = mongo_match_repo.find_by_id(match_id)
    if not match:
        raise HTTPException(status_code=404, detail="Partida no encontrada")
    return get_match_economy_analysis(match)
