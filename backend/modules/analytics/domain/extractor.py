from __future__ import annotations

import copy
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from modules.analytics.domain.constants import (
    SIDE_ATTACK,
    SIDE_DEFENSE,
    SIDE_UNKNOWN,
    SPATIAL_PROXIMITY_THRESHOLD_UNITS,
    TRADE_WINDOW_MS,
)
from modules.analytics.infrastructure.reference_data import (
    resolve_agent_name,
    resolve_agent_role,
    resolve_gear_name,
    resolve_map_name,
    resolve_weapon_name,
)

from shared.combat_events import (
    is_enemy_damage,
    is_valid_kill,
    valid_assistants,
    valid_kills,
)
from shared.math_utils import euclidean_distance_2d, safe_div as _safe_div_raw
from shared.stat_formulas import finalize_core_stats
from shared.weapon_attribution import (
    compute_precise_weapon_stats_core,
    merge_precise_weapon_core_stats,
)


def safe_div(numerator: float, denominator: float) -> float:
    return _safe_div_raw(numerator, denominator, 4)


def clamp_non_negative(value: int | float) -> int | float:
    return value if value >= 0 else 0


def invert_side(side: str) -> str:
    side_norm = str(side).strip().lower()
    if side_norm in {"attack", "attacker", "attackers", "atk"}:
        return SIDE_DEFENSE
    if side_norm in {"defense", "defender", "defenders", "def"}:
        return SIDE_ATTACK
    return SIDE_UNKNOWN


def normalize_side(side: str) -> str:
    side_norm = str(side).strip().lower()
    if side_norm in {"attack", "attacker", "attackers", "atk"}:
        return SIDE_ATTACK
    if side_norm in {"defense", "defender", "defenders", "def"}:
        return SIDE_DEFENSE
    return SIDE_UNKNOWN


def new_scope_stats() -> dict:
    return {
        "matches": 0,
        "rounds": 0,
        "wins": 0,
        "kills": 0,
        "deaths": 0,
        "assists": 0,
        "score": 0,
        "damage_dealt": 0,
        "damage_received": 0,
        "damage_delta": 0,
        "headshots": 0,
        "bodyshots": 0,
        "legshots": 0,
        "first_kills": 0,
        "first_deaths": 0,
        "opening_duel_wins": 0,
        "opening_duel_losses": 0,
        "trade_kills": 0,
        "trade_opportunities": 0,
        "missed_trade_opportunities": 0,
        "traded_deaths": 0,
        "clutch_opportunities": 0,
        "clutches_won": 0,
        "clutch_1v1_opportunities": 0,
        "clutch_1v1_wins": 0,
        "clutch_1v2_opportunities": 0,
        "clutch_1v2_wins": 0,
        "clutch_1v3_opportunities": 0,
        "clutch_1v3_wins": 0,
        "clutch_1v4_opportunities": 0,
        "clutch_1v4_wins": 0,
        "clutch_1v5_opportunities": 0,
        "clutch_1v5_wins": 0,
        "survival_rounds": 0,
        "rounds_with_kill": 0,
        "rounds_with_assist": 0,
        "rounds_with_death": 0,
        "rounds_with_kast": 0,
        "rounds_with_direct_participation": 0,
        "rounds_without_direct_participation": 0,
        "rounds_only_kill": 0,
        "rounds_only_assist": 0,
        "rounds_only_death": 0,
        "rounds_kill_assist": 0,
        "rounds_kill_death": 0,
        "rounds_assist_death": 0,
        "rounds_kill_assist_death": 0,
        "rounds_none": 0,
        "rounds_combined_or_none": 0,
        "rounds_with_multikill": 0,
        "multi_2k": 0,
        "multi_3k": 0,
        "multi_4k": 0,
        "multi_5k": 0,
        "econ_spent": 0,
        "loadout_value_total": 0,
        "weapon_stats": {},
        "armor_stats": {},
        "buy_buckets": {
            "eco": {"rounds": 0, "wins": 0, "kills": 0, "deaths": 0, "damage_dealt": 0, "spent": 0},
            "low_buy": {"rounds": 0, "wins": 0, "kills": 0, "deaths": 0, "damage_dealt": 0, "spent": 0},
            "full_buy": {"rounds": 0, "wins": 0, "kills": 0, "deaths": 0, "damage_dealt": 0, "spent": 0},
        },
    }


