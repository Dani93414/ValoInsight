from __future__ import annotations

from typing import Any

from .content_catalog import find_weapon, gear_armor_level, weapon_catalog_role, weapon_has_profile

BUY_ACTIONS = [
    "ECO_CLASSIC", "ECO_PISTOL_UPGRADE", "ECO_ONE_SHERIFF",
    "ECO_TWO_SHERIFFS", "ECO_SHERIFF", "ECO_SHERIFF_STACK",
    "SEMI_SMG", "SEMI_MARSHAL", "FORCE_OUTLAW", "FORCE_RIFLE_LIGHT",
    "FORCE_2_RIFLES", "FULL_RIFLES", "FULL_OPERATOR",
    "BONUS_KEEP_WEAPONS", "MIXED_LOW_BUY", "UNKNOWN",
]


def _outlay(economy: dict[str, Any]) -> float:
    for key in ("totalOutlay", "derivedSpend", "total_outlay"):
        if economy.get(key) is not None:
            return max(0.0, float(economy.get(key) or 0))
    return 0.0

def _norm(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", " ")


def _weapon_category_contains(weapon_id: Any, text: str) -> bool:
    weapon = find_weapon(weapon_id)
    if not weapon:
        return False
    haystack = " ".join([
        _norm(weapon.get("api_category")),
        _norm(weapon.get("categoryText")),
        _norm(weapon.get("displayName")),
    ])
    return _norm(text) in haystack


def _weapon_name_contains(weapon_id: Any, text: str) -> bool:
    weapon = find_weapon(weapon_id)
    return bool(_norm(text) in _norm((weapon or {}).get("displayName") or weapon_id))


def is_rifle(weapon_id: Any) -> bool: return weapon_catalog_role(weapon_id) == "rifle"
def is_smg(weapon_id: Any) -> bool: return weapon_catalog_role(weapon_id) == "smg" or _weapon_category_contains(weapon_id, "smg")
def is_machine_gun(weapon_id: Any) -> bool: return weapon_catalog_role(weapon_id) == "heavy" or weapon_has_profile(weapon_id, "machine_gun")
def is_shotgun(weapon_id: Any) -> bool: return weapon_catalog_role(weapon_id) == "shotgun" or weapon_has_profile(weapon_id, "shotgun")
def is_operator(weapon_id: Any) -> bool: return _weapon_name_contains(weapon_id, "operator")
def is_outlaw(weapon_id: Any) -> bool: return _weapon_name_contains(weapon_id, "outlaw")
def is_marshal(weapon_id: Any) -> bool: return _weapon_name_contains(weapon_id, "marshal")
def is_sheriff(weapon_id: Any) -> bool: return _weapon_name_contains(weapon_id, "sheriff")
def is_sidearm(weapon_id: Any) -> bool: return weapon_catalog_role(weapon_id) == "sidearm" or weapon_has_profile(weapon_id, "sidearm")
def is_sniper(weapon_id: Any) -> bool: return is_operator(weapon_id) or is_outlaw(weapon_id) or is_marshal(weapon_id)
def is_heavy_armor(armor_id: Any) -> bool: return gear_armor_level(armor_id) == "heavy"
def is_light_armor(armor_id: Any) -> bool: return gear_armor_level(armor_id) == "light"
def is_regen_armor(armor_id: Any) -> bool: return gear_armor_level(armor_id) == "regen"


def classify_team_buy_action(
    team_player_economies: list[dict], previous_round_context: dict | None = None
) -> str:
    economies = [economy or {} for economy in team_player_economies if isinstance(economy, dict)]
    if not economies:
        return "UNKNOWN"
    weapons = [economy.get("weapon") for economy in economies]
    total = sum(float(economy.get("loadoutValue") or 0) for economy in economies)
    spent = sum(_outlay(economy) for economy in economies)
    rifles = sum(is_rifle(weapon) for weapon in weapons)
    smgs = sum(is_smg(weapon) for weapon in weapons)
    machine_guns = sum(is_machine_gun(weapon) for weapon in weapons)
    shotguns = sum(is_shotgun(weapon) for weapon in weapons)
    operators = sum(is_operator(weapon) for weapon in weapons)
    outlaws = sum(is_outlaw(weapon) for weapon in weapons)
    marshals = sum(is_marshal(weapon) for weapon in weapons)
    sheriffs = sum(is_sheriff(weapon) for weapon in weapons)
    sidearms = sum(is_sidearm(weapon) for weapon in weapons)
    heavy = sum(is_heavy_armor(economy.get("armor")) for economy in economies)
    light = sum(is_light_armor(economy.get("armor")) for economy in economies)
    regen = sum(is_regen_armor(economy.get("armor")) for economy in economies)
    premium_primaries = rifles + machine_guns

    if previous_round_context and previous_round_context.get("won") and spent < 5000 and total >= 12000:
        return "BONUS_KEEP_WEAPONS"
    if operators and total >= 18000:
        return "FULL_OPERATOR"
    if premium_primaries >= 4 and heavy + regen >= 3 and total >= 16000:
        return "FULL_RIFLES"
    if premium_primaries >= 2 and total >= 12000:
        return "FORCE_2_RIFLES"
    if rifles and light:
        return "FORCE_RIFLE_LIGHT"
    if machine_guns and total >= 9000:
        return "FORCE_2_RIFLES"
    if outlaws:
        return "FORCE_OUTLAW"
    if marshals:
        return "SEMI_MARSHAL"
    if smgs >= 2 or shotguns >= 2:
        return "SEMI_SMG"
    if sheriffs >= 3:
        return "ECO_SHERIFF_STACK"
    if sheriffs == 2:
        return "ECO_TWO_SHERIFFS"
    if sheriffs == 1 and total < 5000:
        return "ECO_ONE_SHERIFF"
    if sidearms >= 2 and total < 8000:
        return "ECO_PISTOL_UPGRADE"
    if total < 4000 and spent < 3000:
        return "ECO_CLASSIC"
    if total < 8000:
        return "ECO_PISTOL_UPGRADE"
    return "MIXED_LOW_BUY"
