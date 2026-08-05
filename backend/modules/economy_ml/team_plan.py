from __future__ import annotations

from typing import Any

from .action_profiles import simulate_action_features
from .ability_catalog import ability_costs_available
from .economy_action_labels import classify_cashflow_case, normalize_target_loadout_case
from .economy_cases import classify_economy_case
from .future_economy import simulate_next_round_economy
from .plan_coherence import evaluate_plan_coherence
from .plan_evaluator import evaluate_plan_value


BUY_CASE_BY_ACTION = {
    "ECO_CLASSIC": ("ECO", "ECO completa"),
    "ECO_PISTOL_UPGRADE": ("ECO", "ECO con pistolas"),
    "ECO_ONE_SHERIFF": ("ECO", "ECO con 1 Sheriff"),
    "ECO_TWO_SHERIFFS": ("ECO", "ECO con 2 Sheriffs"),
    "ECO_SHERIFF": ("ECO", "ECO con 2 Sheriffs"),
    "ECO_SHERIFF_STACK": ("ECO", "ECO agresiva con Sheriffs"),
    "SEMI_SMG": ("SEMIBUY", "Semibuy equilibrada"),
    "SEMI_MARSHAL": ("SEMIBUY", "Semibuy de castigo economica"),
    "MIXED_LOW_BUY": ("ESTABILIZACION", "Estabilizacion de economia"),
    "FORCE_OUTLAW": ("FORCE", "Force de castigo contra escudo ligero"),
    "FORCE_RIFLE_LIGHT": ("FORCE", "Force con rifle y escudo ligero"),
    "FORCE_2_RIFLES": ("FORCE", "Force con inversion concentrada"),
    "FULL_RIFLES": ("FULLBUY", "Full rifles con utilidad"),
    "FULL_OPERATOR": ("FULLBUY", "Full con sniper"),
    "BONUS_KEEP_WEAPONS": ("BONUS", "Bonus conservando armas"),
}

WEAPON_COST_ESTIMATES = {
    "operator": 4700,
    "outlaw": 2400,
    "marshal": 950,
    "rifle": 2900,
    "smg": 1600,
    "sheriff": 800,
}
ARMOR_COST_ESTIMATES = {"heavy": 1000, "regen": 650, "light": 400}


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _buy_case(action: str) -> tuple[str, str]:
    return BUY_CASE_BY_ACTION.get(action, ("SEMIBUY", "Compra mixta"))


def _estimate_weapon_cost(features: dict[str, Any]) -> float:
    cost = 0.0
    for key, unit_cost in WEAPON_COST_ESTIMATES.items():
        cost += _number(features.get(f"action_{key}_count")) * unit_cost
    return cost


def _estimate_armor_cost(features: dict[str, Any]) -> float:
    return (
        _number(features.get("action_heavy_armor_count")) * ARMOR_COST_ESTIMATES["heavy"]
        + _number(features.get("action_regen_armor_count")) * ARMOR_COST_ESTIMATES["regen"]
        + _number(features.get("action_light_armor_count")) * ARMOR_COST_ESTIMATES["light"]
    )


def _utility_budget(state: dict[str, Any], buy_case: str, credits: float) -> float:
    utility_score = _number(state.get("team_total_utility_score") or 0.5)
    low_economy = _number(state.get("team_low_economy_resilience") or 0.5)
    if buy_case == "ECO":
        cap = 1000 if low_economy >= 0.65 else 500
        ratio = 0.04 + max(0.0, utility_score - 0.5) * 0.08
    elif buy_case == "ESTABILIZACION":
        cap = 2200
        ratio = 0.08 + max(0.0, utility_score - 0.5) * 0.12
    elif buy_case == "SEMIBUY":
        cap = 2600
        ratio = 0.07 + max(0.0, utility_score - 0.5) * 0.10
    elif buy_case == "FULLBUY":
        cap = 4000
        ratio = 0.10 + max(0.0, utility_score - 0.5) * 0.12
    elif buy_case == "BONUS":
        cap = 2500
        ratio = 0.08 + max(0.0, utility_score - 0.5) * 0.10
    else:
        cap = 1800
        ratio = 0.06 + max(0.0, utility_score - 0.5) * 0.08
    return round(max(0.0, min(cap, credits * ratio)), 2)


