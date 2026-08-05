import unittest
from unittest.mock import MagicMock, patch

from modules.players.application import player_dashboard_service
from modules.regions.application import agent_stats_service
from modules.regions.infrastructure import mongo_region_repo


class PerformanceContractsTest(unittest.TestCase):
    def setUp(self):
        agent_stats_service._agent_stats_cache.clear()
        player_dashboard_service._RANK_COMPARISON_CACHE.clear()

    @patch.object(agent_stats_service, "_build_options_cached", return_value={})
    @patch.object(agent_stats_service, "regions_collection")
    def test_unfiltered_agent_stats_reuse_precomputed_region(
        self,
        regions_collection,
        _options,
    ):
        regions_collection.find.return_value = [
            {
                "region": "EU",
                "totalMatches": 12,
                "agentStats": {"agent-1": {"picks": 7}},
            }
        ]

        payload = agent_stats_service.get_global_agent_stats(region="eu")

        self.assertEqual(payload["statsSource"], "regions_precomputed")
        self.assertEqual(payload["sampleSize"], {"matches": 12, "picks": 7, "agents": 1})
        projection = regions_collection.find.call_args.args[1]
        self.assertEqual(
            set(projection),
            {"_id", "region", "agentStats", "totalMatches", "updatedAt"},
        )

    @patch.object(player_dashboard_service, "_compute_player_rank_comparison")
    def test_rank_comparison_is_cached_for_identical_filters(self, compute):
        compute.return_value = {"sampleSize": 20}

        first = player_dashboard_service.get_player_rank_comparison(
            "player-1",
            season_id="act-1",
        )
        second = player_dashboard_service.get_player_rank_comparison(
            "player-1",
            season_id="act-1",
        )

        self.assertEqual(first, second)
        compute.assert_called_once()

    def test_dashboard_analytics_remove_repeated_nested_payloads(self):
        compact = player_dashboard_service._build_light_analytics_list(
            [
                {
                    "match_id": "match-1",
                    "overview": {
                        "kills": 10,
                        "rounds": 20,
                        "weapon_stats": {
                            "vandal": {
                                "weapon_name": "Vandal",
                                "kills": 8,
                                "rounds": 12,
                                "round_details": [{"round": 1}],
                                "unused_large_payload": {"raw": [1, 2, 3]},
                            }
                        },
                    },
                    "sides": {
                        "attack": {
                            "rounds": 10,
                            "kills": 6,
                            "weapon_stats": {"vandal": {"kills": 5}},
                        }
                    },
                }
            ]
        )

        weapon = compact[0]["overview"]["weapon_stats"][0]
        self.assertEqual(weapon["weapon_name"], "Vandal")
        self.assertNotIn("round_details", weapon)
        self.assertNotIn("unused_large_payload", weapon)
        self.assertEqual(compact[0]["sides"]["attack"], {"rounds": 10, "kills": 6})

    @patch.object(mongo_region_repo, "regions_collection")
    def test_region_summary_projection_excludes_heavy_sections(self, collection):
        cursor = MagicMock()
        cursor.sort.return_value = []
        collection.find.return_value = cursor

        mongo_region_repo.get_summaries()

        projection = collection.find.call_args.args[1]
        self.assertEqual(projection["mostPlayedAgents"], {"$slice": 1})
        self.assertNotIn("agentStats", projection)
        self.assertNotIn("mapStats", projection)
        self.assertNotIn("weaponStats", projection)


if __name__ == "__main__":
    unittest.main()
