from __future__ import annotations

import argparse
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .dataset_builder import DEFAULT_DATASET_PATH
from .metrics import classification_metrics, evaluate_slices
from . import model_registry
from .schemas import (
    CATEGORICAL_FEATURES, FORBIDDEN_FEATURES, MODEL_FEATURES, NUMERIC_FEATURES,
    AGENT_UTILITY_NUMERIC_FEATURES,
    PREBUY_CATEGORICAL_FEATURES, PREBUY_NUMERIC_FEATURES, PROPENSITY_FEATURES,
    ACTION_FEATURES, LABEL_COLUMNS, SCHEMA_VERSION, STATE_FEATURES, validate_no_feature_leakage,
)
from .ability_catalog import ability_costs_available
from .config import PLAN_VALUE_WEIGHTS
from .data_availability import build_data_availability_report
from .action_profiles import learn_action_profiles, minimum_action_credits, simulate_action_features
from .off_policy_evaluation import doubly_robust_policy_value
from .economy_rules import pistol_action_guardrail
from .team_plan import evaluate_team_plan_from_action

MIN_SAMPLES_GLOBAL = 1000
MIN_SAMPLES_RANK_GROUP = 700
MIN_SAMPLES_RANK_NAME = 500
MIN_ACTION_SUPPORT = 25
MAX_IPW_WEIGHT = 10.0
MIN_PROPENSITY = 0.02
MIN_ISOTONIC_SAMPLES = 200
MIN_POLICY_VALUE_MARGIN = 0.04
POLICY_CASE_MARGINS = {
    "normal": 0.04,
    "eco": 0.08,
    "pistol": 0.10,
    "bonus": 0.08,
    "stabilization": 0.06,
    "match_point_or_overtime": 0.12,
}

POLICY_SEARCH_CONFIGS = [
    {"name": "balanced", "margin_scale": 1.0},
    {"name": "high_confidence", "margin_scale": 1.5},
    {"name": "very_high_confidence", "margin_scale": 2.0},
    {"name": "premium_buy_only", "margin_scale": 1.5,
     "allowed_actions": ["FULL_RIFLES", "FULL_OPERATOR", "BONUS_KEEP_WEAPONS"]},
]


def _preprocessor(numeric: list[str], categorical: list[str], scale: bool) -> ColumnTransformer:
    numeric_steps: list[tuple[str, Any]] = [("imputer", SimpleImputer(strategy="median"))]
    if scale:
        numeric_steps.append(("scaler", StandardScaler()))
    return ColumnTransformer([
        ("numeric", Pipeline(numeric_steps), numeric),
        ("categorical", Pipeline([
            ("imputer", SimpleImputer(strategy="most_frequent")),
            ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
        ]), categorical),
    ])


def _temporal_split(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame] | None:
    if (pd.to_numeric(frame["game_start_millis"], errors="coerce").fillna(0) <= 0).mean() > 0.1:
        return None
    matches = (
        frame[["match_id", "game_start_millis"]]
        .drop_duplicates("match_id")
        .sort_values(["game_start_millis", "match_id"])
    )
    if len(matches) < 5:
        return None
    train_end = max(1, int(len(matches) * 0.6))
    calibration_end = max(train_end + 1, int(len(matches) * 0.8))
    train_ids = set(matches.iloc[:train_end]["match_id"])
    calibration_ids = set(matches.iloc[train_end:calibration_end]["match_id"])
    test_ids = set(matches.iloc[calibration_end:]["match_id"])
    return (
        frame[frame["match_id"].isin(train_ids)].copy(),
        frame[frame["match_id"].isin(calibration_ids)].copy(),
        frame[frame["match_id"].isin(test_ids)].copy(),
    )


def _temporal_policy_split(
    frame: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame] | None:
    """Four disjoint match/time blocks: fit, calibrate, select policy, final test."""
    if (pd.to_numeric(frame["game_start_millis"], errors="coerce").fillna(0) <= 0).mean() > 0.1:
        return None
    matches = (
        frame[["match_id", "game_start_millis"]]
        .drop_duplicates("match_id")
        .sort_values(["game_start_millis", "match_id"])
    )
    if len(matches) < 8:
        return None
    train_end = max(1, int(len(matches) * 0.55))
    calibration_end = max(train_end + 1, int(len(matches) * 0.70))
    selection_end = max(calibration_end + 1, int(len(matches) * 0.85))
    train_ids = set(matches.iloc[:train_end]["match_id"])
    calibration_ids = set(matches.iloc[train_end:calibration_end]["match_id"])
    selection_ids = set(matches.iloc[calibration_end:selection_end]["match_id"])
    test_ids = set(matches.iloc[selection_end:]["match_id"])
    return tuple(
        frame[frame["match_id"].isin(ids)].copy()
        for ids in (train_ids, calibration_ids, selection_ids, test_ids)
    )


