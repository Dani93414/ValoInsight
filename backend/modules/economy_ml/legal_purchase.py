from __future__ import annotations

from dataclasses import dataclass, field
from itertools import product
from typing import Any

from .ability_catalog import agent_abilities
from .content_catalog import find_gear, find_weapon, load_gear_catalog, load_weapon_catalog, weapon_role
from .inventory import PlayerInventoryState


def _price(item: dict | None) -> float:
    value = (item or {}).get("cost")
    return float(value or 0)


def _weapon_purchase_cost(item: dict | None) -> float:
    value = (item or {}).get("purchase_cost")
    return float(value if value is not None else _price(item))


def _weapon_value(item: dict | None) -> float:
    value = (item or {}).get("weapon_value")
    return float(value if value is not None else _price(item))


def _armor_value(item: dict | None) -> float:
    value = (item or {}).get("armor_value")
    return float(value if value is not None else _price(item))


def _compact_catalog_item(item: dict[str, Any] | None) -> dict[str, Any]:
    """Keep recommendation features without repeating the source API document."""
    return {
        key: value for key, value in (item or {}).items()
        if key not in {"raw", "shopData"}
    }


@dataclass
class LegalPlayerPurchase:
    puuid: str
    weapon: dict[str, Any] | None
    armor: dict[str, Any] | None
    abilities: list[dict[str, Any]]
    keep_weapon: bool
    self_cost: float
    weapon_cost: float
    weapon_purchase_cost: float
    weapon_value: float
    weapon_source: str
    armor_cost: float
    armor_purchase_cost: float
    armor_value: float
    armor_effective_value: float
    armor_full_value: float
    armor_durability_ratio: float | None
    armor_source: str
    keep_armor: bool
    ability_cost: float
    expected_remaining: float
    bought_by: str | None = None
    buys_for: str | list[str] | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        # Catalog items may contain large nested raw payloads. A deep
        # dataclasses.asdict copy multiplied by every candidate dominated the
        # endpoint runtime without adding isolation: candidates are treated as
        # immutable until the solver makes its own shallow copy.
        return dict(self.__dict__)


