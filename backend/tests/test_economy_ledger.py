import unittest

from modules.economy_ml.afk_compensation import infer_afk_compensation_from_reconciliation
from modules.economy_ml.economy_income_rules import (
    round_result_income,
    save_penalty_applies,
)
from modules.economy_ml.economy_ledger import (
    build_match_economy_ledger,
    build_player_round_ledger,
)
from modules.economy_ml.economy_reconciliation import reconcile_expected_vs_observed
from modules.economy_ml.state_extractor import extract_match_round_states


def _players():
    return [{"puuid": f"A{i}", "teamId": "A"} for i in range(5)] + [
        {"puuid": f"B{i}", "teamId": "B"} for i in range(5)
    ]


def _stats(remaining=300, spent=500, loadout=500, weapon="Classic", armor=None):
    return [
        {
            "puuid": player["puuid"],
            "economy": {
                "remaining": remaining,
                "spent": spent,
                "loadoutValue": loadout,
                "weapon": weapon,
                "armor": armor,
            },
            "kills": [],
        }
        for player in _players()
    ]


def _match(rounds):
    return {
        "matchInfo": {
            "matchId": "ledger-match",
            "queueId": "competitive",
            "isRanked": True,
            "mapId": "map",
            "seasonId": "s",
            "gameStartMillis": 1000,
        },
        "players": _players(),
        "teams": [{"teamId": "A", "won": True}, {"teamId": "B", "won": False}],
        "roundResults": rounds,
    }


class EconomyLedgerTests(unittest.TestCase):
    def test_round_1_reset(self):
        match = _match([{"roundNum": 0, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": _stats()}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["credits_before_buy_estimated"], 800)

    def test_round_13_reset(self):
        match = _match([{"roundNum": 13, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": _stats()}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["round_number"], 13)
        self.assertEqual(ledger["credits_before_buy_estimated"], 800)

    def test_victory_kill_and_plant_income(self):
        stats = _stats(remaining=300, spent=500)
        stats[0]["kills"] = [{"victim": "B0"}]
        match = _match([{"roundNum": 0, "winningTeam": "A", "bombPlanter": "A0", "playerStats": stats}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["expected_next_round_credits"], 300 + 3000 + 200 + 300)

    def test_consecutive_loss_rewards(self):
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=1, save_penalty_applies=False), 1900)
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=2, save_penalty_applies=False), 2400)
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=3, save_penalty_applies=False), 2900)
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=4, save_penalty_applies=False), 2900)

    def test_save_penalty_attacker(self):
        self.assertTrue(save_penalty_applies(
            side="attack",
            team_won=False,
            player_survived=True,
            spike_planted=False,
            round_result="RoundResult_TimeExpired",
            round_ceremony=None,
        ))
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=1, save_penalty_applies=True), 1000)

    def test_save_penalty_defender(self):
        self.assertTrue(save_penalty_applies(
            side="defense",
            team_won=False,
            player_survived=True,
            spike_planted=True,
            round_result=None,
            round_ceremony="Ceremony_BombDetonated",
        ))
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=1, save_penalty_applies=True), 1000)

    def test_dead_player_does_not_receive_save_penalty(self):
        self.assertFalse(save_penalty_applies(
            side="attack",
            team_won=False,
            player_survived=False,
            spike_planted=False,
            round_result="RoundResult_TimeExpired",
            round_ceremony=None,
        ))
        self.assertEqual(round_result_income(team_won=False, loss_streak_after_round=1, save_penalty_applies=False), 1900)

    def test_kill_bonus(self):
        stats = _stats()
        stats[0]["kills"] = [{"victim": "B0"}, {"victim": "B1"}, {"victim": "B2"}]
        match = _match([{"roundNum": 0, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": stats}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["kill_income"], 600)

    def test_plant_bonus_for_attack_team(self):
        match = _match([{"roundNum": 0, "winningTeam": "A", "bombPlanter": "A0", "playerStats": _stats()}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A1", previous_player_state=None)
        self.assertEqual(ledger["plant_income"], 300)

    def test_max_credits(self):
        stats = _stats(remaining=8900, spent=0)
        match = _match([{"roundNum": 1, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": stats}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["expected_next_round_credits"], 9000)

    def test_overtime(self):
        match = _match([{"roundNum": 25, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": _stats()}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["round_number"], 25)
        self.assertEqual(ledger["credits_before_buy_estimated"], 5000)

    def test_free_light_armor_exception(self):
        stats = _stats(remaining=0, spent=800, loadout=1200, weapon="Sheriff", armor="Light")
        for stat in stats:
            stat["economy"]["totalOutlay"] = 800
        match = _match([{"roundNum": 13, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": stats}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertIn("free_light_armor_exception", ledger["flags"])

    def test_reconciliation_matched(self):
        result = reconcile_expected_vs_observed(3900, 3910)
        self.assertEqual(result["status"], "matched")

    def test_possible_afk_bonus_reconciliation(self):
        round1 = {"roundNum": 1, "winningTeam": "A", "winningTeamRole": "attack", "playerStats": _stats(remaining=900, spent=0)}
        round2_stats = _stats(remaining=4500, spent=0)
        for stat in round2_stats:
            stat["economy"]["creditsBeforeBuy"] = 4500
        match = _match([round1, {"roundNum": 2, "winningTeam": "B", "winningTeamRole": "attack", "playerStats": round2_stats}])
        ledger = build_player_round_ledger(match=match, round_index=0, team_id="A", puuid="A0", previous_player_state=None)
        self.assertEqual(ledger["reconciliation_status"], "observed_more_than_expected")
        self.assertIn("possible_afk_bonus", ledger["flags"])
        afk = infer_afk_compensation_from_reconciliation([ledger] * 10)
        self.assertEqual(afk["most_likely_bonus"], 600)

    def test_state_extractor_includes_ledger_features(self):
        round1 = {"roundNum": 0, "winningTeam": "A", "bombPlanter": "A0", "playerStats": _stats()}
        round2 = {"roundNum": 1, "winningTeam": "B", "winningTeamRole": "attack", "playerStats": _stats(remaining=3900, spent=0)}
        states = extract_match_round_states(_match([round1, round2]))
        state = next(row for row in states if row["round_number"] == 2 and row["team_id"] == "A")
        self.assertIn("team_player_credit_estimates", state)
        self.assertIn("team_economy_reconciliation_quality_score", state)
        self.assertIn("team_free_light_armor_exception_count", state)


if __name__ == "__main__":
    unittest.main()
