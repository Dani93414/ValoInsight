import { useCallback, useEffect, useMemo, useState } from "react";
import {
  usePlayerDashboard,
  useCompetitiveTiers,
  usePlayerRankComparison,
} from "../../api/hooks";
import { useScrollReveal } from "../../hooks/useScrollReveal";
import { useTacticalStats } from "../../hooks/useTacticalStats";
import { useDashboardStats } from "../../hooks/useDashboardStats";
import { useRankDisplay } from "../../hooks/useRankDisplay";
import type { RankComparisonFilters } from "../../api/playerApi";

import type {
  MatchCard,
  CompetitiveTierAsset,
  PartySizeFilter,
  DashboardFilters,
  RankComparisonMetricKey,
  RankComparisonPayload,
} from "../../types/dashboard";
import { normalizeLabel } from "../../utils/formatters";
import {
  getRankNameFromTier,
  normalizeCompetitiveTierIconPath,
} from "../../utils/rankUtils";
import {
  ACT_FILTER_ALL,
  ACT_FILTER_CURRENT,
  AGENT_FILTER_ALL,
  MAP_FILTER_ALL,
  QUEUE_FILTER_ALL,
  QUEUE_FILTER_COMPETITIVE,
  INFO_ICON_TRIGGER_SELECTOR,
  QUEUE_LABELS,
  PARTY_SIZE_MAP,
} from "../../constants/dashboard";
import {
  type TooltipPlacement,
  type TooltipRect,
  type TooltipSize,
  estimateFloatingInfoTooltipSize,
  resolveFloatingTooltipPosition,
  snapshotTooltipRect,
} from "../../utils/tooltipPositioning";

// ── Constants ──────────────────────────────────────────────────────────
export const MATCHES_PER_PAGE = 8;
export const HISTORY_LOAD_STEP = 12;

const ROLE_ICON_BY_NAME: Record<string, string> = {
  duelista:
    "/content/agents/0e38b510-41a8-5780-5e8f-568b2a4f2d6c/role/displayIcon.png",
  duelist:
    "/content/agents/0e38b510-41a8-5780-5e8f-568b2a4f2d6c/role/displayIcon.png",
  centinela:
    "/content/agents/569fdd95-4d10-43ab-ca70-79becc718b46/role/displayIcon.png",
  sentinel:
    "/content/agents/569fdd95-4d10-43ab-ca70-79becc718b46/role/displayIcon.png",
  controlador:
    "/content/agents/9f0d8ba9-4140-b941-57d3-a7ad57c6b417/role/displayIcon.png",
  controller:
    "/content/agents/9f0d8ba9-4140-b941-57d3-a7ad57c6b417/role/displayIcon.png",
  iniciador:
    "/content/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/role/displayIcon.png",
  initiator:
    "/content/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/role/displayIcon.png",
};

function getRoleIcon(roleName: string, fallback?: string | null) {
  return ROLE_ICON_BY_NAME[normalizeLabel(roleName)] ?? fallback ?? null;
}

type ProfilePerformanceMetric = {
  key: RankComparisonMetricKey;
  label: string;
  value: number;
  fillPercent: number;
  isPercent: boolean;
  decimals: number;
  tooltip: string;
  comparisonSampleSize: number;
  isNeutral: boolean;
};

type RoundImpactSummary = {
  totalRounds: number;
  attackRounds: number;
  defenseRounds: number;
  roundsWithKill: number;
  roundsWithDeath: number;
  roundsWithAssist: number;
  roundsWithDirectParticipation: number;
  roundsWithoutDirectParticipation: number;
  roundsWithKillPct: number;
  roundsWithDeathPct: number;
  roundsWithAssistPct: number;
  directParticipationPct: number;
  noDirectParticipationPct: number;
  firstBloods: number;
  aces: number;
  plants: number;
  defuses: number;
  plantOpportunities: number;
  defuseOpportunities: number;
  plantsPerOpportunityPct: number;
  defusesPerOpportunityPct: number;
  distributionOnlyKills: number;
  distributionOnlyAssists: number;
  distributionOnlyDeaths: number;
  distributionKillAssist: number;
  distributionKillDeath: number;
  distributionAssistDeath: number;
  distributionKillAssistDeath: number;
  distributionNone: number;
  distributionCombinedOrNone: number;
  distributionOnlyKillsPct: number;
  distributionOnlyAssistsPct: number;
  distributionOnlyDeathsPct: number;
  distributionKillAssistPct: number;
  distributionKillDeathPct: number;
  distributionAssistDeathPct: number;
  distributionKillAssistDeathPct: number;
  distributionNonePct: number;
  distributionCombinedOrNonePct: number;
};

const INFO_TOOLTIP_PREFERRED_PLACEMENTS: TooltipPlacement[] = [
  "top",
  "bottom",
  "right",
  "left",
];

const INFO_TOOLTIP_ESTIMATED_MAX_WIDTH = 360;

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }
  return 0;
}

function clampRoundCount(value: unknown, totalRounds: number): number {
  return Math.min(toNonNegativeInt(value), Math.max(0, totalRounds));
}

function scaleRoundCountToSide(
  value: unknown,
  totalRounds: number,
  sideRounds: number,
): number {
  const normalizedTotalRounds = Math.max(0, totalRounds);
  const normalizedSideRounds = Math.max(0, sideRounds);
  if (normalizedTotalRounds <= 0 || normalizedSideRounds <= 0) {
    return 0;
  }

  const safeValue = clampRoundCount(value, normalizedTotalRounds);
  const scaledValue = Math.round(
    (safeValue * normalizedSideRounds) / normalizedTotalRounds,
  );
  return Math.min(normalizedSideRounds, Math.max(0, scaledValue));
}

function getHostRect(target: EventTarget | null): TooltipRect | null {
  if (!(target instanceof Element)) return null;
  const host = target.closest(
    ".stats-panel, .side-panel-card, .header-showcase-card, .player-rank-block",
  );
  return host ? snapshotTooltipRect(host.getBoundingClientRect()) : null;
}

function getAnchorRect(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): TooltipRect {
  if (target instanceof Element) {
    return snapshotTooltipRect(target.getBoundingClientRect());
  }

  return {
    left: clientX,
    top: clientY,
    right: clientX,
    bottom: clientY,
    width: 0,
    height: 0,
  };
}

function resolveInfoTooltipPosition(
  anchorRect: TooltipRect,
  hostRect: TooltipRect | null,
  tooltipSize: TooltipSize,
) {
  return resolveFloatingTooltipPosition({
    anchorRect,
    containerRect: hostRect,
    tooltipSize,
    placements: INFO_TOOLTIP_PREFERRED_PLACEMENTS,
  });
}

