from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .content_catalog import find_weapon
from .inventory import PlayerInventoryState


def _cost(weapon: Any) -> float | None:
    payload = find_weapon(weapon)
    value = (payload or {}).get("cost")
    return float(value) if value is not None else None


@dataclass
class PurchaseHypothesis:
    weapon_source: str
    confidence: float
    estimated_self_spend: float | None
    reasons: list[str] = field(default_factory=list)
    armor_source: str = "unknown"
    estimated_team_spend_impact: float | None = None
    buys_for_teammate: bool | None = None
    utility_bought_estimated: list[dict[str, Any]] = field(default_factory=list)
    free_utility_granted: list[dict[str, Any]] = field(default_factory=list)
    utility_status: str = "unknown"
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PurchaseInferenceEngine:
    def infer(self, state: PlayerInventoryState, *, observed_spent: float | None = None,
              context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        weapon = state.weapon_after_buy
        before = state.weapon_before_buy
        cost = _cost(weapon)
        spent = None if observed_spent is None else max(0.0, float(observed_spent))
        hypotheses: list[PurchaseHypothesis] = []
        normalized_weapon = str(weapon or "").strip().lower()
        is_default = normalized_weapon in {"classic", "default", "classic gratis"} and (cost in (None, 0))
        round_number = int((context or {}).get("round_number") or 0)
        is_reset = bool((context or {}).get("is_pistol_round") or (context or {}).get("is_overtime")
                        or (context or {}).get("is_half_reset") or round_number in {1, 13})
        if is_default and not before and (is_reset or spent in (None, 0)):
            hypotheses.append(PurchaseHypothesis(
                "default_spawn_weapon", .96 if is_reset else .86, 0,
                ["classic_default_loadout", "round_start_default_weapon"],
            ))
        elif before and before == weapon and state.survived_previous_round:
            hypotheses.append(PurchaseHypothesis("carried", .94, 0, ["same_weapon_after_survival"]))
        elif state.died_previous_round and weapon:
            if cost is not None and spent is not None and spent + 100 >= cost:
                hypotheses.append(PurchaseHypothesis("bought_self", .78, cost, ["weapon_lost_on_death", "spend_supports_purchase"]))
            else:
                hypotheses.extend([
                    PurchaseHypothesis("bought_by_teammate", .58, 0, ["weapon_lost_on_death", "insufficient_observed_spend"]),
                    PurchaseHypothesis("picked_up", .24, 0, ["possible_pickup_not_provable"]),
                ])
        elif weapon and weapon != before:
            if cost is not None and spent is not None and spent + 100 < cost:
                hypotheses.extend([
                    PurchaseHypothesis("picked_up", .52, 0, ["weapon_upgrade_without_sufficient_spend"]),
                    PurchaseHypothesis("bought_by_teammate", .42, 0, ["drop_also_explains_credit_gap"]),
                ])
            else:
                hypotheses.append(PurchaseHypothesis("bought_self", .68, cost, ["new_weapon_and_spend_is_compatible"]))
        else:
            hypotheses.append(PurchaseHypothesis("unknown", .25, None, ["insufficient_inventory_evidence"], warnings=["low_confidence"]))
        for item in hypotheses:
            if (state.armor_before_buy and state.armor_before_buy != "Sin escudo"
                    and state.armor_before_buy == state.armor_after_buy):
                item.armor_source = "carried"
            elif state.armor_after_buy:
                item.armor_source = "bought_self"
            item.estimated_team_spend_impact = item.estimated_self_spend
            item.buys_for_teammate = None
            item.free_utility_granted = [
                {"name": name, "charges": charges, "source": "free_round_start"}
                for name, charges in state.free_abilities_granted.items()
            ]
            # Ability purchases are not directly observable in the match payload.
            item.utility_status = "estimated" if observed_spent is not None else "unknown"
            item.warnings = list(dict.fromkeys(item.warnings + ["ability_purchase_not_observable"]))
        return [item.to_dict() for item in sorted(hypotheses, key=lambda h: h.confidence, reverse=True)]

    def infer_team(self, states: list[PlayerInventoryState], observed: dict[str, dict],
                   context: dict[str, Any] | None = None) -> dict[str, list[dict[str, Any]]]:
        context = context or {}
        state_by_puuid = {state.puuid: state for state in states}

        def reconstructed_outlay(puuid: str) -> float | None:
            economy = observed.get(puuid) or {}
            remaining = economy.get("remaining")
            state = state_by_puuid.get(puuid)
            if remaining is None or state is None:
                return None
            return max(0.0, float(state.credits_before_buy) - float(remaining or 0))

        result = {
            state.puuid: self.infer(
                state,
                observed_spent=reconstructed_outlay(state.puuid),
                context=context,
            )
            for state in states
        }
        round_number = int(context.get("round_number") or 0)
        if context.get("is_pistol_round") or context.get("is_overtime") or context.get("is_half_reset") or round_number in {1, 13}:
            return result
        receivers = [
            state for state in states
            if (result.get(state.puuid) or [{}])[0].get("weapon_source") == "bought_by_teammate"
            and float((result.get(state.puuid) or [{}])[0].get("confidence") or 0) >= .5
        ]
        for receiver in receivers:
            weapon_cost = _cost(receiver.weapon_after_buy) or 0.0
            donors = sorted(
                (state for state in states if state.puuid != receiver.puuid),
                key=lambda state: reconstructed_outlay(state.puuid) or 0.0,
                reverse=True,
            )
            donor = next(
                (state for state in donors if (reconstructed_outlay(state.puuid) or 0.0) >= weapon_cost),
                None,
            )
            if not donor:
                top = result[receiver.puuid][0]
                top["weapon_source"] = "unknown_or_pickup"
                top["confidence"] = min(float(top.get("confidence") or .2), .4)
                top["reasons"] = list(top.get("reasons") or []) + ["no_compatible_drop_donor"]
                continue
            donor_hypothesis = dict((result.get(donor.puuid) or [{}])[0])
            donor_hypothesis.update({
                "buys_for_teammate": True,
                "estimated_team_spend_impact": (donor_hypothesis.get("estimated_self_spend") or 0) + weapon_cost,
                "confidence": min(float(donor_hypothesis.get("confidence") or .2), .58),
                "reasons": list(donor_hypothesis.get("reasons") or []) + [f"possible_weapon_drop_for:{receiver.puuid}"],
                "warnings": list(dict.fromkeys(list(donor_hypothesis.get("warnings") or []) + ["team_drop_inferred_not_observed"])),
            })
            result[donor.puuid].insert(0, donor_hypothesis)
        return result
