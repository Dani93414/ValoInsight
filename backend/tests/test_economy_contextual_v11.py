import unittest
from unittest.mock import patch

from modules.economy_ml.ability_usage import build_ability_usage_state, carried_charges
from modules.economy_ml.armor_durability import build_armor_durability_state
from modules.economy_ml.contextual_scorer import apply_contextual_adjustments
from modules.economy_ml.enemy_economy import build_enemy_economy_context
from modules.economy_ml.legal_purchase import LegalPurchaseGenerator
from modules.economy_ml.inventory import PlayerInventoryState
from modules.economy_ml.map_context import build_map_context
from modules.economy_ml.player_profile import build_player_profile
from modules.economy_ml.round_recommender import recommend_match_economy
from modules.economy_ml.recommendation_explainer import RecommendationExplainer
from modules.economy_ml.round_win_model import RoundWinLoadoutModel
from modules.economy_ml.site_tendencies import build_site_tendencies
from modules.economy_ml.ultimate_state import build_ultimate_state
from backend.tests.test_economy_ml import _match


class ContextualEconomyV11Tests(unittest.TestCase):
    def _explained_confidence(self, *, ml_available, unavailable_contexts=0):
        purchase = {"puuid": "p", "weapon": None, "armor": None, "abilities": [],
                    "keep_weapon": False, "keep_armor": False, "weapon_source": "none",
                    "self_cost": 0, "expected_remaining": 1000, "warnings": []}
        projection = {"data_confidence": .8, "confidence": .75,
                      "ml_prediction": {"available": ml_available, "confidence": .8 if ml_available else 0,
                                        "round_win_probability": .6 if ml_available else None, "warnings": []}}
        signal = lambda available: {"available": available, "confidence": .8 if available else 0,
                                    "source": "test", "warnings": []}
        advanced = {key: signal(index >= unavailable_contexts)
                    for index, key in enumerate(("map_context", "enemy_economy", "site_tendencies"))}
        result = RecommendationExplainer().explain(
            round_number=4, team_id="A", side="attack", score_before=None,
            observed={"p": {}}, inferred={"p": [{"confidence": .8, "weapon_source": "unknown", "warnings": []}]},
            plan={"players": [purchase], "plan_kind": "ECO", "team_plan_score": .5,
                  "team_plan_value": .5, "economy_projection": projection, "warnings": [], "alternatives": []},
            context={"advanced_context": advanced},
        )
        return result["confidence"]

    def test_v11_confidence_uses_ml_and_context_availability(self):
        without_ml = self._explained_confidence(ml_available=False)
        with_ml = self._explained_confidence(ml_available=True)
        degraded = self._explained_confidence(ml_available=False, unavailable_contexts=3)
        self.assertGreaterEqual(with_ml, without_ml)
        self.assertLess(degraded, without_ml)
        self.assertTrue(all(0 <= value <= 1 for value in (without_ml, with_ml, degraded)))
    @patch("modules.economy_ml.ultimate_state.agent_abilities")
    def test_ultimate_uses_catalog_ultimate_points(self, abilities):
        abilities.return_value = [{"ability_kind": "ultimate", "ultimate_points": 8, "max_charges": 1}]
        ready = build_ultimate_state({"playerStats": [{"puuid": "p", "ultimatePoints": 8}]},
                                     puuid="p", agent="Chamber", round_number=6)
        self.assertEqual(ready.ultimate_cost, 8)
        self.assertTrue(ready.ultimate_ready)
        abilities.return_value = []
        unknown_cost = build_ultimate_state({"playerStats": [{"puuid": "p", "ultimatePoints": 8}]},
                                            puuid="p", agent="Unknown", round_number=6)
        self.assertIsNone(unknown_cost.ultimate_ready)
        self.assertIn("ultimate_cost_unavailable", unknown_cost.warnings)
    @patch("modules.economy_ml.map_context.load_map_catalog")
    def test_map_context_available_and_missing_fallback(self, catalog):
        catalog.return_value = {"map-1": {"displayName": "Breeze", "mapUrl": "/Game/Breeze"}}
        available = build_map_context({"matchInfo": {"mapId": "map-1"}}, round_number=5, side="attack")
        self.assertTrue(available.available)
        self.assertEqual(available.map_name, "Breeze")
        self.assertEqual(available.map_profile["range_profile"], "long")
        missing = build_map_context({"matchInfo": {}}, round_number=5, side="attack")
        self.assertFalse(missing.available)
        self.assertIn("map_context_unavailable", missing.warnings)

    def test_site_tendencies_use_only_prior_rounds(self):
        match = {"roundResults": [
            {"plantSite": "A", "winningTeam": "A"},
            {"plantSite": "A", "winningTeam": "A"},
            {"plantSite": "B", "winningTeam": "B"},
        ]}
        result = build_site_tendencies(match, round_number=3, team_id="A")
        self.assertTrue(result.available)
        self.assertEqual(result.rounds_observed, 2)
        self.assertEqual(result.likely_attack_site, "A")
        self.assertNotIn("B", result.plant_site_counts)
        self.assertFalse(build_site_tendencies({"roundResults": [{}]}, round_number=2).available)

    def test_site_scoring_requires_sample_and_confidence(self):
        base = {"team_plan_value": .5, "team_plan_score": .5, "round_win_probability": .5,
                "weapon_value": 1600, "armor_value": 400, "utility_value": 300,
                "synchronization": .5, "rule_penalty": 0, "data_confidence": .7,
                "warnings": [], "debug_warnings": []}
        player = {"puuid": "p", "weapon": {"displayName": "Spectre"}, "weapon_value": 1600,
                  "armor_value": 400, "ability_cost": 300, "abilities": [{"tactical_types": ["postplant"]}]}
        def score(rounds, confidence):
            return apply_contextual_adjustments(base, [player], {"advanced_context": {"site_tendencies": {
                "available": True, "rounds_observed": rounds, "confidence": confidence,
                "likely_attack_site": "A", "plant_success_by_site": {"A": .8},
            }}})["site_adjustment"]
        self.assertEqual(score(2, .9), 0)
        self.assertEqual(score(3, .49), 0)
        self.assertGreater(score(3, .5), 0)

    def test_player_profile_is_prior_round_only_and_confidence_gated(self):
        rounds = []
        for weapon, kills in [("Operator", 2), ("Operator", 1), ("Operator", 2), ("Vandal", 0)]:
            rounds.append({"playerStats": [{"puuid": "p", "kills": kills,
                                             "economy": {"weapon": weapon}}]})
        profile = build_player_profile({"roundResults": rounds}, "p", round_number=4)
        self.assertTrue(profile.available)
        self.assertEqual(profile.sample_size, 3)
        self.assertEqual(profile.preferred_weapons[0], "Operator")
        # Round four is excluded, proving the current round cannot alter the profile.
        self.assertNotIn("Vandal", profile.weapon_usage_counts)
        self.assertFalse(build_player_profile({"roundResults": rounds}, "p", round_number=2).available)

    def test_player_profile_accepts_real_kill_and_damage_event_lists(self):
        rounds = [{"playerStats": [{"puuid": "p", "kills": [{}, {}],
                                    "damage": [{"damage": 140}],
                                    "economy": {"weapon": "Vandal"}}]} for _ in range(3)]
        profile = build_player_profile({"roundResults": rounds}, "p", round_number=4)
        self.assertTrue(profile.available)
        self.assertEqual(profile.weapon_kill_rate["Vandal"], 2.0)
        self.assertEqual(profile.weapon_damage_efficiency["Vandal"], 140.0)

    def test_contextual_adjustments_do_not_penalize_weapon_name(self):
        base = {"team_plan_value": .6, "team_plan_score": .6, "round_win_probability": .5,
                "weapon_value": 3200, "armor_value": 0, "utility_value": 0,
                "synchronization": .5, "rule_penalty": 0, "data_confidence": .7,
                "warnings": [], "debug_warnings": []}
        odin = {"puuid": "p", "weapon": {"displayName": "Odin"}, "weapon_value": 3200,
                "armor_value": 0, "ability_cost": 0, "keep_weapon": False}
        eco = {"advanced_context": {"enemy_economy": {"available": True, "enemy_buy_recommendation": "ENEMY_ECO"}}}
        result = apply_contextual_adjustments(base, [odin], eco)
        self.assertEqual(result["enemy_adjustment"], 0)
        self.assertNotIn("context_enemy_low_buy_heavy_overbuy", result["warnings"])
        self.assertGreaterEqual(result["contextual_adjustment"], -.35)
        self.assertLessEqual(result["team_plan_score"], 1)

        weak = {**odin, "weapon": None, "weapon_value": 0}
        full = {"advanced_context": {"enemy_economy": {"available": True, "enemy_buy_recommendation": "ENEMY_FULL_BUY"}}}
        self.assertLess(apply_contextual_adjustments(base, [weak], full)["enemy_adjustment"], 0)

    def test_long_range_map_has_small_positive_sniper_adjustment(self):
        base = {"team_plan_value": .5, "team_plan_score": .5, "round_win_probability": .5,
                "weapon_value": 4700, "armor_value": 1000, "utility_value": 0,
                "synchronization": .5, "rule_penalty": 0, "data_confidence": .7,
                "warnings": [], "debug_warnings": []}
        player = {"puuid": "p", "weapon": {"displayName": "Operator"}, "weapon_value": 4700,
                  "armor_value": 1000, "ability_cost": 0, "keep_weapon": False}
        context = {"advanced_context": {"map_context": {"available": True,
                    "map_profile": {"operator_affinity": .10}}}}
        result = apply_contextual_adjustments(base, [player], context)
        self.assertGreater(result["map_adjustment"], 0)
        self.assertLess(result["map_adjustment"], .05)

    def test_operator_fit_and_ready_chamber_ultimate_adjust_score(self):
        base = {"team_plan_value": .6, "team_plan_score": .6, "round_win_probability": .5,
                "weapon_value": 4700, "armor_value": 1000, "utility_value": 0,
                "synchronization": .5, "rule_penalty": 0, "data_confidence": .7,
                "warnings": [], "debug_warnings": []}
        op = {"puuid": "p", "weapon": {"displayName": "Operator"}, "weapon_value": 4700,
              "armor_value": 1000, "ability_cost": 0, "keep_weapon": False}
        good = {"available": True, "confidence": .8, "sniper_tendency": .9,
                "weapon_kill_rate": {"Operator": 1.0}}
        good_result = apply_contextual_adjustments(base, [op], {"advanced_context": {"player_profiles": {"p": good}}})
        bad = {**good, "sniper_tendency": .05, "weapon_kill_rate": {"Operator": .1}}
        bad_result = apply_contextual_adjustments(base, [op], {"advanced_context": {"player_profiles": {"p": bad}}})
        self.assertGreater(good_result["player_fit_adjustment"], bad_result["player_fit_adjustment"])
        chamber = apply_contextual_adjustments(base, [op], {"advanced_context": {
            "ultimates": {"p": {"available": True, "agent": "Chamber", "ultimate_ready": True}}
        }})
        self.assertLess(chamber["ultimate_adjustment"], 0)
        jett = apply_contextual_adjustments(base, [op], {"advanced_context": {
            "ultimates": {"p": {"available": True, "agent": "Jett", "ultimate_ready": True}}
        }})
        self.assertLess(jett["ultimate_adjustment"], 0)

    def test_armor_and_ability_state_fallbacks(self):
        intact = build_armor_durability_state({}, puuid="p", round_number=4,
                                              armor_name="Heavy Shield", survived=True)
        self.assertTrue(intact.available)
        self.assertEqual(intact.armor_value_remaining, 50)
        damaged = build_armor_durability_state(
            {"playerStats": [{"puuid": "p", "damageReceived": 35}]}, puuid="p", round_number=4,
            armor_name="Heavy Shield", survived=True,
        )
        self.assertLess(damaged.armor_value_remaining, 25)
        self.assertFalse(build_armor_durability_state({}, puuid="p", round_number=13,
                                                     armor_name="Heavy Shield", survived=True, reset=True).available)
        self.assertEqual(carried_charges({"Shock": 2}, {"Shock": 1}), {"Shock": 1})
        self.assertFalse(build_ability_usage_state({}, puuid="p", agent="Sova", round_number=4).available)

    def test_enemy_economy_and_round_model_fallback(self):
        enemy = build_enemy_economy_context({"team_id": "B", "team_player_credit_estimates": {"x": 500, "y": 1000}})
        self.assertTrue(enemy.available)
        self.assertEqual(enemy.enemy_buy_recommendation, "ENEMY_ECO")
        model = RoundWinLoadoutModel("does-not-exist.joblib")
        fallback = model.predict_round_win({"team_weapon_value": 5000})
        self.assertFalse(fallback["available"])
        self.assertIn("round_win_model_unavailable", fallback["warnings"])
        leakage = model.predict_round_win({"current_round_kills": 5})
        self.assertIn("round_win_feature_leakage_blocked", leakage["warnings"])

        pistol = build_enemy_economy_context(
            {"team_id": "B", "team_player_credit_estimates": {"x": 800, "y": 800}},
            round_number=13,
        )
        self.assertEqual(pistol.enemy_buy_recommendation, "ENEMY_PISTOL")
        self.assertEqual(pistol.enemy_projected_buy["projected_weapon_value"], 0)
        full_enemy = build_enemy_economy_context({"team_id": "B", "team_player_credit_estimates": {
            str(i): 5000 for i in range(5)
        }})
        eco_enemy = build_enemy_economy_context({"team_id": "B", "team_player_credit_estimates": {
            str(i): 800 for i in range(5)
        }})
        self.assertGreater(full_enemy.enemy_projected_buy["projected_weapon_value"],
                           eco_enemy.enemy_projected_buy["projected_weapon_value"])

        class FakeModel:
            def predict_proba(self, rows):
                return [[.2, .8]]
        model.model = FakeModel()
        prediction = model.predict_round_win({"team_weapon_value": 5000})
        self.assertTrue(prediction["available"])
        self.assertEqual(prediction["round_win_probability"], .8)

    def test_contextual_model_receives_enemy_projected_values(self):
        class SpyModel:
            def __init__(self): self.features = None
            def predict_round_win(self, features):
                self.features = features
                return {"available": False, "round_win_probability": None, "confidence": 0,
                        "warnings": ["test"], "model_scope": None, "feature_version": None}
        spy = SpyModel()
        base = {"team_plan_value": .5, "team_plan_score": .5, "round_win_probability": .5,
                "weapon_value": 8000, "armor_value": 2000, "utility_value": 500,
                "synchronization": .5, "rule_penalty": 0, "data_confidence": .7,
                "warnings": [], "debug_warnings": []}
        apply_contextual_adjustments(base, [], {"advanced_context": {"enemy_economy": {
            "enemy_projected_buy": {"projected_weapon_value": 12000,
                                    "projected_armor_value": 4000,
                                    "projected_utility_value": 1800},
        }}}, spy)
        self.assertEqual(spy.features["enemy_projected_weapon_value"], 12000)
        self.assertEqual(spy.features["enemy_projected_armor_value"], 4000)
        self.assertEqual(spy.features["enemy_projected_utility_value"], 1800)

    def test_enemy_distribution_and_bonus_are_not_average_only(self):
        mixed = build_enemy_economy_context({"team_id": "B", "team_player_credit_estimates": {
            "a": 9000, "b": 9000, "c": 500, "d": 500, "e": 500,
        }})
        self.assertNotEqual(mixed.enemy_buy_recommendation, "ENEMY_FULL_BUY")
        rich = build_enemy_economy_context({"team_id": "B", "team_player_credit_estimates": {
            "a": 5000, "b": 5000, "c": 5000, "d": 5000, "e": 1000,
        }})
        self.assertEqual(rich.enemy_buy_recommendation, "ENEMY_FULL_BUY")
        self.assertEqual(rich.enemy_can_full_buy_count, 4)

    @patch("modules.economy_ml.legal_purchase.agent_abilities")
    def test_carried_ability_charge_is_not_rebought(self, abilities):
        abilities.return_value = [{"name": "Shock Bolt", "canonical_name": "Shock Bolt", "slot": "Q",
                                   "max_charges": 2, "purchasable_charges": 2,
                                   "cost_per_charge": 150, "is_purchasable": True}]
        options = LegalPurchaseGenerator._ability_options("Sova", 500, carried_charges={"Shock Bolt": 1})
        full = next(option for option in options if any(item["charges"] == 2 for item in option[0]))
        self.assertEqual(full[1], 150)
        shock = next(item for item in full[0] if item["name"] == "Shock Bolt")
        self.assertEqual(shock["source"], "carried_and_bought")

    @patch("modules.economy_ml.legal_purchase.agent_abilities", lambda agent: [])
    @patch("modules.economy_ml.legal_purchase.load_weapon_catalog", lambda: {})
    @patch("modules.economy_ml.legal_purchase.load_gear_catalog")
    @patch("modules.economy_ml.legal_purchase.find_gear")
    def test_damaged_carried_armor_exposes_effective_value(self, find_gear, gear_catalog):
        heavy = {"displayName": "Heavy Shield", "cost": 1000}
        find_gear.return_value = heavy
        gear_catalog.return_value = {"heavy": heavy}
        state = PlayerInventoryState("p", 2000, armor_before_buy="Heavy Shield", survived_previous_round=True)
        context = {"advanced_context": {"armor_durability": {"p": {
            "available": True, "armor_value_remaining": 15, "armor_max_value": 50,
        }}}}
        plans = LegalPurchaseGenerator().generate(state, context=context, limit=100)
        carried = next(item for item in plans if item.get("keep_armor"))
        self.assertEqual(carried["armor_value"], 1000)
        self.assertEqual(carried["armor_effective_value"], 300)
        refreshed = next(item for item in plans if not item.get("keep_armor") and item.get("armor_value") == 1000)
        self.assertGreater(refreshed["armor_value"], carried["armor_effective_value"])

    def test_endpoint_exposes_optional_context_with_v12_compatibility(self):
        result = recommend_match_economy(_match())
        self.assertEqual(result["engine"], "player_first_v12_decision_grade")
        self.assertEqual(result["compatibility_engine"], "player_first_v10")
        self.assertEqual(result["economy_contract_version"], 12)
        self.assertEqual(result["advanced_engine"], "player_first_v11_contextual_stable")
        self.assertTrue(result["rounds"])
        advanced = result["rounds"][0]["advanced_context"]
        self.assertIn("map_context", advanced)
        self.assertIn("enemy_economy", advanced)
        self.assertIn("ml_prediction", advanced)

    def test_site_reason_requires_sample_confidence_and_adjustment(self):
        purchase = {"puuid": "p", "weapon": None, "armor": None, "abilities": [],
                    "keep_weapon": False, "keep_armor": False, "weapon_source": "none",
                    "self_cost": 0, "expected_remaining": 1000, "warnings": []}
        plan = {"players": [purchase], "plan_kind": "ECO", "team_plan_score": .5,
                "economy_projection": {"site_adjustment": .02}, "alternatives": []}
        def reasons(rounds, confidence=.8, adjustment=.02):
            plan["economy_projection"]["site_adjustment"] = adjustment
            result = RecommendationExplainer().explain(
                round_number=4, team_id="A", side="attack", score_before=None,
                observed={"p": {}}, inferred={"p": []}, plan=plan,
                context={"advanced_context": {"site_tendencies": {
                    "available": True, "rounds_observed": rounds, "confidence": confidence,
                    "likely_attack_site": "B",
                }}},
            )
            return result["players"][0]["context_reasons"]
        self.assertFalse(any("site" in item for item in reasons(2)))
        self.assertFalse(any("site" in item for item in reasons(3, confidence=.4)))
        self.assertFalse(any("site" in item for item in reasons(3, adjustment=.01)))
        self.assertTrue(any("zona B" in item for item in reasons(3)))


if __name__ == "__main__":
    unittest.main()