class LegalPurchaseGenerator:
    """Enumerates player-level legal choices. Team drops are solved later."""
    def generate(self, state: PlayerInventoryState, *, agent: str = "", limit: int = 48,
                 ability_combination_limit: int = 64, context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        credits = state.credits_before_buy
        weapons = [] if state.weapon_before_buy else [None]
        if state.weapon_before_buy:
            catalog_weapon = find_weapon(state.weapon_before_buy)
            catalog_value = _price(catalog_weapon)
            carried = {
                **_compact_catalog_item(catalog_weapon),
                "displayName": (catalog_weapon or {}).get("displayName") or state.weapon_before_buy,
                "cost": 0,
                "purchase_cost": 0,
                "weapon_value": catalog_value,
                "source": "carried",
            }
            if not catalog_weapon:
                carried["warnings"] = ["carried_weapon_missing_catalog"]
            weapons.append(carried)
        # A weapon can exceed the receiver's own budget because the team solver
        # may fund it as a legal weapon-only drop.
        purchasable = [w for w in load_weapon_catalog().values() if w.get("cost") is not None]
        purchasable.sort(key=_price)
        weapons.extend({
            **_compact_catalog_item(weapon),
            "purchase_cost": _price(weapon),
            "weapon_value": _price(weapon),
            "source": "bought_self",
        } for weapon in purchasable)
        armors = [] if state.armor_before_buy and state.armor_before_buy != "Sin escudo" else [None]
        durability = (((context or {}).get("advanced_context") or {}).get("armor_durability") or {}).get(state.puuid) or {}
        if state.armor_before_buy and state.armor_before_buy != "Sin escudo":
            catalog_armor = find_gear(state.armor_before_buy)
            catalog_value = _price(catalog_armor)
            maximum = float(durability.get("armor_max_value") or 0)
            remaining = durability.get("armor_value_remaining")
            ratio = max(0.0, min(1.0, float(remaining) / maximum)) if maximum and remaining is not None else 0.75
            effective_value = catalog_value * ratio
            carried_armor = {
                **_compact_catalog_item(catalog_armor),
                "displayName": (catalog_armor or {}).get("displayName") or state.armor_before_buy,
                "cost": 0,
                "purchase_cost": 0,
                "armor_value": catalog_value,
                "armor_full_value": catalog_value,
                "armor_effective_value": effective_value,
                "armor_durability_ratio": ratio,
                "source": "carried",
            }
            if not catalog_armor:
                carried_armor["warnings"] = ["carried_armor_missing_catalog"]
            armors.append(carried_armor)
        armors.extend({
            **_compact_catalog_item(gear),
            "purchase_cost": _price(gear),
            "armor_value": _price(gear),
            "source": "bought_self",
        } for gear in load_gear_catalog().values() if gear.get("cost") is not None and _price(gear) <= credits)
        ability_state = (((context or {}).get("advanced_context") or {}).get("ability_usage") or {}).get(state.puuid) or {}
        carried_charges = state.ability_charges_before_buy or ability_state.get("charges_carried_after_round") or {}
        ability_options = self._ability_options(agent, credits, max_combinations=ability_combination_limit,
                                                carried_charges=carried_charges)
        if (context or {}).get("is_pistol_round"):
            # A pistol plan buys a key piece of utility, not an automatic full kit.
            pistol_cap = float((context or {}).get("pistol_utility_cap_per_player") or 500)
            ability_options = [option for option in ability_options if option[1] <= pistol_cap]
        plans: list[dict[str, Any]] = []
        seen: set[tuple] = set()
        for weapon in weapons:
            source = str((weapon or {}).get("source") or "none")
            keep = source == "carried"
            purchase_cost = _weapon_purchase_cost(weapon)
            equipped_value = _weapon_value(weapon)
            wc = 0 if keep else purchase_cost
            for armor in armors:
                armor_source = str((armor or {}).get("source") or "none")
                keep_armor = armor_source == "carried"
                armor_purchase_cost = float((armor or {}).get("purchase_cost") if (armor or {}).get("purchase_cost") is not None else _price(armor))
                armor_value = _armor_value(armor)
                armor_effective_value = float((armor or {}).get("armor_effective_value")
                                              if (armor or {}).get("armor_effective_value") is not None else armor_value)
                armor_full_value = float((armor or {}).get("armor_full_value")
                                         if (armor or {}).get("armor_full_value") is not None else armor_value)
                armor_ratio = (armor or {}).get("armor_durability_ratio")
                ac = 0 if keep_armor else armor_purchase_cost
                for abilities, ability_cost, warnings in ability_options:
                    total = wc + ac + ability_cost
                    requires_drop = bool(wc and total > credits and ac + ability_cost <= credits)
                    if total > credits + 1e-6 and not requires_drop:
                        continue
                    key = ((weapon or {}).get("displayName"), source, (armor or {}).get("displayName"), armor_source, tuple((a["name"], a["charges"]) for a in abilities))
                    if key in seen:
                        continue
                    seen.add(key)
                    self_cost = ac + ability_cost if requires_drop else total
                    item_warnings = list((weapon or {}).get("warnings") or []) + list((armor or {}).get("warnings") or [])
                    payload = LegalPlayerPurchase(
                        state.puuid, weapon, armor, abilities, keep, self_cost, wc,
                        purchase_cost, equipped_value, source, ac, armor_purchase_cost,
                        armor_value, armor_effective_value, armor_full_value, armor_ratio,
                        armor_source, keep_armor, ability_cost,
                        credits-self_cost, warnings=list(dict.fromkeys(warnings + item_warnings)),
                    )
                    item = payload.to_dict()
                    item["requires_weapon_drop"] = requires_drop
                    plans.append(item)
        plans.sort(key=lambda p: (p.get("self_cost", 0), _price(p.get("weapon")), p.get("ability_cost", 0)))
        if len(plans) <= limit:
            return plans
        indices = {round(i * (len(plans) - 1) / max(1, limit - 1)) for i in range(limit)}
        selected = [plans[i] for i in sorted(indices)]
        # Always retain the strongest utility plan and carried/no-buy choices.
        must_keep = [
            max(plans, key=lambda p: (p.get("ability_cost", 0), -p.get("self_cost", 0))),
            min(plans, key=lambda p: p.get("self_cost", 0)),
        ]
        if (context or {}).get("is_pistol_round"):
            def weapon_name(plan: dict[str, Any]) -> str:
                return str((plan.get("weapon") or {}).get("displayName") or "").lower()

            for name in ("ghost", "frenzy", "shorty"):
                candidates = [
                    plan for plan in plans
                    if weapon_name(plan) == name and not plan.get("requires_weapon_drop")
                ]
                if candidates:
                    must_keep.append(max(candidates, key=lambda p: (
                        p.get("ability_cost", 0), _armor_value(p.get("armor")),
                        -p.get("self_cost", 0),
                    )))
            classic_armor = [
                plan for plan in plans
                if weapon_name(plan) in {"", "classic"}
                and _armor_value(plan.get("armor")) >= 400
            ]
            if classic_armor:
                must_keep.append(max(classic_armor, key=lambda p: (
                    p.get("ability_cost", 0), -p.get("self_cost", 0),
                )))
        # Evenly sampling a cost-sorted list can discard the strategically
        # important middle: protected weapons with enough utility. Preserve
        # those anchors before the team solver reduces the list again.
        protected = [
            plan for plan in plans
            if not plan.get("requires_weapon_drop")
            and _weapon_value(plan.get("weapon")) >= 1600 and _armor_value(plan.get("armor")) >= 400
        ]
        if protected:
            must_keep.append(max(protected, key=lambda p: (
                p.get("ability_cost", 0), _weapon_value(p.get("weapon")),
                _armor_value(p.get("armor")), -p.get("self_cost", 0),
            )))
        rifle_buy = [
            plan for plan in plans
            if not plan.get("requires_weapon_drop")
            and weapon_role(str((plan.get("weapon") or {}).get("displayName") or "").lower()) == "rifle"
            and _armor_value(plan.get("armor")) >= 400
        ]
        if rifle_buy:
            must_keep.append(max(rifle_buy, key=lambda p: (
                p.get("ability_cost", 0), _armor_value(p.get("armor")),
                _weapon_value(p.get("weapon")), -p.get("self_cost", 0),
            )))
        carried = next((p for p in plans if p.get("keep_weapon")), None)
        if carried:
            must_keep.append(carried)
        carried_armor = next((p for p in plans if p.get("keep_armor")), None)
        if carried_armor:
            must_keep.append(carried_armor)
        required = []
        for item in must_keep:
            if item not in required:
                required.append(item)
        remainder = [item for item in selected if item not in required]
        return (required + remainder)[:limit]

    @staticmethod
    def _ability_options(agent: str, credits: float, *, max_combinations: int = 64,
                         carried_charges: dict[str, int] | None = None) -> list[tuple[list[dict], float, list[str]]]:
        free: list[dict] = []
        purchase_axes: list[list[dict | None]] = []
        warnings: list[str] = []
        for ability in agent_abilities(agent):
            if str(ability.get("ability_kind") or "").lower() == "ultimate":
                continue
            free_count = int(ability.get("free_charges_at_round_start") or 0)
            ability_name = ability.get("canonical_name") or ability.get("name")
            slot = str(ability.get("slot") or "").upper()
            carried_count = int((carried_charges or {}).get(str(ability_name),
                                (carried_charges or {}).get(slot, 0)) or 0)
            if carried_count:
                free.append({"name": ability_name, "charges": carried_count, "cost": 0,
                             "cost_per_charge": float(ability.get("cost_per_charge") or 0),
                             "source": "carried", "tactical_types": ability.get("tactical_types") or []})
            if free_count:
                existing = next((item for item in free if item["name"] == ability_name), None)
                if existing:
                    existing["charges"] += free_count
                    existing["source"] = "carried_and_free"
                else:
                    free.append({"name": ability_name, "charges": free_count, "cost": 0,
                             "cost_per_charge": 0, "source": "free_round_start",
                             "tactical_types": ability.get("tactical_types") or []})
            if not ability.get("is_purchasable"):
                continue
            cost = ability.get("cost_per_charge") if ability.get("cost_per_charge") is not None else ability.get("cost_credits")
            if cost is None:
                warnings.append(f"missing_cost:{ability_name}")
                continue
            capacity = int(ability.get("max_charges") or 0)
            max_buy = max(0, capacity - free_count - carried_count) if capacity else int(ability.get("purchasable_charges") or 0)
            axis: list[dict | None] = [None]
            for count in range(1, max_buy + 1):
                total = float(cost) * count
                if total <= credits:
                    axis.append({"name": ability_name, "charges": count, "cost": total,
                                 "cost_per_charge": float(cost), "source": "bought",
                                 "tactical_types": ability.get("tactical_types") or []})
            if len(axis) > 1:
                purchase_axes.append(axis)

        raw = product(*purchase_axes) if purchase_axes else [()]
        options: list[tuple[list[dict], float, list[str]]] = []
        for combination in raw:
            bought = [item for item in combination if item]
            cost = sum(float(item["cost"]) for item in bought)
            if cost <= credits:
                # Merge free and bought charges of the same ability for a stable UI contract.
                merged: dict[str, dict] = {item["name"]: dict(item) for item in free}
                for item in bought:
                    existing = merged.get(item["name"])
                    if existing:
                        existing["charges"] += item["charges"]
                        existing["cost"] += item["cost"]
                        existing["cost_per_charge"] = item["cost_per_charge"]
                        existing["source"] = "carried_and_bought" if "carried" in existing["source"] else "free_and_bought"
                    else:
                        merged[item["name"]] = dict(item)
                options.append((list(merged.values()), cost, list(warnings)))
        options.sort(key=lambda item: (item[1], len(item[0])))
        if len(options) <= max_combinations:
            return options
        if max_combinations <= 1:
            return [options[-1]]
        # Preserve the economic spectrum, not merely the cheapest combinations.
        indices = {round(i * (len(options) - 1) / (max_combinations - 1)) for i in range(max_combinations)}
        return [options[i] for i in sorted(indices)]
