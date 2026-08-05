from __future__ import annotations

import math
import threading
import time
import unicodedata
import re
from datetime import datetime, timezone
from typing import Any

from modules.analytics.domain.constants import (
    SPATIAL_PROXIMITY_THRESHOLD_UNITS,
    TRADE_WINDOW_MS,
)
from modules.players.infrastructure import dashboard_queries
from modules.players.application.rank_resolution import (
    coerce_rank_tier_or_none,
    resolve_current_visual_rank,
)


_DASHBOARD_CONTENT_CACHE: tuple[float, dict[str, Any]] | None = None
_DASHBOARD_RESPONSE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_RANK_COMPARISON_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_DASHBOARD_CONTENT_CACHE_TTL_SECONDS = 300.0
_DASHBOARD_RESPONSE_CACHE_TTL_SECONDS = 120.0
_RANK_COMPARISON_CACHE_TTL_SECONDS = 600.0
_CACHE_LOCK = threading.Lock()


def _get_dashboard_content() -> dict[str, Any]:
    global _DASHBOARD_CONTENT_CACHE
    now = time.monotonic()
    with _CACHE_LOCK:
        if (
            _DASHBOARD_CONTENT_CACHE is None
            or (now - _DASHBOARD_CONTENT_CACHE[0]) > _DASHBOARD_CONTENT_CACHE_TTL_SECONDS
        ):
            _DASHBOARD_CONTENT_CACHE = (now, dashboard_queries.get_dashboard_content())
        return _DASHBOARD_CONTENT_CACHE[1]


from shared.math_utils import euclidean_distance_2d, safe_div as _safe_div
from shared.combat_events import build_team_lookup, valid_assistants, valid_kills
from shared.weapon_attribution import (
    compute_precise_weapon_stats_core,
    merge_precise_weapon_core_stats,
)


def _coerce_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        ivalue = int(value)
        return ivalue if ivalue > 0 else None
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            ivalue = int(float(value))
            return ivalue if ivalue > 0 else None
        except (TypeError, ValueError):
            return None
    return None


def _coerce_rank_tier(value: Any) -> int | None:
    return coerce_rank_tier_or_none(value)


