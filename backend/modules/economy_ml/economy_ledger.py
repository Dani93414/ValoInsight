from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any

from .afk_compensation import infer_afk_compensation_from_reconciliation
from .economy_income_rules import (
    KILL_REWARD,
    MAX_CREDITS,
    SPIKE_PLANT_REWARD,
    SPIKE_PLANT_REWARD_MODE,
    clamp_credits,
    fixed_round_start_credits,
    round_result_income,
    save_penalty_applies,
)
from .economy_reconciliation import reconcile_expected_vs_observed, reconciliation_quality_score
from .economy_rules import infer_pistol_free_light_armor_from_economy


@dataclass
class PlayerRoundEconomyLedger:
    match_id: str
    round_number: int
    team_id: str
    puuid: str
    side: str | None
    credits_before_buy_observed: float | None
    credits_before_buy_estimated: float
    spent: float
    spent_source: str
    remaining_after_buy: float | None
    loadout_value: float | None
    kills: int
    survived: bool | None
    team_won_round: bool
    spike_planted: bool
    spike_planted_by_team: bool
    loss_streak_before_round: int
    loss_streak_after_round: int
    base_income: float
    kill_income: float
    plant_income: float
    save_penalty_income: float
    afk_compensation_income: float
    total_income: float
    expected_next_round_credits: float
    observed_next_round_credits: float | None
    reconciliation_delta: float | None
    reconciliation_status: str
    flags: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class TeamRoundEconomyLedger:
    match_id: str
    round_number: int
    team_id: str
    side: str | None
    team_won_round: bool
    loss_streak_before_round: int
    loss_streak_after_round: int
    team_credits_before_buy_observed: float
    team_credits_before_buy_estimated: float
    team_spent: float
    team_remaining_after_buy: float
    team_loadout_value: float
    team_income_expected: float
    team_expected_next_round_credits: float
    team_observed_next_round_credits: float | None
    missing_player_count_inferred: int
    afk_bonus_inferred: float | None
    players: list[PlayerRoundEconomyLedger]
    reconciliation_delta: float | None
    reconciliation_status: str
    flags: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _display_round(round_obj: dict[str, Any], index: int) -> int:
    raw = round_obj.get("roundNum")
    try:
        value = int(raw)
        return value + 1 if value == index else value
    except (TypeError, ValueError):
        return index + 1


def _normalize_side(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"attack", "attacker", "attackers", "atk"}:
        return "attack"
    if normalized in {"defense", "defender", "defenders", "def"}:
        return "defense"
    return None


def _starting_attack_team(rounds: list[dict], player_team: dict[str, str], team_ids: list[str]) -> str | None:
    for round_obj in rounds[:12]:
        planter_team = player_team.get(str(round_obj.get("bombPlanter")))
        if planter_team:
            return planter_team
        winner = str(round_obj.get("winningTeam") or "")
        winner_role = _normalize_side(round_obj.get("winningTeamRole"))
        if winner and winner_role:
            if winner_role == "attack":
                return winner
            return next((team_id for team_id in team_ids if team_id != winner), None)
    return None


def _team_side(team_id: str, round_number: int, starting_attack_team: str | None) -> str | None:
    if not starting_attack_team:
        return None
    starts_attack = team_id == starting_attack_team
    if round_number <= 12:
        attack = starts_attack
    elif round_number <= 24:
        attack = not starts_attack
    else:
        attack = starts_attack if (round_number - 25) % 2 == 0 else not starts_attack
    return "attack" if attack else "defense"


