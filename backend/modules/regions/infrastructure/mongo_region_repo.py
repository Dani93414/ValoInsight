"""MongoDB repository for region documents."""
from __future__ import annotations

from typing import Any

from infrastructure.mongo_client import regions_collection


def get_all_sorted() -> list[dict[str, Any]]:
    """Return all region stats sorted by avg K/D descending."""
    regiones = list(regions_collection.find({}, {"_id": 0}))
    return sorted(
        regiones,
        key=lambda x: (x.get("averages") or {}).get("kd_ratio", x.get("avg_kd", 0)),
        reverse=True,
    )


def get_options() -> list[dict[str, Any]]:
    """Return only the fields required to populate region selectors."""
    return list(
        regions_collection.find(
            {},
            {"_id": 0, "region": 1, "updatedAt": 1},
        ).sort("region", 1)
    )


def get_summaries() -> list[dict[str, Any]]:
    """Return the compact landing-page summary for every region."""
    return list(
        regions_collection.find(
            {},
            {
                "_id": 0,
                "region": 1,
                "updatedAt": 1,
                "averages": 1,
                "mostPlayedAgents": {"$slice": 1},
                "mostPlayedMaps": {"$slice": 1},
                "mostLethalWeapons": {"$slice": 1},
            },
        ).sort("region", 1)
    )


def get_weapon_stats() -> list[dict[str, Any]]:
    """Return the compact regional projection consumed by the weapons page."""
    return list(
        regions_collection.find(
            {},
            {
                "_id": 0,
                "region": 1,
                "totalRounds": 1,
                "weaponStats": 1,
                "updatedAt": 1,
            },
        ).sort("region", 1)
    )
