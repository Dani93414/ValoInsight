from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def doubly_robust_policy_value(
    *,
    outcomes: np.ndarray,
    observed_actions: np.ndarray,
    target_actions: np.ndarray,
    observed_propensities: np.ndarray,
    observed_outcome_predictions: np.ndarray,
    target_outcome_predictions: np.ndarray,
    baseline_actions: np.ndarray | None = None,
    baseline_outcome_predictions: np.ndarray | None = None,
    match_ids: np.ndarray | None = None,
    bootstrap_samples: int = 400,
    seed: int = 42,
) -> dict[str, Any]:
    propensities = np.clip(np.asarray(observed_propensities, dtype=float), 0.02, 1.0)
    outcomes = np.asarray(outcomes, dtype=float)
    observed_predictions = np.asarray(observed_outcome_predictions, dtype=float)
    target_predictions = np.asarray(target_outcome_predictions, dtype=float)
    observed_actions = np.asarray(observed_actions)
    follows_policy = observed_actions == np.asarray(target_actions)
    influence = target_predictions + follows_policy.astype(float) / propensities * (
        outcomes - observed_predictions
    )
    influence = np.clip(influence, -1.0, 2.0)
    estimate = float(np.mean(influence)) if len(influence) else 0.0
    observed_value = float(np.mean(outcomes)) if len(outcomes) else 0.0
    if baseline_actions is None or baseline_outcome_predictions is None:
        baseline_influence = outcomes.copy()
        baseline_name = "observed_behavior"
    else:
        baseline_predictions = np.asarray(baseline_outcome_predictions, dtype=float)
        follows_baseline = observed_actions == np.asarray(baseline_actions)
        baseline_influence = baseline_predictions + follows_baseline.astype(float) / propensities * (
            outcomes - observed_predictions
        )
        baseline_influence = np.clip(baseline_influence, -1.0, 2.0)
        baseline_name = "deterministic_rules_proxy"
    baseline_value = float(np.mean(baseline_influence)) if len(baseline_influence) else 0.0

    ids = np.asarray(match_ids if match_ids is not None else np.arange(len(influence)))
    frame = pd.DataFrame({
        "match_id": ids, "influence": influence,
        "baseline_influence": baseline_influence, "outcome": outcomes,
    })
    clusters = [
        group[["influence", "baseline_influence", "outcome"]].to_numpy(dtype=float)
        for _, group in frame.groupby("match_id", sort=False)
    ]
    rng = np.random.default_rng(seed)
    samples: list[float] = []
    improvement_samples: list[float] = []
    if clusters:
        for _ in range(max(50, bootstrap_samples)):
            selected = rng.integers(0, len(clusters), len(clusters))
            values = np.concatenate([clusters[index] for index in selected], axis=0)
            samples.append(float(np.mean(values[:, 0])))
            improvement_samples.append(float(np.mean(values[:, 0] - values[:, 1])))
    low, high = (
        np.percentile(samples, [2.5, 97.5]).tolist()
        if samples else [estimate, estimate]
    )
    improvement_low, improvement_high = (
        np.percentile(improvement_samples, [2.5, 97.5]).tolist()
        if improvement_samples else [estimate - baseline_value, estimate - baseline_value]
    )
    return {
        "available": bool(len(influence)),
        "estimator": "doubly_robust_aipw_cluster_bootstrap",
        "policy_value": round(estimate, 6),
        "observed_policy_value": round(observed_value, 6),
        "baseline_policy": baseline_name,
        "baseline_policy_value": round(baseline_value, 6),
        "estimated_improvement": round(estimate - baseline_value, 6),
        "confidence_interval_95": [round(float(low), 6), round(float(high), 6)],
        "improvement_confidence_interval_95": [
            round(float(improvement_low), 6),
            round(float(improvement_high), 6),
        ],
        "policy_match_rate": round(float(follows_policy.mean()), 6) if len(follows_policy) else 0.0,
        "baseline_match_rate": (
            round(float((observed_actions == np.asarray(baseline_actions)).mean()), 6)
            if baseline_actions is not None and len(observed_actions) else None
        ),
        "samples": int(len(influence)),
        "clusters": int(len(clusters)),
    }