def _new_weapon_scope(weapon_id: str, weapon_name: Optional[str] = None) -> dict:
    return {
        "weapon_id": weapon_id,
        "weapon_name": weapon_name or "Unknown",
        "rounds": 0,
        "wins": 0,
        "kills": 0,
        "deaths": 0,
        "assists": 0,
        "score": 0,
        "damage_dealt": 0,
        "damage_received": 0,
        "damage_delta": 0,
        "headshots": 0,
        "bodyshots": 0,
        "legshots": 0,
        "first_kills": 0,
        "first_deaths": 0,
        "opening_duel_wins": 0,
        "opening_duel_losses": 0,
        "trade_kills": 0,
        "trade_opportunities": 0,
        "missed_trade_opportunities": 0,
        "traded_deaths": 0,
        "clutch_opportunities": 0,
        "clutches_won": 0,
        "clutch_1v1_opportunities": 0,
        "clutch_1v1_wins": 0,
        "clutch_1v2_opportunities": 0,
        "clutch_1v2_wins": 0,
        "clutch_1v3_opportunities": 0,
        "clutch_1v3_wins": 0,
        "clutch_1v4_opportunities": 0,
        "clutch_1v4_wins": 0,
        "clutch_1v5_opportunities": 0,
        "clutch_1v5_wins": 0,
        "survival_rounds": 0,
        "rounds_with_kill": 0,
        "rounds_with_assist": 0,
        "rounds_with_death": 0,
        "rounds_with_kast": 0,
        "rounds_with_direct_participation": 0,
        "rounds_without_direct_participation": 0,
        "rounds_only_kill": 0,
        "rounds_only_assist": 0,
        "rounds_only_death": 0,
        "rounds_kill_assist": 0,
        "rounds_kill_death": 0,
        "rounds_assist_death": 0,
        "rounds_kill_assist_death": 0,
        "rounds_none": 0,
        "rounds_combined_or_none": 0,
        "rounds_with_multikill": 0,
        "multi_2k": 0,
        "multi_3k": 0,
        "multi_4k": 0,
        "multi_5k": 0,
        "econ_spent": 0,
        "loadout_value_total": 0,
    }


def _new_armor_scope(armor_id: str, armor_name: Optional[str] = None) -> dict:
    return {
        "weapon_id": armor_id,
        "weapon_name": armor_name or "Unknown",
        "is_armor": True,
        "rounds": 0,
        "rounds_purchased": 0,
        "wins": 0,
        "deaths": 0,
        "damage_received": 0,
        "survival_rounds": 0,
        "econ_spent": 0,
        "loadout_value_total": 0,
    }


def _bucket_from_spent(spent: int) -> str:
    if spent <= 2400:
        return "eco"
    if spent <= 3900:
        return "low_buy"
    return "full_buy"


def _unique_kill_key(kill: dict) -> tuple:
    return (
        kill.get("timeSinceRoundStartMillis"),
        kill.get("killer"),
        kill.get("victim"),
        tuple(sorted(kill.get("assistants", []) or [])),
    )


def _collect_round_kills(round_obj: dict) -> List[dict]:
    seen = set()
    all_kills = []
    for pstat in round_obj.get("playerStats", []):
        for kill in pstat.get("kills", []) or []:
            key = _unique_kill_key(kill)
            if key in seen:
                continue
            seen.add(key)
            all_kills.append(copy.deepcopy(kill))
    all_kills.sort(key=lambda item: item.get("timeSinceRoundStartMillis", 10**12))
    return all_kills


def _player_stats_map(round_obj: dict) -> Dict[str, dict]:
    return {
        pstat.get("puuid"): pstat
        for pstat in round_obj.get("playerStats", [])
        if pstat.get("puuid")
    }


def _infer_winning_side(
    round_obj: dict,
    pstats_map: Dict[str, dict],
    winning_team_id: Optional[str],
    player_team_map: Optional[Dict[str, str]] = None,
    round_num: Optional[int] = None,
    starting_attack_team: Optional[str] = None,
) -> str:
    role = normalize_side(round_obj.get("winningTeamRole"))
    if role in {SIDE_ATTACK, SIDE_DEFENSE}:
        return role

    ptmap = player_team_map or {}

    bomb_planter = round_obj.get("bombPlanter")
    if bomb_planter:
        planter_team_id = ptmap.get(bomb_planter) or (pstats_map.get(bomb_planter) or {}).get("teamId")
        if planter_team_id and winning_team_id:
            return SIDE_ATTACK if planter_team_id == winning_team_id else SIDE_DEFENSE

    bomb_defuser = round_obj.get("bombDefuser")
    if bomb_defuser:
        defuser_team_id = ptmap.get(bomb_defuser) or (pstats_map.get(bomb_defuser) or {}).get("teamId")
        if defuser_team_id and winning_team_id:
            return SIDE_DEFENSE if defuser_team_id == winning_team_id else SIDE_ATTACK

    if round_num is not None and starting_attack_team and winning_team_id:
        attacking_team = _attacking_team_for_round(round_num, starting_attack_team, set(ptmap.values()))
        if attacking_team:
            return SIDE_ATTACK if winning_team_id == attacking_team else SIDE_DEFENSE

    return SIDE_UNKNOWN


def _attacking_team_for_round(
    round_num: int,
    starting_attack_team: str,
    all_team_ids: set,
) -> Optional[str]:
    other_teams = all_team_ids - {starting_attack_team}
    other_team = next(iter(other_teams), None)
    if not other_team:
        return None

    if round_num < 12:
        return starting_attack_team
    if round_num < 24:
        return other_team
    # Overtime: sides alternate every round (AB, AB, AB...)
    return starting_attack_team if (round_num - 24) % 2 == 0 else other_team


