import hashlib
import json

from fastapi import APIRouter, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from modules.regions.application.agent_stats_service import get_global_agent_stats, get_global_map_stats
from modules.regions.infrastructure import mongo_region_repo

router = APIRouter()


def _cacheable_json(request: Request, payload: object) -> Response:
    body = json.dumps(
        jsonable_encoder(payload),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    etag = f'"{hashlib.sha256(body).hexdigest()}"'
    headers = {
        "Cache-Control": "public, max-age=600",
        "ETag": etag,
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(
        content=body,
        media_type="application/json",
        headers=headers,
    )


@router.get("/")
def get_regions(response: Response):
    """
    Devuelve las estadísticas globales de todas las regiones 
    recalculadas por el motor central.
    """
    response.headers["Cache-Control"] = "no-store"
    return mongo_region_repo.get_all_sorted()


@router.get("/options")
def get_region_options(request: Request):
    """Lightweight selector data; avoids transferring the full regional aggregate."""
    return _cacheable_json(request, mongo_region_repo.get_options())


@router.get("/summaries")
def get_region_summaries(request: Request):
    """Compact data used by the home page insight cards."""
    return _cacheable_json(request, mongo_region_repo.get_summaries())


@router.get("/weapon-stats")
def get_region_weapon_stats(request: Request):
    """Regional weapon aggregates without agent/map/economy payloads."""
    return _cacheable_json(request, mongo_region_repo.get_weapon_stats())


@router.get("/agent-stats")
def get_agent_stats(
    region: str | None = Query(default=None, max_length=32),
    rank: str | None = Query(default=None, max_length=64),
    map: str | None = Query(default=None, max_length=128),
    act: str | None = Query(default=None, max_length=128),
    role: str | None = Query(default=None, max_length=64),
):
    """Global agent stats aggregated from matches_collection with global filters."""
    return get_global_agent_stats(
        region=region,
        rank=rank,
        map_id=map,
        act_id=act,
        role=role,
    )


@router.get("/map-stats")
def get_map_stats(
    region: str | None = Query(default=None, max_length=32),
    rank: str | None = Query(default=None, max_length=64),
    map: str | None = Query(default=None, max_length=128),
    act: str | None = Query(default=None, max_length=128),
    agent: str | None = Query(default=None, max_length=128),
):
    """Global map stats aggregated from matches_collection with map filters."""
    return get_global_map_stats(
        region=region,
        rank=rank,
        map_id=map,
        act_id=act,
        agent_id=agent,
    )
