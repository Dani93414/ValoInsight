from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any

try:
    from infrastructure.mongo_client import content_collection, matches_collection, regions_collection
    from shared.stat_formulas import finalize_core_stats
except ModuleNotFoundError:
    backend_root = Path(__file__).resolve().parents[3]
    if str(backend_root) not in sys.path:
        sys.path.append(str(backend_root))
    from backend.infrastructure.mongo_client import content_collection, matches_collection, regions_collection
    from backend.shared.stat_formulas import finalize_core_stats


_SUM_FIELDS = (
    "rounds", "wins", "kills", "deaths", "assists", "score",
    "damage_dealt", "damage_received", "headshots", "bodyshots", "legshots",
    "first_kills", "first_deaths", "opening_duel_wins", "opening_duel_losses",
    "trade_kills", "trade_opportunities", "missed_trade_opportunities",
    "traded_deaths", "clutch_opportunities", "clutches_won",
    "survival_rounds", "rounds_with_kill", "rounds_with_assist",
    "rounds_with_death", "rounds_with_kast",
    "rounds_with_direct_participation", "rounds_without_direct_participation",
    "rounds_only_kill", "rounds_only_assist", "rounds_only_death",
    "rounds_kill_assist", "rounds_kill_death", "rounds_assist_death",
    "rounds_kill_assist_death", "rounds_none", "rounds_combined_or_none",
    "rounds_with_multikill", "multi_2k", "multi_3k", "multi_4k", "multi_5k",
    "econ_spent", "loadout_value_total",
)


_RANK_NAMES = {
    3: "Iron 1",
    4: "Iron 2",
    5: "Iron 3",
    6: "Bronze 1",
    7: "Bronze 2",
    8: "Bronze 3",
    9: "Silver 1",
    10: "Silver 2",
    11: "Silver 3",
    12: "Gold 1",
    13: "Gold 2",
    14: "Gold 3",
    15: "Platinum 1",
    16: "Platinum 2",
    17: "Platinum 3",
    18: "Diamond 1",
    19: "Diamond 2",
    20: "Diamond 3",
    21: "Ascendant 1",
    22: "Ascendant 2",
    23: "Ascendant 3",
    24: "Immortal 1",
    25: "Immortal 2",
    26: "Immortal 3",
    27: "Radiant",
}

_OPTIONS_CACHE_TTL_SECONDS = 600.0
_options_cache: dict[str, tuple[float, dict[str, list[dict[str, Any]]]]] = {}
_options_cache_lock = Lock()
_AGENT_STATS_CACHE_TTL_SECONDS = 600.0
_agent_stats_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_agent_stats_cache_lock = Lock()
_MAP_STATS_CACHE_TTL_SECONDS = 600.0
_map_options_cache: dict[str, tuple[float, dict[str, list[dict[str, Any]]]]] = {}
_map_stats_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_map_stats_cache_lock = Lock()


def _safe_div(num: float, den: float) -> float:
    return round(num / den, 4) if den else 0.0


def _normalize_region(raw: str | None) -> str | None:
    value = str(raw or "").strip().upper()
    return value or None


def _normalize_filter(raw: str | None) -> str | None:
    value = str(raw or "").strip()
    return value if value and value.lower() != "all" else None


def _coerce_rank(raw: str | int | None) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw if raw >= 3 else None
    value = str(raw).strip()
    if not value or value.lower() == "all":
        return None
    try:
        tier = int(float(value))
        return tier if tier >= 3 else None
    except ValueError:
        normalized = value.lower()
        for tier, label in _RANK_NAMES.items():
            if label.lower() == normalized:
                return tier
    return None


def _latest_content_maps_acts_agents() -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    doc = content_collection.find_one(
        {"type": "valorant_content"},
        {
            "_id": 0,
            "maps.uuid": 1,
            "maps.displayName": 1,
            "maps.name": 1,
            "acts.id": 1,
            "acts.name": 1,
            "agents.uuid": 1,
            "agents.displayName": 1,
        },
        sort=[("_id", -1)],
    ) or {}
    maps = {
        str(item.get("uuid") or ""): str(item.get("displayName") or item.get("name") or item.get("uuid") or "")
        for item in doc.get("maps", []) or []
        if item.get("uuid")
    }
    acts = {
        str(item.get("id") or ""): str(item.get("name") or item.get("id") or "")
        for item in doc.get("acts", []) or []
        if item.get("id")
    }
    agents = {
        str(item.get("uuid") or ""): str(item.get("displayName") or item.get("uuid") or "")
        for item in doc.get("agents", []) or []
        if item.get("uuid")
    }
    return maps, acts, agents


def _latest_content_maps_acts() -> tuple[dict[str, str], dict[str, str]]:
    maps, acts, _agents = _latest_content_maps_acts_agents()
    return maps, acts


def _base_match_query(region: str | None, map_id: str | None, act_id: str | None) -> dict[str, Any]:
    query: dict[str, Any] = {"matchInfo.isRanked": True, "players.analytics": {"$exists": True}}
    if region:
        query["matchInfo.region"] = {"$in": [region, region.lower(), region.upper()]}
    if map_id:
        query["matchInfo.mapId"] = map_id
    if act_id:
        query["matchInfo.seasonId"] = act_id
    return query


def _player_matches_filters(player: dict[str, Any], *, rank: int | None, role: str | None) -> bool:
    if rank is not None and int(player.get("competitiveTier") or 0) != rank:
        return False
    if role:
        analytics = player.get("analytics") or {}
        player_role = str(analytics.get("role") or "").strip().lower()
        if player_role != role.strip().lower():
            return False
    return True


def _player_matches_map_filters(
    player: dict[str, Any],
    *,
    rank: int | None,
    agent_id: str | None,
) -> bool:
    if rank is not None and int(player.get("competitiveTier") or 0) != rank:
        return False
    if agent_id and str(player.get("characterId") or "") != agent_id:
        return False
    return bool(player.get("analytics"))