def _get_player_damage_dealt_and_shots(
    round_pstat: dict,
    puuid: str,
    player_team_map: Dict[str, str],
) -> tuple[int, int, int, int]:
    total_damage = 0
    hs = 0
    body = 0
    leg = 0
    for dmg in round_pstat.get("damage", []) or []:
        if not is_enemy_damage(puuid, dmg.get("receiver"), player_team_map):
            continue
        total_damage += int(dmg.get("damage", 0) or 0)
        hs += int(dmg.get("headshots", 0) or 0)
        body += int(dmg.get("bodyshots", 0) or 0)
        leg += int(dmg.get("legshots", 0) or 0)
    return total_damage, hs, body, leg


def _get_player_damage_received(
    round_obj: dict,
    puuid: str,
    player_team_map: Dict[str, str],
) -> int:
    total_received = 0
    for pstat in round_obj.get("playerStats", []) or []:
        attacker = pstat.get("puuid")
        for dmg in pstat.get("damage", []) or []:
            if (
                dmg.get("receiver") == puuid
                and is_enemy_damage(attacker, puuid, player_team_map)
            ):
                total_received += int(dmg.get("damage", 0) or 0)
    return total_received


def _get_round_assists_from_kills(
    kills: Iterable[dict],
    puuid: str,
    player_team_map: Dict[str, str],
) -> int:
    count = 0
    for kill in kills:
        assistants = valid_assistants(kill, player_team_map)
        count += sum(1 for assistant in assistants if assistant == puuid)
    return count


def _get_player_kills_count(
    kills: Iterable[dict],
    puuid: str,
    player_team_map: Dict[str, str],
) -> int:
    return sum(
        1
        for kill in kills
        if kill.get("killer") == puuid and is_valid_kill(kill, player_team_map)
    )


def _did_player_die(kills: Iterable[dict], puuid: str) -> bool:
    return any(kill.get("victim") == puuid for kill in kills)


def _find_first_kill(kills: List[dict]) -> Optional[dict]:
    return kills[0] if kills else None


def _get_player_location_snapshot(kill: dict, puuid: str | None) -> Optional[dict]:
    if not puuid:
        return None

    for player_location in (kill.get("playerLocations") or []):
        if player_location.get("puuid") != puuid:
            continue
        location = player_location.get("location")
        if isinstance(location, dict):
            return location
    return None


def _is_within_trade_proximity(
    actor_location: Optional[dict],
    reference_location: Optional[dict],
) -> bool:
    distance = euclidean_distance_2d(actor_location, reference_location)
    if distance is None:
        return True
    return distance <= SPATIAL_PROXIMITY_THRESHOLD_UNITS


def _prune_expired_trade_opportunities(
    opportunities: list[dict],
    current_time_ms: int,
) -> None:
    opportunities[:] = [opp for opp in opportunities if current_time_ms <= int(opp.get("expires_at", 0) or 0)]


def _consume_trade_opportunity(
    opportunities: list[dict],
    target_killer: str | None,
    event_time_ms: int,
    actor_location: Optional[dict],
    require_proximity: bool = True,
) -> bool:
    if not target_killer:
        return False

    for idx, opportunity in enumerate(opportunities):
        if opportunity.get("target_killer") != target_killer:
            continue

        expires_at = int(opportunity.get("expires_at", 0) or 0)
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
    opportunities: list[dict],
    killer_puuid: str | None,
) -> None:
    opportunities[:] = [
        opportunity
        for opportunity in opportunities
        if opportunity.get("target_killer") != killer_puuid
    ]


def _is_player_positioned_for_realistic_trade(
    kill: dict,
    puuid: str,
    player_alive: bool,
) -> bool:
    if not player_alive:
        return False

    player_location = _get_player_location_snapshot(kill, puuid)
    reference_location = kill.get("victimLocation")
    if not isinstance(reference_location, dict):
        reference_location = None
    return _is_within_trade_proximity(player_location, reference_location)


