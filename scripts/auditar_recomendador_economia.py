from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for path in (PROJECT_ROOT, BACKEND_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from modules.economy_ml.recommendation_audit import (  # noqa: E402
    summarize_pistol_recommendation_safety,
    summarize_recommendation_distribution,
)
from modules.economy_ml.recommendation_backtest import (  # noqa: E402
    summarize_recommendation_backtest,
)
from modules.economy_ml.round_recommender import recommend_match_economy  # noqa: E402
from modules.matches.infrastructure import mongo_match_repo  # noqa: E402


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return round(ordered[index], 4)


def audit_matches(matches: list[dict[str, Any]]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    durations: list[float] = []
    failures: list[dict[str, str]] = []
    for match in matches:
        match_id = str(match.get("matchId") or match.get("match_id") or "UNKNOWN")
        started = time.perf_counter()
        try:
            result = recommend_match_economy(match)
            rows.extend(result.get("rounds") or [])
            durations.append(time.perf_counter() - started)
        except Exception as exc:  # pragma: no cover - operational boundary
            failures.append({"match_id": match_id, "error": f"{type(exc).__name__}: {exc}"})

    backtest = summarize_recommendation_backtest(rows)
    return {
        "matches_requested": len(matches),
        "matches_completed": len(durations),
        "matches_failed": len(failures),
        "failures": failures,
        "performance_seconds": {
            "median": round(statistics.median(durations), 4) if durations else None,
            "p95": _percentile(durations, 0.95),
            "maximum": round(max(durations), 4) if durations else None,
        },
        "acceptance": {
            "zero_invalid_purchases": backtest["invalid_recommendations"] == 0,
            "zero_budget_overruns": backtest["recommendations_exceeding_credits"] == 0,
            "zero_legacy_spent_usage": backtest["legacy_spent_used_rounds"] == 0,
            "zero_broken_buy_recommendations": (
                backtest["recommended_action_counts"].get("BROKEN_BUY", 0) == 0
            ),
            "whole_match_p95_at_most_8_seconds": bool(durations) and (_percentile(durations, 0.95) or 9) <= 8,
        },
        "backtest": backtest,
        "pistol_safety": summarize_pistol_recommendation_safety(rows),
        "distribution": summarize_recommendation_distribution(rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audita legalidad, calidad aparente y latencia del recomendador económico v12."
    )
    parser.add_argument("--limit", type=int, default=20, help="Partidas recientes a auditar.")
    parser.add_argument("--output", type=Path, help="Ruta JSON opcional para guardar el informe.")
    args = parser.parse_args()
    if args.limit <= 0:
        parser.error("--limit debe ser mayor que cero")
    report = audit_matches(mongo_match_repo.list_recent(args.limit))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["matches_failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