def _normalize_weapon_stats(weapon_stats: Any) -> list[dict[str, Any]]:
    if isinstance(weapon_stats, list):
        return [item for item in weapon_stats if isinstance(item, dict)]
    if isinstance(weapon_stats, dict):
        normalized: list[dict[str, Any]] = []
        for key, value in weapon_stats.items():
            if not isinstance(value, dict):
                continue
            normalized.append({**value, "key": key})
        return normalized
    return []


def _team_rounds(team: dict[str, Any]) -> int:
    return int(team.get("roundsWon") or team.get("numPoints") or 0)


def _match_rounds_from_teams(teams: list[dict[str, Any]]) -> int:
    rounds = sum(_team_rounds(team) for team in teams if isinstance(team, dict))
    return rounds if rounds > 0 else 0


def _coerce_pct(raw: Any) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return min(value, 100.0)


def _add_legacy_rate_fallbacks(totals: Counter, overview: dict[str, Any]) -> None:
    rounds = int(overview.get("rounds", 0) or 0)
    if rounds > 0 and not overview.get("rounds_with_kast"):
        kast_pct = _coerce_pct(
            overview.get("kast_pct")
            if overview.get("kast_pct") is not None
            else overview.get("kast")
        )
        if kast_pct is not None:
            totals["rounds_with_kast"] += round((kast_pct / 100.0) * rounds)

    clutch_opportunities = int(overview.get("clutch_opportunities", 0) or 0)
    if clutch_opportunities <= 0:
        clutch_rate = _coerce_pct(overview.get("clutch_win_rate"))
        if clutch_rate is not None:
            totals["clutch_rate_sum"] += clutch_rate
            totals["clutch_rate_count"] += 1


def _finalize_with_legacy_rates(totals: dict[str, Any]) -> dict[str, Any]:
    derived = finalize_core_stats(dict(totals))
    if int(totals.get("clutch_opportunities", 0) or 0) <= 0:
        count = int(totals.get("clutch_rate_count", 0) or 0)
        if count > 0:
            derived["clutch_win_rate"] = _safe_div(float(totals.get("clutch_rate_sum", 0.0) or 0.0), count)
    return derived


def _build_options(region: str | None) -> dict[str, list[dict[str, Any]]]:
    query = _base_match_query(region, None, None)
    projection = {
        "_id": 0,
        "matchInfo.mapId": 1,
        "matchInfo.seasonId": 1,
        "players.characterId": 1,
        "players.competitiveTier": 1,
    }
    map_names, act_names, agent_names = _latest_content_maps_acts_agents()
    map_counts: Counter[str] = Counter()
    act_counts: Counter[str] = Counter()
    rank_counts: Counter[int] = Counter()
    agent_counts: Counter[str] = Counter()

    for match in matches_collection.find(query, projection):
        map_id = str((match.get("matchInfo") or {}).get("mapId") or "").strip()
        act_id = str((match.get("matchInfo") or {}).get("seasonId") or "").strip()
        if map_id:
            map_counts[map_id] += 1
        if act_id:
            act_counts[act_id] += 1
        for player in match.get("players", []) or []:
            tier = _coerce_rank(player.get("competitiveTier"))
            if tier:
                rank_counts[tier] += 1
            agent_id = str(player.get("characterId") or "").strip()
            if agent_id:
                agent_counts[agent_id] += 1

    maps = [
        {"value": key, "label": map_names.get(key, key), "count": count}
        for key, count in map_counts.items()
    ]
    maps.sort(key=lambda item: str(item["label"]).lower())

    acts = [
        {"value": key, "label": act_names.get(key, key), "count": count}
        for key, count in act_counts.items()
    ]
    acts.sort(key=lambda item: str(item["label"]).lower())

    ranks = [
        {"value": str(key), "label": _RANK_NAMES.get(key, f"Tier {key}"), "count": count}
        for key, count in rank_counts.items()
    ]
    ranks.sort(key=lambda item: int(item["value"]))

    agents = [
        {"value": key, "label": agent_names.get(key, key), "count": count}
        for key, count in agent_counts.items()
    ]
    agents.sort(key=lambda item: str(item["label"]).lower())

    return {"maps": maps, "acts": acts, "ranks": ranks, "agents": agents}


def _build_options_cached(region: str | None) -> dict[str, list[dict[str, Any]]]:
    cache_key = region or "__all__"
    now = monotonic()
    with _options_cache_lock:
        cached = _options_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    options = _build_options(region)
    with _options_cache_lock:
        _options_cache[cache_key] = (now + _OPTIONS_CACHE_TTL_SECONDS, options)
    return options