def _compute_trade_metrics(
    kills: List[dict],
    puuid: str,
    player_team: Set[str],
    enemy_team: Set[str],
) -> dict[str, int | float]:
    trade_kills = 0
    traded_deaths = 0
    realistic_trade_candidates = 0
    realistic_trade_conversions = 0
    player_alive = True

    open_trade_kill_opportunities: list[dict] = []
    open_realistic_trade_kill_opportunities: list[dict] = []
    open_traded_death_opportunities: list[dict] = []

    ordered_kills = sorted(
        kills,
        key=lambda item: int(item.get("timeSinceRoundStartMillis", 0) or 0),
    )

    for kill in ordered_kills:
        kill_time = int(kill.get("timeSinceRoundStartMillis", 0) or 0)
        killer = kill.get("killer")
        victim = kill.get("victim")

        _prune_expired_trade_opportunities(open_trade_kill_opportunities, kill_time)
        _prune_expired_trade_opportunities(
            open_realistic_trade_kill_opportunities,
            kill_time,
        )
        _prune_expired_trade_opportunities(open_traded_death_opportunities, kill_time)

        if killer == puuid and victim in enemy_team:
            current_killer_location = _get_player_location_snapshot(kill, killer)
            if _consume_trade_opportunity(
                opportunities=open_trade_kill_opportunities,
                target_killer=victim,
                event_time_ms=kill_time,
                actor_location=current_killer_location,
                require_proximity=False,
            ):
                trade_kills += 1
                if _consume_trade_opportunity(
                    opportunities=open_realistic_trade_kill_opportunities,
                    target_killer=victim,
                    event_time_ms=kill_time,
                    actor_location=current_killer_location,
                ):
                    realistic_trade_conversions += 1

        if killer in player_team and killer != puuid and victim in enemy_team:
            teammate_killer_location = _get_player_location_snapshot(kill, killer)
            if _consume_trade_opportunity(
                opportunities=open_traded_death_opportunities,
                target_killer=victim,
                event_time_ms=kill_time,
                actor_location=teammate_killer_location,
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
                "expires_at": kill_time + TRADE_WINDOW_MS,
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
                    "expires_at": kill_time + TRADE_WINDOW_MS,
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
        "trade_conversion_rate": safe_div(trade_kills * 100.0, trade_opportunities),
        "traded_deaths": traded_deaths,
    }


def _find_trade_kill_count(
    kills: List[dict],
    puuid: str,
    player_team: Set[str],
    enemy_team: Set[str],
) -> tuple[int, int]:
    metrics = _compute_trade_metrics(kills, puuid, player_team, enemy_team)
    return int(metrics["trade_kills"]), int(metrics["traded_deaths"])


def _find_clutch_for_player(
    kills: List[dict],
    puuid: str,
    player_team: Set[str],
    enemy_team: Set[str],
    player_team_won_round: bool,
) -> tuple[int, int, dict[str, int]]:
    """
    clutch opportunity:
      en algún momento el jugador queda como único superviviente de su equipo
      frente a 1+ enemigos.
    clutch won:
      si además su equipo gana la ronda.
    """
    clutch_breakdown = {
        "clutch_1v1_opportunities": 0,
        "clutch_1v1_wins": 0,
        "clutch_1v2_opportunities": 0,
        "clutch_1v2_wins": 0,
        "clutch_1v3_opportunities": 0,
        "clutch_1v3_wins": 0,
        "clutch_1v4_opportunities": 0,
        "clutch_1v4_wins": 0,
        "clutch_1v5_opportunities": 0,
        "clutch_1v5_wins": 0,
    }

    alive_player_team = set(player_team)
    alive_enemy_team = set(enemy_team)

    clutch_enemy_count = None
    player_alive = puuid in alive_player_team

    for kill in kills:
        victim = kill.get("victim")
        if victim in alive_player_team:
            alive_player_team.remove(victim)
        elif victim in alive_enemy_team:
            alive_enemy_team.remove(victim)

        player_alive = puuid in alive_player_team

        if player_alive and len(alive_player_team) == 1 and len(alive_enemy_team) >= 1:
            clutch_enemy_count = len(alive_enemy_team)
            break

    if clutch_enemy_count is None:
        return 0, 0, clutch_breakdown

    clutch_enemy_count = max(1, min(int(clutch_enemy_count), 5))
    opportunity_key = f"clutch_1v{clutch_enemy_count}_opportunities"
    won_key = f"clutch_1v{clutch_enemy_count}_wins"
    clutch_breakdown[opportunity_key] = 1
    if player_team_won_round:
        clutch_breakdown[won_key] = 1

    return 1, 1 if player_team_won_round else 0, clutch_breakdown


def _upsert_weapon_stats(scope: dict, weapon_id: str) -> dict:
    weapon_id = str(weapon_id or "UNKNOWN")
    if weapon_id not in scope["weapon_stats"]:
        scope["weapon_stats"][weapon_id] = _new_weapon_scope(
            weapon_id=weapon_id,
            weapon_name=resolve_weapon_name(weapon_id),
        )
    return scope["weapon_stats"][weapon_id]


def _upsert_armor_stats(scope: dict, armor_id: str) -> dict:
    armor_id = str(armor_id or "UNKNOWN")
    if armor_id not in scope["armor_stats"]:
        scope["armor_stats"][armor_id] = _new_armor_scope(
            armor_id=armor_id,
            armor_name=resolve_gear_name(armor_id),
        )
    return scope["armor_stats"][armor_id]


