from __future__ import annotations

from pathlib import Path
from typing import Any
import argparse

import joblib
import pandas as pd
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .round_win_dataset import (CATEGORICAL_ROUND_WIN_FEATURES, NUMERIC_ROUND_WIN_FEATURES,
                                ROUND_WIN_FEATURES, validate_round_win_dataset)
from .round_win_model import FEATURE_VERSION
from .metrics import classification_metrics
from .train import _apply_calibrator, _temporal_policy_split


DEFAULT_ARTIFACT_PATH = Path(__file__).with_name("artifacts") / "v12_candidate" / "round_win_loadout.joblib"


def train_round_win_model(dataset: pd.DataFrame, *, artifact_path: str | Path = DEFAULT_ARTIFACT_PATH,
                          min_samples: int = 200) -> dict[str, Any]:
    validation = validate_round_win_dataset(dataset)
    clean = dataset.dropna(subset=["round_won"]).sort_values("game_start_millis")
    if not validation["valid"] or len(clean) < min_samples or clean["round_won"].nunique() < 2:
        return {"available": False, "reason": "round_win_dataset_insufficient", "validation": validation,
                "samples": len(clean), "feature_version": FEATURE_VERSION}
    split = _temporal_policy_split(clean)
    if split is None:
        return {"available": False, "reason": "round_win_match_grouped_temporal_split_insufficient",
                "samples": len(clean), "feature_version": FEATURE_VERSION}
    train, calibration, selection, test = split
    if train["round_won"].nunique() < 2:
        return {"available": False, "reason": "round_win_training_class_insufficient",
                "samples": len(clean), "feature_version": FEATURE_VERSION}
    excluded = set(validation.get("excluded_feature_candidates") or [])
    active_numeric = [name for name in NUMERIC_ROUND_WIN_FEATURES if name not in excluded]
    active_categorical = [name for name in CATEGORICAL_ROUND_WIN_FEATURES if name not in excluded]
    active_features = active_numeric + active_categorical
    if not active_features:
        return {"available": False, "reason": "round_win_no_usable_features", "validation": validation,
                "samples": len(clean), "feature_version": FEATURE_VERSION}
    preprocess = ColumnTransformer([
        ("numeric", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), active_numeric),
        ("categorical", Pipeline([("impute", SimpleImputer(strategy="most_frequent")),
                                  ("onehot", OneHotEncoder(handle_unknown="ignore"))]), active_categorical),
    ])
    pipeline = Pipeline([("preprocess", preprocess),
                         ("model", LogisticRegression(max_iter=1000, random_state=42))])
    pipeline.fit(train[active_features], train["round_won"].astype(int))
    # The generic helper expects the main feature contract; calibrate locally for the auxiliary contract.
    raw_calibration = pipeline.predict_proba(calibration[active_features])[:, 1]
    calibrators: list[tuple[str, Any]] = [("none", None)]
    if calibration["round_won"].nunique() > 1:
        sigmoid = LogisticRegression().fit(raw_calibration.reshape(-1, 1), calibration["round_won"])
        calibrators.append(("sigmoid", sigmoid))
    raw_selection = pipeline.predict_proba(selection[active_features])[:, 1]
    local_options: list[tuple[str, Any, dict]] = [
        (name, calibrator, classification_metrics(
            selection["round_won"], _apply_calibrator(calibrator, raw_selection),
        ))
        for name, calibrator in calibrators
    ]
    calibration_name, _selection_calibrator, _ = min(local_options, key=lambda item: (
        item[2]["log_loss"], item[2]["brier_score"], item[2]["expected_calibration_error"]))
    final_pipeline = clone(pipeline)
    development = pd.concat([train, calibration], ignore_index=True)
    final_pipeline.fit(development[active_features], development["round_won"].astype(int))
    final_selection_raw = final_pipeline.predict_proba(selection[active_features])[:, 1]
    calibrator = None
    if calibration_name == "sigmoid":
        calibrator = LogisticRegression().fit(
            final_selection_raw.reshape(-1, 1), selection["round_won"],
        )
    raw_test = final_pipeline.predict_proba(test[active_features])[:, 1]
    probabilities = _apply_calibrator(calibrator, raw_test)
    metrics = classification_metrics(test["round_won"], probabilities)
    coverage = len(active_features) / len(ROUND_WIN_FEATURES)
    confidence = max(0.0, min(1.0, coverage * min(1.0, test["match_id"].nunique() / 50) *
                              (1.0 - metrics["expected_calibration_error"])))
    bundle = {"pipeline": final_pipeline, "calibrator": calibrator, "calibration_method": calibration_name,
              "features": active_features, "excluded_features": sorted(excluded), "feature_version": FEATURE_VERSION,
              "model_scope": "global_temporal_match_grouped", "confidence": confidence, "metrics": metrics,
              "final_refit": "train_plus_calibration_then_recalibrated_on_selection",
              "feature_report": validation.get("feature_report"), "train_samples": len(train),
              "calibration_samples": len(calibration), "selection_samples": len(selection),
              "test_samples": len(test),
              "train_matches": int(train["match_id"].nunique()), "calibration_matches": int(calibration["match_id"].nunique()),
              "selection_matches": int(selection["match_id"].nunique()),
              "test_matches": int(test["match_id"].nunique())}
    target = Path(artifact_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, target)
    return {"available": True, "artifact_path": str(target), "samples": len(clean),
            "train_samples": len(train), "calibration_samples": len(calibration),
            "selection_samples": len(selection), "test_samples": len(test), "metrics": metrics,
            "feature_version": FEATURE_VERSION}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the optional pre-round loadout win model.")
    parser.add_argument("dataset", help="Parquet generated by the economy dataset builder.")
    parser.add_argument("--artifact", default=str(DEFAULT_ARTIFACT_PATH))
    parser.add_argument("--min-samples", type=int, default=200)
    args = parser.parse_args()
    from .round_win_dataset import build_round_win_dataset
    result = train_round_win_model(build_round_win_dataset(pd.read_parquet(args.dataset)),
                                   artifact_path=args.artifact, min_samples=args.min_samples)
    print(result)


if __name__ == "__main__":
    main()
