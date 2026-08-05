from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class EconomyRuleset:
    version: str
    effective_from: str
    max_credits: int = 9000
    half_start_credits: int = 800
    overtime_start_credits: int = 5000
    win_income: int = 3000
    loss_income: tuple[int, int, int] = (1900, 2400, 2900)
    kill_income: int = 200
    spike_plant_income: int = 300
    save_penalty_income: int = 1000
    regen_shield_cost: int | None = 650

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["loss_income"] = list(self.loss_income)
        return payload


# The source payload does not expose a structured patch number consistently.
# Keep selection explicit and conservative until historical content snapshots
# are available. New entries can be inserted without changing callers.
RULESETS = (
    EconomyRuleset(
        version="valorant-economy-9.10+",
        effective_from="9.10",
        regen_shield_cost=650,
    ),
    EconomyRuleset(
        version="valorant-economy-1.11+",
        effective_from="1.11",
        regen_shield_cost=None,
    ),
)


def _version_tuple(value: Any) -> tuple[int, int]:
    text = str(value or "")
    candidates = []
    for token in text.replace("-", ".").split("."):
        if token.isdigit():
            candidates.append(int(token))
        if len(candidates) == 2:
            break
    return tuple((candidates + [0, 0])[:2])  # type: ignore[return-value]


def resolve_economy_ruleset(game_version: Any) -> EconomyRuleset:
    version = _version_tuple(game_version)
    if version >= (9, 10):
        return RULESETS[0]
    return RULESETS[1]


def ruleset_provenance(game_version: Any) -> dict[str, Any]:
    ruleset = resolve_economy_ruleset(game_version)
    return {
        "ruleset_version": ruleset.version,
        "game_version": str(game_version or "desconocida"),
        "price_catalog_source": "current_content_fallback",
        "price_catalog_exact_for_patch": False,
        "warning": "No existe todavía un snapshot histórico completo de precios para esta versión.",
    }
