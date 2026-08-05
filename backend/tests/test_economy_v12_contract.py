import copy
import inspect
import unittest
from unittest.mock import patch
import numpy as np

from backend.ingestion import format_matches
from backend.tests.test_economy_ml import _match
from modules.economy_ml.economy_ledger import build_player_round_ledger
from modules.economy_ml.recommendation_backtest import summarize_recommendation_backtest
from modules.economy_ml.recommendation_audit import summarize_recommendation_distribution
from modules.economy_ml.round_recommender import recommend_match_economy
from modules.economy_ml.schemas import FORBIDDEN_FEATURES, MODEL_FEATURES, SCHEMA_VERSION
from modules.economy_ml.off_policy_evaluation import doubly_robust_policy_value
from modules.economy_ml.metrics import reliability_report
from modules.economy_ml.decision_grade import _score, _shapley_regret
from modules.economy_ml.match_economy_simulator import simulate_match_value


class EconomyV12ContractTests(unittest.TestCase):
    def test_small_value_gap_cannot_become_catastrophic_grade(self):
        self.assertEqual(_score(0.495, 0.5, 0.49), 95.0)

    def test_pure_coordination_regret_is_fully_attributed(self):
        attribution = _shapley_regret({str(index): 0 for index in range(5)}, .02)
        self.assertAlmostEqual(sum(attribution.values()), .02, places=6)
        self.assertTrue(all(value == .004 for value in attribution.values()))

    def test_slice_reliability_requires_calibration_and_discrimination(self):
        weak = reliability_report({
            "samples": 500, "expected_calibration_error": 0.08,
            "roc_auc": 0.52, "calibration_slope": 0.2,
        })
        self.assertFalse(weak["reliable"])
        self.assertIn("slice_calibration_too_weak", weak["reliability_warnings"])
        strong = reliability_report({
            "samples": 500, "expected_calibration_error": 0.02,
            "roc_auc": 0.7, "calibration_slope": 1.0,
        })
        self.assertTrue(strong["reliable"])
    def test_legacy_spent_is_quarantined_at_ingestion(self):
        source = inspect.getsource(format_matches)
        self.assertIn("legacy_invalid_loadout_minus_remaining", source)
        self.assertIn('"observedFields": ["loadoutValue", "weapon", "armor", "remaining"]', source)

    def test_schema_forbids_legacy_spent_features(self):
        self.assertEqual(SCHEMA_VERSION, 12)
        self.assertIn("spent", FORBIDDEN_FEATURES)
        self.assertIn("econ_spent", FORBIDDEN_FEATURES)
        self.assertTrue({"spent", "econ_spent", "player_spent"}.isdisjoint(MODEL_FEATURES))

    def test_ledger_ignores_fabricated_spent(self):
        match = _match()
        first = match["roundResults"][0]["playerStats"][0]["economy"]
        first["remaining"] = 300
        first["spent"] = 99999
        ledger = build_player_round_ledger(
            match=match,
            round_index=0,
            team_id="A",
            puuid="A0",
            previous_player_state=None,
        )
        self.assertEqual(ledger["credits_before_buy_estimated"], 800)
        self.assertEqual(ledger["spent"], 500)
        self.assertEqual(ledger["spent_source"], "derived_prebuy_minus_remaining")
        self.assertIn("legacy_spent_ignored", ledger["flags"])

    def test_v12_grade_is_prebuy_and_outcome_independent(self):
        original = _match()
        changed = copy.deepcopy(original)
        changed["roundResults"][0]["winningTeam"] = "B"
        first = recommend_match_economy(original)["rounds"][0]
        second = recommend_match_economy(changed)["rounds"][0]
        self.assertEqual(first["team_purchase_score"], second["team_purchase_score"])
        self.assertEqual(first["score_range"], second["score_range"])
        self.assertTrue(first["grade_is_prebuy_only"])
        self.assertTrue(first["actual_outcome"]["excluded_from_purchase_grade"])

    def test_individual_counterfactual_uses_real_scoreboard_not_purchase_grade(self):
        with patch(
            "modules.economy_ml.decision_grade.simulate_match_value",
            wraps=simulate_match_value,
        ) as simulator:
            recommend_match_economy(_match())
        scoreboard_values = [
            int(call.kwargs["team_score"])
            for call in simulator.call_args_list
            if "team_score" in call.kwargs
        ]
        self.assertTrue(scoreboard_values)
        self.assertTrue(all(0 <= value <= 13 for value in scoreboard_values))

    def test_round_contract_contains_provenance_plans_and_player_grades(self):
        response = recommend_match_economy(_match())
        self.assertEqual(response["engine"], "player_first_v12_decision_grade")
        row = response["rounds"][0]
        self.assertFalse(row["credit_reconstruction"]["legacy_spent_used"])
        self.assertEqual(row["economy_contract_version"], 12)
        self.assertIn("actual_plan", row)
        self.assertIn("recommended_plan", row)
        self.assertIn("team_grade", row)
        self.assertIn("purchase_score", row["players"][0])
        self.assertIn("actual_purchase", row["players"][0])
        for player in row["players"]:
            if player["purchase_score"] == 100:
                self.assertTrue(player["recommendation_equivalent_to_actual"])
                self.assertEqual(player["individual_value_gap"], 0)

    def test_backtest_understands_player_first_v12(self):
        rows = recommend_match_economy(_match())["rounds"]
        summary = summarize_recommendation_backtest(rows)
        self.assertGreater(summary["total_player_recommendations"], 0)
        self.assertNotIn("UNKNOWN", summary["recommended_action_counts"])
        self.assertEqual(summary["legacy_spent_used_rounds"], 0)
        self.assertGreater(summary["graded_rounds"], 0)

        distribution = summarize_recommendation_distribution(rows)
        self.assertNotIn("UNKNOWN", distribution["real_buy_action_counts"])
        self.assertTrue(all(not action.startswith("{") for action in distribution["real_buy_action_counts"]))

    def test_doubly_robust_evaluation_reports_clustered_interval(self):
        result = doubly_robust_policy_value(
            outcomes=np.array([1, 0, 1, 0], dtype=float),
            observed_actions=np.array(["A", "B", "A", "B"]),
            target_actions=np.array(["A", "A", "A", "A"]),
            observed_propensities=np.array([0.5, 0.5, 0.5, 0.5]),
            observed_outcome_predictions=np.array([0.6, 0.4, 0.6, 0.4]),
            target_outcome_predictions=np.array([0.6, 0.6, 0.6, 0.6]),
            match_ids=np.array(["m1", "m1", "m2", "m2"]),
            bootstrap_samples=60,
        )
        self.assertEqual(result["estimator"], "doubly_robust_aipw_cluster_bootstrap")
        self.assertEqual(result["clusters"], 2)
        self.assertEqual(len(result["confidence_interval_95"]), 2)

    def test_doubly_robust_evaluation_compares_with_rules_baseline(self):
        result = doubly_robust_policy_value(
            outcomes=np.array([1, 0, 1, 0], dtype=float),
            observed_actions=np.array(["A", "B", "A", "B"]),
            target_actions=np.array(["A", "A", "A", "A"]),
            observed_propensities=np.full(4, 0.5),
            observed_outcome_predictions=np.array([0.6, 0.4, 0.6, 0.4]),
            target_outcome_predictions=np.full(4, 0.6),
            baseline_actions=np.array(["B", "B", "B", "B"]),
            baseline_outcome_predictions=np.full(4, 0.4),
            match_ids=np.array(["m1", "m1", "m2", "m2"]),
            bootstrap_samples=60,
        )
        self.assertEqual(result["baseline_policy"], "deterministic_rules_proxy")
        self.assertIn("baseline_policy_value", result)
        self.assertIsNotNone(result["baseline_match_rate"])


if __name__ == "__main__":
    unittest.main()
