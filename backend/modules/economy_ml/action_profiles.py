from __future__ import annotations

from typing import Any

import pandas as pd

from .buy_classifier import (
    is_heavy_armor, is_light_armor, is_marshal, is_operator, is_outlaw, is_regen_armor,
    is_rifle, is_sheriff, is_smg, is_sniper,
)
from .content_catalog import find_gear, find_weapon

ACTION_TEMPLATES: dict[str, dict[str, float | int]] = {
    "ECO_CLASSIC": {"spend": 0, "loadout": 0},
    "ECO_PISTOL_UPGRADE": {"spend": 2500, "loadout": 2500},
    "ECO_ONE_SHERIFF": {"spend": 800, "loadout": 800, "sheriff": 1},
    "ECO_TWO_SHERIFFS": {"spend": 1600, "loadout": 1600, "sheriff": 2},
    "ECO_SHERIFF": {"spend": 1600, "loadout": 1600, "sheriff": 2},
    "ECO_SHERIFF_STACK": {"spend": 4000, "loadout": 4000, "sheriff": 5},
    "SEMI_SMG": {"spend": 9000, "loadout": 9000, "smg": 3, "light": 3},
    "SEMI_MARSHAL": {"spend": 7500, "loadout": 7500, "marshal": 2, "light": 2},
    "FORCE_OUTLAW": {"spend": 10500, "loadout": 10500, "outlaw": 2, "light": 2},
    "FORCE_RIFLE_LIGHT": {"spend": 14250, "loadout": 14250, "rifle": 2, "regen": 1, "light": 2},
    "FORCE_2_RIFLES": {"spend": 15000, "loadout": 15000, "rifle": 2, "heavy": 2},
    "FULL_RIFLES": {"spend": 20500, "loadout": 20500, "rifle": 5, "heavy": 5},
    "FULL_OPERATOR": {"spend": 23000, "loadout": 23000, "operator": 1, "rifle": 4, "heavy": 5},
    "BONUS_KEEP_WEAPONS": {"spend": 4500, "loadout": 13500, "smg": 3, "heavy": 3},
    "MIXED_LOW_BUY": {"spend": 7000, "loadout": 7000, "rifle": 1, "smg": 1, "light": 2},
}

PROFILE_FEATURES = (
    "action_weapon_value", "action_armor_value", "action_utility_value",
    "action_total_loadout_value", "action_total_spend",
    "action_heavy_armor_count", "action_regen_armor_count",
    "action_light_armor_count", "action_no_armor_count",
    "action_rifle_count", "action_smg_count", "action_sniper_count",
    "action_operator_count", "action_outlaw_count", "action_marshal_count",
    "action_classic_count", "action_shorty_count", "action_frenzy_count",
    "action_ghost_count", "action_sheriff_count", "action_players_without_heavy_armor",
    "action_players_without_strong_armor",
)
COUNT_PROFILE_FEATURES = {name for name in PROFILE_FEATURES if name.endswith("_count")}
OPTIONAL_PISTOL_COUNT_FEATURES = {
    "action_classic_count", "action_shorty_count", "action_frenzy_count",
    "action_ghost_count",
}


def learn_action_profiles(frame: pd.DataFrame, *, min_samples: int = 25) -> dict[str, dict[str, float]]:
    """Learn robust action prototypes from training data only.

    Counterfactual rows must live in the same feature space as factual rows.  In
    particular, Henrik loadout values include utility, while the old templates
    forced candidate utility to zero and folded it into weapon value.
    """
    required = {"real_buy_action", *(set(PROFILE_FEATURES) - OPTIONAL_PISTOL_COUNT_FEATURES)}
    if frame.empty or not required.issubset(frame.columns):
        return {}
    profiles: dict[str, dict[str, float]] = {}
    for action, rows in frame.groupby("real_buy_action"):
        if len(rows) < min_samples:
            continue
        profile = {
            feature: float(pd.to_numeric(
                rows[feature] if feature in rows else pd.Series(0, index=rows.index),
                errors="coerce",
            ).median())
            for feature in PROFILE_FEATURES
        }
        profile["samples"] = float(len(rows))
        profiles[str(action)] = profile
    return profiles