def _propensity_weights(train: pd.DataFrame) -> tuple[Pipeline | None, np.ndarray, dict]:
    actions = train["real_buy_action"].astype(str)
    if actions.nunique() < 2:
        return None, np.ones(len(train)), {"available": False, "reason": "single_action"}
    def build() -> Pipeline:
        return Pipeline([
            ("prepare", _preprocessor(PREBUY_NUMERIC_FEATURES, PREBUY_CATEGORICAL_FEATURES, True)),
            ("model", LogisticRegression(max_iter=1500)),
        ])
    ordered_matches = (train[["match_id", "game_start_millis"]].drop_duplicates("match_id")
                       .sort_values(["game_start_millis", "match_id"]))
    chunks = [list(chunk) for chunk in np.array_split(ordered_matches["match_id"].to_numpy(), 5) if len(chunk)]
    observed = np.full(len(train), np.nan, dtype=float)
    for fold in range(1, len(chunks)):
        fit_ids = {item for chunk in chunks[:fold] for item in chunk}
        validation_ids = set(chunks[fold])
        fit_mask = train["match_id"].isin(fit_ids)
        validation_mask = train["match_id"].isin(validation_ids)
        fit_actions = actions.loc[fit_mask]
        if fit_actions.nunique() < 2:
            continue
        cross_fitted = build()
        cross_fitted.fit(train.loc[fit_mask, PROPENSITY_FEATURES], fit_actions)
        probabilities = cross_fitted.predict_proba(train.loc[validation_mask, PROPENSITY_FEATURES])
        classes = list(cross_fitted.named_steps["model"].classes_)
        positions = np.flatnonzero(validation_mask.to_numpy())
        for row_position, probability_row in zip(positions, probabilities):
            action = actions.iloc[row_position]
            observed[row_position] = probability_row[classes.index(action)] if action in classes else MIN_PROPENSITY
    propensity = build()
    propensity.fit(train[PROPENSITY_FEATURES], actions)
    classes = list(propensity.named_steps["model"].classes_)
    marginal = actions.value_counts(normalize=True).to_dict()
    missing_oof = np.isnan(observed)
    observed[missing_oof] = np.array([marginal[action] for action in actions.to_numpy()[missing_oof]])
    stabilized = np.array([marginal[action] / max(observed[index], MIN_PROPENSITY) for index, action in enumerate(actions)])
    weights = np.clip(stabilized, 0.1, MAX_IPW_WEIGHT)
    action_support = actions.value_counts().astype(int).to_dict()
    clipping_rate = float(((stabilized > MAX_IPW_WEIGHT) | (stabilized < 0.1)).mean())
    effective_sample_size = float((weights.sum() ** 2) / np.square(weights).sum()) if len(weights) else 0.0
    propensity_by_action = {
        str(action): {
            "samples": int((actions == action).sum()),
            "mean_observed_probability": float(observed[actions.to_numpy() == action].mean()),
            "min_observed_probability": float(observed[actions.to_numpy() == action].min()),
        }
        for action in classes
        if (actions == action).any()
    }
    return propensity, weights, {
        "available": True, "classes": classes,
        "min_observed_probability": float(observed.min()),
        "max_observed_probability": float(observed.max()),
        "observed_probability_percentiles": {str(p): float(np.percentile(observed, p)) for p in (1, 5, 25, 50, 75, 95, 99)},
        "max_weight": float(weights.max()),
        "weight_percentiles": {str(p): float(np.percentile(weights, p)) for p in (1, 5, 25, 50, 75, 95, 99)},
        "clipping_rate": clipping_rate,
        "effective_sample_size": effective_sample_size,
        "oof_coverage": float((~missing_oof).mean()),
        "cross_fitting": "expanding_temporal_match_grouped",
        "propensity_by_action": propensity_by_action,
        "low_support_actions": {
            action: count for action, count in action_support.items()
            if count < MIN_ACTION_SUPPORT
        },
        "estimator_kind": "stabilized_ipw_observational_not_causal",
    }


MODEL_LABELS = {
    "match_win_model": "match_won",
    "round_win_model": "round_won",
    "fullbuy_next_round_model": "next_round_fullbuy_possible",
}


def _apply_calibrator(calibrator: Any, raw: np.ndarray) -> np.ndarray:
    if calibrator is None:
        return raw
    if hasattr(calibrator, "predict_proba"):
        return calibrator.predict_proba(raw.reshape(-1, 1))[:, 1]
    return np.asarray(calibrator.predict(raw), dtype=float)


