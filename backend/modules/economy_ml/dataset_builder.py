from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import pandas as pd

from modules.analytics.infrastructure.reference_data import (
    resolve_agent_name,
    resolve_agent_role,
)

from .content_catalog import find_gear, find_weapon
from .agent_utility import player_agent_utility_features
from .schemas import FORBIDDEN_FEATURES, MODEL_FEATURES, validate_no_feature_leakage
from .state_extractor import fixed_round_start_credits, extract_match_round_states

LOGGER = logging.getLogger(__name__)
DEFAULT_DATASET_PATH = Path(__file__).parent / "artifacts" / "economy_round_dataset.parquet"
NON_DATASET_STATE_COLUMNS = {
    "team_player_credit_estimates",
    "enemy_player_credit_estimates",
    "team_player_free_light_armor_exceptions",
    "enemy_player_free_light_armor_exceptions",
}


def _dataset_safe_row(row: dict) -> dict:
    return {
        key: value
        for key, value in row.items()
        if key not in NON_DATASET_STATE_COLUMNS
    }


def build_economy_dataset_from_matches(matches: list[dict]) -> pd.DataFrame:
    rows: list[dict] = []
    discarded = {
        "missing_rounds": 0, "not_ranked": 0,
        "invalid_teams_or_economy": 0, "unknown_action_rows": 0,
    }
    for match in matches:
        if not isinstance(match, dict) or not match.get("roundResults"):
            discarded["missing_rounds"] += 1
            continue
        if not bool((match.get("matchInfo") or {}).get("isRanked")):
            discarded["not_ranked"] += 1
            continue
        extracted = extract_match_round_states(match)
        if not extracted:
            discarded["invalid_teams_or_economy"] += 1
            continue
        valid_rows = [row for row in extracted if row.get("real_buy_action") != "UNKNOWN"]
        discarded["unknown_action_rows"] += len(extracted) - len(valid_rows)
        rows.extend(_dataset_safe_row(row) for row in valid_rows)
    LOGGER.info("Economy dataset: %s rows; discarded=%s", len(rows), discarded)
    return pd.DataFrame(rows)


