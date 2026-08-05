import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  useAgentes,
  useGlobalAgentStats,
  usePlayerDashboard,
  useRegionOptions,
} from "../../api/hooks";
import { useAuth } from "../../context/AuthContext";
import type { Agente, Role } from "../../types/agents";
import type { GlobalAgentStatsOption, RegionAgentStats } from "../../types/globalStats";
import {
  formatNumber,
  formatPercent,
  normalizeArrayResponse,
  normalizeLabel,
  safeDivide,
} from "../../utils/formatters";
import { buildAgentCompareMetrics } from "./domain/agentComparisons";
import { getAgentKey } from "./domain/agentKeys";
import {
  formatNormalizedMetricValue,
  type NormalizationMetricKey,
  getNormalizedPersonalMetricValue,
  getNormalizedRegionMetricValue,
} from "./domain/agentMetricNormalization";
import { buildPersonalStatsByAgent } from "./domain/agentPersonalStats";
import { buildAgentProfileMetrics } from "./domain/agentProfile";
import {
  calculateAgentScores,
  getAgentTier,
  getScoreConfidence,
  isLowSample,
} from "./domain/agentScoring";
import type {
  AgentComparisonMetric,
  AgentFilterSummary,
  AgentSelectOption,
  AgentSortKey,
  EnrichedAgent,
  PersonalAgentStats,
  RoleSummaryItem,
} from "./types";

type RouteState = {
  agentName?: string;
  returnTo?: string;
  returnLabel?: string;
} | null;

type ComparisonMetricConfig = {
  key:
    | keyof RegionAgentStats
    | "wins_per_match"
    | "losses_per_match"
    | "kills_per_round"
    | "deaths_per_round"
    | "assists_per_round";
  normalizationKey?: NormalizationMetricKey;
  label: string;
  format: "number" | "percent";
  higherIsBetter?: boolean;
};

const comparisonMetricConfigs: ComparisonMetricConfig[] = [
  { key: "win_rate", label: "Win Rate", format: "percent" },
  { key: "wins_per_match", label: "Wins / partida", format: "number" },
  { key: "losses_per_match", label: "Losses / partida", format: "number", higherIsBetter: false },
  { key: "pick_rate", label: "Pick Rate", format: "percent" },
  { key: "kills_per_round", label: "Kills / ronda", format: "number" },
  { key: "deaths_per_round", label: "Muertes / ronda", format: "number", higherIsBetter: false },
  { key: "assists_per_round", label: "Assists / ronda", format: "number" },
  { key: "avg_kd", label: "KD medio", format: "number" },
  { key: "avg_kda", label: "KDA medio", format: "number" },
  { key: "avg_acs", label: "ACS medio", format: "number" },
  { key: "avg_adr", label: "ADR medio", format: "number" },
  { key: "avg_headshot_pct", label: "Headshot", format: "percent" },
  { key: "avg_fk_rate", label: "FK Rate", format: "percent" },
  { key: "kast_pct", label: "KAST", format: "percent" },
  { key: "trade_rate", label: "Trade rate", format: "percent" },
  { key: "assist_rate", label: "Assist rate", format: "percent" },
  { key: "avg_survival_rate", label: "Supervivencia", format: "percent" },
  { key: "avg_clutch_win_rate", label: "Clutch WR", format: "percent" },
];

function buildAgentStatsResolver(agentStatsById: Record<string, RegionAgentStats>) {
  const agentStatsByName = new Map<string, RegionAgentStats>();
  Object.values(agentStatsById).forEach((stats) => {
    if (stats.agent_name) agentStatsByName.set(normalizeLabel(stats.agent_name), stats);
  });

  return (agent: Agente) =>
    agentStatsById[agent.uuid ?? agent.id ?? ""] ??
    agentStatsByName.get(normalizeLabel(agent.displayName));
}

