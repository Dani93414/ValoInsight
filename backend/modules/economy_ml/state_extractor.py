from __future__ import annotations

from collections import defaultdict
from statistics import median
from typing import Any

from modules.analytics.infrastructure.reference_data import resolve_map_name

from .action_profiles import observed_action_features
from .agent_utility import build_utility_diff_features, summarize_team_agent_utility
from .buy_classifier import classify_team_buy_action
from .economy_action_labels import classify_team_economy_labels
from .economy_cases import classify_economy_case
from .economy_rules import (
    infer_pistol_free_light_armor_from_economy,
    summarize_player_credit_features,
)
from .economy_ledger import build_match_economy_ledger
from .economy_reconciliation import reconciliation_quality_score
from .future_economy import add_future_economy_labels
from .rank_mapping import get_rank_group, get_rank_name, normalize_rank_tier


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _display_round(raw_round: Any, index: int) -> int:
    try:
        value = int(raw_round)
        return value + 1 if value == index else value
    except (TypeError, ValueError):
        return index + 1


def _normalize_side(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"attack", "attacker", "attackers", "atk"}:
        return "attack"
    if normalized in {"defense", "defender", "defenders", "def"}:
        return "defense"
    return "unknown"


def _opposite_side(side: str) -> str:
    return {"attack": "defense", "defense": "attack"}.get(side, "unknown")


def _starting_attack_team(
    rounds: list[dict], player_team: dict[str, str], team_ids: list[str]
) -> str | None:
    for index, round_obj in enumerate(rounds[:12]):
        planter_team = player_team.get(str(round_obj.get("bombPlanter")))
        if planter_team:
            return planter_team
        winner = str(round_obj.get("winningTeam") or "")
        winner_role = _normalize_side(round_obj.get("winningTeamRole"))
        if winner and winner_role != "unknown":
            if winner_role == "attack":
                return winner
            return next((team_id for team_id in team_ids if team_id != winner), None)
    return None


def _team_side(team_id: str, round_number: int, starting_attack_team: str | None) -> str:
    if not starting_attack_team:
        return "unknown"
    starts_attack = team_id == starting_attack_team
    if round_number <= 12:
        attack = starts_attack
    elif round_number <= 24:
        attack = not starts_attack
    else:
        # Competitive overtime swaps sides every round.
        attack = starts_attack if (round_number - 25) % 2 == 0 else not starts_attack
    return "attack" if attack else "defense"


def _credits_summary(values: list[float]) -> dict[str, float | int]:
    total = sum(values)
    return {
        "estimated_credits_before_buy": total,
        "players_can_full_buy_estimate": sum(value >= 3900 for value in values),
        "players_low_money": sum(value < 2000 for value in values),
    }


def _observed_prebuy_credits(economy: dict[str, Any] | None) -> float | None:
    if not isinstance(economy, dict):
        return None
    for key in ("creditsBeforeBuy", "credits_before_buy"):
        if economy.get(key) is not None:
            return _number(economy.get(key))
    return None


def _team_observed_prebuy(players: list[dict[str, Any]], economy_by_player: dict[str, dict]) -> float | None:
    values = [
        _observed_prebuy_credits(economy_by_player.get(str(player["puuid"])))
        for player in players
    ]
    if any(value is None for value in values):
        return None
    return sum(float(value or 0) for value in values)


def _credit_estimate_quality_v9(observed: float | None, rules: float, fallback_quality: str) -> tuple[str, str | None]:
    if observed is not None:
        gap = abs(float(observed) - float(rules))
        if gap <= 100:
            return "exact_observed", None
        if gap <= 600:
            return "reconciled_team", "observed_rules_gap"
        return "inconsistent", "observed_rules_gap_gt_600"
    if rules > 0:
        return "rules_only", None
    return "inconsistent", f"missing_observed_and_rules_{fallback_quality}"


def _select_prebuy_credits(observed: float | None, rules: float, quality: str, *, force_rules: bool = False) -> float:
    if force_rules or observed is None:
        return float(rules)
    if quality in {"exact_observed", "reconciled_team"}:
        return float(observed)
    return float(rules)


