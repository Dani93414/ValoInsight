import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  BarChart,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Info } from "lucide-react";
import type { HeatmapEntryFilters } from "../../components/modals/HeatmapModal";
import BackButton from "../../components/BackButton";
import LoadingModal from "../../components/ui/LoadingModal";
import PageLoadingScreen from "../../components/ui/PageLoadingScreen";
import {
  useEstadisticasViewModel,
  MATCHES_PER_PAGE,
  HISTORY_LOAD_STEP,
} from "./useEstadisticasViewModel";
import { useDashboardStats } from "../../hooks/useDashboardStats";
import "../Estadisticas.scss";

import type {
  HeaderVisualCard,
  MatchCard,
  SideFilter,
  PartySizeFilter,
} from "../../types/dashboard";
import {
  formatNumber,
  formatPercent,
  formatHours,
  normalizeLabel,
} from "../../utils/formatters";
import {
  RECHARTS_TOOLTIP_CLAMP_VIEWBOX,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "../../utils/tooltipPositioning";
import {
  applyUnrankedRankIconFallback,
  normalizeCompetitiveTierIconPath,
  UNRANKED_RANK_ICON_FALLBACK,
} from "../../utils/rankUtils";
import {
  ACT_FILTER_CURRENT,
  AGENT_FILTER_ALL,
  MAP_FILTER_ALL,
  QUEUE_FILTER_COMPETITIVE,
  getHeaderAgentImageAdjustmentByDisplayName,
  buildSvgPlaceholder,
  getHeaderCardKind,
} from "../../constants/dashboard";

const MatchDetailModal = React.lazy(
  () => import("../../components/modals/MatchDetailModal"),
);
const AgentDetailModal = React.lazy(
  () => import("../../components/modals/AgentDetailModal"),
);
const WeaponDetailModal = React.lazy(
  () => import("../../components/modals/WeaponDetailModal"),
);
const MapDetailModal = React.lazy(
  () => import("../../components/modals/MapDetailModal"),
);
const HeatmapModal = React.lazy(
  () => import("../../components/modals/HeatmapModal"),
);

// --- Resolve helpers (use normalizeLabel from utils) ---

function resolveMapImage(
  mapName?: string,
  mapMediaMap?: Record<string, string>,
) {
  const normalizedMapName = normalizeLabel(mapName);
  if (normalizedMapName && mapMediaMap?.[normalizedMapName]) {
    return mapMediaMap[normalizedMapName];
  }

  return buildSvgPlaceholder(
    mapName || "Mapa desconocido",
    "Mapa destacado",
    "#ff7a85",
  );
}

function resolveWeaponImage(weaponName?: string) {
  return buildSvgPlaceholder(
    weaponName || "Arma desconocida",
    "Arma con mas kills",
    "#ff4655",
  );
}

function getProfilePerformanceFillColor(percent: number) {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const hue = (clampedPercent / 100) * 120;
  const baseColor = `hsl(${hue} 72% 48%)`;
  const accentColor = `hsl(${Math.min(hue + 10, 130)} 78% 56%)`;

  return `linear-gradient(90deg, ${baseColor} 0%, ${accentColor} 100%)`;
}

function getProfilePerformanceMetricFillColor(metricKey: string, percent: number) {
  if (metricKey === "d" || metricKey === "losses") {
    return "linear-gradient(90deg, hsl(355 76% 49%) 0%, hsl(8 82% 58%) 100%)";
  }
  return getProfilePerformanceFillColor(percent);
}

const TACTICAL_TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  background: "rgba(20,22,28,0.95)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "10px",
  fontSize: "0.82rem",
};

const TACTICAL_TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: "#ffffff",
  fontWeight: 700,
};

const TACTICAL_TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: "#ffffff",
  fontWeight: 600,
};

const TACTICAL_TOOLTIP_CURSOR = {
  fill: "rgba(255, 70, 85, 0.14)",
};

const CHART_TOOLTIP_WRAPPER_STYLE: React.CSSProperties = {
  ...RECHARTS_TOOLTIP_WRAPPER_STYLE,
};

const CHART_TOOLTIP_ESCAPE = RECHARTS_TOOLTIP_CLAMP_VIEWBOX;

type MatchHistoryCardProps = {
  match: MatchCard;
  agentMediaMap?: Record<
    string,
    { image?: string | null; displayIcon?: string | null }
  >;
  rankIconUrl?: string | null;
  onClick: () => void;
};

type TacticalPanelTab =
  | "Headshot"
  | "Multikills"
  | "Duelos iniciales"
  | "Supervivencia"
  | "Clutches"
  | "Trade Kills";

type RoundImpactChartMode = "participation" | "distribution";

type MetricInfoProps = {
  content: string;
  className?: string;
  getHoverHandlers: (content: string) => {
    onPointerEnter?: React.PointerEventHandler<HTMLButtonElement>;
    onPointerLeave?: React.PointerEventHandler<HTMLButtonElement>;
  };
};

const TACTICAL_PANEL_TABS: TacticalPanelTab[] = [
  "Headshot",
  "Multikills",
  "Duelos iniciales",
  "Supervivencia",
  "Clutches",
  "Trade Kills",
];

const COLLAPSED_HISTORY_MATCHES = 3;

function MatchHistoryCard({
  match,
  agentMediaMap,
  rankIconUrl,
  onClick,
}: MatchHistoryCardProps) {
  const resultVariant =
    match.result === "Victoria"
      ? "win"
      : match.result === "Empate"
        ? "draw"
        : "loss";

  const agentIcon = match.agentId
    ? (agentMediaMap?.[match.agentId]?.displayIcon ?? "")
    : "";

  return (
    <button
      type="button"
      className={`match-card match-card-button match-card--${resultVariant}`}
      onClick={onClick}
    >
      <div className="match-card-top">
        <div className="match-card-left">
          <div className="match-card-mainline">
            {agentIcon && (
              <img
                className="match-agent-icon"
                src={agentIcon}
                alt={match.agent}
                loading="lazy"
              />
            )}
            <div className="match-card-left-content">
              <h3 className="match-map">{match.map}</h3>
              <p className="match-date">{match.dateLabel}</p>
            </div>
          </div>
        </div>

        <div className={`match-result ${resultVariant}`}>
          <span className="match-result-text">{match.result}</span>
          <span className="match-result-score">
            {match.roundScore.replace(/-/g, " - ")}
          </span>
        </div>

        <div className="match-card-right">
          {rankIconUrl && (
            <img
              src={rankIconUrl}
              alt="Rango actual"
              className="match-rank-icon"
              loading="lazy"
            />
          )}
          <span className={`match-mode-badge ${match.ranked ? "ranked" : ""}`}>
            {match.ranked ? "Competitivo" : "Normal"}
          </span>
        </div>
      </div>

      <div className="match-stats-grid">
        <div className="match-stat">
          <span>K / D / A</span>
          <strong>
            {match.kills} / {match.deaths} / {match.assists}
          </strong>
        </div>
        <div className="match-stat">
          <span>KD</span>
          <strong>{formatNumber(match.kd, 2)}</strong>
        </div>
        <div className="match-stat">
          <span>ACS</span>
          <strong>{formatNumber(match.acs, 1)}</strong>
        </div>
        <div className="match-stat">
          <span>ADR</span>
          <strong>{formatNumber(match.adr, 1)}</strong>
        </div>
        <div className="match-stat">
          <span>HS%</span>
          <strong>{formatPercent(match.hs, 1)}</strong>
        </div>
        <div className="match-stat">
          <span>Rondas</span>
          <strong>{formatNumber(match.rounds)}</strong>
        </div>
      </div>
    </button>
  );
}

