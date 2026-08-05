from __future__ import annotations

from typing import Any


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def simulate_match_value(
    projection: dict[str, Any],
    *,
    team_score: int,
    enemy_score: int,
    horizon: int = 8,
) -> dict[str, Any]:
    """Small auditable dynamic program over score and synchronized economy.

    It does not consume the realised round winner. The first-round probability
    comes from the candidate loadout; later probabilities regress toward 0.5
    according to the projected win/loss economy and synchronization.
    """
    first_probability = max(0.02, min(0.98, _number(projection.get("round_win_probability")) or 0.5))
    full_if_win = _number(projection.get("players_can_full_buy_if_win")) / 5.0
    full_if_loss = _number(projection.get("players_can_full_buy_if_loss")) / 5.0
    synchronization = _number(projection.get("synchronization"))
    risk = _number(projection.get("economic_risk"))
    terminal = 13
    states: dict[tuple[int, int], float] = {(int(team_score), int(enemy_score)): 1.0}
    for step in range(max(1, horizon)):
        advanced: dict[tuple[int, int], float] = {}
        for (own, enemy), mass in states.items():
            if own >= terminal or enemy >= terminal:
                advanced[(own, enemy)] = advanced.get((own, enemy), 0.0) + mass
                continue
            if step == 0:
                probability = first_probability
            else:
                economy_edge = (full_if_win - full_if_loss) * 0.08
                probability = max(
                    0.2,
                    min(0.8, 0.5 + economy_edge + (synchronization - 0.5) * 0.06 - risk * 0.04),
                )
            advanced[(own + 1, enemy)] = advanced.get((own + 1, enemy), 0.0) + mass * probability
            advanced[(own, enemy + 1)] = advanced.get((own, enemy + 1), 0.0) + mass * (1.0 - probability)
        states = advanced
    resolved_win = sum(mass for (own, enemy), mass in states.items() if own >= terminal and own > enemy)
    unresolved = [(own, enemy, mass) for (own, enemy), mass in states.items() if own < terminal and enemy < terminal]
    continuation = sum(
        mass * max(0.02, min(0.98, 0.5 + (own - enemy) * 0.055))
        for own, enemy, mass in unresolved
    )
    probability = max(0.02, min(0.98, resolved_win + continuation))
    uncertainty_penalty = min(0.08, risk * 0.04 + max(0.0, 0.5 - synchronization) * 0.04)
    return {
        "match_win_probability": round(probability, 6),
        "risk_adjusted_match_value": round(max(0.0, probability - uncertainty_penalty), 6),
        "horizon_rounds": max(1, horizon),
        "uncertainty_penalty": round(uncertainty_penalty, 6),
        "method": "score_economy_dynamic_program_v1",
    }
