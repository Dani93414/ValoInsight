from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for path in (PROJECT_ROOT, BACKEND_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from modules.economy_ml import model_registry  # noqa: E402


def validate_candidate(*, require_policy: bool = True) -> dict:
    candidate_dir = model_registry.ARTIFACTS_DIR / "v12_candidate"
    metadata_path = candidate_dir / "metadata.json"
    if not metadata_path.exists():
        return {"valid": False, "reasons": ["Falta metadata.json del candidato v12."]}
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    global_model = ((metadata.get("models") or {}).get("global") or {})
    metrics = global_model.get("metrics") or {}
    match_metrics = ((metrics.get("models") or {}).get("match_win_model") or {})
    baseline = match_metrics.get("baseline_global") or {}
    policy = metrics.get("policy_evaluation") or {}
    reasons = []
    if metadata.get("schema_version") != 12:
        reasons.append("El candidato no usa schema_version 12.")
    if float(match_metrics.get("expected_calibration_error") or 1) > 0.03:
        reasons.append("ECE superior a 0,03.")
    if float(match_metrics.get("log_loss") or 1) >= float(baseline.get("log_loss") or 0):
        reasons.append("Log-loss no mejora el baseline del mismo holdout.")
    if float(match_metrics.get("brier_score") or 1) >= float(baseline.get("brier_score") or 0):
        reasons.append("Brier no mejora el baseline del mismo holdout.")
    improvement_interval = policy.get("improvement_confidence_interval_95") or []
    if require_policy and (len(improvement_interval) != 2 or float(improvement_interval[0]) <= 0):
        reasons.append("La mejora doubly robust no tiene un intervalo completamente positivo.")
    if not list(candidate_dir.glob("*.joblib")):
        reasons.append("No hay artefactos joblib candidatos.")
    return {
        "valid": not reasons,
        "reasons": reasons,
        "metrics": {
            "match_win": match_metrics,
            "policy_evaluation": policy,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Valida y activa el candidato económico v12 con snapshot recuperable."
    )
    parser.add_argument(
        "--activate",
        action="store_true",
        help="Activa el candidato solo si supera todos los controles automáticos.",
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--prediction-only",
        action="store_true",
        help="Activa las predicciones supervisadas, manteniendo bloqueada la influencia ML en el solver.",
    )
    mode_group.add_argument(
        "--experimental-policy",
        action="store_true",
        help=(
            "Activa la politica como experimento aunque no supere OPE; conserva una advertencia "
            "explicita y no declara el modelo validado."
        ),
    )
    args = parser.parse_args()
    validation = validate_candidate(
        require_policy=not (args.prediction_only or args.experimental_policy)
    )
    print(json.dumps(validation, ensure_ascii=False, indent=2))
    if not validation["valid"]:
        return 1
    if not args.activate:
        print("Candidato válido. Vuelve a ejecutar con --activate para activarlo.")
        return 0
    mode = (
        "prediction_only" if args.prediction_only
        else "experimental_full" if args.experimental_policy
        else "full"
    )
    print(json.dumps(
        model_registry.activate_v12_candidate(deployment_mode=mode),
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