function HeaderShowcaseCard(props: HeaderVisualCard) {
  const { title, subtitle, image, valueLabel } = props;
  const kind = getHeaderCardKind(subtitle);
  const resolvedImage = image || buildSvgPlaceholder(title, subtitle);

  if (kind === "agent") {
    const adj = getHeaderAgentImageAdjustmentByDisplayName(title);
    const figureStyle: React.CSSProperties = {
      ["--agent-obj-x" as string]: `${adj.objX}%`,
      ["--agent-scale" as string]: adj.scale,
      ["--agent-shift-y" as string]: `${adj.shiftY}%`,
      ["--agent-flip" as string]: adj.flip ? -1 : 1,
      ["--agent-fade-start" as string]: `${adj.fadeStart}%`,
      ["--agent-fade-mid" as string]: `${adj.fadeMid}%`,
      ["--agent-fade-end" as string]: `${adj.fadeEnd}%`,
    };

    return (
      <article className="header-showcase-agent-stage" data-kind={kind}>
        <div className="header-showcase-agent-media">
          <img
            src={resolvedImage}
            alt={title}
            className="header-showcase-agent-figure"
            style={figureStyle}
          />
        </div>
      </article>
    );
  }

  const cardClassName = [
    "header-showcase-card",
    "header-showcase-card-vertical",
    kind === "map" ? "header-showcase-card-map" : "",
    kind === "weapon" ? "header-showcase-card-weapon" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const imageClassName = [
    "header-showcase-image",
    kind === "weapon" ? "header-showcase-image-weapon" : "",
    kind === "map" ? "header-showcase-image-map" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const overlayClassName = [
    "header-showcase-overlay",
    kind === "map" ? "header-showcase-overlay-map" : "",
    kind === "weapon" ? "header-showcase-overlay-weapon" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Render map cards via <img> to avoid background-image refresh issues.
  if (kind === "map") {
    return (
      <article className={cardClassName} data-kind={kind}>
        <div className="header-showcase-media">
          <img src={resolvedImage} alt={title} className={imageClassName} />
          <div className={overlayClassName} />
        </div>

        <div className="header-showcase-copy">
          <span className="header-showcase-subtitle">{subtitle}</span>
          <div className="header-showcase-title-row">
            <strong className="header-showcase-title">{title}</strong>
            {valueLabel ? (
              <span className="header-showcase-value">{valueLabel}</span>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={cardClassName} data-kind={kind}>
      <div className="header-showcase-media">
        <img src={resolvedImage} alt={title} className={imageClassName} />
        <div className={overlayClassName} />
      </div>

      <div className="header-showcase-copy">
        <span className="header-showcase-subtitle">{subtitle}</span>
        <div className="header-showcase-title-row">
          <strong className="header-showcase-title">{title}</strong>
          {valueLabel ? (
            <span className="header-showcase-value">{valueLabel}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function MetricInfo({ content, className, getHoverHandlers }: MetricInfoProps) {
  return (
    <button
      type="button"
      className={`metric-info-button${className ? ` ${className}` : ""}`}
      {...getHoverHandlers(content)}
      aria-label={`Informacion: ${content}`}
    >
      <Info size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export default function Estadisticas() {
  const { playerId } = useParams();
  const navigate = useNavigate();

  const {
    loading,
    rankComparisonInitialLoading,
    rankComparisonLoading,
    dashboard,
    player,
    filters,
    setFilters,
    filtersOpen,
    setFiltersOpen,
    actFilterOptions,
    agentOptions,
    mapOptions,
    queueOptions,
    partySizeOptions,
    effectiveActId,
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
    setHistoryVisibleCount,
    historyExpanded,
    setHistoryExpanded,
    visibleHistoryMatches,
    canLoadMoreHistory,
    canCollapseHistory,
    filteredMatches,
    sortedFilteredMatches,
    filteredAnalyticsList,
    globalTacticalStats,
    globalRadarData,
    globalMultikillData,
    globalHeadshotData,
    globalOpeningDuelData,
    globalSurvivalData,
    globalClutchData,
    displayedRankName,
    displayedRankVisual,
    highestRankName,
    highestRankVisual,
    highestRankActLabel,
    derivedSummary,
    metrics,
    filteredShotChart,
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
    hasKastData,
    kastIsApproximate,
    floatingTooltip,
    updateFloatingTooltipLayout,
    getFloatingInfoHoverHandlers,
  } = useEstadisticasViewModel(playerId);
  const [shotChartRange, setShotChartRange] = React.useState<
    "total" | "recent20"
  >("total");
  const recentShotMatches = React.useMemo(
    () => sortedFilteredMatches.slice(0, 20),
    [sortedFilteredMatches],
  );
  const { filteredShotChart: recentShotChart } = useDashboardStats(
    recentShotMatches,
    filters.side,
  );
  const activeShotChart =
    shotChartRange === "total" ? filteredShotChart : recentShotChart;

  const floatingTooltipRef = React.useRef<HTMLDivElement | null>(null);

  const TACTICAL_HELP: Record<string, string> = {
    "Duelos iniciales":
      "Duelos iniciales: De los primeros duelos en los que participas, porcentaje de los que ganas. Ganado si consigues la primera baja del enfrentamiento; perdido si caes en ese primer duelo.",
    Clutches:
      "Clutches: De todas las situaciones en las que quedas como último jugador vivo de tu equipo, porcentaje de rondas que terminas ganando.",
    "Trade Kills":
      "Trade Kills: En el perfil tactico se representa tu porcentaje de conversion sobre oportunidades reales de trade. En el panel tactico ves ademas el detalle de trades crudos, oportunidades reales y oportunidades perdidas.",
    Supervivencia: "Supervivencia: Porcentaje de rondas en las que no mueres.",
    Multikills:
      "Multikills: De todas las rondas jugadas, porcentaje de rondas en las que consigues 2 o más kills.",
    Headshot:
      "Headshot: De todos los disparos acertados, porcentaje que impacta en la cabeza.",
  };

  const CHART_HELP: Record<string, string> = {
    profile:
      "Perfil de rendimiento: cada barra muestra tu posicion relativa normalizada dentro de una cohorte formada por jugadores cuyo ultimo rango valido en el mismo acto, cola, agente, mapa y party size cae en tu mismo rango, uno por encima y uno por debajo. El filtro de lado no se aplica a este bloque porque la cohorte se calcula a nivel de partida completa. La estadistica visible es real. Para ordenar jugadores dentro de la cohorte se aplica Bayesian shrinkage hacia la media de la cohorte, reduciendo el sesgo de muestras pequenas.",
    precision:
      "Precision de disparos: distribucion de impactos en cabeza, cuerpo y piernas sobre las partidas filtradas.",
    tacticalRadar:
      "Perfil tactico: radar con seis dimensiones (duelos iniciales, clutches, conversion de trade sobre oportunidades reales, supervivencia, multikills y headshot).",
    tacticalPanel:
      "Panel tactico: cambia de pestaña para ver el detalle de cada dimension tactica con su grafica correspondiente.",
    roundStats:
      "Estadisticas de rondas: todas las metricas se calculan sobre las mismas rondas filtradas.",
  };

  const cohortNotesText =
    cohortNotes.length > 0 ? ` ${cohortNotes.join(" ")}` : "";
  const profilePanelTooltip = `${CHART_HELP.profile} Rango base del cohorte: ${cohortBaseRankName}. Cohorte activa: ${cohortReferenceLabel} (${formatNumber(cohortSampleSize)} jugadores).${!hasKastData ? " KAST no aparece en este historial y queda neutral si no hay muestra." : kastIsApproximate ? " Parte del KAST es una aproximación K/A/S porque faltan rondas_with_kast exactas; no incluye trades desconocidos." : " KAST usa rondas exactas con kill válida, asistencia válida, supervivencia o muerte tradeada."}${cohortNotesText}`;

  const playerRankIcon =
    displayedRankVisual ||
    highestRankVisual ||
    dashboard?.currentRank?.smallIcon ||
    dashboard?.currentRank?.image ||
    null;

  const selectedWeapon =
    mostPlayedWeapons.find((weapon) => weapon.id === selectedWeaponId) ?? null;

  const [tacticalPanelTab, setTacticalPanelTab] =
    React.useState<TacticalPanelTab>("Headshot");
  const [agentsSortMode, setAgentsSortMode] = React.useState<
    "matches" | "winrate"
  >("matches");
  const [bestOverviewMode, setBestOverviewMode] = React.useState<
    "agents" | "roles"
  >("agents");
  const [rolesSortMode, setRolesSortMode] = React.useState<
    "matches" | "winrate"
  >("matches");
  const [weaponsSortMode, setWeaponsSortMode] = React.useState<"kills" | "kd">(
    "kills",
  );
  const [mapsSortMode, setMapsSortMode] = React.useState<"matches" | "winrate">(
    "winrate",
  );
  const [roundImpactChartMode, setRoundImpactChartMode] =
    React.useState<RoundImpactChartMode>("participation");
  const [mapsModalOpen, setMapsModalOpen] = React.useState(false);
  const [selectedMapNameForList, setSelectedMapNameForList] = React.useState<
    string | null
  >(null);
  const [selectedMapNameForDetail, setSelectedMapNameForDetail] =
    React.useState<string | null>(null);
  const [heatmapInitialMapName, setHeatmapInitialMapName] = React.useState<
    string | null
  >(null);

  React.useLayoutEffect(() => {
    if (!floatingTooltip?.visible) return;

    const tooltipNode = floatingTooltipRef.current;
    if (!tooltipNode) return;

    const bounds = tooltipNode.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    updateFloatingTooltipLayout(bounds.width, bounds.height);
  }, [
    floatingTooltip?.visible,
    floatingTooltip?.content,
    floatingTooltip?.anchorRect.left,
    floatingTooltip?.anchorRect.top,
    floatingTooltip?.anchorRect.right,
    floatingTooltip?.anchorRect.bottom,
    updateFloatingTooltipLayout,
  ]);

  const canSortAgentsByWinRate = React.useMemo(
    () => mostPlayedAgents.some((agent) => agent.matches >= 3),
    [mostPlayedAgents],
  );

  const canSortWeaponsByKd = React.useMemo(
    () => mostPlayedWeapons.some((weapon) => weapon.kills >= 10),
    [mostPlayedWeapons],
  );

  React.useEffect(() => {
    if (agentsSortMode === "winrate" && !canSortAgentsByWinRate) {
      setAgentsSortMode("matches");
    }
  }, [agentsSortMode, canSortAgentsByWinRate]);

  React.useEffect(() => {
    if (weaponsSortMode === "kd" && !canSortWeaponsByKd) {
      setWeaponsSortMode("kills");
    }
  }, [weaponsSortMode, canSortWeaponsByKd]);

  const displayedAgents = React.useMemo(() => {
    if (agentsSortMode === "winrate") {
      return mostPlayedAgents
        .filter((agent) => agent.matches >= 3)
        .sort((a, b) => {
          if (b.winRate !== a.winRate) return b.winRate - a.winRate;
          return b.matches - a.matches;
        });
    }

    return [...mostPlayedAgents].sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return b.winRate - a.winRate;
    });
  }, [mostPlayedAgents, agentsSortMode]);

  const displayedRoles = React.useMemo(() => {
    if (rolesSortMode === "winrate") {
      return [...mostPlayedRoles].sort((a, b) => {
        if (a.matches === 0 && b.matches !== 0) return 1;
        if (b.matches === 0 && a.matches !== 0) return -1;
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        return b.matches - a.matches;
      });
    }

    return [...mostPlayedRoles].sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return b.winRate - a.winRate;
    });
  }, [mostPlayedRoles, rolesSortMode]);

  const displayedWeapons = React.useMemo(() => {
    if (weaponsSortMode === "kd") {
      return mostPlayedWeapons
        .filter((weapon) => weapon.kills >= 10)
        .sort((a, b) => {
          if (b.kd !== a.kd) return b.kd - a.kd;
          return b.kills - a.kills;
        });
    }

    return [...mostPlayedWeapons].sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      return b.kd - a.kd;
    });
  }, [mostPlayedWeapons, weaponsSortMode]);

  const displayedMaps = React.useMemo(() => {
    if (mapsSortMode === "winrate") {
      return [...mapPerformance].sort((a, b) => {
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        return b.matches - a.matches;
      });
    }

    return [...mapPerformance].sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return b.winRate - a.winRate;
    });
  }, [mapPerformance, mapsSortMode]);

  const selectedMapForModal = React.useMemo(() => {
    if (displayedMaps.length === 0) return null;

    return (
      displayedMaps.find((mapItem) => mapItem.map === selectedMapNameForList) ??
      displayedMaps[0]
    );
  }, [displayedMaps, selectedMapNameForList]);

  const selectedMapForDetail = React.useMemo(() => {
    if (!selectedMapNameForDetail) return null;

    return (
      mapPerformance.find(
        (mapItem) => mapItem.map === selectedMapNameForDetail,
      ) ?? null
    );
  }, [mapPerformance, selectedMapNameForDetail]);

  const getMapPrimaryMetric = React.useCallback(
    (mapItem: { matches: number; winRate: number }) =>
      mapsSortMode === "matches"
        ? formatNumber(mapItem.matches)
        : formatPercent(mapItem.winRate, 1),
    [mapsSortMode],
  );

  const getMapSecondaryMetric = React.useCallback(
    (mapItem: { matches: number; wins: number; losses: number }) =>
      mapsSortMode === "matches"
        ? "partidas"
        : `${formatNumber(mapItem.wins)}W - ${formatNumber(mapItem.losses)}L`,
    [mapsSortMode],
  );

  const openAgentDetail = React.useCallback(
    (agentId: string) => {
      requestAnimationFrame(() => {
        setSelectedAgentId(agentId);
      });
    },
    [setSelectedAgentId],
  );

  const openWeaponDetail = React.useCallback(
    (weaponId: string) => {
      requestAnimationFrame(() => {
        setSelectedWeaponId(weaponId);
      });
    },
    [setSelectedWeaponId],
  );

  const openMapDetail = React.useCallback((mapName: string) => {
    requestAnimationFrame(() => {
      setSelectedMapNameForDetail(mapName);
    });
  }, []);

  const openMapsList = React.useCallback(() => {
    requestAnimationFrame(() => {
      if (!selectedMapNameForList && displayedMaps[0]) {
        setSelectedMapNameForList(displayedMaps[0].map);
      }
      setMapsModalOpen(true);
    });
  }, [displayedMaps, selectedMapNameForList]);

  const openHeatmapSetup = React.useCallback(
    (mapName?: string | null) => {
      requestAnimationFrame(() => {
        setHeatmapInitialMapName(mapName ?? null);
        setHeatmapOpen(true);
      });
    },
    [setHeatmapOpen],
  );

  const handleHeatmapSetupConfirm = React.useCallback(
    (nextFilters: HeatmapEntryFilters) => {
      if (!playerId) return;

      const params = new URLSearchParams();
      if (nextFilters.mapId) {
        params.set("mapId", nextFilters.mapId);
      } else if (nextFilters.mapName) {
        params.set("mapName", nextFilters.mapName);
      }
      if (nextFilters.agentId) {
        params.set("agentId", nextFilters.agentId);
      }
      if (nextFilters.seasonIds && nextFilters.seasonIds.length > 0) {
        params.set("seasonIds", [...new Set(nextFilters.seasonIds)].join(","));
      }
      if (nextFilters.side === "attack" || nextFilters.side === "defense") {
        params.set("side", nextFilters.side);
      }

      setHeatmapOpen(false);
      setHeatmapInitialMapName(null);
      const queryString = params.toString();
      navigate(
        `/estadisticas/${playerId}/heatmap${queryString ? `?${queryString}` : ""}`,
      );
    },
    [navigate, playerId, setHeatmapOpen],
  );

  const totalHeadshotImpacts = React.useMemo(
    () => globalHeadshotData.reduce((sum, point) => sum + point.value, 0),
    [globalHeadshotData],
  );

  const headshotProfileData = React.useMemo(
    () =>
      globalHeadshotData.map((point) => ({
        ...point,
        pct:
          totalHeadshotImpacts > 0
            ? (point.value * 100) / totalHeadshotImpacts
            : 0,
      })),
    [globalHeadshotData, totalHeadshotImpacts],
  );

  const clutchBreakdownData = globalClutchData;

  const clutchBreakdownHasData = React.useMemo(
    () =>
      clutchBreakdownData.some(
        (point) => point.opportunities > 0 || point.won > 0,
      ),
    [clutchBreakdownData],
  );

  const clutchTotalWithoutBreakdown =
    clutchBreakdownHasData &&
    clutchBreakdownData.length === 1 &&
    clutchBreakdownData[0]?.label === "Total";

  const tradeImpactMetrics = React.useMemo(() => {
    const tradeKillsTotal = globalTacticalStats.tradeKills;
    const tradeOpportunitiesTotal = globalTacticalStats.tradeOpportunities;
    const missedTradeOpportunitiesTotal =
      globalTacticalStats.missedTradeOpportunities;
    const tradedDeathsTotal = globalTacticalStats.tradedDeaths;
    const tradeConversionRate = globalTacticalStats.tradeConversionRate;

    return {
      tradeKillsTotal,
      tradeOpportunitiesTotal,
      missedTradeOpportunitiesTotal,
      tradedDeathsTotal,
      tradeConversionRate,
      hasData: tradeOpportunitiesTotal > 0,
      chartData: [
        {
          label: "Oportunidades reales",
          converted: tradeKillsTotal,
          missed: missedTradeOpportunitiesTotal,
        },
      ],
    };
  }, [
    globalTacticalStats.tradeKills,
    globalTacticalStats.tradeOpportunities,
    globalTacticalStats.missedTradeOpportunities,
    globalTacticalStats.tradedDeaths,
    globalTacticalStats.tradeConversionRate,
  ]);

  const roundsWithMultikill =
    globalTacticalStats.multi2k +
    globalTacticalStats.multi3k +
    globalTacticalStats.multi4k +
    globalTacticalStats.multi5k;
  const survivedRounds = Math.max(
    0,
    globalTacticalStats.totalRounds - globalTacticalStats.totalDeaths,
  );

  const tacticalPanelDescriptions: Record<TacticalPanelTab, string> = {
    Headshot: `Distribucion de impactos en cabeza, cuerpo y piernas. HS real: ${formatPercent(globalTacticalStats.headshotPct, 1)} sobre ${formatNumber(totalHeadshotImpacts)} impactos.`,
    Multikills: `Rondas con 2K, 3K, 4K y 5K (Ace). Total: ${formatNumber(roundsWithMultikill)} de ${formatNumber(globalTacticalStats.totalRounds)} rondas.`,
    "Duelos iniciales": `Primer duelo de la ronda: ${formatNumber(globalTacticalStats.openingDuelWins)} ganados, ${formatNumber(globalTacticalStats.openingDuelLosses)} perdidos (${formatPercent(globalTacticalStats.openingDuelWinPct, 1)}).`,
    Supervivencia: `Porcentaje de rondas en las que sigues vivo al final: ${formatNumber(survivedRounds)} de ${formatNumber(globalTacticalStats.totalRounds)} rondas (${formatPercent(globalTacticalStats.survivalRate, 1)}).`,
    Clutches: clutchTotalWithoutBreakdown
      ? `Hay ${formatNumber(globalTacticalStats.clutchOpportunities)} clutches en total, pero este historial no trae desglose por tipo 1vX.`
      : "Desglose por 1v1-1v5 con oportunidades, ganados y win rate por cada tipo de clutch.",
    "Trade Kills": "Trade kill = eliminas al rival que acaba de matar a un companero en <= 5s. Oportunidad real = estabas vivo y cerca para responder, o convertiste el trade.",
  };

  const activeTacticalDescription = tacticalPanelDescriptions[tacticalPanelTab];

  const roundsTotal = roundImpactSummary.totalRounds;
  const firstBloodPerRoundPct =
    roundsTotal > 0 ? (roundImpactSummary.firstBloods * 100) / roundsTotal : 0;
  const acePerRoundPct =
    roundsTotal > 0 ? (roundImpactSummary.aces * 100) / roundsTotal : 0;
  const hasPlantDefuseRoundContext =
    roundImpactSummary.plantOpportunities > 0 ||
    roundImpactSummary.defuseOpportunities > 0;
  const hasRoundImpactData = roundsTotal > 0;

  const firstBloodHelp =
    "Primeras sangres: aperturas conseguidas por el jugador. Se muestra total y porcentaje por ronda sobre todas las rondas analizadas.";
  const aceHelp =
    "Ace: rondas en las que consigues 5K. Se muestra total y porcentaje por ronda sobre todas las rondas analizadas.";
  const directParticipationHelp =
    "Participacion directa: porcentaje de rondas donde haces kill o asistencia. Sin participacion directa: porcentaje de rondas donde no haces ni kill ni asistencia.";
  const plantDefuseHelp =
    "Plant y Defuse: acciones propias divididas por oportunidades de equipo (plant o defuse) en las que estabas vivo en el momento del evento.";

  const roundRateRows = React.useMemo(
    () => [
      {
        key: "kills",
        label: "Rondas con kill",
        pct: roundImpactSummary.roundsWithKillPct,
        rounds: roundImpactSummary.roundsWithKill,
        modifier: "round-rate-item--kills",
      },
      {
        key: "deaths",
        label: "Rondas con muerte",
        pct: roundImpactSummary.roundsWithDeathPct,
        rounds: roundImpactSummary.roundsWithDeath,
        modifier: "round-rate-item--deaths",
      },
      {
        key: "assists",
        label: "Rondas con asistencia",
        pct: roundImpactSummary.roundsWithAssistPct,
        rounds: roundImpactSummary.roundsWithAssist,
        modifier: "round-rate-item--assists",
      },
    ],
    [
      roundImpactSummary.roundsWithKillPct,
      roundImpactSummary.roundsWithKill,
      roundImpactSummary.roundsWithDeathPct,
      roundImpactSummary.roundsWithDeath,
      roundImpactSummary.roundsWithAssistPct,
      roundImpactSummary.roundsWithAssist,
    ],
  );

  const directParticipationChartData = React.useMemo(
    () => [
      {
        label: "Directa",
        detailLabel: "Participacion directa",
        pct: roundImpactSummary.directParticipationPct,
        rounds: roundImpactSummary.roundsWithDirectParticipation,
        color: "#5ec7f4",
      },
      {
        label: "Sin directa",
        detailLabel: "Sin participacion directa",
        pct: roundImpactSummary.noDirectParticipationPct,
        rounds: roundImpactSummary.roundsWithoutDirectParticipation,
        color: "#8b96a8",
      },
    ],
    [
      roundImpactSummary.directParticipationPct,
      roundImpactSummary.noDirectParticipationPct,
      roundImpactSummary.roundsWithDirectParticipation,
      roundImpactSummary.roundsWithoutDirectParticipation,
    ],
  );

  const plantDefuseChartData = React.useMemo(
    () => [
      {
        label: "Plant",
        detailLabel: "Plants propios",
        pct: roundImpactSummary.plantsPerOpportunityPct,
        rounds: roundImpactSummary.plants,
        totalRounds: roundImpactSummary.plantOpportunities,
        denominatorLabel: "oportunidades con vida",
        color: "#5ec7f4",
      },
      {
        label: "Defuse",
        detailLabel: "Defuses propios",
        pct: roundImpactSummary.defusesPerOpportunityPct,
        rounds: roundImpactSummary.defuses,
        totalRounds: roundImpactSummary.defuseOpportunities,
        denominatorLabel: "oportunidades con vida",
        color: "#72d9a8",
      },
    ],
    [
      roundImpactSummary.plantsPerOpportunityPct,
      roundImpactSummary.plants,
      roundImpactSummary.plantOpportunities,
      roundImpactSummary.defusesPerOpportunityPct,
      roundImpactSummary.defuses,
      roundImpactSummary.defuseOpportunities,
    ],
  );

  const roundDistributionChartData = React.useMemo(
    () =>
      [
        {
          label: "Solo kill",
          pct: roundImpactSummary.distributionOnlyKillsPct,
          rounds: roundImpactSummary.distributionOnlyKills,
          color: "#ff6473",
        },
        {
          label: "Solo assist",
          pct: roundImpactSummary.distributionOnlyAssistsPct,
          rounds: roundImpactSummary.distributionOnlyAssists,
          color: "#6ed6a3",
        },
        {
          label: "Solo muertes",
          pct: roundImpactSummary.distributionOnlyDeathsPct,
          rounds: roundImpactSummary.distributionOnlyDeaths,
          color: "#f6bf5f",
        },
        {
          label: "Kill + assist",
          pct: roundImpactSummary.distributionKillAssistPct,
          rounds: roundImpactSummary.distributionKillAssist,
          color: "#5ec7f4",
        },
        {
          label: "Kill + muerte",
          pct: roundImpactSummary.distributionKillDeathPct,
          rounds: roundImpactSummary.distributionKillDeath,
          color: "#f59fb2",
        },
        {
          label: "Assist + muerte",
          pct: roundImpactSummary.distributionAssistDeathPct,
          rounds: roundImpactSummary.distributionAssistDeath,
          color: "#c3cf6e",
        },
        {
          label: "Kill + assist + muerte",
          pct: roundImpactSummary.distributionKillAssistDeathPct,
          rounds: roundImpactSummary.distributionKillAssistDeath,
          color: "#b08cff",
        },
        {
          label: "Ninguna",
          pct: roundImpactSummary.distributionNonePct,
          rounds: roundImpactSummary.distributionNone,
          color: "#8f97a4",
        },
      ].sort(
        (a, b) =>
          b.rounds - a.rounds ||
          b.pct - a.pct ||
          a.label.localeCompare(b.label, "es"),
      ),
    [
      roundImpactSummary.distributionOnlyKillsPct,
      roundImpactSummary.distributionOnlyKills,
      roundImpactSummary.distributionOnlyAssistsPct,
      roundImpactSummary.distributionOnlyAssists,
      roundImpactSummary.distributionOnlyDeathsPct,
      roundImpactSummary.distributionOnlyDeaths,
      roundImpactSummary.distributionKillAssistPct,
      roundImpactSummary.distributionKillAssist,
      roundImpactSummary.distributionKillDeathPct,
      roundImpactSummary.distributionKillDeath,
      roundImpactSummary.distributionAssistDeathPct,
      roundImpactSummary.distributionAssistDeath,
      roundImpactSummary.distributionKillAssistDeathPct,
      roundImpactSummary.distributionKillAssistDeath,
      roundImpactSummary.distributionNonePct,
      roundImpactSummary.distributionNone,
    ],
  );

  const CustomPolarAngleTick = (props: {
    x?: number | string;
    y?: number | string;
    cx?: number | string;
    cy?: number | string;
    payload?: { value?: string | number };
  }) => {
    const toNumber = (value?: number | string) => {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    };

    const x = toNumber(props.x);
    const y = toNumber(props.y);
    const cx = toNumber(props.cx);
    const cy = toNumber(props.cy);
    const label = String(props.payload?.value ?? "");
    const help = TACTICAL_HELP[label] ?? "";
    const hoverHandlers = getFloatingInfoHoverHandlers(help);

    const fontSize = 11;
    const iconSize = 14;
    const iconGap = 4;
    const approxCharWidth = fontSize * 0.58;
    const labelWidth = Math.max(18, Math.round(label.length * approxCharWidth));
    const compoundWidth = labelWidth + iconGap + iconSize;

    const centerX = typeof cx === "number" ? cx : 0;
    const centerY = typeof cy === "number" ? cy : 0;
    const dx = x - centerX;
    const dy = y - centerY;
    const dist = Math.hypot(dx, dy) || 1;

    // Push labels outward from the radar edge so icon+text stay outside the grid/polygon.
    const outwardOffset = 12;
    const anchorX = x + (dx / dist) * outwardOffset;
    const anchorY = y + (dy / dist) * outwardOffset;

    let blockStartX = -compoundWidth / 2;
    if (dx < -2) {
      // Left side: keep the block to the left of its anchor (icon still to the right of text).
      blockStartX = -compoundWidth;
    } else if (dx > 2) {
      // Right side: keep the block to the right of its anchor.
      blockStartX = 0;
    }

    const textCenterX = blockStartX + labelWidth / 2;
    const iconCenterX = blockStartX + labelWidth + iconGap + iconSize / 2;

    return (
      <g transform={`translate(${anchorX},${anchorY})`}>
        <text
          x={textCenterX}
          y={0}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#c0c0c0"
          fontSize={fontSize}
          fontWeight={600}
          style={{ pointerEvents: "none" }}
        >
          {label}
        </text>

        <g
          transform={`translate(${iconCenterX},0)`}
          className="tactical-info-trigger"
          {...hoverHandlers}
        >
          <circle cx={0} cy={0} r={iconSize * 0.7} fill="transparent" />
          <Info
            x={-iconSize / 2}
            y={-iconSize / 2}
            size={iconSize}
            strokeWidth={2}
            className="tactical-info-icon"
            aria-hidden="true"
          />
        </g>
      </g>
    );
  };

  if (loading || rankComparisonInitialLoading) {
    return <PageLoadingScreen />;
  }

  if (!playerId) {
    return (
      <div className="stats-container">
        <div className="stats-header">
          <span className="stats-eyebrow">Valorant</span>
          <h1 className="stats-title">Estadisticas</h1>
          <p className="stats-subtitle">
            Usa el buscador de la pagina principal para abrir el perfil de un
            jugador.
          </p>
          <div className="stats-divider" />
        </div>

        <div className="empty-panel">No hay un jugador seleccionado.</div>
      </div>
    );
  }

  if (!dashboard || !player) {
    return (
      <div className="stats-container">
        <div className="stats-header">
          <span className="stats-eyebrow">Valorant</span>
          <h1 className="stats-title">Estadisticas</h1>
          <p className="stats-subtitle">
            No se encontraron datos del jugador seleccionado.
          </p>
          <div className="stats-divider" />
        </div>

        <div className="empty-panel">
          No se pudieron cargar estadisticas para este jugador.
        </div>
      </div>
    );
  }

  const currentRank = dashboard.currentRank;
  const rankVisual = normalizeCompetitiveTierIconPath(
    displayedRankVisual ?? currentRank.image ?? currentRank.smallIcon ?? null,
  ) ?? UNRANKED_RANK_ICON_FALLBACK;
  const highestRankVisualAsset = normalizeCompetitiveTierIconPath(
    highestRankVisual ?? null,
  ) ?? UNRANKED_RANK_ICON_FALLBACK;

  const totalMatches = derivedSummary.matches;

  const headerShowcase: HeaderVisualCard[] = [
    {
      title: mostPlayedAgentInsight?.name ?? "Agente",
      subtitle: "Agente mas jugado",
      image: mostPlayedAgentInsight?.id
        ? (dashboard.agentMediaMap?.[mostPlayedAgentInsight.id]?.image ?? null)
        : null,
    },
    {
      title: bestMapWinrateInsight?.map ?? "Mapa destacado",
      subtitle: "Mapa con mejor winrate",
      valueLabel: bestMapWinrateInsight
        ? formatPercent(bestMapWinrateInsight.winRate, 1)
        : undefined,
      image: bestMapWinrateInsight?.map
        ? resolveMapImage(bestMapWinrateInsight.map, dashboard.mapMediaMap)
        : (dashboard?.headerShowcase?.[1]?.image ?? null),
    },
    {
      title: bestWeaponInsight?.name ?? "Arma destacada",
      subtitle: "Arma con mas kills",
      valueLabel: bestWeaponInsight
        ? `${formatNumber(bestWeaponInsight.kills ?? 0)} kills`
        : undefined,
      image: bestWeaponInsight?.name
        ? (dashboard?.headerShowcase?.[2]?.image ??
          resolveWeaponImage(bestWeaponInsight.name))
        : null,
    },
  ].map((card) => {
    const kind = getHeaderCardKind(card.subtitle);

    if (kind === "map" && !card.image) {
      return {
        ...card,
        image: resolveMapImage(card.title, dashboard.mapMediaMap),
      };
    }

    if (kind === "weapon" && !card.image) {
      return { ...card, image: resolveWeaponImage(card.title) };
    }

    return card;
  });

  return (
    <div className="stats-container">
      {rankComparisonLoading && (
        <LoadingModal placement="overlay" />
      )}
      <div className="stats-top-actions">
        <BackButton />
        <div className="stats-result-summary" aria-label="Resumen de resultados filtrados">
          <span className="stats-result-summary-item">
            Wins: <strong>{formatNumber(filteredResultSummary.wins)}</strong>
          </span>
          <span className="stats-result-summary-separator">|</span>
          <span className="stats-result-summary-item">
            Loses: <strong>{formatNumber(filteredResultSummary.losses)}</strong>
          </span>
          <span className="stats-result-summary-separator">|</span>
          <span className="stats-result-summary-item">
            Empates: <strong>{formatNumber(filteredResultSummary.draws)}</strong>
          </span>
        </div>
      </div>
      <div className="stats-header">
        <span className="stats-eyebrow">Valorant</span>

        <div className="stats-header-grid">
          <div className="player-header-main">
            <div>
              <h1 className="stats-title player-title-main">
                <span className="player-name-line">
                  {player.gameName || "Jugador"}
                </span>
                {player.tagLine ? (
                  <span className="player-tag">#{player.tagLine}</span>
                ) : null}
              </h1>

              <div className="player-rank-row">
                <div className="player-rank-block">
                  <img
                    src={rankVisual}
                    alt={displayedRankName || "Sin rango"}
                    className="player-rank-image"
                    onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                  />

                  <div className="player-rank-text">
                    <span className="player-rank-label">
                      Rango de referencia
                    </span>
                    <strong>{displayedRankName}</strong>
                  </div>
                </div>

                <div className="player-rank-block">
                  <img
                    src={highestRankVisualAsset}
                    alt={highestRankName || "Sin rango"}
                    className="player-rank-image"
                    onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                  />

                  <div className="player-rank-text">
                    <span className="player-rank-label">Rango mas alto</span>
                    <strong>{highestRankName}</strong>
                    <span className="player-rank-act">
                      {highestRankActLabel}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="stats-divider" />

            <div className="player-hero player-hero-spacing">
              <div className="player-identity player-identity-main">
                <div className="player-meta">
                  <span className="meta-pill">
                    Region: {player.region ?? "-"}
                  </span>
                  <span className="meta-pill">
                    Nivel: {formatNumber(latestFilteredAccountLevel)}
                  </span>
                  <span className="meta-pill">
                    Partidas: {formatNumber(totalMatches)}
                  </span>
                  <span className="meta-pill">
                    H Jugadas: {formatHours(filteredPlaytimeMillis)}
                  </span>
                </div>

                <div className="player-highlight-grid">
                  <div className="highlight-box">
                    <span>Win Rate</span>
                    <strong>{formatPercent(metrics.globalWinRate, 1)}</strong>
                  </div>
                  <div className="highlight-box">
                    <span>KD</span>
                    <strong>{formatNumber(metrics.globalKd, 2)}</strong>
                  </div>
                  <div className="highlight-box">
                    <span>ACS</span>
                    <strong>{formatNumber(metrics.globalAcs, 1)}</strong>
                  </div>
                  <div className="highlight-box">
                    <span>Headshot</span>
                    <strong>
                      {formatPercent(metrics.globalHeadshotPct, 1)}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="header-showcase-grid header-showcase-grid-vertical">
            {headerShowcase.map((card) => (
              <HeaderShowcaseCard
                key={`${card.subtitle}-${card.title}`}
                title={card.title}
                subtitle={card.subtitle}
                image={card.image}
                valueLabel={card.valueLabel}
              />
            ))}
          </div>
        </div>
      </div>

      {filteredMatches.length === 0 ? (
        <div className="no-stats-screen">
          <div className="no-stats-icon">📊</div>
          <h2 className="no-stats-title">No hay estadísticas disponibles</h2>
          <p className="no-stats-subtitle">
            No se encontraron partidas para los filtros seleccionados. Prueba a
            cambiar el acto, agente o mapa.
          </p>
          {(filters.actId !== ACT_FILTER_CURRENT ||
            filters.agentId !== AGENT_FILTER_ALL ||
            filters.map !== MAP_FILTER_ALL) && (
            <button
              type="button"
              className="no-stats-reset-btn"
              onClick={() =>
                setFilters({
                  actId: ACT_FILTER_CURRENT,
                  agentId: AGENT_FILTER_ALL,
                  map: MAP_FILTER_ALL,
                  side: "all",
                  partySize: "all",
                  queueId: QUEUE_FILTER_COMPETITIVE,
                })
              }
            >
              Restablecer filtros
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ── ROW 1: Perfil + Precision (same height) ── */}
          <section className="dashboard-row-top">
            <div className="stats-panel panel-large panel-performance-profile">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Perfil de rendimiento</h3>
                  <p className="panel-subtitle">
                    12 metricas compactas comparadas con tu cohorte de rango
                    filtrada.
                  </p>
                </div>
                <MetricInfo
                  content={profilePanelTooltip}
                  getHoverHandlers={getFloatingInfoHoverHandlers}
                />
              </div>

              <div className="profile-performance-grid">
                {profilePerformanceMetrics.map((metric) => (
                  <div key={metric.key} className="profile-performance-item">
                    <div className="profile-performance-info">
                      <div className="profile-performance-head">
                        <span>{metric.label}</span>
                        <MetricInfo
                          content={metric.tooltip}
                          getHoverHandlers={getFloatingInfoHoverHandlers}
                        />
                      </div>
                      <strong className="profile-performance-value">
                        {metric.isPercent
                          ? formatPercent(metric.value, metric.decimals)
                          : formatNumber(metric.value, metric.decimals)}
                      </strong>
                    </div>
                    <div className="profile-performance-meter">
                      <small className="profile-performance-fill-text">
                        {formatPercent(metric.fillPercent, 0)}
                      </small>
                      <div className="profile-performance-bar-track">
                        <div
                          className="profile-performance-bar-fill"
                          style={{
                            width: `${metric.fillPercent}%`,
                            background: getProfilePerformanceMetricFillColor(
                              metric.key,
                              metric.fillPercent,
                            ),
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="stats-panel stats-panel-precision">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Precision de disparos</h3>
                  <p className="panel-subtitle">
                    Distribucion calculada sobre las partidas filtradas.
                  </p>
                </div>
                <MetricInfo
                  content={CHART_HELP.precision}
                  getHoverHandlers={getFloatingInfoHoverHandlers}
                />
              </div>
              <div className="shot-chart-range-tabs" role="tablist">
                <button
                  type="button"
                  className={shotChartRange === "total" ? "active" : ""}
                  onClick={() => setShotChartRange("total")}
                  role="tab"
                  aria-selected={shotChartRange === "total"}
                >
                  Total
                </button>
                <button
                  type="button"
                  className={shotChartRange === "recent20" ? "active" : ""}
                  onClick={() => setShotChartRange("recent20")}
                  role="tab"
                  aria-selected={shotChartRange === "recent20"}
                >
                  20 últimas partidas
                </button>
              </div>

              <div className="shot-panel-layout">
                <div className="chart-box shot-chart-box">
                  {activeShotChart.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart
                        margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
                      >
                        <Pie
                          data={activeShotChart}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={48}
                          outerRadius={70}
                          paddingAngle={3}
                        >
                          {activeShotChart.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value, _name, item) => {
                            const entry = item?.payload as
                              | { percentage?: number }
                              | undefined;

                            return [
                              `${formatNumber(Number(value))} (${formatPercent(entry?.percentage, 1)})`,
                              "Disparos",
                            ];
                          }}
                          allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                          wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="empty-chart">Sin datos de precision.</div>
                  )}
                </div>

                <div className="shot-legend">
                  {activeShotChart.map((item) => (
                    <div key={item.name} className="shot-legend-item">
                      <div className="shot-legend-left">
                        <span
                          className="legend-dot"
                          style={{ background: item.color }}
                        />
                        <div>
                          <strong>{item.name}</strong>
                          <small>{formatNumber(item.value)}</small>
                        </div>
                      </div>
                      <span className="shot-legend-value">
                        {formatPercent(item.percentage, 1)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* ── INLINE MATCH HISTORY ── */}
          <section className="match-history-inline">
            <div className="match-history-inline-header">
              <div>
                <h3 className="panel-title">Historial de partidas</h3>
                <p className="panel-subtitle">
                  {sortedFilteredMatches.length} partidas registradas
                </p>
              </div>
              {sortedFilteredMatches.length > COLLAPSED_HISTORY_MATCHES && (
                <button
                  type="button"
                  className="match-history-expand-btn"
                  onClick={() => {
                    setHistoryExpanded((prev) => !prev);
                    setHistoryVisibleCount(MATCHES_PER_PAGE);
                  }}
                >
                  {historyExpanded ? "Colapsar" : "Ver todas las partidas"}
                </button>
              )}
            </div>

            {sortedFilteredMatches.length === 0 ? (
              <div className="empty-panel">
                No hay partidas disponibles para la combinación de filtros
                seleccionada.
              </div>
            ) : historyExpanded ? (
              <>
                <div className="matches-list">
                  {visibleHistoryMatches.map((match) => (
                    <MatchHistoryCard
                      key={match.id}
                      match={match}
                      agentMediaMap={dashboard.agentMediaMap}
                      rankIconUrl={playerRankIcon}
                      onClick={() => setSelectedMatchId(match.id)}
                    />
                  ))}
                </div>

                {sortedFilteredMatches.length > MATCHES_PER_PAGE && (
                  <div className="history-pagination">
                    <span className="history-page-info">
                      Mostrando {visibleHistoryMatches.length} de{" "}
                      {sortedFilteredMatches.length} partidas
                    </span>
                    {canLoadMoreHistory && (
                      <button
                        type="button"
                        className="history-page-btn"
                        onClick={() =>
                          setHistoryVisibleCount((prev) =>
                            Math.min(
                              prev + HISTORY_LOAD_STEP,
                              sortedFilteredMatches.length,
                            ),
                          )
                        }
                      >
                        Cargar más
                      </button>
                    )}
                    {canCollapseHistory && (
                      <button
                        type="button"
                        className="history-page-btn"
                        onClick={() => setHistoryVisibleCount(MATCHES_PER_PAGE)}
                      >
                        Mostrar menos
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="matches-list">
                {sortedFilteredMatches
                  .slice(0, COLLAPSED_HISTORY_MATCHES)
                  .map((match) => (
                    <MatchHistoryCard
                      key={match.id}
                      match={match}
                      agentMediaMap={dashboard.agentMediaMap}
                      rankIconUrl={playerRankIcon}
                      onClick={() => setSelectedMatchId(match.id)}
                    />
                  ))}
              </div>
            )}
          </section>

          <section className="heatmap-entry-row">
            <div className="heatmap-entry-section">
              <button
                className="heatmap-entry-card"
                onClick={() => {
                  setHeatmapInitialMapName(null);
                  setHeatmapOpen(true);
                }}
              >
                <div className="heatmap-entry-copy">
                  <span className="heatmap-entry-eyebrow">Mapa de calor</span>
                  <h3 className="heatmap-entry-title">Heatmap</h3>
                  <p className="heatmap-entry-desc">
                    Visualiza kills, muertes, first bloods, plants y defuses en
                    un mapa de calor interactivo. Mantiene los filtros actuales
                    y te deja profundizar por agente, lado y fase.
                  </p>
                </div>
              </button>
            </div>

            <article className="heatmap-placeholder-card" aria-hidden="true">
              <div className="heatmap-placeholder-copy">
                <span className="heatmap-placeholder-eyebrow">
                  Proximamente
                </span>
                <strong className="heatmap-placeholder-title">
                  Bloque reservado
                </strong>
                <p className="heatmap-placeholder-desc">
                  Este espacio queda preparado para nuevo contenido, manteniendo
                  el mismo tamaño visual que el bloque de Heatmap.
                </p>
              </div>
            </article>
          </section>

          {/* ── ROW 2: Performance (left) + Tactical (center) + Side Panels (right) ── */}
          <section className="dashboard-row-bottom">
            {/* ── Column 1: Estadisticas de rondas ── */}
            <div className="stats-panel stats-panel-performance stats-panel-rounds">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Estadisticas de rondas</h3>
                </div>
                <MetricInfo
                  content={CHART_HELP.roundStats}
                  getHoverHandlers={getFloatingInfoHoverHandlers}
                />
              </div>

              <div className="round-impact-layout">
                <div className="round-impact-top">
                  <article className="round-context-kpi">
                    <div className="round-context-head">
                      <span className="round-context-label">Nº Rondas</span>
                    </div>
                    <strong className="round-context-value">
                      {formatNumber(roundsTotal)}
                    </strong>
                    <p className="round-context-caption">Rondas analizadas</p>
                  </article>

                  <article className="round-ratio-triad">
                    <div className="round-ratio-head">
                      <span className="round-ratio-title">
                        Rondas con evento
                      </span>
                    </div>
                    <div className="round-rate-grid round-rate-grid--compact">
                      {roundRateRows.map((row) => (
                        <article
                          key={row.key}
                          className={`round-rate-item ${row.modifier}`}
                        >
                          <div className="round-rate-head">
                            <span>{row.label}</span>
                            <strong>{formatPercent(row.pct, 1)}</strong>
                          </div>
                          <div className="round-rate-track" aria-hidden="true">
                            <span
                              className="round-rate-fill"
                              style={{
                                ["--round-rate-fill" as string]: `${Math.max(0, Math.min(100, row.pct))}%`,
                              }}
                            />
                          </div>
                          <span className="round-rate-footnote">
                            {formatNumber(row.rounds)} de{" "}
                            {formatNumber(roundsTotal)}
                          </span>
                        </article>
                      ))}
                    </div>
                  </article>
                </div>

                <div className="round-milestones">
                  <article className="round-milestone round-milestone-firstblood">
                    <div className="round-milestone-chip-row">
                      <span className="round-milestone-chip">
                        PRIMERAS SANGRES
                      </span>
                      <MetricInfo
                        content={firstBloodHelp}
                        getHoverHandlers={getFloatingInfoHoverHandlers}
                      />
                    </div>
                    <strong className="round-milestone-value">
                      {formatNumber(roundImpactSummary.firstBloods)} ·{" "}
                      {formatPercent(firstBloodPerRoundPct, 1)}
                    </strong>
                  </article>

                  <article className="round-milestone round-milestone-ace">
                    <div className="round-milestone-chip-row">
                      <span className="round-milestone-chip">ACE</span>
                      <MetricInfo
                        content={aceHelp}
                        getHoverHandlers={getFloatingInfoHoverHandlers}
                      />
                    </div>
                    <strong className="round-milestone-value">
                      {formatNumber(roundImpactSummary.aces)} ·{" "}
                      {formatPercent(acePerRoundPct, 1)}
                    </strong>
                  </article>
                </div>

                <div className="round-impact-chart-panel round-impact-chart-panel--full">
                  <div className="round-impact-switch" role="tablist">
                    <button
                      type="button"
                      className={`round-impact-switch-btn${roundImpactChartMode === "participation" ? " active" : ""}`}
                      onClick={() => setRoundImpactChartMode("participation")}
                    >
                      Participacion directa
                    </button>
                    <button
                      type="button"
                      className={`round-impact-switch-btn${roundImpactChartMode === "distribution" ? " active" : ""}`}
                      onClick={() => setRoundImpactChartMode("distribution")}
                    >
                      Escenarios de ronda
                    </button>
                  </div>

                  <div
                    className={`round-impact-chart-box${
                      roundImpactChartMode === "distribution"
                        ? " round-impact-chart-box--distribution"
                        : ""
                    }`}
                  >
                    {hasRoundImpactData ? (
                      roundImpactChartMode === "participation" ? (
                        <div className="round-impact-participation-grid">
                          <section className="round-impact-mini-panel">
                            <div className="round-impact-mini-head">
                              <span className="round-impact-mini-title">
                                Participacion directa
                              </span>
                              <MetricInfo
                                content={directParticipationHelp}
                                getHoverHandlers={getFloatingInfoHoverHandlers}
                              />
                            </div>

                            <div className="round-impact-mini-chart">
                              <ResponsiveContainer width="100%" height={110}>
                                <BarChart
                                  data={directParticipationChartData}
                                  layout="vertical"
                                  margin={{
                                    top: 10,
                                    right: 28,
                                    left: 8,
                                    bottom: 8,
                                  }}
                                  barCategoryGap="22%"
                                >
                                  <CartesianGrid
                                    stroke="rgba(255,255,255,0.08)"
                                    horizontal={false}
                                  />
                                  <XAxis
                                    type="number"
                                    domain={[0, 100]}
                                    tickCount={5}
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{
                                      fill: "#9da6b3",
                                      fontSize: 11,
                                      fontWeight: 700,
                                    }}
                                    tickFormatter={(value: number | string) =>
                                      `${Number(value)}%`
                                    }
                                  />
                                  <YAxis
                                    type="category"
                                    dataKey="label"
                                    width={90}
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{
                                      fill: "#b9c0cc",
                                      fontSize: 12,
                                      fontWeight: 700,
                                    }}
                                  />
                                  <Tooltip
                                    formatter={(value, _name, payload) => {
                                      const rounds = Number(
                                        (
                                          payload as {
                                            payload?: { rounds?: number };
                                          }
                                        )?.payload?.rounds ?? 0,
                                      );
                                      return [
                                        `${formatPercent(Number(value), 1)} · ${formatNumber(rounds)} rondas`,
                                        "Detalle",
                                      ];
                                    }}
                                    contentStyle={
                                      TACTICAL_TOOLTIP_CONTENT_STYLE
                                    }
                                    labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                                    itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                                    cursor={TACTICAL_TOOLTIP_CURSOR}
                                    allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                                    wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                                  />
                                  <Bar
                                    dataKey="pct"
                                    radius={[0, 8, 8, 0]}
                                    barSize={16}
                                  >
                                    {directParticipationChartData.map(
                                      (entry) => (
                                        <Cell
                                          key={entry.label}
                                          fill={entry.color}
                                        />
                                      ),
                                    )}
                                  </Bar>
                                </BarChart>
                              </ResponsiveContainer>
                            </div>

                            <div className="round-impact-duel-meta">
                              {directParticipationChartData.map(
                                (entry, index) => (
                                  <div
                                    key={entry.label}
                                    className={`round-impact-duel-chip ${
                                      index === 0
                                        ? "round-impact-duel-chip--direct"
                                        : "round-impact-duel-chip--nothing"
                                    }`}
                                  >
                                    <span>
                                      {entry.detailLabel ?? entry.label}
                                    </span>
                                    <strong>
                                      {formatNumber(entry.rounds)} ·{" "}
                                      {formatPercent(entry.pct, 1)}
                                    </strong>
                                  </div>
                                ),
                              )}
                            </div>
                          </section>

                          <section className="round-impact-mini-panel">
                            <div className="round-impact-mini-head">
                              <span className="round-impact-mini-title">
                                Plant y defuse
                              </span>
                              <MetricInfo
                                content={plantDefuseHelp}
                                getHoverHandlers={getFloatingInfoHoverHandlers}
                              />
                            </div>

                            {hasPlantDefuseRoundContext ? (
                              <>
                                <div className="round-impact-mini-chart">
                                  <ResponsiveContainer
                                    width="100%"
                                    height={110}
                                  >
                                    <BarChart
                                      data={plantDefuseChartData}
                                      layout="vertical"
                                      margin={{
                                        top: 10,
                                        right: 28,
                                        left: 8,
                                        bottom: 8,
                                      }}
                                      barCategoryGap="22%"
                                    >
                                      <CartesianGrid
                                        stroke="rgba(255,255,255,0.08)"
                                        horizontal={false}
                                      />
                                      <XAxis
                                        type="number"
                                        domain={[0, 100]}
                                        tickCount={5}
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{
                                          fill: "#9da6b3",
                                          fontSize: 11,
                                          fontWeight: 700,
                                        }}
                                        tickFormatter={(
                                          value: number | string,
                                        ) => `${Number(value)}%`}
                                      />
                                      <YAxis
                                        type="category"
                                        dataKey="label"
                                        width={90}
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{
                                          fill: "#b9c0cc",
                                          fontSize: 12,
                                          fontWeight: 700,
                                        }}
                                      />
                                      <Tooltip
                                        formatter={(value, _name, payload) => {
                                          const datum = (
                                            payload as {
                                              payload?: {
                                                rounds?: number;
                                                totalRounds?: number;
                                                denominatorLabel?: string;
                                              };
                                            }
                                          )?.payload;
                                          const rounds = Number(
                                            datum?.rounds ?? 0,
                                          );
                                          const totalRounds = Number(
                                            datum?.totalRounds ?? 0,
                                          );
                                          const denominatorLabel =
                                            datum?.denominatorLabel ?? "";

                                          const breakdown =
                                            totalRounds > 0
                                              ? `${formatNumber(rounds)} de ${formatNumber(totalRounds)} rondas de ${denominatorLabel}`
                                              : `${formatNumber(rounds)} rondas`;

                                          return [
                                            `${formatPercent(Number(value), 1)} · ${breakdown}`,
                                            "Detalle",
                                          ];
                                        }}
                                        contentStyle={
                                          TACTICAL_TOOLTIP_CONTENT_STYLE
                                        }
                                        labelStyle={
                                          TACTICAL_TOOLTIP_LABEL_STYLE
                                        }
                                        itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                                        cursor={TACTICAL_TOOLTIP_CURSOR}
                                        allowEscapeViewBox={
                                          CHART_TOOLTIP_ESCAPE
                                        }
                                        wrapperStyle={
                                          CHART_TOOLTIP_WRAPPER_STYLE
                                        }
                                      />
                                      <Bar
                                        dataKey="pct"
                                        radius={[0, 8, 8, 0]}
                                        barSize={16}
                                      >
                                        {plantDefuseChartData.map((entry) => (
                                          <Cell
                                            key={entry.label}
                                            fill={entry.color}
                                          />
                                        ))}
                                      </Bar>
                                    </BarChart>
                                  </ResponsiveContainer>
                                </div>

                                <div className="round-impact-duel-meta">
                                  {plantDefuseChartData.map((entry) => (
                                    <div
                                      key={entry.label}
                                      className={`round-impact-duel-chip ${
                                        entry.label === "Plant"
                                          ? "round-impact-duel-chip--plant"
                                          : "round-impact-duel-chip--defuse"
                                      }`}
                                    >
                                      <span>
                                        {entry.detailLabel ?? entry.label}
                                      </span>
                                      <strong>
                                        {formatNumber(entry.rounds)} ·{" "}
                                        {formatPercent(entry.pct, 1)}
                                      </strong>
                                    </div>
                                  ))}
                                </div>
                              </>
                            ) : (
                              <div className="empty-chart">
                                Sin oportunidades de plant o defuse para calcular.
                              </div>
                            )}
                          </section>
                        </div>
                      ) : (
                        <>
                          <div className="round-impact-distribution-chart">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart
                                data={roundDistributionChartData}
                                layout="vertical"
                                margin={{
                                  top: 8,
                                  right: 18,
                                  left: 4,
                                  bottom: 8,
                                }}
                                barCategoryGap="11%"
                              >
                                <CartesianGrid
                                  stroke="rgba(255,255,255,0.08)"
                                  horizontal={false}
                                />
                                <XAxis
                                  type="number"
                                  domain={[0, 100]}
                                  tickCount={5}
                                  axisLine={false}
                                  tickLine={false}
                                  tick={{
                                    fill: "#9da6b3",
                                    fontSize: 11,
                                    fontWeight: 700,
                                  }}
                                  tickFormatter={(value: number | string) =>
                                    `${Number(value)}%`
                                  }
                                />
                                <YAxis
                                  type="category"
                                  dataKey="label"
                                  width={132}
                                  interval={0}
                                  axisLine={false}
                                  tickLine={false}
                                  tick={{
                                    fill: "#b9c0cc",
                                    fontSize: 12,
                                    fontWeight: 700,
                                  }}
                                />
                                <Tooltip
                                  formatter={(value, _name, payload) => {
                                    const rounds = Number(
                                      (
                                        payload as {
                                          payload?: { rounds?: number };
                                        }
                                      )?.payload?.rounds ?? 0,
                                    );
                                    return [
                                      `${formatPercent(Number(value), 1)} · ${formatNumber(rounds)} rondas`,
                                      "Detalle",
                                    ];
                                  }}
                                  contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                                  labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                                  itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                                  cursor={TACTICAL_TOOLTIP_CURSOR}
                                  allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                                  wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                                />
                                <Bar
                                  dataKey="pct"
                                  radius={[0, 8, 8, 0]}
                                  barSize={10}
                                >
                                  {roundDistributionChartData.map((entry) => (
                                    <Cell
                                      key={entry.label}
                                      fill={entry.color}
                                    />
                                  ))}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </>
                      )
                    ) : (
                      <div className="empty-chart">
                        Sin rondas para representar.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Column 2: Perfil táctico + Multikills ── */}
            <div className="tactical-column">
              <div className="stats-panel tactical-radar-panel">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Perfil táctico</h3>
                  </div>
                  <MetricInfo
                    content={CHART_HELP.tacticalRadar}
                    getHoverHandlers={getFloatingInfoHoverHandlers}
                  />
                </div>
                <div className="tactical-radar-box">
                  <ResponsiveContainer width="100%" height={214}>
                    <RadarChart
                      data={globalRadarData}
                      cx="50%"
                      cy="50%"
                      outerRadius="70%"
                    >
                      <PolarGrid stroke="rgba(255,255,255,0.08)" />
                      <PolarAngleAxis
                        dataKey="metric"
                        tick={(props) => <CustomPolarAngleTick {...props} />}
                      />
                      <PolarRadiusAxis
                        angle={90}
                        domain={[0, 100]}
                        tick={false}
                        axisLine={false}
                      />
                      <Radar
                        dataKey="value"
                        stroke="#ff4655"
                        fill="#ff4655"
                        fillOpacity={0.2}
                        strokeWidth={2}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "rgba(20,22,28,0.95)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "10px",
                          fontSize: "0.85rem",
                        }}
                        formatter={(
                          _value: unknown,
                          _name: unknown,
                          props: unknown,
                        ) => {
                          const p = (props as { payload?: { real?: string } })
                            ?.payload;
                          return [
                            p?.real ?? `${Number(_value).toFixed(1)}%`,
                            "",
                          ];
                        }}
                        allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                        wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="stats-panel tactical-switch-panel">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Panel táctico</h3>
                  </div>
                  <MetricInfo
                    content={CHART_HELP.tacticalPanel}
                    getHoverHandlers={getFloatingInfoHoverHandlers}
                  />
                </div>

                <div className="tactical-switch-tabs">
                  {TACTICAL_PANEL_TABS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`tactical-switch-tab${tacticalPanelTab === tab ? " active" : ""}`}
                      onClick={() => setTacticalPanelTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <p className="tactical-switch-description">
                  {activeTacticalDescription}
                </p>

                <div className="tactical-switch-content">
                  {tacticalPanelTab === "Headshot" &&
                    (headshotProfileData.some((point) => point.value > 0) ? (
                      <div className="tactical-switch-chart">
                        <ResponsiveContainer width="100%" height={188}>
                          <BarChart
                            data={headshotProfileData}
                            layout="vertical"
                            margin={{ top: 8, right: 14, bottom: 4, left: 8 }}
                          >
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="rgba(255,255,255,0.06)"
                            />
                            <XAxis
                              type="number"
                              domain={[0, 100]}
                              tick={{ fill: "#b5b5b5", fontSize: 11 }}
                              tickFormatter={(value) => `${value}%`}
                              axisLine={false}
                              tickLine={false}
                            />
                            <YAxis
                              dataKey="label"
                              type="category"
                              width={64}
                              tick={{
                                fill: "#b5b5b5",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <Tooltip
                              formatter={(value, _name, payload) => {
                                const impacts = Number(
                                  (
                                    payload as {
                                      payload?: { value?: number };
                                    }
                                  )?.payload?.value ?? 0,
                                );
                                return [
                                  `${formatPercent(Number(value), 1)} · ${formatNumber(impacts)} impactos`,
                                  "Porcentaje",
                                ];
                              }}
                              contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                              labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                              itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                              cursor={TACTICAL_TOOLTIP_CURSOR}
                              allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                              wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                            />
                            <Bar
                              dataKey="pct"
                              radius={[0, 8, 8, 0]}
                              isAnimationActive={false}
                            >
                              {headshotProfileData.map((point) => (
                                <Cell key={point.label} fill={point.color} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="empty-chart">Sin datos de disparos.</div>
                    ))}

                  {tacticalPanelTab === "Multikills" &&
                    (globalMultikillData.some((point) => point.value > 0) ? (
                      <div className="tactical-switch-chart">
                        <ResponsiveContainer width="100%" height={188}>
                          <BarChart
                            data={globalMultikillData}
                            margin={{
                              top: 8,
                              right: 12,
                              bottom: 4,
                              left: -16,
                            }}
                          >
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="rgba(255,255,255,0.06)"
                            />
                            <XAxis
                              dataKey="label"
                              tick={{
                                fill: "#b5b5b5",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <YAxis
                              tick={{ fill: "#b5b5b5", fontSize: 11 }}
                              axisLine={false}
                              tickLine={false}
                              allowDecimals={false}
                            />
                            <Tooltip
                              formatter={(value, name) => [
                                `${formatNumber(Number(value))} rondas`,
                                String(name),
                              ]}
                              contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                              labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                              itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                              cursor={TACTICAL_TOOLTIP_CURSOR}
                              allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                              wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                            />
                            <Bar
                              dataKey="value"
                              name="Rondas"
                              radius={[6, 6, 0, 0]}
                              barSize={28}
                              isAnimationActive={false}
                            >
                              {globalMultikillData.map((d) => (
                                <Cell key={d.label} fill={d.color} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="empty-chart">
                        Sin multikills registrados.
                      </div>
                    ))}

                  {tacticalPanelTab === "Duelos iniciales" &&
                    (globalOpeningDuelData.some((point) => point.value > 0) ? (
                      <div className="tactical-switch-chart">
                        <ResponsiveContainer width="100%" height={188}>
                          <PieChart>
                            <Pie
                              data={globalOpeningDuelData.filter(
                                (point) => point.value > 0,
                              )}
                              dataKey="value"
                              nameKey="label"
                              innerRadius={38}
                              outerRadius={64}
                              paddingAngle={2}
                              stroke="none"
                            >
                              {globalOpeningDuelData
                                .filter((point) => point.value > 0)
                                .map((point) => (
                                  <Cell key={point.label} fill={point.color} />
                                ))}
                            </Pie>
                            <Tooltip
                              formatter={(value, name) => [
                                `${formatNumber(Number(value))} duelos`,
                                String(name),
                              ]}
                              contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                              labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                              itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                              allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                              wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="empty-chart">
                        Sin duelos iniciales registrados.
                      </div>
                    ))}

                  {tacticalPanelTab === "Supervivencia" &&
                    (globalSurvivalData.some((point) => point.value > 0) ? (
                      <div className="tactical-survival-box">
                        <div className="tactical-survival-top">
                          <strong>
                            {formatPercent(globalTacticalStats.survivalRate, 1)}
                          </strong>
                          <span>
                            {formatNumber(survivedRounds)} /{" "}
                            {formatNumber(globalTacticalStats.totalRounds)}{" "}
                            rondas
                          </span>
                        </div>
                        <div className="tactical-switch-chart tactical-survival-chart">
                          <ResponsiveContainer width="100%" height={170}>
                            <BarChart
                              data={globalSurvivalData}
                              margin={{
                                top: 8,
                                right: 12,
                                bottom: 4,
                                left: -16,
                              }}
                            >
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="rgba(255,255,255,0.06)"
                              />
                              <XAxis
                                dataKey="label"
                                tick={{
                                  fill: "#b5b5b5",
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <YAxis
                                tick={{ fill: "#b5b5b5", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                allowDecimals={false}
                              />
                              <Tooltip
                                formatter={(value, name) => [
                                  `${formatNumber(Number(value))} rondas`,
                                  String(name),
                                ]}
                                contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                                labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                                itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                                cursor={TACTICAL_TOOLTIP_CURSOR}
                                allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                                wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                              />
                              <Bar
                                dataKey="value"
                                name="Rondas"
                                radius={[6, 6, 0, 0]}
                                isAnimationActive={false}
                              >
                                {globalSurvivalData.map((point) => (
                                  <Cell key={point.label} fill={point.color} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    ) : (
                      <div className="empty-chart">Sin rondas registradas.</div>
                    ))}

                  {tacticalPanelTab === "Clutches" &&
                    (clutchBreakdownHasData ? (
                      <div className="tactical-switch-chart">
                        <ResponsiveContainer width="100%" height={198}>
                          <ComposedChart
                            data={clutchBreakdownData}
                            margin={{
                              top: 8,
                              right: 12,
                              bottom: 4,
                              left: -16,
                            }}
                          >
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="rgba(255,255,255,0.06)"
                            />
                            <XAxis
                              dataKey="label"
                              tick={{
                                fill: "#b5b5b5",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <YAxis
                              yAxisId="count"
                              tick={{ fill: "#b5b5b5", fontSize: 11 }}
                              axisLine={false}
                              tickLine={false}
                              allowDecimals={false}
                            />
                            <YAxis
                              yAxisId="rate"
                              orientation="right"
                              domain={[0, 100]}
                              tickFormatter={(value) => `${value}%`}
                              tick={{ fill: "#8d94a1", fontSize: 10 }}
                              axisLine={false}
                              tickLine={false}
                              width={36}
                            />
                            <Tooltip
                              labelFormatter={(label) => `Clutch ${label}`}
                              formatter={(value, name, payload) => {
                                const winRate = Number(
                                  (
                                    payload as {
                                      payload?: { winRate?: number };
                                    }
                                  )?.payload?.winRate ?? 0,
                                );
                                if (String(name) === "Win %") {
                                  return [
                                    `${formatPercent(Number(value), 1)}`,
                                    "Win %",
                                  ];
                                }

                                if (String(name) === "Ganados" && winRate > 0) {
                                  return [
                                    `${formatNumber(Number(value))} · ${formatPercent(winRate, 1)}`,
                                    "Ganados",
                                  ];
                                }
                                return [
                                  `${formatNumber(Number(value))}`,
                                  String(name),
                                ];
                              }}
                              contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                              labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                              itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                              cursor={TACTICAL_TOOLTIP_CURSOR}
                              allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                              wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                            />
                            <Bar
                              yAxisId="count"
                              dataKey="opportunities"
                              name="Situaciones"
                              fill="#64748b"
                              radius={[4, 4, 0, 0]}
                            />
                            <Bar
                              yAxisId="count"
                              dataKey="won"
                              name="Ganados"
                              fill="#46c878"
                              radius={[4, 4, 0, 0]}
                            />
                            <Line
                              yAxisId="rate"
                              type="monotone"
                              dataKey="winRate"
                              name="Win %"
                              stroke="#ff4655"
                              strokeWidth={2}
                              dot={{ r: 3, strokeWidth: 0, fill: "#ff4655" }}
                              activeDot={{
                                r: 4,
                                strokeWidth: 0,
                                fill: "#ff4655",
                              }}
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="empty-chart">
                        Sin oportunidades de clutch en las partidas filtradas.
                      </div>
                    ))}

                  {tacticalPanelTab === "Trade Kills" &&
                    (tradeImpactMetrics.hasData ? (
                      <div className="tactical-switch-chart tactical-switch-chart--trade">
                        <div className="trade-conversion-chart-shell">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={tradeImpactMetrics.chartData}
                              layout="vertical"
                              margin={{
                                top: 4,
                                right: 8,
                                bottom: 8,
                                left: 8,
                              }}
                            >
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="rgba(255,255,255,0.06)"
                                horizontal={false}
                              />
                              <XAxis
                                type="number"
                                tick={{ fill: "#b5b5b5", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                allowDecimals={false}
                              />
                              <YAxis
                                type="category"
                                dataKey="label"
                                width={0}
                                hide
                              />
                              <Tooltip
                                labelFormatter={() => "Oportunidades reales de trade"}
                                formatter={(value, name) => {
                                  const numericValue = Number(value);
                                  const sharePct =
                                    tradeImpactMetrics.tradeOpportunitiesTotal > 0
                                      ? (numericValue * 100) /
                                        tradeImpactMetrics.tradeOpportunitiesTotal
                                      : 0;
                                  return [
                                    `${formatNumber(numericValue)} (${formatPercent(sharePct, 1)})`,
                                    String(name),
                                  ];
                                }}
                                contentStyle={TACTICAL_TOOLTIP_CONTENT_STYLE}
                                labelStyle={TACTICAL_TOOLTIP_LABEL_STYLE}
                                itemStyle={TACTICAL_TOOLTIP_ITEM_STYLE}
                                cursor={TACTICAL_TOOLTIP_CURSOR}
                                allowEscapeViewBox={CHART_TOOLTIP_ESCAPE}
                                wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                              />
                              <Bar
                                dataKey="converted"
                                name="Trade Kills"
                                stackId="trade"
                                fill="#64a0ff"
                                radius={[8, 0, 0, 8]}
                                isAnimationActive={false}
                                barSize={26}
                              />
                              <Bar
                                dataKey="missed"
                                name="Oportunidades perdidas"
                                stackId="trade"
                                fill="#f59e0b"
                                radius={[0, 8, 8, 0]}
                                isAnimationActive={false}
                                barSize={26}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>

                        <div className="tactical-switch-footnote">
                          Convertidas <strong>{formatNumber(tradeImpactMetrics.tradeKillsTotal)}</strong> de <strong>{formatNumber(tradeImpactMetrics.tradeOpportunitiesTotal)}</strong> oportunidades reales.
                        </div>
                        <div className="tactical-switch-footnote-muted">
                          Muertes tradeadas por tu equipo: {formatNumber(tradeImpactMetrics.tradedDeathsTotal)}.
                        </div>
                      </div>
                    ) : (
                      <div className="empty-chart">
                        Sin oportunidades de trade reales registradas.
                      </div>
                    ))}
                </div>
              </div>
            </div>

            {/* ── Column 3: Agentes + Armas + Mapas ── */}
            <div className="side-panels-stack">
              <div className="side-panels-top-row side-panels-top-row--triple">
                {/* ── Panel: Mejores agentes ── */}
                <div className="side-panel-card side-panel-card--compact">
                  <div className="side-panel-header side-panel-header--overview">
                    <div className="side-panel-header-main-row">
                      <div className="side-panel-title-mode">
                        <h4 className="side-panel-card-title">Mejores</h4>
                        <select
                          className="side-panel-title-select"
                          value={bestOverviewMode}
                          onChange={(event) =>
                            setBestOverviewMode(
                              event.target.value as "agents" | "roles",
                            )
                          }
                          aria-label="Mostrar mejores agentes o roles"
                        >
                          <option value="agents">Agentes</option>
                          <option value="roles">Roles</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        className="side-panel-view-all-btn"
                        onClick={() => setAgentsModalOpen(true)}
                      >
                        Ver Todos
                      </button>
                    </div>
                    <div className="side-panel-sort-toggle side-panel-sort-toggle--inline">
                      <button
                        type="button"
                        className={`side-panel-sort-btn${
                          (bestOverviewMode === "agents"
                            ? agentsSortMode
                            : rolesSortMode) === "matches"
                            ? " active"
                            : ""
                        }`}
                        onClick={() =>
                          bestOverviewMode === "agents"
                            ? setAgentsSortMode("matches")
                            : setRolesSortMode("matches")
                        }
                      >
                        Partidas
                      </button>
                      {(bestOverviewMode === "roles" ||
                        canSortAgentsByWinRate) && (
                        <button
                          type="button"
                          className={`side-panel-sort-btn${
                            (bestOverviewMode === "agents"
                              ? agentsSortMode
                              : rolesSortMode) === "winrate"
                              ? " active"
                              : ""
                          }`}
                          onClick={() =>
                            bestOverviewMode === "agents"
                              ? setAgentsSortMode("winrate")
                              : setRolesSortMode("winrate")
                          }
                        >
                          Winrate
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="side-panel-card-items side-panel-card-items--compact">
                    {bestOverviewMode === "agents"
                      ? displayedAgents.slice(0, 3).map((agent) => (
                          <button
                            key={agent.id}
                            type="button"
                            className="side-panel-mini"
                            onClick={() => openAgentDetail(agent.id)}
                          >
                            {agent.displayIcon || agent.image ? (
                              <img
                                className="side-panel-mini-img side-panel-mini-img--agent"
                                src={agent.displayIcon || agent.image || ""}
                                alt={agent.name}
                              />
                            ) : (
                              <div className="side-panel-mini-img side-panel-mini-img--agent side-panel-mini-placeholder">
                                {agent.name.charAt(0)}
                              </div>
                            )}
                            <span className="side-panel-mini-name">
                              {agent.name}
                            </span>
                            <span className="side-panel-mini-stat">
                              {agentsSortMode === "winrate"
                                ? `${formatPercent(agent.winRate, 1)} · ${formatNumber(agent.matches)} pj`
                                : `${formatNumber(agent.matches)} partidas`}
                            </span>
                          </button>
                        ))
                      : displayedRoles.slice(0, 4).map((role) => (
                          <div
                            key={role.id}
                            className="side-panel-mini side-panel-mini--role"
                          >
                            {role.displayIcon || role.image ? (
                              <img
                                className="side-panel-mini-img side-panel-mini-img--role"
                                src={role.displayIcon || role.image || ""}
                                alt={role.name}
                              />
                            ) : (
                              <div className="side-panel-mini-img side-panel-mini-img--role side-panel-mini-placeholder">
                                {role.name.charAt(0)}
                              </div>
                            )}
                            <span className="side-panel-mini-name">
                              {role.name}
                            </span>
                            <span className="side-panel-mini-stat">
                              {rolesSortMode === "winrate"
                                ? `${formatPercent(role.winRate, 1)} · ${formatNumber(role.matches)} pj`
                                : `${formatNumber(role.matches)} partidas`}
                            </span>
                          </div>
                        ))}
                  </div>
                </div>

                {/* ── Panel: Mejores armas ── */}
                <div className="side-panel-card side-panel-card--compact">
                  <div className="side-panel-header">
                    <h4 className="side-panel-card-title">Mejores Armas</h4>
                    <div className="side-panel-sort-toggle side-panel-sort-toggle--inline">
                      <button
                        type="button"
                        className={`side-panel-sort-btn${weaponsSortMode === "kills" ? " active" : ""}`}
                        onClick={() => setWeaponsSortMode("kills")}
                      >
                        Kills
                      </button>
                      {canSortWeaponsByKd && (
                        <button
                          type="button"
                          className={`side-panel-sort-btn${weaponsSortMode === "kd" ? " active" : ""}`}
                          onClick={() => setWeaponsSortMode("kd")}
                        >
                          KD
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="side-panel-view-all-btn"
                      onClick={() => setWeaponsModalOpen(true)}
                    >
                      Ver Todos
                    </button>
                  </div>

                  <div className="side-panel-card-items side-panel-card-items--compact">
                    {displayedWeapons.slice(0, 3).map((weapon) => (
                      <button
                        key={weapon.id}
                        type="button"
                        className="side-panel-mini"
                        onClick={() => openWeaponDetail(weapon.id)}
                      >
                        {weapon.image ? (
                          <img
                            className="side-panel-mini-img side-panel-mini-img--weapon"
                            src={weapon.image}
                            alt={weapon.name}
                          />
                        ) : (
                          <div className="side-panel-mini-img side-panel-mini-img--weapon side-panel-mini-placeholder">
                            {weapon.name.charAt(0)}
                          </div>
                        )}
                        <span className="side-panel-mini-name">
                          {weapon.name}
                        </span>
                        <span className="side-panel-mini-stat">
                          {weaponsSortMode === "kd"
                            ? `${formatNumber(weapon.kd, 2)} KD · ${formatNumber(weapon.kills)} kills`
                            : `${formatNumber(weapon.kills)} kills`}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Panel: Mejores mapas ── */}
                <div className="side-panel-card side-panel-card--compact side-panel-card--maps-compact">
                  <div className="side-panel-header">
                    <h4 className="side-panel-card-title">Mejores Mapas</h4>
                    <div className="side-panel-sort-toggle side-panel-sort-toggle--inline">
                      <button
                        type="button"
                        className={`side-panel-sort-btn${mapsSortMode === "matches" ? " active" : ""}`}
                        onClick={() => setMapsSortMode("matches")}
                      >
                        Partidas
                      </button>
                      <button
                        type="button"
                        className={`side-panel-sort-btn${mapsSortMode === "winrate" ? " active" : ""}`}
                        onClick={() => setMapsSortMode("winrate")}
                      >
                        Winrate
                      </button>
                    </div>
                    <button
                      type="button"
                      className="side-panel-view-all-btn"
                      onClick={openMapsList}
                    >
                      Ver Todos
                    </button>
                  </div>

                  <div className="side-panel-card-items side-panel-card-items--compact">
                    {displayedMaps.length === 0 ? (
                      <div className="empty-chart">Sin datos de mapas.</div>
                    ) : (
                      displayedMaps.slice(0, 3).map((mapItem) => (
                        <button
                          key={mapItem.map}
                          type="button"
                          className={`side-panel-mini side-panel-mini--map${mapItem.image ? " side-panel-mini--map-image" : ""}`}
                          style={
                            mapItem.image
                              ? {
                                  backgroundImage: `linear-gradient(104deg, rgba(8, 15, 24, 0.92) 0%, rgba(8, 15, 24, 0.7) 45%, rgba(8, 15, 24, 0.9) 100%), url("${mapItem.image}")`,
                                }
                              : undefined
                          }
                          onClick={() => openMapDetail(mapItem.map)}
                        >
                          <div className="side-panel-map-main">
                            <span className="side-panel-mini-name">
                              {mapItem.map}
                            </span>
                            <div className="side-panel-map-metrics">
                              <span className="side-panel-map-value">
                                {getMapPrimaryMetric(mapItem)}
                              </span>
                              <span className="side-panel-mini-stat side-panel-mini-stat-secondary">
                                {getMapSecondaryMetric(mapItem)}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {!selectedMatchId && <div className="floating-filters">
        {filtersOpen && (
          <div className="floating-filters-panel">
            <div className="floating-filters-header">
              <strong>Filtros</strong>
              <button
                type="button"
                className="floating-filters-close"
                onClick={() => setFiltersOpen(false)}
              >
                ✕
              </button>
            </div>

            {/* ── General ── */}
            <span className="filter-section-title">General</span>
            <div className="history-filter-group">
              <div className="history-filter">
                <label htmlFor="act-filter">Acto</label>
                <select
                  id="act-filter"
                  value={filters.actId}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, actId: e.target.value }))
                  }
                  className="history-select"
                >
                  {actFilterOptions.map((actOption) => (
                    <option key={actOption.id} value={actOption.id}>
                      {actOption.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="history-filter">
                <label htmlFor="agent-filter">Agente</label>
                <select
                  id="agent-filter"
                  value={filters.agentId}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, agentId: e.target.value }))
                  }
                  className="history-select"
                >
                  {agentOptions.map((agentOption) => (
                    <option key={agentOption.id} value={agentOption.id}>
                      {agentOption.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="history-filter">
                <label htmlFor="map-filter">Mapa</label>
                <select
                  id="map-filter"
                  value={filters.map}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, map: e.target.value }))
                  }
                  className="history-select"
                >
                  {mapOptions.map((mapOption) => (
                    <option key={mapOption.id} value={mapOption.id}>
                      {mapOption.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* ── Partida ── */}
            <span className="filter-section-title">Partida</span>
            <div className="history-filter-group">
              <div className="history-filter">
                <label htmlFor="queue-filter">Tipo de partida</label>
                <select
                  id="queue-filter"
                  value={filters.queueId}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, queueId: e.target.value }))
                  }
                  className="history-select"
                >
                  {queueOptions.map((qo) => (
                    <option key={qo.id} value={qo.id}>
                      {qo.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="history-filter">
                <label htmlFor="party-filter">Compañeros</label>
                <select
                  id="party-filter"
                  value={filters.partySize}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      partySize: e.target.value as PartySizeFilter,
                    }))
                  }
                  className="history-select"
                >
                  {partySizeOptions.map((po) => (
                    <option key={po.value} value={po.value}>
                      {po.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* ── Lado ── */}
            <span className="filter-section-title">Lado</span>
            <div className="side-toggle">
              {(["all", "attack", "defense"] as SideFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`side-toggle-btn${filters.side === s ? " active" : ""}`}
                  onClick={() => setFilters((prev) => ({ ...prev, side: s }))}
                >
                  {s === "all"
                    ? "Ambos"
                    : s === "attack"
                      ? "Ataque"
                      : "Defensa"}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="floating-filters-button"
          onClick={() => setFiltersOpen((prev) => !prev)}
        >
          Filtros
          {(() => {
            let count = 0;
            if (filters.actId !== ACT_FILTER_CURRENT) count++;
            if (filters.agentId !== AGENT_FILTER_ALL) count++;
            if (filters.map !== MAP_FILTER_ALL) count++;
            if (filters.queueId !== QUEUE_FILTER_COMPETITIVE) count++;
            if (filters.partySize !== "all") count++;
            if (filters.side !== "all") count++;
            return count > 0 ? (
              <span className="filter-badge">{count}</span>
            ) : null;
          })()}
        </button>
      </div>}

      {/* ── MATCH HISTORY MODAL ── */}
      {historyModalOpen && (
        <div
          className="list-modal-overlay"
          onClick={() => setHistoryModalOpen(false)}
        >
          <div
            className="list-modal-content list-modal-history"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="list-modal-header">
              <h3>Historial de partidas</h3>
              <button
                type="button"
                className="list-modal-close"
                onClick={() => setHistoryModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="list-modal-body">
              {filteredMatches.length === 0 ? (
                <div className="empty-panel">
                  No hay partidas disponibles para la combinación de filtros
                  seleccionada.
                </div>
              ) : (
                <>
                  <div className="matches-list">
                    {visibleHistoryMatches.map((match) => (
                      <MatchHistoryCard
                        key={match.id}
                        match={match}
                        agentMediaMap={dashboard.agentMediaMap}
                        rankIconUrl={playerRankIcon}
                        onClick={() => {
                          setHistoryModalOpen(false);
                          setSelectedMatchId(match.id);
                        }}
                      />
                    ))}
                  </div>

                  {sortedFilteredMatches.length > MATCHES_PER_PAGE && (
                    <div className="history-pagination">
                      <span className="history-page-info">
                        Mostrando {visibleHistoryMatches.length} de{" "}
                        {sortedFilteredMatches.length} partidas
                      </span>
                      {canLoadMoreHistory && (
                        <button
                          type="button"
                          className="history-page-btn"
                          onClick={() =>
                            setHistoryVisibleCount((prev) =>
                              Math.min(
                                prev + HISTORY_LOAD_STEP,
                                sortedFilteredMatches.length,
                              ),
                            )
                          }
                        >
                          Cargar más
                        </button>
                      )}
                      {canCollapseHistory && (
                        <button
                          type="button"
                          className="history-page-btn"
                          onClick={() =>
                            setHistoryVisibleCount(MATCHES_PER_PAGE)
                          }
                        >
                          Mostrar menos
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── AGENTS LIST MODAL ── */}
      {agentsModalOpen && (
        <div
          className="list-modal-overlay"
          onClick={() => setAgentsModalOpen(false)}
        >
          <div
            className="list-modal-content list-modal-agents"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="list-modal-header">
              <h3>
                {bestOverviewMode === "agents"
                  ? "Agentes jugados"
                  : "Roles jugados"}
              </h3>
              <button
                type="button"
                className="list-modal-close"
                onClick={() => setAgentsModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="list-modal-body">
              {bestOverviewMode === "agents" ? (
                displayedAgents.length === 0 ? (
                  <div className="empty-panel">Sin datos de agentes.</div>
                ) : (
                  <div className="list-modal-items">
                    {displayedAgents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        className="list-modal-item"
                        onClick={() => {
                          setAgentsModalOpen(false);
                          openAgentDetail(agent.id);
                        }}
                      >
                        {agent.displayIcon || agent.image ? (
                          <img
                            src={agent.displayIcon || agent.image || ""}
                            alt={agent.name}
                            className="list-modal-item-img"
                          />
                        ) : (
                          <div className="list-modal-item-img list-modal-item-placeholder">
                            {agent.name.charAt(0)}
                          </div>
                        )}
                        <div className="list-modal-item-info">
                          <strong>{agent.name}</strong>
                          <small>
                            {agentsSortMode === "winrate"
                              ? `${formatPercent(agent.winRate, 1)} · ${formatNumber(agent.matches)} partidas`
                              : `${formatNumber(agent.matches)} partidas`}
                          </small>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : displayedRoles.length === 0 ? (
                <div className="empty-panel">Sin datos de roles.</div>
              ) : (
                <div className="list-modal-items">
                  {displayedRoles.map((role) => (
                    <div
                      key={role.id}
                      className="list-modal-item list-modal-item--static"
                    >
                      {role.displayIcon || role.image ? (
                        <img
                          src={role.displayIcon || role.image || ""}
                          alt={role.name}
                          className="list-modal-item-img list-modal-item-role-img"
                        />
                      ) : (
                        <div className="list-modal-item-img list-modal-item-placeholder">
                          {role.name.charAt(0)}
                        </div>
                      )}
                      <div className="list-modal-item-info">
                        <strong>{role.name}</strong>
                        <small>
                          {rolesSortMode === "winrate"
                            ? `${formatPercent(role.winRate, 1)} · ${formatNumber(role.matches)} partidas`
                            : `${formatNumber(role.matches)} partidas`}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── WEAPONS LIST MODAL ── */}
      {weaponsModalOpen && (
        <div
          className="list-modal-overlay"
          onClick={() => setWeaponsModalOpen(false)}
        >
          <div
            className="list-modal-content list-modal-weapons"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="list-modal-header">
              <h3>Armas utilizadas</h3>
              <button
                type="button"
                className="list-modal-close"
                onClick={() => setWeaponsModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="list-modal-body">
              {displayedWeapons.length === 0 ? (
                <div className="empty-panel">Sin datos de armas.</div>
              ) : (
                <div className="list-modal-items">
                  {displayedWeapons.map((weapon) => (
                    <button
                      key={weapon.id}
                      type="button"
                      className="list-modal-item"
                      onClick={() => {
                        setWeaponsModalOpen(false);
                        openWeaponDetail(weapon.id);
                      }}
                    >
                      {weapon.image ? (
                        <img
                          src={weapon.image}
                          alt={weapon.name}
                          className="list-modal-item-img list-modal-item-weapon-img"
                        />
                      ) : (
                        <div className="list-modal-item-img list-modal-item-placeholder">
                          {weapon.name.charAt(0)}
                        </div>
                      )}
                      <div className="list-modal-item-info">
                        <strong>{weapon.name}</strong>
                        <small>
                          {weaponsSortMode === "kd"
                            ? `${formatNumber(weapon.kd, 2)} KD · ${formatNumber(weapon.kills)} kills`
                            : `${formatNumber(weapon.kills)} kills · ${formatNumber(weapon.matches)} partidas`}
                        </small>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── MAPS LIST MODAL ── */}
      {mapsModalOpen && (
        <div
          className="list-modal-overlay"
          onClick={() => setMapsModalOpen(false)}
        >
          <div
            className="list-modal-content list-modal-weapons list-modal-maps"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="list-modal-header">
              <h3>Mapas</h3>
              <button
                type="button"
                className="list-modal-close"
                onClick={() => setMapsModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="list-modal-body">
              {displayedMaps.length === 0 ? (
                <div className="empty-panel">Sin datos de mapas.</div>
              ) : (
                <div className="list-modal-items">
                  {displayedMaps.map((mapItem) => (
                    <button
                      key={mapItem.map}
                      type="button"
                      className={`list-modal-item list-modal-item--map${mapItem.image ? " list-modal-item--map-image" : ""}${selectedMapForModal?.map === mapItem.map ? " is-active" : ""}`}
                      style={
                        mapItem.image
                          ? ({
                              ["--list-modal-map-bg" as string]: `url("${mapItem.image}")`,
                            } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => setSelectedMapNameForList(mapItem.map)}
                    >
                      <div className="list-modal-map-name">{mapItem.map}</div>
                      <div className="list-modal-map-metrics">
                        <span className="list-modal-map-value">
                          {getMapPrimaryMetric(mapItem)}
                        </span>
                        <span className="list-modal-map-caption">
                          {getMapSecondaryMetric(mapItem)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedMapForModal && displayedMaps.length > 0 && (
              <div className="list-modal-footer list-modal-footer--map">
                <div className="map-modal-summary">
                  <div className="map-modal-summary-copy">
                    <strong>{selectedMapForModal.map}</strong>
                    <small>
                      {formatPercent(selectedMapForModal.winRate, 1)} WR ·{" "}
                      {formatNumber(selectedMapForModal.matches)} partidas ·{" "}
                      {formatNumber(selectedMapForModal.wins)}-
                      {formatNumber(selectedMapForModal.losses)} W-L
                    </small>
                  </div>
                  <div className="map-modal-summary-actions">
                    <button
                      type="button"
                      className="map-modal-detail-btn"
                      onClick={() => {
                        setMapsModalOpen(false);
                        openMapDetail(selectedMapForModal.map);
                      }}
                    >
                      Ver detalle
                    </button>
                    <button
                      type="button"
                      className="map-modal-heatmap-btn"
                      onClick={() => {
                        setMapsModalOpen(false);
                        openHeatmapSetup(selectedMapForModal.map);
                      }}
                    >
                      Abrir setup heatmap
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <React.Suspense fallback={<LoadingModal placement="overlay" />}>
      {selectedMatchId && (
        <MatchDetailModal
          key={selectedMatchId}
          matchId={selectedMatchId}
          playerId={playerId ?? ""}
          agentNameMap={dashboard.agentNameMap}
          onClose={() => setSelectedMatchId(null)}
        />
      )}

      {selectedAgentId && (
        <AgentDetailModal
          agentId={selectedAgentId}
          analyticsList={filteredAnalyticsList}
          agentNameMap={dashboard.agentNameMap}
          onClose={() => setSelectedAgentId(null)}
        />
      )}

      {selectedWeaponId && (
        <WeaponDetailModal
          weaponId={selectedWeaponId}
          weaponName={selectedWeapon?.name ?? "Arma"}
          weaponImage={selectedWeapon?.image ?? null}
          analyticsList={filteredAnalyticsList}
          onClose={() => setSelectedWeaponId(null)}
        />
      )}

      {selectedMapNameForDetail && (
        <MapDetailModal
          mapName={selectedMapNameForDetail}
          mapImage={
            selectedMapForDetail?.image ??
            resolveMapImage(selectedMapNameForDetail, dashboard.mapMediaMap)
          }
          analyticsList={filteredAnalyticsList}
          onOpenHeatmap={(mapName) => {
            setSelectedMapNameForDetail(null);
            openHeatmapSetup(mapName);
          }}
          onClose={() => setSelectedMapNameForDetail(null)}
        />
      )}

      {heatmapOpen && dashboard && (
        <HeatmapModal
          mode="modal"
          playerId={playerId ?? ""}
          agentNameMap={dashboard.agentNameMap}
          actOptions={dashboard.actOptions ?? []}
          initialFilters={{
            mapName:
              heatmapInitialMapName ??
              (filters.map !== MAP_FILTER_ALL ? filters.map : undefined),
            agentId:
              filters.agentId !== AGENT_FILTER_ALL
                ? filters.agentId
                : undefined,
            seasonIds: effectiveActId ? [effectiveActId] : undefined,
            side:
              filters.side === "attack" || filters.side === "defense"
                ? filters.side
                : "",
          }}
          onEnterHeatmap={handleHeatmapSetupConfirm}
          onClose={() => {
            setHeatmapOpen(false);
            setHeatmapInitialMapName(null);
          }}
        />
      )}
      </React.Suspense>
      {floatingTooltip && floatingTooltip.visible && (
        <div
          ref={floatingTooltipRef}
          className={`floating-info-tooltip floating-info-tooltip--${floatingTooltip.placement}`}
          style={{ left: floatingTooltip.x, top: floatingTooltip.y }}
        >
          {floatingTooltip.content}
        </div>
      )}
    </div>
  );
}