def _next_round_fullbuy_probability(remaining: float, buy_case: str, state: dict[str, Any]) -> float:
    if state.get("is_last_round_before_switch") or state.get("is_match_point") or state.get("is_overtime"):
        return 0.0
    per_player = remaining / 5
    if per_player >= 3900:
        base = 0.85
    elif per_player >= 2900:
        base = 0.62
    elif per_player >= 1900:
        base = 0.38
    elif per_player >= 1000:
        base = 0.2
    else:
        base = 0.08
    if buy_case == "ESTABILIZACION":
        base += 0.08
    if buy_case == "FORCE":
        base -= 0.12
    return round(max(0.0, min(1.0, base)), 4)


def _coherence_penalty(
    action: str,
    buy_case: str,
    features: dict[str, Any],
    utility_spend: float,
    state: dict[str, Any],
    ability_budget_unknown: bool = False,
) -> tuple[float, list[str]]:
    penalty = 0.0
    reasons: list[str] = []
    rifles = _number(features.get("action_rifle_count"))
    snipers = _number(features.get("action_sniper_count"))
    heavy = _number(features.get("action_heavy_armor_count"))
    regen = _number(features.get("action_regen_armor_count"))
    light = _number(features.get("action_light_armor_count"))
    strong_weapons = rifles + snipers
    utility_score = _number(state.get("team_total_utility_score") or 0.5)

    if buy_case == "ECO" and strong_weapons >= 2:
        penalty += 0.35
        reasons.append("La estrategia ECO contradice una inversion alta en armas.")
    if buy_case == "FULLBUY" and (strong_weapons < 4 or heavy + regen < 4):
        penalty += 0.25
        reasons.append("La fullbuy queda incompleta en armas fuertes o armadura suficiente.")
    if buy_case == "FULLBUY" and regen > 0:
        penalty += min(0.2, regen * 0.04)
        reasons.append("Regen Shield en fullbuy se trata como downgrade frente a escudo pesado.")
    if buy_case in {"SEMIBUY", "ESTABILIZACION"} and strong_weapons >= 4:
        penalty += 0.18
        reasons.append("La compra parcial se parece demasiado a una fullbuy sin estabilidad clara.")
    if buy_case == "FORCE" and not (
        state.get("is_match_point") or state.get("is_last_round_before_switch") or state.get("is_overtime")
    ):
        penalty += 0.08
        reasons.append("La force necesita justificar el riesgo de economia futura.")
    if not ability_budget_unknown and utility_score >= 0.65 and utility_spend < 700 and buy_case not in {"ECO"}:
        penalty += 0.12
        reasons.append("La composicion tiene utilidad potencial, pero el plan reserva poca inversion para ella.")
    if not ability_budget_unknown and buy_case == "FULLBUY" and utility_spend < 1200:
        penalty += 0.1
        reasons.append("La fullbuy no contempla suficiente margen para utilidad clave.")
    if strong_weapons == 0 and heavy + regen + light >= 4 and buy_case not in {"ECO", "BONUS"}:
        penalty += 0.15
        reasons.append("El plan compra demasiado escudo sin armas minimas suficientes.")
    return round(min(1.0, penalty), 4), reasons