def _update_weapon_scope(weapon_scope: dict, round_payload: dict) -> None:
    for key in (
        "rounds",
        "wins",
        "kills",
        "deaths",
        "assists",
        "score",
        "damage_dealt",
        "damage_received",
        "damage_delta",
        "headshots",
        "bodyshots",
        "legshots",
        "first_kills",
        "first_deaths",
        "opening_duel_wins",
        "opening_duel_losses",
        "trade_kills",
        "trade_opportunities",
        "missed_trade_opportunities",
        "traded_deaths",
        "clutch_opportunities",
        "clutches_won",
        "clutch_1v1_opportunities",
        "clutch_1v1_wins",
        "clutch_1v2_opportunities",
        "clutch_1v2_wins",
        "clutch_1v3_opportunities",
        "clutch_1v3_wins",
        "clutch_1v4_opportunities",
        "clutch_1v4_wins",
        "clutch_1v5_opportunities",
        "clutch_1v5_wins",
        "survival_rounds",
        "rounds_with_kill",
        "rounds_with_assist",
        "rounds_with_death",
        "rounds_with_kast",
        "rounds_with_direct_participation",
        "rounds_without_direct_participation",
        "rounds_only_kill",
        "rounds_only_assist",
        "rounds_only_death",
        "rounds_kill_assist",
        "rounds_kill_death",
        "rounds_assist_death",
        "rounds_kill_assist_death",
        "rounds_none",
        "rounds_combined_or_none",
        "rounds_with_multikill",
        "multi_2k",
        "multi_3k",
        "multi_4k",
        "multi_5k",
        "econ_spent",
        "loadout_value_total",
    ):
        weapon_scope[key] += round_payload.get(key, 0)


def _update_armor_scope(armor_scope: dict, round_payload: dict) -> None:
    for key in (
        "rounds",
        "wins",
        "deaths",
        "damage_received",
        "survival_rounds",
        "econ_spent",
        "loadout_value_total",
    ):
        armor_scope[key] += round_payload.get(key, 0)
    armor_scope["rounds_purchased"] += 1


def _update_scope(scope: dict, weapon_id: str, round_payload: dict, spent: int) -> None:
    for key in (
        "rounds",
        "wins",
        "kills",
        "deaths",
        "assists",
        "score",
        "damage_dealt",
        "damage_received",
        "damage_delta",
        "headshots",
        "bodyshots",
        "legshots",
        "first_kills",
        "first_deaths",
        "opening_duel_wins",
        "opening_duel_losses",
        "trade_kills",
        "trade_opportunities",
        "missed_trade_opportunities",
        "traded_deaths",
        "clutch_opportunities",
        "clutches_won",
        "clutch_1v1_opportunities",
        "clutch_1v1_wins",
        "clutch_1v2_opportunities",
        "clutch_1v2_wins",
        "clutch_1v3_opportunities",
        "clutch_1v3_wins",
        "clutch_1v4_opportunities",
        "clutch_1v4_wins",
        "clutch_1v5_opportunities",
        "clutch_1v5_wins",
        "survival_rounds",
        "rounds_with_kill",
        "rounds_with_assist",
        "rounds_with_death",
        "rounds_with_kast",
        "rounds_with_direct_participation",
        "rounds_without_direct_participation",
        "rounds_only_kill",
        "rounds_only_assist",
        "rounds_only_death",
        "rounds_kill_assist",
        "rounds_kill_death",
        "rounds_assist_death",
        "rounds_kill_assist_death",
        "rounds_none",
        "rounds_combined_or_none",
        "rounds_with_multikill",
        "multi_2k",
        "multi_3k",
        "multi_4k",
        "multi_5k",
        "econ_spent",
        "loadout_value_total",
    ):
        scope[key] += round_payload.get(key, 0)

    bucket_name = _bucket_from_spent(spent)
    bucket = scope["buy_buckets"][bucket_name]
    bucket["rounds"] += 1
    bucket["wins"] += round_payload.get("wins", 0)
    bucket["kills"] += round_payload.get("kills", 0)
    bucket["deaths"] += round_payload.get("deaths", 0)
    bucket["damage_dealt"] += round_payload.get("damage_dealt", 0)
    bucket["spent"] += spent

    weapon_scope = _upsert_weapon_stats(scope, weapon_id)
    _update_weapon_scope(weapon_scope, round_payload)


def _update_armor_stats(scope: dict, armor_id: str, round_payload: dict) -> None:
    if not armor_id or armor_id in {"UNKNOWN", "string", "None", "null"}:
        return
    armor_scope = _upsert_armor_stats(scope, armor_id)
    _update_armor_scope(armor_scope, round_payload)


def _finalize_stats_block(stats: dict) -> dict:
    finalize_core_stats(stats)

    for bucket_name, bucket in stats.get("buy_buckets", {}).items():
        bucket_rounds = bucket.get("rounds", 0)
        bucket["win_rate"] = safe_div(bucket.get("wins", 0) * 100.0, bucket_rounds)
        bucket["kd_ratio"] = safe_div(bucket.get("kills", 0), max(bucket.get("deaths", 0), 1))
        bucket["adr"] = safe_div(bucket.get("damage_dealt", 0), bucket_rounds)
        bucket["damage_per_1000_credits"] = safe_div(bucket.get("damage_dealt", 0) * 1000.0, bucket.get("spent", 0))

    for weapon_id, weapon_stats in stats.get("weapon_stats", {}).items():
        finalize_core_stats(weapon_stats)

    for armor_id, armor_stats in stats.get("armor_stats", {}).items():
        rounds = armor_stats.get("rounds", 0)
        armor_stats["win_rate"] = safe_div(armor_stats.get("wins", 0) * 100.0, rounds)
        armor_stats["survival_rate"] = safe_div(armor_stats.get("survival_rounds", 0) * 100.0, rounds)
        armor_stats["damage_received_per_round"] = safe_div(armor_stats.get("damage_received", 0), rounds)
        armor_stats["average_loadout_value"] = safe_div(armor_stats.get("loadout_value_total", 0), rounds)

    return stats


