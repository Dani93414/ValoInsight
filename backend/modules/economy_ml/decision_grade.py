from __future__ import annotations

from math import factorial
from typing import Any

from .content_catalog import find_gear, find_weapon
from .display_normalizer import (
    compact_catalog_item,
    compact_purchase_for_api,
    normalize_purchase_for_display,
)
from .ability_purchase_inference import infer_ability_purchase_combinations
from .economy_ruleset_registry import ruleset_provenance
from .inventory import PlayerInventoryState
from .match_economy_simulator import simulate_match_value
from .team_buy_solver import BuyScorer, TeamBuySolver


ECONOMY_CONTRACT_VERSION = 12
ENGINE_VERSION = "player_first_v12_decision_grade"


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _percentile_10(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * 0.10
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def grade_label(score: float) -> str:
    if score >= 95:
        return "Excelente"
    if score >= 85:
        return "Muy buena"
    if score >= 70:
        return "Correcta"
    if score >= 50:
        return "Mejorable"
    return "Mala"


def _score(q_actual: float, q_best: float, q_floor: float) -> float:
    # Do not amplify a sub-percentage-point difference into a catastrophic
    # grade just because the sampled legal alternatives are very similar.
    denominator = max(0.10, q_best - q_floor)
    if denominator <= 1e-9:
        return 100.0 if q_actual >= q_best - 1e-9 else 0.0
    effective_floor = q_best - denominator
    return round(100.0 * _clamp((q_actual - effective_floor) / denominator), 1)


def _item_cost(item: dict[str, Any] | None) -> float:
    return _number((item or {}).get("cost"))


def _plan_player_summary(player: dict[str, Any]) -> dict[str, Any]:
    return {
        "puuid": player.get("puuid"),
        "weapon": (player.get("weapon") or {}).get("displayName"),
        "armor": (player.get("armor") or {}).get("displayName"),
        "weapon_source": player.get("weapon_source"),
        "armor_source": player.get("armor_source"),
        "total_outlay": player.get("total_outlay", player.get("self_cost")),
        "ability_cost": player.get("ability_cost"),
        "expected_remaining": player.get("expected_remaining"),
    }


def _purchase_signature(player: dict[str, Any]) -> tuple[Any, ...]:
    purchased_abilities = tuple(sorted(
        (
            str(item.get("name") or "").lower(),
            int(_number(item.get("charges"))),
            str(item.get("source") or ""),
        )
        for item in player.get("abilities") or []
        if str(item.get("source") or "") not in {
            "free_round_start", "carried", "carried_and_free",
        }
    ))
    return (
        str((player.get("weapon") or {}).get("displayName") or "").lower(),
        str((player.get("armor") or {}).get("displayName") or "").lower(),
        purchased_abilities,
        round(_number(player.get("expected_remaining")), 2),
    )


def _public_purchase(player: dict[str, Any], *, is_pistol_round: bool) -> dict[str, Any]:
    purchase = compact_purchase_for_api(player)
    purchase["display"] = normalize_purchase_for_display(
        purchase, is_pistol_round=is_pistol_round,
    )
    return purchase


def _actual_player_plan(
    inventory: PlayerInventoryState,
    observed: dict[str, Any],
    hypotheses: list[dict[str, Any]],
    agent: str | None,
) -> dict[str, Any]:
    weapon = compact_catalog_item(find_weapon(observed.get("weapon")))
    armor = compact_catalog_item(find_gear(observed.get("armor")))
    loadout = _number(observed.get("loadoutValue"))
    weapon_value = _item_cost(weapon)
    armor_value = _item_cost(armor)
    utility_inventory_value = max(0.0, loadout - weapon_value - armor_value)
    remaining_raw = observed.get("remaining")
    remaining = _number(remaining_raw)
    total_outlay = (
        max(0.0, inventory.credits_before_buy - remaining)
        if remaining_raw is not None else None
    )
    best = hypotheses[0] if hypotheses else {}
    known_gear_spend = 0.0
    if best.get("weapon_source") == "bought_self":
        known_gear_spend += weapon_value
    if best.get("armor_source") == "bought_self":
        known_gear_spend += armor_value
    # loadoutValue values the inventory; it may include free signature utility
    # and therefore cannot be used directly as a purchase receipt.
    utility_purchase_value = (
        min(
            utility_inventory_value,
            max(0.0, _number(total_outlay) - known_gear_spend),
        )
        if total_outlay is not None else utility_inventory_value
    )
    return {
        "puuid": inventory.puuid,
        "weapon": weapon,
        "armor": armor,
        "abilities": [],
        "keep_weapon": best.get("weapon_source") == "carried",
        "keep_armor": best.get("armor_source") == "carried",
        "weapon_source": best.get("weapon_source") or "unknown",
        "armor_source": best.get("armor_source") or "unknown",
        "weapon_value": weapon_value,
        "armor_value": armor_value,
        "ability_cost": utility_purchase_value,
        "self_cost": total_outlay or 0.0,
        "expected_remaining": remaining,
        "total_outlay": total_outlay,
        "utility_inventory_value": utility_inventory_value,
        "probable_utility_purchase_value": utility_purchase_value,
        "ability_purchase_inference": infer_ability_purchase_combinations(
            agent, utility_purchase_value,
        ),
        "loadout_value": loadout,
        "purchase_hypotheses": hypotheses,
        "provenance": {
            "remaining": "observed",
            "loadout_value": "observed",
            "weapon": "observed",
            "armor": "observed",
            "total_outlay": "derived_from_reconstructed_prebuy_minus_remaining",
            "utility_inventory_value": "derived_residual_not_purchase_spend",
            "probable_utility_purchase_value": "bounded_by_reconstructed_outlay",
            "weapon_source": "inferred",
        },
    }


def _confidence_payload(hypotheses: list[dict[str, Any]], score: float) -> dict[str, Any]:
    confidence = _clamp(_number((hypotheses or [{}])[0].get("confidence")), 0.1, 1.0)
    ambiguity = len([item for item in hypotheses if _number(item.get("confidence")) >= 0.2])
    half_width = 2.0 if confidence >= 0.8 and ambiguity <= 1 else 4.0 if confidence >= 0.65 else 8.0
    low = round(max(0.0, score - half_width), 1)
    high = round(min(100.0, score + half_width), 1)
    return {
        "score_confidence": round(confidence, 4),
        "score_range": [score, score] if high - low <= 5 else [low, high],
        "score_is_single_value": high - low <= 5,
        "ambiguity_reason": None if high - low <= 5 else "Hay varias reconstrucciones compatibles con los datos observados.",
    }


def _shapley_regret(weights: dict[str, float], total_regret: float) -> dict[str, float]:
    players = list(weights)
    if not players or total_regret <= 0:
        return {player: 0.0 for player in players}
    total_weight = sum(weights.values())
    if total_weight <= 1e-12:
        # Pure coordination regret: no unilateral substitution explains the
        # gap, so attribute it equally instead of silently losing 90% of it.
        share = round(total_regret / len(players), 6)
        return {player: share for player in players}

    def value(coalition: set[str]) -> float:
        covered = sum(weights[player] for player in coalition) / total_weight
        coordination = 0.1 if len(coalition) == len(players) else 0.0
        return total_regret * min(1.0, covered * 0.9 + coordination)

    n = len(players)
    result = {player: 0.0 for player in players}
    for player in players:
        others = [item for item in players if item != player]
        for mask in range(1 << len(others)):
            coalition = {others[index] for index in range(len(others)) if mask & (1 << index)}
            size = len(coalition)
            coefficient = factorial(size) * factorial(n - size - 1) / factorial(n)
            result[player] += coefficient * (value(coalition | {player}) - value(coalition))
    return {player: round(value, 6) for player, value in result.items()}


def enrich_round_with_v12(
    payload: dict[str, Any],
    *,
    inventories: list[PlayerInventoryState],
    observed: dict[str, dict[str, Any]],
    inferred: dict[str, list[dict[str, Any]]],
    plan: dict[str, Any],
    context: dict[str, Any],
) -> dict[str, Any]:
    actual_players = [
        _actual_player_plan(
            inventory,
            observed.get(inventory.puuid) or {},
            inferred.get(inventory.puuid) or [],
            next(
                (
                    str(player.get("agent") or "")
                    for player in payload.get("players") or []
                    if str(player.get("puuid")) == inventory.puuid
                ),
                None,
            ),
        )
        for inventory in inventories
    ]
    actual_projection = BuyScorer().score(actual_players, context)
    score_before = payload.get("score_before") or {}
    team_rounds_won = int(_number(score_before.get("team")))
    enemy_rounds_won = int(_number(score_before.get("enemy")))
    actual_simulation = simulate_match_value(
        actual_projection, team_score=team_rounds_won, enemy_score=enemy_rounds_won,
    )
    recommended_simulation = simulate_match_value(
        plan.get("economy_projection") or {},
        team_score=team_rounds_won, enemy_score=enemy_rounds_won,
    )
    alternative_simulations = [
        simulate_match_value(
            item.get("economy_projection") or {},
            team_score=team_rounds_won,
            enemy_score=enemy_rounds_won,
        )
        for item in plan.get("alternatives") or []
        if item.get("valid", True)
    ]
    q_actual = _number(actual_simulation.get("risk_adjusted_match_value"))
    candidate_q_best = _number(recommended_simulation.get("risk_adjusted_match_value"))
    legal_values = [candidate_q_best] + [
        _number(item.get("risk_adjusted_match_value"))
        for item in alternative_simulations
    ]
    team_hypotheses = [item for values in inferred.values() for item in values]
    inference_confidence = _clamp(
        min((_number(item.get("confidence")) for item in team_hypotheses), default=.1),
        .1, 1.0,
    )
    projection = plan.get("economy_projection") or {}
    evidence_confidence = _clamp(min(
        inference_confidence,
        _number(projection.get("data_confidence") or .2),
        _number(projection.get("confidence") or .2),
    ), .1, 1.0)
    team_equivalence_margin = max(.005, (1.0 - evidence_confidence) * .04)
    candidate_value_gap = max(0.0, candidate_q_best - q_actual)
    team_equivalent = candidate_value_gap <= team_equivalence_margin
    q_best = q_actual if team_equivalent else candidate_q_best
    q_floor = _percentile_10(legal_values)
    team_purchase_score = _score(q_actual, q_best, q_floor)
    team_confidence = _confidence_payload(team_hypotheses, team_purchase_score)

    recommended_by_player = {
        str(item.get("puuid")): item for item in plan.get("players") or []
    }
    candidate_options: dict[str, list[dict[str, Any]]] = {
        item["puuid"]: [item] for item in actual_players
    }
    for team_plan in [plan, *(plan.get("alternatives") or [])]:
        if not team_plan.get("valid", True):
            continue
        for option in team_plan.get("players") or []:
            puuid = str(option.get("puuid"))
            if puuid not in candidate_options:
                continue
            if all(
                _purchase_signature(existing) != _purchase_signature(option)
                for existing in candidate_options[puuid]
            ):
                candidate_options[puuid].append(option)

    individual_results: dict[str, dict[str, Any]] = {}
    gaps: dict[str, float] = {}
    scorer = BuyScorer()
    for actual in actual_players:
        puuid = actual["puuid"]
        evaluated: list[tuple[float, dict[str, Any]]] = []
        for option in candidate_options.get(puuid) or [actual]:
            substituted = [
                option if item["puuid"] == puuid else item
                for item in actual_players
            ]
            projection = scorer.score(substituted, context)
            simulation = simulate_match_value(
                projection,
                team_score=team_rounds_won, enemy_score=enemy_rounds_won,
            )
            evaluated.append((
                _number(simulation.get("risk_adjusted_match_value")), option,
            ))
        actual_value = next(
            (value for value, option in evaluated if option is actual), q_actual,
        )
        best_value, best_option = max(evaluated, key=lambda item: item[0])
        player_inference_confidence = _clamp(
            _number((inferred.get(puuid) or [{}])[0].get("confidence")), .1, 1.0,
        )
        player_evidence_confidence = min(player_inference_confidence, evidence_confidence)
        equivalence_margin = max(.005, (1.0 - player_evidence_confidence) * .04)
        equivalent = best_value - actual_value <= equivalence_margin
        if equivalent:
            best_value, best_option = actual_value, actual
        individual_results[puuid] = {
            "q_actual": actual_value,
            "q_best": best_value,
            "q_floor": _percentile_10([value for value, _option in evaluated]),
            "best_option": best_option,
            "equivalent": equivalent,
        }
        gaps[puuid] = max(0.0, best_value - actual_value)
    total_regret = max(0.0, q_best - q_actual)
    shapley = _shapley_regret(gaps, total_regret)

    actual_by_player = {item["puuid"]: item for item in actual_players}
    for player in payload.get("players") or []:
        puuid = str(player.get("puuid"))
        actual = actual_by_player.get(puuid) or {}
        result = individual_results.get(puuid) or {}
        recommended = result.get("best_option") or recommended_by_player.get(puuid) or actual
        individual_score = _score(
            _number(result.get("q_actual")),
            _number(result.get("q_best")),
            _number(result.get("q_floor")),
        )
        confidence_payload = _confidence_payload(inferred.get(puuid) or [], individual_score)
        equivalent = bool(result.get("equivalent"))
        public_recommendation = _public_purchase(
            recommended, is_pistol_round=bool(context.get("is_pistol_round")),
        )
        player.update({
            "actual_purchase": actual,
            "recommended_purchase": public_recommendation,
            "purchase_score": individual_score,
            "grade": "Sin mejora demostrable" if equivalent else grade_label(individual_score),
            **confidence_payload,
            "best_alternative": _plan_player_summary(recommended),
            "recommendation_equivalent_to_actual": equivalent,
            "individual_value_gap": round(max(
                0.0,
                _number(result.get("q_best")) - _number(result.get("q_actual")),
            ), 6),
            "individual_regret": shapley.get(puuid, 0.0),
            "coordination_attribution": {
                "method": "exact_shapley_5_players",
                "match_value_regret": shapley.get(puuid, 0.0),
            },
            "grade_explanation": {
                "what_went_well": "La compra respetó el presupuesto y el inventario observado.",
                "lost_value": (
                    "No hay una mejora material dentro del margen de incertidumbre."
                    if equivalent else
                    "Diferencia de valor de victoria manteniendo las compras reales de sus compañeros."
                ),
                "best_alternative": public_recommendation["display"].get("loadout_label"),
            },
        })
        player["reason"] = (
            "La compra realizada ya es óptima o equivalente dentro del margen de incertidumbre."
            if equivalent else
            "Esta alternativa mejora el valor esperado manteniendo las compras reales de sus compañeros."
        )

    game_version = context.get("game_version")
    ruleset = ruleset_provenance(game_version)
    macro_guidance = context.get("macro_model_guidance") or {}
    actual_plan_kind = TeamBuySolver._summarize(actual_players, inventories, context)
    if team_equivalent:
        payload["recommended_team_buy"] = actual_plan_kind
    credit_players = {
        item.puuid: {
            "credits_before_buy": item.credits_before_buy,
            "remaining_after_buy": (observed.get(item.puuid) or {}).get("remaining"),
            "total_outlay": (actual_by_player.get(item.puuid) or {}).get("total_outlay"),
            "quality": "rules_reconstructed",
        }
        for item in inventories
    }
    payload.update({
        "economy_contract_version": ECONOMY_CONTRACT_VERSION,
        "engine": ENGINE_VERSION,
        "recommendation_source": (
            "ml_guided_solver" if macro_guidance.get("available") else "deterministic_solver"
        ),
        "recommendation_model_abstained": bool(macro_guidance.get("abstained")),
        "recommendation_is_experimental": bool(macro_guidance.get("experimental_policy")),
        "team_recommendation_equivalent_to_actual": team_equivalent,
        "recommendation_abstained_due_uncertainty": team_equivalent,
        "decision_evidence_confidence": round(evidence_confidence, 4),
        "decision_equivalence_margin": round(team_equivalence_margin, 6),
        "coordination_only_improvement": bool(
            not team_equivalent
            and max(0.0, q_best - q_actual) > .003
            and individual_results
            and all(value <= .003 for value in gaps.values())
        ),
        "ruleset_version": ruleset["ruleset_version"],
        "data_provenance": {
            **ruleset,
            "observed_fields": ["remaining", "loadoutValue", "weapon", "armor"],
            "derived_fields": ["credits_before_buy", "total_outlay", "utility_inventory_value"],
            "inferred_fields": ["weapon_source", "armor_source", "drops", "ability_purchase"],
            "legacy_invalid_fields": ["spent"],
        },
        "credit_reconstruction": {
            "method": "previous_remaining_plus_versioned_income",
            "players": credit_players,
            "legacy_spent_used": False,
        },
        "actual_plan": {
            "players": [_plan_player_summary(item) for item in actual_players],
            "team_plan_value": round(q_actual, 6),
            "economy_projection": actual_projection,
            "match_simulation": actual_simulation,
        },
        "recommended_plan": {
            "plan_kind": actual_plan_kind if team_equivalent else plan.get("plan_kind"),
            "players": [
                _plan_player_summary(item)
                for item in (actual_players if team_equivalent else plan.get("players") or [])
            ],
            "team_plan_value": round(q_best, 6),
            "economy_projection": actual_projection if team_equivalent else projection,
            "match_simulation": actual_simulation if team_equivalent else recommended_simulation,
        },
        "candidate_plan": {
            "plan_kind": plan.get("plan_kind"),
            "players": [_plan_player_summary(item) for item in plan.get("players") or []],
            "team_plan_value": round(candidate_q_best, 6),
            "value_gap": round(candidate_value_gap, 6),
            "rejected_as_indistinguishable": team_equivalent,
        },
        "team_purchase_score": team_purchase_score,
        "team_grade": (
            "Sin mejora demostrable" if team_equivalent else grade_label(team_purchase_score)
        ),
        **team_confidence,
        "actual_plan_value": round(q_actual, 6),
        "recommended_plan_value": round(q_best, 6),
        "value_gap": round(max(0.0, q_best - q_actual), 6),
        "decision_value_deltas": {
            "round_win_probability": round(
                _number((actual_projection if team_equivalent else projection).get("round_win_probability"))
                - _number(actual_projection.get("round_win_probability")), 6
            ),
            "match_win_probability": round(
                _number((actual_projection if team_equivalent else projection).get("match_win_probability"))
                - _number(actual_projection.get("match_win_probability")), 6
            ),
            "next_full_buy_players_if_loss": (
                int(_number((actual_projection if team_equivalent else projection).get("players_can_full_buy_if_loss")))
                - int(_number(actual_projection.get("players_can_full_buy_if_loss")))
            ),
        },
        "grade_is_prebuy_only": True,
    })
    return payload
