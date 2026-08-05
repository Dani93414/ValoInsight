from __future__ import annotations

from dataclasses import replace
from typing import Any

from .inventory import PlayerInventoryState
from .economy_ledger import infer_player_survived_round
from .ability_catalog import agent_abilities, get_agent_ability_catalog
from .purchase_inference import PurchaseInferenceEngine
from .recommendation_explainer import RecommendationExplainer
from .team_buy_solver import TeamBuySolver
from .display_normalizer import normalize_observed_economy
from .ability_usage import build_ability_usage_state
from .armor_durability import build_armor_durability_state
from .enemy_economy import build_enemy_economy_context
from .map_context import build_map_context
from .player_profile import build_player_profile
from .site_tendencies import build_site_tendencies
from .ultimate_state import build_ultimate_state
from .policy import recommend_economy_action
from .model_registry import load_model_candidates
from .decision_grade import ENGINE_VERSION, enrich_round_with_v12


class RoundEconomyRecommender:
    """Player-first facade used by API/UI code and post-match analysis."""
    def __init__(self) -> None:
        self.inference = PurchaseInferenceEngine()
        self.solver = TeamBuySolver()
        self.explainer = RecommendationExplainer()

    def recommend(self, *, round_number: int, team_id: str, side: str,
                  inventories: list[PlayerInventoryState], observed: dict[str, dict],
                  player_meta: dict[str, dict] | None = None, context: dict | None = None,
                  score_before: Any = None) -> dict:
        context = {**(context or {}), "round_number": round_number}
        if is_inventory_reset_round(context, round_number):
            inventories = [replace(
                item, weapon_before_buy=None, armor_before_buy=None,
                survived_previous_round=None, died_previous_round=None,
                weapon_source="unknown", armor_source="unknown",
            ) for item in inventories]
        inferred = self.inference.infer_team(inventories, observed, context=context)
        meta = player_meta or {}
        plan = self.solver.solve(
            inventories,
            agents={puuid: str(data.get("agent") or "") for puuid, data in meta.items()},
            context=context,
        )
        payload = self.explainer.explain(
            round_number=round_number, team_id=team_id, side=side, score_before=score_before,
            observed=observed, inferred=inferred, plan=plan, player_meta=meta,
            context=context,
        )
        return enrich_round_with_v12(
            payload,
            inventories=inventories,
            observed=observed,
            inferred=inferred,
            plan=plan,
            context=context,
        )


def is_inventory_reset_round(context: dict, round_number: int) -> bool:
    return (
        bool(context.get("is_pistol_round"))
        or round_number in {1, 13}
        or bool(context.get("is_overtime"))
        or bool(context.get("is_half_reset"))
    )


def recommend_round_economy(**kwargs: Any) -> dict:
    return RoundEconomyRecommender().recommend(**kwargs)


