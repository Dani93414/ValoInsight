from __future__ import annotations

from typing import Any

from .display_normalizer import (
    compact_purchase_for_api,
    normalize_purchase_for_display,
    normalize_warning_list,
)


PLAN_LABELS = {
    "PISTOL_UTILITY": "pistola con utilidad",
    "PISTOL_SIDEARM": "pistola mejorada",
    "PISTOL_ARMOR": "pistola con escudo",
    "PISTOL_DEFAULT": "pistola estándar",
    "POST_PISTOL_CONVERSION": "conversión tras pistola",
    "ANTI_ECO": "antieco",
    "ECO": "ahorro",
    "HALF_BUY": "compra parcial",
    "FORCE_BUY": "compra forzada",
    "FULL_BUY": "compra completa",
    "BONUS_UPGRADE": "mejora de la ronda de bonificación",
    "BONUS_KEEP_INVENTORY": "ronda de bonificación conservando equipamiento",
    "UNDERINVESTED_BUY": "compra insuficiente",
    "BROKEN_BUY": "compra descoordinada",
    "LAST_HALF_ROUND_BUY": "compra de última ronda de mitad",
    "ELIMINATION_BUY": "compra para evitar eliminación",
    "CLOSING_BUY": "compra para cerrar la partida",
    "OVERTIME_BUY": "compra de prórroga",
}


