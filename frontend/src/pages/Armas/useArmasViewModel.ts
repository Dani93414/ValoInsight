import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  useArmas,
  useGear,
  usePlayerDashboard,
  useRegionWeaponStats,
} from "../../api/hooks";
import { useAuth } from "../../context/AuthContext";
import { normalizeArrayResponse, normalizeLabel } from "../../utils/formatters";
import type { GearContent } from "../../types/content";
import type { RegionWeaponStats } from "../../types/globalStats";
import type { Arma } from "../../types/weapons";
import type {
  EnrichedWeapon,
  WeaponSortKey,
  WeaponStatsFilter,
} from "./types";
import {
  buildFilterSummary,
  buildInsights,
  buildOverview,
  buildRanking,
  gearToWeapon,
} from "./weaponAnalytics";
import {
  calculatePersonalWeaponStats,
  compareWeaponStats,
} from "./weaponPersonalStats";
import { buildWeaponCompareMetrics } from "./weaponComparisons";
import {
  buildWeaponStatsResolver,
  getNumericCost,
  getWeaponProfileTags,
  getWeaponHeadshotSample,
  getWeaponSampleReliability,
  matchesWeaponStatsFilter,
  normalizeWeaponCategory,
  sortWeapons,
} from "./weaponUtils";

type RouteState = {
  weaponName?: string;
  returnTo?: string;
  returnLabel?: string;
} | null;

function getWeaponKey(weapon: Arma) {
  return weapon.uuid ?? weapon.displayName;
}

function sumField(target: RegionWeaponStats, source: RegionWeaponStats, key: keyof RegionWeaponStats) {
  const current = Number(target[key] ?? 0);
  const next = Number(source[key] ?? 0);
  target[key] = (current + next) as never;
}

function aggregateRegionWeaponStats(regionsData: Array<{ totalRounds?: number; weaponStats?: Record<string, RegionWeaponStats> }> | undefined) {
  const byId: Record<string, RegionWeaponStats> = {};
  const headshotsById = new Map<string, number>();
  const impactsById = new Map<string, number>();
  let totalRounds = 0;
  for (const region of regionsData ?? []) {
    totalRounds += Number(region?.totalRounds ?? 0);
    const weaponStats = region?.weaponStats ?? {};
    for (const [weaponId, stats] of Object.entries(weaponStats)) {
      const acc = byId[weaponId] ?? { weapon_name: stats.weapon_name, is_armor: stats.is_armor };
      acc.weapon_name = acc.weapon_name ?? stats.weapon_name;
      acc.is_armor = acc.is_armor ?? stats.is_armor;
      sumField(acc, stats, "rounds_equipped");
      sumField(acc, stats, "rounds_purchased");
      sumField(acc, stats, "wins");
      sumField(acc, stats, "kills");
      sumField(acc, stats, "deaths");
      sumField(acc, stats, "headshots");
      sumField(acc, stats, "bodyshots");
      sumField(acc, stats, "legshots");
      sumField(acc, stats, "damage_dealt");
      sumField(acc, stats, "damage_received");
      sumField(acc, stats, "survival_rounds");
      sumField(acc, stats, "loadout_value_total");
      const headshotSample = getWeaponHeadshotSample(stats);
      if (headshotSample) {
        headshotsById.set(weaponId, (headshotsById.get(weaponId) ?? 0) + headshotSample.headshots);
        impactsById.set(weaponId, (impactsById.get(weaponId) ?? 0) + headshotSample.impacts);
      }
      byId[weaponId] = acc;
    }
  }

  for (const [weaponId, stats] of Object.entries(byId)) {
    const rounds = Number(stats.rounds_equipped ?? 0);
    const kills = Number(stats.kills ?? 0);
    const deaths = Number(stats.deaths ?? 0);
    const wins = Number(stats.wins ?? 0);
    const damageDealt = Number(stats.damage_dealt ?? 0);
    const damageReceived = Number(stats.damage_received ?? 0);
    const survivalRounds = Number(stats.survival_rounds ?? 0);
    const loadout = Number(stats.loadout_value_total ?? 0);

    stats.kd_ratio = kills / Math.max(deaths, 1);
    stats.kills_per_round = rounds > 0 ? kills / rounds : 0;
    stats.adr = rounds > 0 ? damageDealt / rounds : 0;
    stats.win_rate = rounds > 0 ? (wins * 100) / rounds : 0;
    stats.survival_rate = rounds > 0 ? (survivalRounds * 100) / rounds : 0;
    stats.damage_received_per_round = rounds > 0 ? damageReceived / rounds : 0;
    stats.average_loadout_value = rounds > 0 ? loadout / rounds : 0;
    // Media global ponderada por todos los impactos de la muestra. Los
    // documentos históricos sin distribución completa quedan sin porcentaje.
    const totalHeadshots = headshotsById.get(weaponId) ?? 0;
    const totalImpacts = impactsById.get(weaponId) ?? 0;
    stats.headshot_pct = totalImpacts > 0 ? (totalHeadshots * 100) / totalImpacts : undefined;
    stats.pick_rate_per_round = totalRounds > 0 ? (rounds * 100) / totalRounds : 0;
  }

  return { weaponStatsById: byId, totalRounds };
}

