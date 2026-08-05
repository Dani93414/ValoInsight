from __future__ import annotations

from collections import Counter
from functools import lru_cache
from typing import Any

from modules.analytics.infrastructure import reference_data


CONTENT_UNAVAILABLE_REASON = "No hay datos de contenido de Valorant cargados en Mongo"
TAXONOMY_VERSION = "valorant-content-taxonomy-v2"

WEAPON_ROLE_ALLOWLIST = {
    "classic": "sidearm",
    "shorty": "sidearm",
    "frenzy": "sidearm",
    "ghost": "sidearm",
    "sheriff": "sidearm",
    "bandit": "sidearm",
    "stinger": "smg",
    "spectre": "smg",
    "bucky": "shotgun",
    "judge": "shotgun",
    "bulldog": "rifle",
    "guardian": "rifle",
    "phantom": "rifle",
    "vandal": "rifle",
    "marshal": "sniper",
    "outlaw": "sniper",
    "operator": "sniper",
    "ares": "heavy",
    "odin": "heavy",
}

ARMOR_ROLE_ALLOWLIST = {
    "light": "light",
    "light shields": "light",
    "light shield": "light",
    "escudo ligero": "light",
    "arm. ligera": "light",
    "regen shield": "regen",
    "regen": "regen",
    "escudo regen": "regen",
    "heavy shields": "heavy",
    "heavy shield": "heavy",
    "heavy": "heavy",
    "escudo pesado": "heavy",
    "arm. pesada": "heavy",
}


def _norm(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", " ")


def _compact(value: Any) -> str:
    return "".join(ch for ch in _norm(value) if ch.isalnum())


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _shop_data(item: dict[str, Any]) -> dict[str, Any]:
    shop = item.get("shopData")
    return shop if isinstance(shop, dict) else {}


def _api_category(item: dict[str, Any]) -> str:
    return str(item.get("category") or _shop_data(item).get("category") or "unknown")


def _category_text(item: dict[str, Any]) -> str:
    return str(_shop_data(item).get("categoryText") or item.get("categoryText") or "")


def _weapon_cost(item: dict[str, Any]) -> float | None:
    shop = _shop_data(item)
    return _number(shop.get("cost") if "cost" in shop else item.get("cost"))


USAGE_PROFILE_RULES: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("melee", ("melee", "knife", "cuchillo"), ()),
    ("sidearm", ("sidearm", "pistol", "pistola"), ()),
    ("rifle_default", ("rifle", "rifles", "fusil"), ()),
    ("sniper", ("sniper", "snipers", "francotirador"), ()),
    ("shotgun", ("shotgun", "escopeta"), ()),
    ("machine_gun", ("machinegun", "machine gun", "heavy weapons", "armas pesadas", "ametralladora"), ()),
    ("close_range", ("smg", "submachine", "shotgun", "escopeta"), ()),
    ("mid_range", ("rifle", "smg", "submachine"), ()),
    ("long_range", ("rifle", "sniper", "guardian", "marshal", "operator", "outlaw"), ()),
    ("operator_style", (), ("operator",)),
    ("anti_light_armor", (), ("outlaw", "marshal")),
    ("eco_punish", ("sidearm", "pistol", "sniper"), ("sheriff", "marshal", "outlaw")),
)


@lru_cache(maxsize=1)
def content_available() -> bool:
    return bool(reference_data.weapons_by_uuid() or reference_data.maps_by_uuid() or reference_data.gear_by_uuid())


def _weapon_usage_profile(item: dict[str, Any]) -> list[str]:
    category = _api_category(item)
    category_text = _category_text(item)
    name = item.get("displayName")
    haystack = " ".join([_norm(category), _norm(category_text), _norm(name)])
    compact_haystack = _compact(haystack)
    role = weapon_role(item)
    profiles: list[str] = []
    if role == "sidearm":
        profiles.append("sidearm")
    elif role == "smg":
        profiles.extend(["close_range", "mid_range"])
    elif role == "shotgun":
        profiles.extend(["shotgun", "close_range"])
    elif role == "rifle":
        profiles.extend(["rifle_default", "mid_range", "long_range"])
    elif role == "sniper":
        profiles.extend(["sniper", "long_range"])
    elif role == "heavy":
        profiles.append("machine_gun")
    for profile, category_terms, name_terms in USAGE_PROFILE_RULES:
        if profile == "rifle_default" and role != "rifle":
            continue
        if any(_compact(term) in compact_haystack for term in category_terms):
            profiles.append(profile)
            continue
        if any(_compact(term) in compact_haystack for term in name_terms):
            profiles.append(profile)
    return list(dict.fromkeys(profiles)) or ["unknown"]


