from __future__ import annotations

from typing import Any

from .buy_classifier import classify_team_buy_action

TARGET_LOADOUT_CASES = {
    "PISTOL_BALANCED",
    "PISTOL_UTILITY_HEAVY",
    "ECO_CLASSIC",
    "ECO_PISTOL_UPGRADE",
    "ECO_SHERIFF_STACK",
    "SEMI_SMG",
    "SEMI_MARSHAL",
    "FORCE_RIFLE_LIGHT",
    "FORCE_OUTLAW",
    "FORCE_2_RIFLES",
    "BONUS_KEEP_WEAPONS",
    "FULL_RIFLES",
    "FULL_OPERATOR",
    "DOUBLE_OPERATOR",
    "MIXED_LOW_BUY",
    "LAST_ROUND_SPEND_ALL",
    "OVERTIME_STANDARD",
    "UNKNOWN",
}

CASHFLOW_CASES = {
    "SAVE",
    "LOW_TOPUP",
    "REBUY_1_2",
    "FULL_REBUY",
    "DROP_HEAVY",
    "CARRYOVER_ONLY",
    "ROLLOVER_WITH_UTILITY",
    "FORCED_SPEND_ALL",
    "UNKNOWN",
}


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def normalize_target_loadout_case(action: str, *, round_number: int | None = None) -> str:
    if round_number in {1, 13}:
        if action in {"ECO_CLASSIC", "ECO_PISTOL_UPGRADE", "ECO_ONE_SHERIFF", "ECO_TWO_SHERIFFS", "ECO_SHERIFF"}:
            return "PISTOL_BALANCED"
        if action == "ECO_SHERIFF_STACK":
            return "ECO_SHERIFF_STACK"
    if round_number is not None and round_number >= 25:
        return "OVERTIME_STANDARD"
    if round_number in {12, 24}:
        return "LAST_ROUND_SPEND_ALL"
    aliases = {
        "ECO_ONE_SHERIFF": "ECO_PISTOL_UPGRADE",
        "ECO_TWO_SHERIFFS": "ECO_SHERIFF_STACK",
        "ECO_SHERIFF": "ECO_SHERIFF_STACK",
    }
    return aliases.get(action, action if action in TARGET_LOADOUT_CASES else "UNKNOWN")


def classify_cashflow_case(
    *,
    team_spent: float,
    team_loadout: float,
    team_prebuy_credits: float,
    target_loadout_case: str,
    is_last_round_before_switch: bool = False,
    is_overtime: bool = False,
) -> str:
    spent = _number(team_spent)
    loadout = _number(team_loadout)
    prebuy = _number(team_prebuy_credits)
    if is_overtime:
        return "FULL_REBUY" if spent >= 12000 else "LOW_TOPUP"
    if is_last_round_before_switch and spent >= max(0.0, prebuy * 0.75):
        return "FORCED_SPEND_ALL"
    if spent <= 500:
        return "CARRYOVER_ONLY" if loadout >= 8000 else "SAVE"
    if loadout >= 12000 and spent <= 5000:
        return "LOW_TOPUP"
    if target_loadout_case == "BONUS_KEEP_WEAPONS":
        return "ROLLOVER_WITH_UTILITY" if spent > 1500 else "CARRYOVER_ONLY"
    if spent <= 6000:
        return "LOW_TOPUP"
    if spent <= 12000:
        return "REBUY_1_2"
    if spent > prebuy + 600 and prebuy > 0:
        return "DROP_HEAVY"
    return "FULL_REBUY"


def classify_team_economy_labels(
    economies: list[dict[str, Any]],
    *,
    round_number: int,
    team_prebuy_credits: float,
    previous_round_context: dict[str, Any] | None = None,
    is_last_round_before_switch: bool = False,
    is_overtime: bool = False,
) -> dict[str, Any]:
    action = classify_team_buy_action(economies, previous_round_context)
    target = normalize_target_loadout_case(action, round_number=round_number)
    team_spent = sum(_number(
        economy.get("totalOutlay")
        if economy.get("totalOutlay") is not None
        else economy.get("derivedSpend")
    ) for economy in economies)
    team_loadout = sum(_number(economy.get("loadoutValue")) for economy in economies)
    cashflow = classify_cashflow_case(
        team_spent=team_spent,
        team_loadout=team_loadout,
        team_prebuy_credits=team_prebuy_credits,
        target_loadout_case=target,
        is_last_round_before_switch=is_last_round_before_switch,
        is_overtime=is_overtime,
    )
    return {
        "real_buy_action": action,
        "target_loadout_case": target,
        "cashflow_case": cashflow,
        "team_spent_derived": team_spent,
        "team_spent_observed": None,
        "team_loadout_observed": team_loadout,
    }
