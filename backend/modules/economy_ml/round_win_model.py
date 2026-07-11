from __future__ import annotations

from pathlib import Path
from typing import Any


FEATURE_VERSION = "round-win-loadout-v3"
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
        leaked = self.validate_features(features)
        if leaked:
            return {"available": False, "round_win_probability": None, "confidence": 0.0,
                    "model_scope": "none", "feature_version": FEATURE_VERSION,
                    "warnings": ["round_win_feature_leakage_blocked"]}
        if not self.available():
            return {"available": False, "round_win_probability": None, "confidence": 0.0,
                    "model_scope": "none", "feature_version": FEATURE_VERSION,
                    "warnings": ["round_win_model_unavailable"]}
        try:
            bundle = self.model if isinstance(self.model, dict) else {}
            estimator = bundle.get("pipeline") or self.model
            feature_names = bundle.get("features") or list(features)
            row = {name: features.get(name) for name in feature_names}
            try:
                import pandas as pd
                values: Any = pd.DataFrame([row], columns=feature_names)
            except Exception:
                values = [row]
            if hasattr(estimator, "predict_proba"):
                probability = float(estimator.predict_proba(values)[0][-1])
            else:
                probability = float(estimator.predict(values)[0])
            calibrator = bundle.get("calibrator")
            if calibrator is not None:
                if hasattr(calibrator, "predict_proba"):
                    probability = float(calibrator.predict_proba([[probability]])[0, 1])
                else:
                    probability = float(calibrator.predict([probability])[0])
            return {"available": True, "round_win_probability": max(0.0, min(1.0, probability)),
                    "confidence": float(bundle.get("confidence") or .7),
                    "model_scope": str(bundle.get("model_scope") or "global"),
                    "feature_version": str(bundle.get("feature_version") or FEATURE_VERSION),
                    "warnings": []}
        except Exception:
            return {"available": False, "round_win_probability": None, "confidence": 0.0,
                    "model_scope": "none", "feature_version": FEATURE_VERSION,
                    "warnings": ["round_win_model_prediction_failed"]}