def _calibration_candidates(raw_pipeline: Pipeline, calibration: pd.DataFrame, label: str) -> list[tuple[str, Any]]:
    if calibration.empty or calibration[label].nunique() < 2:
        return [("none", None)]
    raw = raw_pipeline.predict_proba(calibration[MODEL_FEATURES])[:, 1]
    candidates: list[tuple[str, Any]] = [("none", None)]
    sigmoid = LogisticRegression().fit(raw.reshape(-1, 1), calibration[label])
    candidates.append(("sigmoid", sigmoid))
    if len(calibration) >= MIN_ISOTONIC_SAMPLES and calibration[label].value_counts().min() >= 30:
        candidates.append(("isotonic", IsotonicRegression(out_of_bounds="clip").fit(raw, calibration[label])))
    return candidates


def _predict(bundle: dict, frame: pd.DataFrame, model_key: str = "match_win_model") -> np.ndarray:
    model_bundle = (bundle.get("models") or {}).get(model_key) or bundle
    raw = model_bundle["pipeline"].predict_proba(frame[MODEL_FEATURES])[:, 1]
    calibrator = model_bundle.get("calibrator")
    return _apply_calibrator(calibrator, raw)


def _fit_binary_model(
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    selection: pd.DataFrame,
    test: pd.DataFrame,
    weights: np.ndarray,
    final_train: pd.DataFrame,
    final_weights: np.ndarray,
    label: str,
) -> tuple[dict | None, dict | None, dict | None]:
    if train[label].nunique() < 2 or test.empty or test[label].nunique() < 1:
        return None, None, None
    candidates = {"logistic_regression": Pipeline([
        ("prepare", _preprocessor(NUMERIC_FEATURES, CATEGORICAL_FEATURES, True)),
        ("model", LogisticRegression(max_iter=1500)),
    ]), "hist_gradient_boosting": Pipeline([
        ("prepare", _preprocessor(NUMERIC_FEATURES, CATEGORICAL_FEATURES, False)),
        ("model", HistGradientBoostingClassifier(random_state=42)),
    ])}
    evaluated = []
    for name, pipeline in candidates.items():
        pipeline.fit(train[MODEL_FEATURES], train[label], model__sample_weight=weights)
        for calibration_name, calibrator in _calibration_candidates(pipeline, calibration, label):
            selection_raw = pipeline.predict_proba(selection[MODEL_FEATURES])[:, 1]
            selection_metrics = classification_metrics(
                selection[label], _apply_calibrator(calibrator, selection_raw),
            )
            evaluated.append({"name": name, "pipeline": pipeline, "calibration": calibration_name,
                              "calibrator": calibrator, "selection_metrics": selection_metrics})
    def selection_key(item: dict) -> tuple:
        metrics = item["selection_metrics"]
        return (metrics.get("log_loss", float("inf")), metrics.get("brier_score", float("inf")),
                metrics.get("expected_calibration_error", float("inf")), -(metrics.get("roc_auc") or 0.0))
    selected = min(evaluated, key=selection_key)
    selection_bundle = {
        "pipeline": selected["pipeline"], "calibrator": selected["calibrator"],
        "selected_model": selected["name"], "calibration_method": selected["calibration"],
    }
    final_pipeline = clone(selected["pipeline"])
    final_pipeline.fit(final_train[MODEL_FEATURES], final_train[label], model__sample_weight=final_weights)
    final_raw_selection = final_pipeline.predict_proba(selection[MODEL_FEATURES])[:, 1]
    final_calibrator = None
    if selected["calibration"] == "sigmoid":
        final_calibrator = LogisticRegression().fit(
            final_raw_selection.reshape(-1, 1), selection[label],
        )
    elif selected["calibration"] == "isotonic":
        final_calibrator = IsotonicRegression(out_of_bounds="clip").fit(
            final_raw_selection, selection[label],
        )
    final_bundle = {
        "pipeline": final_pipeline, "calibrator": final_calibrator,
        "selected_model": selected["name"], "calibration_method": selected["calibration"],
        "final_refit": "train_plus_calibration_then_recalibrated_on_policy_selection",
    }
    probabilities = _predict(final_bundle, test, "match_win_model")
    prevalence = float(train[label].mean())
    baseline_probabilities = np.full(len(test), prevalence)
    metrics = classification_metrics(test[label], probabilities)
    metrics["baseline_global"] = classification_metrics(test[label], baseline_probabilities)
    metrics["selected_model"] = selected["name"]
    metrics["selection_criterion"] = "heldout_selection_log_loss_then_brier_then_ece_then_roc_auc"
    metrics["calibration_method"] = selected["calibration"]
    metrics["candidates"] = [{"model": item["name"], "calibration": item["calibration"],
                               "selection_metrics": item["selection_metrics"]} for item in evaluated]
    return final_bundle, selection_bundle, metrics