def weapon_role(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("displayName") or value.get("name") or value.get("uuid")
    compact = _compact(value)
    return WEAPON_ROLE_ALLOWLIST.get(compact, "unknown")


def armor_role(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("displayName") or value.get("name") or value.get("uuid")
    normalized = _norm(value)
    compact = _compact(value)
    for name, role in ARMOR_ROLE_ALLOWLIST.items():
        if _norm(name) == normalized or _compact(name) == compact:
            return role
    return "none"


def _normalize_weapon(uuid: str, item: dict[str, Any]) -> dict[str, Any]:
    weapon_stats = item.get("weaponStats") if isinstance(item.get("weaponStats"), dict) else {}
    return {
        "uuid": uuid,
        "displayName": item.get("displayName"),
        "name": item.get("displayName"),
        "api_category": _api_category(item),
        "categoryText": _category_text(item),
        "shopData": _shop_data(item),
        "cost": _weapon_cost(item),
        "weapon_role": weapon_role(item),
        "taxonomy_version": TAXONOMY_VERSION,
        "fireRate": weapon_stats.get("fireRate"),
        "magazineSize": weapon_stats.get("magazineSize"),
        "wallPenetration": weapon_stats.get("wallPenetration"),
        "equipTimeSeconds": weapon_stats.get("equipTimeSeconds"),
        "reloadTimeSeconds": weapon_stats.get("reloadTimeSeconds"),
        "usage_profile": _weapon_usage_profile(item),
        "raw": item,
    }


@lru_cache(maxsize=1)
def load_weapon_catalog() -> dict[str, dict[str, Any]]:
    return {
        uuid: _normalize_weapon(uuid, item)
        for uuid, item in reference_data.weapons_by_uuid().items()
        if isinstance(item, dict)
    }


@lru_cache(maxsize=1)
def load_map_catalog() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for uuid, item in reference_data.maps_by_uuid().items():
        callouts = item.get("callouts") if isinstance(item.get("callouts"), list) else []
        result[uuid] = {
            "uuid": uuid,
            "displayName": item.get("displayName"),
            "mapUrl": item.get("mapUrl"),
            "xMultiplier": item.get("xMultiplier"),
            "yMultiplier": item.get("yMultiplier"),
            "xScalarToAdd": item.get("xScalarToAdd"),
            "yScalarToAdd": item.get("yScalarToAdd"),
            "callouts": callouts,
            "callout_count": len(callouts),
            "raw": item,
        }
    return result


@lru_cache(maxsize=1)
def load_gear_catalog() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for uuid, item in reference_data.gear_by_uuid().items():
        shop = _shop_data(item)
        name = item.get("displayName")
        category = str(item.get("category") or shop.get("category") or "")
        text = " ".join([_norm(name), _norm(category), _norm(shop.get("categoryText"))])
        armor_level = armor_role(name)
        if armor_level == "none" and ("regen" in text or "regener" in text):
            armor_level = "regen"
        elif armor_level == "none" and ("heavy" in text or "pesad" in text):
            armor_level = "heavy"
        elif armor_level == "none" and ("light" in text or "liger" in text):
            armor_level = "light"
        result[uuid] = {
            "uuid": uuid,
            "displayName": name,
            "api_category": category or "unknown",
            "categoryText": shop.get("categoryText"),
            "cost": _number(shop.get("cost")),
            "armor_level": armor_level,
            "taxonomy_version": TAXONOMY_VERSION,
            "raw": item,
        }
    return result


def build_weapon_usage_taxonomy() -> dict[str, list[dict[str, Any]]]:
    taxonomy: dict[str, list[dict[str, Any]]] = {}
    for weapon in load_weapon_catalog().values():
        for profile in weapon["usage_profile"]:
            taxonomy.setdefault(profile, []).append({
                "uuid": weapon["uuid"],
                "name": weapon["displayName"],
                "api_category": weapon["api_category"],
                "cost": weapon["cost"],
            })
    return taxonomy


@lru_cache(maxsize=1)
def _weapon_lookup_indexes() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_lower: dict[str, dict[str, Any]] = {}
    by_compact: dict[str, dict[str, Any]] = {}
    for uuid, weapon in load_weapon_catalog().items():
        aliases = [
            uuid, weapon.get("displayName"), weapon.get("name"), weapon.get("uuid"),
            (weapon.get("raw") or {}).get("assetPath"),
        ]
        for alias in aliases:
            if alias:
                by_lower.setdefault(str(alias).strip().lower(), weapon)
                by_compact.setdefault(_compact(alias), weapon)
    return by_lower, by_compact


def find_weapon(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        for key in ("uuid", "id", "assetPath", "displayName", "name"):
            found = find_weapon(value.get(key)) if value.get(key) else None
            if found:
                return found
        return None
    text = str(value or "").strip()
    if not text:
        return None
    catalog = load_weapon_catalog()
    if text in catalog:
        return catalog[text]
    by_lower, by_compact = _weapon_lookup_indexes()
    return by_lower.get(text.lower()) or by_compact.get(_compact(text))


@lru_cache(maxsize=1)
def _gear_lookup_indexes() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_lower: dict[str, dict[str, Any]] = {}
    by_compact: dict[str, dict[str, Any]] = {}
    for uuid, gear in load_gear_catalog().items():
        aliases = [
            uuid, gear.get("displayName"), gear.get("uuid"),
            (gear.get("raw") or {}).get("assetPath"),
        ]
        for alias in aliases:
            if alias:
                by_lower.setdefault(str(alias).strip().lower(), gear)
                by_compact.setdefault(_compact(alias), gear)
    return by_lower, by_compact


def find_gear(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        for key in ("uuid", "id", "assetPath", "displayName", "name"):
            found = find_gear(value.get(key)) if value.get(key) else None
            if found:
                return found
        return None
    text = str(value or "").strip()
    if not text:
        return None
    catalog = load_gear_catalog()
    if text in catalog:
        return catalog[text]
    by_lower, by_compact = _gear_lookup_indexes()
    return by_lower.get(text.lower()) or by_compact.get(_compact(text))


def weapon_has_profile(value: Any, profile: str) -> bool:
    weapon = find_weapon(value)
    return bool(weapon and profile in weapon.get("usage_profile", []))


def weapon_catalog_role(value: Any) -> str:
    weapon = find_weapon(value)
    return str((weapon or {}).get("weapon_role") or weapon_role(value))


def gear_armor_level(value: Any) -> str:
    gear = find_gear(value)
    return str((gear or {}).get("armor_level") or armor_role(value) or "none")


def build_content_report() -> dict[str, Any]:
    weapons = list(load_weapon_catalog().values())
    gear = list(load_gear_catalog().values())
    maps = list(load_map_catalog().values())
    if not weapons and not gear and not maps:
        return {"available": False, "reason": CONTENT_UNAVAILABLE_REASON}

    category_counts = Counter(str(weapon.get("api_category") or "unknown") for weapon in weapons)
    profile_counts = Counter(
        profile
        for weapon in weapons
        for profile in (weapon.get("usage_profile") or ["unknown"])
    )
    return {
        "available": True,
        "weapons_found": len(weapons),
        "gear_found": len(gear),
        "maps_found": len(maps),
        "weapon_categories": dict(sorted(category_counts.items())),
        "usage_profiles": dict(sorted(profile_counts.items())),
        "taxonomy_version": TAXONOMY_VERSION,
        "weapons": [
            {
                "uuid": weapon["uuid"],
                "name": weapon.get("displayName"),
                "api_category": weapon.get("api_category"),
                "categoryText": weapon.get("categoryText"),
                "usage_profile": weapon.get("usage_profile"),
                "cost": weapon.get("cost"),
            }
            for weapon in weapons
        ],
        "gear": [
            {
                "uuid": item["uuid"],
                "name": item.get("displayName"),
                "api_category": item.get("api_category"),
                "armor_level": item.get("armor_level"),
                "cost": item.get("cost"),
            }
            for item in gear
        ],
        "maps": [
            {
                "uuid": item["uuid"],
                "name": item.get("displayName"),
                "callout_count": item.get("callout_count"),
            }
            for item in maps
        ],
    }


def clear_catalog_cache() -> None:
    content_available.cache_clear()
    load_weapon_catalog.cache_clear()
    load_map_catalog.cache_clear()
    load_gear_catalog.cache_clear()
    _weapon_lookup_indexes.cache_clear()
    _gear_lookup_indexes.cache_clear()
