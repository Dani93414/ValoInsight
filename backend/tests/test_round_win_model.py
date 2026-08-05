import tempfile
import unittest
from pathlib import Path

import pandas as pd
import joblib

from modules.economy_ml.round_win_dataset import (ROUND_WIN_FEATURES, build_round_win_dataset,
                                                   validate_round_win_dataset)
from modules.economy_ml.round_win_model import RoundWinLoadoutModel, validate_round_win_features
from modules.economy_ml.train_round_win_model import train_round_win_model
from modules.economy_ml.train import _temporal_policy_split, _temporal_split


class RoundWinModelTests(unittest.TestCase):
    def _source(self, rows=80):
        return pd.DataFrame({
            "match_id": [f"m{i // 10}" for i in range(rows)],
            "game_start_millis": list(range(1, rows + 1)),
            "round_won": [i % 2 for i in range(rows)],
            "action_total_loadout": [8000 + (i % 2) * 8000 for i in range(rows)],
            "action_heavy_armor_count": [i % 2 * 5 for i in range(rows)],
            "action_regen_armor_count": [0] * rows,
            "action_light_armor_count": [5 - (i % 2) * 5 for i in range(rows)],
            "action_rifle_count": [i % 2 * 4 for i in range(rows)],
            "action_operator_count": [0] * rows,
            "action_smg_count": [5 - (i % 2) * 5 for i in range(rows)],
            "action_sheriff_count": [0] * rows,
            "round_number": [(i % 24) + 1 for i in range(rows)],
            "score_diff": [0] * rows, "loss_streak": [0] * rows,
            "team_estimated_credits_before_buy": [20000] * rows,
            "enemy_estimated_credits_before_buy": [18000] * rows,
            "enemy_economy_case": ["ENEMY_FULL_BUY" if i % 2 else "ENEMY_ECO" for i in range(rows)],
            "map_name": ["Ascent"] * rows, "side": ["attack"] * rows,
        })

    def test_dataset_contract_excludes_forbidden_features(self):
        dataset = build_round_win_dataset(self._source())
        validation = validate_round_win_dataset(dataset)
        self.assertTrue(validation["valid"])
        self.assertTrue(set(ROUND_WIN_FEATURES).issubset(dataset.columns))
        self.assertEqual(validate_round_win_features({"current_round_damage": 1}), ["current_round_damage"])
        self.assertNotIn("current_round_damage", dataset.columns)
        self.assertGreater(dataset["enemy_projected_weapon_value"].max(), 0)
        full = dataset[self._source()["enemy_economy_case"] == "ENEMY_FULL_BUY"]
        eco = dataset[self._source()["enemy_economy_case"] == "ENEMY_ECO"]
        self.assertGreater(full["enemy_projected_weapon_value"].mean(),
                           eco["enemy_projected_weapon_value"].mean())

    def test_training_writes_loadable_artifact_and_predicts(self):
        dataset = build_round_win_dataset(self._source())
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "round_win.joblib"
            result = train_round_win_model(dataset, artifact_path=artifact, min_samples=20)
            self.assertTrue(result["available"])
            model = RoundWinLoadoutModel(artifact)
            features = dataset.iloc[0][ROUND_WIN_FEATURES].to_dict()
            prediction = model.predict_round_win(features)
            self.assertTrue(prediction["available"])
            self.assertGreaterEqual(prediction["round_win_probability"], 0)
            self.assertLessEqual(prediction["round_win_probability"], 1)

    def test_batch_predictions_match_single_predictions(self):
        dataset = build_round_win_dataset(self._source())
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "round_win.joblib"
            train_round_win_model(dataset, artifact_path=artifact, min_samples=20)
            model = RoundWinLoadoutModel(artifact)
            rows = [
                dataset.iloc[index][ROUND_WIN_FEATURES].to_dict()
                for index in range(3)
            ]
            singles = [model.predict_round_win(row) for row in rows]
            batched = model.predict_round_wins(rows)
            for batch_item, single_item in zip(batched, singles):
                self.assertAlmostEqual(
                    batch_item["round_win_probability"],
                    single_item["round_win_probability"],
                    places=12,
                )

    def test_insufficient_dataset_does_not_publish(self):
        dataset = build_round_win_dataset(self._source(4))
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "round_win.joblib"
            result = train_round_win_model(dataset, artifact_path=artifact, min_samples=20)
            self.assertFalse(result["available"])
            self.assertFalse(artifact.exists())

    def test_old_enemy_unaware_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "round_win_v1.joblib"
            joblib.dump({"feature_version": "round-win-loadout-v1", "pipeline": object()}, artifact)
            self.assertFalse(RoundWinLoadoutModel(artifact).available())

    def test_split_keeps_matches_disjoint_and_temporal(self):
        dataset = build_round_win_dataset(self._source(100))
        train, calibration, test = _temporal_split(dataset)
        self.assertTrue(set(train.match_id).isdisjoint(calibration.match_id))
        self.assertTrue(set(train.match_id).isdisjoint(test.match_id))
        self.assertTrue(set(calibration.match_id).isdisjoint(test.match_id))
        self.assertLess(train.game_start_millis.max(), calibration.game_start_millis.min())
        self.assertLess(calibration.game_start_millis.max(), test.game_start_millis.min())

    def test_policy_split_has_four_disjoint_temporal_blocks(self):
        dataset = build_round_win_dataset(self._source(120))
        train, calibration, selection, test = _temporal_policy_split(dataset)
        blocks = [train, calibration, selection, test]
        for index, left in enumerate(blocks):
            for right in blocks[index + 1:]:
                self.assertTrue(set(left.match_id).isdisjoint(right.match_id))
        self.assertLess(train.game_start_millis.max(), calibration.game_start_millis.min())
        self.assertLess(calibration.game_start_millis.max(), selection.game_start_millis.min())
        self.assertLess(selection.game_start_millis.max(), test.game_start_millis.min())

    def test_action_values_do_not_double_count_armor(self):
        source = self._source(2)
        source["action_total_loadout_value"] = 10000
        source["action_armor_value"] = 5000
        source["action_utility_value"] = 1000
        dataset = build_round_win_dataset(source)
        self.assertEqual(dataset.iloc[0]["team_weapon_value"], 4000)
        self.assertEqual(dataset.iloc[0]["team_armor_value"], 5000)
        self.assertEqual(dataset.iloc[0]["team_utility_value"], 1000)


if __name__ == "__main__":
    unittest.main()
