from __future__ import annotations

from typing import Any

from .buy_classifier import is_heavy_armor, is_light_armor, is_regen_armor, is_sheriff
from .content_catalog import find_gear, find_weapon, load_gear_catalog, load_weapon_catalog

SHERIFF_COST = 800.0
LIGHT_ARMOR_COST = 400.0
REGEN_ARMOR_COST = 650.0
HEAVY_ARMOR_COST = 1000.0
GHOST_COST = 500.0
SHERIFF_LIGHT_COST = SHERIFF_COST + LIGHT_ARMOR_COST
GHOST_LIGHT_COST = GHOST_COST + LIGHT_ARMOR_COST

PISTOL_ROUNDS = {1, 13}
PISTOL_ALLOWED_ACTIONS = {"ECO_CLASSIC", "ECO_PISTOL_UPGRADE", "ECO_ONE_SHERIFF"}
PISTOL_BLOCKED_ACTIONS = {
    "SEMI_SMG",
    "SEMI_MARSHAL",
    "FORCE_OUTLAW",
    "FORCE_RIFLE_LIGHT",
    "FORCE_2_RIFLES",
    "FULL_RIFLES",
    "FULL_OPERATOR",
    "BONUS_KEEP_WEAPONS",
    "MIXED_LOW_BUY",
    "ECO_SHERIFF_STACK",
    "ECO_TWO_SHERIFFS",
    "ECO_SHERIFF",
}


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_pistol_round(state: dict[str, Any]) -> bool:
    return bool(state.get("is_pistol_round")) or int(state.get("round_number") or 0) in PISTOL_ROUNDS


def pistol_action_guardrail(action: str, state: dict[str, Any]) -> tuple[bool, str | None]:
    if not is_pistol_round(state):
        return True, None
    if action == "ECO_SHERIFF_STACK":
        return False, "Stack de Sheriffs bloqueado en pistol round"
    if action in {"ECO_TWO_SHERIFFS", "ECO_SHERIFF"}:
        return False, "Sheriffs multiples bloqueadas en pistol round"
    if action in PISTOL_BLOCKED_ACTIONS:
        return False, "Accion no permitida en pistol round"
    return True, None


def _catalog_weapon_cost(value: Any) -> float | None:
    weapon = find_weapon(value)
    if weapon and weapon.get("cost") is not None:
        return _number(weapon.get("cost"))
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    for weapon in load_weapon_catalog().values():
        if normalized in str(weapon.get("displayName") or "").strip().lower():
            return _number(weapon.get("cost"))
    return None


def _catalog_armor_cost(value: Any) -> float | None:
    gear = find_gear(value)
    if gear and gear.get("cost") is not None:
        return _number(gear.get("cost"))
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    for gear in load_gear_catalog().values():
        if normalized in str(gear.get("displayName") or "").strip().lower():
            return _number(gear.get("cost"))
    return None


def item_cost(item: dict[str, Any] | None) -> float:
    return _number((item or {}).get("cost"))


def weapon_cost(value: Any) -> float:
    if is_sheriff(value):
        return SHERIFF_COST
    cost = _catalog_weapon_cost(value)
    return _number(cost)


def armor_cost(value: Any) -> float:
    if is_light_armor(value):
        return LIGHT_ARMOR_COST
    if is_regen_armor(value):
        return REGEN_ARMOR_COST
    if is_heavy_armor(value):
        return HEAVY_ARMOR_COST
    cost = _catalog_armor_cost(value)
    return _number(cost)


def is_sheriff_weapon(item_or_id: Any) -> bool:
    if isinstance(item_or_id, dict):
        item_or_id = item_or_id.get("uuid") or item_or_id.get("displayName")
    return is_sheriff(item_or_id)


def is_light_armor_item(item_or_id: Any) -> bool:
    if isinstance(item_or_id, dict):
        item_or_id = item_or_id.get("uuid") or item_or_id.get("displayName")
    return is_light_armor(item_or_id) or "light" in str(item_or_id or "").strip().lower()


def infer_pistol_free_light_armor_from_economy(
    round_number: int,
    economy: dict[str, Any],
) -> bool:
    if int(round_number or 0) not in PISTOL_ROUNDS:
        return False
    if not isinstance(economy, dict) or not is_light_armor_item(economy.get("armor")):
        return False

    spent_value = (
        economy.get("totalOutlay")
        if economy.get("totalOutlay") is not None
        else economy.get("derivedSpend")
    )
    if spent_value is None:
        return False
    spent = _number(spent_value)
    weapon = economy.get("weapon")
    w_cost = weapon_cost(weapon)
    loadout = _number(economy.get("loadoutValue"))

    if is_sheriff(weapon) and spent <= SHERIFF_COST:
        return True
    if w_cost > 0 and spent < w_cost + LIGHT_ARMOR_COST:
        return True
    if loadout >= LIGHT_ARMOR_COST and spent < loadout:
        return True
    return False


def summarize_player_credit_features(values: list[float]) -> dict[str, float | int]:
    clean = [float(value or 0) for value in values]
    if not clean:
        return {
            "credit_min": 0.0,
            "credit_max": 0.0,
            "credit_mean": 0.0,
            "credit_median": 0.0,
            "credit_std": 0.0,
            "players_can_buy_sheriff": 0,
            "players_can_buy_light_armor": 0,
            "players_can_buy_sheriff_light": 0,
            "players_can_buy_ghost_light": 0,
        }
    ordered = sorted(clean)
    midpoint = len(ordered) // 2
    median = (
        ordered[midpoint]
        if len(ordered) % 2
        else (ordered[midpoint - 1] + ordered[midpoint]) / 2.0
    )
    mean = sum(clean) / len(clean)
    variance = sum((value - mean) ** 2 for value in clean) / len(clean)
    return {
        "credit_min": min(clean),
        "credit_max": max(clean),
        "credit_mean": mean,
        "credit_median": median,
        "credit_std": variance ** 0.5,
        "players_can_buy_sheriff": sum(value >= SHERIFF_COST for value in clean),
        "players_can_buy_light_armor": sum(value >= LIGHT_ARMOR_COST for value in clean),
        "players_can_buy_sheriff_light": sum(value >= SHERIFF_LIGHT_COST for value in clean),
        "players_can_buy_ghost_light": sum(value >= GHOST_LIGHT_COST for value in clean),
    }