def recommend_match_economy(match: dict) -> dict:
    """Return legal recommendations even when no trained ML artifact exists."""
    from .state_extractor import extract_match_round_states

    rounds = match.get("roundResults") or []
    players = match.get("players") or []
    output = []
    all_states = list(extract_match_round_states(match))
    recommender = RoundEconomyRecommender()
    states_by_round: dict[int, list[dict]] = {}
    for item in all_states:
        states_by_round.setdefault(int(item.get("round_number") or 0), []).append(item)
    players_by_team: dict[str, list[dict]] = {}
    for player in players:
        if player.get("puuid"):
            players_by_team.setdefault(str(player.get("teamId") or ""), []).append(player)
    stats_by_round = [
        {str(stat.get("puuid")): stat for stat in (round_obj.get("playerStats") or []) if stat.get("puuid")}
        for round_obj in rounds
    ]
    macro_candidate_cache: dict[tuple[str, str], list[tuple[dict, str]]] = {}
    for state in all_states:
        index = int(state.get("round_number") or 1) - 1
        round_obj = rounds[index] if 0 <= index < len(rounds) else {}
        stats = stats_by_round[index] if 0 <= index < len(stats_by_round) else {}
        previous = rounds[index-1] if index > 0 else None
        previous_stats = stats_by_round[index-1] if index > 0 and index - 1 < len(stats_by_round) else {}
        reset_inventory = is_inventory_reset_round(state, int(state.get("round_number") or 1))
        credit_map = state.get("team_player_credit_estimates") or {}
        team_players = players_by_team.get(str(state.get("team_id") or ""), [])
        enemy_state = next((
            item for item in states_by_round.get(int(state.get("round_number") or 0), [])
            if item.get("team_id") != state.get("team_id")
        ), None)
        advanced_context = {
            "map_context": build_map_context(match, round_number=int(state.get("round_number") or 1),
                                             side=state.get("side")).to_dict(),
            "site_tendencies": build_site_tendencies(match, round_number=int(state.get("round_number") or 1),
                                                     team_id=str(state.get("team_id") or "")).to_dict(),
            "enemy_economy": build_enemy_economy_context(
                enemy_state, previous_round=previous,
                round_number=int(state.get("round_number") or 1),
                is_pistol_round=bool(state.get("is_pistol_round")),
            ).to_dict(),
            "player_profiles": {}, "ultimates": {}, "armor_durability": {}, "ability_usage": {},
        }
        model_key = (str(state.get("rank_name") or ""), str(state.get("rank_group") or ""))
        if model_key not in macro_candidate_cache:
            macro_candidate_cache[model_key] = load_model_candidates(*model_key)
        model_candidates = macro_candidate_cache[model_key]
        prediction_only = bool(model_candidates) and all(
            bundle.get("deployment_policy_enabled") is False
            for bundle, _scope in model_candidates
        )
        if prediction_only:
            macro_result = {
                "available": True,
                "guidance_enabled": False,
                "model_scope": model_candidates[0][1],
                "reason": "Modelo desplegado solo para prediccion; el solver conserva el control.",
            }
        else:
            macro_result = recommend_economy_action(state, model_candidates=model_candidates)
        guidance_enabled = bool(
            macro_result.get("available") and macro_result.get("guidance_enabled", True)
        )
        macro_guidance = {
            "available": guidance_enabled,
            "experimental_policy": bool(macro_result.get("experimental_policy")),
            "policy_validation_passed": bool(macro_result.get("policy_validation_passed", True)),
            "source": macro_result.get("model_scope") or "rules_fallback",
            "warnings": (
                ["Politica ML experimental: no ha demostrado mejora frente a las reglas."]
                if macro_result.get("experimental_policy")
                else [] if macro_result.get("available")
                else [str(macro_result.get("reason") or "macro_model_unavailable")]
            ),
            "recommended_action": macro_result.get("recommended_action"),
            "model_scope": macro_result.get("model_scope"),
            "confidence": float(macro_result.get("confidence") or 0),
            "recommendation_strength": macro_result.get("recommendation_strength"),
            "abstained": bool(macro_result.get("available") and not guidance_enabled),
            "recommendation_margin": macro_result.get("recommendation_margin"),
            "support_count_best_action": macro_result.get("support_count_best_action"),
            "num_viable_alternatives": macro_result.get("num_viable_alternatives"),
            "reason": macro_result.get("reason"),
            "alternatives": [
                {
                    "action": item.get("action"),
                    "is_available": item.get("is_available"),
                    "team_plan_value": (item.get("team_plan") or {}).get("team_plan_value"),
                    "reason_if_unavailable": item.get("reason_if_unavailable"),
                    "historical_support": item.get("historical_support"),
                }
                for item in (macro_result.get("alternatives") or [])
            ],
        }
        advanced_context["macro_model"] = macro_guidance
        inventories: list[PlayerInventoryState] = []
        observed: dict[str, dict] = {}
        meta: dict[str, dict] = {}
        for player in team_players:
            puuid = str(player["puuid"])
            economy = (stats.get(puuid) or {}).get("economy") or {}
            previous_stat = previous_stats.get(puuid) or {}
            previous_economy = previous_stat.get("economy") or {}
            normalized = normalize_observed_economy(economy)
            previous_normalized = normalize_observed_economy(previous_economy)
            survived = infer_player_survived_round(previous, puuid) if previous else None
            if reset_inventory:
                survived = None
            agent = str(player.get("characterName") or player.get("agentName") or player.get("characterId") or "")
            free_abilities = {
                str(ability.get("name")): int(ability.get("free_charges_at_round_start") or 0)
                for ability in agent_abilities(agent)
                if int(ability.get("free_charges_at_round_start") or 0) > 0
            }
            ability_usage = build_ability_usage_state(
                previous, puuid=puuid, agent=agent, round_number=int(state.get("round_number") or 1),
            )
            inventories.append(PlayerInventoryState(
                puuid=puuid, credits_before_buy=float(credit_map.get(puuid) or 0),
                weapon_before_buy=None if reset_inventory else previous_normalized["weapon"] if survived else None,
                weapon_after_buy=normalized["weapon"],
                armor_before_buy=None if reset_inventory else previous_normalized["armor"] if survived else None,
                armor_after_buy=normalized["armor"],
                survived_previous_round=survived,
                died_previous_round=None if survived is None else not survived,
                free_abilities_granted=free_abilities,
                ability_charges_before_buy={} if reset_inventory else ability_usage.charges_carried_after_round,
                ability_charges_confidence=0.0 if reset_inventory else ability_usage.confidence,
            ))
            advanced_context["player_profiles"][puuid] = build_player_profile(
                match, puuid, round_number=int(state.get("round_number") or 1),
            ).to_dict()
            advanced_context["ultimates"][puuid] = build_ultimate_state(
                previous, puuid=puuid, agent=agent, round_number=int(state.get("round_number") or 1),
            ).to_dict()
            advanced_context["ability_usage"][puuid] = ability_usage.to_dict()
            advanced_context["armor_durability"][puuid] = build_armor_durability_state(
                previous, puuid=puuid, round_number=int(state.get("round_number") or 1),
                armor_name=None if reset_inventory else previous_normalized["armor"] if survived else None,
                survived=survived, reset=reset_inventory,
            ).to_dict()
            observed[puuid] = normalized
            agent_payload = get_agent_ability_catalog(agent) or {}
            meta[puuid] = {"player_name": player.get("gameName"),
                           "agent": agent,
                           "role": agent_payload.get("role"),
                           "credits_before_buy": credit_map.get(puuid)}
        output.append(recommender.recommend(
            round_number=state["round_number"], team_id=state["team_id"], side=state.get("side") or "unknown",
            score_before={"team": state.get("team_score_before"), "enemy": state.get("enemy_score_before")},
            inventories=inventories, observed=observed, player_meta=meta,
            context={**state, "side": state.get("side"), "advanced_context": advanced_context,
                     "macro_model_guidance": macro_guidance,
                     "game_version": (match.get("matchInfo") or {}).get("gameVersion")},
        ))
        output[-1]["actual_outcome"] = {
            "team_won_round": str(round_obj.get("winningTeam") or "") == str(state.get("team_id") or ""),
            "round_result": round_obj.get("roundResult"),
            "round_ceremony": round_obj.get("roundCeremony"),
            "excluded_from_purchase_grade": True,
        }
    match_id = str((match.get("matchInfo") or {}).get("matchId") or "UNKNOWN")
    macro_active = any(((item.get("advanced_context") or {}).get("macro_model") or {}).get("available")
                       for item in output)
    loadout_active = any((((item.get("economy_projection") or {}).get("ml_prediction") or {}).get("available"))
                         for item in output)
    active = ["reglas y solver player-first"]
    debug_limitations: list[str] = []
    if macro_active:
        active.append("modelo economico principal")
    else:
        debug_limitations.append("macro_economy_model_unavailable_rules_fallback")
    if loadout_active:
        active.append("ML auxiliar de victoria por loadout")
    else:
        debug_limitations.append("round_win_loadout_model_unavailable")
    return {"available": True, "economy_contract_version": 12, "engine": ENGINE_VERSION,
            "compatibility_engine": "player_first_v10",
            "advanced_engine": "player_first_v11_contextual_stable",
            "match_id": match_id, "rounds": output,
            "limitations": ["Motor activo: " + " + ".join(active) + "."],
            "debug_limitations": debug_limitations}
