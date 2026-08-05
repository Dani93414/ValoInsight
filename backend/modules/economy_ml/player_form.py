from __future__ import annotations

from typing import Any


def _display_round(raw_round: Any, index: int) -> int:
    try:
        value = int(raw_round)
        return value + 1 if value == index else value
    except (TypeError, ValueError):
        return index + 1


def _round_player_stat(match: dict[str, Any], puuid: str, round_number: int) -> dict[str, Any]:
    for index, round_obj in enumerate(match.get("roundResults") or []):
        if _display_round(round_obj.get("roundNum"), index) != round_number:
            continue
        for pstat in round_obj.get("playerStats") or []:
            if pstat.get("puuid") == puuid:
                return pstat
    return {}


def _count_kills(pstat: dict[str, Any], puuid: str) -> int:
    return sum(1 for kill in pstat.get("kills") or [] if kill.get("killer") == puuid)


def _damage(pstat: dict[str, Any]) -> int:
    return int(sum(float(item.get("damage") or 0) for item in pstat.get("damage") or []))


def _died_in_round(match: dict[str, Any], puuid: str, round_number: int) -> bool:
    for index, round_obj in enumerate(match.get("roundResults") or []):
        if _display_round(round_obj.get("roundNum"), index) != round_number:
            continue
        return any(
            str(kill.get("victim") or "") == str(puuid)
            for stat in round_obj.get("playerStats") or []
            for kill in stat.get("kills") or []
            if isinstance(kill, dict)
        )
    return False


def build_player_form(match: dict[str, Any], puuid: str, round_number: int) -> dict[str, Any]:
    previous = []
    for number in range(1, round_number):
        pstat = _round_player_stat(match, puuid, number)
        if not pstat:
            continue
        kills = _count_kills(pstat, puuid)
        previous.append({
            "kills": kills,
            "damage": _damage(pstat),
            "score": int(pstat.get("score") or 0),
            "death": int(_died_in_round(match, puuid, number)),
            "survived": 0,
        })
    last3 = previous[-3:]
    last5 = previous[-5:]
    kills_last_3 = sum(item["kills"] for item in last3)
    kills_last_5 = sum(item["kills"] for item in last5)
    rounds_without_kill = 0
    for item in reversed(previous):
        if item["kills"] > 0:
            break
        rounds_without_kill += 1
    rounds = max(len(previous), 1)
    total_kills = sum(item["kills"] for item in previous)
    deaths = sum(item["death"] for item in previous)
    hot = min(1.0, kills_last_3 / 6 + kills_last_5 / 15)
    cold = min(1.0, rounds_without_kill / 5 + max(0, deaths - total_kills) / max(rounds * 2, 1))
    return {
        "kills_last_3": kills_last_3,
        "kills_last_5": kills_last_5,
        "damage_last_3": sum(item["damage"] for item in last3),
        "score_last_3": sum(item["score"] for item in last3),
        "deaths_last_3": sum(item["death"] for item in last3),
        "first_deaths_last_5": None,
        "first_kills_last_5": None,
        "rounds_without_kill": rounds_without_kill,
        "survival_last_5": None,
        "current_match_kd_before_round": round(total_kills / max(deaths, 1), 4),
        "current_match_acs_before_round": round(sum(item["score"] for item in previous) / rounds, 2),
        "hot_streak_score": round(hot, 4),
        "cold_streak_score": round(cold, 4),
    }