def _fit_heterogeneous_policy_model(
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    selection: pd.DataFrame,
    train_weights: np.ndarray,
    development: pd.DataFrame,
    development_weights: np.ndarray,
) -> tuple[dict, dict, dict]:
    """Fit an interaction-capable outcome model dedicated to policy ranking."""
    pipeline = Pipeline([
        ("prepare", _preprocessor(NUMERIC_FEATURES, CATEGORICAL_FEATURES, False)),
        ("model", HistGradientBoostingClassifier(random_state=42)),
    ])
    pipeline.fit(train[MODEL_FEATURES], train["match_won"], model__sample_weight=train_weights)
    evaluated = []
    selection_raw = pipeline.predict_proba(selection[MODEL_FEATURES])[:, 1]
    for name, calibrator in _calibration_candidates(pipeline, calibration, "match_won"):
        evaluated.append((
            classification_metrics(selection["match_won"], _apply_calibrator(calibrator, selection_raw)),
            name,
            calibrator,
        ))
    metrics, calibration_name, calibrator = min(
        evaluated,
        key=lambda item: (
            item[0].get("log_loss", float("inf")),
            item[0].get("brier_score", float("inf")),
            item[0].get("expected_calibration_error", float("inf")),
        ),
    )
    selection_model = {
        "pipeline": pipeline,
        "calibrator": calibrator,
        "selected_model": "hist_gradient_boosting_policy",
        "calibration_method": calibration_name,
    }
    final_pipeline = clone(pipeline)
    final_pipeline.fit(
        development[MODEL_FEATURES], development["match_won"],
        model__sample_weight=development_weights,
    )
    final_raw = final_pipeline.predict_proba(selection[MODEL_FEATURES])[:, 1]
    final_calibrator = None
    if calibration_name == "sigmoid":
        final_calibrator = LogisticRegression().fit(
            final_raw.reshape(-1, 1), selection["match_won"],
        )
    elif calibration_name == "isotonic":
        final_calibrator = IsotonicRegression(out_of_bounds="clip").fit(
            final_raw, selection["match_won"],
        )
    final_model = {
        "pipeline": final_pipeline,
        "calibrator": final_calibrator,
        "selected_model": "hist_gradient_boosting_policy",
        "calibration_method": calibration_name,
        "final_refit": "train_plus_calibration_then_recalibrated_on_policy_selection",
    }
    return selection_model, final_model, metrics


