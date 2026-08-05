from __future__ import annotations

from typing import Any

from .content_catalog import weapon_role
from .round_win_model import RoundWinLoadoutModel


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _name(player: dict) -> str:
    return str((player.get("weapon") or {}).get("displayName") or "").lower()


def build_round_win_features(base: dict, players: list[dict], context: dict) -> dict[str, Any]:
    advanced = context.get("advanced_context") or {}
    enemy = advanced.get("enemy_economy") or {}
    enemy_projection = enemy.get("enemy_projected_buy") or {}
    map_context = advanced.get("map_context") or {}
    names = [_name(player) for player in players]
    armor_levels = [
        str((player.get("armor") or {}).get("armor_level") or "").lower()
        for player in players
    ]
    utility_types = sorted({
        str(tactical)
        for player in players
        for ability in player.get("abilities") or []
        for tactical in ability.get("tactical_types") or []
        if tactical
    })
    ultimates = advanced.get("ultimates") or {}
    return {
        "team_weapon_value": _num(base.get("weapon_value")), "team_armor_value": _num(base.get("armor_value")),
        "team_utility_value": _num(base.get("utility_value")),
        "enemy_projected_weapon_value": _num(enemy_projection.get("projected_weapon_value")),
        "enemy_projected_armor_value": _num(enemy_projection.get("projected_armor_value")),
        "enemy_projected_utility_value": _num(enemy_projection.get("projected_utility_value")),
        "rifle_count": sum(weapon_role(_name(p)) == "rifle" for p in players),
        "operator_count": sum(_name(p) == "operator" for p in players),
        "smg_count": sum(weapon_role(_name(p)) == "smg" for p in players),
        "sidearm_count": sum(weapon_role(_name(p)) == "sidearm" for p in players),
        "heavy_weapon_count": sum(weapon_role(_name(p)) == "heavy" for p in players),
        "classic_count": sum(name in {"", "classic"} for name in names),
        "shorty_count": sum(name == "shorty" for name in names),
        "frenzy_count": sum(name == "frenzy" for name in names),
        "ghost_count": sum(name == "ghost" for name in names),
        "sheriff_count": sum(name == "sheriff" for name in names),
        "heavy_shield_count": sum(level == "heavy" for level in armor_levels),
        "regen_shield_count": sum(level == "regen" for level in armor_levels),
        "light_shield_count": sum(level == "light" for level in armor_levels),
        "ultimate_ready_count": sum(
            bool((ultimates.get(str(player.get("puuid"))) or {}).get("ultimate_ready"))
            for player in players
        ),
        "map": map_context.get("map_name"), "side": context.get("side"),
        "round_number": context.get("round_number"), "score_diff": context.get("score_diff"),
        "loss_streak": context.get("loss_streak"), "team_credits_total": context.get("team_estimated_credits_before_buy"),
        "team_credits_median": context.get("team_player_credits_median"),
        "enemy_credits_total": context.get("enemy_estimated_credits_before_buy"),
        "enemy_credits_median": enemy.get("enemy_median_credits"),
        "agent_roles": context.get("team_role_signature") or "unknown",
        "utility_types_available": ",".join(utility_types) or "unknown",
        "player_weapon_fit_scores": context.get("team_avg_weapon_fit_score", .5),
        "enemy_buy_class": enemy.get("enemy_buy_recommendation"),
    }


