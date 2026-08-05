from __future__ import annotations

import unittest

from modules.matches.infrastructure.mongo_match_repo import _has_round_economy


class MongoMatchRepositoryTests(unittest.TestCase):
    def test_detects_economy_inside_nested_round_player_arrays(self):
        match = {
            "roundResults": [{
                "playerStats": [{"puuid": "p1", "economy": {"remaining": 800}}],
            }],
        }
        self.assertTrue(_has_round_economy(match))

    def test_rejects_missing_or_empty_economy(self):
        self.assertFalse(_has_round_economy({"roundResults": []}))
        self.assertFalse(_has_round_economy({
            "roundResults": [{"playerStats": [{"economy": {}}]}],
        }))


if __name__ == "__main__":
    unittest.main()