def _evaluate_policy_doubly_robust(
    bundle: dict,
    test: pd.DataFrame,
    action_support: dict[str, int],
    *,
    policy_enabled: bool = True,
    case_margins: dict[str, float] | None = None,
    allowed_cases: list[str] | None = None,
    allowed_actions: list[str] | None = None,
    policy_name: str = "balanced",
) -> dict:
    configured_margins = case_margins or POLICY_CASE_MARGINS
    propensity = bundle.get("propensity_pipeline")
    supported = [
        action for action, count in action_support.items()
        if count >= MIN_ACTION_SUPPORT
    ]
    if propensity is None or not supported or test.empty:
        return {"available": False, "reason": "missing_propensity_support_or_test"}
    propensity_classes = list(propensity.named_steps["model"].classes_)
    observed_actions = test["real_buy_action"].astype(str).to_numpy()
    propensity_rows = propensity.predict_proba(test[PROPENSITY_FEATURES])
    observed_propensities = np.array([
        row[propensity_classes.index(action)] if action in propensity_classes else MIN_PROPENSITY
        for row, action in zip(propensity_rows, observed_actions)
    ])
    observed_predictions = _predict(bundle, test)
    action_profiles = bundle.get("action_profiles") or {}
    candidate_predictions: dict[str, np.ndarray] = {}
    round_predictions: dict[str, np.ndarray] = {}
    future_predictions: dict[str, np.ndarray] = {}
    availability: dict[str, np.ndarray] = {}
    records = test.to_dict("records")
    for action in supported:
        candidate = test.copy()
        candidate["buy_action"] = action
        original_records = candidate.to_dict("records")
        profile = action_profiles.get(action)
        simulated = [simulate_action_features(row, action, profile) for row in original_records]
        for feature in ACTION_FEATURES:
            if feature == "buy_action":
                continue
            candidate[feature] = [
                item.get(feature, original.get(feature))
                for item, original in zip(simulated, original_records)
            ]
        candidate_predictions[action] = _predict(bundle, candidate)
        round_predictions[action] = _predict(bundle, candidate, "round_win_model")
        future_predictions[action] = _predict(bundle, candidate, "fullbuy_next_round_model")
        action_position = propensity_classes.index(action) if action in propensity_classes else None
        state_propensity = (
            propensity_rows[:, action_position]
            if action_position is not None else np.zeros(len(test), dtype=float)
        )
        legal = []
        required_full_buyers = {
            "FORCE_2_RIFLES": 2, "FULL_RIFLES": 4, "FULL_OPERATOR": 4,
        }.get(action, 0)
        for row, probability in zip(records, state_propensity):
            pistol_allowed, _ = pistol_action_guardrail(action, row)
            legal.append(
                pistol_allowed
                and float(row.get("team_estimated_credits_before_buy") or 0) >= minimum_action_credits(action)
                and (action != "BONUS_KEEP_WEAPONS" or bool(row.get("is_bonus_candidate")))
                and int(row.get("team_players_can_full_buy_estimate") or 0) >= required_full_buyers
                and float(probability) >= MIN_PROPENSITY
            )
        availability[action] = np.asarray(legal, dtype=bool)

    match_matrix = np.column_stack([candidate_predictions[action] for action in supported])
    round_matrix = np.column_stack([round_predictions[action] for action in supported])
    future_matrix = np.column_stack([future_predictions[action] for action in supported])
    available_matrix = np.column_stack([availability[action] for action in supported])
    rule_values = np.full_like(match_matrix, -np.inf, dtype=float)
    ml_values = np.full_like(match_matrix, -np.inf, dtype=float)
    required_margins = np.full_like(match_matrix, np.inf, dtype=float)
    plan_contexts = np.full(match_matrix.shape, "normal", dtype=object)
    for column, action in enumerate(supported):
        profile = action_profiles.get(action)
        for index, row in enumerate(records):
            if not available_matrix[index, column]:
                continue
            rule_plan = evaluate_team_plan_from_action(row, action, 0.5, learned_profile=profile)
            rule_plan["predicted_round_win"] = 0.5
            rule_plan["next_round_fullbuy_probability"] = float(
                rule_plan.get("future_economy_score") or 0.5
            )
            from .plan_evaluator import evaluate_plan_value
            rule_plan.update(evaluate_plan_value(rule_plan, row))
            rule_values[index, column] = float(rule_plan["team_plan_value"])
            ml_plan = evaluate_team_plan_from_action(
                row, action, float(match_matrix[index, column]), learned_profile=profile,
            )
            ml_plan["predicted_round_win"] = float(round_matrix[index, column])
            ml_plan["next_round_fullbuy_probability"] = float(future_matrix[index, column])
            ml_plan["future_economy_score"] = float(future_matrix[index, column])
            ml_plan.update(evaluate_plan_value(ml_plan, row))
            ml_values[index, column] = float(ml_plan["team_plan_value"])
            context = str(ml_plan.get("plan_value_context") or "normal")
            plan_contexts[index, column] = context
            required_margins[index, column] = float(
                configured_margins.get(context, MIN_POLICY_VALUE_MARGIN)
            )
            if bool(row.get("is_overtime")):
                required_margins[index, column] = np.inf

    # A recommendation model is an overlay on the deterministic rules.  It may
    # change the baseline only with enough estimated value margin; otherwise it
    # abstains and leaves the rules in control.
    rows_with_support = available_matrix.any(axis=1)
    baseline_indices = np.argmax(rule_values, axis=1)
    best_ml_indices = np.argmax(ml_values, axis=1)
    baseline_values = rule_values[np.arange(len(test)), baseline_indices]
    best_ml_values = ml_values[np.arange(len(test)), best_ml_indices]
    selected_margins = required_margins[np.arange(len(test)), best_ml_indices]
    selected_contexts = plan_contexts[np.arange(len(test)), best_ml_indices]
    selected_actions = np.array([supported[index] for index in best_ml_indices])
    value_gain = np.full(len(test), -np.inf, dtype=float)
    value_gain[rows_with_support] = (
        best_ml_values[rows_with_support] - baseline_values[rows_with_support]
    )
    change = policy_enabled & (value_gain >= selected_margins)
    if allowed_cases is not None:
        change &= np.isin(selected_contexts, np.asarray(allowed_cases, dtype=object))
    if allowed_actions is not None:
        change &= np.isin(selected_actions, np.asarray(allowed_actions, dtype=object))
    target_indices = np.where(change, best_ml_indices, baseline_indices)
    target_actions = np.array([supported[index] for index in target_indices])
    baseline_actions = np.array([supported[index] for index in baseline_indices])
    target_predictions = match_matrix[np.arange(len(match_matrix)), target_indices]
    baseline_predictions = match_matrix[np.arange(len(match_matrix)), baseline_indices]
    evaluation = doubly_robust_policy_value(
        outcomes=test["match_won"].to_numpy(dtype=float),
        observed_actions=observed_actions,
        target_actions=target_actions,
        observed_propensities=observed_propensities,
        observed_outcome_predictions=observed_predictions,
        target_outcome_predictions=target_predictions,
        baseline_actions=baseline_actions,
        baseline_outcome_predictions=baseline_predictions,
        match_ids=test["match_id"].to_numpy(),
    )
    interval = evaluation.get("improvement_confidence_interval_95") or []
    activation_eligible = bool(len(interval) == 2 and float(interval[0]) > 0)
    return evaluation | {
        "policy_definition": "conservative_ml_overlay_on_deterministic_rules_proxy",
        "policy_name": policy_name,
        "policy_enabled_from_selection": policy_enabled,
        "case_margins": configured_margins,
        "allowed_cases": allowed_cases,
        "allowed_actions": allowed_actions,
        "disabled_cases": ["overtime"],
        "abstention_rate": round(float((~change).mean()), 6),
        "supported_state_rate": round(float(rows_with_support.mean()), 6),
        "activation_eligible": activation_eligible,
    }