def apply_contextual_adjustments(base: dict, players: list[dict], context: dict,
                                 model: RoundWinLoadoutModel | None = None,
                                 prediction: dict[str, Any] | None = None) -> dict:
    advanced = context.get("advanced_context") or {}
    map_adjustment = site_adjustment = player_fit = enemy_adjustment = utility_adjustment = ultimate_adjustment = armor_adjustment = 0.0
    warnings: list[str] = []

    map_context = advanced.get("map_context") or {}
    profile = map_context.get("map_profile") or {}
    for player in players:
        role = weapon_role(_name(player))
        if role == "sniper":
            map_adjustment += _num(profile.get("operator_affinity")) * .12
        elif role == "rifle":
            map_adjustment += _num(profile.get("rifle_affinity")) * .10
        elif role == "shotgun":
            map_adjustment += _num(profile.get("shotgun_affinity")) * .10
    map_adjustment = max(-.04, min(.04, map_adjustment))

    utility_types = {
        tactical for player in players for ability in player.get("abilities") or []
        for tactical in ability.get("tactical_types") or []
    }
    site = advanced.get("site_tendencies") or {}
    likely_site = site.get("likely_attack_site")
    site_available_for_scoring = (
        site.get("available") and int(site.get("rounds_observed") or 0) >= 3
        and _num(site.get("confidence")) >= .5 and likely_site
    )
    if site_available_for_scoring:
        plant_success = _num((site.get("plant_success_by_site") or {}).get(likely_site))
        retake_success = _num((site.get("retake_success_by_site") or {}).get(likely_site))
        weakness = _num((site.get("defense_site_weakness") or {}).get(likely_site))
        if plant_success >= .55 and ({"postplant", "area_damage", "flank_control"} & utility_types):
            site_adjustment += .025 + min(.015, (plant_success - .55) * .05)
        if retake_success >= .45 and ({"flash", "recon", "smoke", "vision_denial"} & utility_types):
            site_adjustment += .02 + min(.015, (retake_success - .45) * .04)
        if weakness >= .55 and ({"stall", "anchor", "trap"} & utility_types):
            site_adjustment += .02
    site_adjustment = max(-.04, min(.06, site_adjustment))

    profiles = advanced.get("player_profiles") or {}
    for player in players:
        profile = profiles.get(str(player.get("puuid"))) or {}
        if not profile.get("available"):
            continue
        role = weapon_role(_name(player))
        tendency = _num(profile.get(f"{role}_tendency"))
        player_fit += (tendency - .25) * .025 * _num(profile.get("confidence"))
        if role == "sniper":
            rates = profile.get("weapon_kill_rate") or {}
            sniper_rate = max((_num(value) for key, value in rates.items() if weapon_role(key) == "sniper"), default=0)
            player_fit += (.015 if sniper_rate >= .7 else -.015) * _num(profile.get("confidence"))
    player_fit = max(-.06, min(.06, player_fit))

    enemy = advanced.get("enemy_economy") or {}
    enemy_buy = enemy.get("enemy_buy_recommendation")
    weak = sum(_num(player.get("weapon_value")) < 1600 for player in players)
    if enemy_buy == "ENEMY_FULL_BUY" and weak:
        enemy_adjustment -= .055 * weak
        warnings.append("context_enemy_full_buy_underpowered")
    if _num(enemy.get("enemy_can_operator_count")) > 0 and ({"smoke", "vision_denial", "flash", "recon"} & utility_types):
        enemy_adjustment += .025
    if enemy_buy == "ENEMY_BONUS":
        useful = sum(_num(player.get("weapon_value")) >= 1600 and _num(player.get("armor_value")) >= 400 for player in players)
        enemy_adjustment += .015 if useful >= 4 else -.04
    enemy_adjustment = max(-.16, min(.08, enemy_adjustment))

    ultimates = advanced.get("ultimates") or {}
    for player in players:
        ult = ultimates.get(str(player.get("puuid"))) or {}
        if not ult.get("ultimate_ready"):
            continue
        agent = str(ult.get("agent") or "").lower()
        if agent in {"chamber", "jett"} and _num(player.get("weapon_value")) >= 2900 and not player.get("keep_weapon"):
            ultimate_adjustment -= .055
            warnings.append(f"context_{agent}_ultimate_reduces_weapon_need")
        if _num(player.get("armor_value")) >= 400:
            ultimate_adjustment += .01
    ultimate_adjustment = max(-.08, min(.04, ultimate_adjustment))

    durability = advanced.get("armor_durability") or {}
    for player in players:
        state = durability.get(str(player.get("puuid"))) or {}
        maximum, remaining = _num(state.get("armor_max_value")), state.get("armor_value_remaining")
        if state.get("available") and maximum and remaining is not None:
            ratio = _num(remaining) / maximum
            if player.get("keep_armor") and ratio < .5:
                armor_adjustment -= .05
                warnings.append("context_damaged_armor_should_refresh")
            elif player.get("keep_armor") and ratio >= .8:
                armor_adjustment += .015
            elif not player.get("keep_armor") and ratio < .5 and _num(player.get("armor_value")) >= maximum * 10:
                armor_adjustment += .025
    armor_adjustment = max(-.08, min(.04, armor_adjustment))

    usage = advanced.get("ability_usage") or {}
    for player in players:
        state = usage.get(str(player.get("puuid"))) or {}
        used = sum(int(value or 0) for value in (state.get("used_abilities_by_slot") or {}).values())
        if state.get("available") and used == 0 and _num(player.get("ability_cost")) >= 500:
            utility_adjustment -= .025
    utility_adjustment = max(-.05, min(.04, utility_adjustment))

    if prediction is None:
        prediction = (model or RoundWinLoadoutModel()).predict_round_win(
            build_round_win_features(base, players, context)
        )
    ml_adjustment = 0.0
    if prediction.get("available") and prediction.get("round_win_probability") is not None:
        # The temporal pistol holdout is calibrated but only weakly
        # discriminative. Keep it as supporting evidence instead of allowing
        # it to decide exact pistol purchases.
        pistol = bool(context.get("is_pistol_round"))
        ml_weight = .25 if pistol else .18
        ml_cap = .035 if pistol else .10
        reference_probability = (
            _num(context.get("pistol_ml_probability_reference"))
            if pistol and context.get("pistol_ml_probability_reference") is not None
            else _num(base.get("round_win_probability"))
        )
        ml_adjustment = max(
            -ml_cap,
            min(
                ml_cap,
                (_num(prediction["round_win_probability"])
                 - reference_probability) * ml_weight,
            ),
        )
        if pistol:
            warnings.append("pistol_ml_used_as_support_only")
    adjustment = max(-.35, min(.25, map_adjustment + site_adjustment + player_fit + enemy_adjustment + utility_adjustment + ultimate_adjustment + armor_adjustment + ml_adjustment))
    raw = _num(base.get("team_plan_value")) + adjustment
    result = dict(base)
    result.update({
        "team_plan_value": round(raw, 5), "team_plan_score": round(max(0.0, min(1.0, raw)), 5),
        "score": round(max(0.0, min(1.0, raw)), 5), "rule_score": base.get("team_plan_score"),
        "ml_round_win_probability": prediction.get("round_win_probability"),
        "future_economy_score": base.get("synchronization"), "enemy_adjustment": round(enemy_adjustment, 5),
        "map_adjustment": round(map_adjustment, 5), "site_adjustment": round(site_adjustment, 5),
        "player_fit_adjustment": round(player_fit, 5),
        "utility_adjustment": round(utility_adjustment, 5), "ultimate_adjustment": round(ultimate_adjustment, 5),
        "armor_adjustment": round(armor_adjustment, 5), "ml_adjustment": round(ml_adjustment, 5),
        "risk_penalty": base.get("rule_penalty"),
        "contextual_adjustment": round(adjustment, 5), "ml_prediction": prediction,
        "warnings": list(dict.fromkeys((base.get("warnings") or []) + warnings)),
        "debug_warnings": list(dict.fromkeys((base.get("debug_warnings") or []) + warnings + prediction.get("warnings", []))),
        "confidence": round(max(.15, min(1.0, _num(base.get("data_confidence")) * .75 + (_num(prediction.get("confidence")) if prediction.get("available") else .2) * .25)), 4),
    })
    return result