def _number(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _display_round(raw_round, index: int) -> int:
    try:
        value = int(raw_round)
        return value + 1 if value == index else value
    except (TypeError, ValueError):
        return index + 1


def _weapon_payload(weapon_id) -> dict:
    weapon = find_weapon(weapon_id) or {}
    return {
        "player_weapon_id": weapon_id,
        "player_weapon_name": weapon.get("displayName"),
        "player_weapon_category": weapon.get("api_category"),
        "player_weapon_usage_profile": ",".join(weapon.get("usage_profile") or ["unknown"]),
    }


def _armor_payload(armor_id) -> dict:
    gear = find_gear(armor_id) or {}
    return {
        "player_armor_id": armor_id,
        "player_armor_name": gear.get("displayName"),
    }


def build_player_economy_dataset_from_matches(matches: list[dict]) -> pd.DataFrame:
    rows: list[dict] = []
    for match in matches:
        if not isinstance(match, dict) or not bool((match.get("matchInfo") or {}).get("isRanked")):
            continue
        team_states = {
            (state["round_number"], state["team_id"]): state
            for state in extract_match_round_states(match)
        }
        players_by_puuid = {
            str(player.get("puuid")): player
            for player in match.get("players") or []
            if player.get("puuid")
        }
        for index, round_obj in enumerate(match.get("roundResults") or []):
            round_number = _display_round(round_obj.get("roundNum"), index)
            for pstat in round_obj.get("playerStats") or []:
                puuid = str(pstat.get("puuid") or "")
                player = players_by_puuid.get(puuid)
                if not player:
                    continue
                team_id = str(player.get("teamId") or "")
                state = team_states.get((round_number, team_id))
                if not state:
                    continue
                economy = pstat.get("economy") or {}
                fixed_credits = fixed_round_start_credits(round_number)
                reconstructed_prebuy = _number(
                    (state.get("team_player_credit_estimates") or {}).get(puuid)
                )
                reconstructed_outlay = max(
                    0.0,
                    reconstructed_prebuy - _number(economy.get("remaining")),
                )
                agent_id = str(player.get("characterId") or "UNKNOWN")
                rows.append({
                    "match_id": state["match_id"],
                    "round_number": round_number,
                    "puuid": puuid,
                    "team_id": team_id,
                    "enemy_team_id": state["enemy_team_id"],
                    "map_id": state.get("map_id"),
                    "map_name": state.get("map_name"),
                    "side": state.get("side"),
                    "agent_id": agent_id,
                    "agent_name": resolve_agent_name(agent_id),
                    "role": resolve_agent_role(agent_id),
                    "competitive_tier": player.get("competitiveTier"),
                    "rank_name": state.get("rank_name"),
                    "rank_group": state.get("rank_group"),
                    **player_agent_utility_features(agent_id, str(state.get("side") or "unknown")),
                    "team_score_before": state.get("team_score_before"),
                    "enemy_score_before": state.get("enemy_score_before"),
                    "score_diff": state.get("score_diff"),
                    "player_remaining": _number(economy.get("remaining")),
                    "player_spent": reconstructed_outlay,
                    "player_spent_source": "derived_prebuy_minus_remaining",
                    "player_loadout": _number(economy.get("loadoutValue")),
                    "player_estimated_credits_before_buy": (
                        fixed_credits if fixed_credits is not None else reconstructed_prebuy
                    ),
                    **_weapon_payload(economy.get("weapon")),
                    **_armor_payload(economy.get("armor")),
                    "team_total_remaining": state.get("action_total_remaining"),
                    "enemy_total_remaining": None,
                    "team_total_loadout": state.get("action_total_loadout"),
                    "enemy_total_loadout": None,
                    "team_buy_action": state.get("real_buy_action"),
                    "player_buy_action": "UNKNOWN",
                    "round_won": state.get("round_won"),
                    "match_won": state.get("match_won"),
                    "historical_player_weapon_rounds": None,
                    "historical_player_weapon_kd": None,
                    "historical_player_weapon_adr": None,
                    "historical_player_weapon_win_rate": None,
                    "historical_player_weapon_damage_per_credit": None,
                })
    return pd.DataFrame(rows)


def build_economy_dataset_from_folder(input_dir: str | Path) -> pd.DataFrame:
    matches: list[dict] = []
    for path in Path(input_dir).rglob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            matches.append(payload.get("data", payload) if isinstance(payload, dict) else {})
        except (OSError, json.JSONDecodeError) as exc:
            LOGGER.warning("Ignoring %s: %s", path, exc)
    return build_economy_dataset_from_matches(matches)


def save_dataset(df: pd.DataFrame, output_path: str | Path = DEFAULT_DATASET_PATH) -> None:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)


def validate_dataset(df: pd.DataFrame) -> dict:
    expected = {feature for feature in MODEL_FEATURES if feature != "buy_action"}
    missing = sorted(expected - set(df.columns))
    leakage = validate_no_feature_leakage(MODEL_FEATURES)
    leaked = sorted(FORBIDDEN_FEATURES.intersection(MODEL_FEATURES))
    timestamp_coverage = (
        float((pd.to_numeric(df["game_start_millis"], errors="coerce").fillna(0) > 0).mean())
        if "game_start_millis" in df and len(df) else 0.0
    )
    return {
        "valid": not missing and leakage["valid"] and not df.empty and timestamp_coverage >= 0.9,
        "rows": len(df),
        "matches": int(df["match_id"].nunique()) if "match_id" in df else 0,
        "missing_model_columns": missing,
        "forbidden_model_features": leaked,
        "post_round_only_model_features": leakage["post_round_only_features"],
        "timestamp_coverage": timestamp_coverage,
        "unknown_action_rate": (
            float((df["real_buy_action"] == "UNKNOWN").mean())
            if "real_buy_action" in df and len(df) else 0.0
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the economy ML round dataset.")
    parser.add_argument("input_dir")
    parser.add_argument("--output", default=str(DEFAULT_DATASET_PATH))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    dataset = build_economy_dataset_from_folder(args.input_dir)
    save_dataset(dataset, args.output)
    print(f"Saved {len(dataset)} rows to {args.output}")


if __name__ == "__main__":
    main()
