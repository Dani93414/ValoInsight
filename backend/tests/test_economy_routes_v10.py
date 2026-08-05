import inspect
import os
import unittest
from unittest.mock import patch

import pandas as pd

from modules.economy_ml.interfaces.routes import match_economy_ml, train_economy_ml
from modules.matches.interfaces.routes import get_match_economy_ml


MATCH = {"matchInfo": {"matchId": "m"}, "players": [], "roundResults": []}


class EconomyRoutesV10Tests(unittest.TestCase):
    def test_main_match_route_uses_player_first_engine(self):
        source = inspect.getsource(get_match_economy_ml)
        self.assertIn("get_match_economy_analysis", source)
        self.assertNotIn("predict_match_economy_recommendations", source)
        self.assertNotIn("ACTION_TEMPLATES", source)

    def test_both_routes_return_compatible_contract(self):
        with patch("modules.matches.interfaces.routes.mongo_match_repo.find_by_id", return_value=MATCH):
            main = get_match_economy_ml("m")
        with patch("modules.economy_ml.interfaces.routes.mongo_match_repo.find_by_id", return_value=MATCH):
            direct = match_economy_ml("m")
        for payload in (main, direct):
            self.assertEqual(payload["engine"], "player_first_v12_decision_grade")
            self.assertEqual(payload["compatibility_engine"], "player_first_v10")
            self.assertEqual(payload["economy_contract_version"], 12)
            self.assertEqual(payload["match_id"], "m")
            self.assertTrue(payload["available"])
            self.assertIsInstance(payload["rounds"], list)
            self.assertIsInstance(payload["limitations"], list)
        self.assertEqual(set(main), set(direct))

    def test_train_route_returns_round_win_result(self):
        frame = pd.DataFrame({"x": [1]})
        with patch.dict(os.environ, {"ECONOMY_ML_TRAIN_TOKEN": "token"}), \
             patch("modules.economy_ml.interfaces.routes.mongo_match_repo.list_training_matches", return_value=[MATCH]), \
             patch("modules.economy_ml.interfaces.routes.build_economy_dataset_from_matches", return_value=frame), \
             patch("modules.economy_ml.interfaces.routes.validate_dataset", return_value={"valid": True}), \
             patch("modules.economy_ml.interfaces.routes.save_dataset"), \
             patch("modules.economy_ml.interfaces.routes.train_models", return_value={"available": True}), \
             patch("modules.economy_ml.interfaces.routes.build_round_win_dataset", return_value=frame), \
             patch("modules.economy_ml.interfaces.routes.train_round_win_model", return_value={"available": True, "samples": 1}):
            result = train_economy_ml("token")
        self.assertTrue(result["available"])
        self.assertTrue(result["round_win_loadout"]["available"])

    def test_train_route_keeps_main_result_when_round_win_fails(self):
        frame = pd.DataFrame({"x": [1]})
        with patch.dict(os.environ, {"ECONOMY_ML_TRAIN_TOKEN": "token"}), \
             patch("modules.economy_ml.interfaces.routes.mongo_match_repo.list_training_matches", return_value=[MATCH]), \
             patch("modules.economy_ml.interfaces.routes.build_economy_dataset_from_matches", return_value=frame), \
             patch("modules.economy_ml.interfaces.routes.validate_dataset", return_value={"valid": True}), \
             patch("modules.economy_ml.interfaces.routes.save_dataset"), \
             patch("modules.economy_ml.interfaces.routes.train_models", return_value={"available": True}), \
             patch("modules.economy_ml.interfaces.routes.build_round_win_dataset", side_effect=RuntimeError("boom")):
            result = train_economy_ml("token")
        self.assertTrue(result["available"])
        self.assertFalse(result["round_win_loadout"]["available"])
        self.assertEqual(result["round_win_loadout"]["reason"], "round_win_training_failed")


if __name__ == "__main__":
    unittest.main()
