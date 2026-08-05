from __future__ import annotations

from itertools import product
from math import exp
from typing import Any

from .ability_catalog import agent_abilities


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def infer_ability_purchase_combinations(
    agent: str | None,
    utility_inventory_value: float,
    *,
    tolerance: float = 50.0,
    limit: int = 8,
) -> dict[str, Any]:
    target = max(0.0, float(utility_inventory_value or 0))
    abilities = []
    missing_cost = []
    for ability in agent_abilities(agent):
        if not ability.get("is_purchasable"):
            continue
        cost = ability.get("cost_per_charge")
        maximum = int(ability.get("purchasable_charges") or ability.get("max_charges") or 0)
        if cost is None or _number(cost) <= 0:
            missing_cost.append(str(ability.get("name") or "Habilidad desconocida"))
            continue
        abilities.append({
            "name": str(ability.get("name") or "Habilidad"),
            "cost": _number(cost),
            "max_charges": max(0, min(4, maximum)),
            "persistent": bool(ability.get("persists_between_rounds")),
            "free_charges": int(ability.get("free_charges_at_round_start") or 0),
        })
    if target <= tolerance:
        return {
            "status": "compatible_zero_or_carried_utility",
            "target_value": target,
            "combinations": [{"items": [], "total_cost": 0.0, "probability": 1.0}],
            "missing_cost_abilities": missing_cost,
        }
    if not abilities:
        return {
            "status": "not_identifiable",
            "target_value": target,
            "combinations": [],
            "missing_cost_abilities": missing_cost,
        }
    candidates = []
    ranges = [range(item["max_charges"] + 1) for item in abilities]
    for quantities in product(*ranges):
        total = sum(quantity * item["cost"] for quantity, item in zip(quantities, abilities))
        error = abs(total - target)
        if error > max(tolerance, target * 0.2):
            continue
        items = [
            {
                "name": item["name"],
                "charges": quantity,
                "cost": quantity * item["cost"],
                "cost_per_charge": item["cost"],
                "source": "comprada_o_conservada",
                "persistent": item["persistent"],
            }
            for quantity, item in zip(quantities, abilities)
            if quantity
        ]
        candidates.append({"items": items, "total_cost": total, "error": error})
    candidates.sort(key=lambda item: (item["error"], len(item["items"])))
    candidates = candidates[:max(1, limit)]
    weights = [exp(-item["error"] / max(25.0, tolerance)) for item in candidates]
    total_weight = sum(weights) or 1.0
    for item, weight in zip(candidates, weights):
        item["probability"] = round(weight / total_weight, 6)
    return {
        "status": (
            "unique_compatible_combination" if len(candidates) == 1
            else "ambiguous_compatible_combinations" if candidates
            else "unreconciled_utility_value"
        ),
        "target_value": target,
        "combinations": candidates,
        "missing_cost_abilities": missing_cost,
        "exact_identity_claim_allowed": len(candidates) == 1 and not missing_cost,
    }
