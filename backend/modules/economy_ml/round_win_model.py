from __future__ import annotations

from pathlib import Path
from typing import Any


FEATURE_VERSION = "round-win-loadout-v4"
FORBIDDEN_ROUND_WIN_FEATURES = {
    "current_round_kills", "current_round_damage", "current_round_plant",
    "current_round_defuse", "current_round_result", "post_round_score",
    "enemy_current_postbuy_loadout",
}


def validate_round_win_features(features: dict[str, Any], *, raise_on_error: bool = False) -> list[str]:
    leaked = sorted(FORBIDDEN_ROUND_WIN_FEATURES.intersection(features))
    if leaked and raise_on_error:
        raise ValueError(f"Forbidden round-win features: {leaked}")
    return leaked


class RoundWinLoadoutModel:
    def __init__(self, artifact_path: str | Path | None = None) -> None:
        self.artifact_path = Path(artifact_path) if artifact_path else Path(__file__).with_name("artifacts") / "round_win_loadout.joblib"
        self.model: Any = None
        if self.artifact_path.exists():
            try:
                import joblib
                loaded = joblib.load(self.artifact_path)
                self.model = loaded if not isinstance(loaded, dict) or loaded.get("feature_version") == FEATURE_VERSION else None
            except Exception:
                self.model = None

    def available(self) -> bool:
        return self.model is not None

    @staticmethod
    def validate_features(features: dict[str, Any]) -> list[str]:
        return validate_round_win_features(features)

    def predict_round_win(self, features: dict[str, Any]) -> dict[str, Any]:
        return self.predict_round_wins([features])[0]

    def predict_round_wins(self, feature_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Predict a shortlist in one estimator call while preserving row order."""
        if not feature_rows:
            return []
        results: list[dict[str, Any] | None] = [None] * len(feature_rows)
        valid_indices: list[int] = []
        valid_rows: list[dict[str, Any]] = []
        for index, features in enumerate(feature_rows):
            if self.validate_features(features):
                results[index] = {
                    "available": False, "round_win_probability": None, "confidence": 0.0,
                    "model_scope": "none", "feature_version": FEATURE_VERSION,
                    "warnings": ["round_win_feature_leakage_blocked"],
                }
            else:
                valid_indices.append(index)
                valid_rows.append(features)
        if not self.available():
            unavailable = {
                "available": False, "round_win_probability": None, "confidence": 0.0,
                "model_scope": "none", "feature_version": FEATURE_VERSION,
                "warnings": ["round_win_model_unavailable"],
            }
            for index in valid_indices:
                results[index] = dict(unavailable)
            return [item or dict(unavailable) for item in results]
        try:
            bundle = self.model if isinstance(self.model, dict) else {}
            estimator = bundle.get("pipeline") or self.model
            feature_names = bundle.get("features") or list(valid_rows[0])
            rows = [{name: features.get(name) for name in feature_names} for features in valid_rows]
            try:
                import pandas as pd
                values: Any = pd.DataFrame(rows, columns=feature_names)
            except Exception:
                values = rows
            if hasattr(estimator, "predict_proba"):
                probabilities = [float(row[-1]) for row in estimator.predict_proba(values)]
            else:
                probabilities = [float(value) for value in estimator.predict(values)]
            calibrator = bundle.get("calibrator")
            if calibrator is not None:
                if hasattr(calibrator, "predict_proba"):
                    probabilities = [
                        float(row[-1])
                        for row in calibrator.predict_proba([[probability] for probability in probabilities])
                    ]
                else:
                    probabilities = [float(value) for value in calibrator.predict(probabilities)]
            for index, probability in zip(valid_indices, probabilities):
                results[index] = {
                    "available": True,
                    "round_win_probability": max(0.0, min(1.0, probability)),
                    "confidence": float(bundle.get("confidence") or .7),
                    "model_scope": str(bundle.get("model_scope") or "global"),
                    "feature_version": str(bundle.get("feature_version") or FEATURE_VERSION),
                    "warnings": [],
                }
        except Exception:
            failed = {
                "available": False, "round_win_probability": None, "confidence": 0.0,
                "model_scope": "none", "feature_version": FEATURE_VERSION,
                "warnings": ["round_win_model_prediction_failed"],
            }
            for index in valid_indices:
                results[index] = dict(failed)
        fallback = {
            "available": False, "round_win_probability": None, "confidence": 0.0,
            "model_scope": "none", "feature_version": FEATURE_VERSION,
            "warnings": ["round_win_model_prediction_failed"],
        }
        return [item or dict(fallback) for item in results]
