import { normalizeLabel } from "../../utils/formatters";
import type { RegionWeaponStats } from "../../types/globalStats";
import type { Arma, DamageRange } from "../../types/weapons";
import type { EnrichedWeapon, WeaponSortKey, WeaponStatsFilter } from "./types";

export const STAT_LABELS: Record<string, string> = {
  fireRate: "Cadencia de disparo",
  magazineSize: "Capacidad del cargador",
  runSpeedMultiplier: "Velocidad de movimiento",
  equipTimeSeconds: "Tiempo de equipamiento",
  reloadTimeSeconds: "Tiempo de recarga",
  firstBulletAccuracy: "Precisión del primer disparo",
  shotgunPelletCount: "Perdigones por disparo",
  wallPenetration: "Penetración de pared",
  feature: "Característica especial",
  fireMode: "Modo de disparo",
  altFireType: "Modo alternativo",
  zoomMultiplier: "Multiplicador de zoom",
  burstCount: "Disparos por ráfaga",
  adsStats: "Estadísticas al apuntar con mira",
  altShotgunStats: "Estadísticas del disparo alternativo",
  airBurstStats: "Estadísticas de explosión aérea",
};

const VALUE_TRANSLATIONS: Record<string, string> = {
  High: "Alta",
  Medium: "Media",
  Low: "Baja",
  Automatic: "Automático",
  SemiAutomatic: "Semiautomático",
  Burst: "Ráfaga",
  Shotgun: "Escopeta",
  Sniper: "Francotirador",
  Rifle: "Rifle",
  SMG: "Subfusil",
  Heavy: "Ametralladora",
  Sidearm: "Pistola",
  Melee: "Cuerpo a cuerpo",
};

const FEATURE_TRANSLATIONS: Array<{ includes: string; label: string }> = [
  { includes: "rofincrease", label: "Cadencia progresiva: aumenta al mantener el disparo." },
  { includes: "rof increase", label: "Cadencia progresiva: aumenta al mantener el disparo." },
  { includes: "rate of fire increase", label: "Cadencia progresiva: aumenta al mantener el disparo." },
  { includes: "ads", label: "Mira: permite apuntar para mejorar el control y la precisión." },
  { includes: "dualzoom", label: "Zoom doble: permite alternar entre dos aumentos de mira." },
  { includes: "dual zoom", label: "Zoom doble: permite alternar entre dos aumentos de mira." },
  { includes: "airburst", label: "Explosión aérea: detona en el aire o por tiempo." },
  { includes: "shotgun", label: "Disparo de escopeta: lanza varios perdigones." },
  { includes: "speed decrease", label: "Ralentización: reduce la velocidad del objetivo impactado." },
  { includes: "silencer", label: "Silenciador: reduce traza sonora y visual de disparo." },
  { includes: "silenced", label: "Silenciador: reduce traza sonora y visual de disparo." },
  { includes: "suppressor", label: "Silenciador: reduce traza sonora y visual de disparo." },
  { includes: "zoom", label: "Zoom: mejora precisión al apuntar con mira." },
  { includes: "burst", label: "Ráfaga: dispara varias balas por activación." },
  { includes: "alt fire", label: "Disparo alternativo: añade un modo secundario de uso." },
  { includes: "alternate fire", label: "Disparo alternativo: añade un modo secundario de uso." },
  { includes: "wall", label: "Penetración: puede impactar a través de superficies." },
  { includes: "air burst", label: "Explosión aérea: detona en el aire o por tiempo." },
];

export function normalizeWeaponCategory(category?: string | null) {
  const clean = category?.trim() ?? "";
  if (!clean || /^[-\u2013\u2014]+$/u.test(clean)) return "CUERPO A CUERPO";

  const lower = clean.toLowerCase();
  if (lower.includes("shield") || lower.includes("escudo")) return "Escudos";
  if (lower.includes("melee") || lower.includes("cuchillo")) {
    return "CUERPO A CUERPO";
  }
  if (lower.includes("sidearm")) return "Pistolas";
  if (lower.includes("smg")) return "Subfusiles";
  if (lower.includes("shotgun")) return "Escopetas";
  if (lower.includes("rifle")) return "Rifles";
  if (lower.includes("sniper")) return "Francotiradores";
  if (lower.includes("heavy")) return "Ametralladoras";

  if (clean.includes("::")) {
    const value = clean.split("::").pop()?.trim() ?? "";
    if (!value || /^[-\u2013\u2014]+$/u.test(value)) return "CUERPO A CUERPO";
    return value.toLowerCase().includes("melee") ? "CUERPO A CUERPO" : value;
  }

  return clean;
}

