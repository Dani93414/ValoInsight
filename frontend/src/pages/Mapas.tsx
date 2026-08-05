import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useActos,
  useAgentes,
  useArmas,
  useGlobalMapStats,
  useMapas,
  usePlayerDashboard,
  useRegionOptions,
} from "../api/hooks";
import { ComparisonTable } from "../components/comparison/ComparisonTable";
import LoadingModal from "../components/ui/LoadingModal";
import { useAuth } from "../context/AuthContext";
import type { ActContent, MapContent } from "../types/content";
import type {
  GlobalAgentStatsOption,
  RegionMapStats,
} from "../types/globalStats";
import {
  formatCompactNumber,
  formatNumber,
  formatPercent,
  hideBrokenImage,
  normalizeText,
} from "./contentFormatters";
import {
  bayesianAdjustedRate,
  calculatePersonalMapStats,
  calculateRoundTypeShares,
  classifyValorantMapMode,
  inferSiteCount,
  regionMapStatsToComputed,
  type ComputedMapStats,
  type MapModeGroupKey,
} from "./Mapas/mapUtils";
import {
  isValidMapPercentPosition,
  translateValorantCoordinatesToMapPosition,
} from "./Mapas/mapCallouts";
import {
  buildBestCompositionsForMap,
  buildBestCompositionsFromGlobal,
  buildBestWeaponsForMap,
  buildBestWeaponsFromGlobal,
  getBestAgents,
} from "./Mapas/mapRankings";
import {
  ContentEmpty,
  ContentError,
  ContentLoading,
  ContentSection,
  ContentShell,
} from "./contentPageUtils";
import "./ContentPages.css";

const ALL = "all";
const COMPETITIVE = "competitive";
const TOPBAR_OFFSET_PX = 88;

const MODE_OPTIONS = [
  { value: COMPETITIVE, label: "Competitivo" },
  { value: "skirmish", label: "Escaramuza" },
  { value: "tdm", label: "Team Deathmatch" },
  { value: "training", label: "Entrenamiento" },
] as const;

const SORT_OPTIONS = [
  { value: "name", label: "Nombre" },
  { value: "matches", label: "Partidas" },
  { value: "winRate", label: "Winrate" },
] as const;

type SortKey = (typeof SORT_OPTIONS)[number]["value"];

type MapEntry = MapContent & {
  groupKey: MapModeGroupKey;
  groupLabel: string;
  groupOrder: number;
  globalStats?: RegionMapStats;
  computedGlobalStats?: ComputedMapStats | null;
};

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type ComparisonMetric = {
  key: string;
  label: string;
  globalLabel: string;
  personalLabel: string;
  diffLabel: string;
  globalNormalizedLabel?: string;
  personalNormalizedLabel?: string;
  normalizedDiffLabel?: string;
  diff?: number;
  normalizedDiff?: number;
  higherIsBetter: boolean;
};