function sortAgents(agents: EnrichedAgent[], sortKey: AgentSortKey): EnrichedAgent[] {
  return [...agents].sort((a, b) => {
    if (sortKey === "score") return b.score - a.score;
    if (sortKey === "picks") return (b.globalStats?.picks ?? 0) - (a.globalStats?.picks ?? 0);
    if (sortKey === "winRate") return (b.globalStats?.win_rate ?? 0) - (a.globalStats?.win_rate ?? 0);
    if (sortKey === "role") {
      const roleCompare = a.role.displayName.localeCompare(b.role.displayName);
      return roleCompare || a.displayName.localeCompare(b.displayName);
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

function buildRoleSummary(agents: EnrichedAgent[], roles: Role[]): RoleSummaryItem[] {
  const totalPicks = agents.reduce((total, agent) => total + (agent.globalStats?.picks ?? 0), 0);

  return roles.map((role) => {
    const roleAgents = agents.filter((agent) => agent.role.displayName === role.displayName);
    const picks = roleAgents.reduce((total, agent) => total + (agent.globalStats?.picks ?? 0), 0);
    const wins = roleAgents.reduce((total, agent) => total + (agent.globalStats?.wins ?? 0), 0);

    return {
      ...role,
      agents: roleAgents.length,
      picks,
      wins,
      usagePct: safeDivide(picks * 100, totalPicks),
      winRate: safeDivide(wins * 100, picks),
    };
  });
}

function buildRegionOptions(regions: { region: string }[] | undefined): AgentSelectOption[] {
  return (regions ?? [])
    .map((region) => region.region?.toLowerCase())
    .filter((region): region is string => Boolean(region))
    .map((region) => ({ value: region, label: region.toUpperCase() }));
}

function buildGlobalFilterOptions(
  options: GlobalAgentStatsOption[] | undefined,
  emptyLabel: string,
): AgentSelectOption[] {
  if (!options || options.length === 0) {
    return [{ value: "all", label: emptyLabel, disabled: true }];
  }
  return [
    { value: "all", label: "Todos" },
    ...options.map((option) => ({
      value: option.value,
      label: option.count ? `${option.label} (${option.count})` : option.label,
    })),
  ];
}

function optionLabel(options: AgentSelectOption[], value: string) {
  const label = options.find((option) => option.value === value)?.label ?? value;
  return label.replace(/\s+\(\d+\)$/, "");
}

function getPersonalMetricValue(personalStats: PersonalAgentStats | null | undefined, config: ComparisonMetricConfig) {
  if (!personalStats) return undefined;
  if (config.key === "win_rate") return personalStats.winRate;
  if (config.key === "pick_rate") return personalStats.usagePct;
  if (config.key === "wins_per_match") return safeDivide(personalStats.wins, personalStats.picks);
  if (config.key === "losses_per_match") return safeDivide(personalStats.losses, personalStats.picks);
  if (config.key === "kills_per_round") return safeDivide(personalStats.kills, personalStats.rounds ?? 0);
  if (config.key === "deaths_per_round") return safeDivide(personalStats.deaths, personalStats.rounds ?? 0);
  if (config.key === "assists_per_round") return safeDivide(personalStats.assists, personalStats.rounds ?? 0);
  const value = personalStats[config.key as keyof PersonalAgentStats];
  return typeof value === "number" ? value : undefined;
}

function getGlobalMetricValue(
  globalStats: RegionAgentStats | undefined,
  key: ComparisonMetricConfig["key"],
) {
  if (key === "wins_per_match") {
    const matches = globalStats?.matches ?? globalStats?.picks;
    const wins = globalStats?.wins;
    if (typeof matches !== "number" || matches <= 0 || typeof wins !== "number") return undefined;
    return wins / matches;
  }
  if (key === "losses_per_match") {
    const matches = globalStats?.matches ?? globalStats?.picks;
    const wins = globalStats?.wins;
    if (typeof matches !== "number" || matches <= 0 || typeof wins !== "number") return undefined;
    return Math.max(0, matches - wins) / matches;
  }
  if (key === "kills_per_round") {
    const rounds = globalStats?.rounds ?? globalStats?.totals?.rounds;
    const kills = globalStats?.totals?.kills;
    if (typeof rounds !== "number" || rounds <= 0 || typeof kills !== "number") return undefined;
    return kills / rounds;
  }
  if (key === "deaths_per_round") {
    const rounds = globalStats?.rounds ?? globalStats?.totals?.rounds;
    const deaths = globalStats?.totals?.deaths;
    if (typeof rounds !== "number" || rounds <= 0 || typeof deaths !== "number") return undefined;
    return deaths / rounds;
  }
  if (key === "assists_per_round") {
    const rounds = globalStats?.rounds ?? globalStats?.totals?.rounds;
    const assists = globalStats?.totals?.assists;
    if (typeof rounds !== "number" || rounds <= 0 || typeof assists !== "number") return undefined;
    return assists / rounds;
  }
  const value = globalStats?.[key as keyof RegionAgentStats];
  return typeof value === "number" ? value : undefined;
}

function formatComparisonValue(value: number | undefined, format: ComparisonMetricConfig["format"]) {
  if (value === undefined || Number.isNaN(value)) return "-";
  if (format === "percent") return formatPercent(value);
  return formatNumber(value, 2);
}

function formatDiff(globalValue: number | undefined, personalValue: number | undefined, format: ComparisonMetricConfig["format"]) {
  if (globalValue === undefined || personalValue === undefined) return "-";
  const diff = personalValue - globalValue;
  const sign = diff > 0 ? "+" : "";
  if (format === "percent") return `${sign}${formatPercent(diff)}`;
  return `${sign}${formatNumber(diff, 2)}`;
}

function formatNormalizedDiff(
  globalValue: number | undefined,
  personalValue: number | undefined,
  format: ComparisonMetricConfig["format"],
) {
  if (globalValue === undefined || personalValue === undefined) return "-";
  const diff = personalValue - globalValue;
  const sign = diff > 0 ? "+" : "";
  if (format === "percent") return `${sign}${formatPercent(diff)}`;
  return `${sign}${formatNumber(diff, 2)}`;
}

function buildComparisonMetrics(
  globalStats: RegionAgentStats | undefined,
  personalStats: PersonalAgentStats | null | undefined,
  roleStats: RegionAgentStats[],
  globalCohort: RegionAgentStats[],
): AgentComparisonMetric[] {
  return comparisonMetricConfigs
    .map<AgentComparisonMetric | null>((config) => {
      const globalValue = getGlobalMetricValue(globalStats, config.key);
      const personalValue = getPersonalMetricValue(personalStats, config);
      if (globalValue === undefined && personalValue === undefined) return null;
      const diff = globalValue === undefined || personalValue === undefined ? undefined : personalValue - globalValue;
      const normalizedMetricKey = (config.normalizationKey ?? config.key) as NormalizationMetricKey;
      const globalNormalizedValue = getNormalizedRegionMetricValue(
        globalStats,
        normalizedMetricKey,
        roleStats,
        globalCohort,
      );
      const personalNormalizedValue = getNormalizedPersonalMetricValue(
        personalStats,
        globalStats,
        normalizedMetricKey,
        roleStats,
        globalCohort,
      );
      const normalizedDiff =
        globalNormalizedValue === undefined || personalNormalizedValue === undefined
          ? undefined
          : personalNormalizedValue - globalNormalizedValue;
      const normalizedDiffLabel = formatNormalizedDiff(
        globalNormalizedValue,
        personalNormalizedValue,
        config.format,
      );
      return {
        key: config.key,
        label: config.label,
        globalLabel: formatComparisonValue(globalValue, config.format),
        personalLabel: formatComparisonValue(personalValue, config.format),
        diffLabel: formatDiff(globalValue, personalValue, config.format),
        ...(diff !== undefined ? { diff } : {}),
        ...(globalNormalizedValue !== undefined
          ? { globalNormalizedLabel: formatNormalizedMetricValue(globalNormalizedValue, config.format) }
          : {}),
        ...(personalNormalizedValue !== undefined
          ? { personalNormalizedLabel: formatNormalizedMetricValue(personalNormalizedValue, config.format) }
          : {}),
        ...(globalNormalizedValue !== undefined ? { globalNormalizedValue } : {}),
        ...(personalNormalizedValue !== undefined ? { personalNormalizedValue } : {}),
        ...(normalizedDiff !== undefined ? { normalizedDiff } : {}),
        normalizedDiffLabel,
        higherIsBetter: config.higherIsBetter ?? true,
      };
    })
    .filter((metric): metric is AgentComparisonMetric => metric !== null);
}

function buildFilterSummary(
  agents: EnrichedAgent[],
  filteredAgents: EnrichedAgent[],
  activeRole: string,
  search: string,
  sortKey: AgentSortKey,
  selectedRegion: string,
  mapFilter: string,
  mapFilterLabel: string,
  rankFilter: string,
  rankFilterLabel: string,
  actFilter: string,
  actFilterLabel: string,
): AgentFilterSummary {
  const sortLabels: Record<AgentSortKey, string> = {
    name: "Orden por nombre",
    picks: "Orden por pick rate",
    winRate: "Orden por win rate",
    role: "Orden por rol",
    score: "Orden por score",
  };
  const activeFilters: AgentFilterSummary["activeFilters"] = [
    selectedRegion ? { key: "region", label: `Región: ${selectedRegion.toUpperCase()}` } : null,
    search.trim() ? { key: "search", label: `Búsqueda: ${search.trim()}` } : null,
    activeRole !== "all" ? { key: "role", label: `Rol: ${activeRole}` } : null,
    mapFilter !== "all" ? { key: "map", label: `Mapa: ${mapFilterLabel}` } : null,
    rankFilter !== "all" ? { key: "rank", label: `Rango: ${rankFilterLabel}` } : null,
    actFilter !== "all" ? { key: "act", label: `Acto: ${actFilterLabel}` } : null,
    sortKey !== "name" ? { key: "sort", label: sortLabels[sortKey] } : null,
  ].filter((filter): filter is AgentFilterSummary["activeFilters"][number] =>
    Boolean(filter),
  );

  return {
    total: agents.length,
    shown: filteredAgents.length,
    activeFilters,
    activeLabels: activeFilters.map((filter) => filter.label),
  };
}

export function useAgentesViewModel() {
  const auth = useAuth();
  const { data: rawAgentes, isLoading: agentesLoading, isError, error } = useAgentes();
  const { data: regions, isLoading: regionsLoading } = useRegionOptions();
  const personalDashboardQuery = usePlayerDashboard(auth.user?.puuid, undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = (location.state as RouteState) ?? null;
  const consumedRouteAgentNameRef = useRef<string | null>(null);
  const regionTouchedRef = useRef(false);

  const [selectedAgent, setSelectedAgent] = useState<EnrichedAgent | null>(null);
  const [activeRole, setActiveRole] = useState("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<AgentSortKey>("score");
  const [selectedRegion, setSelectedRegionState] = useState("");
  const [mapFilter, setMapFilter] = useState("all");
  const [rankFilter, setRankFilter] = useState("all");
  const [actFilter, setActFilter] = useState("all");
  const [compareAgents, setCompareAgents] = useState<EnrichedAgent[]>([]);

  const regionOptions = useMemo(() => buildRegionOptions(regions), [regions]);
  const effectiveRegion = selectedRegion || regionOptions[0]?.value || "";
  const globalAgentStatsQuery = useGlobalAgentStats({
    region: effectiveRegion,
    rank: rankFilter,
    map: mapFilter,
    act: actFilter,
  }, Boolean(effectiveRegion));

  const baseAgents = useMemo(() => normalizeArrayResponse<Agente>(rawAgentes), [rawAgentes]);

  useEffect(() => {
    if (regionTouchedRef.current || regionOptions.length === 0) return;
    const playerRegion = personalDashboardQuery.data?.player?.region?.toLowerCase();
    const preferred = auth.isLoggedIn ? playerRegion : undefined;
    const nextRegion =
      regionOptions.find((option) => option.value === preferred)?.value ??
      regionOptions[0]?.value ??
      "";
    if (nextRegion && selectedRegion !== nextRegion) {
      const frame = requestAnimationFrame(() => setSelectedRegionState(nextRegion));
      return () => cancelAnimationFrame(frame);
    }
  }, [auth.isLoggedIn, personalDashboardQuery.data?.player?.region, regionOptions, selectedRegion]);

  const setSelectedRegion = (value: string) => {
    regionTouchedRef.current = true;
    setSelectedRegionState(value.toLowerCase());
  };

  const resolveStats = useMemo(
    () => buildAgentStatsResolver(globalAgentStatsQuery.data?.agentStats ?? {}),
    [globalAgentStatsQuery.data?.agentStats],
  );

  const agents = useMemo<EnrichedAgent[]>(() => {
    const personalStatsByAgent = buildPersonalStatsByAgent(
      personalDashboardQuery.data?.analyticsList,
      baseAgents,
      { map: mapFilter, rank: rankFilter, act: actFilter },
    );
    const initialAgents = baseAgents
      .map((agent) => {
        const globalStats = resolveStats(agent);
        const confidence = getScoreConfidence(globalStats);
        const enriched: EnrichedAgent = {
          ...agent,
          globalStats,
          personalStats: personalStatsByAgent.get(getAgentKey(agent)) ?? null,
          comparisonMetrics: [],
          profileMetrics: [],
          score: 50,
          tier: "C",
          confidence,
          lowSample: isLowSample(globalStats),
        };
        return enriched;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const scoreByKey = calculateAgentScores(initialAgents);
    const statsByRole = new Map<string, RegionAgentStats[]>();
    const globalCohort = initialAgents
      .map((agent) => agent.globalStats)
      .filter((stats): stats is RegionAgentStats => Boolean(stats));
    initialAgents.forEach((agent) => {
      if (!agent.globalStats) return;
      const key = normalizeLabel(agent.role.displayName);
      statsByRole.set(key, [...(statsByRole.get(key) ?? []), agent.globalStats]);
    });

    return initialAgents.map((agent) => {
      const score = scoreByKey.get(getAgentKey(agent)) ?? 50;
      const lowSample = isLowSample(agent.globalStats);
      const roleStats = statsByRole.get(normalizeLabel(agent.role.displayName)) ?? [];
      const tier = getAgentTier(score, lowSample);
      return {
        ...agent,
        score,
        tier,
        lowSample,
        comparisonMetrics: buildComparisonMetrics(agent.globalStats, agent.personalStats, roleStats, globalCohort),
        profileMetrics: buildAgentProfileMetrics(
          { ...agent, score, tier, lowSample },
          roleStats,
        ),
      };
    });
  }, [
    actFilter,
    baseAgents,
    mapFilter,
    personalDashboardQuery.data?.analyticsList,
    rankFilter,
    resolveStats,
  ]);

  const roles = useMemo(
    () => Array.from(new Map(agents.map((agent) => [agent.role.displayName, agent.role])).values()),
    [agents],
  );

  const roleOptions = useMemo<AgentSelectOption[]>(
    () => [{ value: "all", label: "Todos" }, ...roles.map((role) => ({ value: role.displayName, label: role.displayName }))],
    [roles],
  );

  const roleSummary = useMemo(() => buildRoleSummary(agents, roles), [agents, roles]);

  const mapOptions = useMemo(
    () => buildGlobalFilterOptions(globalAgentStatsQuery.data?.options?.maps, "Sin mapas globales"),
    [globalAgentStatsQuery.data?.options?.maps],
  );
  const rankOptions = useMemo(
    () => buildGlobalFilterOptions(globalAgentStatsQuery.data?.options?.ranks, "Sin rangos globales"),
    [globalAgentStatsQuery.data?.options?.ranks],
  );
  const actOptions = useMemo(
    () => buildGlobalFilterOptions(globalAgentStatsQuery.data?.options?.acts, "Sin actos globales"),
    [globalAgentStatsQuery.data?.options?.acts],
  );

  const filterAvailability = {
    map: mapOptions.length > 1,
    rank: rankOptions.length > 1,
    act: actOptions.length > 1,
  };

  useEffect(() => {
    if (
      (filterAvailability.map || mapFilter === "all") &&
      (filterAvailability.rank || rankFilter === "all") &&
      (filterAvailability.act || actFilter === "all")
    ) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (!filterAvailability.map && mapFilter !== "all") setMapFilter("all");
      if (!filterAvailability.rank && rankFilter !== "all") setRankFilter("all");
      if (!filterAvailability.act && actFilter !== "all") setActFilter("all");
    });
    return () => cancelAnimationFrame(frame);
  }, [actFilter, filterAvailability.act, filterAvailability.map, filterAvailability.rank, mapFilter, rankFilter]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (mapFilter !== "all" && !mapOptions.some((option) => option.value === mapFilter)) {
        setMapFilter("all");
      }
      if (rankFilter !== "all" && !rankOptions.some((option) => option.value === rankFilter)) {
        setRankFilter("all");
      }
      if (actFilter !== "all" && !actOptions.some((option) => option.value === actFilter)) {
        setActFilter("all");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [actFilter, actOptions, mapFilter, mapOptions, rankFilter, rankOptions]);

  const filteredAgents = useMemo(() => {
    const normalizedSearch = normalizeLabel(search);
    const normalizedRole = normalizeLabel(activeRole);
    const filtered = agents.filter((agent) => {
      const matchesSearch = normalizeLabel(agent.displayName).includes(normalizedSearch);
      const matchesRole =
        activeRole === "all" ||
        normalizeLabel(agent.role.displayName) === normalizedRole;
      return matchesSearch && matchesRole;
    });
    return sortAgents(filtered, sortKey);
  }, [activeRole, agents, search, sortKey]);

  const filterSummary = useMemo(
    () =>
      buildFilterSummary(
        agents,
        filteredAgents,
        activeRole,
        search,
        sortKey,
        selectedRegion,
        mapFilter,
        optionLabel(mapOptions, mapFilter),
        rankFilter,
        optionLabel(rankOptions, rankFilter),
        actFilter,
        optionLabel(actOptions, actFilter),
      ),
    [
      activeRole,
      actFilter,
      actOptions,
      agents,
      filteredAgents,
      mapFilter,
      mapOptions,
      rankFilter,
      rankOptions,
      search,
      selectedRegion,
      sortKey,
    ],
  );

  const resetFilters = () => {
    setSearch("");
    setActiveRole("all");
    setSortKey("score");
    setMapFilter("all");
    setRankFilter("all");
    setActFilter("all");
    regionTouchedRef.current = false;
    const playerRegion = personalDashboardQuery.data?.player?.region?.toLowerCase();
    setSelectedRegionState(
      regionOptions.find((option) => option.value === playerRegion)?.value ??
        regionOptions[0]?.value ??
        "",
    );
  };

  useEffect(() => {
    const routeAgentName = routeState?.agentName?.trim() || null;
    if (!routeAgentName || consumedRouteAgentNameRef.current === routeAgentName || agents.length === 0 || selectedAgent) return;

    const frame = requestAnimationFrame(() => {
      const match = agents.find((agent) => normalizeLabel(agent.displayName) === normalizeLabel(routeAgentName));
      if (match) {
        setSelectedAgent(match);
      }
      consumedRouteAgentNameRef.current = routeAgentName;
    });

    return () => cancelAnimationFrame(frame);
  }, [agents, routeState?.agentName, selectedAgent]);

  const selectAgent = (agent: EnrichedAgent) => {
    const isActive = selectedAgent && getAgentKey(selectedAgent) === getAgentKey(agent);
    setSelectedAgent(isActive ? null : agent);
  };

  const closeDetail = () => {
    setSelectedAgent(null);
  };

  const toggleCompareAgent = (agent: EnrichedAgent) => {
    setCompareAgents((current) => {
      const exists = current.some((item) => getAgentKey(item) === getAgentKey(agent));
      if (exists) return current.filter((item) => getAgentKey(item) !== getAgentKey(agent));
      return [...current.slice(-1), agent];
    });
  };

  const removeCompareAgent = (agent: EnrichedAgent) => {
    setCompareAgents((current) => current.filter((item) => getAgentKey(item) !== getAgentKey(agent)));
  };

  const clearCompareAgents = () => setCompareAgents([]);

  const roleStatsByRole = useMemo(() => {
    const byRole = new Map<string, RegionAgentStats[]>();
    agents.forEach((agent) => {
      if (!agent.globalStats) return;
      const role = normalizeLabel(agent.role.displayName);
      byRole.set(role, [...(byRole.get(role) ?? []), agent.globalStats]);
    });
    return byRole;
  }, [agents]);

  const compareMetrics = useMemo(
    () =>
      compareAgents.length === 2
        ? buildAgentCompareMetrics(
            compareAgents[0],
            compareAgents[1],
            roleStatsByRole,
            agents
              .map((agent) => agent.globalStats)
              .filter((stats): stats is RegionAgentStats => Boolean(stats)),
          )
        : [],
    [agents, compareAgents, roleStatsByRole],
  );

  const currentSelectedAgent = selectedAgent
    ? agents.find((agent) => getAgentKey(agent) === getAgentKey(selectedAgent)) ?? selectedAgent
    : null;
  const isGlobalStatsInitialLoading =
    Boolean(selectedRegion) &&
    globalAgentStatsQuery.isLoading &&
    !globalAgentStatsQuery.data;
  const isFilteringGlobalStats =
    Boolean(selectedRegion) &&
    globalAgentStatsQuery.isFetching &&
    Boolean(globalAgentStatsQuery.data);

  return {
    activeRole,
    actFilter,
    actOptions,
    agents,
    compareAgents,
    compareMetrics,
    error: error ?? globalAgentStatsQuery.error,
    filteredAgents,
    filterAvailability,
    filterSummary,
    hasSession: auth.isLoggedIn,
    isError: isError || globalAgentStatsQuery.isError,
    isFilteringGlobalStats,
    isLoading:
      agentesLoading ||
      (regionsLoading && !selectedRegion) ||
      isGlobalStatsInitialLoading,
    mapFilter,
    mapOptions,
    navigate,
    rankFilter,
    rankOptions,
    regionOptions,
    returnLabel: routeState?.returnLabel ?? "Volver",
    returnTo: routeState?.returnTo ?? null,
    roleOptions,
    roleSummary,
    roles,
    search,
    selectedAgent: currentSelectedAgent,
    selectedRegion,
    sortKey,
    closeDetail,
    clearCompareAgents,
    removeCompareAgent,
    resetFilters,
    selectAgent,
    setActiveRole,
    setActFilter,
    setMapFilter,
    setRankFilter,
    setSearch,
    setSelectedRegion,
    setSortKey,
    toggleCompareAgent,
  };
}
