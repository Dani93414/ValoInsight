from __future__ import annotations

from typing import Any, Iterable

from .recommendation_validation import player_recommendation_total_cost


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def summarize_recommendation_backtest(recommendations: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = list(recommendations)
    total_players = 0
    invalid = 0
    exceeds = 0
    with_abilities = 0
    no_utility_when_expected = 0
    sheriff_eco_pistol = 0
    eco_pistol = 0
    values = []
    action_counts: dict[str, int] = {}
    graded_rounds = 0
    score_total = 0.0
    legacy_spent_used = 0
    for row in rows:
        action = str(
            row.get("recommended_action")
            or row.get("recommended_team_buy")
            or (row.get("recommended_plan") or {}).get("team_buy")
            or ""
        )
        action_counts[action] = action_counts.get(action, 0) + 1
        macro = str((
            (row.get("team_plan") or {}).get("macro_case")
            or row.get("macro_case")
            or row.get("recommended_team_buy")
            or ""
        )).upper()
        if macro == "ECO" or row.get("is_pistol_round"):
            eco_pistol += 1
            if "SHERIFF" in action:
                sheriff_eco_pistol += 1
        value = (
            row.get("team_plan_value")
            if row.get("team_plan_value") is not None
            else (row.get("team_plan") or {}).get("team_plan_value")
        )
        if value is None:
            value = (row.get("economy_projection") or {}).get("team_plan_value")
        if value is not None:
            values.append(_number(value))
        if row.get("team_purchase_score") is not None:
            graded_rounds += 1
            score_total += _number(row.get("team_purchase_score"))
        if ((row.get("credit_reconstruction") or {}).get("legacy_spent_used")):
            legacy_spent_used += 1
        for player in (
            row.get("player_recommendations")
            or row.get("players")
            or (row.get("team_plan") or {}).get("players")
            or []
        ):
            total_players += 1
            recommendation = player.get("recommended_purchase") or player
            costs = player_recommendation_total_cost(recommendation)
            estimated = _number(player.get("estimated_credits") or player.get("credits_before_buy"))
            if costs["total_cost"] > estimated + 1e-6:
                invalid += 1
                exceeds += 1
            abilities = (
                recommendation.get("recommended_abilities")
                or recommendation.get("abilities")
                or []
            )
            if abilities:
                with_abilities += 1
            role = str(player.get("role") or "").lower()
            if role in {"controller", "initiator", "sentinel"} and not abilities:
                no_utility_when_expected += 1
    return {
        "total_recommendations": len(rows),
        "total_player_recommendations": total_players,
        "recommended_action_counts": action_counts,
        "invalid_recommendations": invalid,
        "invalid_recommendation_rate": round(invalid / total_players, 6) if total_players else 0.0,
        "recommendations_exceeding_credits": exceeds,
        "exceeds_credits_rate": round(exceeds / total_players, 6) if total_players else 0.0,
        "average_expected_team_plan_value": round(sum(values) / len(values), 6) if values else None,
        "recommendations_with_abilities": with_abilities,
        "ability_recommendation_rate": round(with_abilities / total_players, 6) if total_players else 0.0,
        "missing_utility_for_utility_roles": no_utility_when_expected,
        "sheriff_share_in_eco_or_pistol": round(sheriff_eco_pistol / eco_pistol, 6) if eco_pistol else 0.0,
        "graded_rounds": graded_rounds,
        "average_team_purchase_score": round(score_total / graded_rounds, 4) if graded_rounds else None,
        "legacy_spent_used_rounds": legacy_spent_used,
    }
