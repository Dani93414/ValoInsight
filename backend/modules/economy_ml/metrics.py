from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score, brier_score_loss,
                             log_loss, roc_auc_score)

MIN_SLICE_SAMPLES = 200
MAX_SLICE_ECE = 0.05
MIN_SLICE_AUC = 0.55


def reliability_report(metrics: dict) -> dict[str, Any]:
    reasons: list[str] = []
    if int(metrics.get("samples") or 0) < MIN_SLICE_SAMPLES:
        reasons.append("slice_too_small")
    ece = metrics.get("expected_calibration_error")
    if ece is None or float(ece) > MAX_SLICE_ECE:
        reasons.append("slice_calibration_too_weak")
    auc = metrics.get("roc_auc")
    if auc is None or float(auc) < MIN_SLICE_AUC:
        reasons.append("slice_discrimination_too_weak")
    slope = metrics.get("calibration_slope")
    if slope is None or not 0.5 <= float(slope) <= 1.5:
        reasons.append("slice_calibration_slope_unstable")
    return {
        "reliable": not reasons,
        "warning": reasons[0] if reasons else None,
        "reliability_warnings": reasons,
    }


def expected_calibration_error(y_true: Any, probabilities: Any, bins: int = 10) -> float:
    truth = np.asarray(y_true, dtype=int)
    probs = np.asarray(probabilities, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    error = 0.0
    for index in range(bins):
        upper = probs < edges[index + 1] if index < bins - 1 else probs <= 1
        mask = (probs >= edges[index]) & upper
        if mask.any():
            error += float(mask.mean()) * abs(float(truth[mask].mean()) - float(probs[mask].mean()))
    return error


def classification_metrics(y_true: Any, probabilities: Any) -> dict:
    truth = np.asarray(y_true, dtype=int)
    probs = np.clip(np.asarray(probabilities, dtype=float), 1e-7, 1 - 1e-7)
    result = {
        "accuracy": float(accuracy_score(truth, probs >= 0.5)),
        "log_loss": float(log_loss(truth, probs, labels=[0, 1])),
        "brier_score": float(brier_score_loss(truth, probs)),
        "expected_calibration_error": expected_calibration_error(truth, probs),
        "samples": int(len(truth)),
        "positive_rate": float(truth.mean()) if len(truth) else 0.0,
    }
    result["roc_auc"] = float(roc_auc_score(truth, probs)) if len(set(truth)) > 1 else None
    result["pr_auc"] = float(average_precision_score(truth, probs)) if len(set(truth)) > 1 else None
    result["calibration_slope"] = None
    result["calibration_intercept"] = None
    if len(set(truth)) > 1 and len(truth) >= 10:
        logits = np.log(probs / (1 - probs)).reshape(-1, 1)
        calibration = LogisticRegression(C=1e6, solver="lbfgs").fit(logits, truth)
        result["calibration_slope"] = float(calibration.coef_[0, 0])
        result["calibration_intercept"] = float(calibration.intercept_[0])
    return result


def evaluate_slices(frame: pd.DataFrame, probabilities: Any) -> dict:
    evaluated = frame.copy()
    evaluated["_probability"] = probabilities
    result: dict[str, Any] = {"global": classification_metrics(evaluated["match_won"], evaluated["_probability"])}
    for column in (
        "rank_group",
        "rank_name",
        "real_buy_action",
        "macro_buy_case",
        "credit_estimate_quality",
    ):
        if column not in evaluated:
            continue
        result[column] = {
            str(value): (lambda metrics: {**metrics, **reliability_report(metrics)})(
                classification_metrics(group["match_won"], group["_probability"])
            )
            for value, group in evaluated.groupby(column, dropna=False)
        }
    binary_slices = {
        "pistol": "is_pistol_round",
        "bonus": "is_bonus_candidate",
        "overtime": "is_overtime",
    }
    for label, column in binary_slices.items():
        if column in evaluated:
            mask = evaluated[column].astype(bool)
            if mask.any():
                metrics = classification_metrics(
                    evaluated.loc[mask, "match_won"], evaluated.loc[mask, "_probability"]
                )
                result[label] = {**metrics, **reliability_report(metrics)}
    return result
