from __future__ import annotations

import os
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Any

from .round_recommender import recommend_match_economy


_MAX_ENTRIES = max(1, int(os.getenv("ECONOMY_MATCH_ANALYSIS_CACHE_SIZE", "8")))
_ARTIFACTS_DIR = Path(__file__).with_name("artifacts")
_cache: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
_cache_lock = Lock()


def _artifact_revision() -> tuple[tuple[str, int, int], ...]:
    """Invalidate cached analyses whenever a trained artifact is replaced."""
    result: list[tuple[str, int, int]] = []
    paths = [*_ARTIFACTS_DIR.glob("*.joblib"), _ARTIFACTS_DIR / "metadata.json"]
    for path in sorted(paths):
        try:
            stat = path.stat()
            result.append((path.name, stat.st_mtime_ns, stat.st_size))
        except OSError:
            continue
    return tuple(result)


def _match_revision(match: dict[str, Any]) -> tuple[Any, ...]:
    info = match.get("matchInfo") or {}
    rounds = match.get("roundResults") or []
    return (
        str(info.get("matchId") or ""),
        str(match.get("_id") or ""),
        info.get("gameStartMillis") or info.get("gameStartTimeMillis"),
        len(rounds),
        str((rounds[-1] if rounds else {}).get("roundNum") or ""),
        str((rounds[-1] if rounds else {}).get("winningTeam") or ""),
    )


def get_match_economy_analysis(match: dict[str, Any]) -> dict[str, Any]:
    key = (*_match_revision(match), _artifact_revision())
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached

    result = recommend_match_economy(match)
    with _cache_lock:
        _cache[key] = result
        _cache.move_to_end(key)
        while len(_cache) > _MAX_ENTRIES:
            _cache.popitem(last=False)
    return result


def clear_match_economy_analysis_cache() -> None:
    with _cache_lock:
        _cache.clear()
