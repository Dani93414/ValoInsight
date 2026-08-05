from fastapi import APIRouter, HTTPException, Query

from modules.matches.infrastructure import mongo_match_repo
from modules.content.application.content_services import get_matches_by_player
from modules.economy_ml.match_analysis_cache import get_match_economy_analysis

router = APIRouter()


@router.get("/")
def list_matches(limit: int = Query(default=20, ge=1, le=200)):
    """Lista partidas guardadas en MongoDB (más recientes primero)."""
    return mongo_match_repo.list_recent(limit)


@router.get("/player/{puuid}")
def list_matches_by_player(puuid: str, limit: int = Query(default=50, ge=1, le=1000)):
    """Devuelve las últimas partidas de un jugador usando su puuid."""
    return get_matches_by_player(puuid, limit=limit)


@router.get("/{match_id}")
def get_match_detail(match_id: str):
    """Obtiene el detalle de una partida por matchInfo.matchId."""
    match_doc = mongo_match_repo.find_by_id(match_id)
    if not match_doc:
        raise HTTPException(status_code=404, detail="Partida no encontrada")
    return match_doc


@router.get("/{match_id}/economy-ml")
def get_match_economy_ml(match_id: str):
    """Devuelve recomendaciones de economía ML o un estado no disponible claro."""
    match_doc = mongo_match_repo.find_by_id(match_id)
    if not match_doc:
        raise HTTPException(status_code=404, detail="Partida no encontrada")
    return get_match_economy_analysis(match_doc)