def fixed_round_start_credits(round_number: int) -> float | None:
    if round_number in {1, 13}:
        return 800.0
    if round_number >= 25:
        return 5000.0
    return None


def _round_player_credit_values(
    players: list[dict[str, Any]],
    economy_by_player: dict[str, dict],
    fallback_player_credits: dict[str, float],
    round_number: int,
) -> tuple[dict[str, float], str]:
    values: dict[str, float] = {}
    observed = 0
    fixed_start = fixed_round_start_credits(round_number)
    for player in players:
        puuid = str(player["puuid"])
        if fixed_start is not None:
            values[puuid] = fixed_start
            continue
        exact = _observed_prebuy_credits(economy_by_player.get(puuid))
        if exact is None:
            values[puuid] = fallback_player_credits.get(puuid, 0.0)
            continue
        values[puuid] = min(9000.0, exact)
        observed += 1
    if fixed_start is not None:
        return values, "rules_based_reset"
    if observed == len(players):
        quality = "observed_economy"
    elif observed > 0:
        quality = "mixed_observed_rules"
    else:
        quality = "rules_based"
    return values, quality


def _rules_player_credit_values(
    players: list[dict[str, Any]],
    previous_team_ledger: dict | None,
    fallback_player_credits: dict[str, float],
    round_number: int,
) -> dict[str, float]:
    fixed_start = fixed_round_start_credits(round_number)
    if fixed_start is not None:
        return {str(player["puuid"]): fixed_start for player in players}
    previous_players = {
        str(player.get("puuid")): player
        for player in ((previous_team_ledger or {}).get("players") or [])
        if player.get("puuid")
    }
    result: dict[str, float] = {}
    for player in players:
        puuid = str(player["puuid"])
        previous = previous_players.get(puuid)
        if previous and previous.get("expected_next_round_credits") is not None:
            result[puuid] = min(9000.0, _number(previous.get("expected_next_round_credits")))
        else:
            result[puuid] = min(9000.0, _number(fallback_player_credits.get(puuid)))
    return result


def _selected_player_credit_values(
    observed_values: dict[str, float],
    rules_values: dict[str, float],
    observed_team_total: float | None,
    quality: str,
) -> dict[str, float]:
    if observed_team_total is None or quality not in {"exact_observed", "reconciled_team"}:
        return dict(rules_values)
    return dict(observed_values)


def _prefixed_credit_features(prefix: str, values: list[float]) -> dict[str, float | int]:
    summary = summarize_player_credit_features(values)
    return {
        f"{prefix}_{key}": value
        for key, value in summary.items()
    }


def _empty_reconciliation_features(prefix: str) -> dict[str, float | int | str]:
    return {
        f"{prefix}_economy_reconciliation_abs_delta_mean": 0.0,
        f"{prefix}_economy_reconciliation_abs_delta_max": 0.0,
        f"{prefix}_economy_reconciliation_quality_score": 0.0,
        f"{prefix}_possible_afk_bonus": 0,
        f"{prefix}_possible_afk_bonus_value": 0.0,
        f"{prefix}_free_light_armor_exception_count": 0,
        f"{prefix}_previous_round_reconciliation_quality": "not_available",
    }