def evaluate_team_plan_from_action(
    state: dict[str, Any],
    action: str,
    estimated_match_win_probability: float | None = None,
    learned_profile: dict[str, float] | None = None,
) -> dict[str, Any]:
    features = simulate_action_features(state, action, learned_profile)
    case = classify_economy_case(state, action)
    buy_case, subtype = case["macro_buy_case"], case["economy_intent"]
    target_loadout_case = normalize_target_loadout_case(
        action,
        round_number=int(_number(state.get("round_number"))),
    )
    credits = _number(
        state.get("team_estimated_credits_before_buy")
        or state.get("team_prebuy_credits_selected")
        or state.get("prebuy_credits_selected")
    )
    base_spend = _number(features.get("action_total_spent"))
    weapon_spend = min(base_spend, _estimate_weapon_cost(features))
    armor_spend = min(max(0.0, base_spend - weapon_spend), _estimate_armor_cost(features))
    ability_unknown = not ability_costs_available()
    utility_spend = None if ability_unknown else min(max(0.0, credits - base_spend), _utility_budget(state, buy_case, credits))
    total_spend = min(credits, base_spend + _number(utility_spend))
    remaining = max(0.0, credits - total_spend)
    planned_cashflow = classify_cashflow_case(
        team_spent=total_spend,
        team_loadout=_number(features.get("action_total_loadout")),
        team_prebuy_credits=credits,
        target_loadout_case=target_loadout_case,
        is_last_round_before_switch=bool(state.get("is_last_round_before_switch")),
        is_overtime=bool(state.get("is_overtime")),
    )
    future = simulate_next_round_economy(state, {"expected_remaining": remaining})
    next_fullbuy = float(future.get("next_round_fullbuy_probability") or _next_round_fullbuy_probability(remaining, buy_case, state))
    coherence_penalty, coherence_reasons = _coherence_penalty(
        action, buy_case, features, _number(utility_spend), state, ability_unknown
    )
    utility_value = round(
        min(1.0, _number(state.get("team_total_utility_score") or 0.5) * (0.75 + _number(utility_spend) / 4000)),
        4,
    )
    economy_risk = round(1.0 - next_fullbuy, 4)
    if buy_case == "FORCE" and not state.get("is_match_point"):
        economy_risk = round(min(1.0, economy_risk + 0.12), 4)
    probability = estimated_match_win_probability if estimated_match_win_probability is not None else 0.0
    plan = {
        "macro_case": buy_case,
        "subtype": subtype,
        "target_loadout_case": target_loadout_case,
        "cashflow_case": planned_cashflow,
        "planned_cashflow_case": planned_cashflow,
        "observed_target_loadout_case": state.get("target_loadout_case"),
        "observed_cashflow_case": state.get("cashflow_case"),
        "round_context_case": case["round_context_case"],
        "team_total_budget": round(credits, 2),
        "estimated_total_spend": round(total_spend, 2),
        "estimated_weapon_spend": round(weapon_spend, 2),
        "estimated_armor_spend": round(armor_spend, 2),
        "estimated_regen_armor_spend": round(
            _number(features.get("action_regen_armor_count")) * ARMOR_COST_ESTIMATES["regen"],
            2,
        ),
        "action_regen_armor_count": int(_number(features.get("action_regen_armor_count"))),
        "estimated_ability_spend": None if ability_unknown else round(_number(utility_spend), 2),
        "expected_remaining": round(remaining, 2),
        "future_economy_score": next_fullbuy,
        "utility_value_score": utility_value,
        "weapon_value_score": round(_number(features.get("action_total_loadout")) / 23000, 4),
        "armor_value_score": round(armor_spend / 5000, 4),
        "economic_risk_score": economy_risk,
        "predicted_match_win": probability,
        "predicted_round_win": None,
        "next_round_fullbuy_probability": next_fullbuy,
        "warnings": coherence_reasons,
        "players": [],
        "ability_budget_unknown": ability_unknown,
        "ability_purchase_certainty": "estimated_plan_not_observed",
    }
    coherence = evaluate_plan_coherence(plan, state)
    plan.update(coherence)
    plan.update(evaluate_plan_value(plan, state))
    plan.update({
        "team_buy_case": buy_case,
        "team_buy_subtype": subtype,
        "source_action": action,
        "total_team_spend": round(total_spend, 2),
        "weapon_spend_estimate": round(weapon_spend, 2),
        "armor_spend_estimate": round(armor_spend, 2),
        "ability_spend_estimate": None if ability_unknown else round(_number(utility_spend), 2),
        "expected_remaining_after_buy": round(remaining, 2),
        "next_round_buy_probability": next_fullbuy,
        "team_utility_total_value": utility_value,
        "team_weapon_total_value": features.get("action_total_loadout"),
        "team_armor_total_value": round(armor_spend / 5000, 4),
        "team_economy_risk": economy_risk,
        "coherence_penalty": coherence_penalty,
        "coherence_warnings": plan["warnings"],
    })
    return plan
