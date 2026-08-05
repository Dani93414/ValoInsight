from __future__ import annotations

from typing import Any

import pandas as pd

from .round_win_model import FORBIDDEN_ROUND_WIN_FEATURES, validate_round_win_features


ROUND_WIN_FEATURES = [
    "team_weapon_value", "team_armor_value", "team_utility_value",
    "enemy_projected_weapon_value", "enemy_projected_armor_value", "enemy_projected_utility_value",
    "rifle_count", "operator_count", "smg_count", "sidearm_count", "heavy_weapon_count",
    "classic_count", "shorty_count", "frenzy_count", "ghost_count", "sheriff_count",
    "heavy_shield_count", "regen_shield_count", "light_shield_count", "ultimate_ready_count",
    "map", "side", "round_number", "score_diff", "loss_streak",
    "team_credits_total", "team_credits_median", "enemy_credits_total", "enemy_credits_median",
    "agent_roles", "utility_types_available", "player_weapon_fit_scores", "enemy_buy_class",
]
CATEGORICAL_ROUND_WIN_FEATURES = ["map", "side", "agent_roles", "utility_types_available", "enemy_buy_class"]
NUMERIC_ROUND_WIN_FEATURES = [name for name in ROUND_WIN_FEATURES if name not in CATEGORICAL_ROUND_WIN_FEATURES]
RARE_BUT_ACTIONABLE_FEATURES = {
    "classic_count", "shorty_count", "frenzy_count", "ghost_count", "sheriff_count",
}


def _series(frame: pd.DataFrame, name: str, default: Any = 0) -> pd.Series:
    if name in frame:
        return frame[name]
    return pd.Series([default] * len(frame), index=frame.index)