def _format_tier_name(tier: int | None) -> str:
    if tier is None or tier < 3:
        return "Sin rango"

    names = {
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
    return names.get(tier, f"Tier {tier}")


_RANK_COMPARISON_METRICS: tuple[tuple[str, bool], ...] = (
    ("kd", False),
    ("k", False),
    ("d", True),
    ("a", False),
    ("kda", False),
    ("acs", False),
    ("hsPct", False),
    ("kast", False),
    ("incDamage", False),
    ("wr", False),
    ("wins", False),
    ("losses", True),
)

_RANK_METRIC_DEFAULT_PRIOR_WEIGHT = 10.0
_RANK_METRIC_SAMPLE_BASIS_BY_KEY: dict[str, str] = {
    # Totals that scale primarily with exposure per round.
    "k": "rounds",
    "d": "rounds",
    "a": "rounds",
    # Ratios treated as per-round reliability in this project.
    "kd": "rounds",
    "kda": "rounds",
    # Per-round performance rates.
    "acs": "rounds",
    "incDamage": "rounds",
    # Match-level outcomes.
    "wr": "matches",
    "wins": "matches",
    "losses": "matches",
    # Aim / tactical rates with dedicated denominators.
    "hsPct": "impacts",
    "kast": "kast_rounds_or_fallback",
}
_RANK_METRIC_PRIOR_WEIGHT_BY_KEY: dict[str, float] = {
    # Priors are expressed in the same unit as each metric sample basis.
    "k": 120.0,
    "d": 120.0,
    "a": 120.0,
    "kd": 120.0,
    "kda": 120.0,
    "acs": 120.0,
    "incDamage": 120.0,
    "wr": 10.0,
    "wins": 10.0,
    "losses": 10.0,
    "hsPct": 200.0,
    "kast": 120.0,
}
_RANK_ROUND_RATE_METRIC_KEYS = {"k", "d", "a"}
_RANK_MATCH_RATE_METRIC_KEYS = {"wins", "losses"}


def _normalize_rank_label(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    normalized = unicodedata.normalize("NFD", text)
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return " ".join(normalized.split())


def _sanitize_segment(value: Any) -> str:
    text = str(value if value is not None else "item").strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text)
    text = text.strip("._")
    return text[:120] if text else "item"


def _normalize_weapon_stats(
    weapon_stats: dict[str, dict[str, Any]] | list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not weapon_stats:
        return []

    if isinstance(weapon_stats, list):
        normalized: list[dict[str, Any]] = []
        for idx, entry in enumerate(weapon_stats):
            if not isinstance(entry, dict):
                continue
            key = entry.get("weapon_id") or f"weapon-{idx}"
            normalized.append({**entry, "key": key})
        return normalized

    if not isinstance(weapon_stats, dict):
        return []

    normalized: list[dict[str, Any]] = []
    for key, entry in weapon_stats.items():
        if not isinstance(entry, dict):
            continue
        normalized.append({**entry, "key": key})
    return normalized


def _coerce_non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float):
        return max(0, int(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return 0
        try:
            return max(0, int(float(stripped)))
        except (TypeError, ValueError):
            return 0
    return 0


def _clamp_round_count(value: Any, total_rounds: int) -> int:
    coerced = _coerce_non_negative_int(value)
    return min(coerced, max(total_rounds, 0))


def _pct_rounds(value: int, total_rounds: int) -> float:
    return round(_safe_div(float(value) * 100.0, max(total_rounds, 1)), 4)


def _pct_from_denominator(value: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(_safe_div(float(value) * 100.0, denominator), 4)


def _normalize_round_overview(overview: dict[str, Any] | None) -> dict[str, int | float]:
    source = overview or {}

    total_rounds = _coerce_non_negative_int(source.get("rounds"))
    plants = _coerce_non_negative_int(source.get("plants"))
    defuses = _coerce_non_negative_int(source.get("defuses"))
    plant_opportunities = _coerce_non_negative_int(source.get("plant_opportunities"))
    defuse_opportunities = _coerce_non_negative_int(source.get("defuse_opportunities"))
    rounds_with_kill = _clamp_round_count(source.get("rounds_with_kill"), total_rounds)
    rounds_with_assist = _clamp_round_count(source.get("rounds_with_assist"), total_rounds)
    rounds_with_death = _clamp_round_count(
        source.get("rounds_with_death", source.get("deaths")),
        total_rounds,
    )
    rounds_with_kast = _clamp_round_count(source.get("rounds_with_kast"), total_rounds)

    direct_fallback = max(rounds_with_kill, rounds_with_assist)
    rounds_with_direct_participation = _clamp_round_count(
        source.get("rounds_with_direct_participation", direct_fallback),
        total_rounds,
    )

    rounds_without_direct_participation = _clamp_round_count(
        source.get(
            "rounds_without_direct_participation",
            max(0, total_rounds - rounds_with_direct_participation),
        ),
        total_rounds,
    )
    if (
        rounds_with_direct_participation + rounds_without_direct_participation
        != total_rounds
    ):
        rounds_without_direct_participation = max(
            0,
            total_rounds - rounds_with_direct_participation,
        )

    rounds_only_kill = _clamp_round_count(source.get("rounds_only_kill"), total_rounds)
    remaining = max(0, total_rounds - rounds_only_kill)

    rounds_only_assist = min(
        _clamp_round_count(source.get("rounds_only_assist"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_only_assist)

    rounds_only_death = min(
        _clamp_round_count(source.get("rounds_only_death"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_only_death)

    rounds_kill_assist = min(
        _clamp_round_count(source.get("rounds_kill_assist"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_kill_assist)

    rounds_kill_death = min(
        _clamp_round_count(source.get("rounds_kill_death"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_kill_death)

    rounds_assist_death = min(
        _clamp_round_count(source.get("rounds_assist_death"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_assist_death)

    rounds_kill_assist_death = min(
        _clamp_round_count(source.get("rounds_kill_assist_death"), total_rounds),
        remaining,
    )
    remaining = max(0, remaining - rounds_kill_assist_death)

    rounds_none = min(
        _clamp_round_count(source.get("rounds_none"), total_rounds),
        remaining,
    )

    if (
        rounds_kill_assist == 0
        and rounds_kill_death == 0
        and rounds_assist_death == 0
        and rounds_kill_assist_death == 0
        and rounds_none == 0
    ):
        rounds_none = min(
            _clamp_round_count(source.get("rounds_combined_or_none"), total_rounds),
            remaining,
        )

    rounds_combined_or_none = (
        rounds_kill_assist
        + rounds_kill_death
        + rounds_assist_death
        + rounds_kill_assist_death
        + rounds_none
    )

    return {
        "total_rounds": total_rounds,
        "plants": plants,
        "defuses": defuses,
        "plant_opportunities": plant_opportunities,
        "defuse_opportunities": defuse_opportunities,
        "rounds_with_kill": rounds_with_kill,
        "rounds_with_assist": rounds_with_assist,
        "rounds_with_death": rounds_with_death,
        "rounds_with_kast": rounds_with_kast,
        "rounds_with_direct_participation": rounds_with_direct_participation,
        "rounds_without_direct_participation": rounds_without_direct_participation,
        "rounds_only_kill": rounds_only_kill,
        "rounds_only_assist": rounds_only_assist,
        "rounds_only_death": rounds_only_death,
        "rounds_kill_assist": rounds_kill_assist,
        "rounds_kill_death": rounds_kill_death,
        "rounds_assist_death": rounds_assist_death,
        "rounds_kill_assist_death": rounds_kill_assist_death,
        "rounds_none": rounds_none,
        "rounds_combined_or_none": rounds_combined_or_none,
        "rounds_with_kill_pct": _pct_rounds(rounds_with_kill, total_rounds),
        "rounds_with_assist_pct": _pct_rounds(rounds_with_assist, total_rounds),
        "rounds_with_death_pct": _pct_rounds(rounds_with_death, total_rounds),
        "rounds_with_kast_pct": _pct_rounds(rounds_with_kast, total_rounds),
        "rounds_with_direct_participation_pct": _pct_rounds(
            rounds_with_direct_participation,
            total_rounds,
        ),
        "rounds_without_direct_participation_pct": _pct_rounds(
            rounds_without_direct_participation,
            total_rounds,
        ),
        "rounds_only_kill_pct": _pct_rounds(rounds_only_kill, total_rounds),
        "rounds_only_assist_pct": _pct_rounds(rounds_only_assist, total_rounds),
        "rounds_only_death_pct": _pct_rounds(rounds_only_death, total_rounds),
        "rounds_kill_assist_pct": _pct_rounds(rounds_kill_assist, total_rounds),
        "rounds_kill_death_pct": _pct_rounds(rounds_kill_death, total_rounds),
        "rounds_assist_death_pct": _pct_rounds(rounds_assist_death, total_rounds),
        "rounds_kill_assist_death_pct": _pct_rounds(
            rounds_kill_assist_death,
            total_rounds,
        ),
        "rounds_none_pct": _pct_rounds(rounds_none, total_rounds),
        "rounds_combined_or_none_pct": _pct_rounds(
            rounds_combined_or_none,
            total_rounds,
        ),
        "plants_per_opportunity_pct": _pct_from_denominator(
            plants,
            plant_opportunities,
        ),
        "defuses_per_opportunity_pct": _pct_from_denominator(
            defuses,
            defuse_opportunities,
        ),
    }


def _unique_round_kill_key(kill: dict[str, Any]) -> tuple[Any, Any, Any, tuple[str, ...]]:
    assistants = tuple(sorted(str(a) for a in (kill.get("assistants") or []) if a))
    return (
        kill.get("timeSinceRoundStartMillis"),
        kill.get("killer"),
        kill.get("victim"),
        assistants,
    )


def _collect_unique_round_kills(round_obj: dict[str, Any]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, Any, Any, tuple[str, ...]]] = set()
    unique_kills: list[dict[str, Any]] = []

    for player_round in round_obj.get("playerStats") or []:
        for kill in (player_round or {}).get("kills") or []:
            if not isinstance(kill, dict):
                continue
            key = _unique_round_kill_key(kill)
            if key in seen:
                continue
            seen.add(key)
            unique_kills.append(kill)

    unique_kills.sort(key=lambda item: _coerce_non_negative_int(item.get("timeSinceRoundStartMillis")))
    return unique_kills


def _coerce_optional_non_negative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float):
        return max(0, int(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return max(0, int(float(stripped)))
        except (TypeError, ValueError):
            return None
    return None


def _build_match_team_lookup(match_obj: dict[str, Any]) -> dict[str, str]:
    team_by_puuid: dict[str, str] = {}
    for player in match_obj.get("players") or []:
        if not isinstance(player, dict):
            continue
        player_puuid = str(player.get("puuid") or "").strip()
        player_team = str(player.get("teamId") or "").strip()
        if not player_puuid or not player_team:
            continue
        team_by_puuid[player_puuid] = player_team
    return team_by_puuid


def _first_death_time_in_round(kills: list[dict[str, Any]], puuid: str) -> int | None:
    for kill in kills:
        if kill.get("victim") == puuid:
            return _coerce_non_negative_int(kill.get("timeSinceRoundStartMillis"))
    return None


def _get_player_location_snapshot_from_kill(
    kill: dict[str, Any],
    player_puuid: str | None,
) -> dict[str, Any] | None:
    if not player_puuid:
        return None

    for player_location in kill.get("playerLocations") or []:
        if not isinstance(player_location, dict):
            continue
        if player_location.get("puuid") != player_puuid:
            continue
        location = player_location.get("location")
        if isinstance(location, dict):
            return location
    return None


def _is_within_trade_proximity(
    actor_location: dict[str, Any] | None,
    reference_location: dict[str, Any] | None,
) -> bool:
    distance = euclidean_distance_2d(actor_location, reference_location)
    if distance is None:
        return True
    return distance <= SPATIAL_PROXIMITY_THRESHOLD_UNITS


def _prune_expired_trade_opportunities(
    opportunities: list[dict[str, Any]],
    current_time_ms: int,
) -> None:
    opportunities[:] = [
        opp
        for opp in opportunities
        if current_time_ms <= _coerce_non_negative_int(opp.get("expires_at"))
    ]


def _consume_trade_opportunity(
    opportunities: list[dict[str, Any]],
    target_killer: Any,
    event_time_ms: int,
    actor_location: dict[str, Any] | None,
    require_proximity: bool = True,
) -> bool:
    if not target_killer:
        return False

    for idx, opportunity in enumerate(opportunities):
        if opportunity.get("target_killer") != target_killer:
            continue

        expires_at = _coerce_non_negative_int(opportunity.get("expires_at"))
        if event_time_ms > expires_at:
            continue

        if require_proximity:
            reference_location = opportunity.get("reference_location")
            if not _is_within_trade_proximity(actor_location, reference_location):
                continue

        opportunities.pop(idx)
        return True

    return False


def _close_trade_opportunities_for_killer(
    opportunities: list[dict[str, Any]],
    killer_puuid: Any,
) -> None:
    opportunities[:] = [
        opp for opp in opportunities if opp.get("target_killer") != killer_puuid
    ]


def _is_player_positioned_for_realistic_trade(
    kill: dict[str, Any],
    puuid: str,
    player_alive: bool,
) -> bool:
    if not player_alive:
        return False

    player_location = _get_player_location_snapshot_from_kill(kill, puuid)
    reference_location = kill.get("victimLocation")
    if not isinstance(reference_location, dict):
        reference_location = None
    return _is_within_trade_proximity(player_location, reference_location)


def _compute_trade_metrics_from_round_kills(
    kills: list[dict[str, Any]],
    puuid: str,
    player_team: set[str],
    enemy_team: set[str],
) -> dict[str, int | float]:
    if not kills:
        return {
            "trade_kills": 0,
            "trade_opportunities": 0,
            "missed_trade_opportunities": 0,
            "trade_conversion_rate": 0.0,
            "traded_deaths": 0,
        }

    trade_kills = 0
    traded_deaths = 0
    realistic_trade_candidates = 0
    realistic_trade_conversions = 0
    player_alive = True

    open_trade_kill_opportunities: list[dict[str, Any]] = []
    open_realistic_trade_kill_opportunities: list[dict[str, Any]] = []
    open_traded_death_opportunities: list[dict[str, Any]] = []

    for kill in kills:
        kill_time_ms = _coerce_non_negative_int(kill.get("timeSinceRoundStartMillis"))
        killer = kill.get("killer")
        victim = kill.get("victim")

        _prune_expired_trade_opportunities(open_trade_kill_opportunities, kill_time_ms)
        _prune_expired_trade_opportunities(
            open_realistic_trade_kill_opportunities,
            kill_time_ms,
        )
        _prune_expired_trade_opportunities(open_traded_death_opportunities, kill_time_ms)

        if killer == puuid and victim in enemy_team:
            player_location = _get_player_location_snapshot_from_kill(kill, puuid)
            if _consume_trade_opportunity(
                opportunities=open_trade_kill_opportunities,
                target_killer=victim,
                event_time_ms=kill_time_ms,
                actor_location=player_location,
                require_proximity=False,
            ):
                trade_kills += 1
                if _consume_trade_opportunity(
                    opportunities=open_realistic_trade_kill_opportunities,
                    target_killer=victim,
                    event_time_ms=kill_time_ms,
                    actor_location=player_location,
                ):
                    realistic_trade_conversions += 1

        if killer in player_team and killer != puuid and victim in enemy_team:
            teammate_location = _get_player_location_snapshot_from_kill(kill, str(killer))
            if _consume_trade_opportunity(
                opportunities=open_traded_death_opportunities,
                target_killer=victim,
                event_time_ms=kill_time_ms,
                actor_location=teammate_location,
                require_proximity=False,
            ):
                traded_deaths += 1

        if victim in enemy_team:
            _close_trade_opportunities_for_killer(open_trade_kill_opportunities, victim)
            _close_trade_opportunities_for_killer(
                open_realistic_trade_kill_opportunities,
                victim,
            )
            _close_trade_opportunities_for_killer(open_traded_death_opportunities, victim)

        if victim in player_team and victim != puuid and killer in enemy_team and player_alive:
            reference_location = kill.get("victimLocation")
            opportunity = {
                "target_killer": killer,
                "expires_at": kill_time_ms + TRADE_WINDOW_MS,
                "reference_location": reference_location if isinstance(reference_location, dict) else None,
            }
            open_trade_kill_opportunities.append(opportunity)

            if _is_player_positioned_for_realistic_trade(kill, puuid, player_alive):
                realistic_trade_candidates += 1
                open_realistic_trade_kill_opportunities.append(dict(opportunity))

        if victim == puuid and killer in enemy_team:
            reference_location = kill.get("victimLocation")
            open_traded_death_opportunities.append(
                {
                    "target_killer": killer,
                    "expires_at": kill_time_ms + TRADE_WINDOW_MS,
                    "reference_location": reference_location if isinstance(reference_location, dict) else None,
                }
            )

        if victim == puuid:
            player_alive = False

    missed_trade_opportunities = max(
        realistic_trade_candidates - realistic_trade_conversions,
        0,
    )
    trade_opportunities = trade_kills + missed_trade_opportunities

    return {
        "trade_kills": trade_kills,
        "trade_opportunities": trade_opportunities,
        "missed_trade_opportunities": missed_trade_opportunities,
        "trade_conversion_rate": _pct_from_denominator(
            trade_kills,
            trade_opportunities,
        ),
        "traded_deaths": traded_deaths,
    }


def _compute_trade_counts_from_round_kills(
    kills: list[dict[str, Any]],
    puuid: str,
    player_team: set[str],
    enemy_team: set[str],
) -> tuple[int, int]:
    metrics = _compute_trade_metrics_from_round_kills(
        kills,
        puuid,
        player_team,
        enemy_team,
    )
    return int(metrics["trade_kills"]), int(metrics["traded_deaths"])


def _was_player_alive_at_round_event(
    round_obj: dict[str, Any],
    puuid: str,
    first_death_time_ms: int | None,
    event_kind: str,
) -> bool:
    if event_kind == "plant":
        event_locations = round_obj.get("plantPlayerLocations") or []
        event_time = _coerce_optional_non_negative_int(round_obj.get("plantRoundTime"))
    else:
        event_locations = round_obj.get("defusePlayerLocations") or []
        event_time = _coerce_optional_non_negative_int(round_obj.get("defuseRoundTime"))

    if isinstance(event_locations, list) and event_locations:
        for player_location in event_locations:
            if isinstance(player_location, dict) and player_location.get("puuid") == puuid:
                return True
        return False

    if event_time is None:
        return first_death_time_ms is None

    return first_death_time_ms is None or first_death_time_ms > event_time


def _compute_round_overview_from_round_results(
    match_obj: dict[str, Any],
    puuid: str,
) -> dict[str, Any]:
    round_results = match_obj.get("roundResults") or []
    if not isinstance(round_results, list) or not round_results:
        return {}

    team_by_puuid = _build_match_team_lookup(match_obj)
    player_team_id = team_by_puuid.get(puuid)
    if player_team_id:
        player_team_members = {
            member_puuid
            for member_puuid, team_id in team_by_puuid.items()
            if team_id == player_team_id
        }
        enemy_team_members = {
            member_puuid
            for member_puuid, team_id in team_by_puuid.items()
            if team_id and team_id != player_team_id
        }
    else:
        player_team_members = {puuid}
        enemy_team_members: set[str] = set()

    rounds = 0
    rounds_with_kill = 0
    rounds_with_assist = 0
    rounds_with_death = 0
    rounds_with_kast = 0
    rounds_with_direct_participation = 0
    rounds_without_direct_participation = 0
    rounds_only_kill = 0
    rounds_only_assist = 0
    rounds_only_death = 0
    rounds_kill_assist = 0
    rounds_kill_death = 0
    rounds_assist_death = 0
    rounds_kill_assist_death = 0
    rounds_none = 0
    rounds_combined_or_none = 0
    first_kills = 0
    plants = 0
    defuses = 0
    plant_opportunities = 0
    defuse_opportunities = 0
    trade_kills = 0
    trade_opportunities = 0
    missed_trade_opportunities = 0
    traded_deaths = 0
    rounds_with_multikill = 0
    multi_2k = 0
    multi_3k = 0
    multi_4k = 0
    multi_5k = 0
    round_ceremonies: dict[str, int] = {}

    for round_obj in round_results:
        if not isinstance(round_obj, dict):
            continue

        rounds += 1
        own_team_won_round = bool(
            player_team_id
            and str(round_obj.get("winningTeam") or "").lower()
            == str(player_team_id).lower()
        )
        ceremony = str(round_obj.get("roundCeremony") or "").strip()
        if own_team_won_round and ceremony:
            round_ceremonies[ceremony] = round_ceremonies.get(ceremony, 0) + 1
        unique_kills = _collect_unique_round_kills(round_obj)
        competitive_kills = valid_kills(unique_kills, team_by_puuid)
        first_death_time_ms = _first_death_time_in_round(unique_kills, puuid)
        kills_round = sum(
            1 for kill in competitive_kills if kill.get("killer") == puuid
        )
        assists_round = sum(
            1
            for kill in competitive_kills
            if puuid in valid_assistants(kill, team_by_puuid)
        )
        died = any(kill.get("victim") == puuid for kill in unique_kills)

        round_trade_metrics = _compute_trade_metrics_from_round_kills(
            kills=competitive_kills,
            puuid=puuid,
            player_team=player_team_members,
            enemy_team=enemy_team_members,
        )
        trade_kills += int(round_trade_metrics["trade_kills"])
        trade_opportunities += int(round_trade_metrics["trade_opportunities"])
        missed_trade_opportunities += int(
            round_trade_metrics["missed_trade_opportunities"]
        )
        traded_deaths += int(round_trade_metrics["traded_deaths"])

        has_kill = kills_round > 0
        has_assist = assists_round > 0
        has_death = died
        has_kast = (
            not died
            or has_kill
            or has_assist
            or int(round_trade_metrics["traded_deaths"]) > 0
        )

        if competitive_kills and competitive_kills[0].get("killer") == puuid:
            first_kills += 1

        planter = round_obj.get("bombPlanter")
        if planter == puuid:
            plants += 1
        if planter and (
            planter == puuid
            or (player_team_id and team_by_puuid.get(planter) == player_team_id)
        ):
            if _was_player_alive_at_round_event(
                round_obj=round_obj,
                puuid=puuid,
                first_death_time_ms=first_death_time_ms,
                event_kind="plant",
            ):
                plant_opportunities += 1

        defuser = round_obj.get("bombDefuser")
        if defuser == puuid:
            defuses += 1
        if defuser and (
            defuser == puuid
            or (player_team_id and team_by_puuid.get(defuser) == player_team_id)
        ):
            if _was_player_alive_at_round_event(
                round_obj=round_obj,
                puuid=puuid,
                first_death_time_ms=first_death_time_ms,
                event_kind="defuse",
            ):
                defuse_opportunities += 1

        if kills_round >= 2:
            rounds_with_multikill += 1
        if kills_round == 2:
            multi_2k += 1
        elif kills_round == 3:
            multi_3k += 1
        elif kills_round == 4:
            multi_4k += 1
        elif kills_round >= 5:
            multi_5k += 1

        if has_kill:
            rounds_with_kill += 1
        if has_assist:
            rounds_with_assist += 1
        if has_death:
            rounds_with_death += 1
        if has_kast:
            rounds_with_kast += 1

        if has_kill or has_assist:
            rounds_with_direct_participation += 1
        else:
            rounds_without_direct_participation += 1

        if has_kill and not has_assist and not has_death:
            rounds_only_kill += 1
        elif has_assist and not has_kill and not has_death:
            rounds_only_assist += 1
        elif has_death and not has_kill and not has_assist:
            rounds_only_death += 1
        elif has_kill and has_assist and not has_death:
            rounds_kill_assist += 1
        elif has_kill and has_death and not has_assist:
            rounds_kill_death += 1
        elif has_assist and has_death and not has_kill:
            rounds_assist_death += 1
        elif has_kill and has_assist and has_death:
            rounds_kill_assist_death += 1
        else:
            rounds_none += 1

        rounds_combined_or_none += (
            (1 if has_kill and has_assist and not has_death else 0)
            + (1 if has_kill and has_death and not has_assist else 0)
            + (1 if has_assist and has_death and not has_kill else 0)
            + (1 if has_kill and has_assist and has_death else 0)
            + (1 if not has_kill and not has_assist and not has_death else 0)
        )

    if rounds <= 0:
        return {}

    return {
        "rounds": rounds,
        "first_kills": first_kills,
        "plants": plants,
        "defuses": defuses,
        "plant_opportunities": plant_opportunities,
        "defuse_opportunities": defuse_opportunities,
        "trade_kills": trade_kills,
        "trade_opportunities": trade_opportunities,
        "missed_trade_opportunities": missed_trade_opportunities,
        "trade_conversion_rate": _pct_from_denominator(
            trade_kills,
            trade_opportunities,
        ),
        "traded_deaths": traded_deaths,
        "rounds_with_kill": rounds_with_kill,
        "rounds_with_assist": rounds_with_assist,
        "rounds_with_death": rounds_with_death,
        "rounds_with_kast": rounds_with_kast,
        "rounds_with_direct_participation": rounds_with_direct_participation,
        "rounds_without_direct_participation": rounds_without_direct_participation,
        "rounds_only_kill": rounds_only_kill,
        "rounds_only_assist": rounds_only_assist,
        "rounds_only_death": rounds_only_death,
        "rounds_kill_assist": rounds_kill_assist,
        "rounds_kill_death": rounds_kill_death,
        "rounds_assist_death": rounds_assist_death,
        "rounds_kill_assist_death": rounds_kill_assist_death,
        "rounds_none": rounds_none,
        "rounds_combined_or_none": rounds_combined_or_none,
        "rounds_with_multikill": rounds_with_multikill,
        "multi_2k": multi_2k,
        "multi_3k": multi_3k,
        "multi_4k": multi_4k,
        "multi_5k": multi_5k,
        "round_ceremonies": round_ceremonies,
    }


def _compute_rounds_panel_summary(analytics_docs: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {
        "total_rounds": 0,
        "rounds_with_kill": 0,
        "rounds_with_assist": 0,
        "rounds_with_death": 0,
        "rounds_with_kast": 0,
        "direct_participation_rounds": 0,
        "no_direct_participation_rounds": 0,
        "distribution_only_kills_rounds": 0,
        "distribution_only_assists_rounds": 0,
        "distribution_only_deaths_rounds": 0,
        "distribution_kill_assist_rounds": 0,
        "distribution_kill_death_rounds": 0,
        "distribution_assist_death_rounds": 0,
        "distribution_kill_assist_death_rounds": 0,
        "distribution_none_rounds": 0,
        "distribution_combined_or_none_rounds": 0,
        "first_bloods": 0,
        "aces": 0,
        "plants": 0,
        "defuses": 0,
        "plant_opportunities": 0,
        "defuse_opportunities": 0,
    }

    for doc in analytics_docs:
        overview = doc.get("overview") or {}
        normalized_rounds = _normalize_round_overview(overview)

        totals["total_rounds"] += int(normalized_rounds["total_rounds"])
        totals["rounds_with_kill"] += int(normalized_rounds["rounds_with_kill"])
        totals["rounds_with_assist"] += int(normalized_rounds["rounds_with_assist"])
        totals["rounds_with_death"] += int(normalized_rounds["rounds_with_death"])
        totals["rounds_with_kast"] += int(normalized_rounds["rounds_with_kast"])
        totals["direct_participation_rounds"] += int(
            normalized_rounds["rounds_with_direct_participation"]
        )
        totals["no_direct_participation_rounds"] += int(
            normalized_rounds["rounds_without_direct_participation"]
        )
        totals["distribution_only_kills_rounds"] += int(
            normalized_rounds["rounds_only_kill"]
        )
        totals["distribution_only_assists_rounds"] += int(
            normalized_rounds["rounds_only_assist"]
        )
        totals["distribution_only_deaths_rounds"] += int(
            normalized_rounds["rounds_only_death"]
        )
        totals["distribution_kill_assist_rounds"] += int(
            normalized_rounds["rounds_kill_assist"]
        )
        totals["distribution_kill_death_rounds"] += int(
            normalized_rounds["rounds_kill_death"]
        )
        totals["distribution_assist_death_rounds"] += int(
            normalized_rounds["rounds_assist_death"]
        )
        totals["distribution_kill_assist_death_rounds"] += int(
            normalized_rounds["rounds_kill_assist_death"]
        )
        totals["distribution_none_rounds"] += int(
            normalized_rounds["rounds_none"]
        )
        totals["distribution_combined_or_none_rounds"] += int(
            normalized_rounds["rounds_combined_or_none"]
        )

        totals["first_bloods"] += _coerce_non_negative_int(overview.get("first_kills"))
        totals["aces"] += _coerce_non_negative_int(overview.get("multi_5k"))
        totals["plants"] += int(normalized_rounds["plants"])
        totals["defuses"] += int(normalized_rounds["defuses"])
        totals["plant_opportunities"] += int(normalized_rounds["plant_opportunities"])
        totals["defuse_opportunities"] += int(normalized_rounds["defuse_opportunities"])

    total_rounds = int(totals["total_rounds"])

    return {
        **totals,
        "rounds_with_kill_pct": _pct_rounds(int(totals["rounds_with_kill"]), total_rounds),
        "rounds_with_assist_pct": _pct_rounds(int(totals["rounds_with_assist"]), total_rounds),
        "rounds_with_death_pct": _pct_rounds(int(totals["rounds_with_death"]), total_rounds),
        "rounds_with_kast_pct": _pct_rounds(int(totals["rounds_with_kast"]), total_rounds),
        "direct_participation_pct": _pct_rounds(
            int(totals["direct_participation_rounds"]),
            total_rounds,
        ),
        "no_direct_participation_pct": _pct_rounds(
            int(totals["no_direct_participation_rounds"]),
            total_rounds,
        ),
        "distribution_only_kills_pct": _pct_rounds(
            int(totals["distribution_only_kills_rounds"]),
            total_rounds,
        ),
        "distribution_only_assists_pct": _pct_rounds(
            int(totals["distribution_only_assists_rounds"]),
            total_rounds,
        ),
        "distribution_only_deaths_pct": _pct_rounds(
            int(totals["distribution_only_deaths_rounds"]),
            total_rounds,
        ),
        "distribution_kill_assist_pct": _pct_rounds(
            int(totals["distribution_kill_assist_rounds"]),
            total_rounds,
        ),
        "distribution_kill_death_pct": _pct_rounds(
            int(totals["distribution_kill_death_rounds"]),
            total_rounds,
        ),
        "distribution_assist_death_pct": _pct_rounds(
            int(totals["distribution_assist_death_rounds"]),
            total_rounds,
        ),
        "distribution_kill_assist_death_pct": _pct_rounds(
            int(totals["distribution_kill_assist_death_rounds"]),
            total_rounds,
        ),
        "distribution_none_pct": _pct_rounds(
            int(totals["distribution_none_rounds"]),
            total_rounds,
        ),
        "distribution_combined_or_none_pct": _pct_rounds(
            int(totals["distribution_combined_or_none_rounds"]),
            total_rounds,
        ),
        "plants_per_opportunity_pct": _pct_from_denominator(
            int(totals["plants"]),
            int(totals["plant_opportunities"]),
        ),
        "defuses_per_opportunity_pct": _pct_from_denominator(
            int(totals["defuses"]),
            int(totals["defuse_opportunities"]),
        ),
    }


def _build_competitive_tier_maps(
    content_doc: dict[str, Any],
) -> tuple[dict[int, str], dict[str, str]]:
    tier_by_number: dict[int, str] = {}
    tier_by_name: dict[str, str] = {}

    tier_docs = (
        content_doc.get("competitiveTiers")
        or content_doc.get("competitive_tiers")
        or []
    )

    docs_to_process: list[dict[str, Any]] = []
    if isinstance(tier_docs, list) and tier_docs:
        docs_to_process = [tier_docs[-1]]
    elif isinstance(tier_docs, dict):
        docs_to_process = [tier_docs]

    for doc in docs_to_process:
        tiers = doc.get("tiers") or {}
        entries: list[dict[str, Any]]
        if isinstance(tiers, list):
            entries = [entry for entry in tiers if isinstance(entry, dict)]
        elif isinstance(tiers, dict):
            entries = [x for x in tiers.values() if isinstance(x, dict)]
        else:
            entries = []

        for entry in entries:
            tier_raw = entry.get("tier")
            tier = None
            if isinstance(tier_raw, bool):
                tier = None
            elif isinstance(tier_raw, int):
                tier = tier_raw if tier_raw >= 0 else None
            elif isinstance(tier_raw, float):
                tier_value = int(tier_raw)
                tier = tier_value if tier_value >= 0 else None
            elif isinstance(tier_raw, str):
                try:
                    tier_value = int(float(tier_raw.strip()))
                    tier = tier_value if tier_value >= 0 else None
                except (TypeError, ValueError):
                    tier = None

            tier_set_uuid = doc.get("uuid") or doc.get("id")
            tier_name_sanitized = _sanitize_segment(entry.get("tierName"))
            icon = None
            if tier_set_uuid and tier_name_sanitized:
                icon = (
                    f"/content/competitive_tiers/{tier_set_uuid}/tiers/"
                    f"{tier_name_sanitized}/smallIcon.png"
                )
            tier_name = _normalize_rank_label(entry.get("tierName"))
            division_name = _normalize_rank_label(entry.get("divisionName"))
            if tier_name and icon and tier_name not in tier_by_name:
                tier_by_name[tier_name] = icon

            if tier is not None and icon and tier not in tier_by_number:
                tier_by_number[tier] = icon

            if tier is not None and division_name and icon and tier >= 3:
                division_level = ((tier - 3) % 3) + 1
                division_key = f"{division_name} {division_level}"
                if division_key not in tier_by_name:
                    tier_by_name[division_key] = icon

                english_key = _normalize_rank_label(_format_tier_name(tier))
                if english_key and english_key not in tier_by_name:
                    tier_by_name[english_key] = icon

    return tier_by_number, tier_by_name


def _build_act_label_map(content_doc: dict[str, Any]) -> dict[str, str]:
    acts = content_doc.get("acts", []) or []
    name_by_id: dict[str, str] = {}

    for act in acts:
        act_id = act.get("id")
        act_name = act.get("name")
        if act_id and act_name:
            name_by_id[act_id] = act_name

    label_map: dict[str, str] = {}
    for act in acts:
        act_id = act.get("id")
        if not act_id:
            continue

        own_name = act.get("name") or act_id
        parent_id = act.get("parentId") or act.get("parent_id")
        parent = act.get("parent") or {}
        parent_name = (
            act.get("parentName") or parent.get("name") or name_by_id.get(parent_id)
        )

        is_root = True
        if parent_id:
            parent_norm = str(parent_id).strip().lower()
            is_root = parent_norm in {
                "00000000-0000-0000-0000-000000000000",
                "00000000-0000-0000-0000-00000000000",
            }

        if (not is_root) and parent_name:
            label_map[act_id] = f"{own_name} - {parent_name}"
        else:
            label_map[act_id] = own_name

    return label_map


def _act_time_millis(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text:
        return 0
    try:
        return int(float(text))
    except (TypeError, ValueError):
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0
    return int(parsed.timestamp() * 1000)


def _resolve_current_act_id(content_doc: dict[str, Any]) -> str | None:
    acts = content_doc.get("acts", []) or []
    if not acts:
        return None

    active_act = next(
        (
            act
            for act in acts
            if str(act.get("type") or "").strip().lower() == "act"
            and bool(act.get("isActive"))
        ),
        None,
    )
    if active_act and active_act.get("id"):
        return str(active_act["id"])

    active_episode = next(
        (
            act
            for act in acts
            if str(act.get("type") or "").strip().lower() == "episode"
            and bool(act.get("isActive"))
        ),
        None,
    )
    if not active_episode:
        return None

    parent_id = active_episode.get("id")
    if not parent_id:
        return None

    episode_acts = [
        act
        for act in acts
        if str(act.get("type") or "").strip().lower() == "act"
        and (act.get("parentId") or act.get("parent_id")) == parent_id
    ]

    if not episode_acts:
        return None

    # Se asume que el contenido viene ordenado del acto más reciente al más antiguo
    episode_acts.sort(
        key=lambda act: (
            _act_time_millis(act.get("startTime")),
            _act_time_millis(act.get("endTime")),
        ),
        reverse=True,
    )
    latest_act = episode_acts[0]
    return str(latest_act.get("id")) if latest_act.get("id") else None


def _build_agent_maps(
    content_doc: dict[str, Any],
) -> tuple[dict[str, str], dict[str, dict[str, str | None]]]:
    name_map: dict[str, str] = {}
    media_map: dict[str, dict[str, str | None]] = {}

    for agent in content_doc.get("agents", []) or []:
        agent_id = agent.get("uuid") or agent.get("id")
        agent_name = agent.get("displayName") or agent.get("name")
        if not agent_id:
            continue

        if agent_name:
            name_map[agent_id] = agent_name

        role = agent.get("role") or {}
        role_name = role.get("displayName")
        media_map[agent_id] = {
            "name": agent_name or "Agente desconocido",
            "image": f"/content/agents/{agent_id}/fullPortrait.png",
            "displayIcon": f"/content/agents/{agent_id}/displayIcon.png",
            "roleName": role_name,
            "roleIcon": (
                f"/content/agents/{agent_id}/role/displayIcon.png"
                if role_name
                else None
            ),
        }

    return name_map, media_map


def _build_map_icon_map(content_doc: dict[str, Any]) -> dict[str, str]:
    map_icon_by_name: dict[str, str] = {}
    for map_entry in content_doc.get("maps", []) or []:
        map_name = _normalize_rank_label(
            map_entry.get("displayName") or map_entry.get("name")
        )
        map_uuid = map_entry.get("uuid") or map_entry.get("id")
        icon = f"/content/maps/{map_uuid}/splash.png" if map_uuid else None
        if map_name and icon and map_name not in map_icon_by_name:
            map_icon_by_name[map_name] = icon
    return map_icon_by_name


def _build_weapon_icon_map(content_doc: dict[str, Any]) -> dict[str, str]:
    weapon_icon_by_name: dict[str, str] = {}
    for weapon_entry in content_doc.get("weapons", []) or []:
        weapon_name = _normalize_rank_label(weapon_entry.get("displayName"))
        weapon_uuid = weapon_entry.get("uuid") or weapon_entry.get("id")
        icon = f"/content/weapons/{weapon_uuid}/displayIcon.png" if weapon_uuid else None
        if weapon_name and icon and weapon_name not in weapon_icon_by_name:
            weapon_icon_by_name[weapon_name] = icon
    return weapon_icon_by_name


def _latest_rank_from_matches(puuid: str) -> dict[str, Any]:
    if not puuid:
        return {}

    cursor = dashboard_queries.find_recent_matches_with_rank(puuid, limit=50)

    for match in cursor:
        for player in match.get("players") or []:
            if player.get("puuid") != puuid:
                continue

            tier = _coerce_rank_tier(
                player.get("competitiveTier", player.get("competitive_tier"))
            )
            if tier is not None:
                return {"tier": tier}

    return {}


def _load_match_duration_map(match_ids: list[str]) -> dict[str, int]:
    clean_ids = [mid for mid in match_ids if mid]
    if not clean_ids:
        return {}

    duration_map: dict[str, int] = {}
    cursor = dashboard_queries.find_match_durations(clean_ids)

    for doc in cursor:
        match_info = doc.get("matchInfo") or {}
        raw_duration = match_info.get("gameLengthMillis")
        try:
            duration = int(raw_duration or 0)
        except (TypeError, ValueError):
            duration = 0
        if duration <= 0:
            continue

        match_id_candidates = [
            str((doc.get("metadata") or {}).get("match_id") or "").strip(),
            str(match_info.get("matchId") or "").strip(),
        ]
        for match_id in match_id_candidates:
            if match_id and match_id not in duration_map:
                duration_map[match_id] = duration

    return duration_map


def _extract_side_stats(side_data: dict[str, Any]) -> dict[str, Any]:
    # Do not forward nested weapon/economy structures for every side. The UI
    # consumes these counters and derived values only; the full weapon detail
    # remains available in overview.weapon_stats.
    fields = (
        "rounds", "wins", "kills", "deaths", "assists", "score",
        "damage_dealt", "damage_received", "headshots", "bodyshots", "legshots",
        "acs", "adr", "kd_ratio", "headshot_pct", "first_kills", "first_deaths",
        "rounds_with_kill", "rounds_with_assist", "rounds_with_death",
        "rounds_with_direct_participation",
        "rounds_without_direct_participation",
        "rounds_only_kill", "rounds_only_assist", "rounds_only_death",
        "rounds_kill_assist", "rounds_kill_death", "rounds_assist_death",
        "rounds_kill_assist_death", "rounds_none", "rounds_combined_or_none",
        "rounds_with_multikill", "multi_2k", "multi_3k", "multi_4k", "multi_5k",
    )
    return {field: side_data.get(field) for field in fields if field in side_data}


def _extract_sides_summary(doc: dict[str, Any]) -> dict[str, Any] | None:
    sides = doc.get("sides")
    if not sides or not isinstance(sides, dict):
        return None
    result: dict[str, Any] = {}
    if "attack" in sides and isinstance(sides["attack"], dict):
        result["attack"] = _extract_side_stats(sides["attack"])
    if "defense" in sides and isinstance(sides["defense"], dict):
        result["defense"] = _extract_side_stats(sides["defense"])
    return result if result else None


def _load_party_size_map(match_ids: list[str], puuid: str) -> dict[str, int]:
    """Batch-query matches to compute party size for the given player."""
    clean_ids = [mid for mid in match_ids if mid]
    if not clean_ids or not puuid:
        return {}

    party_map: dict[str, int] = {}
    cursor = dashboard_queries.find_match_parties(clean_ids)

    for doc in cursor:
        match_info = doc.get("matchInfo") or {}
        mid = (
            str(match_info.get("matchId") or "").strip()
            or str((doc.get("metadata") or {}).get("match_id") or "").strip()
        )
        if not mid:
            continue

        players = doc.get("players") or []
        target_party_id = None
        for p in players:
            if p.get("puuid") == puuid:
                target_party_id = p.get("partyId")
                break

        if not target_party_id:
            party_map[mid] = 1
            continue

        count = sum(1 for p in players if p.get("partyId") == target_party_id)
        party_map[mid] = max(count, 1)

    return party_map


def _load_weapon_usage_summary(
    puuid: str,
    season_id: str | None = None,
) -> list[dict[str, Any]]:
    """Compute top weapon usage server-side from embedded analytics in matches."""
    if not puuid:
        return []

    match_stage: dict[str, Any] = {
        "players.puuid": puuid,
        "matchInfo.isRanked": True,
    }
    if season_id:
        match_stage["matchInfo.seasonId"] = season_id

    pipeline: list[dict[str, Any]] = [
        {"$match": match_stage},
        {"$unwind": "$players"},
        {"$match": {"players.puuid": puuid, "players.analytics": {"$exists": True}}},
        {
            "$project": {
                "_id": 0,
                "won_match": "$players.analytics.won_match",
                "ws": {"$objectToArray": {"$ifNull": ["$players.analytics.overview.weapon_stats", {}]}},
            }
        },
        {"$unwind": "$ws"},
        {
            "$project": {
                "weapon_id": "$ws.k",
                "weapon_name": {"$ifNull": ["$ws.v.weapon_name", "Arma desconocida"]},
                "source_id": {"$ifNull": ["$ws.v.source_id", "$ws.k"]},
                "source_name": {
                    "$ifNull": [
                        "$ws.v.source_name",
                        {"$ifNull": ["$ws.v.weapon_name", "Arma desconocida"]},
                    ]
                },
                "source_type": {"$ifNull": ["$ws.v.source_type", "weapon"]},
                "source_icon": "$ws.v.source_icon",
                "is_ability": {"$ifNull": ["$ws.v.is_ability", False]},
                "rounds": {
                    "$convert": {
                        "input": "$ws.v.rounds",
                        "to": "int",
                        "onError": 0,
                        "onNull": 0,
                    }
                },
                "kills": {
                    "$convert": {
                        "input": "$ws.v.kills",
                        "to": "int",
                        "onError": 0,
                        "onNull": 0,
                    }
                },
                "deaths": {
                    "$convert": {
                        "input": "$ws.v.deaths",
                        "to": "int",
                        "onError": 0,
                        "onNull": 0,
                    }
                },
                "won_match": 1,
            }
        },
        {
            "$group": {
                "_id": "$source_id",
                "name": {"$first": "$source_name"},
                "type": {"$first": "$source_type"},
                "icon": {"$first": "$source_icon"},
                "isAbility": {"$max": {"$cond": ["$is_ability", 1, 0]}},
                "rounds": {"$sum": "$rounds"},
                "kills": {"$sum": "$kills"},
                "matches": {
                    "$sum": {
                        "$cond": [
                            {"$gt": ["$rounds", 0]},
                            1,
                            0,
                        ]
                    }
                },
                "wins": {
                    "$sum": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$gt": ["$rounds", 0]},
                                    {"$eq": ["$won_match", True]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
            }
        },
        {"$sort": {"kills": -1, "rounds": -1, "matches": -1}},
        {"$limit": 20},
    ]

    return dashboard_queries.aggregate_weapon_usage(pipeline)


def _build_match_card_id(doc: dict[str, Any]) -> str:
    raw_match_id = doc.get("match_id")
    if raw_match_id:
        return str(raw_match_id)

    timestamp = int(doc.get("game_start_millis") or 0)
    map_name = str(doc.get("map_name") or "match").strip() or "match"
    agent_id = str(doc.get("agent_id") or "agent").strip() or "agent"
    season_id = str(doc.get("season_id") or "season").strip() or "season"
    return f"{timestamp}-{season_id}-{map_name}-{agent_id}"


def _build_light_analytics_list(
    analytics_docs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    light_docs: list[dict[str, Any]] = []

    for doc in analytics_docs:
        overview = doc.get("overview") or {}
        player_totals = doc.get("player_totals_from_match") or {}
        normalized_rounds = _normalize_round_overview(overview)

        compact_weapon_fields = (
            "weapon_id", "weapon_name", "key", "is_armor", "rounds",
            "rounds_equipped", "wins", "kills", "deaths", "assists",
            "damage_dealt", "damage_received", "survival_rounds",
            "loadout_value_total", "headshots", "bodyshots", "legshots",
        )
        compact_weapons = [
            {
                field: weapon.get(field)
                for field in compact_weapon_fields
                if field in weapon
            }
            for weapon in _normalize_weapon_stats(overview.get("weapon_stats"))
            if isinstance(weapon, dict)
        ]

        light_docs.append(
            {
                "id": _build_match_card_id(doc),
                "match_id": doc.get("match_id"),
                "won_match": doc.get("won_match"),
                "season_id": doc.get("season_id"),
                "map_id": doc.get("map_id"),
                "map_name": doc.get("map_name"),
                "game_start_millis": doc.get("game_start_millis"),
                "agent_id": doc.get("agent_id"),
                "agent_name": doc.get("agent_name"),
                "team_agents": doc.get("team_agents"),
                "role": doc.get("role"),
                "competitive_tier": doc.get("competitive_tier"),
                "overview": {
                    "kills": overview.get("kills"),
                    "deaths": overview.get("deaths"),
                    "assists": overview.get("assists"),
                    "acs": overview.get("acs"),
                    "adr": overview.get("adr"),
                    "headshot_pct": overview.get("headshot_pct"),
                    "rounds": normalized_rounds.get("total_rounds"),
                    "wins": overview.get("wins"),
                    "losses": overview.get("losses"),
                    "headshots": overview.get("headshots"),
                    "bodyshots": overview.get("bodyshots"),
                    "legshots": overview.get("legshots"),
                    "plants": normalized_rounds.get("plants"),
                    "defuses": normalized_rounds.get("defuses"),
                    "plant_opportunities": normalized_rounds.get("plant_opportunities"),
                    "defuse_opportunities": normalized_rounds.get("defuse_opportunities"),
                    "plants_per_opportunity_pct": normalized_rounds.get(
                        "plants_per_opportunity_pct"
                    ),
                    "defuses_per_opportunity_pct": normalized_rounds.get(
                        "defuses_per_opportunity_pct"
                    ),
                    "weapon_stats": compact_weapons,
                    # Tactical / advanced fields
                    "first_kills": overview.get("first_kills"),
                    "first_deaths": overview.get("first_deaths"),
                    "opening_duel_win_pct": overview.get("opening_duel_win_pct"),
                    "trade_kills": overview.get("trade_kills"),
                    "trade_opportunities": overview.get("trade_opportunities"),
                    "missed_trade_opportunities": overview.get(
                        "missed_trade_opportunities"
                    ),
                    "trade_conversion_rate": overview.get("trade_conversion_rate"),
                    "traded_deaths": overview.get("traded_deaths"),
                    "clutch_opportunities": overview.get("clutch_opportunities"),
                    "clutches_won": overview.get("clutches_won"),
                    "clutch_win_rate": overview.get("clutch_win_rate"),
                    "clutch_1v1_opportunities": overview.get("clutch_1v1_opportunities"),
                    "clutch_1v1_wins": overview.get("clutch_1v1_wins"),
                    "clutch_1v2_opportunities": overview.get("clutch_1v2_opportunities"),
                    "clutch_1v2_wins": overview.get("clutch_1v2_wins"),
                    "clutch_1v3_opportunities": overview.get("clutch_1v3_opportunities"),
                    "clutch_1v3_wins": overview.get("clutch_1v3_wins"),
                    "clutch_1v4_opportunities": overview.get("clutch_1v4_opportunities"),
                    "clutch_1v4_wins": overview.get("clutch_1v4_wins"),
                    "clutch_1v5_opportunities": overview.get("clutch_1v5_opportunities"),
                    "clutch_1v5_wins": overview.get("clutch_1v5_wins"),
                    "survival_rounds": overview.get("survival_rounds"),
                    "rounds_with_kill": normalized_rounds.get("rounds_with_kill"),
                    "rounds_with_assist": normalized_rounds.get("rounds_with_assist"),
                    "rounds_with_death": normalized_rounds.get("rounds_with_death"),
                    "rounds_with_direct_participation": normalized_rounds.get(
                        "rounds_with_direct_participation"
                    ),
                    "rounds_without_direct_participation": normalized_rounds.get(
                        "rounds_without_direct_participation"
                    ),
                    "rounds_with_kill_pct": normalized_rounds.get("rounds_with_kill_pct"),
                    "rounds_with_assist_pct": normalized_rounds.get(
                        "rounds_with_assist_pct"
                    ),
                    "rounds_with_death_pct": normalized_rounds.get("rounds_with_death_pct"),
                    "rounds_with_direct_participation_pct": normalized_rounds.get(
                        "rounds_with_direct_participation_pct"
                    ),
                    "rounds_without_direct_participation_pct": normalized_rounds.get(
                        "rounds_without_direct_participation_pct"
                    ),
                    "rounds_only_kill": normalized_rounds.get("rounds_only_kill"),
                    "rounds_only_assist": normalized_rounds.get("rounds_only_assist"),
                    "rounds_only_death": normalized_rounds.get("rounds_only_death"),
                    "rounds_kill_assist": normalized_rounds.get("rounds_kill_assist"),
                    "rounds_kill_death": normalized_rounds.get("rounds_kill_death"),
                    "rounds_assist_death": normalized_rounds.get("rounds_assist_death"),
                    "rounds_kill_assist_death": normalized_rounds.get(
                        "rounds_kill_assist_death"
                    ),
                    "rounds_none": normalized_rounds.get("rounds_none"),
                    "rounds_combined_or_none": normalized_rounds.get(
                        "rounds_combined_or_none"
                    ),
                    "rounds_only_kill_pct": normalized_rounds.get("rounds_only_kill_pct"),
                    "rounds_only_assist_pct": normalized_rounds.get(
                        "rounds_only_assist_pct"
                    ),
                    "rounds_only_death_pct": normalized_rounds.get("rounds_only_death_pct"),
                    "rounds_kill_assist_pct": normalized_rounds.get(
                        "rounds_kill_assist_pct"
                    ),
                    "rounds_kill_death_pct": normalized_rounds.get(
                        "rounds_kill_death_pct"
                    ),
                    "rounds_assist_death_pct": normalized_rounds.get(
                        "rounds_assist_death_pct"
                    ),
                    "rounds_kill_assist_death_pct": normalized_rounds.get(
                        "rounds_kill_assist_death_pct"
                    ),
                    "rounds_none_pct": normalized_rounds.get("rounds_none_pct"),
                    "rounds_combined_or_none_pct": normalized_rounds.get(
                        "rounds_combined_or_none_pct"
                    ),
                    "rounds_with_kast": overview.get("rounds_with_kast"),
                    "survival_rate": overview.get("survival_rate"),
                    "multikill_rate": overview.get("multikill_rate"),
                    "multi_2k": overview.get("multi_2k"),
                    "multi_3k": overview.get("multi_3k"),
                    "multi_4k": overview.get("multi_4k"),
                    "multi_5k": overview.get("multi_5k"),
                    "round_ceremonies": overview.get("round_ceremonies"),
                    "damage_delta": overview.get("damage_delta"),
                    "damage_delta_per_round": overview.get("damage_delta_per_round"),
                    "kd_ratio": overview.get("kd_ratio"),
                    "kast": overview.get("kast"),
                    "kast_pct": overview.get("kast_pct"),
                    "kill_assist_survive_trade_pct": overview.get(
                        "kill_assist_survive_trade_pct"
                    ),
                },
                "sides": _extract_sides_summary(doc),
                "player_totals_from_match": {
                    "kills": player_totals.get("kills"),
                    "deaths": player_totals.get("deaths"),
                    "assists": player_totals.get("assists"),
                    "score": player_totals.get("score"),
                    "rounds_played": player_totals.get("rounds_played"),
                },
            }
        )

    return light_docs


def _map_analytics_to_match_card(
    doc: dict[str, Any],
    agent_name_map: dict[str, str],
    duration_by_match_id: dict[str, int] | None = None,
    party_size_map: dict[str, int] | None = None,
) -> dict[str, Any]:
    totals = doc.get("player_totals_from_match") or {}
    overview = doc.get("overview") or {}

    kills = int(totals.get("kills") or overview.get("kills") or 0)
    deaths = int(totals.get("deaths") or overview.get("deaths") or 0)
    assists = int(totals.get("assists") or overview.get("assists") or 0)
    rounds = int(totals.get("rounds_played") or overview.get("rounds") or 0)
    match_id = str(doc.get("match_id") or "").strip()

    stored_duration_millis = int(totals.get("match_duration_millis") or 0)
    fallback_duration_millis = 0
    if duration_by_match_id and match_id:
        fallback_duration_millis = int(duration_by_match_id.get(match_id) or 0)

    # Prefer total match duration; keep legacy playtime as last fallback.
    playtime_millis = (
        stored_duration_millis
        or fallback_duration_millis
        or int(totals.get("playtime_millis") or 0)
    )
    score = int(totals.get("score") or overview.get("score") or 0)
    acs = float(overview.get("acs") or _safe_div(score, max(rounds, 1)))
    adr = float(overview.get("adr") or 0)

    rounds_won = int(overview.get("wins") or 0)
    rounds_lost = rounds - rounds_won
    round_score = f"{rounds_won}-{rounds_lost}" if rounds > 0 else "-"

    headshots = int(overview.get("headshots") or 0)
    bodyshots = int(overview.get("bodyshots") or 0)
    legshots = int(overview.get("legshots") or 0)

    hs = overview.get("headshot_pct")
    if hs is None:
        hs = _safe_div(
            headshots * 100.0,
            headshots + bodyshots + legshots,
        )

    timestamp = int(doc.get("game_start_millis") or 0)
    date_label = "Fecha desconocida"
    if timestamp > 0:
        date_label = datetime.fromtimestamp(
            timestamp / 1000, tz=timezone.utc
        ).strftime("%d/%m/%Y %H:%M UTC")

    agent_id = doc.get("agent_id")
    weapon_stats = _normalize_weapon_stats(overview.get("weapon_stats"))

    return {
        "id": _build_match_card_id(doc),
        "seasonId": doc.get("season_id") or "unknown",
        "dateLabel": date_label,
        "timestamp": timestamp,
        "map": doc.get("map_name") or "-",
        "agent": doc.get("agent_name")
        or agent_name_map.get(agent_id or "", "Agente desconocido"),
        "agentId": agent_id,
        "role": doc.get("role") or "-",
        "queue": doc.get("queue_id") or "-",
        "mode": doc.get("game_mode") or "-",
        "result": (
            "Victoria" if doc.get("won_match")
            else "Empate" if doc.get("is_draw")
            or (
                not doc.get("won_match")
                and overview.get("wins") is not None
                and overview.get("rounds") is not None
                and int(overview.get("wins") or 0) > 0
                and int(overview.get("wins") or 0) * 2 == int(overview.get("rounds") or 0)
            )
            else "Derrota"
        ),
        "ranked": bool(doc.get("is_ranked")),
        "roundScore": round_score,
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "rounds": rounds,
        "playtimeMillis": playtime_millis,
        "score": score,
        "acs": round(acs, 2),
        "adr": round(adr, 2),
        "hs": round(float(hs or 0), 2),
        "kd": round(_safe_div(kills, max(deaths, 1)), 3),
        "headshots": headshots,
        "bodyshots": bodyshots,
        "legshots": legshots,
        "weaponStats": [
            {
                "weaponId": item.get("weapon_id") or item.get("key") or "unknown",
                "weaponName": item.get("weapon_name") or "Arma desconocida",
                "rounds": int(float(item.get("rounds") or 0)),
                "kills": int(float(item.get("kills") or 0)),
                "deaths": int(float(item.get("deaths") or 0)),
                "assists": int(float(item.get("assists") or 0)),
                "kdRatio": float(item.get("kd_ratio") or 0),
            }
            for item in weapon_stats
        ],
        "competitiveTier": _coerce_positive_int(doc.get("competitive_tier") or doc.get("competitiveTier")),
        "competitiveTierImage": None,
        "accountLevel": _coerce_positive_int(doc.get("account_level")) or 0,
        "sides": _extract_sides_summary(doc),
        "partySize": (party_size_map or {}).get(match_id, 0),
    }


def _build_act_summary(matches: list[dict[str, Any]]) -> dict[str, float | int]:
    total_matches = len(matches)
    total_wins = sum(1 for m in matches if m.get("result") == "Victoria")
    total_kills = sum(int(m.get("kills") or 0) for m in matches)
    total_deaths = sum(int(m.get("deaths") or 0) for m in matches)
    total_assists = sum(int(m.get("assists") or 0) for m in matches)
    total_rounds = sum(int(m.get("rounds") or 0) for m in matches)
    total_score = sum(int(m.get("score") or 0) for m in matches)
    total_hs = sum(float(m.get("hs") or 0) for m in matches)

    return {
        "matches": total_matches,
        "wins": total_wins,
        "winRate": round(_safe_div(total_wins * 100.0, total_matches), 2),
        "kd": round(_safe_div(total_kills, max(total_deaths, 1)), 3),
        "kda": round(_safe_div(total_kills + total_assists, max(total_deaths, 1)), 3),
        "acs": round(_safe_div(total_score, max(total_rounds, 1)), 2),
        "killsPerMatch": round(_safe_div(total_kills, max(total_matches, 1)), 3),
        "hsAvg": round(_safe_div(total_hs, max(total_matches, 1)), 2),
    }


def _compute_rank_cohort_tiers(base_tier: int | None) -> list[int]:
    if base_tier is None or base_tier < 3:
        return []

    min_tier = 3
    max_tier = 27
    candidates = {
        max(min_tier, base_tier - 1),
        base_tier,
        min(max_tier, base_tier + 1),
    }
    return sorted(candidates)


def _append_rank_comparison_note(notes: list[str], message: str) -> None:
    text = str(message or "").strip()
    if text and text not in notes:
        notes.append(text)


def _build_empty_rank_comparison_payload(
    base_tier: int | None,
    *,
    reason: str | None = None,
) -> dict[str, Any]:
    cohort_tiers = _compute_rank_cohort_tiers(base_tier)
    notes: list[str] = []
    if reason:
        _append_rank_comparison_note(notes, reason)

    return {
        "baseTier": base_tier,
        "baseRankName": _format_tier_name(base_tier),
        "cohortTiers": cohort_tiers,
        "cohortLabels": [_format_tier_name(tier) for tier in cohort_tiers],
        "sampleSize": 0,
        "metricComparisons": {
            key: {
                "percentile": 50.0,
                "sampleSize": 0,
                "isNeutral": True,
                "value": None,
                "rawValue": None,
                "adjustedValue": None,
                "rankingValue": None,
                "rankingMethod": "bayesian_shrinkage",
                "metricSampleSize": 0,
                "metricSampleBasis": _resolve_rank_metric_sample_basis(key),
                "cohortMean": None,
                "priorWeight": _resolve_rank_metric_prior_weight(key),
            }
            for key, _prefer_lower in _RANK_COMPARISON_METRICS
        },
        "notes": notes,
    }


def _is_valid_rank_metric_value(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def _resolve_rank_metric_prior_weight(metric_key: str) -> float:
    configured = _RANK_METRIC_PRIOR_WEIGHT_BY_KEY.get(metric_key, _RANK_METRIC_DEFAULT_PRIOR_WEIGHT)
    if not isinstance(configured, (int, float)) or not math.isfinite(float(configured)):
        return _RANK_METRIC_DEFAULT_PRIOR_WEIGHT
    return max(float(configured), 0.0)


def _resolve_rank_metric_sample_basis(metric_key: str) -> str:
    return _RANK_METRIC_SAMPLE_BASIS_BY_KEY.get(metric_key, "matches")


def _compute_rank_metric_sample_size(metric_key: str, row: dict[str, Any]) -> float:
    match_count = float(max(int(row.get("matchCount") or 0), 0))
    rounds = float(max(int(row.get("rounds") or 0), 0))
    deaths = float(max(int(row.get("deaths") or 0), 0))
    total_shots = float(max(int(row.get("headshots") or 0), 0) + max(int(row.get("bodyshots") or 0), 0) + max(int(row.get("legshots") or 0), 0))
    round_based_kast_source_rounds = float(max(int(row.get("roundBasedKastSourceRounds") or 0), 0))
    raw_kast_count = float(max(int(row.get("rawKastFallbackCount") or 0), 0))
    basis = _resolve_rank_metric_sample_basis(metric_key)

    if basis == "impacts":
        return total_shots if total_shots > 0 else match_count
    if basis == "kast_rounds_or_fallback":
        if round_based_kast_source_rounds > 0:
            return round_based_kast_source_rounds
        if raw_kast_count > 0:
            return raw_kast_count
        return match_count
    if basis == "deaths":
        if deaths > 0:
            return deaths
        if rounds > 0:
            return rounds
        return match_count
    if basis == "rounds":
        return rounds if rounds > 0 else match_count
    return match_count


def _compute_bayesian_adjusted_value(
    *,
    raw_value: Any,
    sample_size: Any,
    cohort_mean: Any,
    prior_weight: Any,
) -> float | None:
    raw_numeric = float(raw_value) if _is_valid_rank_metric_value(raw_value) else None
    sample_numeric = float(sample_size) if _is_valid_rank_metric_value(sample_size) else 0.0
    cohort_mean_numeric = float(cohort_mean) if _is_valid_rank_metric_value(cohort_mean) else None
    prior_numeric = float(prior_weight) if _is_valid_rank_metric_value(prior_weight) else 0.0

    if raw_numeric is None:
        return None
    if cohort_mean_numeric is None:
        return raw_numeric
    if sample_numeric <= 0:
        return cohort_mean_numeric
    denominator = sample_numeric + max(prior_numeric, 0.0)
    if denominator <= 0:
        return raw_numeric
    return ((raw_numeric * sample_numeric) + (cohort_mean_numeric * max(prior_numeric, 0.0))) / denominator


def _rank_metric_values_close(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9)


def _build_rank_metric_values(row: dict[str, Any]) -> dict[str, float | None]:
    match_count = int(row.get("matchCount") or 0)
    if match_count <= 0:
        return {key: None for key, _prefer_lower in _RANK_COMPARISON_METRICS}

    wins = float(row.get("wins") or 0)
    kills = float(row.get("kills") or 0)
    deaths = float(row.get("deaths") or 0)
    assists = float(row.get("assists") or 0)
    rounds = float(row.get("rounds") or 0)
    score = float(row.get("score") or 0)
    headshots = float(row.get("headshots") or 0)
    bodyshots = float(row.get("bodyshots") or 0)
    legshots = float(row.get("legshots") or 0)
    round_based_kast_rounds = float(row.get("roundBasedKastRounds") or 0)
    round_based_kast_source_rounds = float(row.get("roundBasedKastSourceRounds") or 0)
    raw_kast_sum = float(row.get("rawKastFallbackSum") or 0)
    raw_kast_count = int(row.get("rawKastFallbackCount") or 0)
    damage_delta = float(row.get("damageDelta") or 0)

    total_shots = headshots + bodyshots + legshots

    kast: float | None = None
    if round_based_kast_source_rounds > 0:
        kast = _safe_div(round_based_kast_rounds * 100.0, round_based_kast_source_rounds)
    elif raw_kast_count > 0:
        kast = _safe_div(raw_kast_sum, raw_kast_count)

    if kast is not None:
        kast = max(0.0, min(100.0, kast))

    losses = max(float(match_count) - wins, 0.0)

    return {
        "kd": _safe_div(kills, max(deaths, 1.0)),
        "k": kills,
        "d": deaths,
        "a": assists,
        "kda": _safe_div(kills + assists, max(deaths, 1.0)),
        "acs": _safe_div(score, max(rounds, 1.0)) if rounds > 0 else None,
        "hsPct": _safe_div(headshots * 100.0, total_shots) if total_shots > 0 else None,
        "kast": kast,
        "incDamage": _safe_div(damage_delta, max(rounds, 1.0)) if rounds > 0 else None,
        "wr": _safe_div(wins * 100.0, max(match_count, 1.0)),
        "wins": wins,
        "losses": losses,
    }


def _build_rank_metric_ranking_value(
    metric_key: str,
    display_value: float | None,
    row: dict[str, Any],
) -> float | None:
    if metric_key not in _RANK_ROUND_RATE_METRIC_KEYS and metric_key not in _RANK_MATCH_RATE_METRIC_KEYS:
        return display_value
    if not _is_valid_rank_metric_value(display_value):
        return None
    if metric_key in _RANK_MATCH_RATE_METRIC_KEYS:
        matches = float(max(int(row.get("matchCount") or 0), 0))
        if matches <= 0:
            return None
        return _safe_div(float(display_value), matches)
    rounds = float(max(int(row.get("rounds") or 0), 0))
    if rounds <= 0:
        return None
    return _safe_div(float(display_value), rounds)


def _build_rank_metric_comparison_payload(
    player_raw_value: float | None,
    player_adjusted_value: float | None,
    cohort_adjusted_values: list[float | None],
    metric_sample_size: float,
    metric_sample_basis: str,
    cohort_mean: float | None,
    prior_weight: float,
    *,
    prefer_lower: bool,
) -> dict[str, Any]:
    valid_values = [
        float(value)
        for value in cohort_adjusted_values
        if _is_valid_rank_metric_value(value)
    ]
    sample_size = len(valid_values)

    if not _is_valid_rank_metric_value(player_adjusted_value) or sample_size == 0:
        return {
            "percentile": 50.0,
            "sampleSize": sample_size,
            "isNeutral": True,
            "value": player_raw_value,
            "rawValue": player_raw_value,
            "adjustedValue": player_adjusted_value,
            "rankingValue": player_adjusted_value,
            "rankingMethod": "bayesian_shrinkage",
            "metricSampleSize": round(metric_sample_size, 3),
            "metricSampleBasis": metric_sample_basis,
            "cohortMean": cohort_mean,
            "priorWeight": round(prior_weight, 3),
        }

    player_metric_value = float(player_adjusted_value)
    if sample_size == 1:
        return {
            "percentile": 50.0,
            "sampleSize": sample_size,
            "isNeutral": True,
            "value": player_raw_value,
            "rawValue": player_raw_value,
            "adjustedValue": player_adjusted_value,
            "rankingValue": player_adjusted_value,
            "rankingMethod": "bayesian_shrinkage",
            "metricSampleSize": round(metric_sample_size, 3),
            "metricSampleBasis": metric_sample_basis,
            "cohortMean": cohort_mean,
            "priorWeight": round(prior_weight, 3),
        }

    worse_count = 0
    equal_count = 0
    for value in valid_values:
        if _rank_metric_values_close(value, player_metric_value):
            equal_count += 1
            continue

        if prefer_lower:
            if value > player_metric_value:
                worse_count += 1
        elif value < player_metric_value:
            worse_count += 1

    percentile = _safe_div(
        worse_count + 0.5 * max(equal_count - 1, 0),
        max(sample_size - 1, 1),
    ) * 100.0

    return {
        "percentile": round(max(0.0, min(100.0, percentile)), 3),
        "sampleSize": sample_size,
        "isNeutral": False,
        "value": player_raw_value,
        "rawValue": player_raw_value,
        "adjustedValue": player_adjusted_value,
        "rankingValue": player_adjusted_value,
        "rankingMethod": "bayesian_shrinkage",
        "metricSampleSize": round(metric_sample_size, 3),
        "metricSampleBasis": metric_sample_basis,
        "cohortMean": cohort_mean,
        "priorWeight": round(prior_weight, 3),
    }


def _build_rank_comparison_payload_from_players(
    puuid: str,
    base_tier: int,
    cohort_rows: list[dict[str, Any]],
    *,
    extra_fields: dict[str, Any] | None = None,
    extra_notes: list[str] | None = None,
) -> dict[str, Any]:
    if not cohort_rows:
        payload = _build_empty_rank_comparison_payload(
            base_tier,
            reason="No hay jugadores elegibles en la cohorte para los filtros actuales.",
        )
        if extra_fields:
            payload.update(extra_fields)
        if extra_notes:
            for note in extra_notes:
                _append_rank_comparison_note(payload["notes"], note)
        return payload

    cohort_tiers = _compute_rank_cohort_tiers(base_tier)
    metric_rows = [
        {
            "puuid": str(row.get("puuid") or ""),
            "metrics": _build_rank_metric_values(row),
        }
        for row in cohort_rows
    ]

    player_row = next((row for row in metric_rows if row["puuid"] == puuid), None)
    if player_row is None:
        payload = _build_empty_rank_comparison_payload(
            base_tier,
            reason="El jugador no tiene datos validos dentro de la cohorte filtrada.",
        )
        if extra_fields:
            payload.update(extra_fields)
        if extra_notes:
            for note in extra_notes:
                _append_rank_comparison_note(payload["notes"], note)
        return payload

    metric_comparisons: dict[str, Any] = {}
    for key, prefer_lower in _RANK_COMPARISON_METRICS:
        player_value = player_row["metrics"].get(key)
        prior_weight = _resolve_rank_metric_prior_weight(key)
        sample_basis = _resolve_rank_metric_sample_basis(key)
        cohort_ranking_values = [
            _build_rank_metric_ranking_value(key, row["metrics"].get(key), cohort_rows[idx])
            for idx, row in enumerate(metric_rows)
        ]
        valid_cohort_raw_values = [float(v) for v in cohort_ranking_values if _is_valid_rank_metric_value(v)]
        cohort_mean = (
            _safe_div(sum(valid_cohort_raw_values), len(valid_cohort_raw_values))
            if valid_cohort_raw_values
            else None
        )
        player_source_row = next((r for r in cohort_rows if str(r.get("puuid") or "") == puuid), {})
        player_ranking_value = _build_rank_metric_ranking_value(key, player_value, player_source_row)
        player_sample_size = _compute_rank_metric_sample_size(key, player_source_row)
        player_adjusted_value = _compute_bayesian_adjusted_value(
            raw_value=player_ranking_value,
            sample_size=player_sample_size,
            cohort_mean=cohort_mean,
            prior_weight=prior_weight,
        )
        cohort_adjusted_values = [
            _compute_bayesian_adjusted_value(
                raw_value=cohort_ranking_values[idx],
                sample_size=_compute_rank_metric_sample_size(key, cohort_rows[idx]),
                cohort_mean=cohort_mean,
                prior_weight=prior_weight,
            )
            for idx, row in enumerate(metric_rows)
        ]
        metric_comparisons[key] = _build_rank_metric_comparison_payload(
            player_value,
            player_adjusted_value,
            cohort_adjusted_values,
            player_sample_size,
            sample_basis,
            cohort_mean,
            prior_weight,
            prefer_lower=prefer_lower,
        )

    sample_size = len(metric_rows)
    notes: list[str] = []
    if sample_size < 2:
        _append_rank_comparison_note(
            notes,
            "La cohorte tiene menos de 2 jugadores validos; los porcentajes se muestran en 50% neutral hasta tener comparacion real.",
        )
    if any(
        int(metric.get("sampleSize") or 0) < sample_size
        for metric in metric_comparisons.values()
    ):
        _append_rank_comparison_note(
            notes,
            "Algunas metricas usan menos jugadores validos porque faltan datos especificos en esa metrica.",
        )

    return {
        "baseTier": base_tier,
        "baseRankName": _format_tier_name(base_tier),
        **(extra_fields or {}),
        "cohortTiers": cohort_tiers,
        "cohortLabels": [_format_tier_name(tier) for tier in cohort_tiers],
        "sampleSize": sample_size,
        "metricComparisons": metric_comparisons,
        "notes": [*notes, *(extra_notes or [])],
    }


def resolve_cohort_reference_tier(
    puuid: str,
    *,
    queue_id: str | None = None,
    agent_id: str | None = None,
    map_name: str | None = None,
    season_id: str | None = None,
    party_size: str | None = None,
) -> dict[str, Any]:
    if not puuid:
        return {
            "tier": None,
            "source": "none",
            "seasonId": None,
            "timestamp": None,
            "note": None,
        }

    filtered_ranked = dashboard_queries.find_player_latest_valid_rank(
        puuid,
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        season_id=season_id,
        party_size=party_size,
    )
    tier = _coerce_rank_tier(filtered_ranked.get("latestTier"))
    if tier is not None:
        return {
            "tier": tier,
            "source": "filtered_ranked",
            "seasonId": filtered_ranked.get("seasonId"),
            "timestamp": filtered_ranked.get("timestamp"),
            "note": None,
        }

    first_filtered_timestamp = None
    if season_id:
        first_filtered_timestamp = dashboard_queries.find_player_first_match_timestamp(
            puuid,
            season_id=season_id,
            queue_id=queue_id,
        )
        previous_ranked = dashboard_queries.find_player_latest_valid_rank(
            puuid,
            queue_id=queue_id,
            agent_id=agent_id,
            map_name=map_name,
            party_size=party_size,
            before_timestamp=first_filtered_timestamp,
            exclude_season_id=season_id,
        )
        tier = _coerce_rank_tier(previous_ranked.get("latestTier"))
        if tier is not None:
            return {
                "tier": tier,
                "source": "previous_valid_rank",
                "seasonId": previous_ranked.get("seasonId"),
                "timestamp": previous_ranked.get("timestamp"),
                "note": "El jugador esta sin rango en la temporada filtrada; la cohorte usa su ultimo rango valido anterior.",
            }

    global_ranked = dashboard_queries.find_player_latest_valid_rank(puuid)
    tier = _coerce_rank_tier(global_ranked.get("latestTier"))
    if tier is not None:
        return {
            "tier": tier,
            "source": "global_valid_rank",
            "seasonId": global_ranked.get("seasonId"),
            "timestamp": global_ranked.get("timestamp"),
            "note": "No hay rango valido dentro de los filtros; la cohorte usa el ultimo rango valido global.",
        }

    return {
        "tier": None,
        "source": "none",
        "seasonId": None,
        "timestamp": first_filtered_timestamp,
        "note": None,
    }


def aggregate_rank_cohort_players_by_reference_tier(
    cohort_tiers: list[int],
    *,
    queue_id: str | None = None,
    agent_id: str | None = None,
    map_name: str | None = None,
    season_id: str | None = None,
    party_size: str | None = None,
    reference_before_timestamp: int | None = None,
    reference_exclude_season_id: str | None = None,
) -> list[dict[str, Any]]:
    clean_tiers = {
        int(tier)
        for tier in cohort_tiers
        if isinstance(tier, (int, float)) and int(tier) >= 3
    }
    if not clean_tiers:
        return []

    metric_rows = dashboard_queries.aggregate_rank_cohort_metric_players(
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        season_id=season_id,
        party_size=party_size,
    )
    reference_by_puuid = dashboard_queries.find_latest_valid_ranks_for_players(
        [str(row.get("puuid") or "") for row in metric_rows],
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        party_size=party_size,
        before_timestamp=reference_before_timestamp,
        exclude_season_id=reference_exclude_season_id,
    )
    cohort_rows: list[dict[str, Any]] = []
    for row in metric_rows:
        row_puuid = str(row.get("puuid") or "")
        ranked_ref = reference_by_puuid.get(row_puuid) or {}
        reference_tier = _coerce_rank_tier(ranked_ref.get("latestTier"))
        if reference_tier is None and not reference_before_timestamp:
            reference_tier = _coerce_rank_tier(row.get("latestTier"))
        if reference_tier not in clean_tiers:
            continue
        cohort_rows.append(
            {
                **row,
                "referenceTier": reference_tier,
                "latestTier": reference_tier,
                "referenceTimestamp": ranked_ref.get("timestamp"),
                "referenceSeasonId": ranked_ref.get("seasonId"),
            }
        )
    return cohort_rows


def _compute_player_rank_comparison(
    puuid: str,
    *,
    queue_id: str | None = None,
    agent_id: str | None = None,
    map_name: str | None = None,
    season_id: str | None = None,
    party_size: str | None = None,
) -> dict[str, Any]:
    if not puuid:
        return _build_empty_rank_comparison_payload(
            None,
            reason="No se pudo resolver el jugador para construir la cohorte.",
        )

    latest_reference = dashboard_queries.find_player_latest_rank_reference(
        puuid,
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        season_id=season_id,
        party_size=party_size,
    )
    if not latest_reference:
        return _build_empty_rank_comparison_payload(
            None,
            reason="El jugador no tiene partidas dentro de los filtros actuales.",
        )

    cohort_reference = resolve_cohort_reference_tier(
        puuid,
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        season_id=season_id,
        party_size=party_size,
    )
    base_tier = _coerce_rank_tier(cohort_reference.get("tier"))
    if base_tier is None:
        return _build_empty_rank_comparison_payload(
            None,
            reason="No se pudo resolver ningun rango valido para construir la cohorte.",
        )

    cohort_tiers = _compute_rank_cohort_tiers(base_tier)
    source = str(cohort_reference.get("source") or "none")
    extra_notes = [cohort_reference["note"]] if cohort_reference.get("note") else []
    visual_tier = _coerce_rank_tier(latest_reference.get("latestTier"))
    extra_fields = {
        "baseTierSource": source,
        "baseTierSeasonId": cohort_reference.get("seasonId"),
        "visualRankName": _format_tier_name(visual_tier),
        "cohortReferenceTier": base_tier,
        "cohortReferenceRankName": _format_tier_name(base_tier),
    }

    if source in {"previous_valid_rank", "global_valid_rank"}:
        reference_before_timestamp = (
            int(cohort_reference.get("timestamp") or 0) + 1
            if source == "previous_valid_rank" and cohort_reference.get("timestamp") is not None
            else None
        )
        first_season_timestamp = (
            dashboard_queries.find_player_first_match_timestamp(
                puuid,
                season_id=season_id,
                queue_id=queue_id,
            )
            if season_id
            else None
        )
        if first_season_timestamp is not None:
            reference_before_timestamp = first_season_timestamp
        cohort_rows = aggregate_rank_cohort_players_by_reference_tier(
            cohort_tiers,
            queue_id=queue_id,
            agent_id=agent_id,
            map_name=map_name,
            season_id=season_id,
            party_size=party_size,
            reference_before_timestamp=reference_before_timestamp,
            reference_exclude_season_id=season_id,
        )
    else:
        cohort_rows = dashboard_queries.aggregate_rank_cohort_players(
            cohort_tiers,
            queue_id=queue_id,
            agent_id=agent_id,
            map_name=map_name,
            season_id=season_id,
            party_size=party_size,
        )

    return _build_rank_comparison_payload_from_players(
        puuid,
        base_tier,
        cohort_rows,
        extra_fields=extra_fields,
        extra_notes=extra_notes,
    )


def get_player_rank_comparison(
    puuid: str,
    *,
    queue_id: str | None = None,
    agent_id: str | None = None,
    map_name: str | None = None,
    season_id: str | None = None,
    party_size: str | None = None,
) -> dict[str, Any]:
    cache_key = "|".join(
        str(value or "")
        for value in (
            puuid,
            queue_id,
            agent_id,
            map_name,
            season_id,
            party_size,
        )
    )
    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _RANK_COMPARISON_CACHE.get(cache_key)
        if cached and (now - cached[0]) <= _RANK_COMPARISON_CACHE_TTL_SECONDS:
            return cached[1]

    payload = _compute_player_rank_comparison(
        puuid,
        queue_id=queue_id,
        agent_id=agent_id,
        map_name=map_name,
        season_id=season_id,
        party_size=party_size,
    )
    with _CACHE_LOCK:
        if len(_RANK_COMPARISON_CACHE) > 1000:
            _RANK_COMPARISON_CACHE.clear()
        _RANK_COMPARISON_CACHE[cache_key] = (now, payload)
    return payload


def build_player_dashboard(
    player: dict[str, Any],
    player_docs: list[dict[str, Any]],
    total_matches_in_db: int = 0,
) -> dict[str, Any]:
    content_doc = _get_dashboard_content()

    agent_name_map, agent_media_map = _build_agent_maps(content_doc)
    map_icon_by_name = _build_map_icon_map(content_doc)
    weapon_icon_by_name = _build_weapon_icon_map(content_doc)
    act_label_map = _build_act_label_map(content_doc)
    current_act_id_from_content = _resolve_current_act_id(content_doc)
    rank_icon_map, rank_icon_by_name_map = _build_competitive_tier_maps(content_doc)

    analytics_sorted = sorted(
        player_docs,
        key=lambda item: int(item.get("game_start_millis") or 0),
        reverse=True,
    )

    match_ids = [str(doc.get("match_id") or "").strip() for doc in analytics_sorted]
    duration_by_match_id = _load_match_duration_map(match_ids)
    party_size_map = _load_party_size_map(match_ids, str(player.get("puuid") or ""))

    mapped_matches = [
        _map_analytics_to_match_card(doc, agent_name_map, duration_by_match_id, party_size_map)
        for doc in analytics_sorted
    ]

    matches_by_act: dict[str, list[dict[str, Any]]] = {}
    latest_timestamp_by_act: dict[str, int] = {}
    for match in mapped_matches:
        act_id = match.get("seasonId") or "unknown"
        matches_by_act.setdefault(act_id, []).append(match)
        latest_timestamp_by_act[act_id] = max(
            latest_timestamp_by_act.get(act_id, 0),
            int(match.get("timestamp") or 0),
        )

    act_sections: dict[str, dict[str, Any]] = {}
    for act_id, section_matches in matches_by_act.items():
        sorted_section = sorted(
            section_matches,
            key=lambda m: int(m.get("timestamp") or 0),
            reverse=True,
        )
        act_sections[act_id] = {
            "summary": _build_act_summary(sorted_section),
            "matches": sorted_section,
        }

    act_options = [
        {
            "id": act_id,
            "label": act_label_map.get(act_id, act_id),
            "latestTimestamp": latest_timestamp_by_act.get(act_id, 0),
        }
        for act_id in matches_by_act.keys()
    ]
    act_options.sort(
        key=lambda option: (
            -int(option.get("latestTimestamp") or 0),
            str(option["label"]).lower(),
        )
    )

    act_options_public = [
        {"id": option["id"], "label": option["label"]} for option in act_options
    ]

    latest_player_act_id = act_options_public[0]["id"] if act_options_public else None
    current_act_id = current_act_id_from_content or latest_player_act_id
    if latest_player_act_id and current_act_id:
        latest_player_ts = int(latest_timestamp_by_act.get(latest_player_act_id) or 0)
        current_content_ts = int(latest_timestamp_by_act.get(current_act_id) or 0)
        if latest_player_ts > current_content_ts:
            current_act_id = latest_player_act_id

    current_act_matches = (
        act_sections.get(current_act_id, {}).get("matches", []) if current_act_id else []
    )

    current_act_docs = (
        [
            doc
            for doc in analytics_sorted
            if (doc.get("season_id") or "unknown") == current_act_id
        ]
        if current_act_id
        else []
    )

    # Use all matches as fallback only for global overview computations
    overview_matches = current_act_matches if current_act_matches else mapped_matches
    overview_docs = current_act_docs if current_act_docs else analytics_sorted

    total_matches = len(overview_matches)
    total_wins = sum(1 for match in overview_matches if match.get("result") == "Victoria")
    total_kills = sum(int(match.get("kills") or 0) for match in overview_matches)
    total_deaths = sum(int(match.get("deaths") or 0) for match in overview_matches)
    total_assists = sum(int(match.get("assists") or 0) for match in overview_matches)
    total_score = sum(int(match.get("score") or 0) for match in overview_matches)
    total_rounds = sum(int(match.get("rounds") or 0) for match in overview_matches)
    total_headshots = sum(int(match.get("headshots") or 0) for match in overview_matches)
    total_bodyshots = sum(int(match.get("bodyshots") or 0) for match in overview_matches)
    total_legshots = sum(int(match.get("legshots") or 0) for match in overview_matches)

    global_win_rate = _safe_div(total_wins * 100.0, max(total_matches, 1))
    global_kd = _safe_div(total_kills, max(total_deaths, 1))
    global_acs = _safe_div(total_score, max(total_rounds, 1))
    global_hs_pct = _safe_div(
        total_headshots * 100.0,
        total_headshots + total_bodyshots + total_legshots,
    )

    if global_hs_pct >= 25:
        primary_insight = "Precision alta"
    elif global_kd >= 1.1:
        primary_insight = "Buen impacto ofensivo"
    elif global_win_rate >= 50:
        primary_insight = "Rendimiento competitivo"
    else:
        primary_insight = "Progresion constante"

    agent_buckets: dict[str, dict[str, Any]] = {}
    for match in overview_matches:
        agent_id = str(match.get("agentId") or "unknown")
        bucket = agent_buckets.setdefault(
            agent_id,
            {
                "id": agent_id,
                "name": match.get("agent")
                or agent_name_map.get(agent_id, "Agente desconocido"),
                "matches": 0,
            },
        )
        bucket["matches"] = int(bucket["matches"]) + 1

    most_played_agents = sorted(
        agent_buckets.values(),
        key=lambda item: int(item.get("matches") or 0),
        reverse=True,
    )[:5]

    for agent in most_played_agents:
        agent_id = str(agent.get("id") or "")
        agent["image"] = (agent_media_map.get(agent_id) or {}).get("image")

    best_map: dict[str, Any] | None = None
    map_buckets: dict[str, dict[str, int]] = {}
    for match in overview_matches:
        map_name = str(match.get("map") or "").strip()
        if not map_name or map_name == "-":
            continue
        bucket = map_buckets.setdefault(map_name, {"matches": 0, "wins": 0})
        bucket["matches"] += 1
        if match.get("result") == "Victoria":
            bucket["wins"] += 1

    for map_name, bucket in map_buckets.items():
        win_rate = _safe_div(bucket["wins"] * 100.0, max(bucket["matches"], 1))
        candidate = {
            "map": map_name,
            "matches": bucket["matches"],
            "wins": bucket["wins"],
            "winRate": round(win_rate, 2),
        }
        if not best_map:
            best_map = candidate
            continue
        if candidate["winRate"] > best_map["winRate"] or (
            candidate["winRate"] == best_map["winRate"]
            and candidate["matches"] > best_map["matches"]
        ):
            best_map = candidate

    # Keep weapon insights fast by aggregating weapon_stats server-side.
    weapon_summary_rows = _load_weapon_usage_summary(
        puuid=str(player.get("puuid") or ""),
        season_id=current_act_id if current_act_matches else None,
    )

    usage_sorted_weapon_rows = sorted(
        weapon_summary_rows,
        key=lambda row: (
            -int(row.get("rounds") or 0),
            -int(row.get("kills") or 0),
            -int(row.get("matches") or 0),
        ),
    )

    most_played_weapons: list[dict[str, Any]] = []
    for row in usage_sorted_weapon_rows:
        name = str(row.get("name") or "Arma desconocida")
        source_type = str(row.get("type") or "weapon")
        source_icon = row.get("icon")
        most_played_weapons.append(
            {
                "id": str(row.get("_id") or "unknown"),
                "name": name,
                "type": source_type,
                "isAbility": bool(row.get("isAbility")),
                "rounds": int(row.get("rounds") or 0),
                "kills": int(row.get("kills") or 0),
                "matches": int(row.get("matches") or 0),
                "image": source_icon or weapon_icon_by_name.get(_normalize_rank_label(name)),
            }
        )

    best_weapon: dict[str, Any] | None = None
    if weapon_summary_rows:
        top = max(
            weapon_summary_rows,
            key=lambda row: (
                int(row.get("kills") or 0),
                int(row.get("rounds") or 0),
                int(row.get("matches") or 0),
            ),
        )
        best_weapon = {
            "name": str(top.get("name") or "Arma desconocida"),
            "matches": int(top.get("matches") or 0),
            "wins": int(top.get("wins") or 0),
            "kills": int(top.get("kills") or 0),
            "winRate": round(
                _safe_div(
                    int(top.get("wins") or 0) * 100.0,
                    max(int(top.get("matches") or 0), 1),
                ),
                2,
            ),
        }

    latest_analytics = overview_docs[0] if overview_docs else (analytics_sorted[0] if analytics_sorted else {})
    visual_rank = resolve_current_visual_rank(
        current_act_docs=current_act_docs,
        mapped_matches=mapped_matches,
        player=player,
        rank_icon_map=rank_icon_map,
        rank_icon_by_name_map=rank_icon_by_name_map,
    )
    tier = visual_rank.get("tier")
    rank_name = str(visual_rank.get("name") or _format_tier_name(tier))
    rank_image = visual_rank.get("image")
    rank_small_icon = visual_rank.get("smallIcon")
    rank_comparison = get_player_rank_comparison(
        str(player.get("puuid") or ""),
        season_id=current_act_id if current_act_matches else None,
    )

    top_agent = most_played_agents[0] if most_played_agents else None
    best_map_name = (best_map or {}).get("map")
    best_weapon_name = (best_weapon or {}).get("name")
    best_map_image = map_icon_by_name.get(_normalize_rank_label(best_map_name))
    best_weapon_image = weapon_icon_by_name.get(_normalize_rank_label(best_weapon_name))
    header_showcase = [
        {
            "title": (top_agent or {}).get("name") or "Agente",
            "subtitle": "Agente mas jugado",
            "image": (top_agent or {}).get("image"),
        },
        {
            "title": best_map_name or "Mapa destacado",
            "subtitle": "Mapa con mejor winrate",
            "image": best_map_image,
        },
        {
            "title": best_weapon_name or "Arma destacada",
            "subtitle": "Arma con mas kills",
            "image": best_weapon_image,
        },
    ]

    overview_metrics = {
        "globalWinRate": round(global_win_rate, 2),
        "globalKd": round(global_kd, 3),
        "globalAcs": round(global_acs, 2),
        "globalHeadshotPct": round(global_hs_pct, 2),
        "kdaOverall": round(
            _safe_div(total_kills + total_assists, max(total_deaths, 1)), 3
        ),
        "avgDeathsPerMatch": round(_safe_div(total_deaths, max(total_matches, 1)), 3),
        "avgAssistsPerMatch": round(_safe_div(total_assists, max(total_matches, 1)), 3),
        "avgRoundsPerMatch": round(_safe_div(total_rounds, max(total_matches, 1)), 3),
        "killsPerRound": round(_safe_div(total_kills, max(total_rounds, 1)), 3),
        "killsPerMatch": round(_safe_div(total_kills, max(total_matches, 1)), 3),
    }

    total_shots = total_headshots + total_bodyshots + total_legshots
    shot_chart = [
        {
            "name": "Headshots",
            "value": total_headshots,
            "percentage": round(_safe_div(total_headshots * 100.0, total_shots), 2),
            "color": "#ff4655",
        },
        {
            "name": "Bodyshots",
            "value": total_bodyshots,
            "percentage": round(_safe_div(total_bodyshots * 100.0, total_shots), 2),
            "color": "#ff7a85",
        },
        {
            "name": "Legshots",
            "value": total_legshots,
            "percentage": round(_safe_div(total_legshots * 100.0, total_shots), 2),
            "color": "#7f2c33",
        },
    ]
    shot_chart = [item for item in shot_chart if item["value"] > 0]

    performance_metrics = [
        {
            "label": "KD",
            "value": round(global_kd, 2),
            "percent": min(global_kd * 50.0, 100.0),
            "helper": "1.00 es equilibrio",
        },
        {
            "label": "Win Rate",
            "value": round(global_win_rate, 2),
            "percent": min(global_win_rate, 100.0),
            "helper": "porcentaje de victorias",
        },
        {
            "label": "Headshot %",
            "value": round(global_hs_pct, 2),
            "percent": min(global_hs_pct, 100.0),
            "helper": "precision a la cabeza",
        },
        {
            "label": "ACS",
            "value": round(global_acs, 2),
            "percent": min(_safe_div(global_acs, 300.0) * 100.0, 100.0),
            "helper": "impacto medio por ronda",
        },
        {
            "label": "Kills / partida",
            "value": round(_safe_div(total_kills, max(total_matches, 1)), 2),
            "percent": min(
                _safe_div(total_kills, max(total_matches, 1)) * 4.0,
                100.0,
            ),
            "helper": "media global",
        },
        {
            "label": "KDA",
            "value": round(
                _safe_div(total_kills + total_assists, max(total_deaths, 1)), 2
            ),
            "percent": min(
                _safe_div(total_kills + total_assists, max(total_deaths, 1)) * 33.33,
                100.0,
            ),
            "helper": "kills + assists / deaths",
        },
    ]

    # Override player name with data from the latest match
    latest_name_doc = analytics_sorted[0] if analytics_sorted else {}
    latest_game_name = latest_name_doc.get("game_name")
    latest_tag_line = latest_name_doc.get("tag_line")
    player_out = dict(player)
    if latest_game_name:
        player_out["gameName"] = latest_game_name
    if latest_tag_line:
        player_out["tagLine"] = latest_tag_line

    round_stats_summary = _compute_rounds_panel_summary(overview_docs)

    return {
        "player": player_out,
        "totalMatchesInDb": total_matches_in_db,
        "agentNameMap": agent_name_map,
        "agentMediaMap": agent_media_map,
        "mapMediaMap": map_icon_by_name,
        "analyticsList": _build_light_analytics_list(analytics_sorted),
        "roundStats": round_stats_summary,
        "currentActId": current_act_id,
        "currentRank": {
            "tier": tier,
            "name": rank_name,
            "image": rank_image,
            "smallIcon": rank_small_icon,
            "source": visual_rank.get("source"),
            "rankSource": visual_rank.get("source"),
            "isUnranked": bool(visual_rank.get("isUnranked")),
        },
        "rankComparison": rank_comparison,
        "headerShowcase": header_showcase,
        "mostPlayedAgents": most_played_agents,
        "mostPlayedWeapons": most_played_weapons,
        "metrics": overview_metrics,
        "shotChart": shot_chart,
        "performanceMetrics": performance_metrics,
        "insights": {
            "primary": primary_insight,
            "mostPlayedAgent": top_agent,
            "bestMap": best_map,
            "bestWeapon": best_weapon,
        },
        "actOptions": act_options_public,
        "actSections": act_sections,
    }


def _extract_flat_analytics_docs(puuid: str, matches_cursor) -> list[dict[str, Any]]:
    """
    Convert embedded analytics from match documents into the flat analytics doc format
    that build_player_dashboard() expects.
    """
    docs: list[dict[str, Any]] = []
    for match_obj in matches_cursor:
        match_info = match_obj.get("matchInfo") or {}
        for player in match_obj.get("players", []) or []:
            if player.get("puuid") != puuid:
                continue
            analytics = player.get("analytics")
            if not analytics:
                continue
            player_stats = player.get("stats") or {}
            overview = dict(analytics.get("overview") or {})
            # Modern ingested matches already contain the complete analytics.
            # Rebuilding every round and weapon on every GET made large
            # profiles scale linearly to tens of seconds. Keep compatibility
            # with old documents by calculating only when those aggregates are
            # absent.
            has_round_analytics = (
                overview.get("rounds") is not None
                and overview.get("rounds_with_kill") is not None
                and overview.get("rounds_with_direct_participation") is not None
            )
            if not has_round_analytics:
                round_overview = _compute_round_overview_from_round_results(
                    match_obj,
                    puuid,
                )
                if round_overview:
                    overview.update(round_overview)
            if not overview.get("weapon_stats"):
                overview["weapon_stats"] = merge_precise_weapon_core_stats(
                    overview.get("weapon_stats"),
                    compute_precise_weapon_stats_core(
                        match_obj.get("roundResults") or [],
                        puuid,
                        build_team_lookup(match_obj.get("players") or []),
                    ),
                )
            player_team_id = str(player.get("teamId") or "").lower()
            team_agents: list[dict[str, Any]] = []
            if player_team_id:
                for teammate in match_obj.get("players", []) or []:
                    if str(teammate.get("teamId") or "").lower() != player_team_id:
                        continue
                    character_id = str(teammate.get("characterId") or "").strip()
                    if not character_id:
                        continue
                    team_agents.append({
                        "agent_id": character_id,
                        "agent_name": teammate.get("characterName") or teammate.get("agentName"),
                    })

            docs.append({
                "match_id": str(match_info.get("matchId") or ""),
                "puuid": puuid,
                "game_name": player.get("gameName"),
                "tag_line": player.get("tagLine"),
                "team_id": player.get("teamId"),
                "won_match": analytics.get("won_match"),
                "is_draw": analytics.get("is_draw"),
                "is_ranked": match_info.get("isRanked", True),
                "queue_id": match_info.get("queueId"),
                "game_mode": match_info.get("gameMode"),
                "region": match_info.get("region"),
                "game_start_millis": match_info.get("gameStartMillis"),
                "season_id": str(match_info.get("seasonId") or "UNKNOWN"),
                "map_id": str(match_info.get("mapId") or "UNKNOWN"),
                "map_name": analytics.get("map_name"),
                "agent_id": str(player.get("characterId") or "UNKNOWN"),
                "agent_name": analytics.get("agent_name"),
                "team_agents": team_agents,
                "role": analytics.get("role"),
                "competitive_tier": player.get("competitiveTier"),
                "account_level": player.get("accountLevel"),
                "player_totals_from_match": {
                    "kills": int(overview.get("kills", 0) or 0),
                    "deaths": int(overview.get("deaths", 0) or 0),
                    "assists": int(overview.get("assists", 0) or 0),
                    "score": int(overview.get("score", player_stats.get("score", 0)) or 0),
                    "rounds_played": int(
                        overview.get("rounds", player_stats.get("roundsPlayed", 0))
                        or 0
                    ),
                    "match_duration_millis": int(match_info.get("gameLengthMillis", 0) or 0),
                    "playtime_millis": int(player_stats.get("playtimeMillis", 0) or 0),
                },
                "overview": overview,
                "sides": analytics.get("sides"),
            })
            break  # Only one entry per match for this puuid
    return docs


def get_player_dashboard(
    puuid: str,
    player: dict[str, Any],
) -> dict[str, Any]:
    total_matches_in_db = dashboard_queries.count_player_matches(puuid)

    cache_key = f"{puuid}:{total_matches_in_db}"
    now = time.monotonic()

    with _CACHE_LOCK:
        cached = _DASHBOARD_RESPONSE_CACHE.get(cache_key)
        if cached and (now - cached[0]) <= _DASHBOARD_RESPONSE_CACHE_TTL_SECONDS:
            return cached[1]

    matches_cursor = dashboard_queries.find_ranked_matches_cursor(puuid)

    player_docs = _extract_flat_analytics_docs(puuid, matches_cursor)

    dashboard = build_player_dashboard(
        player=player,
        player_docs=player_docs,
        total_matches_in_db=total_matches_in_db,
    )

    with _CACHE_LOCK:
        if len(_DASHBOARD_RESPONSE_CACHE) > 500:
            _DASHBOARD_RESPONSE_CACHE.clear()
        _DASHBOARD_RESPONSE_CACHE[cache_key] = (now, dashboard)

    return dashboard
