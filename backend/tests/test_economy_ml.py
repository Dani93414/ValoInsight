import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import numpy as np
import joblib

from modules.economy_ml.action_profiles import (
    learn_action_profiles, observed_action_features, simulate_action_features,
)
from modules.economy_ml.buy_classifier import (
    classify_team_buy_action,
    is_heavy_armor,
    is_marshal,
    is_operator,
    is_outlaw,
    is_regen_armor,
    is_rifle,
)
from modules.economy_ml.agent_utility import classify_agent_utility_profile
from modules.economy_ml.dataset_builder import (
    build_economy_dataset_from_matches,
    build_player_economy_dataset_from_matches,
    save_dataset,
    validate_dataset,
)
from modules.economy_ml.similar_rounds import find_similar_rounds
from modules.economy_ml.policy import _policy_gate, recommend_economy_action
from modules.economy_ml.plan_allocator import allocate_player_loadouts
from modules.economy_ml.player_recommendations import build_player_recommendations
from modules.economy_ml.ability_planner import recommend_ability_purchase
from modules.economy_ml.economy_rules import infer_pistol_free_light_armor_from_economy
from modules.economy_ml.recommendation_backtest import summarize_recommendation_backtest
from modules.economy_ml.recommendation_validation import (
    validate_macro_composition,
    validate_player_recommendation_budget,
)
from modules.economy_ml.train import train_models
from modules.economy_ml import model_registry
from modules.economy_ml.rank_mapping import get_rank_group, get_rank_name, normalize_rank_tier
from modules.economy_ml.schemas import FORBIDDEN_FEATURES, MODEL_FEATURES, PREBUY_NUMERIC_FEATURES, SCHEMA_VERSION
from modules.economy_ml.state_extractor import extract_match_round_states
from modules.economy_ml.team_plan import evaluate_team_plan_from_action
from modules.economy_ml.content_catalog import armor_role, weapon_has_profile, weapon_role
from modules.economy_ml.ability_catalog import (
    ability_costs_available,
    build_ability_catalog_report,
    classify_ability_profiles,
    get_agent_ability_catalog,
    validate_ability_catalog,
)
from modules.economy_ml.data_contract import build_data_contract_report, validate_feature_contract
from modules.economy_ml.data_availability import build_data_availability_report
from modules.economy_ml.economy_cases import classify_economy_case
from modules.economy_ml.plan_coherence import evaluate_plan_coherence
from modules.economy_ml.plan_evaluator import context_key
from modules.economy_ml.recommendation_audit import (
    summarize_pistol_recommendation_safety,
    summarize_recommendation_distribution,
)
from modules.economy_ml.ultimate_inference import infer_ultimate_state
from modules.economy_ml.utility_budget import estimate_player_utility_budget


def _match():
    players = [
        {"puuid": f"A{i}", "teamId": "A", "competitiveTier": 13} for i in range(5)
    ] + [{"puuid": f"B{i}", "teamId": "B", "competitiveTier": 14} for i in range(5)]
    stats = []
    for player in players:
        stats.append({
            "puuid": player["puuid"],
            "economy": {"loadoutValue": 1000, "weapon": "Sheriff", "armor": "Light", "remaining": 1200, "spent": 800},
        })
    return {
        "matchInfo": {
            "matchId": "m1", "mapId": "map", "seasonId": "s",
            "queueId": "competitive", "isRanked": True, "gameStartMillis": 1000,
        },
        "players": players,
        "teams": [{"teamId": "A", "won": True}, {"teamId": "B", "won": False}],
        "roundResults": [{"roundNum": 0, "winningTeam": "A", "bombPlanter": "A0", "playerStats": stats}],
    }


