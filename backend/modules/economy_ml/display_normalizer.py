from __future__ import annotations

from typing import Any

from .content_catalog import armor_role, find_gear, find_weapon


PLACEHOLDERS = {"", "string", "none", "null", "unknown", "undefined", "n/a"}
PUBLIC_ITEM_FIELDS = {
    "uuid", "id", "displayName", "name", "cost", "purchase_cost",
    "weapon_value", "armor_value", "armor_level", "source",
    "category", "shopCategory", "api_category", "usage_profile", "warnings",
}


def _raw(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("uuid") or value.get("displayName") or value.get("name")
    return value


def _invalid(value: Any) -> bool:
    return str(_raw(value) or "").strip().lower() in PLACEHOLDERS


def normalize_weapon_display(value: Any) -> dict[str, Any]:
    raw = _raw(value)
    item = find_weapon(value)
    if item:
        name = str(item.get("displayName") or item.get("name") or "Arma desconocida")
        return {"id": item.get("uuid"), "displayName": name, "shortName": name,
                "kind": "weapon", "source_value": raw, "known": True,
                "cost": item.get("cost"), "warnings": []}
    if _invalid(value):
        return {"id": None, "displayName": "Arma no observada", "shortName": "Arma no observada",
                "kind": "weapon", "source_value": raw, "known": False, "cost": None,
                "warnings": [f"invalid_placeholder_value:{raw}"] if raw else []}
    text = str(raw).strip()
    return {"id": None, "displayName": text, "shortName": text, "kind": "weapon",
            "source_value": raw, "known": False, "cost": None,
            "warnings": ["unknown_weapon_catalog_value"]}


def normalize_armor_display(value: Any) -> dict[str, Any]:
    raw = _raw(value)
    item = find_gear(value)
    if item:
        name = str(item.get("displayName") or "Escudo desconocido")
        return {"id": item.get("uuid"), "displayName": name, "shortName": name,
                "kind": "armor", "source_value": raw, "known": True,
                "cost": item.get("cost"), "armor_level": item.get("armor_level"), "warnings": []}
    role = armor_role(raw)
    if role in {"light", "regen", "heavy"}:
        names = {"light": "Light Shield", "regen": "Regen Shield", "heavy": "Heavy Shield"}
        costs = {"light": 400, "regen": 650, "heavy": 1000}
        return {"id": None, "displayName": names[role], "shortName": names[role],
                "kind": "armor", "source_value": raw, "known": True,
                "cost": costs[role], "armor_level": role, "warnings": []}
    if _invalid(value):
        warnings = [f"invalid_placeholder_value:{raw}"] if raw else []
        return {"id": None, "displayName": "Sin escudo", "shortName": "Sin escudo",
                "kind": "armor", "source_value": raw, "known": False, "cost": 0,
                "armor_level": "none", "warnings": warnings}
    text = str(raw).strip()
    return {"id": None, "displayName": text, "shortName": text, "kind": "armor",
            "source_value": raw, "known": False, "cost": None, "armor_level": "unknown",
            "warnings": ["unknown_armor_catalog_value"]}


def normalize_observed_economy(economy: dict[str, Any] | None) -> dict[str, Any]:
    source = economy or {}
    weapon = normalize_weapon_display(source.get("weapon"))
    armor = normalize_armor_display(source.get("armor"))
    debug = list(dict.fromkeys((weapon.get("warnings") or []) + (armor.get("warnings") or [])))
    return {"weapon_raw": source.get("weapon"), "armor_raw": source.get("armor"),
            "weapon": weapon["displayName"], "armor": armor["displayName"],
            "weapon_display": weapon, "armor_display": armor,
            "loadoutValue": source.get("loadoutValue"), "spent": source.get("spent"),
            "remaining": source.get("remaining"), "warnings": normalize_warning_list(debug),
            "debug_warnings": debug}


def compact_catalog_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    return {
        key: value
        for key, value in item.items()
        if key in PUBLIC_ITEM_FIELDS
    }


def compact_purchase_for_api(purchase: dict[str, Any]) -> dict[str, Any]:
    result = dict(purchase)
    result["weapon"] = compact_catalog_item(purchase.get("weapon"))
    result["armor"] = compact_catalog_item(purchase.get("armor"))
    return result


def normalize_purchase_for_display(purchase: dict[str, Any], *, is_pistol_round: bool = False) -> dict[str, str]:
    weapon = purchase.get("weapon") or {}
    armor = purchase.get("armor") or {}
    weapon_name = str(weapon.get("displayName") or ("Classic" if is_pistol_round else "No comprar arma"))
    armor_name = str(armor.get("displayName") or "Sin escudo")
    if purchase.get("keep_armor") and armor:
        armor_name = f"{armor_name} conservada"
    source = purchase.get("weapon_source") or weapon.get("source") or "none"
    is_free_classic = weapon_name.strip().lower() == "classic" and float(
        purchase.get("weapon_purchase_cost") if purchase.get("weapon_purchase_cost") is not None
        else weapon.get("purchase_cost") or weapon.get("cost") or 0
    ) == 0
    if (is_pistol_round and not purchase.get("weapon")) or is_free_classic:
        weapon_label, source_label = "Classic gratis", "Arma inicial gratis"
    elif source == "carried":
        weapon_label, source_label = weapon_name, "Arma conservada"
    elif source == "dropped":
        weapon_label, source_label = weapon_name, "Arma recibida de un compañero"
    elif source == "bought_self":
        weapon_label, source_label = weapon_name, "Compra propia"
    else:
        weapon_label, source_label = weapon_name, "Sin compra de arma"
    abilities = purchase.get("abilities") or []
    included_sources = {"free_round_start", "carried", "carried_and_free"}
    purchased_abilities = [
        item for item in abilities
        if str(item.get("source") or "") not in included_sources
        and float(item.get("cost") or 0) > 0
    ]
    included_abilities = [
        item for item in abilities
        if str(item.get("source") or "") in included_sources
        or float(item.get("cost") or 0) <= 0
    ]
    ability_label = ", ".join(
        f"{item.get('name')} x{item.get('charges')}" for item in purchased_abilities
    ) or "Sin compra de habilidades"
    included_ability_label = ", ".join(
        f"{item.get('name')} x{item.get('charges')}" for item in included_abilities
    ) or "Ninguna"
    return {"weapon_label": weapon_label, "armor_label": armor_name,
            "loadout_label": f"{weapon_label} + {armor_name}", "ability_label": ability_label,
            "included_ability_label": included_ability_label,
            "spend_label": f"Gasto propio {float(purchase.get('self_cost') or 0):.0f}",
            "source_label": source_label}


def normalize_warning_list(warnings: list[str] | None) -> list[str]:
    raw = list(dict.fromkeys(str(item) for item in (warnings or []) if item))
    human: list[str] = []
    if any(item.startswith("missing_cost:") for item in raw):
        human.append("Algunos costes de habilidad requieren revision de catalogo.")
    if "ability_purchase_not_observable" in raw:
        human.append("Compra de habilidades estimada; Riot no expone la compra exacta de utilidad.")
    translations = {
        "low_confidence": "Inferencia con confianza baja.",
        "team_drop_inferred_not_observed": "El arma recibida de un compañero es una inferencia, no una observación directa.",
        "carried_weapon_missing_catalog": "El arma conservada no figura en el catalogo cargado.",
    }
    for item in raw:
        translated = translations.get(item)
        if translated:
            human.append(translated)
    return list(dict.fromkeys(human))