function optionLabel(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function toSelectOptions(
  options: GlobalAgentStatsOption[] | undefined,
  fallback: string,
): SelectOption[] {
  if (!options || options.length === 0) {
    return [{ value: ALL, label: fallback, disabled: true }];
  }
  return [
    { value: ALL, label: "Todos" },
    ...options.map((option) => ({
      value: option.value,
      label: option.count ? `${option.label} (${option.count})` : option.label,
    })),
  ];
}

function stripOptionCount(label: string) {
  return label.replace(/\s+\(\d+\)$/, "");
}

function formatActOptionLabel(
  option: SelectOption,
  actsById: Map<string, ActContent>,
) {
  if (option.value === ALL || option.disabled) return option.label;
  const act = actsById.get(option.value);
  const baseName = stripOptionCount(act?.name ?? option.label);
  const episode = act?.parentName ? stripOptionCount(act.parentName) : "";
  return episode ? `${baseName} - ${episode}` : option.label;
}

function getMapStatsKey(map: MapContent) {
  return map.uuid ?? map.displayName;
}

function isAvailableNumber(value: number | undefined | null) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asCoordinateValue(value: unknown) {
  return typeof value === "number" || typeof value === "string"
    ? value
    : undefined;
}

function resolveCalloutPosition(
  location: Record<string, unknown>,
  map: MapEntry,
  naturalSize: { width: number; height: number } | null,
) {
  const gameX = map.callouts
    ? (asCoordinateValue(location.x) ??
      asCoordinateValue(location.X) ??
      asCoordinateValue(location.gameX) ??
      asCoordinateValue(location.game_x))
    : undefined;
  const gameY = map.callouts
    ? (asCoordinateValue(location.y) ??
      asCoordinateValue(location.Y) ??
      asCoordinateValue(location.gameY) ??
      asCoordinateValue(location.game_y))
    : undefined;

  const transformed = translateValorantCoordinatesToMapPosition({
    gameX,
    gameY,
    xMultiplier: map.xMultiplier,
    xScalarToAdd: map.xScalarToAdd,
    yMultiplier: map.yMultiplier,
    yScalarToAdd: map.yScalarToAdd,
  });
  if (isValidMapPercentPosition(transformed)) return transformed;

  const rawX = toFiniteNumber(gameX);
  const rawY = toFiniteNumber(gameY);
  if (rawX === undefined || rawY === undefined) return null;

  // Some stored callouts may already be normalized/percentage/pixel image coordinates.
  // The overlay always uses CSS percentages so it stays aligned after responsive resizing.
  if (rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1) {
    return { xPercent: rawX * 100, yPercent: rawY * 100 };
  }
  if (rawX >= 0 && rawX <= 100 && rawY >= 0 && rawY <= 100) {
    return { xPercent: rawX, yPercent: rawY };
  }
  if (
    naturalSize &&
    rawX >= 0 &&
    rawX <= naturalSize.width &&
    rawY >= 0 &&
    rawY <= naturalSize.height
  ) {
    return {
      xPercent: (rawX * 100) / naturalSize.width,
      yPercent: (rawY * 100) / naturalSize.height,
    };
  }
  return null;
}

function formatMaybePercent(value?: number) {
  return isAvailableNumber(value) ? formatPercent(value, 1) : "Sin datos";
}

function formatMaybeNumber(value?: number, digits = 0) {
  return isAvailableNumber(value) ? formatNumber(value, digits) : "Sin datos";
}

function getMapGridColumns() {
  if (typeof window === "undefined") return 5;
  if (window.innerWidth <= 600) return 2;
  if (window.innerWidth <= 900) return 3;
  if (window.innerWidth <= 1200) return 4;
  return 5;
}

function ContentThumb({
  src,
  alt,
  className = "",
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  if (!src)
    return (
      <span
        className={`mapas-thumb mapas-thumb--empty ${className}`}
        aria-hidden="true"
      />
    );
  return (
    <img
      className={`mapas-thumb ${className}`}
      src={src}
      alt={alt}
      onError={hideBrokenImage}
    />
  );
}

function buildRegionOptions(
  regions: Array<{ region?: string }> | undefined,
): SelectOption[] {
  const values = Array.from(
    new Set(
      (regions ?? [])
        .map((region) => region.region?.toLowerCase())
        .filter(Boolean) as string[],
    ),
  );
  return [
    { value: "", label: "Todas" },
    ...values.map((value) => ({ value, label: value.toUpperCase() })),
  ];
}

function buildComparisonMetrics(
  globalStats: ComputedMapStats | null | undefined,
  personalStats: ComputedMapStats | null | undefined,
  globalCohort: ComputedMapStats[] = [],
): ComparisonMetric[] {
  const configs = [
    {
      key: "rounds",
      label: "Rondas jugadas",
      format: "number" as const,
      noDiff: true,
      noNormalize: true,
    },
    {
      key: "roundDiff",
      label: "Diferencia de rondas",
      format: "number" as const,
      sampleKey: "rounds",
      noDiff: true,
      noNormalize: true,
      globalAsDash: true,
    },
    {
      key: "winRate",
      label: "Winrate jugadores",
      format: "percent" as const,
      sampleKey: "playerMatches",
    },
    {
      key: "teamRoundWinRate",
      label: "WR rondas equipo",
      format: "percent" as const,
      sampleKey: "rounds",
    },
    {
      key: "attackWinRate",
      label: "Attack WR",
      format: "percent" as const,
      sampleKey: "rounds",
    },
    {
      key: "defenseWinRate",
      label: "Defense WR",
      format: "percent" as const,
      sampleKey: "rounds",
    },
    {
      key: "killsPerRound",
      label: "Kills / player-round",
      format: "number" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "deathsPerRound",
      label: "Muertes / player-round",
      format: "number" as const,
      lowerIsBetter: true,
      sampleKey: "playerRounds",
    },
    {
      key: "adr",
      label: "ADR",
      format: "number" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "kd",
      label: "K/D",
      format: "number" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "acs",
      label: "ACS",
      format: "number" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "kastPct",
      label: "KAST (K/A/S)",
      format: "percent" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "survivalRate",
      label: "Supervivencia",
      format: "percent" as const,
      sampleKey: "playerRounds",
    },
    {
      key: "clutchRate",
      label: "Clutch rate",
      format: "percent" as const,
      sampleKey: "clutchOpportunities",
    },
  ];

  return configs
    .map<ComparisonMetric | null>((config) => {
      const globalValue = globalStats?.[
        config.key as keyof ComputedMapStats
      ] as number | undefined;
      const personalValue = personalStats?.[
        config.key as keyof ComputedMapStats
      ] as number | undefined;
      if (!isAvailableNumber(globalValue) && !isAvailableNumber(personalValue))
        return null;
      const formatValue = (value?: number) =>
        config.format === "percent"
          ? formatMaybePercent(value)
          : formatMaybeNumber(
              value,
              config.key === "matches" || config.key === "rounds" ? 0 : 2,
            );
      const diff =
        isAvailableNumber(globalValue) && isAvailableNumber(personalValue)
          ? (personalValue as number) - (globalValue as number)
          : undefined;
      const sampleKey = (config.sampleKey ??
        "rounds") as keyof ComputedMapStats;
      const globalSample = Number(globalStats?.[sampleKey] ?? 0);
      const personalSample = Number(personalStats?.[sampleKey] ?? 0);
      const cohortValues = globalCohort
        .map(
          (stats) =>
            stats[config.key as keyof ComputedMapStats] as number | undefined,
        )
        .filter((value): value is number => isAvailableNumber(value));
      const cohortMean = cohortValues.length
        ? cohortValues.reduce((sum, value) => sum + value, 0) /
          cohortValues.length
        : isAvailableNumber(globalValue)
          ? globalValue
          : personalValue;
      const priorWeight = config.format === "percent" ? 50 : 80;
      const globalNormalized = config.noNormalize
        ? undefined
        : bayesianAdjustedRate(
            globalValue,
            globalSample,
            cohortMean,
            priorWeight,
          );
      const personalNormalized = config.noNormalize
        ? undefined
        : bayesianAdjustedRate(
            personalValue,
            personalSample,
            cohortMean,
            priorWeight,
          );
      const normalizedDiff =
        isAvailableNumber(globalNormalized) &&
        isAvailableNumber(personalNormalized)
          ? (personalNormalized as number) - (globalNormalized as number)
          : undefined;
      return {
        key: config.key,
        label: config.label,
        globalLabel: config.globalAsDash ? "-" : formatValue(globalValue),
        personalLabel: formatValue(personalValue),
        diffLabel:
          config.noDiff || diff === undefined
            ? "-"
            : `${diff > 0 ? "+" : ""}${config.format === "percent" ? formatNumber(diff, 1) + " pts" : formatNumber(diff, 2)}`,
        globalNormalizedLabel: config.noNormalize
          ? "-"
          : formatValue(globalNormalized),
        personalNormalizedLabel: config.noNormalize
          ? "-"
          : formatValue(personalNormalized),
        normalizedDiffLabel:
          normalizedDiff === undefined
            ? "-"
            : `${normalizedDiff > 0 ? "+" : ""}${config.format === "percent" ? formatNumber(normalizedDiff, 1) + " pts" : formatNumber(normalizedDiff, 2)}`,
        ...(diff !== undefined ? { diff } : {}),
        ...(normalizedDiff !== undefined ? { normalizedDiff } : {}),
        higherIsBetter: !config.lowerIsBetter,
      };
    })
    .filter((metric): metric is ComparisonMetric => Boolean(metric));
}

function buildComparisonSummary(
  personalStats: ComputedMapStats | null | undefined,
  metrics: ComparisonMetric[],
) {
  if (!personalStats)
    return "Sin datos personales para estos filtros. Se muestra la referencia global disponible.";
  if (personalStats.matches <= 3)
    return "Baja muestra: el winrate personal se muestra con ajuste bayesiano para no sobrerreaccionar.";
  const positive = metrics.filter((metric) =>
    metric.diffLabel.startsWith("+"),
  ).length;
  if (positive >= 3)
    return "Tu rendimiento personal destaca frente a varias referencias globales.";
  return "Tu rendimiento queda comparado contra la referencia competitiva global disponible.";
}

function getMetricTone(
  metric: ComparisonMetric,
  field: "diff" | "normalizedDiff",
) {
  const value = metric[field];
  if (!isAvailableNumber(value) || Math.abs(value ?? 0) < 0.0001)
    return "neutral";
  const positive = metric.higherIsBetter ? (value ?? 0) > 0 : (value ?? 0) < 0;
  return positive ? "positive" : "negative";
}

function buildRoundCeremonySharesFromGlobal(stats: RegionMapStats | undefined) {
  const ceremonyLabels: Record<string, string> = {
    CeremonyAce: "Ace",
    CeremonyClutch: "Clutch",
    CeremonyDefault: "Normal",
    CeremonyFlawless: "Impecable",
    CeremonyTeamAce: "Team Ace",
    CeremonyThrifty: "Thrifty",
  };
  const entries = Object.entries(stats?.round_ceremonies ?? {})
    .map(([key, value]) => {
      const wins =
        typeof value === "number"
          ? value
          : Number(value?.wins ?? value?.rounds ?? 0);
      return { key, wins };
    })
    .filter((item) => item.wins > 0);
  const totalWinsWithRoundCeremony = entries.reduce(
    (sum, item) => sum + item.wins,
    0,
  );
  if (totalWinsWithRoundCeremony <= 0) return [];
  return entries
    .map((item) => ({
      key: item.key,
      label: ceremonyLabels[item.key] ?? item.key.replace(/^Ceremony/, ""),
      wins: item.wins,
      percent: (item.wins * 100) / totalWinsWithRoundCeremony,
    }))
    .sort((a, b) => b.percent - a.percent);
}

type PositionedCallout = {
  callout: NonNullable<MapEntry["callouts"]>[number];
  position: { xPercent: number; yPercent: number };
  placement: "right" | "left" | "above" | "below";
  offsetY: number;
};

function layoutCalloutLabels(
  items: Array<{
    callout: NonNullable<MapEntry["callouts"]>[number];
    position: { xPercent: number; yPercent: number };
  }>,
): PositionedCallout[] {
  const labelWidth = 16;
  const labelHeight = 4.5;
  const gap = 1.6;
  const placements: PositionedCallout["placement"][] = [
    "right",
    "left",
    "below",
    "above",
  ];
  const boxFor = (
    position: { xPercent: number; yPercent: number },
    placement: PositionedCallout["placement"],
    offsetY: number,
  ) => {
    const offsetPct = offsetY / 6;
    if (placement === "left") {
      return {
        left: position.xPercent - gap - labelWidth,
        right: position.xPercent - gap,
        top: position.yPercent - labelHeight / 2 + offsetPct,
        bottom: position.yPercent + labelHeight / 2 + offsetPct,
      };
    }
    if (placement === "above") {
      return {
        left: position.xPercent - labelWidth / 2,
        right: position.xPercent + labelWidth / 2,
        top: position.yPercent - gap - labelHeight + offsetPct,
        bottom: position.yPercent - gap + offsetPct,
      };
    }
    if (placement === "below") {
      return {
        left: position.xPercent - labelWidth / 2,
        right: position.xPercent + labelWidth / 2,
        top: position.yPercent + gap + offsetPct,
        bottom: position.yPercent + gap + labelHeight + offsetPct,
      };
    }
    return {
      left: position.xPercent + gap,
      right: position.xPercent + gap + labelWidth,
      top: position.yPercent - labelHeight / 2 + offsetPct,
      bottom: position.yPercent + labelHeight / 2 + offsetPct,
    };
  };
  const overflows = (box: ReturnType<typeof boxFor>) =>
    box.left < 0 || box.right > 100 || box.top < 0 || box.bottom > 100;
  const overlaps = (
    box: ReturnType<typeof boxFor>,
    other: ReturnType<typeof boxFor>,
  ) =>
    box.left < other.right &&
    box.right > other.left &&
    box.top < other.bottom &&
    box.bottom > other.top;

  const placed: PositionedCallout[] = [];
  const sorted = [...items].sort(
    (a, b) =>
      a.position.yPercent - b.position.yPercent ||
      a.position.xPercent - b.position.xPercent,
  );

  sorted.forEach((item) => {
    const { xPercent, yPercent } = item.position;
    const basePlacement: PositionedCallout["placement"] =
      xPercent > 82
        ? "left"
        : yPercent < 5
          ? "below"
          : yPercent > 95
            ? "above"
            : "right";
    const orderedPlacements = [
      basePlacement,
      ...placements.filter((placement) => placement !== basePlacement),
    ];
    let placement = basePlacement;
    let offsetY = 0;

    const pick = () => {
      const offsets = [0, 14, -14, 28, -28, 42, -42];
      for (const candidatePlacement of orderedPlacements) {
        for (const candidateOffset of offsets) {
          const candidateBox = boxFor(
            item.position,
            candidatePlacement,
            candidateOffset,
          );
          if (overflows(candidateBox)) continue;
          const hasOverlap = placed.some((other) =>
            overlaps(
              candidateBox,
              boxFor(other.position, other.placement, other.offsetY),
            ),
          );
          if (!hasOverlap)
            return { placement: candidatePlacement, offsetY: candidateOffset };
        }
      }
      for (const candidatePlacement of orderedPlacements) {
        const candidateBox = boxFor(item.position, candidatePlacement, 0);
        if (!overflows(candidateBox))
          return { placement: candidatePlacement, offsetY: 0 };
      }
      return { placement: basePlacement, offsetY: 0 };
    };
    const picked = pick();
    placement = picked.placement;
    offsetY = picked.offsetY;

    placed.push({
      ...item,
      placement,
      offsetY,
    });
  });

  return placed;
}

function CalloutMap({ map }: { map: MapEntry }) {
  const imageCandidates = [map.displayIcon].filter(Boolean) as string[];
  const [imageIndex, setImageIndex] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const image = imageCandidates[imageIndex];
  const transformAvailable = [
    map.xMultiplier,
    map.xScalarToAdd,
    map.yMultiplier,
    map.yScalarToAdd,
  ].every((value) => toFiniteNumber(value) !== undefined);
  const positionedCallouts = (map.callouts ?? [])
    .map((callout) => {
      const rawLocation = (callout.location ?? {}) as Record<string, unknown>;
      const position = resolveCalloutPosition(rawLocation, map, naturalSize);
      return { callout, position };
    })
    .filter(
      (
        item,
      ): item is {
        callout: NonNullable<MapEntry["callouts"]>[number];
        position: { xPercent: number; yPercent: number };
      } => isValidMapPercentPosition(item.position),
    );
  const laidOutCallouts = layoutCalloutLabels(positionedCallouts);

  if (!image) {
    return (
      <div className="mapas-empty-panel">
        Sin minimapa tactico compatible con coordenadas para este mapa.
      </div>
    );
  }

  return (
    <div className="mapas-callout-map-shell">
      <div className="mapas-callout-map">
        <img
          src={image}
          alt={`Mapa tactico de ${map.displayName}`}
          onLoad={(event) => {
            const target = event.currentTarget;
            setNaturalSize({
              width: target.naturalWidth,
              height: target.naturalHeight,
            });
          }}
          onError={(event) => {
            const nextIndex = imageIndex + 1;
            if (nextIndex < imageCandidates.length) {
              setImageIndex(nextIndex);
              setNaturalSize(null);
              return;
            }
            hideBrokenImage(event);
          }}
        />
        {laidOutCallouts.map(({ callout, position, placement, offsetY }) => {
          const label = `${callout.superRegionName ? `${callout.superRegionName}: ` : ""}${callout.regionName ?? "Callout"}`;
          return (
            <span
              key={`${callout.superRegionName ?? ""}-${callout.regionName ?? ""}-${callout.location?.x ?? ""}-${callout.location?.y ?? ""}`}
              className={`mapas-callout-marker mapas-callout-marker--${placement}`}
              style={{
                left: `${position.xPercent}%`,
                top: `${position.yPercent}%`,
                ["--callout-offset-y" as string]: `${offsetY}px`,
              }}
              title={label}
              aria-label={label}
            >
              <span className="mapas-callout-dot" aria-hidden="true" />
              <span className="mapas-callout-label">
                {callout.regionName ?? callout.superRegionName ?? "Callout"}
              </span>
            </span>
          );
        })}
        {(!transformAvailable || positionedCallouts.length === 0) &&
          (map.callouts?.length ?? 0) > 0 && (
            <div className="mapas-map-notice">
              Sin coordenadas transformables para pintar callouts reales.
            </div>
          )}
        {positionedCallouts.length === 0 &&
          (map.callouts?.length ?? 0) === 0 && (
            <div className="mapas-map-notice">
              Sin callouts posicionables para este mapa.
            </div>
          )}
      </div>
    </div>
  );
}

function StatGrid({
  stats,
  totalMatches,
}: {
  stats: ComputedMapStats | null | undefined;
  totalMatches: number;
}) {
  const playRate =
    stats?.matches && totalMatches > 0
      ? (stats.matches * 100) / totalMatches
      : undefined;
  const performanceRounds = stats?.playerRounds || stats?.rounds || 0;
  const assistsPerRound = performanceRounds
    ? stats!.assists / performanceRounds
    : undefined;
  const kda = stats?.deaths
    ? (stats.kills + stats.assists) / stats.deaths
    : undefined;
  const items = [
    ["Partidas", formatMaybeNumber(stats?.matches)],
    ["Participaciones", formatMaybeNumber(stats?.playerMatches)],
    ["Rondas jugadas", formatMaybeNumber(stats?.rounds)],
    ["Rondas equipo ganadas", formatMaybeNumber(stats?.roundsWon)],
    ["Rondas equipo perdidas", formatMaybeNumber(stats?.roundsLost)],
    [
      "Diferencia de rondas",
      isAvailableNumber(stats?.roundDiff)
        ? `${(stats?.roundDiff ?? 0) > 0 ? "+" : ""}${formatNumber(stats?.roundDiff ?? 0, 0)}`
        : "Sin datos",
    ],
    ["Winrate jugadores", formatMaybePercent(stats?.winRate)],
    ["WR rondas equipo", formatMaybePercent(stats?.teamRoundWinRate)],
    ["Attack WR", formatMaybePercent(stats?.attackWinRate)],
    ["Defense WR", formatMaybePercent(stats?.defenseWinRate)],
    ["Kills / player-round", formatMaybeNumber(stats?.killsPerRound, 2)],
    ["Muertes / player-round", formatMaybeNumber(stats?.deathsPerRound, 2)],
    ["Asist. / player-round", formatMaybeNumber(assistsPerRound, 2)],
    ["ADR", formatMaybeNumber(stats?.adr, 1)],
    ["K/D", formatMaybeNumber(stats?.kd, 2)],
    ["KDA", formatMaybeNumber(kda, 2)],
    ["ACS", formatMaybeNumber(stats?.acs, 1)],
    ["KAST (K/A/S)", formatMaybePercent(stats?.kastPct)],
    ["Supervivencia", formatMaybePercent(stats?.survivalRate)],
    ["Clutch rate", formatMaybePercent(stats?.clutchRate)],
    ["Play rate", formatMaybePercent(playRate)],
  ];
  return (
    <div className="content-kv-grid content-kv-grid--compact mapas-stat-grid">
      {items.map(([label, value]) => (
        <div className="content-kv" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

type BestAgentRow = ReturnType<typeof getBestAgents>[number];
type BestWeaponRow = ReturnType<typeof buildBestWeaponsFromGlobal>[number];
type BestCompositionRow = ReturnType<
  typeof buildBestCompositionsFromGlobal
>[number];
type RoundTypeShareRow = {
  key: string;
  label: string;
  percent: number;
  wins: number;
};

function MapRoundTypesCard({
  roundTypeShares,
  showSelectedStatsLoading,
}: {
  roundTypeShares: RoundTypeShareRow[];
  showSelectedStatsLoading: boolean;
}) {
  return (
    <div className="mapas-round-types-card">
      <div className="mapas-section-heading">
        <span>Rondas</span>
        <h3>Tipos de rondas ganadas</h3>
      </div>
      <p className="mapas-panel-helper">
        Porcentajes calculados solo con roundCeremony sobre rondas ganadas del
        mapa.
      </p>
      {showSelectedStatsLoading ? (
        <LoadingModal placement="section" />
      ) : roundTypeShares.length === 0 ? (
        <div className="mapas-empty-panel">
          Sin datos de ceremonias de ronda.
        </div>
      ) : (
        <div className="mapas-mini-list">
          {roundTypeShares.map((item) => (
            <div className="mapas-mini-row" key={item.key}>
              <span>{item.label}</span>
              <strong>{formatPercent(item.percent, 1)}</strong>
              <small>{formatNumber(item.wins, 0)} rondas</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function lowSampleSuffix(sampleConfidence?: number) {
  return (sampleConfidence ?? 0) < 0.6 ? " - baja muestra" : "";
}

function formatCompositionRoundRecord(composition: BestCompositionRow) {
  const label = composition.hasRoundBreakdown === false ? "partidas" : "rondas";
  return `${formatNumber(composition.roundsWon, 0)}-${formatNumber(composition.roundsLost, 0)} ${label}`;
}

function BestAgentsPanel({
  bestAgents,
  agentMetaById,
  showSelectedStatsLoading,
}: {
  bestAgents: BestAgentRow[];
  agentMetaById: Map<string, { name: string; image?: string | null }>;
  showSelectedStatsLoading: boolean;
}) {
  if (showSelectedStatsLoading) return <PanelLoading />;
  if (bestAgents.length === 0)
    return (
      <div className="mapas-empty-panel">
        Sin datos de agentes para este mapa con los filtros actuales.
      </div>
    );
  return (
    <RecommendationPanel title="Mejores agentes" eyebrow="Agentes">
      <div className="mapas-ranking-list">
        {bestAgents.map((agent, index) => (
          <div className="mapas-ranking-row" key={agent.agentId}>
            <b>{index + 1}</b>
            <span className="mapas-mini-identity">
              <ContentThumb
                src={agentMetaById.get(agent.agentId)?.image}
                alt=""
              />
              <span>{agent.name}</span>
            </span>
            <strong>{formatMaybeNumber(agent.score, 1)} score</strong>
            <small>
              {formatPercent(agent.winRate, 1)} WR -{" "}
              {formatNumber(agent.matches, 0)} partidas -{" "}
              {formatNumber(agent.rounds, 0)} rondas - pick{" "}
              {formatMaybePercent(agent.pickRate)}
              {lowSampleSuffix(agent.sampleConfidence)}
            </small>
          </div>
        ))}
      </div>
    </RecommendationPanel>
  );
}

function BestWeaponsPanel({
  bestWeapons,
  weaponMetaByKey,
  showSelectedStatsLoading,
}: {
  bestWeapons: BestWeaponRow[];
  weaponMetaByKey: Map<string, { name: string; image?: string | null }>;
  showSelectedStatsLoading: boolean;
}) {
  if (showSelectedStatsLoading) return <PanelLoading />;
  if (bestWeapons.length === 0)
    return (
      <div className="mapas-empty-panel">
        Sin datos personales de armas por mapa. El agregado global aun no separa
        armas por mapa.
      </div>
    );
  return (
    <RecommendationPanel title="Mejores armas" eyebrow="Arsenal">
      <div className="mapas-ranking-list">
        {bestWeapons.map((weapon, index) => {
          const meta =
            weaponMetaByKey.get(weapon.key) ??
            weaponMetaByKey.get(normalizeText(weapon.name));
          return (
            <div className="mapas-ranking-row" key={weapon.key}>
              <b>{index + 1}</b>
              <span className="mapas-mini-identity">
                <ContentThumb
                  src={meta?.image}
                  alt=""
                  className="mapas-thumb--weapon"
                />
                <span>{weapon.name}</span>
              </span>
              <strong>{formatMaybeNumber(weapon.score, 1)} score</strong>
              <small>
                {formatMaybePercent(weapon.winRate)} WR -{" "}
                {formatNumber(weapon.kills, 0)} kills -{" "}
                {formatNumber(weapon.rounds, 0)} rondas -{" "}
                {formatNumber(weapon.killsPerRound, 2)} K/R - HS{" "}
                {formatMaybePercent(weapon.hsPct)}
                {lowSampleSuffix(weapon.sampleConfidence)}
              </small>
            </div>
          );
        })}
      </div>
    </RecommendationPanel>
  );
}

function BestCompositionsPanel({
  bestCompositions,
  agentMetaById,
  agentMetaByName,
  showSelectedStatsLoading,
}: {
  bestCompositions: BestCompositionRow[];
  agentMetaById: Map<string, { name: string; image?: string | null }>;
  agentMetaByName: Map<string, { name: string; image?: string | null }>;
  showSelectedStatsLoading: boolean;
}) {
  if (showSelectedStatsLoading) return <PanelLoading />;
  if (bestCompositions.length === 0)
    return (
      <div className="mapas-empty-panel">
        Sin composiciones exactas de 5 agentes para este mapa con los filtros
        actuales.
      </div>
    );
  return (
    <RecommendationPanel title="Mejores composiciones" eyebrow="Composición">
      <div className="mapas-ranking-list">
        {bestCompositions.map((composition, index) => (
          <div
            className="mapas-ranking-row mapas-ranking-row--composition"
            key={composition.key}
          >
            <b>{index + 1}</b>
            <CompositionIdentity
              composition={composition}
              agentMetaById={agentMetaById}
              agentMetaByName={agentMetaByName}
            />
            <strong>{formatMaybeNumber(composition.score, 1)} score</strong>
            <small>
              {formatMaybePercent(composition.winRate)} WR -{" "}
              {formatNumber(composition.matches, 0)} partidas -{" "}
              {formatCompositionRoundRecord(composition)}
              {lowSampleSuffix(composition.sampleConfidence)}
            </small>
          </div>
        ))}
      </div>
    </RecommendationPanel>
  );
}

function RecommendationPanel({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mapas-recommendation-panel">
      <div className="mapas-section-heading">
        <span>{eyebrow}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function PanelLoading() {
  return <LoadingModal placement="section" />;
}

function CompositionIdentity({
  composition,
  agentMetaById,
  agentMetaByName,
}: {
  composition: BestCompositionRow;
  agentMetaById: Map<string, { name: string; image?: string | null }>;
  agentMetaByName: Map<string, { name: string; image?: string | null }>;
}) {
  return (
    <span className="mapas-composition-identity">
      {(composition.key ? composition.key.split("|") : [])
        .slice(0, 5)
        .map((agentId, index) => {
          const fallbackName = composition.agents[index] ?? agentId;
          const meta =
            agentMetaById.get(agentId) ??
            agentMetaByName.get(normalizeText(fallbackName));
          return (
            <ContentThumb
              key={`${composition.key}-${agentId}-${index}`}
              src={meta?.image}
              alt={meta?.name ?? fallbackName}
            />
          );
        })}
    </span>
  );
}

export default function Mapas() {
  const auth = useAuth();
  const query = useMapas();
  const agentsQuery = useAgentes();
  const weaponsQuery = useArmas();
  const actsQuery = useActos();
  const regionsQuery = useRegionOptions();
  const { data: regions } = regionsQuery;
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<string>(COMPETITIVE);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [actFilter, setActFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selected, setSelected] = useState<MapEntry | null>(null);
  const [mapGridColumns, setMapGridColumns] = useState(getMapGridColumns);
  const regionTouchedRef = useRef(false);
  const detailRef = useRef<HTMLElement | null>(null);
  const previousScrollBeforeDetailRef = useRef<number | null>(null);

  const personalDashboardQuery = usePlayerDashboard(auth.user?.puuid, {
    queue_id: COMPETITIVE,
    page_size: 250,
  });
  const playerRegion =
    personalDashboardQuery.data?.player?.region?.toLowerCase();
  const isWaitingForPlayerRegion =
    auth.isLoggedIn &&
    Boolean(auth.user?.puuid) &&
    !selectedRegion &&
    personalDashboardQuery.isLoading;
  // Wait for the definitive initial region. This avoids requesting the global
  // aggregate and immediately replacing it with a region-specific request.
  const canLoadGlobalMapStats = Boolean(selectedRegion);
  const globalMapStatsQuery = useGlobalMapStats(
    {
      region: selectedRegion,
      act: actFilter,
    },
    canLoadGlobalMapStats,
  );

  const regionOptions = useMemo(() => buildRegionOptions(regions), [regions]);
  const actOptions = useMemo(
    () =>
      toSelectOptions(
        globalMapStatsQuery.data?.options?.acts,
        "Sin actos disponibles",
      ),
    [globalMapStatsQuery.data?.options?.acts],
  );
  const actsById = useMemo(() => {
    const byId = new Map<string, ActContent>();
    ((actsQuery.data as ActContent[] | undefined) ?? []).forEach((act) => {
      if (act.id) byId.set(act.id, act);
    });
    return byId;
  }, [actsQuery.data]);
  const formattedActOptions = useMemo(
    () =>
      actOptions.map((option) => ({
        ...option,
        label: formatActOptionLabel(option, actsById),
      })),
    [actOptions, actsById],
  );
  const agentMetaById = useMemo(() => {
    const byId = new Map<string, { name: string; image?: string | null }>();
    const raw = agentsQuery.data as Record<string, unknown[]> | undefined;
    Object.values(raw ?? {})
      .flat()
      .forEach((item) => {
        if (!item || typeof item !== "object") return;
        const record = item as {
          uuid?: string | null;
          displayName?: string | null;
          displayIcon?: string | null;
          displayIconSmall?: string | null;
        };
        if (record.uuid && record.displayName) {
          byId.set(record.uuid, {
            name: record.displayName,
            image: record.displayIconSmall ?? record.displayIcon,
          });
        }
      });
    return byId;
  }, [agentsQuery.data]);
  const agentNameById = useMemo(() => {
    const byId = new Map<string, string>();
    agentMetaById.forEach((meta, id) => byId.set(id, meta.name));
    return byId;
  }, [agentMetaById]);
  const agentMetaByName = useMemo(() => {
    const byName = new Map<string, { name: string; image?: string | null }>();
    agentMetaById.forEach((meta) => byName.set(normalizeText(meta.name), meta));
    return byName;
  }, [agentMetaById]);
  const weaponMetaByKey = useMemo(() => {
    const byKey = new Map<string, { name: string; image?: string | null }>();
    const byName = new Map<string, { name: string; image?: string | null }>();
    (
      (weaponsQuery.data as
        | Array<{
            uuid?: string | null;
            displayName?: string | null;
            displayIcon?: string | null;
          }>
        | undefined) ?? []
    ).forEach((weapon) => {
      const meta = {
        name: weapon.displayName ?? weapon.uuid ?? "",
        image: weapon.displayIcon,
      };
      if (weapon.uuid) byKey.set(weapon.uuid, meta);
      if (weapon.displayName)
        byName.set(normalizeText(weapon.displayName), meta);
    });
    byName.forEach((meta, name) => byKey.set(name, meta));
    return byKey;
  }, [weaponsQuery.data]);

  useEffect(() => {
    if (actFilter === ALL) return;
    if (
      formattedActOptions.some(
        (option) => option.value === actFilter && !option.disabled,
      )
    )
      return;
    const frame = requestAnimationFrame(() => setActFilter(ALL));
    return () => cancelAnimationFrame(frame);
  }, [actFilter, formattedActOptions]);

  useEffect(() => {
    if (regionTouchedRef.current || selectedRegion) return;
    if (playerRegion) {
      const preferred =
        regionOptions.find((option) => option.value === playerRegion)?.value ??
        playerRegion;
      const frame = requestAnimationFrame(() => setSelectedRegion(preferred));
      return () => cancelAnimationFrame(frame);
    }
    if (auth.isLoggedIn && auth.user?.puuid && !personalDashboardQuery.isError)
      return;
    const fallback = regionOptions.find((option) => option.value)?.value ?? "";
    if (!fallback) return;
    const frame = requestAnimationFrame(() => setSelectedRegion(fallback));
    return () => cancelAnimationFrame(frame);
  }, [
    auth.isLoggedIn,
    auth.user?.puuid,
    personalDashboardQuery.isError,
    playerRegion,
    regionOptions,
    selectedRegion,
  ]);

  const globalMapStatsById = useMemo(
    () => globalMapStatsQuery.data?.mapStats ?? {},
    [globalMapStatsQuery.data?.mapStats],
  );
  const globalMapStatsValues = useMemo(
    () => Object.values(globalMapStatsById),
    [globalMapStatsById],
  );
  const globalPriorWinRate = useMemo(
    () =>
      globalMapStatsValues.length
        ? globalMapStatsValues.reduce(
            (sum, stats) =>
              sum + Number(stats.player_win_rate ?? stats.win_rate ?? 0),
            0,
          ) / globalMapStatsValues.length
        : 50,
    [globalMapStatsValues],
  );
  const globalTotalMatches = globalMapStatsQuery.data?.sampleSize?.matches ?? 0;
  const hasGlobalStatsDataset =
    globalMapStatsQuery.isSuccess && globalMapStatsValues.length > 0;

  const maps = useMemo<MapEntry[]>(() => {
    const data = query.data ?? {};
    const flat = Object.entries(data).flatMap(([backendGroupKey, items]) =>
      (items ?? []).map((item) => {
        const group = classifyValorantMapMode({
          ...item,
          name: item.name ?? backendGroupKey,
        });
        const globalStats =
          globalMapStatsById[getMapStatsKey(item)] ??
          Object.values(globalMapStatsById).find(
            (stats) =>
              normalizeText(stats.map_name) === normalizeText(item.displayName),
          );
        return {
          ...item,
          groupKey: group.key,
          groupLabel: group.label,
          groupOrder: group.sortOrder,
          globalStats,
          computedGlobalStats: regionMapStatsToComputed(
            globalStats,
            globalPriorWinRate,
          ),
        };
      }),
    );
    return flat.sort(
      (a, b) =>
        a.groupOrder - b.groupOrder ||
        a.displayName.localeCompare(b.displayName),
    );
  }, [globalMapStatsById, globalPriorWinRate, query.data]);
  const globalMapCohort = useMemo(
    () =>
      maps
        .map((map) => map.computedGlobalStats)
        .filter((stats): stats is ComputedMapStats => Boolean(stats)),
    [maps],
  );

  const personalStatsByMapKey = useMemo(() => {
    const byKey = new Map<string, ComputedMapStats>();
    for (const map of maps) {
      const stats = calculatePersonalMapStats(
        personalDashboardQuery.data?.analyticsList,
        map,
        { act: actFilter },
        globalPriorWinRate,
      );
      if (stats) byKey.set(getMapStatsKey(map), stats);
    }
    return byKey;
  }, [
    actFilter,
    globalPriorWinRate,
    maps,
    personalDashboardQuery.data?.analyticsList,
  ]);

  useEffect(() => {
    if (!selected) return;
    const fresh = maps.find(
      (map) => getMapStatsKey(map) === getMapStatsKey(selected),
    );
    const hasGlobal = Boolean(
      fresh?.computedGlobalStats?.matches || fresh?.computedGlobalStats?.rounds,
    );
    const hasPersonal = fresh
      ? personalStatsByMapKey.has(getMapStatsKey(fresh))
      : false;
    if (!fresh || (!hasGlobal && !hasPersonal)) {
      const frame = requestAnimationFrame(() => setSelected(null));
      return () => cancelAnimationFrame(frame);
    }
    if (fresh !== selected) {
      const frame = requestAnimationFrame(() => setSelected(fresh));
      return () => cancelAnimationFrame(frame);
    }
  }, [maps, personalStatsByMapKey, selected]);

  const selectedStats = selected?.computedGlobalStats;
  const personalStats = useMemo(
    () =>
      calculatePersonalMapStats(
        personalDashboardQuery.data?.analyticsList,
        selected,
        { act: actFilter },
        globalPriorWinRate,
      ),
    [
      actFilter,
      globalPriorWinRate,
      personalDashboardQuery.data?.analyticsList,
      selected,
    ],
  );
  const comparisonMetrics = useMemo(
    () => buildComparisonMetrics(selectedStats, personalStats, globalMapCohort),
    [globalMapCohort, personalStats, selectedStats],
  );
  const roundTypeShares = useMemo(() => {
    const globalShares = buildRoundCeremonySharesFromGlobal(
      selected?.globalStats,
    );
    if (globalShares.length > 0) return globalShares;
    return calculateRoundTypeShares(
      personalDashboardQuery.data?.analyticsList,
      selected,
      { act: actFilter },
    );
  }, [actFilter, personalDashboardQuery.data?.analyticsList, selected]);
  const selectedGlobalMapKey = selected
    ? globalMapStatsById[getMapStatsKey(selected)]
      ? getMapStatsKey(selected)
      : Object.entries(globalMapStatsById).find(
          ([, stats]) =>
            normalizeText(stats.map_name) ===
            normalizeText(selected.displayName),
        )?.[0]
    : undefined;
  const selectedGlobalMapStats = selectedGlobalMapKey
    ? globalMapStatsById[selectedGlobalMapKey]
    : selected?.globalStats;
  const bestAgents = useMemo(
    () =>
      getBestAgents(
        (selectedGlobalMapKey
          ? globalMapStatsQuery.data?.agentStatsByMap?.[selectedGlobalMapKey]
          : undefined) ?? selectedGlobalMapStats?.agent_stats,
      ),
    [
      globalMapStatsQuery.data?.agentStatsByMap,
      selectedGlobalMapKey,
      selectedGlobalMapStats?.agent_stats,
    ],
  );
  const bestWeapons = useMemo(() => {
    const globalRows = buildBestWeaponsFromGlobal(
      (selectedGlobalMapKey
        ? globalMapStatsQuery.data?.weaponStatsByMap?.[selectedGlobalMapKey]
        : undefined) ?? selectedGlobalMapStats?.weapon_stats,
    );
    if (globalRows.length > 0) return globalRows;
    return buildBestWeaponsForMap(
      personalDashboardQuery.data?.analyticsList,
      selected,
      { act: actFilter },
    );
  }, [
    actFilter,
    globalMapStatsQuery.data?.weaponStatsByMap,
    personalDashboardQuery.data?.analyticsList,
    selected,
    selectedGlobalMapKey,
    selectedGlobalMapStats?.weapon_stats,
  ]);
  const bestCompositions = useMemo(() => {
    const globalRows = buildBestCompositionsFromGlobal(
      (selectedGlobalMapKey
        ? globalMapStatsQuery.data?.compositionsByMap?.[selectedGlobalMapKey]
        : undefined) ?? selectedGlobalMapStats?.composition_stats,
    );
    if (globalRows.length > 0) return globalRows;
    return buildBestCompositionsForMap(
      personalDashboardQuery.data?.analyticsList,
      selected,
      { act: actFilter },
      agentNameById,
    );
  }, [
    actFilter,
    agentNameById,
    globalMapStatsQuery.data?.compositionsByMap,
    personalDashboardQuery.data?.analyticsList,
    selected,
    selectedGlobalMapKey,
    selectedGlobalMapStats?.composition_stats,
  ]);

  const filtered = useMemo(() => {
    const normalizedSearch = normalizeText(search);
    const filteredMaps = maps.filter((map) => {
      const matchesSearch = normalizeText(map.displayName).includes(
        normalizedSearch,
      );
      const matchesMode =
        (modeFilter === COMPETITIVE && map.groupKey === "core") ||
        map.groupKey === modeFilter;
      const hasGlobal = Boolean(
        map.computedGlobalStats?.matches || map.computedGlobalStats?.rounds,
      );
      const hasPersonal = personalStatsByMapKey.has(getMapStatsKey(map));
      const hasStatsForActiveFilters = hasGlobal || hasPersonal;
      return (
        matchesSearch &&
        matchesMode &&
        (hasGlobalStatsDataset ? hasStatsForActiveFilters : true)
      );
    });
    return [...filteredMaps].sort((a, b) => {
      if (sortKey === "name") return a.displayName.localeCompare(b.displayName);
      if (sortKey === "matches")
        return (
          (b.computedGlobalStats?.matches ?? 0) -
            (a.computedGlobalStats?.matches ?? 0) ||
          a.displayName.localeCompare(b.displayName)
        );
      if (sortKey === "winRate")
        return (
          (b.computedGlobalStats?.adjustedWinRate ?? 0) -
            (a.computedGlobalStats?.adjustedWinRate ?? 0) ||
          a.displayName.localeCompare(b.displayName)
        );
      return a.displayName.localeCompare(b.displayName);
    });
  }, [
    hasGlobalStatsDataset,
    maps,
    modeFilter,
    personalStatsByMapKey,
    search,
    sortKey,
  ]);

  const availableModeOptions = useMemo(() => {
    const groupsWithData = new Set(
      maps
        .filter((map) => {
          if (!hasGlobalStatsDataset) return true;
          return (
            Boolean(
              map.computedGlobalStats?.matches ||
              map.computedGlobalStats?.rounds,
            ) || personalStatsByMapKey.has(getMapStatsKey(map))
          );
        })
        .map((map) => map.groupKey),
    );
    return MODE_OPTIONS.filter((option) => {
      if (option.value === COMPETITIVE) return groupsWithData.has("core");
      return groupsWithData.has(option.value as MapModeGroupKey);
    });
  }, [hasGlobalStatsDataset, maps, personalStatsByMapKey]);

  useEffect(() => {
    if (availableModeOptions.some((option) => option.value === modeFilter))
      return;
    const nextMode = availableModeOptions[0]?.value ?? COMPETITIVE;
    const frame = requestAnimationFrame(() => setModeFilter(nextMode));
    return () => cancelAnimationFrame(frame);
  }, [availableModeOptions, modeFilter]);

  const selectedSites = inferSiteCount(selected);
  const activeModeLabel = optionLabel(MODE_OPTIONS, modeFilter);
  const activeFilterItems = [
    search.trim() ? `Busqueda: ${search.trim()}` : null,
    modeFilter !== COMPETITIVE ? `Modo: ${activeModeLabel}` : null,
    selectedRegion ? `Region: ${selectedRegion.toUpperCase()}` : null,
    actFilter !== ALL
      ? `Acto: ${optionLabel(formattedActOptions, actFilter)}`
      : null,
    sortKey !== "name" ? `Orden: ${optionLabel(SORT_OPTIONS, sortKey)}` : null,
  ].filter((item): item is string => Boolean(item));
  const resetFilters = () => {
    setSearch("");
    setModeFilter(COMPETITIVE);
    setActFilter(ALL);
    setSortKey("name");
    regionTouchedRef.current = false;
    setSelectedRegion(
      playerRegion ?? regionOptions.find((option) => option.value)?.value ?? "",
    );
  };
  const restoreDetailScroll = () => {
    const savedScroll = previousScrollBeforeDetailRef.current;
    if (savedScroll === null) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScroll, behavior: "smooth" });
      previousScrollBeforeDetailRef.current = null;
    });
  };
  const handleSelectMap = (map: MapEntry, isActive: boolean) => {
    if (!isActive) previousScrollBeforeDetailRef.current = window.scrollY;
    setSelected(isActive ? null : map);
    if (isActive) restoreDetailScroll();
  };
  const handleCloseMapDetail = () => {
    setSelected(null);
    restoreDetailScroll();
  };
  const showPersonalComparison =
    auth.isLoggedIn && Boolean(personalStats?.matches);
  const showStatsLoading =
    isWaitingForPlayerRegion ||
    regionsQuery.isLoading ||
    globalMapStatsQuery.isLoading ||
    globalMapStatsQuery.isFetching;
  const showSelectedStatsLoading = Boolean(selected) && showStatsLoading;
  const initialMapasLoading =
    query.isLoading ||
    agentsQuery.isLoading ||
    weaponsQuery.isLoading ||
    actsQuery.isLoading ||
    regionsQuery.isLoading ||
    (globalMapStatsQuery.isLoading && !globalMapStatsQuery.data) ||
    isWaitingForPlayerRegion;

  useEffect(() => {
    const updateColumns = () => setMapGridColumns(getMapGridColumns());
    updateColumns();
    window.addEventListener("resize", updateColumns);
    return () => window.removeEventListener("resize", updateColumns);
  }, []);

  useEffect(() => {
    if (!selected || !detailRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!detailRef.current) return;
      const top =
        detailRef.current.getBoundingClientRect().top +
        window.scrollY -
        TOPBAR_OFFSET_PX;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const selectedDetail = selected ? (
    <article ref={detailRef} className="content-detail mapas-detail" id="mapas-detail">
      <button
        className="content-detail-close"
        type="button"
        aria-label="Cerrar detalle"
        onClick={handleCloseMapDetail}
      >
        <span className="content-detail-close-icon" aria-hidden="true" />
      </button>

      <section
        className="mapas-detail-hero"
        style={
          {
            "--map-hero-image": `url("${selected.splash || selected.listViewIconTall || ""}")`,
          } as CSSProperties
        }
      >
        <div className="mapas-detail-hero__content">
          <span className="mapas-section-eyebrow">Detalle del mapa</span>
          <h2 className="content-detail-title">{selected.displayName}</h2>
          <div className="content-badge-row">
            <span className="content-badge">Número de sites: {selectedSites ? `${selectedSites}` : "Sin datos"}</span>
            <span className="content-badge">Región: {selectedRegion ? selectedRegion.toUpperCase() : "Sin datos"}</span>
            <span className="content-badge">Acto: {actFilter !== ALL ? optionLabel(formattedActOptions, actFilter) : "Todos"}</span>
            <span className="content-badge">{selectedStats?.matches ? `${formatCompactNumber(selectedStats.matches)} partidas globales` : "Sin datos globales"}</span>
            <span className="content-badge">{personalStats?.matches ? `${formatCompactNumber(personalStats.matches)} partidas personales` : "Sin datos personales"}</span>
          </div>
        </div>
        {(selected.splash || selected.listViewIconTall) && (
          <img
            className="mapas-detail-hero__image"
            src={selected.splash || selected.listViewIconTall || ""}
            alt={selected.displayName}
            onError={hideBrokenImage}
          />
        )}
      </section>

      <div className="mapas-detail-dashboard">
        <section
          className="mapas-dashboard-card mapas-dashboard-card--map"
        >
          <div className="mapas-section-heading">
            <span>Mapa táctico</span>
            <h3>Callouts en mapa</h3>
          </div>
          <CalloutMap key={getMapStatsKey(selected)} map={selected} />
        </section>

        <aside className="mapas-dashboard-card mapas-dashboard-card--summary">
          <MapRoundTypesCard
            roundTypeShares={roundTypeShares}
            showSelectedStatsLoading={showSelectedStatsLoading}
          />
        </aside>
      </div>

      <section className="mapas-full-stats-card">
        <div className="mapas-section-heading">
          <span>{showPersonalComparison ? "Comparativa" : "Global"}</span>
          <h3>{showPersonalComparison ? "Comparativa completa" : "Detalle estadístico completo"}</h3>
        </div>
        {showSelectedStatsLoading ? (
          <PanelLoading />
        ) : !showPersonalComparison ? (
          <StatGrid stats={selectedStats} totalMatches={globalTotalMatches} />
        ) : (
          <>
            <p className="mapas-panel-helper">{buildComparisonSummary(personalStats, comparisonMetrics)}</p>
            {comparisonMetrics.length === 0 ? (
              <div className="mapas-empty-panel">Sin datos personales o globales comparables para este mapa.</div>
            ) : (
              <div className="mapas-comparison-scroll">
                <ComparisonTable
                  ariaLabel="Comparativa global contra personal"
                  rows={comparisonMetrics.map((metric) => ({
                    key: metric.key,
                    label: metric.label,
                    globalLabel: metric.globalLabel,
                    personalLabel: metric.personalLabel,
                    diffLabel: metric.diffLabel,
                    globalNormalizedLabel: metric.globalNormalizedLabel,
                    personalNormalizedLabel: metric.personalNormalizedLabel,
                    normalizedDiffLabel: metric.normalizedDiffLabel,
                    diffTone: metric.diffLabel === "-" ? "plain" : getMetricTone(metric, "diff"),
                    normalizedDiffTone: (metric.normalizedDiffLabel ?? "-") === "-" ? "plain" : getMetricTone(metric, "normalizedDiff"),
                  }))}
                />
              </div>
            )}
          </>
        )}
      </section>

      <section className="mapas-recommendations">
        <div className="mapas-section-heading">
          <span>Recomendaciones</span>
          <h3>Recomendaciones para este mapa</h3>
        </div>
        <div className="mapas-recommendations-grid">
          <BestAgentsPanel
            bestAgents={bestAgents}
            agentMetaById={agentMetaById}
            showSelectedStatsLoading={showSelectedStatsLoading}
          />
          <BestWeaponsPanel
            bestWeapons={bestWeapons}
            weaponMetaByKey={weaponMetaByKey}
            showSelectedStatsLoading={showSelectedStatsLoading}
          />
          <BestCompositionsPanel
            bestCompositions={bestCompositions}
            agentMetaById={agentMetaById}
            agentMetaByName={agentMetaByName}
            showSelectedStatsLoading={showSelectedStatsLoading}
          />
        </div>
      </section>
    </article>
  ) : null;

  const selectedIndex = selected
    ? filtered.findIndex((map) => getMapStatsKey(map) === getMapStatsKey(selected))
    : -1;
  const selectedDetailInsertIndex =
    selectedIndex >= 0
      ? Math.min(filtered.length - 1, selectedIndex + (mapGridColumns - 1 - (selectedIndex % mapGridColumns)))
      : -1;

  if (initialMapasLoading) {
    return <ContentLoading title="Cargando mapas" />;
  }

  return (
    <ContentShell
      title="Mapas"
      subtitle="Mapas por modo, estadisticas competitivas globales y comparativa personal con ajuste bayesiano cuando hay muestra baja."
    >
      {query.isError && (
        <ContentError
          message="No se pudieron cargar los mapas."
          onRetry={() => query.refetch()}
        />
      )}

      {!query.isError && maps.length === 0 && (
        <ContentEmpty message="No hay mapas disponibles." />
      )}

      {!query.isError && maps.length > 0 && (
        <>
          <section className="mapas-filter-panel" aria-label="Filtros de mapas">
            <div className="mapas-filter-panel__header">
              <div>
                <span>Filtros</span>
                <strong>{filtered.length} mapas encontrados</strong>
              </div>
              <button
                className="mapas-filter-reset"
                type="button"
                onClick={resetFilters}
                disabled={activeFilterItems.length === 0}
              >
                Limpiar
              </button>
            </div>

            <div className="mapas-filter-grid">
              <label className="content-select-label content-select-label--premium mapas-filter-field mapas-filter-field--search">
                Buscar
                <input
                  className="content-search content-search--premium"
                  type="search"
                  placeholder="Nombre del mapa"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="content-select-label content-select-label--premium mapas-filter-field">
                Modo
                <select
                  className="content-select content-select--premium"
                  value={modeFilter}
                  onChange={(event) => setModeFilter(event.target.value)}
                >
                  {availableModeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="content-select-label content-select-label--premium mapas-filter-field">
                Region
                <select
                  className="content-select content-select--premium"
                  value={selectedRegion}
                  onChange={(event) => {
                    regionTouchedRef.current = true;
                    setSelectedRegion(event.target.value);
                  }}
                >
                  {selectedRegion &&
                    !regionOptions.some(
                      (option) => option.value === selectedRegion,
                    ) && (
                      <option value={selectedRegion}>
                        {selectedRegion.toUpperCase()}
                      </option>
                    )}
                  {regionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="content-select-label content-select-label--premium mapas-filter-field">
                Acto
                <select
                  className="content-select content-select--premium"
                  value={actFilter}
                  onChange={(event) => setActFilter(event.target.value)}
                >
                  {formattedActOptions.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="content-select-label content-select-label--premium mapas-filter-field">
                Orden
                <select
                  className="content-select content-select--premium"
                  value={sortKey}
                  onChange={(event) =>
                    setSortKey(event.target.value as SortKey)
                  }
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mapas-active-filters" aria-live="polite">
              {activeFilterItems.length > 0 ? (
                activeFilterItems.map((item) => <span key={item}>{item}</span>)
              ) : (
                <span>Sin filtros adicionales</span>
              )}
            </div>
          </section>

          {showStatsLoading && (
            <LoadingModal placement="overlay" />
          )}

          {globalMapStatsQuery.isError && (
            <ContentError
              message="No se pudieron cargar las estadísticas globales. Los mapas siguen disponibles."
              onRetry={() => globalMapStatsQuery.refetch()}
            />
          )}

          {filtered.length === 0 ? (
            <ContentEmpty message="No hay mapas con ese filtro." />
          ) : (
            <ContentSection title={activeModeLabel}>
              <div className="content-grid mapas-grid">
                {filtered.map((map, index) => {
                  const active = selected?.displayName === map.displayName;
                  const stats =
                    map.computedGlobalStats ??
                    personalStatsByMapKey.get(getMapStatsKey(map));
                  return (
                    <Fragment key={`${map.groupKey}-${map.uuid ?? map.displayName}`}>
                      <button
                        className={`content-card mapas-card ${active ? "active" : ""}`}
                        type="button"
                        aria-expanded={active}
                        aria-controls={active ? "mapas-detail" : undefined}
                        onClick={() => handleSelectMap(map, active)}
                      >
                        {(map.displayIcon || map.splash) && (
                          <span className="content-card-image-wrap mapas-card-image-wrap">
                            <img
                              className="content-card-image"
                              src={map.displayIcon || map.splash || ""}
                              alt={map.displayName}
                              loading="lazy"
                              onError={hideBrokenImage}
                            />
                          </span>
                        )}
                        <h2 className="content-card-title">{map.displayName}</h2>
                        <p className="content-card-meta">
                          {stats?.matches
                            ? `${formatCompactNumber(stats.matches)} partidas${map.computedGlobalStats ? "" : " personales"}`
                            : "Sin estadisticas"}
                        </p>
                        <p className="content-card-meta">
                          WR ajustado {formatMaybePercent(stats?.adjustedWinRate)}
                        </p>
                      </button>
                      {index === selectedDetailInsertIndex && selectedDetail && (
                        <div className="mapas-detail-grid-item">
                          {selectedDetail}
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            </ContentSection>
          )}
        </>
      )}
    </ContentShell>
  );
}


