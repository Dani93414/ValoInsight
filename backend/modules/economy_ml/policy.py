from __future__ import annotations

from typing import Any

import pandas as pd

from .action_profiles import minimum_action_credits, simulate_action_features
from .buy_classifier import BUY_ACTIONS
from .config import MIN_PROPENSITY
from .economy_rules import is_pistol_round, pistol_action_guardrail
from .economy_cases import classify_economy_case
from .model_registry import load_model_candidates
from .plan_allocator import allocate_player_loadouts
from .schemas import MODEL_FEATURES, PROPENSITY_FEATURES
from .team_plan import evaluate_team_plan_from_action

MIN_RECOMMENDATION_MARGIN = 0.04
PISTOL_SHERIFF_MIN_MARGIN = 0.08
DEFAULT_CASE_MARGINS = {
    "normal": 0.04, "eco": 0.08, "pistol": 0.10, "bonus": 0.08,
    "stabilization": 0.06, "match_point_or_overtime": 0.12,
}


def recommendation_status(num_viable_alternatives: int, chosen_eq_real: bool, delta_team_plan_value: float) -> str:
    if num_viable_alternatives == 0:
        return "no_supported_counterfactual"
    if num_viable_alternatives == 1 and chosen_eq_real:
        return "only_one_viable_action"
    if chosen_eq_real and abs(delta_team_plan_value) < 1e-6:
        return "matched_real"
    return "actionable_recommendation"


def _credit_quality_adjustment(state: dict) -> tuple[float, str | None]:
    quality = str(state.get("credit_estimate_quality") or state.get("team_credit_estimate_quality") or "")
    if quality == "inconsistent":
        reason = str(state.get("credit_estimate_inconsistency_reason") or "credit_estimate_inconsistent")
        return 0.55, f"Calidad de creditos inconsistente: {reason}"
    if quality in {"rules_only", "observed_with_reconciliation_warnings"}:
        return 0.8, "Creditos estimados por reglas/reconciliacion; menor confianza"
    return 1.0, None


def _availability(action: str, state: dict, bundle: dict) -> tuple[bool, str | None, int]:
    allowed, pistol_reason = pistol_action_guardrail(action, state)
    credits = float(state.get("team_estimated_credits_before_buy") or 0)
    minimum = minimum_action_credits(action)
    support = int(bundle.get("action_support", {}).get(action, 0))
    required_support = int(bundle.get("min_action_support", 25))
    if not allowed:
        return False, pistol_reason, support
    if credits < minimum:
        return False, f"Créditos estimados insuficientes ({credits:.0f} < {minimum:.0f})", support
    if action == "BONUS_KEEP_WEAPONS" and not state.get("is_bonus_candidate"):
        return False, "No es una ronda bonus candidata", support
    required_full_buyers = {
        "FORCE_2_RIFLES": 2, "FULL_RIFLES": 4, "FULL_OPERATOR": 4,
    }.get(action, 0)
    if int(state.get("team_players_can_full_buy_estimate") or 0) < required_full_buyers:
        return False, "La distribución estimada de créditos no permite equipar al equipo", support
    if support < required_support:
        return False, f"Soporte histórico insuficiente ({support} < {required_support})", support
    propensity = bundle.get("propensity_pipeline")
    if propensity is not None:
        probabilities = propensity.predict_proba(pd.DataFrame([{key: state.get(key) for key in PROPENSITY_FEATURES}]))[0]
        classes = list(propensity.named_steps["model"].classes_)
        probability = float(probabilities[classes.index(action)]) if action in classes else 0.0
        if probability < MIN_PROPENSITY:
            return False, f"Acción fuera de soporte para este estado ({probability:.1%})", support
    return True, None, support


def _eco_sheriff_guardrail(action: str, state: dict, team_plan: dict) -> tuple[bool, str | None]:
    sheriff_actions = {
        "ECO_SHERIFF", "ECO_ONE_SHERIFF", "ECO_TWO_SHERIFFS", "ECO_SHERIFF_STACK",
    }
    if action not in sheriff_actions:
        return True, None
    if state.get("is_match_point") or state.get("is_last_round_before_switch") or state.get("is_overtime"):
        return True, None

    future = float(team_plan.get("future_economy_score") or 0)
    round_win = float(team_plan.get("predicted_round_win") or 0)
    credits = float(state.get("team_estimated_credits_before_buy") or 0)

    if action == "ECO_SHERIFF_STACK":
        return False, "Stack de Sheriffs bloqueado fuera de rondas limite"
    if credits < 7000 and action in {"ECO_TWO_SHERIFFS", "ECO_SHERIFF"}:
        return False, "Eco con varias Sheriffs bloqueada: creditos bajos y prioridad de ahorro"
    if future < 0.55 and round_win < 0.38 and action in {"ECO_TWO_SHERIFFS", "ECO_SHERIFF"}:
        return False, "Eco Sheriff bloqueada: bajo beneficio inmediato y mala economia futura"
    return True, None