// ── Hook ───────────────────────────────────────────────────────────────
export function useEstadisticasViewModel(playerId: string | undefined) {
  // ── Data fetching ────────────────────────────────────────────────────
  const { data: dashboard, isLoading: loading } = usePlayerDashboard(playerId);

  const { data: tiersRaw } = useCompetitiveTiers();

  // ── State ────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<DashboardFilters>({
    actId: ACT_FILTER_CURRENT,
    agentId: AGENT_FILTER_ALL,
    map: MAP_FILTER_ALL,
    side: "all",
    partySize: "all",
    queueId: QUEUE_FILTER_COMPETITIVE,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedWeaponId, setSelectedWeaponId] = useState<string | null>(null);
  const [heatmapOpen, setHeatmapOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [agentsModalOpen, setAgentsModalOpen] = useState(false);
  const [weaponsModalOpen, setWeaponsModalOpen] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] =
    useState(MATCHES_PER_PAGE);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // ── Floating tooltip state ───────────────────────────────────────────
  const [floatingTooltip, setFloatingTooltip] = useState<{
    visible: true;
    x: number;
    y: number;
    content: string;
    placement: TooltipPlacement;
    anchorRect: TooltipRect;
    hostRect: TooltipRect | null;
  } | null>(null);

  // ── Rank name → icon map ─────────────────────────────────────────────
  const rankNameIconMap = useMemo(() => {
    const m = new Map<string, string>();
    if (!Array.isArray(tiersRaw)) return m;
    for (const t of tiersRaw as CompetitiveTierAsset[]) {
      const tier = Number(t?.tier);
      const icon = normalizeCompetitiveTierIconPath(
        t?.smallIcon ||
          t?.largeIcon ||
          t?.rankTriangleUpIcon ||
          t?.rankTriangleDownIcon,
      );
      const tierName = normalizeLabel(t?.tierName);
      const divisionName = normalizeLabel(t?.divisionName);

      if (tierName && icon && !m.has(tierName)) m.set(tierName, icon);

      if (divisionName && icon && Number.isFinite(tier) && tier >= 3) {
        const divisionLevel = ((tier - 3) % 3) + 1;
        const divisionKey = `${divisionName} ${divisionLevel}`;
        if (!m.has(divisionKey)) m.set(divisionKey, icon);
      }

      if (Number.isFinite(tier)) {
        const english = normalizeLabel(getRankNameFromTier(tier));
        if (english && icon && !m.has(english)) m.set(english, icon);
      }
    }
    return m;
  }, [tiersRaw]);

  // ── Reset history count when filters change ──────────────────────────
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setHistoryVisibleCount(MATCHES_PER_PAGE);
    });
    return () => cancelAnimationFrame(frame);
  }, [filters]);

  // ── Derived data ─────────────────────────────────────────────────────
  const player = dashboard?.player;
  const actOptions = useMemo(
    () => dashboard?.actOptions ?? [],
    [dashboard?.actOptions],
  );
  const actLabelById = useMemo(() => {
    const map = new Map<string, string>();
    actOptions.forEach((option) => {
      map.set(option.id, option.label);
    });
    return map;
  }, [actOptions]);
  const currentActId = dashboard?.currentActId ?? actOptions[0]?.id ?? null;

  const allMatches = useMemo(() => {
    if (!dashboard) return [];
    return Object.values(dashboard.actSections).flatMap(
      (section) => section.matches ?? [],
    );
  }, [dashboard]);

  const effectiveCurrentActId = useMemo(() => {
    if (currentActId && allMatches.some((m) => m.seasonId === currentActId)) {
      return currentActId;
    }
    if (actOptions.length > 0) return actOptions[0].id;
    return null;
  }, [currentActId, allMatches, actOptions]);

  const effectiveActId = useMemo(() => {
    if (filters.actId === ACT_FILTER_ALL) return null;
    if (filters.actId === ACT_FILTER_CURRENT) return effectiveCurrentActId;
    return filters.actId;
  }, [filters.actId, effectiveCurrentActId]);

  const rankComparisonFilters = useMemo<RankComparisonFilters>(
    () => ({
      queue_id:
        filters.queueId === QUEUE_FILTER_ALL ? undefined : filters.queueId,
      agent_id:
        filters.agentId === AGENT_FILTER_ALL ? undefined : filters.agentId,
      map_name: filters.map === MAP_FILTER_ALL ? undefined : filters.map,
      season_id: effectiveActId ?? undefined,
      party_size: filters.partySize === "all" ? undefined : filters.partySize,
    }),
    [
      effectiveActId,
      filters.agentId,
      filters.map,
      filters.partySize,
      filters.queueId,
    ],
  );

  const {
    data: rankComparisonRaw,
    isLoading: rankComparisonLoading,
    isFetching: rankComparisonFetching,
  } = usePlayerRankComparison(
    playerId,
    rankComparisonFilters,
    Boolean(playerId && dashboard),
  );
  const rankComparison =
    (rankComparisonRaw as RankComparisonPayload | undefined) ?? null;

  // ── Cascading filter options ─────────────────────────────────────────
  const availableFilterOptions = useMemo(() => {
    const checkAgent = (m: MatchCard) =>
      filters.agentId === AGENT_FILTER_ALL || m.agentId === filters.agentId;
    const checkMap = (m: MatchCard) =>
      filters.map === MAP_FILTER_ALL || m.map === filters.map;
    const checkQueue = (m: MatchCard) =>
      filters.queueId === QUEUE_FILTER_ALL || m.queue === filters.queueId;
    const checkParty = (m: MatchCard) =>
      filters.partySize === "all" ||
      (PARTY_SIZE_MAP[filters.partySize] ?? []).includes(m.partySize ?? 0);
    const checkAct = (m: MatchCard) =>
      !effectiveActId || m.seasonId === effectiveActId;

    const matchesForAct = allMatches.filter(
      (m) => checkAgent(m) && checkMap(m) && checkQueue(m) && checkParty(m),
    );
    const actIds = new Set(matchesForAct.map((m) => m.seasonId));

    const matchesForAgent = allMatches.filter(
      (m) => checkAct(m) && checkMap(m) && checkQueue(m) && checkParty(m),
    );
    const agentMap = new Map<string, string>();
    matchesForAgent.forEach((m) => {
      if (m.agentId && m.agent) agentMap.set(m.agentId, m.agent);
    });

    const matchesForMap = allMatches.filter(
      (m) => checkAct(m) && checkAgent(m) && checkQueue(m) && checkParty(m),
    );
    const maps = Array.from(
      new Set(matchesForMap.map((m) => m.map).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b, "es"));

    const matchesForQueue = allMatches.filter(
      (m) => checkAct(m) && checkAgent(m) && checkMap(m) && checkParty(m),
    );
    const queues = Array.from(
      new Set(
        matchesForQueue.map((m) => (m.queue as string) || "").filter(Boolean),
      ),
    );

    const matchesForParty = allMatches.filter(
      (m) => checkAct(m) && checkAgent(m) && checkMap(m) && checkQueue(m),
    );
    const partySizes = new Set<number>();
    matchesForParty.forEach((m) => {
      if (m.partySize) partySizes.add(m.partySize);
    });

    return { actIds, agentMap, maps, queues, partySizes };
  }, [allMatches, effectiveActId, filters]);

  const actFilterOptions = useMemo(() => {
    const result: Array<{ id: string; label: string }> = [];
    if (
      effectiveCurrentActId &&
      availableFilterOptions.actIds.has(effectiveCurrentActId)
    ) {
      const currentActLabel =
        actOptions.find((opt) => opt.id === effectiveCurrentActId)?.label ||
        "Acto actual";
      result.push({ id: ACT_FILTER_CURRENT, label: currentActLabel });
    }
    result.push({ id: ACT_FILTER_ALL, label: "Todos los actos" });
    const filtered = actOptions.filter(
      (opt) =>
        availableFilterOptions.actIds.has(opt.id) &&
        opt.id !== effectiveCurrentActId,
    );
    result.push(...filtered);
    return result;
  }, [actOptions, availableFilterOptions.actIds, effectiveCurrentActId]);

  const agentOptions = useMemo(() => {
    return [
      { id: AGENT_FILTER_ALL, label: "Todos los agentes" },
      ...Array.from(availableFilterOptions.agentMap.entries())
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "es")),
    ];
  }, [availableFilterOptions.agentMap]);

  const mapOptions = useMemo(() => {
    return [
      { id: MAP_FILTER_ALL, label: "Todos los mapas" },
      ...availableFilterOptions.maps.map((m) => ({ id: m, label: m })),
    ];
  }, [availableFilterOptions.maps]);

  const queueOptions = useMemo(() => {
    return [
      { id: QUEUE_FILTER_ALL, label: "Todos los tipos" },
      ...availableFilterOptions.queues
        .map((q) => ({
          id: q,
          label:
            QUEUE_LABELS[q.toLowerCase()] ||
            q.charAt(0).toUpperCase() + q.slice(1),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "es")),
    ];
  }, [availableFilterOptions.queues]);

  const partySizeOptions = useMemo(() => {
    const ps = availableFilterOptions.partySizes;
    const opts: Array<{ value: PartySizeFilter; label: string }> = [
      { value: "all", label: "Todos" },
    ];
    if (ps.has(1)) opts.push({ value: "solo", label: "Solo" });
    if (ps.has(2)) opts.push({ value: "duo", label: "Dúo" });
    if (ps.has(3)) opts.push({ value: "trio", label: "Trío" });
    if ([4, 5].some((n) => ps.has(n)))
      opts.push({ value: "team", label: "Equipo (4-5)" });
    return opts;
  }, [availableFilterOptions.partySizes]);

  // ── Auto-reset stale filters ─────────────────────────────────────────
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setFilters((prev) => {
        const next = { ...prev };
        let changed = false;

        if (
          prev.actId !== ACT_FILTER_CURRENT &&
          prev.actId !== ACT_FILTER_ALL &&
          !availableFilterOptions.actIds.has(prev.actId)
        ) {
          next.actId = ACT_FILTER_CURRENT;
          changed = true;
        }
        if (
          prev.agentId !== AGENT_FILTER_ALL &&
          !availableFilterOptions.agentMap.has(prev.agentId)
        ) {
          next.agentId = AGENT_FILTER_ALL;
          changed = true;
        }
        if (
          prev.map !== MAP_FILTER_ALL &&
          !availableFilterOptions.maps.includes(prev.map)
        ) {
          next.map = MAP_FILTER_ALL;
          changed = true;
        }
        if (
          prev.queueId !== QUEUE_FILTER_ALL &&
          !availableFilterOptions.queues.includes(prev.queueId)
        ) {
          next.queueId = QUEUE_FILTER_ALL;
          changed = true;
        }
        if (prev.partySize !== "all") {
          const validSizes = PARTY_SIZE_MAP[prev.partySize] ?? [];
          if (
            !validSizes.some((s) => availableFilterOptions.partySizes.has(s))
          ) {
            next.partySize = "all";
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [availableFilterOptions]);

  // ── Filtered matches ─────────────────────────────────────────────────
  const filteredMatches = useMemo(() => {
    return allMatches.filter((match) => {
      const matchesAct = effectiveActId
        ? match.seasonId === effectiveActId
        : true;
      const matchesAgent =
        filters.agentId === AGENT_FILTER_ALL
          ? true
          : match.agentId === filters.agentId;
      const matchesMap =
        filters.map === MAP_FILTER_ALL ? true : match.map === filters.map;
      const matchesQueue =
        filters.queueId === QUEUE_FILTER_ALL
          ? true
          : match.queue === filters.queueId;
      const matchesParty =
        filters.partySize === "all"
          ? true
          : (PARTY_SIZE_MAP[filters.partySize] ?? []).includes(
              match.partySize ?? 0,
            );

      return (
        matchesAct && matchesAgent && matchesMap && matchesQueue && matchesParty
      );
    });
  }, [
    allMatches,
    effectiveActId,
    filters.agentId,
    filters.map,
    filters.queueId,
    filters.partySize,
  ]);

  const sortedFilteredMatches = useMemo(
    () =>
      [...filteredMatches].sort(
        (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0),
      ),
    [filteredMatches],
  );

  const filteredAnalyticsList = useMemo(() => {
    if (!dashboard) return [];
    const ids = new Set(filteredMatches.map((m) => m.id));
    return dashboard.analyticsList.filter((a) => ids.has(a.match_id ?? a.id));
  }, [filteredMatches, dashboard]);

  // ── Hooks that depend on filtered data ───────────────────────────────
  const {
    globalTacticalStats,
    globalRadarData,
    globalMultikillData,
    globalHeadshotData,
    globalOpeningDuelData,
    globalSurvivalData,
    globalClutchData,
    globalTradeData,
  } = useTacticalStats(filteredAnalyticsList);

  const {
    displayedRankName,
    displayedRankVisual,
    highestRankName,
    highestRankVisual,
    highestRankActLabel,
  } = useRankDisplay(
    allMatches,
    filters.actId,
    effectiveCurrentActId,
    rankNameIconMap,
    dashboard?.currentRank,
    actLabelById,
  );

  const { derivedSummary, metrics, filteredShotChart } = useDashboardStats(
    filteredMatches,
    filters.side,
  );
  const {
    derivedSummary: cohortDerivedSummary,
    metrics: cohortDerivedMetrics,
  } = useDashboardStats(filteredMatches, "all");

  // ── Additional computed values ───────────────────────────────────────
  const filteredPlaytimeMillis = useMemo(() => {
    return filteredMatches.reduce(
      (sum, match) => sum + (match.playtimeMillis ?? 0),
      0,
    );
  }, [filteredMatches]);

  const filteredWinsTotal = useMemo(() => {
    return filteredMatches.reduce(
      (sum, match) => sum + (match.result === "Victoria" ? 1 : 0),
      0,
    );
  }, [filteredMatches]);

  const filteredDrawsTotal = useMemo(() => {
    return filteredMatches.reduce(
      (sum, match) => sum + (match.result === "Empate" ? 1 : 0),
      0,
    );
  }, [filteredMatches]);

  const filteredLossesTotal = useMemo(() => {
    return filteredMatches.reduce(
      (sum, match) => sum + (match.result === "Derrota" ? 1 : 0),
      0,
    );
  }, [filteredMatches]);

  const filteredResultSummary = useMemo(
    () => ({
      wins: filteredWinsTotal,
      losses: filteredLossesTotal,
      draws: filteredDrawsTotal,
      total: filteredMatches.length,
    }),
    [filteredDrawsTotal, filteredLossesTotal, filteredMatches.length, filteredWinsTotal],
  );

  const latestFilteredAccountLevel = useMemo(() => {
    if (!filteredMatches.length) {
      return player?.accountLevel ?? 0;
    }
    const latestMatch = filteredMatches.reduce((latest, current) => {
      if ((current.timestamp ?? 0) > (latest.timestamp ?? 0)) {
        return current;
      }
      return latest;
    }, filteredMatches[0]);
    return latestMatch.accountLevel ?? player?.accountLevel ?? 0;
  }, [filteredMatches, player?.accountLevel]);

  const mostPlayedAgents = useMemo(() => {
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        matches: number;
        wins: number;
        winRate: number;
        image?: string | null;
        displayIcon?: string | null;
      }
    >();

    filteredMatches.forEach((match) => {
      if (!match.agentId) return;
      const current = grouped.get(match.agentId);
      const media = dashboard?.agentMediaMap?.[match.agentId];

      if (current) {
        current.matches += 1;
        if (match.result === "Victoria") {
          current.wins += 1;
        }
      } else {
        grouped.set(match.agentId, {
          id: match.agentId,
          name: match.agent || media?.name || "Agente",
          matches: 1,
          wins: match.result === "Victoria" ? 1 : 0,
          winRate: 0,
          image: media?.image ?? null,
          displayIcon: media?.displayIcon ?? null,
        });
      }
    });

    return Array.from(grouped.values())
      .map((agent) => ({
        ...agent,
        winRate: safeDiv(agent.wins * 100, Math.max(agent.matches, 1)),
      }))
      .sort((a, b) => b.matches - a.matches);
  }, [filteredMatches, dashboard]);

  const mostPlayedRoles = useMemo(() => {
    type RoleOverview = {
      id: string;
      name: string;
      matches: number;
      wins: number;
      winRate: number;
      image?: string | null;
      displayIcon?: string | null;
    };

    const grouped = new Map<string, RoleOverview>();

    Object.values(dashboard?.agentMediaMap ?? {}).forEach((media) => {
      const roleName = media.roleName?.trim();
      if (!roleName) return;

      const roleId = normalizeLabel(roleName);
      const roleIcon = getRoleIcon(roleName, media.roleIcon);
      const current = grouped.get(roleId);
      if (current) {
        if (!current.displayIcon && roleIcon) {
          current.image = roleIcon;
          current.displayIcon = roleIcon;
        }
        return;
      }

      grouped.set(roleId, {
        id: roleId,
        name: roleName,
        matches: 0,
        wins: 0,
        winRate: 0,
        image: roleIcon,
        displayIcon: roleIcon,
      });
    });

    filteredMatches.forEach((match) => {
      const media = match.agentId
        ? dashboard?.agentMediaMap?.[match.agentId]
        : undefined;
      const roleName = match.role?.trim() || media?.roleName?.trim();
      if (!roleName) return;

      const roleId = normalizeLabel(roleName);
      const roleIcon = getRoleIcon(roleName, media?.roleIcon);
      const current = grouped.get(roleId);
      if (current) {
        current.matches += 1;
        if (match.result === "Victoria") {
          current.wins += 1;
        }
        if (!current.displayIcon && roleIcon) {
          current.image = roleIcon;
          current.displayIcon = roleIcon;
        }
        return;
      }

      grouped.set(roleId, {
        id: roleId,
        name: roleName,
        matches: 1,
        wins: match.result === "Victoria" ? 1 : 0,
        winRate: 0,
        image: roleIcon,
        displayIcon: roleIcon,
      });
    });

    return Array.from(grouped.values())
      .map((role) => ({
        ...role,
        winRate: safeDiv(role.wins * 100, Math.max(role.matches, 1)),
      }))
      .sort((a, b) => {
        if (b.matches !== a.matches) return b.matches - a.matches;
        return b.winRate - a.winRate;
      });
  }, [filteredMatches, dashboard?.agentMediaMap]);

  const dashboardWeaponImageById = useMemo(() => {
    const map = new Map<string, string | null>();
    (dashboard?.mostPlayedWeapons ?? []).forEach((weapon) => {
      map.set(weapon.id, weapon.image ?? null);
    });
    return map;
  }, [dashboard?.mostPlayedWeapons]);

  const dashboardWeaponImageByName = useMemo(() => {
    const map = new Map<string, string | null>();
    (dashboard?.mostPlayedWeapons ?? []).forEach((weapon) => {
      map.set(normalizeLabel(weapon.name), weapon.image ?? null);
    });
    return map;
  }, [dashboard?.mostPlayedWeapons]);

  const mostPlayedWeapons = useMemo(() => {
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        kills: number;
        deaths: number;
        matches: number;
        wins: number;
        kd: number;
        winRate: number;
        image?: string | null;
      }
    >();

    filteredMatches.forEach((match) => {
      (match.weaponStats ?? []).forEach((weapon) => {
        const rounds = weapon.rounds ?? 0;
        const kills = weapon.kills ?? 0;
        const deaths = weapon.deaths ?? 0;
        const assists = weapon.assists ?? 0;
        const hasUsage =
          rounds > 0 || kills > 0 || deaths > 0 || assists > 0;
        if (!hasUsage) return;

        const key = weapon.weaponId || weapon.weaponName || "unknown";
        const name = weapon.weaponName || "Arma desconocida";
        const imageFromDashboard =
          dashboardWeaponImageById.get(key) ??
          dashboardWeaponImageByName.get(normalizeLabel(name)) ??
          null;
        const current = grouped.get(key);
        if (current) {
          current.kills += weapon.kills ?? 0;
          current.deaths += weapon.deaths ?? 0;
          current.matches += 1;
          if (match.result === "Victoria") {
            current.wins += 1;
          }
        } else {
          grouped.set(key, {
            id: key,
            name,
            kills: weapon.kills ?? 0,
            deaths: weapon.deaths ?? 0,
            matches: 1,
            wins: match.result === "Victoria" ? 1 : 0,
            kd: 0,
            winRate: 0,
            image: imageFromDashboard,
          });
        }
      });
    });

    const aggregated = Array.from(grouped.values())
      .map((weapon) => ({
        ...weapon,
        kd: safeDiv(weapon.kills, Math.max(weapon.deaths, 1)),
        winRate: safeDiv(weapon.wins * 100, Math.max(weapon.matches, 1)),
      }))
      .sort((a, b) => {
        if (b.kills !== a.kills) return b.kills - a.kills;
        return b.matches - a.matches;
      });

    if (aggregated.length > 0) {
      return aggregated;
    }

    return (dashboard?.mostPlayedWeapons ?? []).map((weapon) => ({
      id: weapon.id,
      name: weapon.name,
      kills: weapon.kills,
      deaths: 0,
      matches: weapon.matches,
      wins: 0,
      kd: safeDiv(weapon.kills, Math.max(weapon.matches, 1)),
      winRate: 0,
      image: weapon.image ?? null,
    }));
  }, [
    filteredMatches,
    dashboard?.mostPlayedWeapons,
    dashboardWeaponImageById,
    dashboardWeaponImageByName,
  ]);

  const mapPerformance = useMemo(() => {
    const grouped = new Map<
      string,
      {
        map: string;
        matches: number;
        wins: number;
        losses: number;
        winRate: number;
        image: string | null;
      }
    >();

    filteredMatches.forEach((match) => {
      const mapName = String(match.map || "").trim();
      if (!mapName || mapName === "-") return;

      const normalizedMapName = normalizeLabel(mapName);
      const current = grouped.get(mapName);
      if (current) {
        current.matches += 1;
        if (match.result === "Victoria") {
          current.wins += 1;
        } else if (match.result === "Derrota") {
          current.losses += 1;
        }
      } else {
        grouped.set(mapName, {
          map: mapName,
          matches: 1,
          wins: match.result === "Victoria" ? 1 : 0,
          losses: match.result === "Derrota" ? 1 : 0,
          winRate: 0,
          image: dashboard?.mapMediaMap?.[normalizedMapName] ?? null,
        });
      }
    });

    return Array.from(grouped.values())
      .map((entry) => ({
        ...entry,
        winRate: safeDiv(entry.wins * 100, Math.max(entry.matches, 1)),
      }))
      .sort((a, b) => {
        if (b.matches !== a.matches) return b.matches - a.matches;
        return b.winRate - a.winRate;
      });
  }, [filteredMatches, dashboard?.mapMediaMap]);

  const bestMapWinrateInsight = useMemo(() => {
    const sorted = [...mapPerformance].sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return b.matches - a.matches;
    });

    return sorted[0] ?? null;
  }, [mapPerformance]);

  const bestWeaponInsight = useMemo(() => {
    const first = mostPlayedWeapons[0];
    if (first) {
      return {
        name: first.name,
        matches: first.matches,
        kills: first.kills,
        winRate: first.winRate,
      };
    }
    return dashboard?.insights?.bestWeapon ?? null;
  }, [mostPlayedWeapons, dashboard?.insights?.bestWeapon]);

  const mostPlayedAgentInsight = mostPlayedAgents[0] ?? null;

  const advancedRoundStats = useMemo(() => {
    let tradeKillsTotal = 0;
    let damageDeltaTotal = 0;
    let damageDeltaRoundsTotal = 0;
    let roundsWithKastTotal = 0;
    let roundsForKastTotal = 0;
    let kastSum = 0;
    let kastCount = 0;
    let usedApproximateKast = false;

    filteredAnalyticsList.forEach((match) => {
      const overview = match.overview ?? {};
      tradeKillsTotal += Number(overview.trade_kills ?? 0);
      damageDeltaTotal += Number(overview.damage_delta ?? 0);

      const rounds = Number(overview.rounds ?? 0);
      if (Number.isFinite(rounds) && rounds > 0) {
        damageDeltaRoundsTotal += rounds;
      }
      const roundsWithKast = Number(overview.rounds_with_kast ?? 0);
      const hasRoundKastBreakdown = overview.rounds_with_kast != null;
      const survivalRoundsRaw = overview.survival_rounds;
      const roundsWithKillRaw = overview.rounds_with_kill;
      const roundsWithAssistRaw = overview.rounds_with_assist;

      if (hasRoundKastBreakdown && rounds > 0) {
        roundsWithKastTotal += roundsWithKast;
        roundsForKastTotal += rounds;
        return;
      }

      if (
        rounds > 0 &&
        survivalRoundsRaw != null &&
        roundsWithKillRaw != null &&
        roundsWithAssistRaw != null
      ) {
        usedApproximateKast = true;
        const survivalRounds = Number(survivalRoundsRaw);
        const roundsWithKill = Number(roundsWithKillRaw);
        const roundsWithAssist = Number(roundsWithAssistRaw);

        if (
          Number.isFinite(survivalRounds) &&
          Number.isFinite(roundsWithKill) &&
          Number.isFinite(roundsWithAssist)
        ) {
          // Approximate OR(survive, kill, assist) when exact rounds_with_kast is absent.
          const pSurvival = clampNumber(safeDiv(survivalRounds, rounds), 0, 1);
          const pKill = clampNumber(safeDiv(roundsWithKill, rounds), 0, 1);
          const pAssist = clampNumber(safeDiv(roundsWithAssist, rounds), 0, 1);
          const estimatedKasRounds =
            (1 - (1 - pSurvival) * (1 - pKill) * (1 - pAssist)) * rounds;

          roundsWithKastTotal += estimatedKasRounds;
          roundsForKastTotal += rounds;
          return;
        }
      }

      const rawKast =
        overview.kast ??
        overview.kast_pct ??
        overview.kill_assist_survive_trade_pct;
      if (typeof rawKast === "number" && Number.isFinite(rawKast)) {
        usedApproximateKast = true;
        kastSum += rawKast <= 1 ? rawKast * 100 : rawKast;
        kastCount += 1;
      }
    });

    const kastFromRounds =
      roundsForKastTotal > 0
        ? safeDiv(roundsWithKastTotal * 100, roundsForKastTotal)
        : null;

    const kastFromRaw =
      kastCount > 0 ? safeDiv(kastSum, Math.max(kastCount, 1)) : 0;

    const kastPct = clampNumber(kastFromRounds ?? kastFromRaw, 0, 100);

    return {
      tradeKillsTotal,
      damageDeltaPerRound: safeDiv(damageDeltaTotal, damageDeltaRoundsTotal),
      kastPct,
      hasKastData: roundsForKastTotal > 0 || kastCount > 0,
      kastIsApproximate: usedApproximateKast,
    };
  }, [filteredAnalyticsList]);

  const cohortLabels = rankComparison?.cohortLabels ?? [];
  const cohortReferenceLabel =
    cohortLabels.length > 0 ? cohortLabels.join(" / ") : "Sin cohorte";
  const cohortSampleSize = rankComparison?.sampleSize ?? 0;
  const cohortNotes = rankComparison?.notes ?? [];
  const cohortBaseRankName = rankComparison?.baseRankName ?? "Sin rango";

  const profilePerformanceMetrics = useMemo<ProfilePerformanceMetric[]>(() => {
    const playerValues = {
      kd: cohortDerivedMetrics.globalKd,
      k: cohortDerivedSummary.kills,
      d: cohortDerivedSummary.deaths,
      a: cohortDerivedSummary.assists,
      kda: cohortDerivedMetrics.kdaOverall,
      acs: cohortDerivedMetrics.globalAcs,
      hsPct: cohortDerivedMetrics.globalHeadshotPct,
      kast: advancedRoundStats.kastPct,
      incDamage: advancedRoundStats.damageDeltaPerRound,
      wr: cohortDerivedMetrics.globalWinRate,
      wins: filteredWinsTotal,
      losses: filteredLossesTotal,
    };

    const orderedMetrics: Array<{
      key: RankComparisonMetricKey;
      source: keyof typeof playerValues;
      label: string;
      isPercent: boolean;
      decimals: number;
      description: string;
    }> = [
      {
        key: "kd",
        source: "kd",
        label: "KD",
        isPercent: false,
        decimals: 2,
        description:
          "KD: relacion bajas/muertes del jugador frente a jugadores cuya ultima partida valida dentro de los filtros del cohorte cae en el mismo rango, uno por encima o uno por debajo.",
      },
      {
        key: "k",
        source: "k",
        label: "K",
        isPercent: false,
        decimals: 0,
        description:
          "K: kills totales del jugador dentro de los filtros del cohorte, comparadas por posicion relativa dentro de la cohorte.",
      },
      {
        key: "d",
        source: "d",
        label: "D",
        isPercent: false,
        decimals: 0,
        description:
          "D: muertes totales dentro de los filtros del cohorte. Menos muertes implican mejor posicion relativa.",
      },
      {
        key: "a",
        source: "a",
        label: "A",
        isPercent: false,
        decimals: 0,
        description:
          "A: asistencias totales del jugador dentro de los filtros del cohorte, comparadas por posicion relativa dentro de la cohorte.",
      },
      {
        key: "kda",
        source: "kda",
        label: "KDA",
        isPercent: false,
        decimals: 2,
        description:
          "KDA: (kills + asistencias) / muertes del jugador frente a la cohorte calculada con los mismos filtros.",
      },
      {
        key: "acs",
        source: "acs",
        label: "ACS",
        isPercent: false,
        decimals: 1,
        description:
          "ACS: impacto medio por ronda del jugador en las partidas del cohorte, comparado por posicion relativa dentro de la cohorte.",
      },
      {
        key: "hsPct",
        source: "hsPct",
        label: "HS%",
        isPercent: true,
        decimals: 1,
        description:
          "HS%: porcentaje de impactos en cabeza del jugador dentro de los filtros del cohorte, comparado con la cohorte filtrada.",
      },
      {
        key: "kast",
        source: "kast",
        label: "KAST",
        isPercent: true,
        decimals: 1,
        description:
          "KAST: porcentaje de rondas donde sobrevives, matas o asistes. Se calcula con las partidas del cohorte y el mismo fallback que usa backend.",
      },
      {
        key: "incDamage",
        source: "incDamage",
        label: "▲Inc.Dano/R",
        isPercent: false,
        decimals: 1,
        description:
          "▲Inc.Dano/R: incremento medio de dano por ronda (dano infligido - dano recibido) dentro de los filtros del cohorte, comparado con la cohorte.",
      },
      {
        key: "wr",
        source: "wr",
        label: "WR",
        isPercent: true,
        decimals: 1,
        description:
          "WR: winrate del jugador en las partidas del cohorte, comparado por posicion relativa dentro de la cohorte.",
      },
      {
        key: "wins",
        source: "wins",
        label: "Wins",
        isPercent: false,
        decimals: 0,
        description:
          "Wins: victorias totales del jugador dentro de los filtros del cohorte, comparadas por ranking relativo dentro de la cohorte.",
      },
      {
        key: "losses",
        source: "losses",
        label: "Loses",
        isPercent: false,
        decimals: 0,
        description:
          "Loses: partidas no ganadas dentro de los filtros del cohorte. Menos derrotas implican mejor posicion relativa.",
      },
    ];

    return orderedMetrics.map((metric) => {
      const value = playerValues[metric.source] ?? 0;
      const comparison = rankComparison?.metricComparisons?.[metric.key];
      const comparisonSampleSize = Number(comparison?.sampleSize ?? 0);
      const fillPercent = clampNumber(
        Number(comparison?.percentile ?? 50),
        0,
        100,
      );
      const isNeutral = Boolean(
        comparison?.isNeutral ?? comparisonSampleSize < 2,
      );

      const sampleDetails =
        comparisonSampleSize > 0
          ? comparisonSampleSize < cohortSampleSize
            ? ` Muestras validas para esta metrica: ${comparisonSampleSize} de ${cohortSampleSize} jugadores de la cohorte.`
            : ` Muestras validas para esta metrica: ${comparisonSampleSize} jugadores.`
          : " Sin muestra valida para esta metrica; la barra se muestra en 50% neutral.";
      const rankingMethodDetails =
        comparison?.rankingMethod === "bayesian_shrinkage"
          ? ` La estadistica visible es real. Para el ranking se aplica Bayesian shrinkage (muestra=${Number(comparison?.metricSampleSize ?? 0).toFixed(0)}, media cohorte=${Number(comparison?.cohortMean ?? 0).toFixed(metric.decimals)}, prior=${Number(comparison?.priorWeight ?? 0).toFixed(0)}).`
          : "";

      const neutralDetails =
        isNeutral && comparisonSampleSize > 0
          ? " La comparacion queda en 50% neutral porque no hay suficiente muestra competitiva para ordenar esta metrica con estabilidad."
          : "";

      return {
        key: metric.key,
        label: metric.label,
        value,
        fillPercent,
        isPercent: metric.isPercent,
        decimals: metric.decimals,
        tooltip: `${metric.description}${sampleDetails}${rankingMethodDetails}${neutralDetails}`,
        comparisonSampleSize,
        isNeutral,
      };
    });
  }, [
    cohortDerivedMetrics,
    cohortDerivedSummary.kills,
    cohortDerivedSummary.deaths,
    cohortDerivedSummary.assists,
    advancedRoundStats.kastPct,
    advancedRoundStats.damageDeltaPerRound,
    rankComparison,
    cohortSampleSize,
    filteredWinsTotal,
    filteredLossesTotal,
  ]);

  const roundImpactSummary = useMemo<RoundImpactSummary>(() => {
    const sideFilter =
      filters.side === "attack" || filters.side === "defense"
        ? filters.side
        : null;

    let totalRounds = 0;
    let attackRounds = 0;
    let defenseRounds = 0;
    let roundsWithKill = 0;
    let roundsWithDeath = 0;
    let roundsWithAssist = 0;
    let roundsWithDirectParticipation = 0;
    let roundsWithoutDirectParticipation = 0;
    let firstBloods = 0;
    let aces = 0;
    let plants = 0;
    let defuses = 0;
    let plantOpportunities = 0;
    let defuseOpportunities = 0;
    let distributionOnlyKills = 0;
    let distributionOnlyAssists = 0;
    let distributionOnlyDeaths = 0;
    let distributionKillAssist = 0;
    let distributionKillDeath = 0;
    let distributionAssistDeath = 0;
    let distributionKillAssistDeath = 0;
    let distributionNone = 0;
    let distributionCombinedOrNone = 0;

    filteredAnalyticsList.forEach((match) => {
      const overview = match.overview ?? {};
      const overviewRounds = toNonNegativeInt(overview.rounds);
      if (overviewRounds <= 0) return;

      const attackFromSides = toNonNegativeInt(match.sides?.attack?.rounds);
      const defenseFromSides = toNonNegativeInt(match.sides?.defense?.rounds);

      const selectedSideStats = sideFilter ? match.sides?.[sideFilter] : null;
      const selectedSideRounds = toNonNegativeInt(selectedSideStats?.rounds);
      const useSideBreakdown =
        selectedSideStats != null && selectedSideRounds > 0;
      const rounds = useSideBreakdown ? selectedSideRounds : overviewRounds;

      const readRoundMetric = (
        sideValue: unknown,
        overviewValue: unknown,
      ): number => {
        if (!useSideBreakdown) {
          return clampRoundCount(overviewValue, rounds);
        }

        if (sideValue != null) {
          return clampRoundCount(sideValue, rounds);
        }

        return scaleRoundCountToSide(overviewValue, overviewRounds, rounds);
      };

      const readSideOrScaledCounter = (
        sideValue: unknown,
        overviewValue: unknown,
      ): number => {
        if (!useSideBreakdown) {
          return clampRoundCount(overviewValue, rounds);
        }

        if (sideValue != null) {
          return clampRoundCount(sideValue, rounds);
        }

        return scaleRoundCountToSide(overviewValue, overviewRounds, rounds);
      };

      const matchRoundsWithKill = readRoundMetric(
        selectedSideStats?.rounds_with_kill,
        overview.rounds_with_kill,
      );
      const matchRoundsWithAssist = readRoundMetric(
        selectedSideStats?.rounds_with_assist,
        overview.rounds_with_assist,
      );
      const matchRoundsWithDeath = readRoundMetric(
        selectedSideStats?.rounds_with_death,
        overview.rounds_with_death ?? overview.deaths,
      );

      const matchRoundsWithDirectParticipation = readRoundMetric(
        selectedSideStats?.rounds_with_direct_participation,
        overview.rounds_with_direct_participation ??
          Math.max(matchRoundsWithKill, matchRoundsWithAssist),
      );

      let matchRoundsWithoutDirectParticipation = readRoundMetric(
        selectedSideStats?.rounds_without_direct_participation,
        overview.rounds_without_direct_participation ??
          rounds - matchRoundsWithDirectParticipation,
      );

      if (
        matchRoundsWithDirectParticipation +
          matchRoundsWithoutDirectParticipation !==
        rounds
      ) {
        matchRoundsWithoutDirectParticipation = Math.max(
          0,
          rounds - matchRoundsWithDirectParticipation,
        );
      }

      const onlyKills = readRoundMetric(
        selectedSideStats?.rounds_only_kill,
        overview.rounds_only_kill,
      );
      let remaining = Math.max(0, rounds - onlyKills);

      const onlyAssists = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_only_assist,
          overview.rounds_only_assist,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - onlyAssists);

      const onlyDeaths = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_only_death,
          overview.rounds_only_death,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - onlyDeaths);

      const killAssist = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_kill_assist,
          overview.rounds_kill_assist,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - killAssist);

      const killDeath = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_kill_death,
          overview.rounds_kill_death,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - killDeath);

      const assistDeath = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_assist_death,
          overview.rounds_assist_death,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - assistDeath);

      const killAssistDeath = Math.min(
        readRoundMetric(
          selectedSideStats?.rounds_kill_assist_death,
          overview.rounds_kill_assist_death,
        ),
        remaining,
      );
      remaining = Math.max(0, remaining - killAssistDeath);

      let none = Math.min(
        readRoundMetric(selectedSideStats?.rounds_none, overview.rounds_none),
        remaining,
      );

      if (
        killAssist === 0 &&
        killDeath === 0 &&
        assistDeath === 0 &&
        killAssistDeath === 0 &&
        none === 0
      ) {
        none = Math.min(
          readRoundMetric(
            selectedSideStats?.rounds_combined_or_none,
            overview.rounds_combined_or_none,
          ),
          remaining,
        );
      }

      const coveredCategories =
        onlyKills +
        onlyAssists +
        onlyDeaths +
        killAssist +
        killDeath +
        assistDeath +
        killAssistDeath +
        none;

      if (coveredCategories < rounds) {
        none += rounds - coveredCategories;
      }

      const combinedOrNone =
        killAssist + killDeath + assistDeath + killAssistDeath + none;

      totalRounds += rounds;
      attackRounds += attackFromSides;
      defenseRounds += defenseFromSides;
      roundsWithKill += matchRoundsWithKill;
      roundsWithDeath += matchRoundsWithDeath;
      roundsWithAssist += matchRoundsWithAssist;
      roundsWithDirectParticipation += matchRoundsWithDirectParticipation;
      roundsWithoutDirectParticipation += matchRoundsWithoutDirectParticipation;
      firstBloods += readSideOrScaledCounter(
        selectedSideStats?.first_kills,
        overview.first_kills,
      );
      aces += readSideOrScaledCounter(
        selectedSideStats?.multi_5k,
        overview.multi_5k,
      );

      const matchPlantOpportunities = toNonNegativeInt(
        overview.plant_opportunities,
      );
      const matchDefuseOpportunities = toNonNegativeInt(
        overview.defuse_opportunities,
      );

      // Keep plants/defuses global so this block does not change with side filter.
      plants += toNonNegativeInt(overview.plants);
      defuses += toNonNegativeInt(overview.defuses);
      plantOpportunities +=
        matchPlantOpportunities > 0 ? matchPlantOpportunities : attackFromSides;
      defuseOpportunities +=
        matchDefuseOpportunities > 0 ? matchDefuseOpportunities : defenseFromSides;
      distributionOnlyKills += onlyKills;
      distributionOnlyAssists += onlyAssists;
      distributionOnlyDeaths += onlyDeaths;
      distributionKillAssist += killAssist;
      distributionKillDeath += killDeath;
      distributionAssistDeath += assistDeath;
      distributionKillAssistDeath += killAssistDeath;
      distributionNone += none;
      distributionCombinedOrNone += combinedOrNone;
    });

    return {
      totalRounds,
      attackRounds,
      defenseRounds,
      roundsWithKill,
      roundsWithDeath,
      roundsWithAssist,
      roundsWithDirectParticipation,
      roundsWithoutDirectParticipation,
      roundsWithKillPct: safeDiv(roundsWithKill * 100, totalRounds),
      roundsWithDeathPct: safeDiv(roundsWithDeath * 100, totalRounds),
      roundsWithAssistPct: safeDiv(roundsWithAssist * 100, totalRounds),
      directParticipationPct: safeDiv(
        roundsWithDirectParticipation * 100,
        totalRounds,
      ),
      noDirectParticipationPct: safeDiv(
        roundsWithoutDirectParticipation * 100,
        totalRounds,
      ),
      firstBloods,
      aces,
      plants,
      defuses,
      plantOpportunities,
      defuseOpportunities,
      plantsPerOpportunityPct: safeDiv(plants * 100, plantOpportunities),
      defusesPerOpportunityPct: safeDiv(defuses * 100, defuseOpportunities),
      distributionOnlyKills,
      distributionOnlyAssists,
      distributionOnlyDeaths,
      distributionKillAssist,
      distributionKillDeath,
      distributionAssistDeath,
      distributionKillAssistDeath,
      distributionNone,
      distributionCombinedOrNone,
      distributionOnlyKillsPct: safeDiv(
        distributionOnlyKills * 100,
        totalRounds,
      ),
      distributionOnlyAssistsPct: safeDiv(
        distributionOnlyAssists * 100,
        totalRounds,
      ),
      distributionOnlyDeathsPct: safeDiv(
        distributionOnlyDeaths * 100,
        totalRounds,
      ),
      distributionKillAssistPct: safeDiv(
        distributionKillAssist * 100,
        totalRounds,
      ),
      distributionKillDeathPct: safeDiv(
        distributionKillDeath * 100,
        totalRounds,
      ),
      distributionAssistDeathPct: safeDiv(
        distributionAssistDeath * 100,
        totalRounds,
      ),
      distributionKillAssistDeathPct: safeDiv(
        distributionKillAssistDeath * 100,
        totalRounds,
      ),
      distributionNonePct: safeDiv(distributionNone * 100, totalRounds),
      distributionCombinedOrNonePct: safeDiv(
        distributionCombinedOrNone * 100,
        totalRounds,
      ),
    };
  }, [filteredAnalyticsList, filters.side]);

  const visibleHistoryMatches = useMemo(
    () => sortedFilteredMatches.slice(0, historyVisibleCount),
    [sortedFilteredMatches, historyVisibleCount],
  );

  const canLoadMoreHistory = historyVisibleCount < sortedFilteredMatches.length;
  const canCollapseHistory = historyVisibleCount > MATCHES_PER_PAGE;

  // ── Floating tooltip helpers ─────────────────────────────────────────
  const isHoveringInfoIcon = useCallback((target: EventTarget | null) => {
    return (
      target instanceof Element &&
      Boolean(target.closest(INFO_ICON_TRIGGER_SELECTOR))
    );
  }, []);

  const showFloatingTooltip = useCallback((
    e: { clientX: number; clientY: number; currentTarget?: EventTarget | null },
    content: string,
  ) => {
    if (!content?.trim()) {
      setFloatingTooltip(null);
      return;
    }

    const clientX = e.clientX ?? 0;
    const clientY = e.clientY ?? 0;
    const currentTarget = e.currentTarget ?? null;
    const anchorRect = getAnchorRect(currentTarget, clientX, clientY);
    const hostRect = getHostRect(currentTarget);

    const estimatedSize = estimateFloatingInfoTooltipSize(
      content,
      INFO_TOOLTIP_ESTIMATED_MAX_WIDTH,
    );
    const position = resolveInfoTooltipPosition(anchorRect, hostRect, estimatedSize);

    setFloatingTooltip({
      visible: true,
      x: position.x,
      y: position.y,
      content,
      placement: position.placement,
      anchorRect,
      hostRect,
    });
  }, []);

  const updateFloatingTooltipLayout = useCallback(
    (tooltipWidth: number, tooltipHeight: number) => {
      if (!Number.isFinite(tooltipWidth) || !Number.isFinite(tooltipHeight)) {
        return;
      }

      const size: TooltipSize = {
        width: Math.max(1, tooltipWidth),
        height: Math.max(1, tooltipHeight),
      };

      setFloatingTooltip((previous) => {
        if (!previous) return previous;

        const position = resolveInfoTooltipPosition(
          previous.anchorRect,
          previous.hostRect,
          size,
        );

        if (
          Math.abs(previous.x - position.x) < 0.5 &&
          Math.abs(previous.y - position.y) < 0.5 &&
          previous.placement === position.placement
        ) {
          return previous;
        }

        return {
          ...previous,
          x: position.x,
          y: position.y,
          placement: position.placement,
        };
      });
    },
    [],
  );

  const moveFloatingTooltip = () => undefined;

  const hideFloatingTooltip = useCallback(() => setFloatingTooltip(null), []);

  const getFloatingInfoHoverHandlers = useCallback(
    (content: string) => ({
      onPointerEnter: (e: React.PointerEvent<HTMLElement | SVGElement>) =>
        showFloatingTooltip(e, content),
      onPointerLeave: () => hideFloatingTooltip(),
    }),
    [hideFloatingTooltip, showFloatingTooltip],
  );

  // ── Dismiss tooltip on outside interactions ──────────────────────────
  useEffect(() => {
    if (!floatingTooltip) return;

    const handlePointerDown = () => setFloatingTooltip(null);
    const handlePointerMove = (e: PointerEvent) => {
      if (!isHoveringInfoIcon(e.target)) {
        setFloatingTooltip(null);
      }
    };
    const handleScroll = () => setFloatingTooltip(null);
    const handleResize = () => setFloatingTooltip(null);
    const handleWindowBlur = () => setFloatingTooltip(null);

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [floatingTooltip, isHoveringInfoIcon]);

  // ── Scroll reveal ────────────────────────────────────────────────────
  useScrollReveal([playerId, filteredMatches.length, historyExpanded]);

  // ── Return ───────────────────────────────────────────────────────────
  return {
    // loading / data
    loading,
    rankComparisonInitialLoading: rankComparisonLoading,
    rankComparisonLoading: rankComparisonLoading || rankComparisonFetching,
    dashboard,
    player,

    // filters
    filters,
    setFilters,
    filtersOpen,
    setFiltersOpen,

    // filter option lists
    actFilterOptions,
    agentOptions,
    mapOptions,
    queueOptions,
    partySizeOptions,
    availableFilterOptions,
    actOptions,

    // act resolution
    effectiveActId,
    effectiveCurrentActId,

    // modal / selection state
    selectedMatchId,
    setSelectedMatchId,
    selectedAgentId,
    setSelectedAgentId,
    selectedWeaponId,
    setSelectedWeaponId,
    heatmapOpen,
    setHeatmapOpen,
    historyModalOpen,
    setHistoryModalOpen,
    agentsModalOpen,
    setAgentsModalOpen,
    weaponsModalOpen,
    setWeaponsModalOpen,

    // history pagination
    historyVisibleCount,
    setHistoryVisibleCount,
    historyExpanded,
    setHistoryExpanded,
    visibleHistoryMatches,
    canLoadMoreHistory,
    canCollapseHistory,

    // match lists
    allMatches,
    filteredMatches,
    sortedFilteredMatches,
    filteredAnalyticsList,

    // tactical stats
    globalTacticalStats,
    globalRadarData,
    globalMultikillData,
    globalHeadshotData,
    globalOpeningDuelData,
    globalSurvivalData,
    globalClutchData,
    globalTradeData,

    // rank display
    displayedRankName,
    displayedRankVisual,
    highestRankName,
    highestRankVisual,
    highestRankActLabel,
    rankNameIconMap,

    // dashboard stats
    derivedSummary,
    metrics,
    filteredShotChart,

    // extra computed values
    filteredPlaytimeMillis,
    filteredResultSummary,
    latestFilteredAccountLevel,
    mostPlayedAgents,
    mostPlayedRoles,
    mostPlayedWeapons,
    mapPerformance,
    bestMapWinrateInsight,
    bestWeaponInsight,
    mostPlayedAgentInsight,
    profilePerformanceMetrics,
    roundImpactSummary,
    cohortBaseRankName,
    cohortReferenceLabel,
    cohortSampleSize,
    cohortNotes,
    hasKastData: advancedRoundStats.hasKastData,
    kastIsApproximate: advancedRoundStats.kastIsApproximate,

    // floating tooltip
    floatingTooltip,
    setFloatingTooltip,
    showFloatingTooltip,
    updateFloatingTooltipLayout,
    moveFloatingTooltip,
    hideFloatingTooltip,
    getFloatingInfoHoverHandlers,
    isHoveringInfoIcon,
  };
}

// ── Exported type for the return value ─────────────────────────────────
export type EstadisticasViewModel = ReturnType<typeof useEstadisticasViewModel>;