def _select_policy_config(bundle: dict, selection: pd.DataFrame, action_support: dict[str, int]) -> tuple[dict, dict, list[dict]]:
    candidates: list[tuple[dict, dict]] = []
    for raw_config in POLICY_SEARCH_CONFIGS:
        scale = float(raw_config.get("margin_scale") or 1.0)
        config = {
            "name": str(raw_config["name"]),
            "case_margins": {
                case: round(float(margin) * scale, 6)
                for case, margin in POLICY_CASE_MARGINS.items()
            },
            "allowed_cases": raw_config.get("allowed_cases"),
            "allowed_actions": raw_config.get("allowed_actions"),
            "disabled_cases": ["overtime"],
        }
        evaluation = _evaluate_policy_doubly_robust(
            bundle, selection, action_support,
            case_margins=config["case_margins"],
            allowed_cases=config["allowed_cases"],
            allowed_actions=config["allowed_actions"],
            policy_name=config["name"],
        )
        candidates.append((config, evaluation))

    def rank(item: tuple[dict, dict]) -> tuple[float, float, float]:
        evaluation = item[1]
        interval = evaluation.get("improvement_confidence_interval_95") or [-1.0, -1.0]
        return (
            float(interval[0]),
            float(evaluation.get("estimated_improvement") or 0.0),
            float(evaluation.get("abstention_rate") or 0.0),
        )

    selected_config, selected_evaluation = max(candidates, key=rank)
    summaries = [
        {
            "name": config["name"],
            "estimated_improvement": evaluation.get("estimated_improvement"),
            "improvement_confidence_interval_95": evaluation.get("improvement_confidence_interval_95"),
            "abstention_rate": evaluation.get("abstention_rate"),
            "activation_eligible": evaluation.get("activation_eligible"),
        }
        for config, evaluation in candidates
    ]
    return selected_config, selected_evaluation, summaries