def _predict_probability(bundle: dict, scenario: dict, model_key: str = "match_win_model") -> float | None:
    model_bundle = (bundle.get("models") or {}).get(model_key)
    if model_bundle is None:
        if model_key != "match_win_model":
            return None
        model_bundle = bundle
    raw = float(model_bundle["pipeline"].predict_proba(pd.DataFrame([scenario]))[0, 1])
    calibrator = model_bundle.get("calibrator")
    if calibrator is None:
        return raw
    if hasattr(calibrator, "predict_proba"):
        return float(calibrator.predict_proba([[raw]])[0, 1])
    return float(calibrator.predict([raw])[0])


def _bundle_quality(bundle: dict) -> tuple[bool, float]:
    metrics = bundle.get("metrics") or {}
    primary = metrics.get("match_win_model") or metrics
    test_matches = int(bundle.get("test_matches") or bundle.get("dataset_quality", {}).get("test_matches") or 0)
    logloss = primary.get("log_loss")
    brier = primary.get("brier_score")
    ece = primary.get("expected_calibration_error")
    if test_matches and test_matches < 5:
        return False, float("-inf")
    if any(value is None for value in (logloss, brier, ece)):
        return True, -1.0
    return True, -(float(logloss) + float(brier) + float(ece))


def _policy_gate(bundle: dict) -> tuple[bool, str | None]:
    """Keep predictive models from becoming recommenders without OPE evidence."""
    if bundle.get("deployment_policy_enabled") is False:
        return False, "El modelo esta desplegado solo para prediccion; se mantienen las reglas."
    if bundle.get("experimental_policy_override") is True:
        return True, None
    evaluation = (bundle.get("metrics") or {}).get("policy_evaluation")
    if not evaluation:
        # Small synthetic/test bundles and old rule-only integrations do not
        # claim causal validation; their local confidence guardrails still run.
        return True, None
    interval = evaluation.get("improvement_confidence_interval_95") or []
    if len(interval) != 2 or float(interval[0]) <= 0:
        return False, "La politica ML no mejora al solver con confianza estadistica; se mantienen las reglas."
    return True, None


def _utility_explanations(state: dict) -> list[str]:
    explanations: list[str] = []
    utility = float(state.get("team_total_utility_score") or 0)
    utility_diff = float(state.get("utility_score_diff") or 0)
    low_resilience = float(state.get("team_low_economy_resilience") or 0)
    weapon_dependency = float(state.get("team_weapon_dependency_score") or 0)
    if utility >= 0.68:
        explanations.append(
            "La composicion aliada tiene alta utilidad potencial pre-ronda; no se asume compra real de habilidades."
        )
    if utility_diff >= 0.12:
        explanations.append("La composicion aliada muestra ventaja de utilidad potencial frente al rival.")
    if low_resilience >= 0.68:
        explanations.append("El equipo conserva valor potencial incluso con economia baja por su perfil de utilidad.")
    if weapon_dependency >= 0.62:
        explanations.append("La composicion depende mas del impacto con arma, lo que puede favorecer compras mas fuertes.")
    return explanations