def observed_action_features(economies: list[dict]) -> dict[str, float | int]:
    weapons = [economy.get("weapon") for economy in economies]
    armors = [economy.get("armor") for economy in economies]
    number = lambda value: float(value or 0)
    heavy = sum(is_heavy_armor(armor) for armor in armors)
    light = sum(is_light_armor(armor) for armor in armors)
    regen = sum(is_regen_armor(armor) for armor in armors)
    strong_armor = heavy + regen
    total_loadout = sum(number(e.get("loadoutValue")) for e in economies)
    armor_value = sum(number((find_gear(e.get("armor")) or {}).get("cost")) for e in economies)
    weapon_value = sum(number((find_weapon(e.get("weapon")) or {}).get("cost")) for e in economies)
    utility_value = max(0.0, total_loadout - armor_value - weapon_value)
    total_spend = sum(number(
        e.get("totalOutlay") if e.get("totalOutlay") is not None else e.get("derivedSpend")
    ) for e in economies)
    remaining = sum(number(e.get("remaining")) for e in economies)
    weapon_names = [
        str((find_weapon(value) or {}).get("displayName") or value or "").strip().lower()
        for value in weapons
    ]
    return {
        "action_weapon_value": weapon_value,
        "action_armor_value": armor_value, "action_utility_value": utility_value,
        "action_total_loadout_value": total_loadout, "action_total_spend": total_spend,
        "action_expected_remaining": remaining,
        "action_total_loadout": sum(number(e.get("loadoutValue")) for e in economies),
        "action_total_spent": total_spend,
        "action_total_remaining": sum(number(e.get("remaining")) for e in economies),
        "action_heavy_armor_count": heavy, "action_regen_armor_count": regen,
        "action_light_armor_count": light,
        "action_no_armor_count": max(0, len(economies) - heavy - regen - light),
        "action_rifle_count": sum(is_rifle(w) for w in weapons),
        "action_smg_count": sum(is_smg(w) for w in weapons),
        "action_sniper_count": sum(is_sniper(w) for w in weapons),
        "action_operator_count": sum(is_operator(w) for w in weapons),
        "action_outlaw_count": sum(is_outlaw(w) for w in weapons),
        "action_marshal_count": sum(is_marshal(w) for w in weapons),
        "action_classic_count": sum(name == "classic" for name in weapon_names),
        "action_shorty_count": sum(name == "shorty" for name in weapon_names),
        "action_frenzy_count": sum(name == "frenzy" for name in weapon_names),
        "action_ghost_count": sum(name == "ghost" for name in weapon_names),
        "action_sheriff_count": sum(is_sheriff(w) for w in weapons),
        "action_players_without_heavy_armor": max(0, len(economies) - heavy),
        "action_players_without_strong_armor": max(0, len(economies) - strong_armor),
    }


def simulate_action_features(
    state: dict[str, Any],
    action: str,
    learned_profile: dict[str, float] | None = None,
) -> dict[str, float | int]:
    template = ACTION_TEMPLATES[action]
    credits = float(state.get("team_estimated_credits_before_buy") or 0)
    if learned_profile:
        requested_spend = max(0.0, float(learned_profile.get("action_total_spend") or 0))
        spend = min(credits, requested_spend)
        affordability = min(1.0, credits / max(requested_spend, 1.0))
        result: dict[str, float | int] = {}
        for feature in PROFILE_FEATURES:
            value = max(0.0, float(learned_profile.get(feature) or 0))
            # Counts describe discrete team loadouts. Scale them only when the
            # team cannot afford the representative action.
            result[feature] = int(round(value * affordability)) if feature in COUNT_PROFILE_FEATURES else value * affordability
        weapon = float(result["action_weapon_value"])
        armor = float(result["action_armor_value"])
        utility = float(result["action_utility_value"])
        loadout = weapon + armor + utility
        result.update({
            "action_total_loadout_value": loadout,
            "action_total_spend": spend,
            "action_expected_remaining": max(0.0, credits - spend),
            "action_total_loadout": loadout,
            "action_total_spent": spend,
            "action_total_remaining": max(0.0, credits - spend),
        })
        return result
    spend = min(credits, float(template["spend"]))
    ratio = min(1.0, credits / max(float(template["spend"]), 1.0))
    count = lambda key: int(round(float(template.get(key, 0)) * ratio))
    heavy, regen, light = count("heavy"), count("regen"), count("light")
    operator, outlaw, marshal = count("operator"), count("outlaw"), count("marshal")
    total_loadout = min(credits, float(template["loadout"]))
    armor_value = heavy * 1000 + regen * 650 + light * 400
    weapon_value = (
        count("operator") * 4700 + count("outlaw") * 2400 + count("marshal") * 950
        + count("rifle") * 2900 + count("smg") * 1600 + count("sheriff") * 800
    )
    utility_value = max(0.0, total_loadout - weapon_value - armor_value)
    return {
        "action_weapon_value": weapon_value,
        "action_armor_value": armor_value, "action_utility_value": utility_value,
        "action_total_loadout_value": total_loadout, "action_total_spend": spend,
        "action_expected_remaining": max(0.0, credits - spend),
        "action_total_loadout": min(credits, float(template["loadout"])),
        "action_total_spent": spend, "action_total_remaining": max(0.0, credits - spend),
        "action_heavy_armor_count": heavy, "action_regen_armor_count": regen,
        "action_light_armor_count": light,
        "action_no_armor_count": max(0, 5 - heavy - regen - light),
        "action_rifle_count": count("rifle"), "action_smg_count": count("smg"),
        "action_sniper_count": operator + outlaw + marshal,
        "action_operator_count": operator, "action_outlaw_count": outlaw,
        "action_marshal_count": marshal,
        "action_classic_count": 5 if action == "ECO_CLASSIC" else 0,
        "action_shorty_count": 0, "action_frenzy_count": 0,
        "action_ghost_count": 0, "action_sheriff_count": count("sheriff"),
        "action_players_without_heavy_armor": max(0, 5 - heavy),
        "action_players_without_strong_armor": max(0, 5 - heavy - regen),
    }


def minimum_action_credits(action: str) -> float:
    return float(ACTION_TEMPLATES[action]["spend"])