def _economy_by_player(round_obj: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for stat in round_obj.get("playerStats") or []:
        economy = stat.get("economy")
        if stat.get("puuid") and isinstance(economy, dict):
            result[str(stat["puuid"])] = economy
    return result


def _stats_by_player(round_obj: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(stat.get("puuid")): stat
        for stat in round_obj.get("playerStats") or []
        if stat.get("puuid")
    }


def _observed_prebuy(economy: dict[str, Any] | None) -> float | None:
    if not isinstance(economy, dict):
        return None
    for key in ("creditsBeforeBuy", "credits_before_buy"):
        if economy.get(key) is not None:
            return clamp_credits(_number(economy.get(key)))
    return None


def _next_observed_prebuy(rounds: list[dict], round_index: int, puuid: str) -> float | None:
    if round_index + 1 >= len(rounds):
        return None
    return _observed_prebuy(_economy_by_player(rounds[round_index + 1]).get(puuid))


def _round_kills(stat: dict[str, Any] | None) -> tuple[int, bool]:
    if not isinstance(stat, dict):
        return 0, False
    kills = stat.get("kills")
    if isinstance(kills, list):
        return len(kills), True
    if isinstance(kills, (int, float)):
        return int(kills), True
    return 0, False


def infer_player_survived_round(round_obj: dict, puuid: str) -> bool | None:
    saw_kill_field = False
    for stat in round_obj.get("playerStats") or []:
        kills = stat.get("kills")
        if not isinstance(kills, list):
            continue
        saw_kill_field = True
        for kill in kills:
            if str((kill or {}).get("victim") or "") == str(puuid):
                return False
    if not saw_kill_field:
        return None
    return True


def _bomb_planter_team(round_obj: dict[str, Any], player_team: dict[str, str]) -> str | None:
    planter = str(round_obj.get("bombPlanter") or "")
    if not planter:
        return None
    if planter in player_team:
        return player_team[planter]
    return planter


def _player_ids_for_team(match: dict[str, Any], team_id: str) -> list[str]:
    return [
        str(player.get("puuid"))
        for player in match.get("players") or []
        if player.get("puuid") and str(player.get("teamId")) == str(team_id)
    ]


def _team_ids(match: dict[str, Any]) -> list[str]:
    ids = [str(team.get("teamId")) for team in match.get("teams") or [] if team.get("teamId")]
    if ids:
        return ids
    return sorted({
        str(player.get("teamId"))
        for player in match.get("players") or []
        if player.get("teamId")
    })


def build_player_round_ledger(
    *,
    match: dict,
    round_index: int,
    team_id: str,
    puuid: str,
    previous_player_state: dict | None,
) -> dict:
    context = _build_context(match)
    loss_before = int((previous_player_state or {}).get("loss_streak_after_round", 0))
    return asdict(_build_player(round_index, team_id, puuid, previous_player_state, context, loss_before))


def build_team_round_ledger(
    *,
    match: dict,
    round_index: int,
    team_id: str,
    previous_team_state: dict | None,
) -> dict:
    context = _build_context(match)
    return asdict(_build_team(round_index, team_id, previous_team_state, context))


def _build_context(match: dict[str, Any]) -> dict[str, Any]:
    rounds = match.get("roundResults") or []
    players = [p for p in (match.get("players") or []) if p.get("puuid") and p.get("teamId")]
    player_team = {str(player["puuid"]): str(player["teamId"]) for player in players}
    team_ids = _team_ids(match)
    return {
        "match": match,
        "match_id": str((match.get("matchInfo") or {}).get("matchId") or "UNKNOWN"),
        "rounds": rounds,
        "players": players,
        "player_team": player_team,
        "team_ids": team_ids,
        "starting_attack_team": _starting_attack_team(rounds, player_team, team_ids),
    }


def _build_player(
    round_index: int,
    team_id: str,
    puuid: str,
    previous_player_state: dict | None,
    context: dict[str, Any],
    loss_streak_before_round: int,
) -> PlayerRoundEconomyLedger:
    rounds = context["rounds"]
    round_obj = rounds[round_index]
    round_number = _display_round(round_obj, round_index)
    economy = _economy_by_player(round_obj).get(str(puuid))
    stat = _stats_by_player(round_obj).get(str(puuid))
    observed_before = _observed_prebuy(economy)
    fixed_start = fixed_round_start_credits(round_number)
    if fixed_start is not None:
        estimated_before = fixed_start
    elif observed_before is not None:
        estimated_before = observed_before
    elif previous_player_state:
        estimated_before = _number(previous_player_state.get("expected_next_round_credits"))
    else:
        estimated_before = 0.0
    estimated_before = clamp_credits(estimated_before)

    remaining = (economy or {}).get("remaining")
    remaining_after_buy = _number(remaining) if remaining is not None else estimated_before
    spent = max(0.0, estimated_before - remaining_after_buy) if remaining is not None else 0.0
    loadout_value = (economy or {}).get("loadoutValue")
    kills, kills_available = _round_kills(stat)
    survived = infer_player_survived_round(round_obj, puuid)
    team_won = str(round_obj.get("winningTeam") or "") == str(team_id)
    loss_after = 0 if team_won else loss_streak_before_round + 1
    planter_team = _bomb_planter_team(round_obj, context["player_team"])
    spike_planted = bool(round_obj.get("bombPlanter"))
    spike_planted_by_team = planter_team == str(team_id)
    side = _team_side(str(team_id), round_number, context["starting_attack_team"])
    save_penalty = save_penalty_applies(
        side=side or "",
        team_won=team_won,
        player_survived=survived,
        spike_planted=spike_planted,
        round_result=round_obj.get("roundResult"),
        round_ceremony=round_obj.get("roundCeremony"),
    )
    base_income = round_result_income(
        team_won=team_won,
        loss_streak_after_round=loss_after,
        save_penalty_applies=save_penalty,
    )
    kill_income = kills * KILL_REWARD
    plant_income = 0.0
    if SPIKE_PLANT_REWARD_MODE == "team_attackers" and spike_planted_by_team and side == "attack":
        plant_income = SPIKE_PLANT_REWARD
    elif SPIKE_PLANT_REWARD_MODE == "planter_only" and str(round_obj.get("bombPlanter")) == str(puuid):
        plant_income = SPIKE_PLANT_REWARD
    total_income = base_income + kill_income + plant_income
    expected_next = clamp_credits(remaining_after_buy + total_income)
    observed_next = _next_observed_prebuy(rounds, round_index, puuid)
    reconciliation = reconcile_expected_vs_observed(expected_next, observed_next)
    flags = list(reconciliation["flags"])
    warnings = list(reconciliation["warnings"])
    if save_penalty:
        flags.append("save_penalty")
    elif not team_won and survived is None:
        warnings.append("save_penalty_uncertain")
    if not kills_available:
        warnings.append("kills_not_available")
    if infer_pistol_free_light_armor_from_economy(round_number, economy or {}):
        flags.append("free_light_armor_exception")
    if isinstance(economy, dict) and economy.get("spent") is not None:
        flags.append("legacy_spent_ignored")
    if round_number in {1, 13}:
        flags.append("is_half_reset_round")
    if round_number >= 25:
        flags.append("is_overtime_round")
    if round_number in {12, 24}:
        flags.append("is_last_round_before_switch")
    return PlayerRoundEconomyLedger(
        match_id=context["match_id"],
        round_number=round_number,
        team_id=str(team_id),
        puuid=str(puuid),
        side=side,
        credits_before_buy_observed=observed_before,
        credits_before_buy_estimated=estimated_before,
        spent=spent,
        spent_source="derived_prebuy_minus_remaining",
        remaining_after_buy=remaining_after_buy if remaining is not None else None,
        loadout_value=_number(loadout_value) if loadout_value is not None else None,
        kills=kills,
        survived=survived,
        team_won_round=team_won,
        spike_planted=spike_planted,
        spike_planted_by_team=spike_planted_by_team,
        loss_streak_before_round=loss_streak_before_round,
        loss_streak_after_round=loss_after,
        base_income=base_income,
        kill_income=kill_income,
        plant_income=plant_income,
        save_penalty_income=base_income if save_penalty else 0.0,
        afk_compensation_income=0.0,
        total_income=total_income,
        expected_next_round_credits=expected_next,
        observed_next_round_credits=observed_next,
        reconciliation_delta=reconciliation["delta"],
        reconciliation_status=reconciliation["status"],
        flags=flags,
        warnings=warnings,
    )


def _build_team(
    round_index: int,
    team_id: str,
    previous_team_state: dict | None,
    context: dict[str, Any],
) -> TeamRoundEconomyLedger:
    round_obj = context["rounds"][round_index]
    round_number = _display_round(round_obj, round_index)
    team_won = str(round_obj.get("winningTeam") or "") == str(team_id)
    loss_before = int((previous_team_state or {}).get("loss_streak_after_round", 0))
    loss_after = 0 if team_won else loss_before + 1
    players = [
        _build_player(round_index, team_id, puuid, (previous_team_state or {}).get("players_by_puuid", {}).get(puuid), context, loss_before)
        for puuid in _player_ids_for_team(context["match"], team_id)
    ]
    team_expected_next = sum(player.expected_next_round_credits for player in players)
    team_observed_next_values = [
        player.observed_next_round_credits
        for player in players
        if player.observed_next_round_credits is not None
    ]
    team_observed_next = sum(team_observed_next_values) if team_observed_next_values else None
    reconciliation = reconcile_expected_vs_observed(team_expected_next, team_observed_next)
    statuses = [player.reconciliation_status for player in players]
    flags = list(reconciliation["flags"])
    warnings = list(reconciliation["warnings"])
    if any("free_light_armor_exception" in player.flags for player in players):
        flags.append("free_light_armor_exception")
    if any("save_penalty" in player.flags for player in players):
        flags.append("save_penalty")
    if round_number in {1, 13}:
        flags.append("is_half_reset_round")
    if round_number >= 25:
        flags.append("is_overtime_round")
    if round_number in {12, 24}:
        flags.append("is_last_round_before_switch")
    missing = max(0, 5 - len(players))
    return TeamRoundEconomyLedger(
        match_id=context["match_id"],
        round_number=round_number,
        team_id=str(team_id),
        side=_team_side(str(team_id), round_number, context["starting_attack_team"]),
        team_won_round=team_won,
        loss_streak_before_round=loss_before,
        loss_streak_after_round=loss_after,
        team_credits_before_buy_observed=sum(player.credits_before_buy_observed or 0 for player in players),
        team_credits_before_buy_estimated=sum(player.credits_before_buy_estimated for player in players),
        team_spent=sum(player.spent for player in players),
        team_remaining_after_buy=sum(player.remaining_after_buy or 0 for player in players),
        team_loadout_value=sum(player.loadout_value or 0 for player in players),
        team_income_expected=sum(player.total_income for player in players),
        team_expected_next_round_credits=team_expected_next,
        team_observed_next_round_credits=team_observed_next,
        missing_player_count_inferred=missing,
        afk_bonus_inferred=None,
        players=players,
        reconciliation_delta=reconciliation["delta"],
        reconciliation_status=(
            "matched" if statuses and all(status == "matched" for status in statuses)
            else reconciliation["status"]
        ),
        flags=flags,
        warnings=warnings,
    )


def build_match_economy_ledger(match: dict) -> dict:
    context = _build_context(match)
    team_ids = context["team_ids"]
    previous: dict[str, dict[str, Any]] = {}
    round_payloads: list[dict[str, Any]] = []
    all_player_ledgers: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, _round_obj in enumerate(context["rounds"]):
        teams: dict[str, dict[str, Any]] = {}
        for team_id in team_ids:
            team_ledger = _build_team(index, team_id, previous.get(team_id), context)
            team_dict = asdict(team_ledger)
            team_dict["players_by_puuid"] = {
                player["puuid"]: player for player in team_dict["players"]
            }
            team_dict["reconciliation_quality_score"] = reconciliation_quality_score(
                [player["reconciliation_status"] for player in team_dict["players"]]
            )
            teams[team_id] = team_dict
            previous[team_id] = team_dict
            all_player_ledgers.extend(team_dict["players"])
            warnings.extend(team_dict["warnings"])
        round_payloads.append({
            "round_number": _display_round(context["rounds"][index], index),
            "teams": teams,
        })

    afk = infer_afk_compensation_from_reconciliation(all_player_ledgers)
    for round_payload in round_payloads:
        for team in round_payload["teams"].values():
            if team["reconciliation_status"] == "observed_more_than_expected":
                team["afk_bonus_inferred"] = afk["most_likely_bonus"]

    matched = sum(1 for item in all_player_ledgers if item.get("reconciliation_status") == "matched")
    observable = [item for item in all_player_ledgers if item.get("reconciliation_status") != "not_observable"]
    deltas = [abs(float(item["reconciliation_delta"])) for item in observable if item.get("reconciliation_delta") is not None]
    return {
        "match_id": context["match_id"],
        "queue_id": str((match.get("matchInfo") or {}).get("queueId") or "UNKNOWN"),
        "is_ranked": bool((match.get("matchInfo") or {}).get("isRanked")),
        "rounds": round_payloads,
        "summary": {
            "rounds": len(round_payloads),
            "player_rounds": len(all_player_ledgers),
            "matched_rate": round(matched / len(observable), 4) if observable else 0.0,
            "mean_abs_delta": round(sum(deltas) / len(deltas), 4) if deltas else 0.0,
            "large_delta_count": sum(delta > 50 for delta in deltas),
            "possible_afk_bonus_candidates": afk["candidate_bonus_values"],
            "save_penalty_cases": sum("save_penalty" in item.get("flags", []) for item in all_player_ledgers),
            "free_light_armor_exceptions": sum("free_light_armor_exception" in item.get("flags", []) for item in all_player_ledgers),
        },
        "warnings": sorted(set(warnings + afk["warnings"])),
    }


def build_economy_ledger_report(matches: list[dict]) -> dict:
    ledgers = [build_match_economy_ledger(match) for match in matches if isinstance(match, dict)]
    player_ledgers: list[dict[str, Any]] = []
    warnings: list[str] = []
    rounds = 0
    for ledger in ledgers:
        warnings.extend(ledger.get("warnings") or [])
        rounds += len(ledger.get("rounds") or [])
        for round_payload in ledger.get("rounds") or []:
            for team in (round_payload.get("teams") or {}).values():
                player_ledgers.extend(team.get("players") or [])
    observable = [item for item in player_ledgers if item.get("reconciliation_status") != "not_observable"]
    matched = sum(1 for item in observable if item.get("reconciliation_status") == "matched")
    deltas = [abs(float(item["reconciliation_delta"])) for item in observable if item.get("reconciliation_delta") is not None]
    afk = infer_afk_compensation_from_reconciliation(player_ledgers)
    return {
        "matches": len(ledgers),
        "rounds": rounds,
        "player_rounds": len(player_ledgers),
        "matched_rate": round(matched / len(observable), 4) if observable else 0.0,
        "mean_abs_delta": round(sum(deltas) / len(deltas), 4) if deltas else 0.0,
        "large_delta_count": sum(delta > 50 for delta in deltas),
        "possible_afk_bonus_candidates": afk["candidate_bonus_values"],
        "save_penalty_cases": sum("save_penalty" in item.get("flags", []) for item in player_ledgers),
        "free_light_armor_exceptions": sum("free_light_armor_exception" in item.get("flags", []) for item in player_ledgers),
        "warnings": sorted(set(warnings + afk["warnings"])),
    }