def _recommend_with_bundle(
    state: dict,
    actions: list[str],
    bundle: dict,
    scope: str,
    match: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    alternatives = []
    action_profiles = bundle.get("action_profiles") or {}
    for action in actions:
        viable, reason, support = _availability(action, state, bundle)
        probability = None
        team_plan = None
        round_probability = None
        fullbuy_probability = None
        if viable:
            scenario = {feature: state.get(feature) for feature in MODEL_FEATURES}
            learned_profile = action_profiles.get(action)
            scenario.update(simulate_action_features(state, action, learned_profile))
            scenario["buy_action"] = action
            scenario.update(classify_economy_case(state, action))
            policy_model_key = (
                "policy_match_win_model"
                if (
                    "policy_match_win_model" in (bundle.get("models") or {})
                    and (
                        bool((bundle.get("policy_config") or {}).get("selected"))
                        or bundle.get("experimental_policy_override") is True
                    )
                    and bundle.get("deployment_policy_enabled", True) is not False
                )
                else "match_win_model"
            )
            probability = _predict_probability(bundle, scenario, policy_model_key)
            round_probability = _predict_probability(bundle, scenario, "round_win_model")
            fullbuy_probability = _predict_probability(bundle, scenario, "fullbuy_next_round_model")
            team_plan = (
                evaluate_team_plan_from_action(
                    state, action, probability, learned_profile=learned_profile,
                )
                if learned_profile is not None
                else evaluate_team_plan_from_action(state, action, probability)
            )
            if round_probability is not None:
                team_plan["predicted_round_win"] = round_probability
            if fullbuy_probability is not None:
                team_plan["next_round_fullbuy_probability"] = fullbuy_probability
                team_plan["future_economy_score"] = fullbuy_probability
            from .plan_evaluator import evaluate_plan_value
            team_plan.update(evaluate_plan_value(team_plan, state))
            viable, guardrail_reason = _eco_sheriff_guardrail(action, state, team_plan)
            if not viable:
                reason = guardrail_reason
            if viable and match is not None:
                allocation = allocate_player_loadouts(match, state, action)
                team_plan["allocation"] = allocation
                if not allocation.get("valid"):
                    viable = False
                    reason = "; ".join(allocation.get("violations") or ["Asignacion individual no viable"])
        alternatives.append({
            "action": action, "estimated_match_win_probability": probability,
            "estimated_round_win_probability": round_probability,
            "estimated_fullbuy_next_round_probability": fullbuy_probability,
            "is_available": viable, "reason_if_unavailable": reason, "historical_support": support,
            "team_plan": team_plan,
        })
    viable = [item for item in alternatives if item["is_available"]]
    if not viable:
        return None
    best = max(viable, key=lambda item: item["team_plan"]["team_plan_value"])
    ordered = sorted(viable, key=lambda item: item["team_plan"]["team_plan_value"], reverse=True)
    margin = (
        ordered[0]["team_plan"]["team_plan_value"] - ordered[1]["team_plan"]["team_plan_value"]
        if len(ordered) > 1 else 0.0
    )
    pistol_conservative_reason = None
    if is_pistol_round(state) and best["action"] == "ECO_ONE_SHERIFF" and margin < PISTOL_SHERIFF_MIN_MARGIN:
        fallback = next(
            (
                item
                for preferred in ("ECO_PISTOL_UPGRADE", "ECO_CLASSIC")
                for item in ordered
                if item["action"] == preferred
            ),
            None,
        )
        if fallback is not None:
            best = fallback
            competitors = [item for item in viable if item is not best]
            margin = (
                best["team_plan"]["team_plan_value"]
                - max(item["team_plan"]["team_plan_value"] for item in competitors)
                if competitors else 0.0
            )
            pistol_conservative_reason = (
                "Sheriff en pistol requiere margen alto; se elige alternativa conservadora."
            )
    support_factor = min(1.0, best["historical_support"] / 200)
    real_action = str(state.get("real_buy_action") or "")
    real_alternative = next((item for item in viable if item["action"] == real_action), None)
    real_plan = real_alternative.get("team_plan") if real_alternative else None
    best_plan = best["team_plan"] or {}
    delta_team_plan_value = (
        float(best_plan.get("team_plan_value") or 0)
        - float((real_plan or {}).get("team_plan_value") or 0)
        if real_plan is not None else None
    )
    delta_round_win = (
        float(best_plan.get("predicted_round_win") or 0)
        - float((real_plan or {}).get("predicted_round_win") or 0)
        if real_plan is not None
        and best_plan.get("predicted_round_win") is not None
        and real_plan.get("predicted_round_win") is not None
        else None
    )
    delta_next_fullbuy = (
        float(best_plan.get("next_round_fullbuy_probability") or 0)
        - float((real_plan or {}).get("next_round_fullbuy_probability") or 0)
        if real_plan is not None
        and best_plan.get("next_round_fullbuy_probability") is not None
        and real_plan.get("next_round_fullbuy_probability") is not None
        else None
    )
    status = recommendation_status(
        len(viable),
        best["action"] == real_action,
        float(delta_team_plan_value or 0.0),
    )
    credit_quality_factor, credit_quality_reason = _credit_quality_adjustment(state)
    confidence = min(1.0, margin * 4) * support_factor * credit_quality_factor
    policy_config = bundle.get("policy_config") or {}
    case_margins = policy_config.get("case_margins") or DEFAULT_CASE_MARGINS
    plan_context = str(best_plan.get("plan_value_context") or "normal")
    required_margin = float(case_margins.get(plan_context, MIN_RECOMMENDATION_MARGIN))
    disabled_case = bool(state.get("is_overtime")) or (
        plan_context in set(policy_config.get("disabled_cases") or [])
    )
    allowed_cases = policy_config.get("allowed_cases")
    allowed_actions = policy_config.get("allowed_actions")
    outside_selected_scope = (
        allowed_cases is not None and plan_context not in set(allowed_cases)
    ) or (
        allowed_actions is not None and best["action"] not in set(allowed_actions)
    )
    if credit_quality_reason is not None and credit_quality_factor < 0.7:
        strength = "low"
        low_confidence_reason = credit_quality_reason
    elif disabled_case or outside_selected_scope:
        strength = "low"
        low_confidence_reason = "La politica ML se abstiene en esta casuistica economica."
    elif margin < required_margin:
        strength = "low"
        low_confidence_reason = (
            f"Margen insuficiente entre alternativas ({margin:.3f} < {required_margin:.3f})"
        )
    elif confidence >= 0.6:
        strength = "high"
        low_confidence_reason = None
    else:
        strength = "medium"
        low_confidence_reason = None
    policy_gate_passed, policy_gate_reason = _policy_gate(bundle)
    actionable = strength != "low" and credit_quality_factor >= 0.7 and policy_gate_passed
    if not actionable:
        status = "abstained_low_confidence"
    return {
        "available": True, "guidance_enabled": actionable,
        "experimental_policy": bool(bundle.get("experimental_policy_override")),
        "policy_validation_passed": not bool(bundle.get("experimental_policy_override")),
        "policy_gate_passed": policy_gate_passed,
        "recommended_action": best["action"],
        "candidate_action": best["action"], "model_scope": scope,
        "confidence": float(confidence), "confidence_kind": "support_adjusted_margin",
        "recommendation_margin": float(margin),
        "required_recommendation_margin": required_margin,
        "policy_case": plan_context,
        "support_factor": float(support_factor),
        "credit_quality_factor": float(credit_quality_factor),
        "recommendation_status": status,
        "num_viable_alternatives": len(viable),
        "delta_team_plan_value": delta_team_plan_value,
        "delta_round_win": delta_round_win,
        "delta_next_fullbuy": delta_next_fullbuy,
        "support_count_best_action": best["historical_support"],
        "credit_estimate_quality": state.get("credit_estimate_quality") or state.get("team_credit_estimate_quality"),
        "recommendation_strength": strength,
        "low_confidence_reason": low_confidence_reason or policy_gate_reason,
        "estimated_match_win_probability": best["estimated_match_win_probability"],
        "team_plan": best["team_plan"],
        "alternatives": alternatives,
        "explanation": [
            f"Recomendación observacional calibrada con modelo {scope}; no constituye una garantía causal ni una acción óptima demostrada.",
            f"La acción recomendada tiene {best['historical_support']} observaciones de soporte en entrenamiento.",
            "Cada alternativa se evaluo como plan de equipo: armas, escudos, utilidad potencial, ahorro y riesgo futuro.",
            "La compra de habilidades se modela como inversion potencial; no se afirma que esas habilidades se compraran historicamente.",
            "La eleccion final usa team_plan_value, no solo la probabilidad estimada de ganar partida.",
            *( [credit_quality_reason] if credit_quality_reason else [] ),
            *( [pistol_conservative_reason] if pistol_conservative_reason else [] ),
            *_utility_explanations(state),
        ],
        "limitations": [
            "Modelo observacional: no prueba causalidad.",
            "Compra historica de habilidades no observable salvo dato explicito verificable.",
            *( ["La estimación de créditos de esta ronda no es exacta; revisa la reconstrucción de créditos y equipamiento."] if credit_quality_reason else [] ),
        ],
    }


def recommend_economy_action(
    state: dict,
    available_actions: list[str] | None = None,
    match: dict[str, Any] | None = None,
    model_candidates: list[tuple[dict, str]] | None = None,
) -> dict[str, Any]:
    candidates = (model_candidates if model_candidates is not None else
                  load_model_candidates(state.get("rank_name"), state.get("rank_group")))
    if not candidates:
        return {"available": False, "reason": "No hay modelo compatible entrenado todavía"}
    actions = available_actions or [action for action in BUY_ACTIONS if action != "UNKNOWN"]
    ranked = sorted(candidates, key=lambda item: _bundle_quality(item[0])[1], reverse=True)
    for bundle, scope in ranked:
        if not _bundle_quality(bundle)[0]:
            continue
        recommendation = _recommend_with_bundle(state, actions, bundle, scope, match=match)
        if recommendation:
            return recommendation
    return {
        "available": False,
        "reason": "No hay acciones con economía y soporte histórico suficientes en ningún scope",
    }