def _ledger_reconciliation_features(prefix: str, team_ledger: dict | None) -> dict[str, float | int | str | None]:
    if not isinstance(team_ledger, dict):
        return {
            **_empty_reconciliation_features(prefix),
            f"{prefix}_drop_reconciliation_status": "not_available",
            f"{prefix}_possible_drop_credit_gap": 0.0,
            f"{prefix}_spent_over_prebuy": 0.0,
        }
    players = team_ledger.get("players") or []
    deltas = [
        abs(_number(player.get("reconciliation_delta")))
        for player in players
        if player.get("reconciliation_delta") is not None
    ]
    statuses = [str(player.get("reconciliation_status") or "") for player in players]
    possible_afk = team_ledger.get("afk_bonus_inferred")
    team_spent = _number(team_ledger.get("team_spent"))
    team_prebuy = _number(team_ledger.get("team_credits_before_buy_estimated"))
    spent_over_prebuy = max(0.0, team_spent - team_prebuy)
    team_delta = team_ledger.get("reconciliation_delta")
    possible_drop_gap = max(0.0, spent_over_prebuy, _number(team_delta) if team_delta is not None else 0.0)
    if spent_over_prebuy > 0:
        drop_status = "spent_over_prebuy"
    elif team_ledger.get("reconciliation_status") == "observed_more_than_expected":
        drop_status = "possible_external_credit_source"
    elif team_ledger.get("reconciliation_status") == "observed_less_than_expected":
        drop_status = "possible_untracked_spend_or_drop"
    else:
        drop_status = str(team_ledger.get("reconciliation_status") or "not_available")
    return {
        f"{prefix}_economy_reconciliation_abs_delta_mean": sum(deltas) / len(deltas) if deltas else 0.0,
        f"{prefix}_economy_reconciliation_abs_delta_max": max(deltas) if deltas else 0.0,
        f"{prefix}_economy_reconciliation_quality_score": reconciliation_quality_score(statuses),
        f"{prefix}_possible_afk_bonus": int(possible_afk is not None or "possible_afk_bonus" in (team_ledger.get("flags") or [])),
        f"{prefix}_possible_afk_bonus_value": _number(possible_afk),
        f"{prefix}_free_light_armor_exception_count": sum(
            "free_light_armor_exception" in (player.get("flags") or [])
            for player in players
        ),
        f"{prefix}_previous_round_reconciliation_quality": str(team_ledger.get("reconciliation_status") or "not_available"),
        f"{prefix}_drop_reconciliation_status": drop_status,
        f"{prefix}_possible_drop_credit_gap": possible_drop_gap,
        f"{prefix}_spent_over_prebuy": spent_over_prebuy,
    }


def _ledger_credit_quality(fallback_quality: str, team_ledger: dict | None) -> str:
    if not isinstance(team_ledger, dict):
        return fallback_quality
    if team_ledger.get("reconciliation_status") in {"observed_more_than_expected", "observed_less_than_expected"}:
        return "observed_with_reconciliation_warnings"
    players = team_ledger.get("players") or []
    if players and all(player.get("credits_before_buy_observed") is not None for player in players):
        return "observed_economy" if fallback_quality != "rules_based_reset" else fallback_quality
    return "ledger_estimated" if fallback_quality == "rules_based" else fallback_quality


def _income_per_player(team_id: str, round_obj: dict, streaks: dict) -> float:
    winner = str(round_obj.get("winningTeam") or "")
    won = winner == team_id
    current_loss_streak = 0 if won else int(streaks[team_id]["loss"]) + 1
    return 3000 if won else 1900 if current_loss_streak == 1 else 2400 if current_loss_streak == 2 else 2900


def _update_player_credit_estimates(
    round_obj: dict, players: list[dict], economy_by_player: dict[str, dict],
    streaks: dict, player_team: dict[str, str], player_credits: dict[str, float],
    credit_quality: dict[str, str],
) -> None:
    planter_team = player_team.get(str(round_obj.get("bombPlanter")))
    for player in players:
        puuid, team_id = str(player["puuid"]), str(player["teamId"])
        economy = economy_by_player.get(puuid)
        income = _income_per_player(team_id, round_obj, streaks)
        plant_bonus = 300 if planter_team == team_id else 0
        if economy is None:
            player_credits[puuid] = min(9000.0, income + plant_bonus)
            credit_quality[team_id] = "low"
        else:
            player_credits[puuid] = min(9000.0, _number(economy.get("remaining")) + income + plant_bonus)


def _advance_round_context(
    round_obj: dict, team_ids: list[str], scores: defaultdict[str, int], streaks: dict
) -> None:
    winner = str(round_obj.get("winningTeam") or "")
    if winner in team_ids:
        scores[winner] += 1
    for team_id in team_ids:
        won = winner == team_id
        streaks[team_id]["previous_won"] = won
        streaks[team_id]["win"] = streaks[team_id]["win"] + 1 if won else 0
        streaks[team_id]["loss"] = 0 if won else streaks[team_id]["loss"] + 1


