from __future__ import annotations

from typing import Any

from .buy_classifier import (
    is_heavy_armor, is_light_armor, is_marshal, is_operator, is_outlaw, is_regen_armor,
    is_rifle, is_sheriff, is_smg, is_sniper,
)

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


def observed_action_features(economies: list[dict]) -> dict[str, float | int]:
    weapons = [economy.get("weapon") for economy in economies]
    armors = [economy.get("armor") for economy in economies]
    number = lambda value: float(value or 0)
    heavy = sum(is_heavy_armor(armor) for armor in armors)
    light = sum(is_light_armor(armor) for armor in armors)
    regen = sum(is_regen_armor(armor) for armor in armors)
    strong_armor = heavy + regen
    total_loadout = sum(number(e.get("loadoutValue")) for e in economies)
    armor_value = heavy * 1000 + regen * 650 + light * 400
    total_spend = sum(number(e.get("spent")) for e in economies)
    remaining = sum(number(e.get("remaining")) for e in economies)
    return {
        "action_weapon_value": max(0.0, total_loadout - armor_value),
        "action_armor_value": armor_value, "action_utility_value": 0.0,
        "action_total_loadout_value": total_loadout, "action_total_spend": total_spend,
        "action_expected_remaining": remaining,
        "action_total_loadout": sum(number(e.get("loadoutValue")) for e in economies),
        "action_total_spent": sum(number(e.get("spent")) for e in economies),
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
        "action_sheriff_count": sum(is_sheriff(w) for w in weapons),
        "action_players_without_heavy_armor": max(0, len(economies) - heavy),
        "action_players_without_strong_armor": max(0, len(economies) - strong_armor),
    }


def simulate_action_features(state: dict[str, Any], action: str) -> dict[str, float | int]:
    template = ACTION_TEMPLATES[action]
    credits = float(state.get("team_estimated_credits_before_buy") or 0)
    spend = min(credits, float(template["spend"]))
    ratio = min(1.0, credits / max(float(template["spend"]), 1.0))
    count = lambda key: int(round(float(template.get(key, 0)) * ratio))
    heavy, regen, light = count("heavy"), count("regen"), count("light")
    operator, outlaw, marshal = count("operator"), count("outlaw"), count("marshal")
    total_loadout = min(credits, float(template["loadout"]))
    armor_value = heavy * 1000 + regen * 650 + light * 400
    return {
        "action_weapon_value": max(0.0, total_loadout - armor_value),
        "action_armor_value": armor_value, "action_utility_value": 0.0,
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
        "action_marshal_count": marshal, "action_sheriff_count": count("sheriff"),
        "action_players_without_heavy_armor": max(0, 5 - heavy),
        "action_players_without_strong_armor": max(0, 5 - heavy - regen),
    }


def minimum_action_credits(action: str) -> float:
    return float(ACTION_TEMPLATES[action]["spend"])