export function useArmasViewModel() {
  const auth = useAuth();
  const {
    data: rawArmas,
    isLoading: weaponsLoading,
    isError: weaponsError,
    error: weaponsErrorValue,
  } = useArmas();
  const {
    data: rawGear,
    isLoading: gearLoading,
    isError: gearError,
    error: gearErrorValue,
  } = useGear();
  const {
    data: regions,
    isLoading: regionsLoading,
    isFetching: regionsFetching,
  } = useRegionWeaponStats();
  const personalDashboardQuery = usePlayerDashboard(
    auth.user?.puuid,
    undefined,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = (location.state as RouteState) ?? null;
  const consumedRouteWeaponNameRef = useRef<string | null>(null);

  const [selectedWeapon, setSelectedWeapon] = useState<EnrichedWeapon | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("Todas");
  const [activeCost, setActiveCost] = useState("Todos");
  const [statsFilter, setStatsFilter] = useState<WeaponStatsFilter>("all");
  const [sortKey, setSortKey] = useState<WeaponSortKey>("name");
  const [compareWeapons, setCompareWeapons] = useState<EnrichedWeapon[]>([]);

  const aggregatedRegionData = useMemo(
    () => aggregateRegionWeaponStats(regions as Array<{ totalRounds?: number; weaponStats?: Record<string, RegionWeaponStats> }> | undefined),
    [regions],
  );
  const weaponStatsById = aggregatedRegionData.weaponStatsById;
  const resolveStats = useMemo(
    () => buildWeaponStatsResolver(weaponStatsById),
    [weaponStatsById],
  );

  const weapons = useMemo<EnrichedWeapon[]>(() => {
    const contentWeapons = normalizeArrayResponse<Arma>(rawArmas);
    const shields = normalizeArrayResponse<GearContent>(rawGear)
      .filter((item) => item.displayName)
      .map(gearToWeapon);

    return [...contentWeapons, ...shields]
      .map((weapon) => {
        const globalStats = resolveStats(weapon);
        return {
          ...weapon,
          globalStats,
          normalizedCategory: normalizeWeaponCategory(weapon.category),
          profileTags: getWeaponProfileTags(weapon),
          sampleReliability: getWeaponSampleReliability(globalStats),
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [rawArmas, rawGear, resolveStats]);

  const categories = useMemo(
    () => ["Todas", ...Array.from(new Set(weapons.map((weapon) => weapon.normalizedCategory)))],
    [weapons],
  );

  const filteredWeapons = useMemo(() => {
    const normalizedSearch = normalizeLabel(search);
    const filtered = weapons.filter((weapon) => {
      const matchesSearch = normalizeLabel(weapon.displayName).includes(normalizedSearch);
      const matchesCategory =
        activeCategory === "Todas" || weapon.normalizedCategory === activeCategory;
      const numericCost = getNumericCost(weapon);
      const matchesCost =
        activeCost === "Todos" ||
        (activeCost === "Gratis" && numericCost === 0) ||
        (activeCost === "Economicas" && numericCost > 0 && numericCost <= 1600) ||
        (activeCost === "Premium" && numericCost > 1600);
      return (
        matchesSearch &&
        matchesCategory &&
        matchesCost &&
        matchesWeaponStatsFilter(weapon, statsFilter)
      );
    });
    return sortWeapons(filtered, sortKey);
  }, [activeCategory, activeCost, search, sortKey, statsFilter, weapons]);

  const weaponsByCategory = useMemo(() => {
    return filteredWeapons.reduce<Record<string, EnrichedWeapon[]>>((acc, weapon) => {
      if (!acc[weapon.normalizedCategory]) acc[weapon.normalizedCategory] = [];
      acc[weapon.normalizedCategory].push(weapon);
      return acc;
    }, {});
  }, [filteredWeapons]);

  const overviewStats = useMemo(() => buildOverview(weapons), [weapons]);
  const ranking = useMemo(() => buildRanking(weapons), [weapons]);
  const insights = useMemo(() => buildInsights(weapons), [weapons]);
  const filterSummary = useMemo(
    () =>
      buildFilterSummary(
        weapons,
        filteredWeapons,
        search,
        activeCategory,
        activeCost,
        statsFilter,
        sortKey,
      ),
    [activeCategory, activeCost, filteredWeapons, search, sortKey, statsFilter, weapons],
  );

  const personalComparison = useMemo(() => {
    if (!auth.isLoggedIn) return null;
    if (personalDashboardQuery.isLoading) {
      return {
        hasSession: true,
        isLoading: true,
        isError: false,
        hasPersonalUsage: false,
        hasGlobalReference: Boolean(selectedWeapon?.globalStats),
        sampleReliability: "Cargando",
        summary: "Cargando tus estadísticas personales...",
        metrics: [],
      };
    }
    if (personalDashboardQuery.isError) {
      return {
        hasSession: true,
        isLoading: false,
        isError: true,
        hasPersonalUsage: false,
        hasGlobalReference: Boolean(selectedWeapon?.globalStats),
        sampleReliability: "Sin datos",
        summary: "No se pudieron cargar tus estadísticas personales.",
        metrics: [],
      };
    }
    if (!selectedWeapon) return null;

    const personalStats = calculatePersonalWeaponStats(
      personalDashboardQuery.data?.analyticsList,
      selectedWeapon.uuid,
    );
    return compareWeaponStats(
      selectedWeapon.globalStats,
      personalStats,
      weapons.map((weapon) => weapon.globalStats).filter((stats): stats is RegionWeaponStats => Boolean(stats)),
      Boolean(selectedWeapon.isShield),
      aggregatedRegionData.totalRounds,
    );
  }, [
    auth.isLoggedIn,
    personalDashboardQuery.data?.analyticsList,
    personalDashboardQuery.isError,
    personalDashboardQuery.isLoading,
    aggregatedRegionData.totalRounds,
    selectedWeapon,
    weapons,
  ]);

  const compareMetrics = useMemo(() => {
    if (compareWeapons.length !== 2) return [];
    return buildWeaponCompareMetrics(compareWeapons[0], compareWeapons[1]);
  }, [compareWeapons]);

  useEffect(() => {
    const routeWeaponName = routeState?.weaponName?.trim() || null;
    if (
      !routeWeaponName ||
      consumedRouteWeaponNameRef.current === routeWeaponName ||
      weapons.length === 0 ||
      selectedWeapon
    ) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const match = weapons.find(
        (weapon) => normalizeLabel(weapon.displayName) === normalizeLabel(routeWeaponName),
      );
      if (match) setSelectedWeapon(match);
      consumedRouteWeaponNameRef.current = routeWeaponName;
    });

    return () => cancelAnimationFrame(frame);
  }, [routeState?.weaponName, selectedWeapon, weapons]);

  useEffect(() => {
    if (!selectedWeapon) return;
    const selectedKey = getWeaponKey(selectedWeapon);
    const stillVisible = filteredWeapons.some(
      (weapon) => getWeaponKey(weapon) === selectedKey,
    );
    if (stillVisible) return;
    const frame = requestAnimationFrame(() => setSelectedWeapon(null));
    return () => cancelAnimationFrame(frame);
  }, [filteredWeapons, selectedWeapon]);

  const selectWeapon = (weapon: EnrichedWeapon) => {
    const active =
      selectedWeapon && getWeaponKey(selectedWeapon) === getWeaponKey(weapon);
    setSelectedWeapon(active ? null : weapon);
  };

  const toggleCompareWeapon = (weapon: EnrichedWeapon) => {
    setCompareWeapons((current) => {
      const key = getWeaponKey(weapon);
      if (current.some((item) => getWeaponKey(item) === key)) {
        return current.filter((item) => getWeaponKey(item) !== key);
      }
      if (current.some((item) => item.isShield !== weapon.isShield)) return current;
      if (current.length >= 2) return current;
      return [...current, weapon];
    });
  };

  const removeCompareWeapon = (weapon: EnrichedWeapon) => {
    const key = getWeaponKey(weapon);
    setCompareWeapons((current) => current.filter((item) => getWeaponKey(item) !== key));
  };

  const clearCompareWeapons = () => setCompareWeapons([]);

  const resetFilters = () => {
    setSearch("");
    setActiveCategory("Todas");
    setActiveCost("Todos");
    setStatsFilter("all");
    setSortKey("name");
  };

  const clearFilter = (key: "search" | "category" | "cost" | "stats" | "sort") => {
    if (key === "search") setSearch("");
    if (key === "category") setActiveCategory("Todas");
    if (key === "cost") setActiveCost("Todos");
    if (key === "stats") setStatsFilter("all");
    if (key === "sort") setSortKey("name");
  };

  return {
    activeCategory,
    activeCost,
    categories,
    compareMetrics,
    compareWeapons,
    error: weaponsErrorValue ?? gearErrorValue,
    filterSummary,
    filteredWeapons,
    hasSession: auth.isLoggedIn,
    insights,
    isError: weaponsError || gearError,
    isLoading:
      weaponsLoading ||
      gearLoading ||
      regionsLoading ||
      regionsFetching,
    navigate,
    overviewStats,
    personalComparison,
    ranking,
    returnLabel: routeState?.returnLabel ?? "Volver",
    returnTo: routeState?.returnTo ?? null,
    search,
    selectedWeapon,
    sortKey,
    statsFilter,
    weapons,
    weaponsByCategory,
    resetFilters,
    clearFilter,
    clearCompareWeapons,
    removeCompareWeapon,
    selectWeapon,
    setActiveCategory,
    setActiveCost,
    setSearch,
    setSelectedWeapon,
    setSortKey,
    setStatsFilter,
    toggleCompareWeapon,
  };
}