def _build_map_options_for_filters(
    *,
    region: str | None,
    map_id: str | None,
    act_id: str | None,
    rank: int | None,
    agent_id: str | None,
) -> dict[str, list[dict[str, Any]]]:
    projection = {
        "_id": 0,
        "matchInfo.mapId": 1,
        "matchInfo.seasonId": 1,
        "players.characterId": 1,
        "players.competitiveTier": 1,
        "players.analytics": 1,
    }
    map_names, act_names, agent_names = _latest_content_maps_acts_agents()
    counts: dict[str, Counter[Any]] = {
        "maps": Counter(),
        "acts": Counter(),
        "ranks": Counter(),
        "agents": Counter(),
    }

    for option_key in counts:
        current_map = map_id if option_key != "maps" else None
        current_act = act_id if option_key != "acts" else None
        query = _base_match_query(region, current_map, current_act)
        for match in matches_collection.find(query, projection):
            match_info = match.get("matchInfo") or {}
            current_map_id = str(match_info.get("mapId") or "").strip()
            current_act_id = str(match_info.get("seasonId") or "").strip()
            matched_players = []
            for player in match.get("players", []) or []:
                if not player.get("analytics"):
                    continue
                player_rank = _coerce_rank(player.get("competitiveTier"))
                player_agent = str(player.get("characterId") or "").strip()
                if option_key != "ranks" and rank is not None and player_rank != rank:
                    continue
                if option_key != "agents" and agent_id and player_agent != agent_id:
                    continue
                matched_players.append((player_rank, player_agent))

            if not matched_players:
                continue
            if option_key == "maps" and current_map_id:
                counts["maps"][current_map_id] += 1
            elif option_key == "acts" and current_act_id:
                counts["acts"][current_act_id] += 1
            elif option_key == "ranks":
                for player_rank, _player_agent in matched_players:
                    if player_rank:
                        counts["ranks"][player_rank] += 1
            elif option_key == "agents":
                for _player_rank, player_agent in matched_players:
                    if player_agent:
                        counts["agents"][player_agent] += 1

    maps = [
        {"value": key, "label": map_names.get(key, key), "count": count}
        for key, count in counts["maps"].items()
    ]
    maps.sort(key=lambda item: str(item["label"]).lower())

    acts = [
        {"value": key, "label": act_names.get(key, key), "count": count}
        for key, count in counts["acts"].items()
    ]
    acts.sort(key=lambda item: str(item["label"]).lower())

    ranks = [
        {"value": str(key), "label": _RANK_NAMES.get(int(key), f"Tier {key}"), "count": count}
        for key, count in counts["ranks"].items()
    ]
    ranks.sort(key=lambda item: int(item["value"]))

    agents = [
        {"value": key, "label": agent_names.get(key, key), "count": count}
        for key, count in counts["agents"].items()
    ]
    agents.sort(key=lambda item: str(item["label"]).lower())

    return {"maps": maps, "acts": acts, "ranks": ranks, "agents": agents}


def _build_map_options_for_filters_cached(
    *,
    region: str | None,
    map_id: str | None,
    act_id: str | None,
    rank: int | None,
    agent_id: str | None,
) -> dict[str, list[dict[str, Any]]]:
    cache_key = "|".join([
        region or "",
        map_id or "",
        act_id or "",
        str(rank or ""),
        agent_id or "",
    ])
    now = monotonic()
    with _map_stats_cache_lock:
        cached = _map_options_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    options = _build_map_options_for_filters(
        region=region,
        map_id=map_id,
        act_id=act_id,
        rank=rank,
        agent_id=agent_id,
    )
    with _map_stats_cache_lock:
        _map_options_cache[cache_key] = (now + _MAP_STATS_CACHE_TTL_SECONDS, options)
    return options


def _normalize_round_ceremonies(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, int] = {}
    for key, value in raw.items():
        if isinstance(value, dict):
            amount = value.get("wins", value.get("rounds", 0))
        else:
            amount = value
        try:
            result[str(key)] = int(amount or 0)
        except (TypeError, ValueError):
            continue
    return result


def _project_region_map_stats(map_stats: dict[str, Any]) -> dict[str, Any]:
    """Keep legacy region map aggregates compatible with /regions/map-stats."""
    projected = dict(map_stats)
    projected["round_ceremonies"] = _normalize_round_ceremonies(projected.get("round_ceremonies"))
    agent_stats = projected.get("agent_stats") if isinstance(projected.get("agent_stats"), dict) else {}
    player_matches = sum(
        int((row or {}).get("matches") or (row or {}).get("matches_played") or (row or {}).get("picks") or 0)
        for row in agent_stats.values()
        if isinstance(row, dict)
    )
    player_wins = sum(
        int((row or {}).get("wins") or 0)
        for row in agent_stats.values()
        if isinstance(row, dict)
    )
    if not projected.get("player_matches") and player_matches:
        projected["player_matches"] = player_matches
    if not projected.get("wins") and player_wins:
        projected["wins"] = player_wins
    if not projected.get("player_win_rate"):
        projected["player_win_rate"] = _safe_div(
            float(projected.get("wins") or 0) * 100.0,
            int(projected.get("player_matches") or 0),
        )
    if not projected.get("map_rounds"):
        projected["map_rounds"] = projected.get("total_rounds") or projected.get("rounds_played") or 0
    projected["agent_stats"] = agent_stats
    projected["weapon_stats"] = projected.get("weapon_stats") or {}
    composition_stats = projected.get("composition_stats") or {}
    if isinstance(composition_stats, dict):
        composition_stats = list(composition_stats.values())
    projected["composition_stats"] = composition_stats if isinstance(composition_stats, list) else []
    return projected