def _detect_starting_attack_team(
    round_results: List[dict],
    player_team_map: Dict[str, str],
) -> Optional[str]:
    """Scan rounds 0-11 for a bombPlanter to determine which team started on attack."""
    for r in round_results:
        rnum = r.get("roundNum")
        if not isinstance(rnum, int) or rnum >= 12:
            continue
        planter = r.get("bombPlanter")
        if planter and planter in player_team_map:
            return player_team_map[planter]
    return None


def build_player_match_analytics_docs(match_obj: dict) -> List[dict]:
    """Legacy wrapper — returns list of standalone analytics docs (for compatibility)."""
    embedded = build_player_analytics_embedded(match_obj)
    if not embedded:
        return []

    match_info = match_obj.get("matchInfo") or {}
    players = match_obj.get("players", []) or []
    teams = match_obj.get("teams", []) or []
    team_winner_map = {team["teamId"]: bool(team.get("won")) for team in teams if team.get("teamId")}

    docs: List[dict] = []
    for player in players:
        puuid = player.get("puuid")
        if not puuid or puuid not in embedded:
            continue
        analytics = embedded[puuid]
        player_stats = player.get("stats", {}) or {}
        docs.append({
            "match_id": str(match_info.get("matchId")),
            "puuid": puuid,
            "game_name": player.get("gameName"),
            "tag_line": player.get("tagLine"),
            "team_id": player.get("teamId"),
            "won_match": analytics["won_match"],
            "is_draw": analytics["is_draw"],
            "is_ranked": True,
            "queue_id": match_info.get("queueId"),
            "game_mode": match_info.get("gameMode"),
            "region": match_info.get("region"),
            "game_start_millis": match_info.get("gameStartMillis"),
            "season_id": str(match_info.get("seasonId") or "UNKNOWN"),
            "map_id": str(match_info.get("mapId") or "UNKNOWN"),
            "map_name": analytics["map_name"],
            "agent_id": str(player.get("characterId") or "UNKNOWN"),
            "agent_name": analytics["agent_name"],
            "role": analytics["role"],
            "competitive_tier": player.get("competitiveTier"),
            "competitive_tier_image": player.get("competitiveTierImage"),
            "account_level": player.get("accountLevel"),
            "player_totals_from_match": {
                "kills": int(player_stats.get("kills", 0) or 0),
                "deaths": int(player_stats.get("deaths", 0) or 0),
                "assists": int(player_stats.get("assists", 0) or 0),
                "score": int(player_stats.get("score", 0) or 0),
                "rounds_played": int(player_stats.get("roundsPlayed", 0) or 0),
                "match_duration_millis": int(match_info.get("gameLengthMillis", 0) or 0),
                "playtime_millis": int(player_stats.get("playtimeMillis", 0) or 0),
            },
            "overview": analytics["overview"],
            "sides": analytics["sides"],
        })
    return docs