class EconomyMlTests(unittest.TestCase):
    def test_rank_mapping(self):
        self.assertEqual(get_rank_name(13), "Gold 2")
        self.assertEqual(get_rank_group(27), "Immortal+")
        self.assertIsNone(normalize_rank_tier("bad"))

    def test_buy_classifier_is_granular(self):
        economies = [{"weapon": "Sheriff", "armor": None, "loadoutValue": 800, "spent": 800}] * 5
        self.assertEqual(classify_team_buy_action(economies), "ECO_SHERIFF_STACK")
        self.assertTrue(is_operator("a03b24d3-4319-996d-0f8c-94bbfba1dfc7"))
        self.assertTrue(is_heavy_armor("822bcab2-40a2-324e-c137-e09195ad7692"))

    def test_buy_classifier_distinguishes_sheriff_counts(self):
        sheriff = {"weapon": "Sheriff", "armor": None, "loadoutValue": 800, "spent": 800}
        classic = {"weapon": "Classic", "armor": None, "loadoutValue": 0, "spent": 0}
        self.assertEqual(classify_team_buy_action([sheriff] + [classic] * 4), "ECO_ONE_SHERIFF")
        self.assertEqual(classify_team_buy_action([sheriff] * 2 + [classic] * 3), "ECO_TWO_SHERIFFS")
        self.assertEqual(classify_team_buy_action([sheriff] * 3 + [classic] * 2), "ECO_SHERIFF_STACK")

    def test_buy_classifier_handles_non_rifle_weapon_families(self):
        bucky_buy = [
            {"weapon": "910be174-449b-c412-ab22-d0873436b21b", "armor": "Light", "loadoutValue": 2500, "spent": 2500}
        ] * 5
        odin_buy = [
            {"weapon": "Odin", "armor": "822bcab2-40a2-324e-c137-e09195ad7692", "loadoutValue": 4500, "spent": 4500}
        ] * 5
        self.assertEqual(classify_team_buy_action(bucky_buy), "SEMI_SMG")
        self.assertEqual(classify_team_buy_action(odin_buy), "FULL_RIFLES")

    def test_agent_utility_classification_uses_role_and_abilities(self):
        omen = {
            "uuid": "agent-omen",
            "displayName": "Omen",
            "role": {"displayName": "Controller"},
            "abilities": [
                {"displayName": "Dark Cover", "description": "Lanza una esfera de humo que bloquea vision."},
                {"displayName": "Paranoia", "description": "Ciega a los jugadores alcanzados."},
            ],
        }
        result = classify_agent_utility_profile(omen)
        self.assertIn("smoke", result["utility_profiles"])
        self.assertIn("vision_denial", result["utility_profiles"])
        self.assertGreaterEqual(result["base_utility_score"], 0.5)

    def test_agent_utility_unknown_fallback_is_neutral(self):
        result = classify_agent_utility_profile({"uuid": "x", "displayName": "Mystery"})
        self.assertEqual(result["utility_profiles"], ["unknown"])
        self.assertEqual(result["base_utility_score"], 0.5)

    def test_data_contract_blocks_post_round_leakage(self):
        report = build_data_contract_report()
        self.assertIn("kills", report["forbidden_pre_round"])
        leakage = validate_feature_contract(["round_number", "kills", "round_won"])
        self.assertFalse(leakage["valid"])
        self.assertIn("round_won", leakage["forbidden_features"])

    def test_ability_profiles_do_not_require_costs(self):
        ability = {"displayName": "Dark Cover", "description": "Lanza una smoke que bloquea vision."}
        profiles = classify_ability_profiles(ability, "Controller")
        self.assertIn("smoke", profiles)

    def test_manual_seed_astra_costs_and_round_start_smoke(self):
        astra = get_agent_ability_catalog("Astra")
        self.assertIsNotNone(astra)
        abilities = astra["abilities"]
        by_name = {str(item.get("name")).lower(): item for item in abilities}
        nebula = next(item for item in abilities if "nebula" in str(item.get("name")).lower() or "nebulosa" in str(item.get("name")).lower())
        self.assertIn("smoke", nebula["tactical_types"])
        manual_nebula = by_name.get("nebula / dissipate")
        self.assertIsNotNone(manual_nebula)
        self.assertEqual(manual_nebula["max_charges"], 2)
        self.assertEqual(manual_nebula["free_charges_at_round_start"], 1)
        self.assertEqual(manual_nebula["cost_credits"], 150.0)
        self.assertEqual(by_name["nova pulse"]["max_charges"], 1)
        self.assertEqual(by_name["nova pulse"]["cost_credits"], 150.0)
        self.assertEqual(by_name["gravity well"]["max_charges"], 1)
        self.assertEqual(by_name["gravity well"]["cost_credits"], 150.0)

    def test_ultimates_have_points_not_credit_cost(self):
        validation = validate_ability_catalog()
        self.assertTrue(validation["valid"])
        for agent_name in ("Astra", "Sova", "Chamber"):
            agent = get_agent_ability_catalog(agent_name)
            ultimates = [item for item in agent["abilities"] if item.get("ability_kind") == "ultimate"]
            self.assertTrue(ultimates)
            for ultimate in ultimates:
                self.assertIsNone(ultimate["cost_credits"])
                self.assertIsNotNone(ultimate.get("ultimate_points"))

    def test_ability_catalog_report_counts_manual_costs_and_review(self):
        report = build_ability_catalog_report()
        self.assertGreaterEqual(report["agents_loaded"], 29)
        self.assertGreater(report["abilities_with_cost"], 0)
        self.assertIn("agents_incomplete", report)
        self.assertIn("validation", report)
        self.assertGreaterEqual(report["needs_review_count"], 1)

    def test_utility_budget_uses_manual_seed_costs(self):
        payload = estimate_player_utility_budget("Astra", "attack", 800, "FULLBUY")
        self.assertFalse(payload["ability_budget_unknown"])
        self.assertTrue(payload["ability_cost_available"])
        self.assertEqual(payload["free_round_start_ability"], "Nebula / Dissipate")
        self.assertIn("smoke", payload["free_round_start_ability_types"])
        self.assertGreater(payload["minimum_key_utility_budget"], 0)

    def test_ability_cost_source_is_manual_catalog_not_database(self):
        report = build_data_availability_report()
        self.assertTrue(report["summary"]["ability_cost_available"])
        self.assertFalse(report["summary"]["content_ability_cost_available"])
        self.assertEqual(report["summary"]["ability_cost_source"], "manual_versioned_catalog")
        cost_field = next(item for item in report["fields"] if item["field"] == "ability cost")
        self.assertEqual(cost_field["source"], "backend/modules/economy_ml/data/ability_catalog_seed.json")
        self.assertEqual(cost_field["usable_as"], "pre_round_plan_feature")

    def test_economy_case_distinguishes_stabilization(self):
        case = classify_economy_case({
            "team_estimated_credits_before_buy": 12000,
            "team_players_can_full_buy_estimate": 1,
            "team_players_low_money": 3,
        })
        self.assertEqual(case["macro_buy_case"], "STABILIZATION")

    def test_plan_coherence_penalizes_eco_with_expensive_weapons(self):
        result = evaluate_plan_coherence({
            "macro_case": "ECO",
            "estimated_weapon_spend": 8000,
            "estimated_armor_spend": 0,
            "estimated_total_spend": 8000,
            "expected_remaining": 1000,
        })
        self.assertLess(result["coherence_score"], 1)
        self.assertTrue(result["warnings"])

    def test_ultimate_inference_is_estimated_not_asserted(self):
        match = _match()
        result = infer_ultimate_state(match, "A0", "Jett", 1)
        self.assertEqual(result["availability_certainty"], "estimated_not_observed")
        self.assertIn("estimated_ult_available_probability", result)

    def test_state_is_pre_round_and_estimates_credits(self):
        rows = extract_match_round_states(_match())
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["team_score_before"], 0)
        self.assertEqual(rows[0]["team_estimated_credits_before_buy"], 4000)
        self.assertEqual(rows[0]["team_credit_estimate_quality"], "rules_based_reset")
        self.assertEqual(rows[0]["team_player_credit_estimates"]["A0"], 800)
        self.assertEqual(rows[0]["round_won"], 1)
        self.assertEqual(rows[0]["side"], "attack")
        self.assertEqual(rows[1]["side"], "defense")
        self.assertIn("team_total_utility_score", rows[0])
        self.assertIn("enemy_smoke_utility_score", rows[0])
        self.assertTrue(FORBIDDEN_FEATURES.isdisjoint(MODEL_FEATURES))
        self.assertNotIn("action_total_loadout", PREBUY_NUMERIC_FEATURES)
        self.assertIn("team_total_utility_score", PREBUY_NUMERIC_FEATURES)

    def test_pistol_round_ignores_observed_credit_anomalies(self):
        match = _match()
        economies = [
            {"remaining": 700, "spent": 0, "loadoutValue": 0, "weapon": "Classic"},
            {"remaining": 300, "spent": 500, "loadoutValue": 500, "weapon": "Ghost"},
            {"remaining": 450, "spent": 400, "loadoutValue": 400, "weapon": "Classic", "armor": "Light"},
            {"remaining": 0, "spent": 500, "loadoutValue": 500, "weapon": "Ghost"},
            {"remaining": 250, "spent": 800, "loadoutValue": 800, "weapon": "Sheriff"},
        ]
        for index, economy in enumerate(economies):
            match["roundResults"][0]["playerStats"][index]["economy"] = economy
        state = extract_match_round_states(match)[0]
        self.assertEqual(state["team_estimated_credits_before_buy"], 4000)
        self.assertEqual(set(state["team_player_credit_estimates"].values()), {800.0})

    def test_pistol_round_never_recommends_sheriff_light_without_free_exception(self):
        match = _match()
        state = {
            **extract_match_round_states(match)[0],
            "team_player_free_light_armor_exceptions": {f"A{i}": False for i in range(5)},
            "pistol_free_light_armor_exception": 0,
            "team_players_with_free_light_armor_exception": 0,
        }
        allocation = allocate_player_loadouts(match, state, "ECO_ONE_SHERIFF")
        sheriff_players = [
            player for player in allocation["players"]
            if str((player.get("weapon") or {}).get("displayName") or "").lower() == "sheriff"
        ]
        self.assertEqual(len(sheriff_players), 1)
        sheriff_player = sheriff_players[0]
        self.assertIsNone(sheriff_player.get("armor"))
        self.assertLessEqual(sheriff_player["total_cost"], 800)

    def test_pistol_free_light_exception_allows_free_light_armor(self):
        economy = {"weapon": "Sheriff", "armor": "Light", "totalOutlay": 800, "loadoutValue": 1200}
        self.assertTrue(infer_pistol_free_light_armor_from_economy(1, economy))
        match = _match()
        state = {
            **extract_match_round_states(match)[0],
            "team_player_free_light_armor_exceptions": {"A0": True},
        }
        allocation = allocate_player_loadouts(match, state, "ECO_ONE_SHERIFF")
        sheriff_player = next(
            player for player in allocation["players"]
            if str((player.get("weapon") or {}).get("displayName") or "").lower() == "sheriff"
        )
        self.assertLessEqual(sheriff_player["total_cost"], sheriff_player["estimated_credits"])
        if sheriff_player["puuid"] == "A0" and sheriff_player.get("armor"):
            self.assertTrue(sheriff_player["armor_is_free_exception"])
            self.assertIn("gratuito", " ".join(sheriff_player["reasons"]))

    def test_eco_one_sheriff_allocates_only_one_sheriff(self):
        match = _match()
        recommendations = build_player_recommendations(
            match,
            extract_match_round_states(match)[0],
            "ECO_ONE_SHERIFF",
        )
        sheriff_count = sum(item.get("recommended_weapon") == "Sheriff" for item in recommendations)
        self.assertEqual(sheriff_count, 1)

    def test_player_loadout_never_exceeds_estimated_credits(self):
        match = _match()
        base_state = extract_match_round_states(match)[0]
        high_credit_state = {
            **base_state,
            "round_number": 4,
            "is_pistol_round": 0,
            "team_player_credit_estimates": {f"A{i}": 5000 for i in range(5)},
            "team_estimated_credits_before_buy": 25000,
        }
        actions = [
            ("ECO_CLASSIC", base_state),
            ("ECO_PISTOL_UPGRADE", base_state),
            ("ECO_ONE_SHERIFF", base_state),
            ("ECO_TWO_SHERIFFS", {**base_state, "round_number": 3, "is_pistol_round": 0}),
            ("FULL_RIFLES", high_credit_state),
        ]
        for action, state in actions:
            allocation = allocate_player_loadouts(match, state, action)
            for player in allocation["players"]:
                self.assertLessEqual(player["total_cost"], player["estimated_credits"])

    def test_new_credit_features_exist_in_state(self):
        state = extract_match_round_states(_match())[0]
        expected = [
            "team_credit_min", "team_credit_max", "team_credit_mean",
            "team_credit_median", "team_credit_std",
            "team_players_can_buy_sheriff", "team_players_can_buy_light_armor",
            "team_players_can_buy_sheriff_light", "team_players_can_buy_ghost_light",
            "enemy_credit_min", "enemy_credit_max", "enemy_credit_mean",
            "enemy_credit_median", "enemy_credit_std",
            "enemy_players_can_buy_sheriff", "enemy_players_can_buy_light_armor",
            "enemy_players_can_buy_sheriff_light", "enemy_players_can_buy_ghost_light",
        ]
        for key in expected:
            self.assertIn(key, state)
            self.assertIn(key, PREBUY_NUMERIC_FEATURES)
        self.assertEqual(state["team_players_can_buy_sheriff"], 5)
        self.assertEqual(state["team_players_can_buy_sheriff_light"], 0)
        self.assertEqual(state["team_players_can_buy_ghost_light"], 0)
        self.assertIn("team_player_credit_estimates", state)
        self.assertNotIn("team_player_credit_estimates", PREBUY_NUMERIC_FEATURES)

    def test_schema_version_12(self):
        self.assertEqual(SCHEMA_VERSION, 12)

    def test_content_taxonomy_knows_bandit_and_regen_shield(self):
        self.assertEqual(weapon_role({"displayName": "Bandit"}), "sidearm")
        self.assertEqual(armor_role({"displayName": "Regen Shield"}), "regen")

    def test_weapon_taxonomy_keeps_snipers_out_of_rifles(self):
        for name in ("Operator", "Outlaw", "Marshal"):
            self.assertFalse(is_rifle(name), name)
            self.assertFalse(weapon_has_profile(name, "rifle_default"), name)
        self.assertTrue(is_operator("Operator"))
        self.assertTrue(is_outlaw("Outlaw"))
        self.assertTrue(is_marshal("Marshal"))
        for name in ("Phantom", "Vandal", "Bulldog", "Guardian"):
            self.assertTrue(is_rifle(name), name)

    def test_state_includes_target_loadout_and_cashflow_cases(self):
        state = extract_match_round_states(_match())[0]
        self.assertIn("target_loadout_case", state)
        self.assertIn("cashflow_case", state)
        self.assertIn("credit_estimate_quality", state)
        self.assertIn("prebuy_credits_selected", state)
        self.assertIn("team_prebuy_credits_rules", state)
        self.assertIn("team_drop_reconciliation_status", state)
        self.assertIn("team_possible_drop_credit_gap", state)
        self.assertIn("team_spent_over_prebuy", state)
        self.assertNotIn("target_loadout_case", MODEL_FEATURES)
        self.assertNotIn("cashflow_case", MODEL_FEATURES)
        self.assertIn("team_drop_reconciliation_status", MODEL_FEATURES)
        self.assertIn("team_possible_drop_credit_gap", MODEL_FEATURES)

    def test_pistol_selected_credits_use_rules_when_observed_is_inconsistent(self):
        match = _match()
        match["roundResults"][0]["playerStats"][0]["economy"]["remaining"] = 9000
        state = extract_match_round_states(match)[0]
        self.assertIsNone(state["prebuy_credits_observed"])
        self.assertEqual(state["prebuy_credits_rules"], 4000)
        self.assertEqual(state["prebuy_credits_selected"], 4000)
        self.assertEqual(state["team_estimated_credits_before_buy"], 4000)
        self.assertEqual(state["credit_estimate_quality"], "rules_only")

    def test_rules_credits_do_not_copy_current_observed_prebuy(self):
        match = _match()
        first = match["roundResults"][0]
        second_stats = []
        for stat in first["playerStats"]:
            economy = dict(stat["economy"])
            economy["remaining"] = 3000
            economy["spent"] = 0
            second_stats.append({**stat, "economy": economy})
        match["roundResults"] = [
            first,
            {"roundNum": 1, "winningTeam": "B", "bombPlanter": "B0", "playerStats": second_stats},
        ]
        rows = extract_match_round_states(match)
        round_two = next(row for row in rows if row["round_number"] == 2 and row["team_id"] == "A")
        self.assertIsNone(round_two["prebuy_credits_observed"])
        self.assertEqual(round_two["prebuy_credits_selected"], round_two["prebuy_credits_rules"])

    def test_regen_shield_features_and_plan_penalty(self):
        economies = [
            {"weapon": "Vandal", "armor": "Regen Shield", "loadoutValue": 3550, "spent": 3550}
            for _ in range(5)
        ]
        features = observed_action_features(economies)
        self.assertEqual(features["action_regen_armor_count"], 5)
        self.assertEqual(features["action_players_without_strong_armor"], 0)
        self.assertTrue(is_regen_armor("Regen Shield"))
        state = {**extract_match_round_states(_match())[0], "team_estimated_credits_before_buy": 18000}
        simulated = simulate_action_features(state, "FORCE_RIFLE_LIGHT")
        self.assertGreaterEqual(simulated["action_regen_armor_count"], 1)
        plan = evaluate_team_plan_from_action(state, "FORCE_RIFLE_LIGHT")
        self.assertIn("estimated_regen_armor_spend", plan)

    def test_team_plan_uses_planned_cashflow_not_observed_cashflow(self):
        state = {
            **extract_match_round_states(_match())[0],
            "cashflow_case": "LOW_TOPUP",
            "team_estimated_credits_before_buy": 25000,
            "team_prebuy_credits_selected": 25000,
            "prebuy_credits_selected": 25000,
            "is_pistol_round": 0,
            "round_number": 4,
        }
        plan = evaluate_team_plan_from_action(state, "FULL_RIFLES")
        self.assertEqual(plan["observed_cashflow_case"], "LOW_TOPUP")
        self.assertIn("planned_cashflow_case", plan)
        self.assertEqual(plan["cashflow_case"], plan["planned_cashflow_case"])
        self.assertNotEqual(plan["planned_cashflow_case"], "LOW_TOPUP")

    def test_skipped_round_still_advances_score_and_streak(self):
        match = _match()
        valid_round = match["roundResults"][0]
        match["roundResults"] = [
            {"roundNum": 0, "winningTeam": "A", "bombPlanter": "A0", "playerStats": []},
            {**valid_round, "roundNum": 1, "winningTeam": "B"},
        ]
        rows = extract_match_round_states(match)
        team_a = next(row for row in rows if row["team_id"] == "A")
        self.assertEqual(team_a["team_score_before"], 1)
        self.assertEqual(team_a["win_streak"], 1)

    def test_counterfactual_profiles_are_coherent_and_distinct(self):
        state = extract_match_round_states(_match())[0]
        eco = simulate_action_features(state, "ECO_CLASSIC")
        full = simulate_action_features({**state, "team_estimated_credits_before_buy": 25000}, "FULL_RIFLES")
        self.assertEqual(eco["action_rifle_count"], 0)
        self.assertEqual(eco["action_total_spent"], 0)
        self.assertEqual(full["action_rifle_count"], 5)
        self.assertEqual(full["action_heavy_armor_count"], 5)

    def test_sheriff_eco_profiles_are_distinct(self):
        state = {**extract_match_round_states(_match())[0], "team_estimated_credits_before_buy": 8000}
        one = simulate_action_features(state, "ECO_ONE_SHERIFF")
        two = simulate_action_features(state, "ECO_TWO_SHERIFFS")
        stack = simulate_action_features(state, "ECO_SHERIFF_STACK")
        self.assertEqual(one["action_sheriff_count"], 1)
        self.assertEqual(two["action_sheriff_count"], 2)
        self.assertEqual(stack["action_sheriff_count"], 5)
        self.assertLess(one["action_total_spent"], two["action_total_spent"])
        self.assertLess(two["action_total_spent"], stack["action_total_spent"])

    def test_learned_action_profile_preserves_utility_and_component_sum(self):
        row = {
            "real_buy_action": "FULL_RIFLES", "action_weapon_value": 14500,
            "action_armor_value": 5000, "action_utility_value": 3200,
            "action_total_loadout_value": 22700, "action_total_spend": 18000,
            "action_heavy_armor_count": 5, "action_regen_armor_count": 0,
            "action_light_armor_count": 0, "action_no_armor_count": 0,
            "action_rifle_count": 5, "action_smg_count": 0,
            "action_sniper_count": 0, "action_operator_count": 0,
            "action_outlaw_count": 0, "action_marshal_count": 0,
            "action_sheriff_count": 0, "action_players_without_heavy_armor": 0,
            "action_players_without_strong_armor": 0,
        }
        profile = learn_action_profiles(pd.DataFrame([row] * 25))["FULL_RIFLES"]
        simulated = simulate_action_features(
            {"team_estimated_credits_before_buy": 25000}, "FULL_RIFLES", profile,
        )
        self.assertEqual(simulated["action_utility_value"], 3200)
        self.assertEqual(
            simulated["action_total_loadout_value"],
            simulated["action_weapon_value"]
            + simulated["action_armor_value"]
            + simulated["action_utility_value"],
        )

    def test_context_key_detects_eco(self):
        state = {"is_match_point": 0, "is_overtime": 0, "is_pistol_round": 0}
        self.assertEqual(context_key(state, {"macro_case": "ECO"}), "eco")

    def test_team_plan_evaluates_collective_costs_and_future_economy(self):
        state = {
            **extract_match_round_states(_match())[0],
            "team_estimated_credits_before_buy": 25000,
            "team_total_utility_score": 0.8,
            "team_low_economy_resilience": 0.7,
        }
        plan = evaluate_team_plan_from_action(state, "FULL_RIFLES", 0.62)
        self.assertEqual(plan["team_buy_case"], "FULLBUY")
        if ability_costs_available():
            self.assertGreater(plan["ability_spend_estimate"], 0)
        else:
            self.assertIsNone(plan["ability_spend_estimate"])
            self.assertTrue(plan["ability_budget_unknown"])
        self.assertLessEqual(plan["total_team_spend"], state["team_estimated_credits_before_buy"])
        self.assertIn("team_plan_value", plan)
        self.assertEqual(plan["ability_purchase_certainty"], "estimated_plan_not_observed")

    def test_dataset_save_and_missing_model_fallback(self):
        frame = build_economy_dataset_from_matches([_match()])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dataset.parquet"
            save_dataset(frame, output)
            self.assertEqual(len(pd.read_parquet(output)), 2)
        self.assertTrue(validate_dataset(frame)["valid"])
        with patch("modules.economy_ml.policy.load_model_candidates", return_value=[]):
            result = recommend_economy_action(frame.iloc[0].to_dict())
        self.assertFalse(result["available"])
        self.assertIn("No hay modelo", result["reason"])

    def test_player_dataset_includes_agent_utility_features(self):
        frame = build_player_economy_dataset_from_matches([_match()])
        self.assertFalse(frame.empty)
        self.assertIn("agent_base_utility_score", frame.columns)
        self.assertIn("agent_weapon_dependency_score", frame.columns)

    def test_player_recommendations_use_state_prebuy_credits(self):
        match = _match()
        match["roundResults"][0]["playerStats"][0]["economy"] = {
            "remaining": 700,
            "spent": 600,
            "loadoutValue": 700,
            "weapon": "Classic",
        }
        state = extract_match_round_states(match)[0]
        recommendations = build_player_recommendations(match, state, "ECO_CLASSIC")
        player = next(item for item in recommendations if item["puuid"] == "A0")
        self.assertEqual(state["team_player_credit_estimates"]["A0"], 800)
        self.assertEqual(player["credits_before_buy"], 800)
        self.assertEqual(player["real_spent"], 600)
        self.assertEqual(player["real_loadout_value"], 700)

    def test_policy_generates_alternatives_and_rejects_impossible_full_buy(self):
        class FakePipeline:
            seen = {}

            def predict_proba(self, frame):
                action = frame.iloc[0]["buy_action"]
                self.seen[action] = frame.iloc[0].to_dict()
                probability = 0.6 if action == "ECO_CLASSIC" else 0.5
                return np.array([[1 - probability, probability]])

        state = extract_match_round_states(_match())[0]
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "FULL_RIFLES": 100},
                "min_action_support": 25,
            }, "rank_group")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "FULL_RIFLES"])
        self.assertTrue(result["available"])
        self.assertEqual(result["recommended_action"], "ECO_CLASSIC")
        self.assertIsNotNone(result["team_plan"])
        self.assertEqual(result["team_plan"]["team_buy_case"], "ECO")
        self.assertIsNotNone(result["alternatives"][0]["team_plan"])
        full_buy = next(item for item in result["alternatives"] if item["action"] == "FULL_RIFLES")
        self.assertFalse(full_buy["is_available"])

    def test_policy_blocks_sheriff_stack_in_normal_eco(self):
        class FakePipeline:
            def predict_proba(self, frame):
                action = frame.iloc[0]["buy_action"]
                probability = 0.9 if action == "ECO_SHERIFF_STACK" else 0.5
                return np.array([[1 - probability, probability]])

        state = {
            **extract_match_round_states(_match())[0],
            "credit_estimate_quality": "exact_observed",
            "round_number": 3,
            "is_pistol_round": 0,
            "is_match_point": 0,
            "is_last_round_before_switch": 0,
            "is_overtime": 0,
            "team_estimated_credits_before_buy": 6000,
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "ECO_SHERIFF_STACK": 100},
                "min_action_support": 25,
            }, "global")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "ECO_SHERIFF_STACK"])
        self.assertTrue(result["available"])
        self.assertNotEqual(result["recommended_action"], "ECO_SHERIFF_STACK")
        blocked = next(item for item in result["alternatives"] if item["action"] == "ECO_SHERIFF_STACK")
        self.assertFalse(blocked["is_available"])
        self.assertIn("Stack de Sheriffs bloqueado", blocked["reason_if_unavailable"])

    def test_policy_blocks_multi_sheriff_in_pistol(self):
        class FakePipeline:
            def predict_proba(self, frame):
                action = frame.iloc[0]["buy_action"]
                probability = 0.9 if action in {"ECO_TWO_SHERIFFS", "ECO_SHERIFF_STACK"} else 0.5
                return np.array([[1 - probability, probability]])

        state = extract_match_round_states(_match())[0]
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {
                    "ECO_CLASSIC": 100,
                    "ECO_TWO_SHERIFFS": 100,
                    "ECO_SHERIFF": 100,
                    "ECO_SHERIFF_STACK": 100,
                },
                "min_action_support": 25,
            }, "global")],
        ):
            result = recommend_economy_action(
                state,
                ["ECO_CLASSIC", "ECO_TWO_SHERIFFS", "ECO_SHERIFF", "ECO_SHERIFF_STACK"],
            )
        self.assertEqual(result["recommended_action"], "ECO_CLASSIC")
        for action in ("ECO_TWO_SHERIFFS", "ECO_SHERIFF", "ECO_SHERIFF_STACK"):
            blocked = next(item for item in result["alternatives"] if item["action"] == action)
            self.assertFalse(blocked["is_available"])
            self.assertIn("pistol round", blocked["reason_if_unavailable"])

    def test_pistol_sheriff_requires_high_margin(self):
        class FakePipeline:
            def predict_proba(self, _frame):
                return np.array([[0.4, 0.6]])

        def fake_plan(_state, action, probability):
            return {"source_action": action, "predicted_match_win": probability, "team_plan_value": 0.5}

        def fake_value(plan, _state):
            value = 0.54 if plan["source_action"] == "ECO_ONE_SHERIFF" else 0.50
            return {"team_plan_value": value, "plan_value_context": "pistol", "plan_value_weights": {}}

        state = extract_match_round_states(_match())[0]
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "ECO_ONE_SHERIFF": 100},
                "min_action_support": 25,
            }, "global")],
        ), patch(
            "modules.economy_ml.policy.evaluate_team_plan_from_action",
            side_effect=fake_plan,
        ), patch(
            "modules.economy_ml.plan_evaluator.evaluate_plan_value",
            side_effect=fake_value,
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "ECO_ONE_SHERIFF"])
        self.assertEqual(result["recommended_action"], "ECO_CLASSIC")
        self.assertIn("margen alto", " ".join(result["explanation"]))

    def test_policy_blocks_multi_sheriff_when_credits_are_low(self):
        class FakePipeline:
            def predict_proba(self, frame):
                action = frame.iloc[0]["buy_action"]
                probability = 0.8 if action == "ECO_TWO_SHERIFFS" else 0.5
                return np.array([[1 - probability, probability]])

        state = {
            **extract_match_round_states(_match())[0],
            "credit_estimate_quality": "exact_observed",
            "credit_estimate_inconsistency_reason": None,
            "round_number": 3,
            "is_pistol_round": 0,
            "is_match_point": 0,
            "is_last_round_before_switch": 0,
            "is_overtime": 0,
            "team_estimated_credits_before_buy": 5000,
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "ECO_TWO_SHERIFFS": 100},
                "min_action_support": 25,
            }, "global")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "ECO_TWO_SHERIFFS"])
        blocked = next(item for item in result["alternatives"] if item["action"] == "ECO_TWO_SHERIFFS")
        self.assertFalse(blocked["is_available"])
        self.assertIn("creditos bajos", blocked["reason_if_unavailable"])

    def test_policy_marks_small_margin_as_low_strength(self):
        class FakePipeline:
            def predict_proba(self, _frame):
                return np.array([[0.5, 0.5]])

        def fake_plan(_state, action, probability):
            return {"source_action": action, "predicted_match_win": probability, "team_plan_value": 0.5}

        def fake_value(plan, _state):
            value = 0.500 if plan["source_action"] == "ECO_CLASSIC" else 0.485
            return {"team_plan_value": value, "plan_value_context": "eco", "plan_value_weights": {}}

        state = {
            **extract_match_round_states(_match())[0],
            "round_number": 3,
            "is_pistol_round": 0,
            "is_match_point": 0,
            "is_overtime": 0,
            "team_estimated_credits_before_buy": 6000,
            "credit_estimate_quality": "exact_observed",
            "credit_estimate_inconsistency_reason": None,
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "ECO_ONE_SHERIFF": 100},
                "min_action_support": 25,
            }, "global")],
        ), patch(
            "modules.economy_ml.policy.evaluate_team_plan_from_action",
            side_effect=fake_plan,
        ), patch(
            "modules.economy_ml.plan_evaluator.evaluate_plan_value",
            side_effect=fake_value,
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "ECO_ONE_SHERIFF"])
        self.assertEqual(result["recommendation_strength"], "low")
        self.assertFalse(result["guidance_enabled"])
        self.assertLess(result["recommendation_margin"], 0.04)
        self.assertIn("Margen insuficiente", result["low_confidence_reason"])

    def test_policy_abstains_outside_selected_action_scope(self):
        class FakePipeline:
            def predict_proba(self, _frame):
                return np.array([[0.2, 0.8]])

        state = {
            **extract_match_round_states(_match())[0],
            "credit_estimate_quality": "exact_observed",
        }
        bundle = {
            "pipeline": FakePipeline(),
            "action_support": {"ECO_CLASSIC": 100},
            "min_action_support": 25,
            "policy_config": {
                "selected": True,
                "allowed_actions": ["FULL_RIFLES"],
                "case_margins": {"pistol": 0.0},
                "disabled_cases": [],
            },
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[(bundle, "global")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC"])
        self.assertFalse(result["guidance_enabled"])
        self.assertEqual(result["recommendation_status"], "abstained_low_confidence")
        self.assertIn("abstiene", result["low_confidence_reason"])

    def test_experimental_policy_override_is_explicit_and_bypasses_only_ope_gate(self):
        bundle = {
            "deployment_policy_enabled": True,
            "experimental_policy_override": True,
            "metrics": {
                "policy_evaluation": {
                    "improvement_confidence_interval_95": [-0.01, 0.01],
                },
            },
        }
        self.assertEqual(_policy_gate(bundle), (True, None))
        bundle["experimental_policy_override"] = False
        allowed, reason = _policy_gate(bundle)
        self.assertFalse(allowed)
        self.assertIn("confianza estadistica", reason)

    def test_policy_downgrades_inconsistent_credit_quality(self):
        class FakePipeline:
            def predict_proba(self, frame):
                action = frame.iloc[0]["buy_action"]
                probability = 0.62 if action == "ECO_CLASSIC" else 0.5
                return np.array([[1 - probability, probability]])

        state = {
            **extract_match_round_states(_match())[0],
            "round_number": 3,
            "is_pistol_round": 0,
            "is_match_point": 0,
            "is_overtime": 0,
            "team_estimated_credits_before_buy": 6000,
            "credit_estimate_quality": "inconsistent",
            "credit_estimate_inconsistency_reason": "observed_rules_gap_gt_600",
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": FakePipeline(),
                "action_support": {"ECO_CLASSIC": 100, "ECO_ONE_SHERIFF": 100},
                "min_action_support": 25,
            }, "global")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC", "ECO_ONE_SHERIFF"])
        self.assertEqual(result["recommendation_strength"], "low")
        self.assertLess(result["credit_quality_factor"], 1.0)
        self.assertIn("Calidad de creditos inconsistente", result["low_confidence_reason"])

    def test_policy_rejects_action_without_historical_support(self):
        state = {**extract_match_round_states(_match())[0], "team_estimated_credits_before_buy": 25000}
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[({
                "pipeline": object(), "action_support": {"FULL_RIFLES": 2},
                "min_action_support": 25,
            }, "global")],
        ):
            result = recommend_economy_action(state, ["FULL_RIFLES"])
        self.assertFalse(result["available"])
        self.assertIn("soporte histórico", result["reason"])

    def test_policy_falls_back_when_exact_scope_has_no_support(self):
        class FakePipeline:
            def predict_proba(self, _frame):
                return np.array([[0.4, 0.6]])

        state = extract_match_round_states(_match())[0]
        unsupported = {"pipeline": FakePipeline(), "action_support": {}, "min_action_support": 25}
        supported = {
            "pipeline": FakePipeline(), "action_support": {"ECO_CLASSIC": 100},
            "min_action_support": 25,
        }
        with patch(
            "modules.economy_ml.policy.load_model_candidates",
            return_value=[(unsupported, "rank_name"), (supported, "rank_group")],
        ):
            result = recommend_economy_action(state, ["ECO_CLASSIC"])
        self.assertTrue(result["available"])
        self.assertEqual(result["model_scope"], "rank_group")

    def test_registry_rejects_partial_or_old_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            joblib.dump({"schema_version": 1}, root / "global_model.joblib")
            with patch.object(model_registry, "ARTIFACTS_DIR", root), patch.object(
                model_registry, "METADATA_PATH", root / "metadata.json"
            ):
                self.assertEqual(model_registry.load_model_candidates("Gold 2", "Gold"), [])
                self.assertFalse(model_registry.status()["available"])

    def test_failed_training_preserves_previous_artifacts(self):
        frame = build_economy_dataset_from_matches([_match()])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.mkdir(exist_ok=True)
            previous = {"schema_version": model_registry.SCHEMA_VERSION, "sentinel": True}
            joblib.dump(previous, root / "global_model.joblib")
            (root / "metadata.json").write_text(
                '{"schema_version": %d}' % model_registry.SCHEMA_VERSION,
                encoding="utf-8",
            )
            with patch.object(model_registry, "ARTIFACTS_DIR", root), patch.object(
                model_registry, "METADATA_PATH", root / "metadata.json"
            ):
                with self.assertRaises(ValueError):
                    train_models(frame, enforce_minimums=False)
                self.assertEqual(joblib.load(root / "global_model.joblib"), previous)
                self.assertTrue(model_registry.status()["available"])

    def test_similar_rounds_excludes_same_match(self):
        state = extract_match_round_states(_match())[0]
        dataset = pd.DataFrame([
            {**state, "match_id": state["match_id"]},
            {**state, "match_id": "other-match"},
        ])
        similar = find_similar_rounds(state, dataset)
        self.assertEqual([row["match_id"] for row in similar], ["other-match"])

    def test_recommendation_audit_counts_sheriff_share(self):
        summary = summarize_recommendation_distribution([
            {"recommended_action": "ECO_CLASSIC", "real_buy_action": "ECO_CLASSIC"},
            {"recommended_action": "ECO_ONE_SHERIFF", "real_buy_action": "ECO_PISTOL_UPGRADE"},
            {"recommended_action": "FULL_RIFLES", "real_buy_action": "FULL_RIFLES"},
        ])
        self.assertEqual(summary["total_recommendations"], 3)
        self.assertEqual(summary["recommended_action_counts"]["ECO_ONE_SHERIFF"], 1)
        self.assertEqual(summary["real_vs_recommended_matrix"]["ECO_PISTOL_UPGRADE"]["ECO_ONE_SHERIFF"], 1)
        self.assertEqual(summary["sheriff_share_within_eco_recommendations"], 0.5)

    def test_pistol_recommendation_audit_counts_impossible_sheriff_light(self):
        summary = summarize_pistol_recommendation_safety([
            {
                "round_number": 1,
                "player_recommendations": [
                    {
                        "recommended_weapon": "Sheriff",
                        "recommended_armor": "Light Shield",
                        "recommended_armor_is_free_exception": False,
                        "expected_spend": 1200,
                        "estimated_credits": 800,
                    },
                    {
                        "recommended_weapon": "Sheriff",
                        "recommended_armor": "Light Shield",
                        "recommended_armor_is_free_exception": True,
                        "expected_spend": 800,
                        "estimated_credits": 800,
                    },
                ],
            }
        ])
        self.assertEqual(summary["pistol_sheriff_light_player_recommendations"], 2)
        self.assertEqual(summary["pistol_free_light_exceptions"], 1)
        self.assertGreaterEqual(summary["pistol_impossible_player_recommendations"], 1)

    def test_player_recommendation_validation_rejects_total_cost_over_budget(self):
        valid, reasons = validate_player_recommendation_budget(
            {"weapon_cost": 2900, "armor_cost": 1000, "ability_cost": 600},
            estimated_credits=3900,
        )
        self.assertFalse(valid)
        self.assertIn("supera", reasons[0])

    def test_macro_composition_validation_is_centralized(self):
        invalid_full = validate_macro_composition("FULL_RIFLES", {
            "players": [
                {"weapon": {"displayName": "Operator"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Vandal"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Phantom"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Bulldog"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Guardian"}, "armor": {"armor_level": "heavy"}},
            ]
        })
        self.assertFalse(invalid_full["valid"])
        self.assertIn("snipers", " ".join(invalid_full["violations"]))

        regen_full = validate_macro_composition("FULL_RIFLES", {
            "players": [
                {"weapon": {"displayName": "Vandal"}, "armor": {"armor_level": "regen"}},
                {"weapon": {"displayName": "Phantom"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Bulldog"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Guardian"}, "armor": {"armor_level": "heavy"}},
                {"weapon": {"displayName": "Vandal"}, "armor": {"armor_level": "heavy"}},
            ]
        })
        self.assertTrue(regen_full["valid"])
        self.assertIn("Regen Shield", " ".join(regen_full["warnings"]))

        invalid_sheriff = validate_macro_composition("ECO_ONE_SHERIFF", {
            "players": [
                {"weapon": {"displayName": "Sheriff"}},
                {"weapon": {"displayName": "Sheriff"}},
            ]
        })
        self.assertFalse(invalid_sheriff["valid"])

    def test_ability_planner_recommends_controller_smoke_when_affordable(self):
        result = recommend_ability_purchase(
            agent_name="Omen",
            agent_id=None,
            role="Controller",
            side="attack",
            available_credits_after_loadout=600,
            context="fullbuy",
        )
        self.assertGreater(result["total_cost"], 0)
        self.assertTrue(result["abilities"])
        types = {profile for ability in result["abilities"] for profile in ability["tactical_types"]}
        self.assertTrue({"smoke", "vision_denial"}.intersection(types))

    def test_full_rifle_controller_prefers_light_plus_smokes_over_illegal_heavy(self):
        match = _match()
        for player in match["players"]:
            if player["teamId"] == "A":
                player["characterId"] = "Omen"
                player["characterName"] = "Omen"
        state = {
            **extract_match_round_states(match)[0],
            "round_number": 4,
            "is_pistol_round": 0,
            "is_match_point": 0,
            "is_last_round_before_switch": 0,
            "is_overtime": 0,
            "team_player_credit_estimates": {f"A{i}": 3900 for i in range(5)},
            "team_estimated_credits_before_buy": 19500,
        }
        allocation = allocate_player_loadouts(match, state, "FULL_RIFLES")
        self.assertTrue(allocation["valid"], allocation.get("violations"))
        for player in allocation["players"]:
            self.assertLessEqual(player["total_cost"], player["estimated_credits"])
        rifle_players = [player for player in allocation["players"] if player.get("weapon")]
        self.assertTrue(rifle_players)
        self.assertFalse(any(
            str((player.get("weapon") or {}).get("displayName") or "").lower() in {"operator", "outlaw", "marshal"}
            for player in rifle_players
        ))
        self.assertTrue(any(player.get("abilities") for player in rifle_players))
        self.assertTrue(any((player.get("armor") or {}).get("armor_level") in {"light", "regen"} for player in rifle_players))

    def test_player_recommendations_include_abilities_without_breaking_budget(self):
        match = _match()
        for player in match["players"]:
            if player["teamId"] == "A":
                player["characterId"] = "Omen"
                player["characterName"] = "Omen"
        state = {
            **extract_match_round_states(match)[0],
            "round_number": 4,
            "is_pistol_round": 0,
            "team_player_credit_estimates": {f"A{i}": 3900 for i in range(5)},
            "team_estimated_credits_before_buy": 19500,
        }
        recommendations = build_player_recommendations(match, state, "FULL_RIFLES")
        self.assertTrue(any(item["recommended_abilities"] for item in recommendations))
        for item in recommendations:
            self.assertLessEqual(item["expected_spend"], item["estimated_credits"])
            self.assertTrue(item["budget_valid"])

    def test_backtest_reports_zero_invalid_when_budgets_hold(self):
        summary = summarize_recommendation_backtest([
            {
                "recommended_action": "FULL_RIFLES",
                "team_plan": {"team_plan_value": 0.7, "macro_case": "FULLBUY"},
                "player_recommendations": [
                    {
                        "estimated_credits": 3900,
                        "recommended_weapon": "Vandal",
                        "recommended_armor": "Light Shield",
                        "recommended_abilities": [{"name": "Dark Cover", "cost": 150}],
                        "role": "Controller",
                    }
                ],
            }
        ])
        self.assertEqual(summary["invalid_recommendation_rate"], 0)
        self.assertGreater(summary["ability_recommendation_rate"], 0)


if __name__ == "__main__":
    unittest.main()
