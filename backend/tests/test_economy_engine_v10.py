import unittest
from itertools import product
from unittest.mock import patch

from modules.economy_ml.economy_income_rules import fixed_round_start_credits, save_penalty_applies
from modules.economy_ml.inventory import PlayerInventoryState, advance_inventory
from modules.economy_ml.legal_purchase import LegalPurchaseGenerator
from modules.economy_ml.purchase_inference import PurchaseInferenceEngine
from modules.economy_ml.recommendation_explainer import RecommendationExplainer
from modules.economy_ml.schemas import FORBIDDEN_FEATURES, MODEL_FEATURES, SCHEMA_VERSION
from modules.economy_ml.team_buy_solver import TeamBuySolver
from modules.economy_ml.team_buy_solver import BuyScorer
from modules.economy_ml.display_normalizer import (
    normalize_armor_display, normalize_observed_economy,
    normalize_purchase_for_display, normalize_warning_list, normalize_weapon_display,
)
from modules.economy_ml.ability_catalog import agent_abilities, clear_ability_catalog_cache
from modules.economy_ml.round_recommender import RoundEconomyRecommender, recommend_match_economy
from backend.tests.test_economy_ml import _match as economy_match


WEAPONS = {
    "classic": {"displayName": "Classic", "cost": 0},
    "spectre": {"displayName": "Spectre", "cost": 1600},
    "vandal": {"displayName": "Vandal", "cost": 2900},
}
GEAR = {
    "light": {"displayName": "Light Shield", "cost": 400},
    "regen": {"displayName": "Regen Shield", "cost": 650},
    "heavy": {"displayName": "Heavy Shield", "cost": 1000},
}


def inv(puuid, credits, weapon=None, survived=None):
    return PlayerInventoryState(puuid, credits, weapon_before_buy=weapon, survived_previous_round=survived)