def _merge_precomputed_map_stats(region_docs: list[dict[str, Any]]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for doc in region_docs:
        for map_id, raw_stats in (doc.get("mapStats") or {}).items():
            stats = _project_region_map_stats(raw_stats if isinstance(raw_stats, dict) else {})
            target = merged.setdefault(str(map_id), {
                "map_name": stats.get("map_name") or str(map_id),
                "matches": 0,
                "player_matches": 0,
                "wins": 0,
                "map_rounds": 0,
                "player_rounds": 0,
                "team_round_wins": 0,
                "team_round_losses": 0,
                "rounds_with_kast": 0,
                "assists": 0,
                "survival_rounds": 0,
                "clutch_opportunities": 0,
                "clutches_won": 0,
                "round_ceremonies": Counter(),
                "sides": {"attack": Counter(), "defense": Counter()},
                "totals": Counter(),
            })
            for field in (
                "matches", "player_matches", "wins", "map_rounds", "player_rounds",
                "team_round_wins", "team_round_losses", "rounds_with_kast", "assists",
                "survival_rounds", "clutch_opportunities", "clutches_won",
            ):
                target[field] += int(stats.get(field) or stats.get("matches_played" if field == "matches" else field) or 0)
            target["round_ceremonies"].update(_normalize_round_ceremonies(stats.get("round_ceremonies")))
            for side_name in ("attack", "defense"):
                side = stats.get("sides", {}).get(side_name, {}) if isinstance(stats.get("sides"), dict) else {}
                side_counter = target["sides"][side_name]
                side_counter["rounds"] += int(side.get("rounds", stats.get(f"{side_name}_rounds", 0)) or 0)
                side_counter["wins"] += int(side.get("wins", stats.get(f"{side_name}_wins", 0)) or 0)
                side_counter["kills"] += int(side.get("kills", 0) or 0)
                side_counter["deaths"] += int(side.get("deaths", 0) or 0)
                side_counter["damage_dealt"] += int(float(side.get("adr", 0) or 0) * int(side.get("rounds", 0) or 0))
            averages = stats.get("averages") or {}
            player_rounds = int(stats.get("player_rounds") or 0)
            target["totals"]["kills"] += int(stats.get("kills") or float(averages.get("kills_per_round", 0) or 0) * player_rounds)
            target["totals"]["deaths"] += int(stats.get("deaths") or float(averages.get("deaths_per_round", 0) or 0) * player_rounds)
            target["totals"]["assists"] += int(stats.get("assists") or float(averages.get("assists_per_round", 0) or 0) * player_rounds)
            target["totals"]["damage_dealt"] += int(stats.get("damage_dealt") or float(averages.get("adr", 0) or 0) * player_rounds)
            target["totals"]["score"] += int(float(averages.get("acs", 0) or 0) * player_rounds)
            target["totals"]["rounds"] += player_rounds
            target["totals"]["rounds_with_kast"] += int(stats.get("rounds_with_kast") or 0)
            target["totals"]["survival_rounds"] += int(stats.get("survival_rounds") or 0)
            target["totals"]["clutch_opportunities"] += int(stats.get("clutch_opportunities") or 0)
            target["totals"]["clutches_won"] += int(stats.get("clutches_won") or 0)

    result: dict[str, Any] = {}
    for map_id, bucket in merged.items():
        totals = dict(bucket["totals"])
        derived = _finalize_with_legacy_rates(totals)
        sides = {}
        for side_name, side_counter in bucket["sides"].items():
            rounds = int(side_counter.get("rounds", 0) or 0)
            wins = int(side_counter.get("wins", 0) or 0)
            sides[side_name] = {
                "rounds": rounds,
                "wins": wins,
                "win_rate": _safe_div(wins * 100.0, rounds),
                "kills": int(side_counter.get("kills", 0) or 0),
                "deaths": int(side_counter.get("deaths", 0) or 0),
                "adr": _safe_div(float(side_counter.get("damage_dealt", 0) or 0), rounds),
                "kills_per_round": _safe_div(float(side_counter.get("kills", 0) or 0), rounds),
            }
        result[map_id] = {
            "map_name": bucket["map_name"],
            "matches": int(bucket["matches"]),
            "player_matches": int(bucket["player_matches"]),
            "wins": int(bucket["wins"]),
            "map_rounds": int(bucket["map_rounds"]),
            "player_rounds": int(bucket["player_rounds"]),
            "team_round_wins": int(bucket["team_round_wins"]),
            "team_round_losses": int(bucket["team_round_losses"]),
            "total_rounds": int(bucket["map_rounds"]),
            "rounds_with_kast": int(bucket["rounds_with_kast"]),
            "assists": int(bucket["assists"]),
            "survival_rounds": int(bucket["survival_rounds"]),
            "clutch_opportunities": int(bucket["clutch_opportunities"]),
            "clutches_won": int(bucket["clutches_won"]),
            "win_rate": _safe_div(int(bucket["wins"]) * 100.0, int(bucket["player_matches"])),
            "player_win_rate": _safe_div(int(bucket["wins"]) * 100.0, int(bucket["player_matches"])),
            "team_round_win_rate": _safe_div(
                int(bucket["team_round_wins"]) * 100.0,
                int(bucket["team_round_wins"]) + int(bucket["team_round_losses"]),
            ),
            "kast_pct": derived.get("kast_pct", 0.0),
            "survival_rate": derived["survival_rate"],
            "clutch_win_rate": derived["clutch_win_rate"],
            "averages": {
                "kd_ratio": derived["kd_ratio"],
                "acs": derived["acs"],
                "adr": derived["adr"],
                "headshot_pct": derived["headshot_pct"],
                "kast_pct": derived.get("kast_pct", 0.0),
                "survival_rate": derived["survival_rate"],
                "clutch_win_rate": derived["clutch_win_rate"],
                "kills_per_round": derived["kills_per_round"],
                "deaths_per_round": derived["deaths_per_round"],
                "assists_per_round": derived["assists_per_round"],
            },
            "sides": sides,
            "round_ceremonies": dict(bucket["round_ceremonies"]),
        }
    return result


def _precomputed_map_stats_payload(region: str | None) -> dict[str, Any] | None:
    query = {"region": region} if region else {}
    docs = list(regions_collection.find(query, {"_id": 0, "region": 1, "mapStats": 1, "updatedAt": 1}))
    if not docs:
        return None
    if region and len(docs) == 1:
        map_stats = {
            str(map_id): _project_region_map_stats(stats if isinstance(stats, dict) else {})
            for map_id, stats in (docs[0].get("mapStats") or {}).items()
        }
    else:
        map_stats = _merge_precomputed_map_stats(docs)
    agent_stats_by_map = {
        map_id: stats.get("agent_stats", {})
        for map_id, stats in map_stats.items()
        if isinstance(stats.get("agent_stats"), dict)
    }
    weapon_stats_by_map = {
        map_id: stats.get("weapon_stats", {})
        for map_id, stats in map_stats.items()
        if isinstance(stats.get("weapon_stats"), dict)
    }
    compositions_by_map = {
        map_id: stats.get("composition_stats", [])
        for map_id, stats in map_stats.items()
        if isinstance(stats.get("composition_stats"), list)
    }
    return {
        "mapStats": map_stats,
        "agentStatsByMap": agent_stats_by_map,
        "weaponStatsByMap": weapon_stats_by_map,
        "compositionsByMap": compositions_by_map,
        "sampleSize": {
            "matches": sum(int(stats.get("matches") or stats.get("matches_played") or 0) for stats in map_stats.values()),
            "players": sum(int(stats.get("player_matches") or 0) for stats in map_stats.values()),
            "maps": len(map_stats),
        },
    }


def get_global_agent_stats(
    *,
    region: str | None = None,
    rank: str | int | None = None,
    map_id: str | None = None,
    act_id: str | None = None,
    role: str | None = None,
) -> dict[str, Any]:
    region_norm = _normalize_region(region)
    map_norm = _normalize_filter(map_id)
    act_norm = _normalize_filter(act_id)
    role_norm = _normalize_filter(role)
    rank_tier = _coerce_rank(rank)
    cache_key = "|".join([
        region_norm or "",
        str(rank_tier or ""),
        map_norm or "",
        act_norm or "",
        role_norm or "",
    ])
    now = monotonic()
    with _agent_stats_cache_lock:
        cached = _agent_stats_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    # The analytics rebuild already stores the unfiltered aggregate in regions.
    # Reusing it removes a full scan of matches from the normal page load.
    if rank_tier is None and map_norm is None and act_norm is None and role_norm is None:
        query = {"region": region_norm} if region_norm else {}
        docs = list(
            regions_collection.find(
                query,
                {
                    "_id": 0,
                    "region": 1,
                    "agentStats": 1,
                    "totalMatches": 1,
                    "updatedAt": 1,
                },
            )
        )
        if len(docs) == 1 and isinstance(docs[0].get("agentStats"), dict):
            agent_stats = docs[0]["agentStats"]
            payload = {
                "filters": {
                    "region": region_norm,
                    "rank": None,
                    "map": None,
                    "act": None,
                    "role": None,
                },
                "options": _build_options_cached(region_norm),
                "sampleSize": {
                    "matches": int(docs[0].get("totalMatches") or 0),
                    "picks": sum(int(stats.get("picks") or 0) for stats in agent_stats.values()),
                    "agents": len(agent_stats),
                },
                "warnings": [],
                "statsSource": "regions_precomputed",
                "agentStats": agent_stats,
            }
            with _agent_stats_cache_lock:
                _agent_stats_cache[cache_key] = (
                    now + _AGENT_STATS_CACHE_TTL_SECONDS,
                    payload,
                )
            return payload

    query = _base_match_query(region_norm, map_norm, act_norm)
    projection = {
        "_id": 0,
        "matchInfo.matchId": 1,
        "players.characterId": 1,
        "players.competitiveTier": 1,
        "players.analytics.agent_name": 1,
        "players.analytics.role": 1,
        "players.analytics.won_match": 1,
        **{
            f"players.analytics.overview.{field}": 1
            for field in _SUM_FIELDS
        },
    }

    agents = defaultdict(lambda: {
        "agent_name": "Unknown",
        "role": "Desconocido",
        "picks": 0,
        "wins": 0,
        "totals": Counter(),
    })
    match_ids: set[str] = set()
    filtered_picks = 0

    for match in matches_collection.find(query, projection):
        match_id = str((match.get("matchInfo") or {}).get("matchId") or "").strip()
        match_has_pick = False
        for player in match.get("players", []) or []:
            analytics = player.get("analytics") or {}
            if not analytics or not _player_matches_filters(player, rank=rank_tier, role=role_norm):
                continue

            overview = analytics.get("overview") or {}
            agent_id = str(player.get("characterId") or "UNKNOWN")
            bucket = agents[agent_id]
            bucket["agent_name"] = analytics.get("agent_name") or bucket["agent_name"]
            bucket["role"] = analytics.get("role") or bucket["role"]
            bucket["picks"] += 1
            bucket["wins"] += 1 if analytics.get("won_match") else 0
            for field in _SUM_FIELDS:
                bucket["totals"][field] += int(overview.get(field, 0) or 0)
            _add_legacy_rate_fallbacks(bucket["totals"], overview)
            filtered_picks += 1
            match_has_pick = True
        if match_has_pick and match_id:
            match_ids.add(match_id)

    agent_stats: dict[str, Any] = {}
    for agent_id, bucket in agents.items():
        totals = dict(bucket["totals"])
        derived = _finalize_with_legacy_rates(totals)
        picks = int(bucket["picks"])
        agent_stats[agent_id] = {
            "agent_name": bucket["agent_name"],
            "role": bucket["role"],
            "picks": picks,
            "matches": picks,
            "wins": int(bucket["wins"]),
            "rounds": int(totals.get("rounds", 0)),
            "totals": {field: int(totals.get(field, 0) or 0) for field in _SUM_FIELDS},
            "pick_rate": _safe_div(picks * 100.0, filtered_picks),
            "win_rate": _safe_div(int(bucket["wins"]) * 100.0, picks),
            "avg_kd": derived["kd_ratio"],
            "avg_kda": derived["kda_ratio"],
            "avg_acs": derived["acs"],
            "avg_adr": derived["adr"],
            "avg_headshot_pct": derived["headshot_pct"],
            "avg_fk_rate": derived["fk_rate"],
            "avg_fd_rate": derived["fd_rate"],
            "avg_survival_rate": derived["survival_rate"],
            "avg_clutch_win_rate": derived["clutch_win_rate"],
            "deaths_per_round": derived["deaths_per_round"],
            "assist_rate": derived["rounds_with_assist_pct"],
            "kast_pct": derived.get("kast_pct", 0.0),
            "trade_rate": derived["trade_conversion_rate"],
            "trade_kills_per_round": derived["trade_kills_per_round"],
            "opening_duel_win_pct": derived["opening_duel_win_pct"],
        }

    warnings = []
    if filtered_picks == 0:
        warnings.append("No hay datos globales para el subconjunto filtrado.")
    elif filtered_picks < 100:
        warnings.append("Muestra global baja para el subconjunto filtrado.")

    payload = {
        "filters": {
            "region": region_norm,
            "rank": str(rank_tier) if rank_tier is not None else None,
            "map": map_norm,
            "act": act_norm,
            "role": role_norm,
        },
        "options": _build_options_cached(region_norm),
        "sampleSize": {
            "matches": len(match_ids),
            "picks": filtered_picks,
            "agents": len(agent_stats),
        },
        "warnings": warnings,
        "agentStats": agent_stats,
    }
    with _agent_stats_cache_lock:
        _agent_stats_cache[cache_key] = (
            now + _AGENT_STATS_CACHE_TTL_SECONDS,
            payload,
        )
    return payload


def get_global_map_stats(
    *,
    region: str | None = None,
    rank: str | int | None = None,
    map_id: str | None = None,
    act_id: str | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    region_norm = _normalize_region(region)
    map_norm = _normalize_filter(map_id)
    act_norm = _normalize_filter(act_id)
    agent_norm = _normalize_filter(agent_id)
    rank_tier = _coerce_rank(rank)
    cache_key = "|".join([
        region_norm or "",
        str(rank_tier or ""),
        map_norm or "",
        act_norm or "",
        agent_norm or "",
    ])
    now = monotonic()
    with _map_stats_cache_lock:
        cached = _map_stats_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    can_use_precomputed = rank_tier is None and map_norm is None and act_norm is None and agent_norm is None
    if can_use_precomputed:
        precomputed = _precomputed_map_stats_payload(region_norm)
        if precomputed:
            payload = {
                "filters": {
                    "region": region_norm,
                    "rank": None,
                    "map": None,
                    "act": None,
                    "agent": None,
                },
                "options": _build_options_cached(region_norm),
                "warnings": [],
                "statsSource": "regions_precomputed",
                **precomputed,
            }
            with _map_stats_cache_lock:
                _map_stats_cache[cache_key] = (now + _MAP_STATS_CACHE_TTL_SECONDS, payload)
            return payload

    query = _base_match_query(region_norm, map_norm, act_norm)
    projection = {
        "_id": 0,
        "matchInfo.matchId": 1,
        "matchInfo.mapId": 1,
        "matchInfo.seasonId": 1,
        "teams": 1,
        "roundResults.roundCeremony": 1,
        "roundResults.winningTeam": 1,
        "players.teamId": 1,
        "players.characterId": 1,
        "players.competitiveTier": 1,
        "players.analytics": 1,
    }
    map_names, _act_names, agent_names = _latest_content_maps_acts_agents()

    maps = defaultdict(lambda: {
        "map_name": "Unknown",
        "match_ids": set(),
        "player_matches": 0,
        "player_wins": 0,
        "map_rounds": 0,
        "team_round_wins": 0,
        "team_round_losses": 0,
        "wins": 0,
        "totals": Counter(),
        "round_ceremonies": Counter(),
        "sides": {
            "attack": Counter(),
            "defense": Counter(),
        },
    })
    map_agents = defaultdict(lambda: defaultdict(lambda: {
        "agent_name": "Unknown",
        "picks": 0,
        "wins": 0,
        "totals": Counter(),
    }))
    map_weapons = defaultdict(lambda: defaultdict(lambda: Counter()))
    compositions = defaultdict(lambda: defaultdict(lambda: {
        "agents": [],
        "matches": 0,
        "wins": 0,
        "rounds_won": 0,
        "rounds_lost": 0,
    }))
    match_ids: set[str] = set()
    filtered_players = 0

    for match in matches_collection.find(query, projection):
        match_info = match.get("matchInfo") or {}
        match_id = str(match_info.get("matchId") or "").strip()
        current_map_id = str(match_info.get("mapId") or "").strip() or "UNKNOWN"
        map_name = map_names.get(current_map_id, current_map_id)
        match_has_filtered_player = False
        filtered_player_teams: set[str] = set()
        teams_raw = [team for team in (match.get("teams") or []) if isinstance(team, dict)]
        analytics_players = [
            player
            for player in (match.get("players", []) or [])
            if isinstance(player, dict) and player.get("analytics")
        ]

        for player in analytics_players:
            if not _player_matches_map_filters(player, rank=rank_tier, agent_id=agent_norm):
                continue
            analytics = player.get("analytics") or {}
            overview = analytics.get("overview") or {}
            bucket = maps[current_map_id]
            bucket["map_name"] = analytics.get("map_name") or map_name or bucket["map_name"]
            bucket["player_matches"] += 1
            bucket["player_wins"] += 1 if analytics.get("won_match") else 0
            bucket["wins"] = bucket["player_wins"]
            team_id = str(player.get("teamId") or "").lower()
            if team_id:
                filtered_player_teams.add(team_id)
            for field in _SUM_FIELDS:
                bucket["totals"][field] += int(overview.get(field, 0) or 0)
            _add_legacy_rate_fallbacks(bucket["totals"], overview)
            for side_name in ("attack", "defense"):
                side = (analytics.get("sides") or {}).get(side_name) or {}
                target = bucket["sides"][side_name]
                for field in ("rounds", "wins", "kills", "deaths", "damage_dealt", "score"):
                    target[field] += int(side.get(field, 0) or 0)

            filtered_players += 1
            match_has_filtered_player = True

        if match_has_filtered_player and match_id:
            match_ids.add(match_id)
            bucket = maps[current_map_id]
            bucket["match_ids"].add(match_id)
            match_rounds = _match_rounds_from_teams(teams_raw)
            bucket["map_rounds"] += match_rounds

            for round_obj in match.get("roundResults", []) or []:
                if not isinstance(round_obj, dict):
                    continue
                ceremony = str(round_obj.get("roundCeremony") or "").strip()
                if not ceremony:
                    continue
                if rank_tier is None and not agent_norm:
                    bucket["round_ceremonies"][ceremony] += 1
                    continue
                winning_team = str(round_obj.get("winningTeam") or "").lower()
                if winning_team in filtered_player_teams:
                    bucket["round_ceremonies"][ceremony] += 1

            team_results_once = {
                str(team.get("teamId") or "").lower(): team
                for team in teams_raw
                if isinstance(team, dict)
            }
            for team_id in filtered_player_teams:
                team_result = team_results_once.get(team_id) or {}
                rounds_won = _team_rounds(team_result)
                rounds_lost = 0
                for other_team_id, other_team in team_results_once.items():
                    if other_team_id != team_id:
                        rounds_lost = _team_rounds(other_team)
                        break
                bucket["team_round_wins"] += rounds_won
                bucket["team_round_losses"] += rounds_lost

            for player in analytics_players:
                analytics = player.get("analytics") or {}
                overview = analytics.get("overview") or {}
                current_agent_id = str(player.get("characterId") or "UNKNOWN")
                agent_bucket = map_agents[current_map_id][current_agent_id]
                agent_bucket["agent_name"] = analytics.get("agent_name") or agent_names.get(current_agent_id, current_agent_id)
                agent_bucket["picks"] += 1
                agent_bucket["wins"] += 1 if analytics.get("won_match") else 0
                for field in _SUM_FIELDS:
                    agent_bucket["totals"][field] += int(overview.get(field, 0) or 0)
                _add_legacy_rate_fallbacks(agent_bucket["totals"], overview)

                for weapon in _normalize_weapon_stats(overview.get("weapon_stats")):
                    weapon_id = str(
                        weapon.get("weapon_id")
                        or weapon.get("weaponId")
                        or weapon.get("key")
                        or weapon.get("name")
                        or weapon.get("weapon_name")
                        or "UNKNOWN"
                    )
                    weapon_bucket = map_weapons[current_map_id][weapon_id]
                    weapon_bucket["weapon_name"] = weapon.get("weapon_name") or weapon.get("weaponName") or weapon.get("name") or weapon_id
                    weapon_bucket["is_armor"] = bool(weapon.get("is_armor"))
                    for field in (
                        "rounds", "rounds_equipped", "rounds_purchased", "wins", "kills", "deaths",
                        "headshots", "bodyshots", "legshots", "damage_dealt", "damage_received",
                        "survival_rounds", "loadout_value_total",
                    ):
                        weapon_bucket[field] += int(weapon.get(field, 0) or 0)

        team_results = {
            str(team.get("teamId") or "").lower(): team
            for team in match.get("teams", []) or []
            if isinstance(team, dict)
        }
        players_by_team: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for player in match.get("players", []) or []:
            team_id = str(player.get("teamId") or "").lower()
            if team_id:
                players_by_team[team_id].append(player)

        for team_id, players in players_by_team.items():
            if len(players) != 5:
                continue
            if rank_tier is not None and not match_has_filtered_player:
                continue
            if agent_norm and not match_has_filtered_player:
                continue
            team_agent_ids = sorted(str(player.get("characterId") or "").strip() for player in players)
            if len([agent for agent in team_agent_ids if agent]) != 5:
                continue
            key = "|".join(team_agent_ids)
            team_result = team_results.get(team_id) or {}
            row = compositions[current_map_id][key]
            row["agents"] = [agent_names.get(agent, agent) for agent in team_agent_ids]
            row["matches"] += 1
            row["wins"] += 1 if team_result.get("won") else 0
            rounds_won = int(team_result.get("roundsWon") or team_result.get("numPoints") or 0)
            opponent_rounds = 0
            for other_team_id, other_team in team_results.items():
                if other_team_id != team_id:
                    opponent_rounds = int(other_team.get("roundsWon") or other_team.get("numPoints") or 0)
                    break
            row["rounds_won"] += rounds_won
            row["rounds_lost"] += int(team_result.get("roundsLost") or opponent_rounds)

    map_stats: dict[str, Any] = {}
    for current_map_id, bucket in maps.items():
        totals = dict(bucket["totals"])
        derived = _finalize_with_legacy_rates(totals)
        sides: dict[str, Any] = {}
        for side_name, side_counter in bucket["sides"].items():
            rounds = int(side_counter.get("rounds", 0) or 0)
            wins = int(side_counter.get("wins", 0) or 0)
            sides[side_name] = {
                "rounds": rounds,
                "wins": wins,
                "win_rate": _safe_div(wins * 100.0, rounds),
                "kills": int(side_counter.get("kills", 0) or 0),
                "deaths": int(side_counter.get("deaths", 0) or 0),
                "adr": _safe_div(float(side_counter.get("damage_dealt", 0) or 0), rounds),
                "kills_per_round": _safe_div(float(side_counter.get("kills", 0) or 0), rounds),
            }
        map_stats[current_map_id] = {
            "map_name": bucket["map_name"],
            "matches": len(bucket["match_ids"]),
            "player_matches": int(bucket["player_matches"]),
            "wins": int(bucket["player_wins"]),
            "map_rounds": int(bucket["map_rounds"]),
            "player_rounds": int(totals.get("rounds", 0) or 0),
            "team_round_wins": int(bucket["team_round_wins"]),
            "team_round_losses": int(bucket["team_round_losses"]),
            "total_rounds": int(bucket["map_rounds"]),
            "rounds_with_kast": int(totals.get("rounds_with_kast", 0) or 0),
            "assists": int(totals.get("assists", 0) or 0),
            "survival_rounds": int(totals.get("survival_rounds", 0) or 0),
            "clutch_opportunities": int(totals.get("clutch_opportunities", 0) or 0),
            "clutches_won": int(totals.get("clutches_won", 0) or 0),
            "avg_rounds_per_match": _safe_div(float(bucket["map_rounds"]), len(bucket["match_ids"])),
            "win_rate": _safe_div(int(bucket["player_wins"]) * 100.0, int(bucket["player_matches"])),
            "player_win_rate": _safe_div(int(bucket["player_wins"]) * 100.0, int(bucket["player_matches"])),
            "team_round_win_rate": _safe_div(
                int(bucket["team_round_wins"]) * 100.0,
                int(bucket["team_round_wins"]) + int(bucket["team_round_losses"]),
            ),
            "kast_pct": derived.get("kast_pct", 0.0),
            "survival_rate": derived["survival_rate"],
            "clutch_win_rate": derived["clutch_win_rate"],
            "averages": {
                "kd_ratio": derived["kd_ratio"],
                "acs": derived["acs"],
                "adr": derived["adr"],
                "headshot_pct": derived["headshot_pct"],
                "kast_pct": derived.get("kast_pct", 0.0),
                "survival_rate": derived["survival_rate"],
                "clutch_win_rate": derived["clutch_win_rate"],
                "kills_per_round": derived["kills_per_round"],
                "deaths_per_round": derived["deaths_per_round"],
                "assists_per_round": derived["assists_per_round"],
            },
            "sides": sides,
            "round_ceremonies": dict(bucket["round_ceremonies"]),
        }

    agent_stats_by_map: dict[str, dict[str, Any]] = {}
    for current_map_id, agents in map_agents.items():
        total_picks = sum(int(bucket["picks"]) for bucket in agents.values())
        agent_stats_by_map[current_map_id] = {}
        for current_agent_id, bucket in agents.items():
            totals = dict(bucket["totals"])
            derived = _finalize_with_legacy_rates(totals)
            picks = int(bucket["picks"])
            agent_stats_by_map[current_map_id][current_agent_id] = {
                "agent_name": bucket["agent_name"],
                "picks": picks,
                "matches": picks,
                "wins": int(bucket["wins"]),
                "rounds": int(totals.get("rounds", 0) or 0),
                "pick_rate": _safe_div(picks * 100.0, total_picks),
                "win_rate": _safe_div(int(bucket["wins"]) * 100.0, picks),
                "avg_kd": derived["kd_ratio"],
                "avg_acs": derived["acs"],
                "avg_adr": derived["adr"],
            }

    weapon_stats_by_map: dict[str, dict[str, Any]] = {}
    for current_map_id, weapons in map_weapons.items():
        total_rounds = int((maps[current_map_id]["totals"]).get("rounds", 0) or 0)
        weapon_stats_by_map[current_map_id] = {}
        for weapon_id, bucket in weapons.items():
            rounds = int(bucket.get("rounds_equipped") or bucket.get("rounds") or 0)
            shots = int(bucket.get("headshots", 0) or 0) + int(bucket.get("bodyshots", 0) or 0) + int(bucket.get("legshots", 0) or 0)
            weapon_stats_by_map[current_map_id][weapon_id] = {
                "weapon_name": bucket.get("weapon_name"),
                "is_armor": bool(bucket.get("is_armor")),
                "rounds_equipped": rounds,
                "rounds_purchased": int(bucket.get("rounds_purchased", 0) or 0),
                "wins": int(bucket.get("wins", 0) or 0),
                "kills": int(bucket.get("kills", 0) or 0),
                "deaths": int(bucket.get("deaths", 0) or 0),
                "headshots": int(bucket.get("headshots", 0) or 0),
                "bodyshots": int(bucket.get("bodyshots", 0) or 0),
                "legshots": int(bucket.get("legshots", 0) or 0),
                "headshot_pct": _safe_div(int(bucket.get("headshots", 0) or 0) * 100.0, shots),
                "kd_ratio": _safe_div(float(bucket.get("kills", 0) or 0), float(bucket.get("deaths", 0) or 0)),
                "kills_per_round": _safe_div(float(bucket.get("kills", 0) or 0), rounds),
                "win_rate": _safe_div(int(bucket.get("wins", 0) or 0) * 100.0, rounds),
                "pick_rate_per_round": _safe_div(rounds * 100.0, total_rounds),
            }

    compositions_by_map: dict[str, list[dict[str, Any]]] = {}
    for current_map_id, rows in compositions.items():
        raw_rows = []
        for key, row in rows.items():
            matches = int(row["matches"])
            raw_rows.append({
                "key": key,
                "agents": row["agents"],
                "matches": matches,
                "wins": int(row["wins"]),
                "rounds_won": int(row["rounds_won"]),
                "rounds_lost": int(row["rounds_lost"]),
                "win_rate": _safe_div(int(row["wins"]) * 100.0, matches),
            })
        compositions_by_map[current_map_id] = raw_rows

    warnings = []
    if filtered_players == 0:
        warnings.append("No hay datos globales para el subconjunto filtrado.")
    elif filtered_players < 100:
        warnings.append("Muestra global baja para el subconjunto filtrado.")

    payload = {
        "filters": {
            "region": region_norm,
            "rank": str(rank_tier) if rank_tier is not None else None,
            "map": map_norm,
            "act": act_norm,
            "agent": agent_norm,
        },
        "options": _build_map_options_for_filters_cached(
            region=region_norm,
            map_id=map_norm,
            act_id=act_norm,
            rank=rank_tier,
            agent_id=agent_norm,
        ),
        "sampleSize": {
            "matches": len(match_ids),
            "players": filtered_players,
            "maps": len(map_stats),
        },
        "warnings": warnings,
        "mapStats": map_stats,
        "agentStatsByMap": agent_stats_by_map,
        "weaponStatsByMap": weapon_stats_by_map,
        "compositionsByMap": compositions_by_map,
    }
    with _map_stats_cache_lock:
        _map_stats_cache[cache_key] = (now + _MAP_STATS_CACHE_TTL_SECONDS, payload)
    return payload