def _fit_scope(
    frame: pd.DataFrame, scope: str, value: str | None, artifacts_dir: Path
) -> dict | None:
    if frame["match_won"].nunique() < 2:
        return None
    frame = frame.copy()
    frame["buy_action"] = frame["real_buy_action"]
    split = _temporal_policy_split(frame)
    if split is None:
        return None
    train, calibration, policy_selection, test = split
    if train["match_won"].nunique() < 2 or test.empty:
        return None
    selection_propensity, selection_weights, selection_propensity_metadata = _propensity_weights(train)
    development = pd.concat([train, calibration], ignore_index=True).sort_values(
        ["game_start_millis", "match_id"]
    )
    propensity, final_weights, propensity_metadata = _propensity_weights(development)
    action_profiles = learn_action_profiles(development, min_samples=MIN_ACTION_SUPPORT)
    selection_action_profiles = learn_action_profiles(train, min_samples=MIN_ACTION_SUPPORT)
    fitted_models: dict[str, dict] = {}
    selection_models: dict[str, dict] = {}
    model_metrics: dict[str, dict] = {}
    for model_key, label in MODEL_LABELS.items():
        if label not in train:
            continue
        model_bundle, selection_model_bundle, metrics = _fit_binary_model(
            train, calibration, policy_selection, test, selection_weights,
            development, final_weights, label,
        )
        if model_bundle:
            fitted_models[model_key] = model_bundle
            selection_models[model_key] = selection_model_bundle or model_bundle
            model_metrics[model_key] = metrics or {}
    if "match_win_model" not in fitted_models:
        return None
    policy_hgb_selection, policy_hgb_final, policy_hgb_metrics = _fit_heterogeneous_policy_model(
        train, calibration, policy_selection, selection_weights, development, final_weights,
    )
    action_support = development["real_buy_action"].value_counts().astype(int).to_dict()
    bundle = {
        "pipeline": fitted_models["match_win_model"]["pipeline"],
        "calibrator": fitted_models["match_win_model"].get("calibrator"),
        "models": fitted_models,
        "propensity_pipeline": propensity,
        "scope": scope, "value": value, "features": MODEL_FEATURES,
        "schema_version": SCHEMA_VERSION, "action_support": action_support,
        "action_profiles": action_profiles,
        "min_action_support": MIN_ACTION_SUPPORT,
    }
    selection_bundle = {
        "pipeline": selection_models["match_win_model"]["pipeline"],
        "calibrator": selection_models["match_win_model"].get("calibrator"),
        "models": selection_models,
        "propensity_pipeline": selection_propensity,
        "scope": scope, "value": value, "features": MODEL_FEATURES,
        "schema_version": SCHEMA_VERSION, "action_support": (
            train["real_buy_action"].value_counts().astype(int).to_dict()
        ),
        "action_profiles": selection_action_profiles,
        "min_action_support": MIN_ACTION_SUPPORT,
    }
    probabilities = _predict(bundle, test, "match_win_model")
    metrics = evaluate_slices(test, probabilities)
    metrics["models"] = model_metrics
    heterogeneous_selection_bundle = {
        **selection_bundle,
        "models": {**selection_bundle["models"], "match_win_model": policy_hgb_selection},
    }
    policy_model_candidates = []
    for outcome_model, candidate_bundle in (
        ("predictive_model", selection_bundle),
        ("heterogeneous_hgb", heterogeneous_selection_bundle),
    ):
        config, evaluation, search = _select_policy_config(
            candidate_bundle, policy_selection, candidate_bundle["action_support"],
        )
        config["outcome_model"] = outcome_model
        for item in search:
            item["outcome_model"] = outcome_model
        policy_model_candidates.append((config, evaluation, search))

    def policy_rank(item: tuple[dict, dict, list[dict]]) -> tuple[float, float, float]:
        evaluation = item[1]
        interval = evaluation.get("improvement_confidence_interval_95") or [-1.0, -1.0]
        return (
            float(interval[0]),
            float(evaluation.get("estimated_improvement") or 0.0),
            float(evaluation.get("abstention_rate") or 0.0),
        )

    selected_policy_config, policy_selection_metrics, _ = max(
        policy_model_candidates, key=policy_rank,
    )
    policy_search = [item for _config, _evaluation, search in policy_model_candidates for item in search]
    selection_interval = policy_selection_metrics.get("improvement_confidence_interval_95") or []
    policy_selected = bool(
        len(selection_interval) == 2 and float(selection_interval[0]) > 0
    )
    bundle["policy_config"] = {
        "selected": policy_selected,
        **selected_policy_config,
        "selection_evaluation": policy_selection_metrics,
        "search_summary": policy_search,
    }
    metrics["policy_selection"] = policy_selection_metrics
    metrics["policy_outcome_models"] = {
        "predictive_model": model_metrics.get("match_win_model"),
        "heterogeneous_hgb": policy_hgb_metrics,
    }
    policy_evaluation_bundle = bundle
    if selected_policy_config.get("outcome_model") == "heterogeneous_hgb":
        fitted_models["policy_match_win_model"] = policy_hgb_final
        policy_evaluation_bundle = {
            **bundle,
            "models": {**bundle["models"], "match_win_model": policy_hgb_final},
        }
    metrics["policy_evaluation"] = _evaluate_policy_doubly_robust(
        policy_evaluation_bundle, test, action_support, policy_enabled=policy_selected,
        case_margins=selected_policy_config["case_margins"],
        allowed_cases=selected_policy_config.get("allowed_cases"),
        allowed_actions=selected_policy_config.get("allowed_actions"),
        policy_name=selected_policy_config["name"],
    )
    bundle["metrics"] = metrics
    bundle["train_matches"] = int(train["match_id"].nunique())
    bundle["calibration_matches"] = int(calibration["match_id"].nunique())
    bundle["policy_selection_matches"] = int(policy_selection["match_id"].nunique())
    bundle["test_matches"] = int(test["match_id"].nunique())
    bundle["selected_model"] = fitted_models["match_win_model"].get("selected_model")
    bundle["calibration_method"] = fitted_models["match_win_model"].get("calibration_method")
    model_registry.save_model(bundle, scope, value, artifacts_dir)
    return {
        "samples": len(frame), "train_samples": len(train), "calibration_samples": len(calibration),
        "policy_selection_samples": len(policy_selection),
        "test_samples": len(test),
        "train_matches": int(train["match_id"].nunique()),
        "calibration_matches": int(calibration["match_id"].nunique()),
        "policy_selection_matches": int(policy_selection["match_id"].nunique()),
        "test_matches": int(test["match_id"].nunique()),
        "action_support": action_support,
        "propensity": propensity_metadata, "metrics": metrics,
        "labels": {key: label for key, label in MODEL_LABELS.items() if key in fitted_models},
    }