class EconomyEngineV10Tests(unittest.TestCase):
    def setUp(self):
        self.catalogs = patch.multiple(
            "modules.economy_ml.legal_purchase",
            load_weapon_catalog=lambda: WEAPONS,
            load_gear_catalog=lambda: GEAR,
            find_weapon=lambda value: next((w for w in WEAPONS.values() if w["displayName"] == value), None),
            find_gear=lambda value: next((g for g in GEAR.values() if g["displayName"] == value), None),
            agent_abilities=lambda agent: [],
        )
        self.catalogs.start()

    def tearDown(self):
        self.catalogs.stop()

    def test_inventory_carries_weapon_after_survival(self):
        previous = PlayerInventoryState("p", 1000, weapon_after_buy="Vandal", armor_after_buy="Light Shield")
        current = advance_inventory(previous, puuid="p", credits_before_buy=3000,
                                    observed_weapon="Vandal", observed_armor="Light Shield", survived_previous_round=True)
        self.assertEqual(current.weapon_before_buy, "Vandal")
        self.assertEqual(current.weapon_source, "carried")

    @patch("modules.economy_ml.display_normalizer.find_weapon")
    def test_classic_uuid_is_normalized_for_display(self, find):
        find.return_value = {"uuid": "29a0cfab-485b-f5d5-779a-b59f85e204a8", "displayName": "Classic", "cost": 0}
        result = normalize_weapon_display("29a0cfab-485b-f5d5-779a-b59f85e204a8")
        self.assertEqual(result["displayName"], "Classic")
        self.assertTrue(result["known"])

    def test_placeholder_armor_becomes_no_shield(self):
        result = normalize_armor_display("string")
        self.assertEqual(result["displayName"], "Sin escudo")
        self.assertNotEqual(result["displayName"], "string")
        observed = normalize_observed_economy({"weapon": None, "armor": "string"})
        self.assertEqual(observed["armor"], "Sin escudo")
        self.assertEqual(normalize_weapon_display("string")["displayName"], "Arma no observada")

    def test_death_loses_weapon(self):
        previous = PlayerInventoryState("p", 1000, weapon_after_buy="Vandal")
        current = advance_inventory(previous, puuid="p", credits_before_buy=3000,
                                    observed_weapon="Classic", observed_armor=None, survived_previous_round=False)
        self.assertIsNone(current.weapon_before_buy)
        self.assertTrue(current.died_previous_round)

    @patch("modules.economy_ml.purchase_inference.find_weapon", lambda value: WEAPONS.get(str(value).lower()))
    def test_pickup_hypothesis_when_upgrade_has_insufficient_spend(self):
        state = PlayerInventoryState("p", 1200, weapon_before_buy="Classic", weapon_after_buy="Vandal",
                                     survived_previous_round=True)
        result = PurchaseInferenceEngine().infer(state, observed_spent=100)
        self.assertEqual(result[0]["weapon_source"], "picked_up")
        self.assertLess(result[0]["confidence"], 1)

    @patch("modules.economy_ml.purchase_inference.find_weapon", lambda value: WEAPONS.get(str(value).lower()))
    def test_pistol_classic_is_default_spawn_not_purchase(self):
        state = PlayerInventoryState("p", 800, weapon_after_buy="Classic")
        result = PurchaseInferenceEngine().infer(state, observed_spent=0, context={"is_pistol_round": True})
        self.assertEqual(result[0]["weapon_source"], "default_spawn_weapon")
        self.assertEqual(result[0]["estimated_self_spend"], 0)
        self.assertNotEqual(result[0]["weapon_source"], "bought_self")

    @patch("modules.economy_ml.purchase_inference.find_weapon", lambda value: WEAPONS.get(str(value).lower()))
    def test_team_inference_can_mark_probable_drop_buyer(self):
        receiver = PlayerInventoryState("poor", 400, weapon_after_buy="Vandal", died_previous_round=True)
        donor = PlayerInventoryState("rich", 9000, weapon_before_buy="Vandal", weapon_after_buy="Vandal",
                                     survived_previous_round=True)
        result = PurchaseInferenceEngine().infer_team(
            [receiver, donor], {"poor": {"remaining": 400}, "rich": {"remaining": 6000}}
        )
        self.assertEqual(result["poor"][0]["weapon_source"], "bought_by_teammate")
        self.assertTrue(result["rich"][0]["buys_for_teammate"])
        self.assertIn("team_drop_inferred_not_observed", result["rich"][0]["warnings"])

    def test_armor_variants_are_generated_and_budgeted(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 1000), limit=100)
        armor_names = {(p.get("armor") or {}).get("displayName") for p in plans}
        self.assertTrue({"Light Shield", "Regen Shield", "Heavy Shield"}.issubset(armor_names))
        self.assertTrue(all(p["self_cost"] <= 1000 for p in plans if not p.get("requires_weapon_drop")))

    def test_carried_vandal_costs_zero_but_keeps_tactical_value(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 2000, "Vandal", True), limit=200)
        kept = next(p for p in plans if p["keep_weapon"] and (p["weapon"] or {}).get("displayName") == "Vandal"
                    and p["armor"] is None and p["ability_cost"] == 0)
        self.assertEqual(kept["weapon_source"], "carried")
        self.assertEqual(kept["weapon_cost"], 0)
        self.assertEqual(kept["weapon_purchase_cost"], 0)
        self.assertEqual(kept["weapon_value"], 2900)
        self.assertEqual(kept["self_cost"], 0)
        self.assertEqual(kept["expected_remaining"], 2000)

    def test_carried_heavy_armor_has_zero_cost_and_full_value(self):
        state = PlayerInventoryState("p", 2000, weapon_before_buy="Vandal",
                                     armor_before_buy="Heavy Shield", survived_previous_round=True)
        plans = LegalPurchaseGenerator().generate(state, limit=300)
        kept = next(p for p in plans if p["keep_weapon"] and p["keep_armor"])
        self.assertEqual(kept["armor_source"], "carried")
        self.assertEqual(kept["armor_cost"], 0)
        self.assertEqual(kept["armor_value"], 1000)
        self.assertIn("Heavy Shield conservada", normalize_purchase_for_display(kept)["armor_label"])

    def test_reset_round_discards_carried_weapon_and_armor(self):
        state = PlayerInventoryState("p", 800, weapon_before_buy="Vandal", armor_before_buy="Heavy Shield",
                                     survived_previous_round=True, weapon_after_buy="Classic")
        result = RoundEconomyRecommender().recommend(
            round_number=13, team_id="A", side="defense", inventories=[state],
            observed={"p": {"weapon": "Classic", "armor": "Sin escudo", "spent": 0}},
            context={"is_pistol_round": True},
        )
        purchase = result["players"][0]["recommended_purchase"]
        self.assertFalse(purchase["keep_weapon"])
        self.assertFalse(purchase["keep_armor"])
        self.assertNotEqual(purchase["weapon_source"], "carried")

    def test_only_actual_spectre_is_marked_as_carried(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 2000, "Spectre", True), limit=200)
        kept = [p for p in plans if p["keep_weapon"]]
        self.assertTrue(kept)
        self.assertEqual({(p["weapon"] or {}).get("displayName") for p in kept}, {"Spectre"})
        classic = next(p for p in plans if (p["weapon"] or {}).get("displayName") == "Classic"
                       and not p["keep_weapon"])
        self.assertEqual(classic["weapon_cost"], 0)
        self.assertEqual(classic["weapon_source"], "bought_self")

    @patch("modules.economy_ml.legal_purchase.agent_abilities")
    def test_omen_has_one_free_and_one_purchasable_smoke(self, abilities):
        abilities.return_value = [{"name": "Dark Cover", "free_charges_at_round_start": 1,
                                   "max_charges": 2, "purchasable_charges": 1,
                                   "cost_per_charge": 150, "is_purchasable": True}]
        options = LegalPurchaseGenerator._ability_options("Omen", 500)
        bought = next(option for option in options if option[1] == 150)
        self.assertEqual(sum(a["charges"] for a in bought[0] if a["name"] == "Dark Cover"), 2)

    @patch("modules.economy_ml.legal_purchase.agent_abilities")
    def test_killjoy_turret_is_free_but_has_inventory_value(self, abilities):
        abilities.return_value = [{"name": "Turret", "free_charges_at_round_start": 1,
                                   "max_charges": 1, "purchasable_charges": 0,
                                   "cost_per_charge": 0, "is_purchasable": False}]
        option = LegalPurchaseGenerator._ability_options("Killjoy", 0)[0]
        self.assertEqual(option[1], 0)
        self.assertEqual(option[0][0]["name"], "Turret")
        self.assertEqual(option[0][0]["charges"], 1)
        self.assertEqual(option[0][0]["cost"], 0)

    @patch("modules.economy_ml.legal_purchase.agent_abilities")
    def test_multiple_abilities_and_charges_can_share_one_purchase(self, abilities):
        abilities.return_value = [
            {"name": "Owl Drone", "max_charges": 1, "purchasable_charges": 1, "cost_per_charge": 400, "is_purchasable": True},
            {"name": "Shock Bolt", "max_charges": 2, "purchasable_charges": 2, "cost_per_charge": 150, "is_purchasable": True},
            {"name": "Recon Bolt", "ability_kind": "signature", "free_charges_at_round_start": 1, "is_purchasable": False},
        ]
        options = LegalPurchaseGenerator._ability_options("Sova", 700)
        full = next(option for option in options if option[1] == 700)
        by_name = {item["name"]: item for item in full[0]}
        self.assertEqual(by_name["Owl Drone"]["charges"], 1)
        self.assertEqual(by_name["Shock Bolt"]["charges"], 2)
        self.assertEqual(by_name["Recon Bolt"]["cost"], 0)

    @patch("modules.economy_ml.legal_purchase.agent_abilities")
    def test_missing_ability_cost_warns_without_crashing(self, abilities):
        abilities.return_value = [{"name": "Unknown Utility", "max_charges": 1,
                                   "purchasable_charges": 1, "cost_per_charge": None,
                                   "cost_credits": None, "is_purchasable": True}]
        options = LegalPurchaseGenerator._ability_options("Agent", 1000)
        self.assertIn("missing_cost:Unknown Utility", options[0][2])

    def test_weapon_drop_can_fund_receiver_but_not_armor_or_abilities(self):
        inventories = [inv("rich", 9000), inv("poor", 400)]
        plan = TeamBuySolver().solve(inventories, alternatives=2)
        self.assertTrue(plan["valid"])
        for player in plan["players"]:
            self.assertLessEqual(player["self_cost"], next(i.credits_before_buy for i in inventories if i.puuid == player["puuid"]))
            if player.get("bought_by"):
                self.assertEqual(player["weapon_cost"], 0)
                self.assertEqual(player["self_cost"], player["armor_cost"] + player["ability_cost"])

    def test_vandal_drop_requires_donor_to_keep_useful_loadout(self):
        generator = LegalPurchaseGenerator()
        rich_plans = generator.generate(inv("rich", 9000), limit=200)
        poor_plans = generator.generate(inv("poor", 400), limit=200)
        donor = next(p for p in rich_plans if (p["weapon"] or {}).get("displayName") == "Vandal"
                     and (p["armor"] or {}).get("displayName") == "Heavy Shield")
        receiver = next(p for p in poor_plans if (p["weapon"] or {}).get("displayName") == "Vandal"
                        and p["armor"] is None and p["ability_cost"] == 0 and p["requires_weapon_drop"])
        TeamBuySolver._resolve_weapon_drops([donor, receiver], [inv("rich", 9000), inv("poor", 400)])
        self.assertEqual(receiver["weapon_cost"], 0)
        self.assertEqual(receiver["weapon_purchase_cost"], 2900)
        self.assertEqual(receiver["weapon_value"], 2900)
        self.assertEqual(receiver["self_cost"], 0)
        self.assertEqual(receiver["bought_by"], "rich")
        self.assertEqual(receiver["weapon_source"], "dropped")
        self.assertEqual(donor["self_cost"], 6800)
        self.assertEqual(donor["expected_remaining"], 2200)

    def test_no_buy_never_discards_carried_weapon_or_armor(self):
        state = PlayerInventoryState("p", 500, weapon_before_buy="Vandal",
                                     armor_before_buy="Heavy Shield", survived_previous_round=True)
        plans = LegalPurchaseGenerator().generate(state, limit=200)
        self.assertTrue(plans)
        self.assertTrue(all(plan["weapon"] is not None and plan["armor"] is not None for plan in plans))
        kept = next(plan for plan in plans if plan["keep_weapon"] and plan["keep_armor"])
        display = normalize_purchase_for_display(kept)
        self.assertEqual(display["loadout_label"], "Vandal + Heavy Shield conservada")

    def test_validate_rejects_discarding_carried_inventory(self):
        state = PlayerInventoryState("p", 1000, weapon_before_buy="Vandal", armor_before_buy="Heavy Shield")
        result = TeamBuySolver.validate([TeamBuySolver._zero_plan(inv("p", 1000))], [state])
        self.assertFalse(result["valid"])

    def test_free_classic_is_never_labeled_self_purchase(self):
        purchase = {"weapon": WEAPONS["classic"], "armor": GEAR["light"],
                    "weapon_source": "bought_self", "weapon_purchase_cost": 0,
                    "self_cost": 400}
        display = normalize_purchase_for_display(purchase, is_pistol_round=True)
        self.assertEqual(display["loadout_label"], "Classic gratis + Light Shield")
        self.assertEqual(display["source_label"], "Arma inicial gratis")

    def test_match_point_taxonomy_distinguishes_closing_and_elimination(self):
        players = [TeamBuySolver._zero_plan(inv(str(i), 1000)) for i in range(5)]
        inventories = [inv(str(i), 1000) for i in range(5)]
        self.assertEqual(TeamBuySolver._summarize(players, inventories, {
            "round_number": 18, "team_score_before": 12, "enemy_score_before": 4,
        }), "CLOSING_BUY")
        self.assertEqual(TeamBuySolver._summarize(players, inventories, {
            "round_number": 24, "team_score_before": 11, "enemy_score_before": 12,
        }), "LAST_HALF_ROUND_BUY")
        self.assertEqual(TeamBuySolver._summarize(players, inventories, {
            "round_number": 24 + 0, "is_last_round_before_switch": False,
            "team_score_before": 2, "enemy_score_before": 12,
        }), "LAST_HALF_ROUND_BUY")
        self.assertEqual(TeamBuySolver._summarize(players, inventories, {
            "round_number": 20, "team_score_before": 2, "enemy_score_before": 12,
        }), "ELIMINATION_BUY")

    def test_rich_weak_plan_is_underinvested_and_penalized(self):
        inventories = [inv(str(i), 6000) for i in range(5)]
        players = [TeamBuySolver._zero_plan(item) for item in inventories]
        context = {"round_number": 5, "team_player_credit_estimates": {str(i): 6000 for i in range(5)}}
        score = BuyScorer().score(players, context)
        self.assertIn("team_full_buy_available_but_half_buy_penalty", score["warnings"])
        self.assertIn("excessive_saving_penalty", score["warnings"])
        self.assertEqual(TeamBuySolver._summarize(players, inventories, context), "BROKEN_BUY")

    def test_coordinated_bulldog_force_is_not_mislabeled_as_broken(self):
        inventories = [inv(str(i), 3600) for i in range(5)]
        players = [{
            **TeamBuySolver._zero_plan(inventory),
            "weapon": {"displayName": "Bulldog"}, "weapon_value": 2050,
            "armor": GEAR["light"], "armor_value": 400,
            "self_cost": 2450, "expected_remaining": 1150,
        } for inventory in inventories]
        self.assertEqual(
            TeamBuySolver._summarize(players, inventories, {"round_number": 6}),
            "FORCE_BUY",
        )

    def test_guardian_team_is_a_full_buy(self):
        inventories = [inv(str(i), 4300) for i in range(5)]
        players = [{
            **TeamBuySolver._zero_plan(inventory),
            "weapon": {"displayName": "Guardian"}, "weapon_value": 2250,
            "armor": GEAR["heavy"], "armor_value": 1000,
            "armor_effective_value": 1000,
            "self_cost": 3250, "expected_remaining": 1050,
        } for inventory in inventories]
        self.assertEqual(
            TeamBuySolver._summarize(players, inventories, {"round_number": 6}),
            "FULL_BUY",
        )

    def test_split_buy_with_funded_unarmed_player_is_dominated(self):
        inventories = [inv(str(i), 4000) for i in range(5)]
        players = []
        for index, inventory in enumerate(inventories):
            player = TeamBuySolver._zero_plan(inventory)
            if index < 4:
                player.update({
                    "weapon": {"displayName": "Bulldog"}, "weapon_value": 2050,
                    "armor": GEAR["light"], "armor_value": 400,
                    "self_cost": 2450, "expected_remaining": 1550,
                })
            players.append(player)
        context = {
            "round_number": 6,
            "team_player_credit_estimates": {str(i): 4000 for i in range(5)},
        }
        score = BuyScorer().score(players, context)
        self.assertIn("split_team_buy_with_funded_unarmed_players", score["warnings"])
        candidate = {"economy_projection": score}
        self.assertTrue(TeamBuySolver._is_dominated_underinvestment(candidate, context))

    def test_bonus_does_not_preserve_classic_when_replacement_is_affordable(self):
        players = [{
            **TeamBuySolver._zero_plan(inv(str(i), 5000)),
            "weapon": {"displayName": "Classic"}, "weapon_value": 0,
            "weapon_source": "carried", "keep_weapon": True,
            "expected_remaining": 5000,
        } for i in range(5)]
        context = {
            "round_number": 3, "is_bonus_candidate": True,
            "team_player_credit_estimates": {str(i): 5000 for i in range(5)},
        }
        score = BuyScorer().score(players, context)
        self.assertIn("bonus_missing_replacement_weapon", score["warnings"])
        self.assertTrue(TeamBuySolver._is_dominated_underinvestment(
            {"economy_projection": score}, context,
        ))

    def test_fragmented_expensive_low_value_plan_is_dominated(self):
        inventories = [inv(str(i), 3000) for i in range(5)]
        players = []
        for index, inventory in enumerate(inventories):
            player = TeamBuySolver._zero_plan(inventory)
            player.update({
                "weapon": {"displayName": "Shorty"}, "weapon_value": 300,
                "armor": GEAR["heavy"], "armor_value": 1000,
                "self_cost": 1500, "expected_remaining": 1500,
            })
            if index == 4:
                player.update({
                    "weapon": {"displayName": "Bulldog"}, "weapon_value": 2050,
                    "self_cost": 2700, "expected_remaining": 300,
                })
            players.append(player)
        context = {
            "round_number": 9,
            "team_player_credit_estimates": {str(i): 3000 for i in range(5)},
        }
        score = BuyScorer().score(players, context)
        self.assertIn("fragmented_low_value_team_buy", score["warnings"])
        self.assertTrue(TeamBuySolver._is_dominated_underinvestment(
            {"economy_projection": score}, context,
        ))

    def test_rich_player_low_weapon_loses_to_rifle_and_ultimate_reduces_penalty(self):
        def player(puuid, weapon, value):
            return {"puuid": puuid, "weapon": {"displayName": weapon}, "weapon_value": value,
                    "armor": GEAR["heavy"], "armor_value": 1000, "ability_cost": 0,
                    "self_cost": value + 1000, "expected_remaining": 5000,
                    "keep_weapon": False}
        rifles = [player(str(i), "Vandal", 2900) for i in range(5)]
        weak = [*rifles[:4], player("4", "Bandit", 900)]
        context = {"round_number": 8, "team_player_credit_estimates": {str(i): 9000 for i in range(5)},
                   "advanced_context": {"enemy_economy": {"enemy_buy_recommendation": "ENEMY_FULL_BUY"}}}
        scorer = BuyScorer()
        rifle_score = scorer.score(rifles, context)
        weak_score = scorer.score(weak, context)
        self.assertIn("rich_player_low_weapon_full_buy_penalty", weak_score["warnings"])
        self.assertIn("rich_player_underpowered_vs_full_buy", weak_score["warnings"])
        self.assertLess(weak_score["team_plan_value"], rifle_score["team_plan_value"])
        with_ult = scorer.score(weak, {**context, "advanced_context": {
            **context["advanced_context"], "ultimates": {"4": {
                "ultimate_ready": True, "agent": "Jett",
            }},
        }})
        self.assertLess(with_ult["rule_penalty"], weak_score["rule_penalty"])

    def test_bonus_carried_weak_weapon_avoids_rich_player_penalty(self):
        players = [{"puuid": str(i), "weapon": {"displayName": "Bandit"}, "weapon_value": 900,
                    "armor": GEAR["heavy"], "armor_value": 1000, "ability_cost": 0,
                    "self_cost": 0, "expected_remaining": 9000, "keep_weapon": True}
                   for i in range(5)]
        score = BuyScorer().score(players, {"round_number": 4, "is_bonus_candidate": True,
            "team_player_credit_estimates": {str(i): 9000 for i in range(5)}})
        self.assertNotIn("rich_player_low_weapon_full_buy_penalty", score["warnings"])

    def test_reduced_choices_keeps_carried_and_rifle_armor_anchors(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 6000, "Spectre", True), limit=200)
        with patch("modules.economy_ml.team_buy_solver.MAX_CHOICES_PER_PLAYER", 4):
            choices = TeamBuySolver._reduced_choices(plans)
        self.assertLessEqual(len(choices), 4)
        self.assertTrue(any(item.get("keep_weapon") for item in choices))
        self.assertTrue(any((item.get("weapon") or {}).get("displayName") == "Vandal"
                            and (item.get("armor") or {}).get("displayName") == "Heavy Shield"
                            for item in choices))

    def test_pistol_reduction_preserves_classic_ghost_and_armor_baselines(self):
        pistol_catalog = {
            **WEAPONS,
            "ghost": {"displayName": "Ghost", "cost": 500},
            "shorty": {"displayName": "Shorty", "cost": 300},
            "frenzy": {"displayName": "Frenzy", "cost": 450},
            "sheriff": {"displayName": "Sheriff", "cost": 800},
        }
        with patch("modules.economy_ml.legal_purchase.load_weapon_catalog", lambda: pistol_catalog):
            plans = LegalPurchaseGenerator().generate(
                inv("p", 800), agent="Skye", limit=200,
                context={"is_pistol_round": True},
            )
        with patch("modules.economy_ml.team_buy_solver.MAX_CHOICES_PER_PLAYER", 4):
            choices = TeamBuySolver._reduced_choices(plans, {"is_pistol_round": True})
        names = {(item.get("weapon") or {}).get("displayName") for item in choices}
        self.assertTrue(None in names or "Classic" in names)
        self.assertIn("Ghost", names)
        self.assertTrue(any((item.get("armor_value") or 0) >= 400 for item in choices))
        self.assertTrue({"Shorty", "Frenzy", "Sheriff"}.issubset(names))

    def test_pistol_sidearm_has_no_intrinsic_weapon_penalty(self):
        base = {
            "puuid": "p", "armor": None, "armor_value": 0,
            "abilities": [], "ability_cost": 0, "expected_remaining": 500,
            "self_cost": 300, "keep_weapon": False,
        }
        shorty = {**base, "weapon": {"displayName": "Shorty"}, "weapon_value": 300}
        classic = {**base, "weapon": {"displayName": "Classic"}, "weapon_value": 0}
        scorer = BuyScorer()
        shorty_score = scorer.score([shorty], {"is_pistol_round": True})
        scorer.score([classic], {"is_pistol_round": True})
        self.assertNotIn("pistol_shorty_without_close_range_support", shorty_score["warnings"])

    def test_reduced_choices_does_not_replace_self_buy_anchor_with_unfunded_operator(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 3500), limit=200)
        with patch("modules.economy_ml.team_buy_solver.MAX_CHOICES_PER_PLAYER", 4):
            choices = TeamBuySolver._reduced_choices(plans)
        protected = [p for p in choices if (p.get("weapon_value") or 0) >= 1600
                     and (p.get("armor_value") or 0) >= 400]
        self.assertTrue(protected)
        self.assertTrue(any(not p.get("requires_weapon_drop") for p in protected))

    def test_purchase_payload_does_not_repeat_raw_content_documents(self):
        plans = LegalPurchaseGenerator().generate(inv("p", 6000), limit=200)
        self.assertTrue(plans)
        self.assertTrue(all("raw" not in (plan.get("weapon") or {}) for plan in plans))
        self.assertTrue(all("raw" not in (plan.get("armor") or {}) for plan in plans))

    def test_contextual_scoring_uses_bounded_shortlist(self):
        inventories = [inv(str(i), 6000) for i in range(5)]
        def passthrough(score, players, context, model, prediction=None):
            return {**score, "warnings": score.get("warnings", []),
                    "debug_warnings": score.get("debug_warnings", [])}
        with patch("modules.economy_ml.team_buy_solver.apply_contextual_adjustments",
                   side_effect=passthrough) as contextual:
            TeamBuySolver().solve(inventories, context={"advanced_context": {"map_context": {}}})
        self.assertGreater(contextual.call_count, 0)
        self.assertLessEqual(contextual.call_count, 16)

    def test_direct_combination_lookup_matches_cartesian_product_order(self):
        choices = [
            [{"id": "a0"}, {"id": "a1"}],
            [{"id": "b0"}, {"id": "b1"}, {"id": "b2"}],
            [{"id": "c0"}, {"id": "c1"}],
        ]
        expected = list(product(*choices))
        actual = [
            TeamBuySolver._combination_at_index(choices, index)
            for index in range(len(expected))
        ]
        self.assertEqual(actual, expected)

    def test_round_win_model_is_reused_between_solver_calls(self):
        inventories = [inv(str(i), 6000) for i in range(5)]

        def passthrough(score, players, context, model, prediction=None):
            return {**score, "warnings": score.get("warnings", []),
                    "debug_warnings": score.get("debug_warnings", [])}

        with (
            patch("modules.economy_ml.team_buy_solver.RoundWinLoadoutModel") as model_type,
            patch("modules.economy_ml.team_buy_solver.apply_contextual_adjustments",
                  side_effect=passthrough),
        ):
            model_type.return_value.predict_round_wins.side_effect = (
                lambda rows: [{"available": False, "warnings": []} for _ in rows]
            )
            solver = TeamBuySolver()
            solver.solve(inventories, context={"advanced_context": {"map_context": {}}})
            solver.solve(inventories, context={"advanced_context": {"map_context": {}}})
        model_type.assert_called_once_with()

    def test_early_heavy_weapon_has_no_intrinsic_penalty(self):
        operator = {"puuid": "p", "weapon": {"displayName": "Operator"}, "weapon_value": 4700,
                    "armor": GEAR["heavy"], "armor_value": 1000, "ability_cost": 0,
                    "self_cost": 5700, "expected_remaining": 1000, "keep_weapon": False}
        rifles = [{**operator, "puuid": str(i), "weapon": {"displayName": "Vandal"},
                   "weapon_value": 2900, "self_cost": 3900} for i in range(1, 5)]
        scorer = BuyScorer()
        early = scorer.score([operator, *rifles], {"round_number": 3})
        late = scorer.score([operator, *rifles], {"round_number": 8, "advanced_context": {
            "map_context": {"map_profile": {"operator_affinity": .3}},
            "player_profiles": {"p": {"available": True, "confidence": .8, "sniper_tendency": .8}},
            "enemy_economy": {"enemy_buy_recommendation": "ENEMY_FULL_BUY"},
        }})
        self.assertNotIn("early_heavy_weapon_context_penalty", early["warnings"])
        self.assertEqual(late["rule_penalty"], early["rule_penalty"])

    def test_one_drop_per_donor_and_no_cheap_drop(self):
        donor = {"puuid": "rich", "weapon": WEAPONS["vandal"], "weapon_value": 2900,
                 "armor": GEAR["heavy"], "armor_value": 1000, "keep_weapon": False,
                 "self_cost": 3900, "expected_remaining": 5100, "buys_for": None}
        receivers = []
        for puuid in ("poor1", "poor2"):
            receivers.append({"puuid": puuid, "weapon": WEAPONS["vandal"], "weapon_value": 2900,
                              "weapon_purchase_cost": 2900, "weapon_cost": 2900, "armor": None,
                              "ability_cost": 0, "self_cost": 0, "expected_remaining": 400,
                              "keep_weapon": False, "requires_weapon_drop": True})
        inventories = [inv("rich", 9000), inv("poor1", 400), inv("poor2", 400)]
        TeamBuySolver._resolve_weapon_drops([donor, *receivers], inventories)
        self.assertEqual(sum(bool(item.get("bought_by")) for item in receivers), 1)
        self.assertEqual(len(donor["buys_for"]), 1)

    def test_non_weapon_drop_is_rejected(self):
        players = [{"puuid": "poor", "self_cost": 0, "expected_remaining": 400, "bought_by": "rich",
                    "weapon_cost": 0, "armor_cost": 400, "ability_cost": 0, "requires_weapon_drop": False}]
        result = TeamBuySolver.validate(players, [inv("poor", 400)])
        self.assertFalse(result["valid"])

    def test_operator_stack_has_no_weapon_name_penalty(self):
        operator = {"displayName": "Operator", "cost": 4700}
        rifle = {"displayName": "Vandal", "cost": 2900}
        base = {"armor": GEAR["heavy"], "abilities": [], "ability_cost": 0,
                "self_cost": 5700, "expected_remaining": 0, "keep_weapon": False}
        stacked = [{**base, "puuid": str(i), "weapon": operator} for i in range(3)]
        balanced = [{**base, "puuid": str(i), "weapon": operator if i == 0 else rifle} for i in range(3)]
        scorer = BuyScorer()
        stacked_score = scorer.score(stacked, {})
        self.assertNotIn("multiple_operators_without_exception", stacked_score["warnings"])
        self.assertNotIn("too_many_snipers", stacked_score["warnings"])

    def test_post_pistol_odin_without_armor_loses_to_protected_spectre(self):
        odin = {"puuid": "p", "weapon": {"displayName": "Odin", "cost": 3200}, "weapon_value": 3200,
                "armor": None, "armor_value": 0, "ability_cost": 0, "self_cost": 3200,
                "expected_remaining": 100, "keep_weapon": False}
        spectre = {**odin, "weapon": {"displayName": "Spectre", "cost": 1600}, "weapon_value": 1600,
                   "armor": GEAR["heavy"], "armor_value": 1000, "self_cost": 2600, "expected_remaining": 700}
        context = {"round_number": 2, "is_second_round": True, "previous_round_won": True}
        scorer = BuyScorer()
        self.assertGreater(scorer.score([spectre], context)["team_plan_value"],
                           scorer.score([odin], context)["team_plan_value"])
        self.assertNotIn("heavy_weapon_early_penalty", scorer.score([odin], context)["debug_warnings"])

    def test_team_plan_score_is_capped_but_internal_value_is_preserved(self):
        loaded = [{"puuid": str(i), "weapon": {"displayName": "Vandal", "cost": 2900},
                   "weapon_value": 2900, "armor": GEAR["heavy"], "armor_value": 1000,
                   "abilities": [], "ability_cost": 500, "self_cost": 0,
                   "expected_remaining": 9000, "keep_weapon": True} for i in range(5)]
        result = BuyScorer().score(loaded, {"is_bonus_candidate": True})
        self.assertLessEqual(result["team_plan_score"], 1)
        self.assertIn("team_plan_value", result)

    def test_future_economy_preserves_each_player_distribution(self):
        players = [
            {"puuid": "a", "weapon": None, "armor": None, "abilities": [], "ability_cost": 0,
             "self_cost": 0, "expected_remaining": 8000, "keep_weapon": False},
            {"puuid": "b", "weapon": None, "armor": None, "abilities": [], "ability_cost": 0,
             "self_cost": 0, "expected_remaining": 200, "keep_weapon": False},
        ]
        projection = BuyScorer().score(players, {"loss_income": 1900})
        by_id = {item["puuid"]: item for item in projection["players"]}
        self.assertEqual(by_id["a"]["credits_if_loss"], 9000)
        self.assertEqual(by_id["b"]["credits_if_loss"], 2100)

    def test_carried_weapon_value_improves_score_without_increasing_spend(self):
        carried = {"puuid": "p", "weapon": {"displayName": "Vandal", "cost": 0, "weapon_value": 2900, "source": "carried"},
                   "weapon_value": 2900, "weapon_cost": 0, "weapon_purchase_cost": 0,
                   "armor": None, "abilities": [], "ability_cost": 0, "self_cost": 0,
                   "expected_remaining": 2000, "keep_weapon": True}
        empty = {**carried, "weapon": None, "weapon_value": 0, "keep_weapon": False}
        carried_score = BuyScorer().score([carried], {})
        empty_score = BuyScorer().score([empty], {})
        self.assertGreater(carried_score["round_win_probability"], empty_score["round_win_probability"])
        self.assertGreater(carried_score["score"], empty_score["score"])
        self.assertEqual(carried_score["weapon_value"], 2900)
        self.assertEqual(empty_score["weapon_value"], 0)
        self.assertEqual(carried_score["team_spend"], 0)

    def test_overtime_underinvestment_is_penalized(self):
        players = [{"puuid": str(i), "weapon": None, "armor": None, "abilities": [],
                    "ability_cost": 0, "self_cost": 0, "expected_remaining": 5000, "keep_weapon": False}
                   for i in range(5)]
        result = BuyScorer().score(players, {"is_overtime": True})
        self.assertIn("decisive_round_underinvestment", result["warnings"])

    def test_pistol_utility_plan_has_specific_label(self):
        players = [{"puuid": "p", "weapon": None, "weapon_value": 0, "self_cost": 700,
                    "ability_cost": 700, "armor_cost": 0, "keep_weapon": False}]
        label = TeamBuySolver._summarize(players, [inv("p", 800)], {"is_pistol_round": True})
        self.assertEqual(label, "PISTOL_UTILITY")

    def test_sova_localized_abilities_reuse_seed_costs_by_slot(self):
        clear_ability_catalog_cache()
        abilities = {item["slot"]: item for item in agent_abilities("Sova") if item["slot"] in {"C", "Q", "E"}}
        self.assertEqual(abilities["Q"]["cost_per_charge"], 150)
        self.assertEqual(abilities["C"]["cost_per_charge"], 400)
        self.assertFalse(any(item.get("missing_cost") for item in abilities.values()))
        self.assertIn("Shock Bolt", abilities["Q"]["aliases"])

    def test_warning_codes_are_deduplicated_and_humanized(self):
        result = normalize_warning_list([
            "missing_cost:Flecha explosiva", "missing_cost:Flecha explosiva",
            "missing_cost:Dron", "ability_purchase_not_observable",
            "ability_purchase_not_observable",
        ])
        self.assertEqual(len(result), 2)
        self.assertTrue(any("costes de habilidad" in item for item in result))
        self.assertTrue(any("Compra de habilidades estimada" in item for item in result))

    def test_placeholder_warning_is_debug_only(self):
        self.assertEqual(normalize_warning_list(["invalid_placeholder_value:string"]), [])

    def test_pistol_empty_purchase_has_classic_free_display(self):
        display = normalize_purchase_for_display({"weapon": None, "armor": None, "abilities": [], "self_cost": 0}, is_pistol_round=True)
        self.assertEqual(display["loadout_label"], "Classic gratis + Sin escudo")
        self.assertEqual(display["source_label"], "Arma inicial gratis")

    def test_free_signature_ability_is_not_labeled_as_a_purchase(self):
        display = normalize_purchase_for_display({
            "weapon": None, "armor": None, "self_cost": 0,
            "abilities": [{
                "name": "Paint Shells", "charges": 1, "cost": 0,
                "source": "free_round_start",
            }],
        }, is_pistol_round=True)
        self.assertEqual(display["ability_label"], "Sin compra de habilidades")
        self.assertEqual(display["included_ability_label"], "Paint Shells x1")

    def test_player_reason_uses_spanish_label_for_force_buy(self):
        explanation = RecommendationExplainer._reason({}, {"plan_kind": "FORCE_BUY"})
        self.assertEqual(explanation, "Compra coherente con el plan compra forzada.")

    def test_match_response_exposes_normalized_observed_display_and_dynamic_model_status(self):
        result = recommend_match_economy(economy_match())
        self.assertEqual(len(result["limitations"]), 1)
        self.assertIn("reglas y solver player-first", result["limitations"][0])
        self.assertNotIn("Reglas activas; ML auxiliar no cargado.", result["limitations"])
        self.assertTrue(result["rounds"])
        observed = next(iter(result["rounds"][0]["real_team_buy_observed"].values()))
        self.assertTrue(observed["weapon_display"]["displayName"])
        self.assertTrue(observed["armor_display"]["displayName"])
        self.assertNotIn("ml_auxiliary_unavailable_rules_only", result["rounds"][0]["warnings"])

    def test_macro_model_guidance_adjusts_but_does_not_replace_rule_score(self):
        players = []
        for index in range(5):
            players.append({
                "puuid": str(index), "weapon": WEAPONS["vandal"], "weapon_value": 2900,
                "armor": GEAR["heavy"], "armor_value": 1000, "ability_cost": 0,
                "self_cost": 3900, "expected_remaining": 2100, "keep_weapon": False,
            })
        base = BuyScorer().score(players, {"round_number": 8})
        guided = BuyScorer().score(players, {"round_number": 8, "macro_model_guidance": {
            "available": True, "recommended_action": "FULL_RIFLES", "model_scope": "global",
            "confidence": .75,
        }})
        self.assertTrue(guided["macro_model_available"])
        self.assertEqual(guided["macro_model_action"], "FULL_RIFLES")
        self.assertEqual(guided["macro_model_candidate_action"], "FULL_RIFLES")
        self.assertGreater(guided["macro_model_adjustment"], 0)
        self.assertGreater(guided["team_plan_value"], base["team_plan_value"])
        self.assertLessEqual(guided["macro_model_adjustment"], .12)

        no_confidence = BuyScorer().score(players, {"round_number": 8, "macro_model_guidance": {
            "available": True, "recommended_action": "FULL_RIFLES", "model_scope": "global",
            "confidence": 0,
        }})
        self.assertEqual(no_confidence["macro_model_adjustment"], 0)
        self.assertEqual(no_confidence["team_plan_value"], base["team_plan_value"])

    def test_bonus_keeps_real_inventory_instead_of_buying_five_shields(self):
        inventories = [inv(str(i), 2000, "Spectre", True) for i in range(5)]
        plan = TeamBuySolver().solve(inventories, context={"is_bonus_candidate": True})
        self.assertEqual(plan["plan_kind"], "BONUS_KEEP_INVENTORY")
        kept = [p for p in plan["players"] if p["keep_weapon"]]
        self.assertGreaterEqual(len(kept), 3)
        self.assertTrue(all((p["weapon"] or {}).get("displayName") == "Spectre" for p in kept))
        self.assertTrue(all(p["weapon_cost"] == 0 and p["weapon_value"] == 1600 for p in kept))
        self.assertTrue(all(p["self_cost"] == p["armor_cost"] + p["ability_cost"] for p in kept))

    def test_post_pistol_conversion_does_not_leave_rich_players_unarmed(self):
        inventories = [inv(str(i), 3550) for i in range(5)]
        context = {
            "round_number": 2, "is_second_round": True, "is_post_pistol_conversion": True,
            "previous_round_won": True,
            "team_player_credit_estimates": {str(i): 3550 for i in range(5)},
            "advanced_context": {"enemy_economy": {"enemy_buy_recommendation": "ENEMY_ECO"}},
        }
        plan = TeamBuySolver().solve(inventories, context=context)
        useful = sum((p.get("weapon_value") or 0) >= 1600 for p in plan["players"])
        unarmed = [p for p in plan["players"] if (p.get("weapon_value") or 0) < 500]
        self.assertGreaterEqual(useful, 3)
        self.assertFalse(unarmed)
        self.assertNotIn("post_pistol_conversion_underinvestment", plan["warnings"])

    def test_post_pistol_sidearms_do_not_count_as_conversion_weapons(self):
        inventories = [inv(str(i), 3550, "Ghost", True) for i in range(5)]
        context = {
            "round_number": 2, "is_second_round": True, "is_post_pistol_conversion": True,
            "previous_round_won": True,
            "team_player_credit_estimates": {str(i): 3550 for i in range(5)},
            "advanced_context": {"enemy_economy": {"enemy_buy_recommendation": "ENEMY_ECO"}},
        }
        plan = TeamBuySolver().solve(inventories, context=context)
        useful = sum((p.get("weapon_value") or 0) >= 1600 for p in plan["players"])
        self.assertGreaterEqual(useful, 3)

    def test_bonus_replaces_dead_players_weapons_without_upgrading_survivors(self):
        inventories = [inv("alive1", 5000, "Spectre", True), inv("alive2", 5000, "Spectre", True)]
        inventories += [inv(f"dead{i}", 4500) for i in range(3)]
        credits = {item.puuid: item.credits_before_buy for item in inventories}
        plan = TeamBuySolver().solve(inventories, context={
            "round_number": 3, "is_bonus_candidate": True,
            "team_player_credit_estimates": credits,
            "advanced_context": {"enemy_economy": {"enemy_buy_recommendation": "ENEMY_FULL_BUY"}},
        })
        by_id = {p["puuid"]: p for p in plan["players"]}
        self.assertTrue(by_id["alive1"]["keep_weapon"] and by_id["alive2"]["keep_weapon"])
        self.assertTrue(all((by_id[f"dead{i}"].get("weapon_value") or 0) >= 1600 for i in range(3)))
        self.assertNotIn("bonus_missing_replacement_weapon", plan["warnings"])

    def test_rich_team_vs_full_buy_rejects_low_weapon_when_supported(self):
        inventories = [inv(str(i), 4500) for i in range(5)]
        context = {
            "round_number": 3,
            "team_player_credit_estimates": {str(i): 4500 for i in range(5)},
            "advanced_context": {"enemy_economy": {"enemy_buy_recommendation": "ENEMY_FULL_BUY"}},
        }
        plan = TeamBuySolver().solve(inventories, context=context)
        self.assertNotIn("rich_player_low_weapon_full_buy_penalty", plan["warnings"])
        self.assertTrue(all((p.get("weapon_value") or 0) >= 1600 for p in plan["players"]))

    def test_pistol_plan_never_exceeds_800_per_player(self):
        inventories = [inv(str(i), 800) for i in range(5)]
        plan = TeamBuySolver().solve(inventories, context={"is_pistol_round": True})
        self.assertTrue(all(p["self_cost"] <= 800 for p in plan["players"]))

    def test_save_penalty_and_overtime_constants(self):
        self.assertTrue(save_penalty_applies(side="attack", team_won=False, player_survived=True,
                                            spike_planted=False, round_result="RoundResult_TimeExpired", round_ceremony=None))
        self.assertEqual(fixed_round_start_credits(25), 5000)

    def test_no_observed_post_buy_labels_in_model_features(self):
        self.assertEqual(SCHEMA_VERSION, 12)
        leaked = {"target_loadout_case", "cashflow_case", "enemy_target_loadout_case", "enemy_cashflow_case"}
        self.assertTrue(leaked.issubset(FORBIDDEN_FEATURES))
        self.assertTrue(leaked.isdisjoint(MODEL_FEATURES))

    def test_explainer_plan_and_players_are_coherent(self):
        purchase = {"puuid": "p", "self_cost": 400, "expected_remaining": 400, "weapon": None,
                    "armor": GEAR["light"], "abilities": [], "warnings": []}
        result = RecommendationExplainer().explain(round_number=1, team_id="A", side="attack", score_before="0-0",
            observed={"p": {"weapon": "Classic", "armor": None}},
            inferred={"p": [{"weapon_source": "default", "confidence": .8}]},
            plan={"players": [purchase], "plan_kind": "PISTOL", "team_plan_score": .5, "alternatives": [], "economy_projection": {}},
            player_meta={"p": {"credits_before_buy": 800}})
        self.assertEqual(result["players"][0]["recommended_purchase"]["puuid"], purchase["puuid"])
        self.assertNotIn("raw", result["players"][0]["recommended_purchase"].get("armor") or {})
        self.assertEqual(result["recommended_team_buy"], "PISTOL")


if __name__ == "__main__":
    unittest.main()