def extract_match_round_states(match: dict) -> list[dict]:
    match_info = match.get("matchInfo") or {}
    players = [p for p in (match.get("players") or []) if p.get("puuid") and p.get("teamId")]
    teams = [t for t in (match.get("teams") or []) if t.get("teamId")]
    rounds = match.get("roundResults") or []
    team_ids = [str(team["teamId"]) for team in teams]
    if len(team_ids) != 2 or not rounds:
        return []
    player_team = {str(player["puuid"]): str(player["teamId"]) for player in players}
    team_players = {
        team_id: [player for player in players if str(player["teamId"]) == team_id]
        for team_id in team_ids
    }
    team_won_match = {str(team["teamId"]): bool(team.get("won")) for team in teams}
    starting_attack_team = _starting_attack_team(rounds, player_team, team_ids)
    scores: defaultdict[str, int] = defaultdict(int)
    streaks = {team_id: {"win": 0, "loss": 0, "previous_won": None} for team_id in team_ids}
    player_credits = {str(player["puuid"]): 800.0 for player in players}
    credit_quality = {team_id: "rules_based" for team_id in team_ids}
    ledger = build_match_economy_ledger(match)
    ledger_by_round_team = {
        (int(round_payload.get("round_number") or 0), str(ledger_team_id)): team_ledger
        for round_payload in ledger.get("rounds") or []
        for ledger_team_id, team_ledger in (round_payload.get("teams") or {}).items()
    }
    rows: list[dict] = []

    for index, round_obj in enumerate(rounds):
        round_number = _display_round(round_obj.get("roundNum"), index)
        if round_number in {1, 13}:
            player_credits = {str(player["puuid"]): 800.0 for player in players}
            credit_quality = {team_id: "rules_based" for team_id in team_ids}
        elif round_number >= 25:
            player_credits = {str(player["puuid"]): 5000.0 for player in players}
            credit_quality = {team_id: "rules_based" for team_id in team_ids}
        stats_by_team: dict[str, list[dict]] = {team_id: [] for team_id in team_ids}
        economy_by_player: dict[str, dict] = {}
        for stat in round_obj.get("playerStats") or []:
            puuid = str(stat.get("puuid"))
            team_id = player_team.get(puuid)
            economy = stat.get("economy")
            if team_id in stats_by_team and isinstance(economy, dict):
                stats_by_team[team_id].append({**economy, "_puuid": puuid})
                economy_by_player[puuid] = economy

        # Even unusable rounds must advance score/streak context for later rows.
        if any(len(stats_by_team[team_id]) < 3 for team_id in team_ids):
            _update_player_credit_estimates(
                round_obj, players, economy_by_player, streaks, player_team,
                player_credits, credit_quality,
            )
            _advance_round_context(round_obj, team_ids, scores, streaks)
            continue

        round_player_credits: dict[str, dict[str, float]] = {}
        round_credit_quality: dict[str, str] = {}
        for team_id in team_ids:
            values, quality = _round_player_credit_values(
                team_players[team_id],
                economy_by_player,
                player_credits,
                round_number,
            )
            round_player_credits[team_id] = values
            round_credit_quality[team_id] = quality if quality != "rules_based" else credit_quality[team_id]
        credits = {
            team_id: _credits_summary(list(round_player_credits[team_id].values()))
            for team_id in team_ids
        }
        credit_distributions = {
            team_id: list(round_player_credits[team_id].values())
            for team_id in team_ids
        }
        free_light_exceptions: dict[str, bool] = {}
        for team_id in team_ids:
            enemy_id = next(value for value in team_ids if value != team_id)
            tiers = [normalize_rank_tier(player.get("competitiveTier")) for player in team_players[team_id]]
            enemy_tiers = [normalize_rank_tier(player.get("competitiveTier")) for player in team_players[enemy_id]]
            valid_tiers = [tier for tier in tiers if tier is not None]
            valid_enemy_tiers = [tier for tier in enemy_tiers if tier is not None]
            avg_tier = sum(valid_tiers) / len(valid_tiers) if valid_tiers else 0
            median_tier = median(valid_tiers) if valid_tiers else 0
            enemy_avg_tier = sum(valid_enemy_tiers) / len(valid_enemy_tiers) if valid_enemy_tiers else 0
            rounded_tier = int(round(avg_tier)) if valid_tiers else None
            enemy_rounded_tier = int(round(enemy_avg_tier)) if valid_enemy_tiers else None
            observed_team_player_credits = {
                str(player["puuid"]): round_player_credits[team_id][str(player["puuid"])]
                for player in team_players[team_id]
            }
            observed_enemy_player_credits = {
                str(player["puuid"]): round_player_credits[enemy_id][str(player["puuid"])]
                for player in team_players[enemy_id]
            }
            map_id = str(match_info.get("mapId") or "UNKNOWN")
            side = _team_side(team_id, round_number, starting_attack_team)
            enemy_side = _opposite_side(side)
            team_ledger = ledger_by_round_team.get((round_number, team_id))
            enemy_ledger = ledger_by_round_team.get((round_number, enemy_id))
            previous_team_ledger = ledger_by_round_team.get((round_number - 1, team_id))
            previous_enemy_ledger = ledger_by_round_team.get((round_number - 1, enemy_id))
            team_observed_prebuy = _team_observed_prebuy(team_players[team_id], economy_by_player)
            enemy_observed_prebuy = _team_observed_prebuy(team_players[enemy_id], economy_by_player)
            team_rules_player_credits = _rules_player_credit_values(
                team_players[team_id],
                previous_team_ledger,
                player_credits,
                round_number,
            )
            enemy_rules_player_credits = _rules_player_credit_values(
                team_players[enemy_id],
                previous_enemy_ledger,
                player_credits,
                round_number,
            )
            team_rules_prebuy = sum(team_rules_player_credits.values())
            enemy_rules_prebuy = sum(enemy_rules_player_credits.values())
            team_quality_v7, team_quality_reason = _credit_estimate_quality_v9(
                team_observed_prebuy,
                team_rules_prebuy,
                round_credit_quality[team_id],
            )
            enemy_quality_v7, enemy_quality_reason = _credit_estimate_quality_v9(
                enemy_observed_prebuy,
                enemy_rules_prebuy,
                round_credit_quality[enemy_id],
            )
            force_rules_prebuy = fixed_round_start_credits(round_number) is not None
            team_selected_prebuy = _select_prebuy_credits(
                team_observed_prebuy,
                team_rules_prebuy,
                team_quality_v7,
                force_rules=force_rules_prebuy,
            )
            enemy_selected_prebuy = _select_prebuy_credits(
                enemy_observed_prebuy,
                enemy_rules_prebuy,
                enemy_quality_v7,
                force_rules=force_rules_prebuy,
            )
            team_player_credit_estimates = _selected_player_credit_values(
                observed_team_player_credits,
                team_rules_player_credits,
                team_observed_prebuy,
                team_quality_v7,
            )
            enemy_player_credit_estimates = _selected_player_credit_values(
                observed_enemy_player_credits,
                enemy_rules_player_credits,
                enemy_observed_prebuy,
                enemy_quality_v7,
            )
            own_credits = _credits_summary(list(team_player_credit_estimates.values()))
            enemy_credits = _credits_summary(list(enemy_player_credit_estimates.values()))
            own_credits["estimated_credits_before_buy"] = team_selected_prebuy
            enemy_credits["estimated_credits_before_buy"] = enemy_selected_prebuy
            team_economies_derived = [
                {
                    **economy,
                    "totalOutlay": max(
                        0.0,
                        _number(team_player_credit_estimates.get(str(economy.get("_puuid"))))
                        - _number(economy.get("remaining")),
                    ),
                }
                for economy in stats_by_team[team_id]
            ]
            enemy_economies_derived = [
                {
                    **economy,
                    "totalOutlay": max(
                        0.0,
                        _number(enemy_player_credit_estimates.get(str(economy.get("_puuid"))))
                        - _number(economy.get("remaining")),
                    ),
                }
                for economy in stats_by_team[enemy_id]
            ]
            if not free_light_exceptions:
                for economy in team_economies_derived + enemy_economies_derived:
                    puuid = str(economy.get("_puuid") or "")
                    if puuid:
                        free_light_exceptions[puuid] = infer_pistol_free_light_armor_from_economy(
                            round_number, economy,
                        )
            team_free_light_exceptions = {
                puuid: bool(free_light_exceptions.get(puuid))
                for puuid in team_player_credit_estimates
            }
            enemy_free_light_exceptions = {
                puuid: bool(free_light_exceptions.get(puuid))
                for puuid in enemy_player_credit_estimates
            }
            team_utility = summarize_team_agent_utility(
                team_players[team_id],
                side=side,
                estimated_credits=team_selected_prebuy,
                prefix="team",
            )
            enemy_utility = summarize_team_agent_utility(
                team_players[enemy_id],
                side=enemy_side,
                estimated_credits=enemy_selected_prebuy,
                prefix="enemy",
            )
            team_labels = classify_team_economy_labels(
                team_economies_derived,
                round_number=round_number,
                team_prebuy_credits=team_selected_prebuy,
                previous_round_context={"won": streaks[team_id]["previous_won"]},
                is_last_round_before_switch=round_number in {12, 24},
                is_overtime=round_number >= 25,
            )
            enemy_labels = classify_team_economy_labels(
                enemy_economies_derived,
                round_number=round_number,
                team_prebuy_credits=enemy_selected_prebuy,
                previous_round_context={"won": streaks[enemy_id]["previous_won"]},
                is_last_round_before_switch=round_number in {12, 24},
                is_overtime=round_number >= 25,
            )
            real_buy_action = str(team_labels["real_buy_action"])
            current_max_score = max((scores[value] for value in team_ids), default=0)
            case = classify_economy_case({
                "is_overtime": int(round_number >= 25),
                "is_match_point": int(current_max_score >= 12),
                "is_last_round_before_switch": int(round_number in {12, 24}),
                "is_bonus_candidate": int(round_number in {3, 15} and streaks[team_id]["win"] >= 2),
                "team_estimated_credits_before_buy": own_credits["estimated_credits_before_buy"],
                "team_players_can_full_buy_estimate": own_credits["players_can_full_buy_estimate"],
                "team_players_low_money": own_credits["players_low_money"],
            }, real_buy_action)
            row = {
                "match_id": str(match_info.get("matchId") or "UNKNOWN"),
                "game_start_millis": int(_number(match_info.get("gameStartMillis"))),
                "round_number": round_number, "team_id": team_id, "enemy_team_id": enemy_id,
                "map_id": map_id, "map_name": resolve_map_name(map_id),
                "season_id": str(match_info.get("seasonId") or "UNKNOWN"),
                "queue_id": str(match_info.get("queueId") or "UNKNOWN"),
                "is_ranked": int(bool(match_info.get("isRanked"))),
                "rank_tier_avg": avg_tier, "rank_tier_median": median_tier,
                "rank_name": get_rank_name(rounded_tier), "rank_group": get_rank_group(rounded_tier),
                "rank_name_mode": get_rank_name(rounded_tier), "rank_group_mode": get_rank_group(rounded_tier),
                "enemy_rank_tier_avg": enemy_avg_tier,
                "enemy_rank_group_mode": get_rank_group(enemy_rounded_tier),
                "side": side,
                "team_credit_estimate_quality": _ledger_credit_quality(round_credit_quality[team_id], team_ledger),
                "enemy_credit_estimate_quality": _ledger_credit_quality(round_credit_quality[enemy_id], enemy_ledger),
                "prebuy_credits_observed": team_observed_prebuy,
                "prebuy_credits_rules": team_rules_prebuy,
                "prebuy_credits_selected": team_selected_prebuy,
                "team_prebuy_credits_observed": team_observed_prebuy,
                "team_prebuy_credits_rules": team_rules_prebuy,
                "team_prebuy_credits_selected": team_selected_prebuy,
                "credit_estimate_quality": team_quality_v7,
                "credit_estimate_inconsistency_reason": team_quality_reason,
                "enemy_prebuy_credits_observed": enemy_observed_prebuy,
                "enemy_prebuy_credits_rules": enemy_rules_prebuy,
                "enemy_prebuy_credits_selected": enemy_selected_prebuy,
                "enemy_credit_estimate_inconsistency_reason": enemy_quality_reason,
                "team_score_before": scores[team_id], "enemy_score_before": scores[enemy_id],
                "score_diff": scores[team_id] - scores[enemy_id],
                "previous_round_won": int(bool(streaks[team_id]["previous_won"])),
                "win_streak": streaks[team_id]["win"], "loss_streak": streaks[team_id]["loss"],
                "enemy_win_streak": streaks[enemy_id]["win"], "enemy_loss_streak": streaks[enemy_id]["loss"],
                "is_pistol_round": int(round_number in {1, 13}), "is_second_round": int(round_number in {2, 14}),
                "is_bonus_candidate": int(round_number in {3, 15} and streaks[team_id]["win"] >= 2),
                "is_last_round_before_switch": int(round_number in {12, 24}),
                "is_match_point": int(current_max_score >= 12), "is_overtime": int(round_number >= 25),
                "team_estimated_credits_before_buy": team_selected_prebuy,
                "enemy_estimated_credits_before_buy": enemy_selected_prebuy,
                "credits_before_buy_diff": team_selected_prebuy - enemy_selected_prebuy,
                "team_players_can_full_buy_estimate": own_credits["players_can_full_buy_estimate"],
                "enemy_players_can_full_buy_estimate": enemy_credits["players_can_full_buy_estimate"],
                "team_players_low_money": own_credits["players_low_money"],
                "enemy_players_low_money": enemy_credits["players_low_money"],
                **_prefixed_credit_features("team", list(team_player_credit_estimates.values())),
                **_prefixed_credit_features("enemy", list(enemy_player_credit_estimates.values())),
                "pistol_free_light_armor_exception": int(any(team_free_light_exceptions.values())),
                "team_players_with_free_light_armor_exception": sum(team_free_light_exceptions.values()),
                "enemy_players_with_free_light_armor_exception": sum(enemy_free_light_exceptions.values()),
                "team_player_credit_estimates": team_player_credit_estimates,
                "enemy_player_credit_estimates": enemy_player_credit_estimates,
                "team_player_free_light_armor_exceptions": team_free_light_exceptions,
                "enemy_player_free_light_armor_exceptions": enemy_free_light_exceptions,
                "team_afk_bonus_inferred": (previous_team_ledger or {}).get("afk_bonus_inferred"),
                "enemy_afk_bonus_inferred": (previous_enemy_ledger or {}).get("afk_bonus_inferred"),
                **_ledger_reconciliation_features("team", previous_team_ledger),
                **_ledger_reconciliation_features("enemy", previous_enemy_ledger),
                "target_loadout_case": team_labels["target_loadout_case"],
                "cashflow_case": team_labels["cashflow_case"],
                "enemy_target_loadout_case": enemy_labels["target_loadout_case"],
                "enemy_cashflow_case": enemy_labels["cashflow_case"],
                "real_buy_action": real_buy_action,
                **case,
                "round_won": int(str(round_obj.get("winningTeam")) == team_id),
                "match_won": int(team_won_match.get(team_id, False)),
                **team_utility,
                **enemy_utility,
                **build_utility_diff_features(team_utility, enemy_utility),
                **observed_action_features(team_economies_derived),
            }
            rows.append(row)
        _update_player_credit_estimates(
            round_obj, players, economy_by_player, streaks, player_team,
            player_credits, credit_quality,
        )
        _advance_round_context(round_obj, team_ids, scores, streaks)
    return add_future_economy_labels(rows)