def train_models(
    dataset: pd.DataFrame,
    *,
    enforce_minimums: bool = True,
    train_scoped_models: bool = False,
) -> dict:
    required = [column for column in MODEL_FEATURES if column != "buy_action"]
    required += ["match_id", "game_start_millis", "match_won", "round_won", "real_buy_action"]
    missing = [column for column in required if column not in dataset]
    if missing:
        raise ValueError(f"Dataset missing required columns: {missing}")
    invalid_timestamp_rate = (
        pd.to_numeric(dataset["game_start_millis"], errors="coerce").fillna(0) <= 0
    ).mean()
    if invalid_timestamp_rate > 0.1:
        raise ValueError("Dataset lacks enough valid timestamps for temporal evaluation")
    if (dataset["real_buy_action"] == "UNKNOWN").any():
        raise ValueError("Dataset contains UNKNOWN buy actions")
    leakage = validate_no_feature_leakage(MODEL_FEATURES)
    if not leakage["valid"]:
        raise ValueError(f"Forbidden or post-round model features: {leakage}")
    availability = build_data_availability_report()
    training_match_ids = sorted(str(value) for value in dataset["match_id"].dropna().unique())
    metadata = {
        "schema_version": SCHEMA_VERSION, "created_at": datetime.now(timezone.utc).isoformat(),
        "dataset_rows": len(dataset), "dataset_matches": int(dataset["match_id"].nunique()),
        "features": MODEL_FEATURES, "feature_version": f"economy-features-v{SCHEMA_VERSION}",
        "feature_groups": {"state": STATE_FEATURES, "action": ACTION_FEATURES, "labels": LABEL_COLUMNS},
        "training_match_ids": training_match_ids,
        "categorical_features": CATEGORICAL_FEATURES, "numeric_features": NUMERIC_FEATURES,
        "includes_agent_utility": True,
        "agent_utility_features": AGENT_UTILITY_NUMERIC_FEATURES,
        "labels": MODEL_LABELS,
        "available_data_report_hash": availability.get("report_hash"),
        "ability_cost_available": ability_costs_available(),
        "prebuy_credit_source": "selected_from_observed_rules_reconciliation",
        "supports_regen_shield": True,
        "weapon_taxonomy_version": "valorant-content-taxonomy-v2",
        "planned_cashflow_available": True,
        "agent_utility_available": True,
        "player_style_available": "fallback_or_embedded_analytics",
        "player_form_available": True,
        "ultimate_inference_available": True,
        "plan_value_weights": PLAN_VALUE_WEIGHTS,
        "estimation_type": "observational_off_policy_doubly_robust_aipw",
        "limitations": [
            "Las estimaciones no prueban causalidad.",
            "Solo se recomiendan acciones con soporte histórico suficiente.",
            "Las alternativas usan perfiles de compra simulados y auditables.",
            "No se conoce compra real de habilidades; se estima utilidad potencial por composición de agentes.",
        ],
        "models": {"global": None, "rank_groups": {}, "rank_names": {}},
    }
    model_registry.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".training_", dir=model_registry.ARTIFACTS_DIR
    ) as staging:
        staging_dir = Path(staging)
        global_minimum = MIN_SAMPLES_GLOBAL if enforce_minimums else 1
        if len(dataset) >= global_minimum:
            metadata["models"]["global"] = _fit_scope(dataset, "global", None, staging_dir)
        if train_scoped_models:
            for column, scope, minimum, target in (
                ("rank_group", "rank_group", MIN_SAMPLES_RANK_GROUP, "rank_groups"),
                ("rank_name", "rank_name", MIN_SAMPLES_RANK_NAME, "rank_names"),
            ):
                for value, frame in dataset.groupby(column):
                    if len(frame) >= (minimum if enforce_minimums else 1):
                        result = _fit_scope(frame, scope, str(value), staging_dir)
                        if result:
                            metadata["models"][target][str(value)] = result
        if not list(staging_dir.glob("*.joblib")):
            raise ValueError(
                "No se pudo entrenar ningun modelo: faltan muestras, clases, "
                "partidas temporales suficientes o variacion en match_won"
            )
        model_registry.save_metadata(metadata, staging_dir)
        model_registry.publish_model_artifacts(staging_dir)
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Train conservative off-policy economy models.")
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET_PATH))
    args = parser.parse_args()
    metadata = train_models(pd.read_parquet(Path(args.dataset)))
    print(f"Training complete: {metadata['dataset_rows']} rows")


if __name__ == "__main__":
    main()