export function formatWeaponCost(value: unknown) {
  if (value === undefined || value === null || value === "" || value === "-") {
    return "Gratis";
  }
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric)) return "Gratis";
  return `${numeric} créditos`;
}

export function getNumericCost(weapon: Arma) {
  const numeric = Number(weapon.cost);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function isMeleeWeapon(weapon: Arma) {
  return normalizeWeaponCategory(weapon.category) === "CUERPO A CUERPO";
}

export function formatWeaponValue(value: unknown): string | number {
  if (typeof value === "string") {
    const cleanValue = value.includes("::")
      ? (value.split("::").pop() ?? value)
      : value;
    const normalizedValue = cleanValue.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const featureMatch = FEATURE_TRANSLATIONS.find((item) => normalizedValue.includes(item.includes));
    if (featureMatch) return featureMatch.label;
    return VALUE_TRANSLATIONS[cleanValue] ?? cleanValue.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  if (typeof value === "number") return value;
  return "-";
}

export function getWeaponSampleReliability(stats?: RegionWeaponStats) {
  const sample = stats?.rounds_equipped ?? stats?.kills ?? 0;
  if (sample <= 0) return "Sin muestra";
  if (sample <= 10) return "Baja muestra";
  return "Muestra estable";
}

export function getWeaponProfileTags(weapon: Arma) {
  const tags = new Set<string>();
  const cost = getNumericCost(weapon);
  const category = normalizeWeaponCategory(weapon.category);
  const stats = weapon.stats;

  if (weapon.isShield || category === "Escudos") tags.add("escudo");
  if (category === "CUERPO A CUERPO") tags.add("cuerpo a cuerpo");
  if (cost > 0 && cost <= 1600) tags.add("económica");
  if (cost > 1600) tags.add("premium");
  if ((stats?.fireRate ?? 0) >= 10) tags.add("alta cadencia");
  if ((stats?.reloadTimeSeconds ?? 99) > 0 && (stats?.reloadTimeSeconds ?? 99) <= 2.3) {
    tags.add("recarga rápida");
  }
  if ((stats?.magazineSize ?? 0) >= 50) tags.add("cargador grande");
  if ((stats?.firstBulletAccuracy ?? 99) > 0 && (stats?.firstBulletAccuracy ?? 99) <= 0.3) {
    tags.add("precisa");
  }
  if (weapon.adsStats && Object.keys(weapon.adsStats).length > 0) {
    tags.add("tiene mira");
  }
  if (String(stats?.wallPenetration ?? "").toLowerCase().includes("high")) {
    tags.add("buena penetración");
  }

  return Array.from(tags);
}

export function hasSufficientWeaponSample(stats?: RegionWeaponStats) {
  return (stats?.rounds_equipped ?? 0) >= 10 || (stats?.kills ?? 0) >= 10;
}

export function calculateGlobalWeaponHeadshotPct(
  stats?: Pick<RegionWeaponStats, "headshots" | "bodyshots" | "legshots" | "headshot_pct">,
) {
  const sample = getWeaponHeadshotSample(stats);
  return sample && sample.impacts > 0
    ? (sample.headshots * 100) / sample.impacts
    : undefined;
}

export function getWeaponHeadshotSample(
  stats?: Pick<RegionWeaponStats, "headshots" | "bodyshots" | "legshots" | "headshot_pct">,
) {
  const headshots = Number(stats?.headshots ?? 0);
  const bodyshots = Number(stats?.bodyshots ?? 0);
  const legshots = Number(stats?.legshots ?? 0);
  const impacts = headshots + bodyshots + legshots;
  const hasStoredDistribution = stats?.bodyshots != null || stats?.legshots != null;
  if (hasStoredDistribution && impacts > 0) {
    return { headshots, impacts };
  }

  // Los agregados regionales históricos guardan headshots y el porcentaje,
  // pero no bodyshots/legshots. Recuperamos el denominador original para
  // poder combinar regiones con ponderación real por impactos.
  const storedPct = Number(stats?.headshot_pct ?? 0);
  if (headshots > 0 && storedPct > 0 && storedPct <= 100) {
    return { headshots, impacts: (headshots * 100) / storedPct };
  }
  return undefined;
}

export function buildWeaponProfileSummary(weapon: EnrichedWeapon) {
  const tags = new Set(weapon.profileTags);
  if (tags.has("escudo")) {
    return "Escudo defensivo orientado a supervivencia y mitigación de daño.";
  }
  if (tags.has("cuerpo a cuerpo")) {
    return "Arma cuerpo a cuerpo sin estadísticas balísticas; útil como recurso básico de movilidad y remate.";
  }

  const fragments: string[] = [];
  if (tags.has("premium")) fragments.push("arma de inversión alta");
  if (tags.has("económica")) fragments.push("opción adecuada para rondas económicas");
  if (tags.has("alta cadencia")) fragments.push("buen rendimiento en duelos sostenidos");
  if (tags.has("precisa")) fragments.push("premia disparos controlados");
  if (tags.has("buena penetración")) fragments.push("puede castigar a través de superficies");
  if (tags.has("tiene mira")) fragments.push("ofrece utilidad a media y larga distancia al apuntar con mira");

  if (fragments.length === 0) {
    return "Arma versátil del arsenal; revisa sus estadísticas base y daño por distancia para contextualizar su uso.";
  }

  return `${fragments[0][0].toUpperCase()}${fragments[0].slice(1)}${fragments.length > 1 ? `, con ${fragments.slice(1).join(", ")}.` : "."}`;
}

export function buildWeaponStatsResolver(
  weaponStatsById: Record<string, RegionWeaponStats>,
) {
  const byName = new Map<string, RegionWeaponStats>();
  Object.values(weaponStatsById).forEach((stats) => {
    if (stats.weapon_name) byName.set(normalizeLabel(stats.weapon_name), stats);
  });

  return (weapon: Arma) => {
    const byUuid = weaponStatsById[weapon.uuid ?? ""];
    if (byUuid) return byUuid;
    const byDisplayName = byName.get(normalizeLabel(weapon.displayName));
    if (byDisplayName) return byDisplayName;
    if (weapon.isShield) {
      const shieldAliases =
        normalizeLabel(weapon.displayName).includes("heavy")
          ? ["heavy shields", "heavy shield", "escudos pesados", "escudo pesado"]
          : normalizeLabel(weapon.displayName).includes("light")
            ? ["light shields", "light shield", "escudos ligeros", "escudo ligero"]
            : [];
      for (const alias of shieldAliases) {
        const match = byName.get(normalizeLabel(alias));
        if (match) return match;
      }
    }
    return undefined;
  };
}

export function matchesWeaponStatsFilter(
  weapon: EnrichedWeapon,
  filter: WeaponStatsFilter,
) {
  const hasStats =
    (weapon.globalStats?.kills ?? 0) > 0 ||
    (weapon.globalStats?.rounds_equipped ?? 0) > 0;
  if (filter === "withStats") return hasStats;
  if (filter === "withoutStats") return !hasStats;
  if (filter === "weapons") return !weapon.isShield;
  if (filter === "shields") return Boolean(weapon.isShield);
  return true;
}

export function sortWeapons(weapons: EnrichedWeapon[], sortKey: WeaponSortKey) {
  return [...weapons].sort((a, b) => {
    if (sortKey === "cost") {
      return getNumericCost(a) - getNumericCost(b) || a.displayName.localeCompare(b.displayName);
    }
    if (sortKey === "category") {
      return (
        a.normalizedCategory.localeCompare(b.normalizedCategory) ||
        a.displayName.localeCompare(b.displayName)
      );
    }
    if (sortKey === "kills") {
      return (b.globalStats?.kills ?? 0) - (a.globalStats?.kills ?? 0);
    }
    if (sortKey === "headshot") {
      const bSufficient = hasSufficientWeaponSample(b.globalStats) ? 1 : 0;
      const aSufficient = hasSufficientWeaponSample(a.globalStats) ? 1 : 0;
      if (bSufficient !== aSufficient) return bSufficient - aSufficient;
      return (
        (b.globalStats?.headshot_pct ?? 0) - (a.globalStats?.headshot_pct ?? 0) ||
        (b.globalStats?.kills ?? 0) - (a.globalStats?.kills ?? 0)
      );
    }
    if (sortKey === "rounds") {
      return (b.globalStats?.rounds_equipped ?? 0) - (a.globalStats?.rounds_equipped ?? 0);
    }
    if (sortKey === "fireRate") {
      return (b.stats?.fireRate ?? 0) - (a.stats?.fireRate ?? 0);
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

export function getMaxHeadDamage(ranges?: DamageRange[] | null) {
  return Math.max(0, ...(ranges ?? []).map((range) => range.headDamage ?? 0));
}