class RecommendationExplainer:
    def explain(self, *, round_number: int, team_id: str, side: str, score_before: Any,
                observed: dict[str, dict], inferred: dict[str, list[dict]], plan: dict,
                player_meta: dict[str, dict] | None = None,
                context: dict[str, Any] | None = None) -> dict:
        meta = player_meta or {}
        players = []
        public_inferred: dict[str, list[dict]] = {}
        for puuid, hypotheses in inferred.items():
            public_inferred[puuid] = []
            for hypothesis in hypotheses:
                payload = dict(hypothesis)
                raw = list(dict.fromkeys(payload.get("warnings") or []))
                payload["debug_warnings"] = raw
                payload["warnings"] = normalize_warning_list(raw)
                public_inferred[puuid].append(payload)
        for purchase in plan.get("players") or []:
            purchase = compact_purchase_for_api(purchase)
            puuid = purchase["puuid"]
            hypotheses = public_inferred.get(puuid) or []
            best = hypotheses[0] if hypotheses else {"weapon_source": "unknown", "confidence": .2, "reasons": ["no_inference"]}
            obs = observed.get(puuid) or {}
            raw_warnings = list(dict.fromkeys(
                (purchase.get("warnings") or []) + (best.get("debug_warnings") or best.get("warnings") or []) +
                (obs.get("debug_warnings") or [])
            ))
            purchase["display"] = normalize_purchase_for_display(
                purchase, is_pistol_round=bool((context or {}).get("is_pistol_round")),
            )
            players.append({
                "puuid": puuid, "player_name": meta.get(puuid, {}).get("player_name"),
                "agent": meta.get(puuid, {}).get("agent"), "role": meta.get(puuid, {}).get("role"),
                "credits_before_buy": meta.get(puuid, {}).get("credits_before_buy"),
                "observed_weapon": obs.get("weapon"), "observed_armor": obs.get("armor"),
                "observed_weapon_display": obs.get("weapon_display"),
                "observed_armor_display": obs.get("armor_display"),
                "inferred_real_purchase": best, "recommended_purchase": purchase,
                "reason": self._reason(purchase, plan),
                "context_reasons": self._context_reasons(purchase, plan, context or {}),
                "warnings": normalize_warning_list(raw_warnings),
                "debug_warnings": raw_warnings,
                "confidence": best.get("confidence"),
            })
        inference_confidence = min([p["confidence"] for p in players] or [.2])
        projection = plan.get("economy_projection") or {}
        data_confidence = float(projection.get("data_confidence") or .5)
        contextual_confidence = float(projection.get("confidence") if projection.get("confidence") is not None else data_confidence)
        ml_prediction = projection.get("ml_prediction") or {}
        ml_confidence = float(ml_prediction.get("confidence") or .2)
        advanced = (context or {}).get("advanced_context") or {}
        important = [advanced.get(key) or {} for key in ("map_context", "enemy_economy", "site_tendencies")]
        unavailable = sum(not item.get("available") for item in important)
        availability_factor = max(.78, 1.0 - unavailable * .07)
        ml_factor = 1.0 if ml_prediction.get("available") else .90
        combined = (inference_confidence * .45 + data_confidence * .25 +
                    contextual_confidence * .20 + ml_confidence * .10)
        confidence = round(max(.1, min(1.0, combined * ml_factor * availability_factor)), 4)
        alternatives = plan.get("alternatives") or []
        for alternative in alternatives:
            alternative["players"] = [
                compact_purchase_for_api(purchase)
                for purchase in alternative.get("players") or []
            ]
            for purchase in alternative.get("players") or []:
                purchase["display"] = normalize_purchase_for_display(
                    purchase, is_pistol_round=bool((context or {}).get("is_pistol_round")),
                )
        placeholder_normalized = any(
            warning.startswith("invalid_placeholder_value:")
            for item in observed.values() for warning in item.get("debug_warnings") or []
        )
        round_warnings = normalize_warning_list(plan.get("warnings") or [])
        if placeholder_normalized:
            round_warnings.append("Algunos datos observados estaban incompletos y fueron normalizados.")
        advanced_context = dict((context or {}).get("advanced_context") or {})
        if projection.get("ml_prediction"):
            advanced_context["ml_prediction"] = projection["ml_prediction"]
        return {
            "round_number": round_number, "team_id": team_id, "side": side, "score_before": score_before,
            "real_team_buy_observed": observed, "inferred_team_buy": public_inferred,
            "recommended_team_buy": plan.get("plan_kind"), "team_plan_score": plan.get("team_plan_score"),
            "team_plan_value": plan.get("team_plan_value"),
            "confidence": confidence, "players": players, "alternatives": alternatives,
            "economy_projection": projection,
            "advanced_context": advanced_context,
            "warnings": list(dict.fromkeys(round_warnings)),
            "debug_warnings": list(dict.fromkeys((plan.get("warnings") or []) +
                [warning for item in observed.values() for warning in item.get("debug_warnings") or []])),
        }

    @staticmethod
    def _reason(purchase: dict, plan: dict) -> str:
        kind = str(plan.get("plan_kind") or "")
        if purchase.get("bought_by"):
            return "Recibe un arma de un compañero; conserva sus créditos para escudo, utilidad y economía futura."
        if purchase.get("buys_for"):
            return "Compra un arma para un compañero manteniendo recursos suficientes."
        if purchase.get("keep_weapon"):
            weapon = str((purchase.get("weapon") or {}).get("displayName") or "el arma")
            if kind.startswith("BONUS"):
                return f"Conserva {weapon} para jugar la ronda de bonificación y ahorrar para la siguiente compra completa."
            return f"Conserva {weapon} y compra solo la protección o utilidad necesaria."
        if kind in {"POST_PISTOL_CONVERSION", "ANTI_ECO"}:
            return "Convierte la ventaja tras la ronda de pistolas con arma, escudo y utilidad controlada, sin sobreinvertir."
        if kind in {"ECO", "HALF_BUY"}:
            return "Limita el gasto para sincronizar una compra completa en la siguiente ronda."
        if kind in {"UNDERINVESTED_BUY", "BROKEN_BUY"}:
            return "La compra queda por debajo de la potencia disponible y debe revisarse."
        if kind == "FULL_BUY":
            return "Completa una compra coordinada con arma, protección y utilidad clave."
        if kind in {"LAST_HALF_ROUND_BUY", "ELIMINATION_BUY", "OVERTIME_BUY"}:
            return "Prioriza potencia inmediata porque no aporta valor reservar creditos."
        if kind == "CLOSING_BUY":
            return "Prioriza cerrar la partida sin ignorar por completo una ronda posterior."
        return f"Compra coherente con el plan {PLAN_LABELS.get(kind, 'de equipo')}."

    @staticmethod
    def _context_reasons(purchase: dict, plan: dict, context: dict) -> list[str]:
        projection = plan.get("economy_projection") or {}
        advanced = context.get("advanced_context") or {}
        reasons: list[str] = []
        enemy = (advanced.get("enemy_economy") or {}).get("enemy_buy_recommendation")
        if enemy == "ENEMY_PISTOL":
            reasons.append("Ronda de pistolas: se prioriza una compra inicial eficiente.")
        elif enemy == "ENEMY_ECO":
            reasons.append("La economía enemiga probable es de ahorro; se evita sobreinvertir.")
        elif enemy == "ENEMY_FULL_BUY":
            reasons.append("La compra enemiga probable es completa; se prioriza potencia coordinada.")
        if purchase.get("keep_weapon") and str(plan.get("plan_kind") or "").startswith("BONUS"):
            reasons.append("Se conserva el arma para mantener el valor de la ronda de bonificación.")
        puuid = str(purchase.get("puuid") or "")
        ultimate = ((advanced.get("ultimates") or {}).get(puuid) or {})
        if ultimate.get("ultimate_ready") and str(ultimate.get("agent") or "").lower() in {"jett", "chamber"}:
            reasons.append("La habilidad definitiva lista reduce la necesidad de comprar un arma cara.")
        durability = ((advanced.get("armor_durability") or {}).get(puuid) or {})
        maximum = float(durability.get("armor_max_value") or 0)
        remaining = durability.get("armor_value_remaining")
        if maximum and remaining is not None and float(remaining) / maximum < .5:
            reasons.append("La armadura conservada está dañada y conviene renovarla si el presupuesto lo permite.")
        site_context = advanced.get("site_tendencies") or {}
        if (site_context.get("available") and int(site_context.get("rounds_observed") or 0) >= 3
                and float(site_context.get("confidence") or 0) >= .5
                and float(projection.get("site_adjustment") or 0) > .01):
            site = site_context.get("likely_attack_site")
            reasons.append(f"La utilidad encaja con la tendencia observada de la zona {site or 'probable'}.")
        if projection.get("player_fit_adjustment", 0) > 0:
            reasons.append("El arma tiene buen ajuste con el historial previo del jugador.")
        return reasons