def _enemy_projected_values(source: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Build training treatment values; inference uses pre-round projections."""
    credits = pd.to_numeric(_series(source, "enemy_estimated_credits_before_buy"), errors="coerce").fillna(0)
    case = _series(source, "enemy_economy_case", "ENEMY_UNKNOWN").fillna("ENEMY_UNKNOWN").astype(str)
    weapon = pd.Series(credits * .38, index=source.index).clip(upper=7000)
    armor = pd.Series(credits * .14, index=source.index).clip(upper=2500)
    utility = pd.Series(credits * .07, index=source.index).clip(upper=1400)
    profiles = {
        "ENEMY_FULL_BUY": (.55, 14500, .20, 5000, .10, 2500),
        "ENEMY_HALF_BUY": (.45, 8000, .18, 3000, .08, 1800),
        "ENEMY_FORCE": (.45, 9000, .16, 3000, .08, 1800),
        "ENEMY_ECO": (.30, 3000, .10, 1200, .08, 1000),
        "ENEMY_BONUS": (.42, 9000, .18, 3500, .08, 1600),
    }
    for label, (wr, wc, ar, ac, ur, uc) in profiles.items():
        mask = case == label
        weapon.loc[mask] = (credits.loc[mask] * wr).clip(upper=wc)
        armor.loc[mask] = (credits.loc[mask] * ar).clip(upper=ac)
        utility.loc[mask] = (credits.loc[mask] * ur).clip(upper=uc)
    pistol = case == "ENEMY_PISTOL"
    weapon.loc[pistol], armor.loc[pistol], utility.loc[pistol] = 0, 0, 1000

    # When historical enemy treatment columns exist, prefer them for training.
    # These are never read at inference, where enemy_economy projects pre-round values.
    observed_total = pd.to_numeric(_series(source, "enemy_action_total_loadout"), errors="coerce")
    heavy = pd.to_numeric(_series(source, "enemy_action_heavy_armor_count"), errors="coerce").fillna(0)
    regen = pd.to_numeric(_series(source, "enemy_action_regen_armor_count"), errors="coerce").fillna(0)
    light = pd.to_numeric(_series(source, "enemy_action_light_armor_count"), errors="coerce").fillna(0)
    observed_armor = heavy * 1000 + regen * 650 + light * 400
    observed_utility = pd.to_numeric(_series(source, "enemy_plan_estimated_ability_spend"), errors="coerce").fillna(0)
    observed = observed_total.notna() & (observed_total > 0)
    armor.loc[observed] = observed_armor.loc[observed]
    utility.loc[observed] = observed_utility.loc[observed]
    weapon.loc[observed] = (observed_total.loc[observed] - observed_armor.loc[observed] - observed_utility.loc[observed]).clip(lower=0)
    return weapon, armor, utility


def validate_round_win_dataset(frame: pd.DataFrame) -> dict[str, Any]:
    leaked = sorted(FORBIDDEN_ROUND_WIN_FEATURES.intersection(frame.columns))
    missing = [name for name in ROUND_WIN_FEATURES + ["round_won"] if name not in frame]
    valid_labels = int(pd.to_numeric(frame.get("round_won"), errors="coerce").notna().sum()) if "round_won" in frame else 0
    report = feature_quality_report(frame)
    return {"valid": not leaked and not missing and valid_labels > 0, "rows": len(frame),
            "valid_labels": valid_labels, "forbidden_features": leaked, "missing_features": missing,
            "feature_version": "round-win-loadout-v4", "feature_report": report,
            "excluded_feature_candidates": [
                name for name, item in report.items()
                if item["nunique"] <= 1
                or (
                    item["default_rate"] >= .98
                    and name not in RARE_BUT_ACTIONABLE_FEATURES
                )
            ]}


def feature_quality_report(frame: pd.DataFrame) -> dict[str, dict[str, Any]]:
    report: dict[str, dict[str, Any]] = {}
    defaults = {name: "unknown" for name in CATEGORICAL_ROUND_WIN_FEATURES}
    defaults["enemy_buy_class"] = "ENEMY_UNKNOWN"
    for name in ROUND_WIN_FEATURES:
        series = frame[name] if name in frame else pd.Series(index=frame.index, dtype="object")
        missing_rate = float(series.isna().mean()) if len(series) else 1.0
        default = defaults.get(name, 0)
        default_rate = float((series.fillna(default).astype(str).str.lower() == str(default).lower()).mean()) if len(series) else 1.0
        numeric = pd.to_numeric(series, errors="coerce")
        item: dict[str, Any] = {"missing_rate": missing_rate, "default_rate": default_rate,
                                "nunique": int(series.nunique(dropna=True)), "coverage": 1.0 - missing_rate,
                                "origin": "shared_economy_action_contract", "available_in_training": name in frame,
                                "available_in_inference": True}
        if numeric.notna().any():
            item.update({"std": float(numeric.std(ddof=0)), "min": float(numeric.min()), "max": float(numeric.max()),
                         "percentiles": {str(p): float(numeric.quantile(p / 100)) for p in (5, 25, 50, 75, 95)}})
        report[name] = item
    return report


def build_round_win_dataset(economy_dataset: pd.DataFrame) -> pd.DataFrame:
    source = economy_dataset.copy()
    result = pd.DataFrame(index=source.index)
    # Observed action fields are the historical treatment. At inference these are
    # replaced by each legal simulated candidate, never by unknown future data.
    calculated_armor = (
        pd.to_numeric(_series(source, "action_heavy_armor_count"), errors="coerce").fillna(0) * 1000
        + pd.to_numeric(_series(source, "action_regen_armor_count"), errors="coerce").fillna(0) * 650
        + pd.to_numeric(_series(source, "action_light_armor_count"), errors="coerce").fillna(0) * 400
    )
    total_loadout = pd.to_numeric(_series(source, "action_total_loadout_value", None), errors="coerce")
    legacy_total = pd.to_numeric(_series(source, "action_total_loadout"), errors="coerce").fillna(0)
    result["team_armor_value"] = pd.to_numeric(_series(source, "action_armor_value", None), errors="coerce").fillna(calculated_armor)
    result["team_utility_value"] = pd.to_numeric(_series(source, "action_utility_value", None), errors="coerce").fillna(
        pd.to_numeric(_series(source, "plan_estimated_ability_spend"), errors="coerce").fillna(0))
    result["team_weapon_value"] = pd.to_numeric(_series(source, "action_weapon_value", None), errors="coerce").fillna(
        (total_loadout.fillna(legacy_total) - result["team_armor_value"] - result["team_utility_value"]).clip(lower=0))
    enemy_weapon, enemy_armor, enemy_utility = _enemy_projected_values(source)
    result["enemy_projected_weapon_value"] = enemy_weapon
    result["enemy_projected_armor_value"] = enemy_armor
    result["enemy_projected_utility_value"] = enemy_utility
    mappings = {
        "rifle_count": "action_rifle_count", "operator_count": "action_operator_count",
        "smg_count": "action_smg_count", "heavy_shield_count": "action_heavy_armor_count",
        "classic_count": "action_classic_count", "shorty_count": "action_shorty_count",
        "frenzy_count": "action_frenzy_count", "ghost_count": "action_ghost_count",
        "sheriff_count": "action_sheriff_count",
        "regen_shield_count": "action_regen_armor_count", "light_shield_count": "action_light_armor_count",
        "round_number": "round_number", "score_diff": "score_diff", "loss_streak": "loss_streak",
        "team_credits_total": "team_estimated_credits_before_buy",
        "enemy_credits_total": "enemy_estimated_credits_before_buy",
    }
    for target, origin in mappings.items():
        result[target] = pd.to_numeric(_series(source, origin), errors="coerce").fillna(0)
    result["sidearm_count"] = sum(
        result[name] for name in (
            "classic_count", "shorty_count", "frenzy_count", "ghost_count", "sheriff_count",
        )
    )
    result["heavy_weapon_count"] = 0
    result["ultimate_ready_count"] = pd.to_numeric(_series(source, "team_ultimates_ready"), errors="coerce").fillna(0)
    result["team_credits_median"] = pd.to_numeric(_series(source, "team_credit_median"), errors="coerce").fillna(0)
    result["enemy_credits_median"] = pd.to_numeric(_series(source, "enemy_credit_median"), errors="coerce").fillna(0)
    result["map"] = _series(source, "map_name", "UNKNOWN").fillna("UNKNOWN").astype(str)
    result["side"] = _series(source, "side", "unknown").fillna("unknown").astype(str)
    result["agent_roles"] = _series(source, "team_role_signature", "unknown").fillna("unknown").astype(str)
    result["utility_types_available"] = _series(source, "team_utility_signature", "unknown").fillna("unknown").astype(str)
    result["player_weapon_fit_scores"] = pd.to_numeric(_series(source, "team_avg_weapon_fit_score"), errors="coerce").fillna(.5)
    result["enemy_buy_class"] = _series(source, "enemy_economy_case", "ENEMY_UNKNOWN").fillna("ENEMY_UNKNOWN").astype(str)
    result["round_won"] = pd.to_numeric(_series(source, "round_won", None), errors="coerce")
    result["game_start_millis"] = pd.to_numeric(_series(source, "game_start_millis"), errors="coerce").fillna(0)
    result["match_id"] = _series(source, "match_id", "UNKNOWN").astype(str)
    validate_round_win_features({name: None for name in ROUND_WIN_FEATURES}, raise_on_error=True)
    return result
