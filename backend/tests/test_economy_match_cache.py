import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from modules.economy_ml import match_analysis_cache


class EconomyMatchAnalysisCacheTests(unittest.TestCase):
    def setUp(self):
        match_analysis_cache.clear_match_economy_analysis_cache()

    def tearDown(self):
        match_analysis_cache.clear_match_economy_analysis_cache()

    @staticmethod
    def _match(document_id: str = "mongo-1") -> dict:
        return {
            "_id": document_id,
            "matchInfo": {"matchId": "match-1", "gameStartMillis": 123},
            "roundResults": [{"roundNum": 1, "winningTeam": "Blue"}],
        }

    @patch.object(match_analysis_cache, "_artifact_revision", return_value=(("model", 1, 1),))
    @patch.object(match_analysis_cache, "recommend_match_economy")
    def test_identical_match_and_artifacts_reuse_analysis(self, recommend, _revision):
        recommend.return_value = {"available": True, "rounds": []}

        first = match_analysis_cache.get_match_economy_analysis(self._match())
        second = match_analysis_cache.get_match_economy_analysis(self._match())

        self.assertIs(first, second)
        recommend.assert_called_once()

    @patch.object(match_analysis_cache, "_artifact_revision", return_value=(("model", 1, 1),))
    @patch.object(match_analysis_cache, "recommend_match_economy")
    def test_replaced_match_document_invalidates_analysis(self, recommend, _revision):
        recommend.side_effect = [
            {"available": True, "revision": 1},
            {"available": True, "revision": 2},
        ]

        first = match_analysis_cache.get_match_economy_analysis(self._match("mongo-1"))
        second = match_analysis_cache.get_match_economy_analysis(self._match("mongo-2"))

        self.assertEqual(first["revision"], 1)
        self.assertEqual(second["revision"], 2)
        self.assertEqual(recommend.call_count, 2)

    def test_deployment_metadata_is_part_of_artifact_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "global_model.joblib").write_bytes(b"model")
            (root / "metadata.json").write_text(
                '{"deployment_mode":"experimental_full"}', encoding="utf-8",
            )
            with patch.object(match_analysis_cache, "_ARTIFACTS_DIR", root):
                revision = match_analysis_cache._artifact_revision()
        self.assertEqual(
            {item[0] for item in revision},
            {"global_model.joblib", "metadata.json"},
        )