def build_player_analytics_embedded(match_obj: dict) -> Dict[str, dict]:
    """
    Compute per-player analytics and return a dict keyed by puuid.
    Each value is the analytics subdocument to embed in matches.players[].analytics.
    Only processes ranked matches; returns empty dict otherwise.
    """
    match_info = match_obj.get("matchInfo") or {}
    if not match_info.get("isRanked"):
        return {}

    match_id = match_info.get("matchId")
    if not match_id:
        return []

    players = match_obj.get("players", []) or []
    teams = match_obj.get("teams", []) or []
    round_results = match_obj.get("roundResults", []) or []
    try:
        from modules.economy_ml.economy_ledger import build_match_economy_ledger
        economy_ledger = build_match_economy_ledger(match_obj)
        derived_spend = {
            (int(round_payload.get("round_number") or 0), str(player.get("puuid") or "")): int(
                float(player.get("spent") or 0)
            )
            for round_payload in economy_ledger.get("rounds") or []
            for team in (round_payload.get("teams") or {}).values()
            for player in team.get("players") or []
        }
    except Exception:
        derived_spend = {}

    team_winner_map = {team["teamId"]: bool(team.get("won")) for team in teams if team.get("teamId")}
    winning_team_id = next((team_id for team_id, won in team_winner_map.items() if won), None)
    is_draw = bool(teams) and not any(team.get("won") for team in teams)

    player_team = {p["puuid"]: p.get("teamId") for p in players if p.get("puuid")}
    team_members: Dict[str, Set[str]] = defaultdict(set)
    for player in players:
        puuid = player.get("puuid")
        team_id = player.get("teamId")
        if puuid and team_id:
            team_members[team_id].add(puuid)

    starting_attack_team = _detect_starting_attack_team(round_results, player_team)

    result: Dict[str, dict] = {}

    for player in players:
        puuid = player.get("puuid")
        if not puuid:
            continue

        team_id = player.get("teamId")
        enemy_team_ids = [tid for tid in team_members.keys() if tid != team_id]
        enemy_team_id = enemy_team_ids[0] if enemy_team_ids else None

        player_stats = player.get("stats", {}) or {}
        agent_id = str(player.get("characterId") or "UNKNOWN")
        role = resolve_agent_role(agent_id)
        map_id = str(match_info.get("mapId") or "UNKNOWN")
        season_id = str(match_info.get("seasonId") or "UNKNOWN")

        overview = new_scope_stats()
        overview["matches"] = 1

        sides = {
            SIDE_ATTACK: new_scope_stats(),
            SIDE_DEFENSE: new_scope_stats(),
        }
        side_round_results = {
            SIDE_ATTACK: [],
            SIDE_DEFENSE: [],
        }

        for round_index, round_obj in enumerate(round_results):
            pstats_map = _player_stats_map(round_obj)
            round_pstat = pstats_map.get(puuid, {})
            all_kills = _collect_round_kills(round_obj)
            competitive_kills = valid_kills(all_kills, player_team)

            round_num = round_obj.get("roundNum")
            if not isinstance(round_num, int):
                round_num = None

            own_team_won_round = round_obj.get("winningTeam") == team_id
            winning_team_role = _infer_winning_side(
                round_obj=round_obj,
                pstats_map=pstats_map,
                winning_team_id=round_obj.get("winningTeam"),
                player_team_map=player_team,
                round_num=round_num,
                starting_attack_team=starting_attack_team,
            )
            if own_team_won_round:
                round_side = winning_team_role
            else:
                round_side = invert_side(winning_team_role)

            if round_side not in {SIDE_ATTACK, SIDE_DEFENSE}:
                round_side = SIDE_UNKNOWN

            player_team_set = team_members.get(team_id, set())
            enemy_team_set = team_members.get(enemy_team_id, set()) if enemy_team_id else set()

            dealt_damage, hs, body, leg = _get_player_damage_dealt_and_shots(
                round_pstat,
                puuid,
                player_team,
            )
            received_damage = _get_player_damage_received(
                round_obj,
                puuid,
                player_team,
            )
            assists_round = _get_round_assists_from_kills(
                competitive_kills,
                puuid,
                player_team,
            )
            kills_round = _get_player_kills_count(
                competitive_kills,
                puuid,
                player_team,
            )
            died = _did_player_die(all_kills, puuid)
            deaths_round = 1 if died else 0

            score_round = int(round_pstat.get("score", 0) or 0)
            economy = round_pstat.get("economy", {}) or {}
            display_round_number = (
                int(round_obj.get("roundNum")) + 1
                if round_obj.get("roundNum") == round_index
                else int(round_obj.get("roundNum") or round_index + 1)
            )
            spent = int(derived_spend.get((display_round_number, str(puuid)), 0))
            loadout_value = int(economy.get("loadoutValue", 0) or 0)
            equipped_weapon_id = str(economy.get("weapon") or "UNKNOWN")
            equipped_armor_id = str(economy.get("armor") or "UNKNOWN")

            first_kill = _find_first_kill(competitive_kills)
            first_kills = 0
            first_deaths = 0
            opening_duel_wins = 0
            opening_duel_losses = 0

            if first_kill:
                if first_kill.get("killer") == puuid:
                    first_kills = 1
                    opening_duel_wins = 1
                elif first_kill.get("victim") == puuid:
                    first_deaths = 1
                    opening_duel_losses = 1

            trade_metrics = _compute_trade_metrics(
                kills=competitive_kills,
                puuid=puuid,
                player_team=player_team_set,
                enemy_team=enemy_team_set,
            )

            clutch_opportunities, clutches_won, clutch_breakdown = _find_clutch_for_player(
                kills=competitive_kills,
                puuid=puuid,
                player_team=player_team_set,
                enemy_team=enemy_team_set,
                player_team_won_round=own_team_won_round,
            )

            survival_rounds = 0 if died else 1
            rounds_with_kill = 1 if kills_round > 0 else 0
            rounds_with_assist = 1 if assists_round > 0 else 0
            rounds_with_death = 1 if deaths_round > 0 else 0
            rounds_with_kast = (
                1
                if (
                    survival_rounds > 0
                    or rounds_with_kill > 0
                    or rounds_with_assist > 0
                    or int(trade_metrics["traded_deaths"]) > 0
                )
                else 0
            )
            rounds_with_direct_participation = (
                1 if (rounds_with_kill > 0 or rounds_with_assist > 0) else 0
            )
            rounds_without_direct_participation = (
                0 if rounds_with_direct_participation > 0 else 1
            )

            rounds_only_kill = (
                1
                if (
                    rounds_with_kill > 0
                    and rounds_with_assist == 0
                    and rounds_with_death == 0
                )
                else 0
            )
            rounds_only_assist = (
                1
                if (
                    rounds_with_assist > 0
                    and rounds_with_kill == 0
                    and rounds_with_death == 0
                )
                else 0
            )
            rounds_only_death = (
                1
                if (
                    rounds_with_death > 0
                    and rounds_with_kill == 0
                    and rounds_with_assist == 0
                )
                else 0
            )
            rounds_kill_assist = (
                1
                if (
                    rounds_with_kill > 0
                    and rounds_with_assist > 0
                    and rounds_with_death == 0
                )
                else 0
            )
            rounds_kill_death = (
                1
                if (
                    rounds_with_kill > 0
                    and rounds_with_death > 0
                    and rounds_with_assist == 0
                )
                else 0
            )
            rounds_assist_death = (
                1
                if (
                    rounds_with_assist > 0
                    and rounds_with_death > 0
                    and rounds_with_kill == 0
                )
                else 0
            )
            rounds_kill_assist_death = (
                1
                if (
                    rounds_with_kill > 0
                    and rounds_with_assist > 0
                    and rounds_with_death > 0
                )
                else 0
            )
            rounds_none = (
                1
                if (
                    rounds_with_kill == 0
                    and rounds_with_assist == 0
                    and rounds_with_death == 0
                )
                else 0
            )
            rounds_combined_or_none = (
                rounds_kill_assist
                + rounds_kill_death
                + rounds_assist_death
                + rounds_kill_assist_death
                + rounds_none
            )

            rounds_with_multikill = 1 if kills_round >= 2 else 0
            multi_2k = 1 if kills_round == 2 else 0
            multi_3k = 1 if kills_round == 3 else 0
            multi_4k = 1 if kills_round == 4 else 0
            multi_5k = 1 if kills_round >= 5 else 0

            round_payload = {
                "rounds": 1,
                "wins": 1 if own_team_won_round else 0,
                "kills": kills_round,
                "deaths": deaths_round,
                "assists": assists_round,
                "score": score_round,
                "damage_dealt": dealt_damage,
                "damage_received": received_damage,
                "damage_delta": dealt_damage - received_damage,
                "headshots": hs,
                "bodyshots": body,
                "legshots": leg,
                "first_kills": first_kills,
                "first_deaths": first_deaths,
                "opening_duel_wins": opening_duel_wins,
                "opening_duel_losses": opening_duel_losses,
                "trade_kills": int(trade_metrics["trade_kills"]),
                "trade_opportunities": int(trade_metrics["trade_opportunities"]),
                "missed_trade_opportunities": int(trade_metrics["missed_trade_opportunities"]),
                "traded_deaths": int(trade_metrics["traded_deaths"]),
                "clutch_opportunities": clutch_opportunities,
                "clutches_won": clutches_won,
                **clutch_breakdown,
                "survival_rounds": survival_rounds,
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
                "econ_spent": spent,
                "loadout_value_total": loadout_value,
            }

            _update_scope(overview, equipped_weapon_id, round_payload, spent)
            _update_armor_stats(overview, equipped_armor_id, round_payload)

            if round_side in {SIDE_ATTACK, SIDE_DEFENSE}:
                side_round_results[round_side].append(round_obj)
                _update_scope(sides[round_side], equipped_weapon_id, round_payload, spent)
                _update_armor_stats(sides[round_side], equipped_armor_id, round_payload)

        overview["weapon_stats"] = merge_precise_weapon_core_stats(
            overview.get("weapon_stats"),
            compute_precise_weapon_stats_core(round_results, puuid, player_team),
        )
        overview["weapon_stats"].update(overview.get("armor_stats") or {})
        for side_name in (SIDE_ATTACK, SIDE_DEFENSE):
            sides[side_name]["weapon_stats"] = merge_precise_weapon_core_stats(
                sides[side_name].get("weapon_stats"),
                compute_precise_weapon_stats_core(
                    side_round_results[side_name],
                    puuid,
                    player_team,
                ),
            )
            sides[side_name]["weapon_stats"].update(sides[side_name].get("armor_stats") or {})

        _finalize_stats_block(overview)
        if sides[SIDE_ATTACK].get("rounds", 0) > 0:
            sides[SIDE_ATTACK]["matches"] = 1
        if sides[SIDE_DEFENSE].get("rounds", 0) > 0:
            sides[SIDE_DEFENSE]["matches"] = 1
        _finalize_stats_block(sides[SIDE_ATTACK])
        _finalize_stats_block(sides[SIDE_DEFENSE])

        result[puuid] = {
            "won_match": bool(team_winner_map.get(team_id, False)),
            "is_draw": is_draw,
            "map_name": resolve_map_name(map_id),
            "agent_name": resolve_agent_name(agent_id),
            "role": role,
            "overview": overview,
            "sides": sides,
        }

    return result
