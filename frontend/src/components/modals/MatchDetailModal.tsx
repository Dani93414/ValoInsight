import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  Circle,
  Clock3,
  Crosshair,
  Info,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  StepForward,
  Wrench,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useMatchById,
  useMatchEconomyMl,
  useAgentes,
  useArmas,
  useMapasGeo,
  useCompetitiveTiers,
} from "../../api/hooks";
import LoadingModal from "../ui/LoadingModal";
import {
  safeDivide,
  formatDateTime,
  normalizeArrayResponse,
  formatNumber,
  formatPercent,
} from "../../utils/formatters";
import {
  getRankNameFromTier,
  applyUnrankedRankIconFallback,
  resolveCompetitiveTierIcon,
} from "../../utils/rankUtils";
import {
  analyzeEconomyEfficiency,
  classifyTeamEconomy,
} from "../../utils/analytics/economyDecision";
import type {
  EconomyEfficiency,
  EconomyEfficiencyAnalysis,
} from "../../utils/analytics/economyDecision";
import {
  BALANCED_THRESHOLD,
  DECISIVE_IMPACT_THRESHOLD,
  HIGH_IMPACT_THRESHOLD,
  MEDIUM_IMPACT_THRESHOLD,
  calculateMatchMomentum,
} from "../../utils/analytics/momentum";
import type {
  MatchMomentumResult,
  MomentumInputRound,
} from "../../utils/analytics/momentum";
import { calculateRoundPlayerImpacts } from "../../utils/analytics/playerRoundImpact";
import type {
  PlayerRoundImpactBreakdown,
  RoundPlayerImpactResult,
} from "../../utils/analytics/playerRoundImpact";
import { analyzeAdvancedMomentum } from "../../utils/analytics/advancedMomentum";
import type {
  AdvancedMomentumResult,
  AdvancedMomentumRound,
  MomentumEvent,
} from "../../utils/analytics/advancedMomentum";
import type { AgentContent } from "../../types/agents";
import type { Arma } from "../../types/weapons";
import type {
  RawLocation,
  RawMatchDetail,
  RawPlayer,
  RawPlayerLocation,
  RawRound,
  EconomyMlResponse,
} from "../../types/matches";
import { TRADE_WINDOW_MS } from "../../constants/stats";
import {
  collectRoundKills,
  isEnemyDamage,
  isValidKill,
  validAssistants,
} from "../../utils/stats/combatEvents";
import {
  resolveKillDamageSource,
  shouldSuppressKillConnectionLine,
} from "../../utils/damageAttribution";
import "./DetailModals.css";

type Props = {
  matchId: string;
  playerId: string;
  agentNameMap: Record<string, string>;
  onClose: () => void;
};

type MapGeoContent = {
  uuid?: string;
  displayName?: string;
  displayIcon?: string | null;
  xMultiplier?: number;
  xScalarToAdd?: number;
  yMultiplier?: number;
  yScalarToAdd?: number;
};

type CompetitiveTierContent = {
  tier?: number | string | null;
  tierName?: string;
  smallIcon?: string;
  largeIcon?: string;
};

type SideKey = "attack" | "defense";
type MatchDetailSection =
  | "summary"
  | "classification"
  | "rounds"
  | "duels"
  | "economy";
type TeamScoreboardMode = "grouped" | "combined";
type ScoreboardSideFilter = "all" | "attack" | "defense";
type WeaponCatalogEntry = {
  id: string;
  displayName: string;
  displayIcon?: string | null;
};

type KillRoundEvent = {
  id: string;
  kind: "kill";
  roundNum: number;
  timeMs: number;
  killer?: string;
  victim?: string;
  killerName: string;
  victimName: string;
  killerIcon?: string;
  victimIcon?: string;
  weaponId?: string;
  weaponName: string;
  weaponIcon?: string | null;
  damageType?: string;
  damageSourceType?: "weapon" | "ability" | "melee" | "fall" | "bomb" | "unknown";
  abilityId?: string;
  abilityName?: string;
  abilityIcon?: string | null;
  isAbilityKill?: boolean;
  suppressConnectionLine?: boolean;
  playerLocations: RawPlayerLocation[];
  killerLocation?: RawLocation;
  victimLocation?: RawLocation;
  isPlayerKill: boolean;
  isPlayerDeath: boolean;
  isValidKill: boolean;
  isOpening: boolean;
  isTrade: boolean;
};

type ObjectiveRoundEvent = {
  id: string;
  kind: "plant" | "defuse";
  roundNum: number;
  timeMs: number;
  actor?: string;
  actorName: string;
  site?: string;
  location?: RawLocation;
  playerLocations: RawPlayerLocation[];
};

type RoundEvent = KillRoundEvent | ObjectiveRoundEvent;

type RoundSummary = {
  roundNum: number;
  side: SideKey;
  didWin: boolean;
  winningTeam: string;
  roundResult: string;
  roundCeremony: string;
  playerKills: number;
  playerDeaths: number;
  playerAssists: number;
  playerScore: number;
  playerSpent: number;
  playerLoadout: number;
  teamSpent: number;
  teamLoadout: number;
  buyType: EconomyBuyType;
  playerDamage: number;
  playerWasTraded: boolean;
  hadPlant: boolean;
  hadDefuse: boolean;
  events: RoundEvent[];
};

type SideSummary = {
  key: SideKey;
  label: string;
  rounds: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  spent: number;
  loadout: number;
  kd: number;
  kda: number;
  winRate: number;
  killsPerRound: number;
  avgSpent: number;
  avgLoadout: number;
};

type WeaponSummary = {
  id: string;
  name: string;
  icon?: string | null;
  kills: number;
};

type MatchAnalysis = {
  rounds: RoundSummary[];
  totalRounds: number;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  kd: number;
  kda: number;
  killsPerRound: number;
  totalDamage: number;
  adr: number;
  acs: number;
  kastPct: number;
  headshotPct: number;
  survivalRounds: number;
  survivalPct: number;
  multikillRounds: number;
  maxKillsInRound: number;
  roundsWon: number;
  roundsWonWithImpact: number;
  winRoundParticipationPct: number;
  tradeKills: number;
  openingWon: number;
  openingLost: number;
  roundsWithKills: number;
  topWeapons: WeaponSummary[];
  bestRound: RoundSummary | null;
  sideSummary: SideSummary[];
  totalSpent: number;
  avgSpent: number;
  avgLoadout: number;
  ecoRounds: number;
  ecoWins: number;
  fullBuyRounds: number;
  fullBuyWins: number;
  insights: string[];
};

type AverageTeamRank = {
  tier: number | null;
  name: string;
  icon: string | null;
};

type PlayerScoreboardStats = {
  player: RawPlayer;
  puuid: string;
  teamId: string;
  agentName: string;
  agentIcon?: string | null;
  rankTier?: number | null;
  rankName: string;
  rankIcon?: string | null;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  rounds: number;
  acs: number;
  kd: number;
  plusMinus: number;
  damageDealt: number;
  damageReceived: number;
  damageDelta: number;
  adr: number;
  headshots: number;
  bodyshots: number;
  legshots: number;
  hsPct: number;
  kastRounds: number;
  kastPct: number;
  firstKills: number;
  firstDeaths: number;
  multikillRounds: number;
};

type RoundTeamLoadout = {
  roundNum: number;
  teamAValue: number;
  teamBValue: number;
  teamASpent: number;
  teamBSpent: number;
  teamACredits: number;
  teamBCredits: number;
  teamAWon: boolean;
  teamBWon: boolean;
  hadPlant: boolean;
  hadDefuse: boolean;
};

type TeamEconomySummary = {
  key: "teamA" | "teamB";
  label: string;
  totalLoadout: number;
  avgLoadout: number;
  totalSpent: number;
  avgSpent: number;
  buyTypes: Record<EconomyBuyType, { rounds: number; wins: number; winRate: number }>;
};

type EconomyBuyType = "eco" | "semiEco" | "fullBuy";
type RoundWinCondition = "elimination" | "defuse" | "time" | "fallback";

type PlayerDuelCell = {
  key: string;
  teamAPlayer: RawPlayer;
  teamBPlayer: RawPlayer;
  teamAKillsOnB: number;
  teamBKillsOnA: number;
  total: number;
  leader: "teamA" | "teamB" | "tie";
  events: RoundEvent[];
};

type RoundScoreboardRow = {
  playerId: string;
  teamId: string;
  agentName: string;
  agentIcon?: string;
  playerName: string;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  loadout: number;
  spent: number;
  weaponName?: string;
  armorName?: string;
};

type PartyMarker = {
  partyId: string;
  color: string;
};

type MatchPerspective = {
  selectedPlayer: RawPlayer;
  selectedPlayerId: string;
  selectedTeamId: string;
  opponentTeamId: string;
  teamAId: string;
  teamBId: string;
  teamALabel: "Team A";
  teamBLabel: "Team B";
  selectedPlayerTeamLabel: "Team A" | "Team B";
  selectedTeamKey: "teamA" | "teamB";
  opponentTeamKey: "teamA" | "teamB";
};

const matchDetailSections = [
  { key: "summary", label: "Resumen" },
  { key: "classification", label: "Tabla de clasificación" },
  { key: "rounds", label: "Rondas" },
  { key: "duels", label: "Duelos" },
  { key: "economy", label: "Economía" },
] as const satisfies ReadonlyArray<{
  key: MatchDetailSection;
  label: string;
}>;

const economyBuyLabels: Record<EconomyBuyType, string> = {
  eco: "ECO",
  semiEco: "SEMIECO",
  fullBuy: "FULL",
};

const economyBuyColors: Record<EconomyBuyType, string> = {
  eco: "#ff4655",
  semiEco: "#f3c567",
  fullBuy: "#46c878",
};

type MapTransform = {
  xMultiplier: number;
  xScalarToAdd: number;
  yMultiplier: number;
  yScalarToAdd: number;
};

type EventMapMarker = {
  id: string;
  x: number;
  y: number;
  label: string;
  icon?: string;
  actorIcon?: string;
  actorLabel?: string;
  weaponIcon?: string | null;
  weaponLabel?: string;
  deathIcon?: string;
  objectiveIcon?: "plant" | "defuse";
  team: "ally" | "enemy" | "neutral";
  kind: "player" | "victim" | "objective";
  isTarget: boolean;
  facingRadians?: number;
};

type EventMapState = {
  markers: EventMapMarker[];
  hasSnapshot: boolean;
};

type MatchResultState = "win" | "loss" | "draw";

const WEAPON_ICON_ID_RE = /\/content\/weapons\/([^/]+)\/displayIcon\.png/i;
const PARTY_MARKER_COLORS = [
  "#f5c451",
  "#a78bfa",
  "#60a5fa",
  "#fb7185",
  "#34d399",
  "#f97316",
  "#22d3ee",
  "#e879f9",
] as const;

function cleanId(value?: string | null): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.toLowerCase() === "string") return "";
  return text;
}

function buildPartyMarkerMap(players: RawPlayer[]): Map<string, PartyMarker> {
  const playersByParty = new Map<string, Set<string>>();

  for (const player of players) {
    const partyId = cleanId(player.partyId);
    const puuid = cleanId(player.puuid);
    if (!partyId || !puuid) continue;

    const partyPlayers = playersByParty.get(partyId) ?? new Set<string>();
    partyPlayers.add(puuid);
    playersByParty.set(partyId, partyPlayers);
  }

  const markerByPuuid = new Map<string, PartyMarker>();
  [...playersByParty.entries()]
    .filter(([, puuids]) => puuids.size >= 2)
    .sort(([partyA], [partyB]) => partyA.localeCompare(partyB))
    .forEach(([partyId, puuids], index) => {
      const marker = {
        partyId,
        color: PARTY_MARKER_COLORS[index % PARTY_MARKER_COLORS.length],
      };
      puuids.forEach((puuid) => markerByPuuid.set(puuid, marker));
    });

  return markerByPuuid;
}

function cleanSite(value?: string | null): string | undefined {
  const site = cleanId(value);
  return site || undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toSecondsLabel(ms?: number): string {
  const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function toGameDurationLabel(ms?: number): string {
  const millis = toNumber(ms);
  if (!millis) return "";
  const hours = millis / 3_600_000;
  const formattedHours = Number.isInteger(hours)
    ? String(hours)
    : hours.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formattedHours} h`;
}

function formatQueueLabel(queueId?: string | null): string {
  const queue = cleanId(queueId).toLowerCase();
  if (!queue || queue === "standard") return "";
  if (queue === "competitive") return "Competitivo";
  if (queue === "unrated") return "No competitivo";
  if (queue === "swiftplay") return "Swiftplay";
  return queue.charAt(0).toUpperCase() + queue.slice(1);
}

function getWeaponIdFromIcon(icon?: string | null): string {
  if (!icon) return "";
  const match = icon.match(WEAPON_ICON_ID_RE);
  return cleanId(match?.[1]);
}

function determineRoundSide(teamId: string, roundNum: number): SideKey {
  const isRed = teamId.toLowerCase() === "red";

  if (roundNum < 12) {
    return isRed ? "attack" : "defense";
  }
  if (roundNum < 24) {
    return isRed ? "defense" : "attack";
  }

  const overtimeSet = Math.floor((roundNum - 24) / 2);
  const redAttacks = overtimeSet % 2 === 0;
  if (redAttacks) {
    return isRed ? "attack" : "defense";
  }
  return isRed ? "defense" : "attack";
}

function getMvp(currentMatch: RawMatchDetail) {
  const players = currentMatch.players ?? [];
  if (players.length === 0) return null;

  return [...players].sort((a, b) => {
    const scoreA = a.stats?.score ?? 0;
    const scoreB = b.stats?.score ?? 0;
    return scoreB - scoreA;
  })[0];
}

function getPlayerDisplay(player?: RawPlayer | null) {
  if (!player) return "Unknown";
  if (player.gameName && player.tagLine) {
    return `${player.gameName}#${player.tagLine}`;
  }
  return player.gameName ?? "Unknown";
}

function getPlayerShortDisplay(player?: RawPlayer | null) {
  if (!player) return "Unknown";
  return player.gameName?.trim() || getPlayerDisplay(player);
}

function compareScoreboardPlayers(
  a: PlayerScoreboardStats,
  b: PlayerScoreboardStats,
): number {
  return (
    b.acs - a.acs ||
    b.kd - a.kd ||
    b.kills - a.kills ||
    b.score - a.score
  );
}

function getAverageTeamRank(
  players: RawPlayer[],
  tierByNumber: Map<number, CompetitiveTierContent>,
): AverageTeamRank {
  const tiers = players
    .map((player) => Number(player.competitiveTier))
    .filter((tier) => Number.isFinite(tier) && tier > 0);

  if (tiers.length === 0) {
    return {
      tier: null,
      name: "Sin rango",
      icon: resolveCompetitiveTierIcon(null, null, [...tierByNumber.values()]),
    };
  }

  const tier = Math.round(
    tiers.reduce((sum, current) => sum + current, 0) / tiers.length,
  );
  const tierAsset = tierByNumber.get(tier);
  return {
    tier,
    name: getRankNameFromTier(tier),
    icon: resolveCompetitiveTierIcon(
      tier,
      tierAsset?.smallIcon ?? tierAsset?.largeIcon ?? null,
      [...tierByNumber.values()],
    ),
  };
}

function getAgentMeta(
  player: RawPlayer | null | undefined,
  agentById: Map<string, AgentContent>,
  agentNameMap: Record<string, string>,
) {
  const agentId = cleanId(player?.characterId);
  const agent = agentId ? agentById.get(agentId) : undefined;
  return {
    agentId,
    name: agent?.displayName ?? agentNameMap[agentId] ?? "Agente desconocido",
    icon: agent?.displayIconSmall ?? agent?.displayIcon ?? null,
  };
}

function toMapTransform(mapMeta: MapGeoContent | null): MapTransform | null {
  if (
    !mapMeta ||
    mapMeta.xMultiplier === undefined ||
    mapMeta.xScalarToAdd === undefined ||
    mapMeta.yMultiplier === undefined ||
    mapMeta.yScalarToAdd === undefined
  ) {
    return null;
  }

  const transform = {
    xMultiplier: Number(mapMeta.xMultiplier),
    xScalarToAdd: Number(mapMeta.xScalarToAdd),
    yMultiplier: Number(mapMeta.yMultiplier),
    yScalarToAdd: Number(mapMeta.yScalarToAdd),
  };

  if (
    !Number.isFinite(transform.xMultiplier) ||
    !Number.isFinite(transform.xScalarToAdd) ||
    !Number.isFinite(transform.yMultiplier) ||
    !Number.isFinite(transform.yScalarToAdd)
  ) {
    return null;
  }

  return transform;
}

function transformLocation(
  location: RawLocation | undefined,
  transform: MapTransform | null,
): { x: number; y: number } | null {
  if (!location || !transform) return null;
  if (location.x === undefined || location.y === undefined) return null;

  const gameX = Number(location.x);
  const gameY = Number(location.y);
  if (!Number.isFinite(gameX) || !Number.isFinite(gameY)) return null;

  const normalizedX = gameY * transform.xMultiplier + transform.xScalarToAdd;
  const normalizedY = gameX * transform.yMultiplier + transform.yScalarToAdd;
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(1, normalizedX)),
    y: Math.max(0, Math.min(1, normalizedY)),
  };
}

function transformViewRadians(
  viewRadians: number | undefined,
  transform: MapTransform | null,
): number | undefined {
  if (!Number.isFinite(viewRadians)) return undefined;
  return Math.atan2(
    Math.cos(Number(viewRadians)) * (transform?.yMultiplier ?? 1),
    Math.sin(Number(viewRadians)) * (transform?.xMultiplier ?? 1),
  );
}

function roundLabel(roundNum: number): string {
  return `Ronda ${roundNum + 1}`;
}

function getEventDescription(event: RoundEvent): string {
  if (event.kind === "kill") {
    return `${event.killerName} eliminó a ${event.victimName}`;
  }
  return `${event.actorName} ha ${
    event.kind === "plant" ? "plantado" : "defusado"
  }`;
}

function classifyRoundEconomy(teamSpent: number, teamLoadout: number): EconomyBuyType {
  const economyType = classifyTeamEconomy(teamLoadout || teamSpent);
  if (economyType === "FULL") return "fullBuy";
  if (economyType === "SEMIECO") return "semiEco";
  return "eco";
}

function getRoundWinCondition(round: RoundSummary): RoundWinCondition {
  const text = `${round.roundResult} ${round.roundCeremony}`.toLowerCase();

  if (round.hadDefuse || text.includes("defuse") || text.includes("defused")) {
    return "defuse";
  }
  if (
    text.includes("time") ||
    text.includes("timeout") ||
    text.includes("expired") ||
    text.includes("detonate") ||
    text.includes("spike")
  ) {
    return "time";
  }
  if (
    text.includes("elim") ||
    text.includes("kill") ||
    text.includes("ace") ||
    text.includes("flawless") ||
    text.includes("survived")
  ) {
    return "elimination";
  }
  return "fallback";
}

function getRoundWinIcon(condition: RoundWinCondition): LucideIcon {
  if (condition === "defuse") return Wrench;
  if (condition === "time") return Clock3;
  if (condition === "elimination") return Crosshair;
  return Circle;
}

function getTeamScoreState(
  currentMatch: RawMatchDetail | null,
  playerTeam: string,
): {
  selectedTeamRounds: number;
  opponentTeamRounds: number;
  resultState: MatchResultState;
} {
  const teams = currentMatch?.teams ?? [];
  const selectedTeamInfo =
    teams.find((team) => cleanId(team.teamId) === playerTeam) ?? null;
  const opponentTeamInfo =
    teams.find((team) => cleanId(team.teamId) !== playerTeam) ?? null;

  const selectedRoundsFromTeam = toNumber(selectedTeamInfo?.roundsWon);
  const opponentRoundsFromTeam = toNumber(opponentTeamInfo?.roundsWon);
  const selectedRoundsLost = toNumber(selectedTeamInfo?.roundsLost);
  let countedSelectedRounds = 0;
  let countedOpponentRounds = 0;

  for (const round of currentMatch?.roundResults ?? []) {
    const winningTeam = cleanId(round.winningTeam);
    if (!winningTeam) continue;
    if (winningTeam === playerTeam) {
      countedSelectedRounds += 1;
    } else {
      countedOpponentRounds += 1;
    }
  }

  const selectedTeamRounds = selectedRoundsFromTeam || countedSelectedRounds;
  let opponentTeamRounds = opponentRoundsFromTeam;

  if (!opponentTeamRounds && selectedRoundsLost > 0) {
    opponentTeamRounds = selectedRoundsLost;
  }

  if (!opponentTeamRounds && countedOpponentRounds > 0) {
    opponentTeamRounds = countedOpponentRounds;
  }

  const resultState: MatchResultState =
    selectedTeamRounds === opponentTeamRounds
      ? "draw"
      : selectedTeamRounds > opponentTeamRounds
        ? "win"
        : "loss";

  return { selectedTeamRounds, opponentTeamRounds, resultState };
}

function getTeamRoundsWon(currentMatch: RawMatchDetail | null, teamId: string): number {
  const teamInfo =
    currentMatch?.teams?.find((team) => cleanId(team.teamId) === teamId) ?? null;
  const roundsFromTeam = toNumber(teamInfo?.roundsWon);
  if (roundsFromTeam > 0) return roundsFromTeam;

  return (currentMatch?.roundResults ?? []).filter(
    (round) => cleanId(round.winningTeam) === teamId,
  ).length;
}

function buildRoundTeamLoadoutTimeline(
  currentMatch: RawMatchDetail,
  playersByTeam: Array<[string, RawPlayer[]]>,
): RoundTeamLoadout[] {
  const teamAId = cleanId(playersByTeam[0]?.[0]);
  const teamBId = cleanId(playersByTeam[1]?.[0]);
  const playerTeamByPuuid = new Map<string, string>();

  for (const [teamId, teamPlayers] of playersByTeam) {
    for (const player of teamPlayers) {
      const puuid = cleanId(player.puuid);
      if (puuid) playerTeamByPuuid.set(puuid, cleanId(teamId));
    }
  }

  return (currentMatch.roundResults ?? []).map((round, index) => {
    const roundNum = Number.isFinite(round.roundNum)
      ? Number(round.roundNum)
      : index;
    let teamAValue = 0;
    let teamBValue = 0;
    let teamASpent = 0;
    let teamBSpent = 0;
    let teamACredits = 0;
    let teamBCredits = 0;

    for (const stat of round.playerStats ?? []) {
      const puuid = cleanId(stat.puuid);
      const teamId = puuid ? playerTeamByPuuid.get(puuid) : "";
      const loadoutValue = toNumber(stat.economy?.loadoutValue);
      const spent = toNumber(stat.economy?.spent);
      const remaining = toNumber(stat.economy?.remaining);
      if (teamId === teamAId) {
        teamAValue += loadoutValue;
        teamASpent += spent;
        teamACredits += remaining;
      }
      if (teamId === teamBId) {
        teamBValue += loadoutValue;
        teamBSpent += spent;
        teamBCredits += remaining;
      }
    }

    const winningTeam = cleanId(round.winningTeam);
    return {
      roundNum,
      teamAValue,
      teamBValue,
      teamASpent,
      teamBSpent,
      teamACredits,
      teamBCredits,
      teamAWon: Boolean(teamAId) && winningTeam === teamAId,
      teamBWon: Boolean(teamBId) && winningTeam === teamBId,
      hadPlant: Boolean(cleanId(round.bombPlanter)),
      hadDefuse: Boolean(cleanId(round.bombDefuser)),
    };
  });
}

function MatchLoadoutTimeline({
  data,
  teamALabel,
  teamBLabel,
}: {
  data: RoundTeamLoadout[];
  teamALabel: string;
  teamBLabel: string;
}) {
  const globalMax = Math.max(
    ...data.flatMap((round) => [round.teamAValue, round.teamBValue]),
    0,
  );

  return (
    <section className="match-loadout-timeline-panel">
      <div className="match-loadout-timeline-header">
        <div>
          <h4>Comparativa de equipamiento por ronda</h4>
          <p>Valor total de equipamiento por equipo antes de cada ronda.</p>
        </div>
        <div className="match-loadout-legend" aria-label="Leyenda de equipamiento">
          <span><i className="is-team-a" /> {teamALabel}</span>
          <span><i className="is-team-b" /> {teamBLabel}</span>
        </div>
      </div>

      {data.length === 0 || globalMax <= 0 ? (
        <div className="empty-chart">No hay datos de equipamiento por ronda.</div>
      ) : (
        <div className="match-loadout-timeline-scroll">
          {data.map((round) => {
            const winner = round.teamAWon
              ? teamALabel
              : round.teamBWon
                ? teamBLabel
                : "Empate";
            const teamAHeight = Math.max(6, safeDivide(round.teamAValue, globalMax) * 100);
            const teamBHeight = Math.max(6, safeDivide(round.teamBValue, globalMax) * 100);

            return (
              <article
                key={`loadout-${round.roundNum}`}
                className={`match-loadout-round ${
                  round.teamAWon ? "is-team-a-win" : round.teamBWon ? "is-team-b-win" : ""
                }`}
                title={`${roundLabel(round.roundNum)} · ${teamALabel} ${formatNumber(
                  round.teamAValue,
                )} · ${teamBLabel} ${formatNumber(round.teamBValue)} · Ganó ${winner}`}
              >
                <span className="match-loadout-round-number">
                  {round.roundNum + 1}
                </span>
                <div className="match-loadout-bars" aria-hidden="true">
                  <span
                    className="match-loadout-bar match-loadout-bar--team-a"
                    style={{ height: `${teamAHeight}%` }}
                  />
                  <span
                    className="match-loadout-bar match-loadout-bar--team-b"
                    style={{ height: `${teamBHeight}%` }}
                  />
                </div>
                <span className="match-loadout-round-meta">
                  {round.hadPlant && <em>P</em>}
                  {round.hadDefuse && <em>DEF</em>}
                </span>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function getStableTeamEntries(currentMatch: RawMatchDetail | null): Array<[string, RawPlayer[]]> {
  const players = currentMatch?.players ?? [];
  const grouped = new Map<string, RawPlayer[]>();
  const order: string[] = [];

  for (const team of currentMatch?.teams ?? []) {
    const teamId = cleanId(team.teamId);
    if (teamId && !grouped.has(teamId)) {
      grouped.set(teamId, []);
      order.push(teamId);
    }
  }

  for (const player of players) {
    const teamId = cleanId(player.teamId) || "Sin equipo";
    if (!grouped.has(teamId)) {
      grouped.set(teamId, []);
      order.push(teamId);
    }
    grouped.get(teamId)?.push(player);
  }

  return order.map((teamId) => [teamId, grouped.get(teamId) ?? []]);
}

function buildMatchPerspective(
  currentMatch: RawMatchDetail | null,
  selectedPlayerId: string,
): MatchPerspective | null {
  const teamEntries = getStableTeamEntries(currentMatch);
  const teamAId = cleanId(teamEntries[0]?.[0]);
  const teamBId = cleanId(teamEntries[1]?.[0]);
  const players = currentMatch?.players ?? [];
  const selectedPlayer =
    players.find((player) => cleanId(player.puuid) === selectedPlayerId) ??
    players.find((player) => cleanId(player.puuid)) ??
    null;
  if (!selectedPlayer || !teamAId || !teamBId) return null;

  const resolvedSelectedPlayerId = cleanId(selectedPlayer.puuid);
  const selectedTeamId = cleanId(selectedPlayer.teamId);
  const selectedTeamKey = selectedTeamId === teamBId ? "teamB" : "teamA";
  const opponentTeamKey = selectedTeamKey === "teamA" ? "teamB" : "teamA";
  const opponentTeamId = opponentTeamKey === "teamA" ? teamAId : teamBId;

  return {
    selectedPlayer,
    selectedPlayerId: resolvedSelectedPlayerId,
    selectedTeamId,
    opponentTeamId,
    teamAId,
    teamBId,
    teamALabel: "Team A",
    teamBLabel: "Team B",
    selectedPlayerTeamLabel: selectedTeamKey === "teamA" ? "Team A" : "Team B",
    selectedTeamKey,
    opponentTeamKey,
  };
}

type RoundMomentumImpactLevel = "low" | "medium" | "high" | "decisive";
type RoundMomentumDominance = "selected" | "opponent" | "neutral";
type RoundMomentumReason =
  | "economy"
  | "individual_play"
  | "first_blood"
  | "streak"
  | "side_switch"
  | "objective"
  | "multikill"
  | "clutch"
  | "carry_drop"
  | "activation"
  | "normal";
type RoundMomentumTone = "positive" | "negative" | "neutral";
type RoundMomentumTicketEvent = {
  id: string;
  label: string;
  detail: string;
  teamLabel: "Tu equipo" | "Rival";
  contribution: number;
  isContext?: boolean;
};
type RoundMomentumTicketPlayer = {
  playerId: string;
  playerName: string;
  agentName?: string;
  agentIcon?: string | null;
  teamLabel: "Tu equipo" | "Rival";
  contribution: number;
  breakdown: Array<{ label: string; value: number }>;
};
type RoundMomentumTimelineItem = {
  id: string;
  label: string;
  detail: string;
  timeMs?: number;
  tone: RoundMomentumTone;
};

type RoundMomentumViewModel = {
  roundNumber: number;
  winningTeamId: string;
  isSelectedTeamWin: boolean;
  momentumBefore: number;
  momentumAfter: number;
  momentumChange: number;
  roundImpact: number;
  impactLevel: RoundMomentumImpactLevel;
  dominanceBefore: RoundMomentumDominance;
  dominanceAfter: RoundMomentumDominance;
  selectedTeamEconomy?: string;
  opponentTeamEconomy?: string;
  selectedTeamLoadout?: number;
  opponentTeamLoadout?: number;
  loadoutDiff?: number;
  mainReason: RoundMomentumReason;
  eventIcon?: "economy" | "clutch" | "multikill" | "first_blood" | "defuse" | "side_switch" | "up" | "down";
  eventPerspective: "Tu equipo" | "Rival" | "Ronda";
  eventTitle: string;
  eventDescription: string;
  roundType: string;
  shortComment: string;
  consequence: string;
  secondaryEvents: Array<{ type: MomentumEvent["type"]; label: string }>;
  ticketEvents: RoundMomentumTicketEvent[];
  ticketPlayers: RoundMomentumTicketPlayer[];
  timeline: RoundMomentumTimelineItem[];
  confidenceLabel: string;
  evidences: string[];
  learning?: string;
  beforeItems: Array<{ label: string; value: string; tone?: RoundMomentumTone }>;
  duringItems: Array<{ label: string; value: string; tone?: RoundMomentumTone }>;
  afterItems: Array<{ label: string; value: string; tone?: RoundMomentumTone }>;
  selectedPlayerContribution: {
    title: string;
    description: string;
    tone: RoundMomentumTone;
    stats?: Array<{ label: string; value: string }>;
  };
  confidence: "high" | "medium" | "low";
  confidenceReason?: string;
  sourceEvent?: MomentumEvent;
  isKeyRound: boolean;
  winnerLabel: string;
  winMethod?: string;
};

function dominanceFromMomentum(value: number): RoundMomentumDominance {
  if (value >= BALANCED_THRESHOLD) return "selected";
  if (value <= -BALANCED_THRESHOLD) return "opponent";
  return "neutral";
}

function dominanceLabel(dominance: RoundMomentumDominance): string {
  if (dominance === "selected") return "Tu equipo";
  if (dominance === "opponent") return "Rival";
  return "Equilibrio";
}

function impactLevelFromValue(value: number): RoundMomentumImpactLevel {
  const abs = Math.abs(value);
  if (abs >= DECISIVE_IMPACT_THRESHOLD) return "decisive";
  if (abs >= HIGH_IMPACT_THRESHOLD) return "high";
  if (abs >= MEDIUM_IMPACT_THRESHOLD) return "medium";
  return "low";
}

function impactLevelLabel(level: RoundMomentumImpactLevel): string {
  if (level === "decisive") return "Decisivo";
  if (level === "high") return "Alto";
  if (level === "medium") return "Medio";
  return "Bajo";
}

function formatMomentumDelta(value: number): string {
  if (Math.abs(value) < 0.05) return "sin cambio claro";
  return value > 0
    ? `+${formatNumber(value, 1)} para tu equipo`
    : `${formatNumber(value, 1)} hacia el rival`;
}

function formatMomentumContribution(value: number): string {
  if (!Number.isFinite(value)) return "0";

  const sign = value < 0 ? "-" : "";
  const maxDecimals = 4;
  const factor = 10 ** maxDecimals;
  const truncated = Math.trunc(Math.abs(value) * factor) / factor;

  return `${sign}${new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(truncated)}`;
}

function getMomentumEventCategory(event: RoundMomentumTicketEvent): string {
  const text = `${event.id} ${event.label}`.toLowerCase();
  if (text.includes("defuse") || text.includes("spike") || text.includes("plant")) return "Objetivo";
  if (text.includes("trade")) return "Trade";
  if (text.includes("opening") || text.includes("apertura") || text.includes("primera")) return "Apertura";
  if (text.includes("clutch") || text.includes("remontada")) return "Clutch";
  if (text.includes("eco") || text.includes("compra") || text.includes("loadout")) return "Economía";
  if (text.includes("racha") || text.includes("crítica") || event.isContext) return "Contexto";
  return "Combate";
}

function formatRoundTimelineTime(timeMs?: number): string {
  if (!Number.isFinite(timeMs)) return "Contexto";
  return `${(Math.max(0, timeMs ?? 0) / 1000).toFixed(1)}s`;
}

function getRoundWinMethod(roundResult?: string, roundCeremony?: string): string | undefined {
  const text = `${roundResult ?? ""} ${roundCeremony ?? ""}`.toLowerCase();
  if (text.includes("defuse") || text.includes("defused")) return "Defuse";
  if (text.includes("detonate") || text.includes("spike")) return "Spike";
  if (text.includes("time") || text.includes("expired")) return "Tiempo";
  if (text.includes("elim") || text.includes("kill") || text.includes("ace")) return "Eliminación";
  return cleanId(roundResult) || cleanId(roundCeremony) || undefined;
}

function getTeamLoadoutForRound(
  round: RawRound,
  teamId: string,
  playerTeamByPuuid: Map<string, string>,
) {
  let loadout = 0;
  let spent = 0;
  let remaining = 0;
  for (const stat of round.playerStats ?? []) {
    const puuid = cleanId(stat.puuid);
    if (!puuid || playerTeamByPuuid.get(puuid) !== teamId) continue;
    loadout += toNumber(stat.economy?.loadoutValue);
    spent += toNumber(stat.economy?.spent);
    remaining += toNumber(stat.economy?.remaining);
  }
  return { loadout, spent, remaining, economy: classifyTeamEconomy(loadout || spent) };
}

function getMomentumEventReason(event?: MomentumEvent): RoundMomentumReason | null {
  if (!event) return null;
  if (["ECO_WIN", "SEMIECO_WIN_VS_FULL", "FULL_LOSS_VS_ECO", "ECONOMIC_SWING", "COSTLY_WIN"].includes(event.type)) return "economy";
  if (["CLUTCH_INFERRED"].includes(event.type)) return "clutch";
  if (["ACE", "MULTIKILL"].includes(event.type)) return "multikill";
  if (event.type === "FIRST_BLOOD_SWING") return "first_blood";
  if (["STREAK_BREAKER", "STREAK_START", "COMEBACK_SIGNAL"].includes(event.type)) return "streak";
  if (event.type === "SIDE_SWITCH_DOMINANCE") return "side_switch";
  if (event.type === "OBJECTIVE_CONTROL" || event.type === "EXTREME_DEFUSE") return "objective";
  if (event.type === "CARRY_DROP") return "carry_drop";
  if (event.type === "PLAYER_ACTIVATION") return "activation";
  return "individual_play";
}

const momentumEventPriority: Record<MomentumEvent["type"], number> = {
  CLUTCH_INFERRED: 100,
  EXTREME_DEFUSE: 95,
  ACE: 90,
  ECO_WIN: 85,
  SEMIECO_WIN_VS_FULL: 82,
  MATCH_POINT_SAVED: 80,
  OVERTIME_TURN: 79,
  COMEBACK_SIGNAL: 75,
  SIDE_SWITCH_DOMINANCE: 72,
  STREAK_BREAKER: 68,
  MULTIKILL: 65,
  FIRST_BLOOD_SWING: 58,
  PLAYER_ACTIVATION: 54,
  DUEL_REVERSAL: 50,
  CARRY_DROP: 48,
  OBJECTIVE_CONTROL: 45,
  TRADE_SWING: 42,
  STREAK_START: 40,
  MATCH_POINT_REACHED: 38,
  FULL_LOSS_VS_ECO: 35,
  ECONOMIC_SWING: 34,
  COSTLY_WIN: 30,
};

function getEventPerspective(event: MomentumEvent, selectedTeamId: string) {
  const eventDescribesDisadvantagedTeam = ["FULL_LOSS_VS_ECO", "CARRY_DROP"].includes(
    event.type,
  );
  const eventTeamIsSelected = event.teamId === selectedTeamId;
  const advantageIsForSelected = eventDescribesDisadvantagedTeam
    ? !eventTeamIsSelected
    : eventTeamIsSelected;
  return advantageIsForSelected ? "Tu equipo" : "Rival";
}

function getEventDisplayTitle(event: MomentumEvent): string {
  const actor = event.agentName ?? event.playerName;
  let title: string;
  switch (event.type) {
    case "CLUTCH_INFERRED":
      title = actor ? `${event.title.split("·").at(-1)?.trim()} de ${actor}` : event.title;
      break;
    case "ACE":
      title = actor ? `Ace de ${actor}` : "Ace";
      break;
    case "MULTIKILL":
      title = actor ? `Multikill de ${actor}` : "Multikill";
      break;
    case "EXTREME_DEFUSE":
      title = actor ? `Defuse extremo de ${actor}` : "Defuse extremo";
      break;
    case "ECO_WIN":
    case "SEMIECO_WIN_VS_FULL":
      title = "Victoria con economía inferior";
      break;
    case "FULL_LOSS_VS_ECO":
      title = "Aprovechó una FULL rival";
      break;
    case "STREAK_BREAKER":
      title = "Ruptura de racha rival";
      break;
    case "COMEBACK_SIGNAL":
      title = "Inicio de remontada";
      break;
    case "FIRST_BLOOD_SWING":
      title = "Las primeras bajas dieron la iniciativa";
      break;
    case "SIDE_SWITCH_DOMINANCE":
      title = "Dominio después del cambio de lado";
      break;
    case "PLAYER_ACTIVATION":
      title = actor ? `${actor} elevó su impacto` : "Un jugador elevó su impacto";
      break;
    case "CARRY_DROP":
      title = actor
        ? `Aprovechó la caída de impacto de ${actor}`
        : "Aprovechó la caída de impacto del líder rival";
      break;
    case "DUEL_REVERSAL":
      title = actor ? `${actor} invirtió un duelo repetido` : "Inversión de duelo";
      break;
    case "OBJECTIVE_CONTROL":
      title = actor ? `Defuse de ${actor}` : "Victoria por defuse";
      break;
    default:
      title = event.title.replace(/^.*?·\s*/, "");
  }
  return title;
}

function getEventDisplayDescription(event: MomentumEvent) {
  if (event.type === "FULL_LOSS_VS_ECO") {
    return "El equipo contrario perdió una FULL contra una compra inferior.";
  }
  if (event.type === "CARRY_DROP") {
    const actor = event.agentName ?? event.playerName ?? "El líder rival";
    return `${actor} perdió influencia y permitió que el equipo indicado ganara ventaja en el tramo.`;
  }
  return event.description;
}

function signedTicketContribution(
  amount: number,
  beneficiaryTeamId: string,
  selectedTeamId: string,
) {
  return beneficiaryTeamId === selectedTeamId ? Math.abs(amount) : -Math.abs(amount);
}

function getMomentumTicketSemanticFamily(
  event: Pick<RoundMomentumTicketEvent, "id" | "label">,
): string | null {
  const id = event.id.toLowerCase();
  const label = event.label.toLowerCase();
  if (
    id.includes("streak-break") ||
    id.includes("streak-ended") ||
    id.includes("streak_breaker") ||
    label.includes("ruptura de racha") ||
    label.includes("racha rival terminada")
  ) {
    return "streak-break";
  }
  if (
    id.includes("critical-round") ||
    id.includes("critical_round") ||
    id.includes("match-point-saved") ||
    id.includes("match_point_saved") ||
    label.includes("ronda crítica") ||
    label.includes("match point")
  ) {
    return "critical-round";
  }
  return null;
}

function consolidateRoundTicketEvents(
  events: RoundMomentumTicketEvent[],
): RoundMomentumTicketEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const kept = new Map(events.map((event) => [event.id, event]));
  const keepOnly = (ids: string[], preferredIds: string[]) => {
    const present = ids.filter((id) => byId.has(id));
    if (present.length <= 1) return;
    const preferred =
      preferredIds.find((id) => byId.has(id)) ?? present[0];
    for (const id of present) {
      if (id !== preferred) kept.delete(id);
    }
  };

  keepOnly(
    [
      "opening-triple",
      "opening-double",
      "first-blood",
      "opening-converted",
      "triple-opening-lost",
      "double-opening-lost",
      "opening-not-converted",
      "second-kill-recovered",
      "opening-traded",
    ],
    [
      "triple-opening-lost",
      "double-opening-lost",
      "second-kill-recovered",
      "opening-not-converted",
      "opening-triple",
      "opening-double",
      "opening-traded",
      "first-blood",
      "opening-converted",
    ],
  );
  keepOnly(
    ["flawless-round", "near-flawless-round", "efficient-win", "costly-round"],
    ["flawless-round", "near-flawless-round", "costly-round", "efficient-win"],
  );
  keepOnly(
    ["match-point-saved", "overtime-entry", "critical-round-won"],
    ["match-point-saved", "overtime-entry", "critical-round-won"],
  );
  keepOnly(
    ["full-wasted", "large-loadout-upset"],
    ["full-wasted", "large-loadout-upset"],
  );

  const objectiveIds = [...kept.keys()].filter(
    (id) =>
      [
        "spike-detonated",
        "plant-defense",
        "plant-lost",
        "defuse-without-postplant-kills",
        "defuse-enemies-alive",
        "defuse-number-disadvantage",
      ].includes(id) ||
      id.includes("EXTREME_DEFUSE") ||
      id.includes("OBJECTIVE_CONTROL"),
  );
  if (objectiveIds.length > 1) {
    const priority = [
      "defuse-number-disadvantage",
      ...objectiveIds.filter((id) => id.includes("EXTREME_DEFUSE")),
      "defuse-without-postplant-kills",
      "defuse-enemies-alive",
      ...objectiveIds.filter((id) => id.includes("OBJECTIVE_CONTROL")),
      "plant-lost",
      "spike-detonated",
      "plant-defense",
    ];
    const primaryId = priority.find((id) => kept.has(id)) ?? objectiveIds[0];
    const primary = kept.get(primaryId);
    if (primary) {
      const details = objectiveIds
        .map((id) => kept.get(id))
        .filter(
          (event): event is RoundMomentumTicketEvent =>
            Boolean(event && event.id !== primaryId),
        )
        .map((event) => event.detail);
      kept.set(primaryId, {
        ...primary,
        detail: [primary.detail, ...details].join(" "),
        contribution: Math.max(
          ...objectiveIds.map(
            (id) => Math.abs(kept.get(id)?.contribution ?? 0),
          ),
        ) * Math.sign(primary.contribution || 1),
      });
    }
    for (const id of objectiveIds) {
      if (id !== primaryId) kept.delete(id);
    }
  }

  const advancedStreak = [...kept.keys()].find((id) =>
    id.includes("STREAK_BREAKER"),
  );
  if (advancedStreak) kept.delete("streak-ended");
  if ([...kept.keys()].some((id) => id.startsWith("trade-chain-"))) {
    kept.delete("opening-traded");
    for (const id of [...kept.keys()]) {
      if (id.startsWith("trades-")) kept.delete(id);
    }
  }

  for (const [id, event] of kept) {
    if (
      id.includes("FIRST_BLOOD_SWING") ||
      [
        "opening-streak",
        "recurring-opening-player",
        "recurring-opening-victim",
        "opening-conversion",
        "poor-opening-conversion",
        "winning-streak",
        "economy-recovery",
        "critical-round-won",
        "confirmed-domain-change",
        "failed-domain-change",
        "round-without-trades",
        "collective-impact",
        "single-player-dependence",
      ].includes(id)
    ) {
      kept.set(id, { ...event, contribution: 0, isContext: true });
    }
  }

  return [...kept.values()];
}

function normalizeTicketContributions({
  events,
  players,
  target,
}: {
  events: RoundMomentumTicketEvent[];
  players: RoundMomentumTicketPlayer[];
  target: number;
}) {
  if (
    Math.abs(target) >= 0.05 &&
    !events.some(
      (event) =>
        !event.isContext &&
        Math.sign(event.contribution) === Math.sign(target),
    ) &&
    !players.some(
      (player) => Math.sign(player.contribution) === Math.sign(target),
    )
  ) {
    events = [
      ...events,
      {
        id: "round-result-balance",
        label: "Resultado de la ronda",
        detail: "Ajuste base que representa el resultado competitivo de la ronda.",
        teamLabel: target > 0 ? "Tu equipo" : "Rival",
        contribution: target,
      },
    ];
  }
  const actionableEvents = events.filter((event) => !event.isContext);
  const hasEventSignal = actionableEvents.some(
    (event) => Math.sign(event.contribution) === Math.sign(target),
  );
  const hasPlayerSignal = players.some(
    (player) => Math.sign(player.contribution) === Math.sign(target),
  );
  const eventShare = hasEventSignal && hasPlayerSignal ? 0.45 : hasEventSignal ? 1 : 0;
  const playerShare = hasPlayerSignal ? 1 - eventShare : 0;

  const normalizeValues = <T extends { contribution: number }>(
    items: T[],
    share: number,
  ) => {
    if (Math.abs(target) < 0.05 || share === 0) {
      return items.map((item) => ({ ...item, contribution: 0 }));
    }
    const direction = Math.sign(target);
    const aligned = items.filter(
      (item) => Math.sign(item.contribution) === direction,
    );
    const opposing = items.filter(
      (item) =>
        item.contribution !== 0 &&
        Math.sign(item.contribution) !== direction,
    );
    const alignedRaw = aligned.reduce(
      (sum, item) => sum + Math.abs(item.contribution),
      0,
    );
    if (alignedRaw === 0) {
      return items.map((item) => ({ ...item, contribution: 0 }));
    }
    const shareTarget = target * share;
    const opposingRaw = opposing.reduce(
      (sum, item) => sum + Math.abs(item.contribution),
      0,
    );
    const opposingBudget = Math.min(
      opposingRaw,
      Math.abs(shareTarget) * 0.25,
    );
    const opposingScale =
      opposingRaw > 0 ? opposingBudget / opposingRaw : 0;
    const opposingTotal = -direction * opposingBudget;
    const alignedTarget = shareTarget - opposingTotal;
    const alignedScale = Math.abs(alignedTarget) / alignedRaw;
    return items.map((item) => {
      if (item.contribution === 0) return item;
      const alignedItem = Math.sign(item.contribution) === direction;
      return {
        ...item,
        contribution:
          item.contribution * (alignedItem ? alignedScale : opposingScale),
      };
    });
  };

  const normalizedEvents = normalizeValues(events, eventShare).map((event) => ({
    ...event,
    contribution: Math.round(event.contribution * 100) / 100,
  }));
  const normalizedPlayers = normalizeValues(players, playerShare).map(
    (player) => {
      const original = players.find(
        (candidate) => candidate.playerId === player.playerId,
      );
      const roundedContribution = Math.round(player.contribution * 100) / 100;
      const rawBreakdown = original?.breakdown ?? [];
      const direction = Math.sign(roundedContribution);
      const alignedRaw = rawBreakdown
        .filter((item) => Math.sign(item.value) === direction)
        .reduce((sum, item) => sum + Math.abs(item.value), 0);
      const opposingRaw = rawBreakdown
        .filter(
          (item) => item.value !== 0 && Math.sign(item.value) !== direction,
        )
        .reduce((sum, item) => sum + Math.abs(item.value), 0);
      const opposingBudget =
        direction === 0
          ? 0
          : Math.min(opposingRaw, Math.abs(roundedContribution) * 0.25);
      const opposingScale =
        opposingRaw > 0 ? opposingBudget / opposingRaw : 0;
      const alignedTarget =
        Math.abs(roundedContribution) + opposingBudget;
      const alignedScale =
        alignedRaw > 0 ? alignedTarget / alignedRaw : 0;
      const breakdown = rawBreakdown.map((item) => ({
        ...item,
        value:
          Math.round(
            item.value *
              (Math.sign(item.value) === direction
                ? alignedScale
                : opposingScale) *
              100,
          ) / 100,
      }));
      const breakdownTotal = breakdown.reduce(
        (sum, item) => sum + item.value,
        0,
      );
      const breakdownResidual =
        Math.round((roundedContribution - breakdownTotal) * 100) / 100;
      if (breakdown[0] && Math.abs(breakdownResidual) >= 0.01) {
        breakdown[0].value =
          Math.round((breakdown[0].value + breakdownResidual) * 100) / 100;
      }
      return {
        ...player,
        teamLabel:
          roundedContribution > 0
            ? ("Tu equipo" as const)
            : roundedContribution < 0
              ? ("Rival" as const)
              : player.teamLabel,
        contribution: roundedContribution,
        breakdown,
      };
    },
  );

  const roundedTarget = Math.round(target * 100) / 100;
  const currentTotal =
    normalizedEvents.reduce((sum, event) => sum + event.contribution, 0) +
    normalizedPlayers.reduce((sum, player) => sum + player.contribution, 0);
  const residual = Math.round((roundedTarget - currentTotal) * 100) / 100;
  if (Math.abs(residual) >= 0.01) {
    const eventRecipient = normalizedEvents
      .filter((event) => !event.isContext)
      .sort(
        (a, b) =>
          Math.abs(b.contribution) - Math.abs(a.contribution),
      )[0];
    if (eventRecipient) {
      eventRecipient.contribution =
        Math.round((eventRecipient.contribution + residual) * 100) / 100;
    } else {
      const playerRecipient = [...normalizedPlayers].sort(
        (a, b) =>
          Math.abs(b.contribution) - Math.abs(a.contribution),
      )[0];
      if (playerRecipient) {
        playerRecipient.contribution =
          Math.round((playerRecipient.contribution + residual) * 100) / 100;
        if (playerRecipient.breakdown[0]) {
          playerRecipient.breakdown[0].value =
            Math.round(
              (playerRecipient.breakdown[0].value + residual) * 100,
            ) / 100;
        }
      }
    }
  }

  return {
    events: normalizedEvents,
    players: normalizedPlayers,
  };
}

function buildRoundMomentumTicketEvents({
  round,
  allRounds,
  events,
  players,
  selectedTeamId,
  currentMomentum,
}: {
  round: AdvancedMomentumRound;
  allRounds: AdvancedMomentumRound[];
  events: MomentumEvent[];
  players: AdvancedMomentumResult["playerImpacts"][number]["players"];
  selectedTeamId: string;
  currentMomentum?: MatchMomentumResult["rounds"][number];
}): RoundMomentumTicketEvent[] {
  const ticket = new Map<string, RoundMomentumTicketEvent>();
  const playersById = new Map(players.map((player) => [player.playerId, player]));
  const playerTeam = (playerId?: string) => playersById.get(playerId ?? "")?.teamId ?? "";
  const teamLabel = (teamId: string): "Tu equipo" | "Rival" =>
    teamId === selectedTeamId ? "Tu equipo" : "Rival";
  const add = (
    id: string,
    label: string,
    detail: string,
    beneficiaryTeamId: string,
    contribution: number,
    isContext = false,
  ) => {
    if (!beneficiaryTeamId || ticket.has(id)) return;
    ticket.set(id, {
      id,
      label,
      detail,
      teamLabel: teamLabel(beneficiaryTeamId),
      contribution: signedTicketContribution(
        contribution,
        beneficiaryTeamId,
        selectedTeamId,
      ),
      isContext,
    });
  };

  const kills = [...round.kills].sort((a, b) => a.timeMs - b.timeMs);
  const firstKillTeam = playerTeam(kills[0]?.killerId);
  const secondKillTeam = playerTeam(kills[1]?.killerId);
  const thirdKillTeam = playerTeam(kills[2]?.killerId);
  const firstThreeTeams = kills.slice(0, 3).map((kill) => playerTeam(kill.killerId));
  const openingTrade = kills[0]
    ? kills.find(
        (kill) =>
          kill.timeMs > kills[0].timeMs &&
          kill.victimId === kills[0].killerId &&
          playerTeam(kill.killerId) === playerTeam(kills[0].victimId) &&
          kill.timeMs - kills[0].timeMs <= 7_000,
      )
    : undefined;
  if (firstKillTeam) {
    const openingWasConverted = round.winnerTeamId === firstKillTeam;
    const hadTripleOpening =
      firstKillTeam === secondKillTeam && firstKillTeam === thirdKillTeam;
    const hadDoubleOpening = firstKillTeam === secondKillTeam;
    if (
      hadTripleOpening &&
      openingWasConverted
    ) {
      add(
        "opening-triple",
        "Tres primeras bajas",
        "El equipo consiguió las tres primeras eliminaciones de la ronda.",
        firstKillTeam,
        0.9,
      );
    } else if (hadDoubleOpening && openingWasConverted) {
      add(
        "opening-double",
        "Primera y segunda baja",
        "El equipo consiguió las dos primeras eliminaciones de la ronda.",
        firstKillTeam,
        0.7,
      );
    } else if (!hadDoubleOpening) {
      add(
        "first-blood",
        "Primera baja de la ronda",
        "La apertura se determina por el menor timestamp de baja.",
        firstKillTeam,
        0.45,
      );
    }
    if (round.winnerTeamId === firstKillTeam) {
      add(
        "opening-converted",
        "Ventaja inicial convertida",
        "El equipo que consiguió la primera baja terminó ganando la ronda.",
        round.winnerTeamId,
        0.35,
      );
    } else if (round.winnerTeamId) {
      if (hadTripleOpening) {
        add(
          "triple-opening-lost",
          "Ventaja triple desperdiciada",
          "El equipo rival consiguió las tres primeras bajas, pero perdió la ronda.",
          round.winnerTeamId,
          1.05,
        );
      } else if (hadDoubleOpening) {
        add(
          "double-opening-lost",
          "Ventaja doble desperdiciada",
          "El equipo rival consiguió las dos primeras bajas, pero perdió la ronda.",
          round.winnerTeamId,
          0.85,
        );
      } else {
        add(
          "opening-not-converted",
          "Apertura sin convertir",
          "El equipo recibió la primera baja y aun así remontó la ronda.",
          round.winnerTeamId,
          0.65,
        );
      }
    }
    if (
      firstThreeTeams.length >= 3 &&
      firstThreeTeams[0] !== firstThreeTeams[1] &&
      firstThreeTeams[1] === firstThreeTeams[2]
    ) {
      add(
        "second-kill-recovered",
        "Segunda baja recuperada",
        "El equipo perdió la apertura y respondió consiguiendo las dos bajas siguientes.",
        firstThreeTeams[1],
        0.65,
      );
    }
    if (openingTrade) {
      const elapsed = openingTrade.timeMs - kills[0].timeMs;
      add(
        "opening-traded",
        elapsed <= 3_000 ? "Apertura tradeada de inmediato" : "Apertura tradeada",
        `La primera baja fue respondida en ${(elapsed / 1000).toFixed(1)} segundos.`,
        playerTeam(openingTrade.killerId),
        elapsed <= 3_000 ? 0.45 : 0.3,
      );
    }
  }

  const aliveByTeam = new Map<string, Set<string>>();
  for (const player of players) {
    if (!player.teamId) continue;
    const alive = aliveByTeam.get(player.teamId) ?? new Set<string>();
    alive.add(player.playerId);
    aliveByTeam.set(player.teamId, alive);
  }
  let maximumWinnerDisadvantage = 0;
  let comebackComposition: { winnerAlive: number; rivalAlive: number } | null = null;
  for (const kill of kills) {
    const victimTeam = playerTeam(kill.victimId);
    aliveByTeam.get(victimTeam)?.delete(kill.victimId);
    if (!round.winnerTeamId) continue;
    const rivalTeamId =
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId;
    const winnerAlive = aliveByTeam.get(round.winnerTeamId)?.size ?? 0;
    const rivalAlive = aliveByTeam.get(rivalTeamId)?.size ?? 0;
    const disadvantage = rivalAlive - winnerAlive;
    if (disadvantage > maximumWinnerDisadvantage) {
      maximumWinnerDisadvantage = disadvantage;
      comebackComposition = { winnerAlive, rivalAlive };
    }
  }
  if (
    maximumWinnerDisadvantage > 0 &&
    round.winnerTeamId &&
    comebackComposition &&
    comebackComposition.winnerAlive >= 2
  ) {
    add(
      "number-disadvantage-win",
      `Remontada ${comebackComposition.winnerAlive}v${comebackComposition.rivalAlive}`,
      "El equipo ganó después de quedar en una desventaja numérica colectiva.",
      round.winnerTeamId,
      0.55 + maximumWinnerDisadvantage * 0.25,
    );
  } else if (
    maximumWinnerDisadvantage > 0 &&
    round.winnerTeamId &&
    comebackComposition?.winnerAlive === 1
  ) {
    const survivor = [...(aliveByTeam.get(round.winnerTeamId) ?? [])][0];
    const player = playersById.get(survivor);
    add(
      "individual-clutch-comeback",
      `Clutch individual 1v${comebackComposition.rivalAlive}`,
      `${player?.agentName ?? player?.playerName ?? "Un jugador"} resolvió la desventaja final en solitario.`,
      round.winnerTeamId,
      0.65 + maximumWinnerDisadvantage * 0.25,
    );
  }

  if (round.winnerTeamId) {
    const winnerDeaths = kills.filter(
      (kill) => playerTeam(kill.victimId) === round.winnerTeamId,
    ).length;
    if (winnerDeaths === 0 && kills.length > 0) {
      add(
        "flawless-round",
        "Ronda perfecta",
        "El equipo ganó sin perder ningún jugador.",
        round.winnerTeamId,
        0.5,
      );
    } else if (winnerDeaths === 1) {
      add(
        "near-flawless-round",
        "Ronda casi perfecta",
        "El equipo ganó perdiendo únicamente un jugador.",
        round.winnerTeamId,
        0.32,
      );
    } else if (winnerDeaths >= 4) {
      add(
        "costly-round",
        "Ronda costosa",
        "El equipo ganó, pero perdió cuatro o más jugadores.",
        round.winnerTeamId,
        0.18,
      );
    }
    if (winnerDeaths <= 1) {
      add(
        "efficient-win",
        "Victoria eficiente",
        `El equipo conservó ${5 - winnerDeaths} jugadores al cerrar la ronda.`,
        round.winnerTeamId,
        winnerDeaths === 0 ? 0.42 : 0.28,
      );
    }
  }

  for (const teamId of [round.teamAId, round.teamBId]) {
    const teamKills = kills.filter((kill) => playerTeam(kill.killerId) === teamId);
    if (
      teamKills.length >= 5 &&
      teamKills[4].timeMs - teamKills[0].timeMs <= 15_000
    ) {
      add(
        `rapid-elimination-${teamId}`,
        "Eliminación completa rápida",
        `El equipo consiguió cinco bajas en ${(
          (teamKills[4].timeMs - teamKills[0].timeMs) /
          1000
        ).toFixed(1)} segundos.`,
        teamId,
        0.65,
      );
    }
  }

  if (round.bombPlanter) {
    const planterTeam = playerTeam(round.bombPlanter);
    const resultText = `${round.roundResult ?? ""} ${round.roundCeremony ?? ""}`.toLowerCase();
    const isDefuse =
      Boolean(round.bombDefuser) ||
      resultText.includes("defuse") ||
      resultText.includes("defused");
    const isDetonation =
      resultText.includes("detonate") ||
      resultText.includes("detonated") ||
      resultText.includes("bomb") ||
      resultText.includes("spike");
    if (planterTeam && planterTeam === round.winnerTeamId) {
      add(
        isDetonation ? "spike-detonated" : "plant-defense",
        isDetonation ? "Spike detonada" : "Defensa del plant",
        isDetonation
          ? "El equipo plantó y ganó mediante la detonación de la spike."
          : "El equipo plantó y defendió el postplant hasta ganar.",
        planterTeam,
        isDetonation ? 0.4 : 0.3,
      );
    } else if (planterTeam && round.winnerTeamId) {
      add(
        "plant-lost",
        "Plant perdido",
        "El equipo ganó después de que el rival plantara la spike.",
        round.winnerTeamId,
        0.4,
      );
    }
    if (isDefuse && round.winnerTeamId) {
      const killsAfterPlant = kills.filter(
        (kill) => kill.timeMs > (round.plantRoundTime ?? 0),
      );
      if (killsAfterPlant.length === 0) {
        add(
          "defuse-without-postplant-kills",
          "Defuse sin bajas posteriores al plant",
          "La recuperación del objetivo se completó sin eliminaciones después del plant.",
          round.winnerTeamId,
          0.5,
        );
      }
    }
  }

  if (round.bombDefuser && round.defuseRoundTime && round.winnerTeamId) {
    const aliveAtDefuse = new Map<string, Set<string>>();
    for (const player of players) {
      if (!player.teamId) continue;
      const alive = aliveAtDefuse.get(player.teamId) ?? new Set<string>();
      alive.add(player.playerId);
      aliveAtDefuse.set(player.teamId, alive);
    }
    for (const kill of kills.filter((kill) => kill.timeMs <= (round.defuseRoundTime ?? 0))) {
      aliveAtDefuse.get(playerTeam(kill.victimId))?.delete(kill.victimId);
    }
    const rivalTeamId =
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId;
    const winnerAlive = aliveAtDefuse.get(round.winnerTeamId)?.size ?? 0;
    const enemiesAlive = aliveAtDefuse.get(rivalTeamId)?.size ?? 0;
    if (enemiesAlive > 0) {
      add(
        "defuse-enemies-alive",
        "Defuse con enemigos vivos",
        `El defuse terminó con ${enemiesAlive} rival${enemiesAlive === 1 ? "" : "es"} todavía con vida.`,
        round.winnerTeamId,
        0.4 + Math.min(0.3, enemiesAlive * 0.1),
      );
    }
    if (enemiesAlive > winnerAlive) {
      add(
        "defuse-number-disadvantage",
        `Defuse en desventaja ${winnerAlive}v${enemiesAlive}`,
        "El equipo completó el defuse teniendo menos jugadores vivos que el rival.",
        round.winnerTeamId,
        0.8,
      );
    }
  }

  const roundResultText = `${round.roundResult ?? ""} ${round.roundCeremony ?? ""}`.toLowerCase();
  if (
    round.winnerTeamId &&
    (roundResultText.includes("time") ||
      roundResultText.includes("timeout") ||
      roundResultText.includes("expired"))
  ) {
    add(
      "time-win",
      "Victoria por tiempo",
      "El equipo defensor ganó al agotarse el tiempo de la ronda.",
      round.winnerTeamId,
      0.3,
    );
  }

  const tradeCounts = new Map<string, number>();
  for (const kill of kills) {
    const killerTeam = playerTeam(kill.killerId);
    const tradedDeath = [...kills]
      .reverse()
      .find(
        (candidate) =>
          candidate.killerId === kill.victimId &&
          playerTeam(candidate.victimId) === killerTeam &&
          candidate.timeMs < kill.timeMs &&
          kill.timeMs - candidate.timeMs <= 7_000,
      );
    if (tradedDeath && killerTeam) {
      tradeCounts.set(killerTeam, (tradeCounts.get(killerTeam) ?? 0) + 1);
    }
  }
  for (const [teamId, count] of tradeCounts) {
    if (count >= 2) {
      add(
        `trade-chain-${teamId}`,
        "Cadena de trades",
        `El equipo encadenó ${count} respuestas a bajas rivales en menos de siete segundos.`,
        teamId,
        Math.min(0.75, count * 0.25),
      );
    } else if (!openingTrade || playerTeam(openingTrade.killerId) !== teamId) {
      add(
        `trades-${teamId}`,
        "Trade útil",
        "Una baja rival fue respondida en un máximo de siete segundos.",
        teamId,
        0.2,
      );
    }
  }
  if (kills.length >= 4 && tradeCounts.size === 0 && round.winnerTeamId) {
    add(
      "round-without-trades",
      "Ronda sin trades",
      "Hubo varias eliminaciones, pero ninguna fue respondida en menos de siete segundos.",
      round.winnerTeamId,
      0.2,
    );
  }

  const orderedRounds = [...allRounds].sort(
    (a, b) => a.roundNumber - b.roundNumber,
  );
  const currentRoundIndex = orderedRounds.findIndex(
    (candidate) => candidate.roundNumber === round.roundNumber,
  );
  const previousRound = orderedRounds[currentRoundIndex - 1];
  const firstKillData = (candidate: AdvancedMomentumRound) => {
    const first = [...candidate.kills].sort((a, b) => a.timeMs - b.timeMs)[0];
    return {
      teamId: playerTeam(first?.killerId),
      killerId: first?.killerId ?? "",
      victimId: first?.victimId ?? "",
    };
  };

  if (firstKillTeam && currentRoundIndex >= 0) {
    let teamOpeningStreak = 0;
    let playerOpeningStreak = 0;
    let victimOpeningStreak = 0;
    const openingPlayerId = kills[0]?.killerId ?? "";
    const openingVictimId = kills[0]?.victimId ?? "";
    for (let index = currentRoundIndex; index >= 0; index -= 1) {
      const opening = firstKillData(orderedRounds[index]);
      if (opening.teamId === firstKillTeam) teamOpeningStreak += 1;
      else break;
    }
    for (let index = currentRoundIndex; index >= 0; index -= 1) {
      const opening = firstKillData(orderedRounds[index]);
      if (opening.killerId === openingPlayerId) playerOpeningStreak += 1;
      else break;
    }
    for (let index = currentRoundIndex; index >= 0; index -= 1) {
      const opening = firstKillData(orderedRounds[index]);
      if (opening.victimId === openingVictimId) victimOpeningStreak += 1;
      else break;
    }
    if (teamOpeningStreak >= 3) {
      add(
        "opening-streak",
        `Racha de ${teamOpeningStreak} aperturas`,
        "El equipo consiguió la primera baja en varias rondas consecutivas.",
        firstKillTeam,
        Math.min(1, 0.35 + teamOpeningStreak * 0.1),
      );
    }
    if (playerOpeningStreak >= 3) {
      const player = playersById.get(openingPlayerId);
      add(
        "recurring-opening-player",
        "Jugador de apertura recurrente",
        `${player?.agentName ?? player?.playerName ?? "Un jugador"} consiguió la primera baja en ${playerOpeningStreak} rondas seguidas.`,
        firstKillTeam,
        0.45,
      );
    }
    if (victimOpeningStreak >= 3) {
      const victim = playersById.get(openingVictimId);
      add(
        "recurring-opening-victim",
        "Víctima inicial recurrente",
        `${victim?.agentName ?? victim?.playerName ?? "Un jugador"} sufrió la primera muerte en ${victimOpeningStreak} rondas seguidas.`,
        firstKillTeam,
        0.4,
      );
    }

    const openingWindow = orderedRounds
      .slice(Math.max(0, currentRoundIndex - 5), currentRoundIndex + 1)
      .map((candidate) => ({
        round: candidate,
        opening: firstKillData(candidate),
      }))
      .filter((entry) => entry.opening.teamId === firstKillTeam);
    if (openingWindow.length >= 3) {
      const converted = openingWindow.filter(
        (entry) => entry.round.winnerTeamId === firstKillTeam,
      ).length;
      const conversionRate = converted / openingWindow.length;
      if (conversionRate >= 0.75) {
        add(
          "opening-conversion",
          "Alta conversión de aperturas",
          `El equipo convirtió ${converted} de ${openingWindow.length} primeras bajas en victoria.`,
          firstKillTeam,
          0.45,
        );
      } else if (conversionRate <= 0.4) {
        const beneficiary =
          firstKillTeam === round.teamAId ? round.teamBId : round.teamAId;
        add(
          "poor-opening-conversion",
          "Mala conversión de aperturas",
          `El rival solo convirtió ${converted} de ${openingWindow.length} primeras bajas en victoria.`,
          beneficiary,
          0.4,
        );
      }
    }
  }

  if (round.winnerTeamId && currentRoundIndex >= 0) {
    let winningStreak = 0;
    for (let index = currentRoundIndex; index >= 0; index -= 1) {
      if (orderedRounds[index].winnerTeamId === round.winnerTeamId) {
        winningStreak += 1;
      } else {
        break;
      }
    }
    if (winningStreak >= 2) {
      add(
        "winning-streak",
        `Racha de ${winningStreak} victorias`,
        "El equipo encadenó varias rondas ganadas consecutivas.",
        round.winnerTeamId,
        Math.min(0.8, 0.15 + winningStreak * 0.1),
      );
    }
    const rivalTeamId =
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId;
    let brokenStreak = 0;
    for (let index = currentRoundIndex - 1; index >= 0; index -= 1) {
      if (orderedRounds[index].winnerTeamId === rivalTeamId) brokenStreak += 1;
      else break;
    }
    if (
      brokenStreak >= 2 &&
      !events.some((event) => event.type === "STREAK_BREAKER")
    ) {
      add(
        "streak-ended",
        "Racha rival terminada",
        `El equipo detuvo una secuencia rival de ${brokenStreak} victorias.`,
        round.winnerTeamId,
        Math.min(0.7, 0.25 + brokenStreak * 0.1),
      );
    }
  }

  const loadoutFor = (candidate: AdvancedMomentumRound, teamId: string) =>
    teamId === candidate.teamAId
      ? candidate.teamALoadout
      : candidate.teamBLoadout;
  if (round.winnerTeamId) {
    const rivalTeamId =
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId;
    const winnerLoadout = loadoutFor(round, round.winnerTeamId);
    const rivalLoadout = loadoutFor(round, rivalTeamId);
    const loadoutGap = rivalLoadout - winnerLoadout;
    if (
      winnerLoadout > 0 &&
      rivalLoadout > 0 &&
      loadoutGap >= 2_500 &&
      classifyTeamEconomy(rivalLoadout) !== "FULL" &&
      !events.some((event) => ["ECO_WIN", "SEMIECO_WIN_VS_FULL"].includes(event.type))
    ) {
      add(
        "large-loadout-upset",
        "Victoria con gran desventaja de equipamiento",
        `El ganador comenzó con ${formatNumber(loadoutGap)} menos de equipamiento.`,
        round.winnerTeamId,
        Math.min(1, 0.4 + loadoutGap / 20_000),
      );
    }
    if (
      winnerLoadout > 0 &&
      loadoutGap >= 2_500 &&
      classifyTeamEconomy(rivalLoadout) === "FULL" &&
      !events.some((event) => event.type === "FULL_LOSS_VS_ECO")
    ) {
      add(
        "full-wasted",
        "FULL desperdiciada",
        "El rival perdió pese a comenzar con una ventaja importante de equipamiento.",
        round.winnerTeamId,
        0.55,
      );
    }
    if (previousRound) {
      const previousEconomy = classifyTeamEconomy(
        loadoutFor(previousRound, round.winnerTeamId),
      );
      const currentEconomy = classifyTeamEconomy(winnerLoadout);
      const economyRank = { ECO: 0, SEMIECO: 1, FULL: 2 };
      if (
        winnerLoadout > 0 &&
        loadoutFor(previousRound, round.winnerTeamId) > 0 &&
        economyRank[currentEconomy] > economyRank[previousEconomy]
      ) {
        add(
          "economy-recovery",
          "Recuperación económica",
          `El equipo pasó de ${previousEconomy} a ${currentEconomy} y ganó la ronda.`,
          round.winnerTeamId,
          0.28,
        );
      }
    }
  }

  if (round.winnerTeamId) {
    const scoreBefore = round.scoreBefore ?? {};
    const scoreAfter = round.scoreAfter ?? {};
    const rivalTeamId =
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId;
    const ownBefore = scoreBefore[round.winnerTeamId] ?? 0;
    const rivalBefore = scoreBefore[rivalTeamId] ?? 0;
    if (round.roundNumber >= 25 || Math.max(ownBefore, rivalBefore) >= 11) {
      add(
        "critical-round-won",
        "Ronda crítica ganada",
        round.roundNumber >= 25
          ? "El equipo ganó una ronda de overtime."
          : "El equipo ganó una ronda cercana al punto de mapa.",
        round.winnerTeamId,
        round.roundNumber >= 25 ? 0.65 : 0.4,
      );
    }
    if (rivalBefore >= 12) {
      add(
        "match-point-saved",
        "Match point salvado",
        "El rival podía cerrar el mapa, pero el equipo mantuvo viva la partida.",
        round.winnerTeamId,
        0.75,
      );
    }
    if (
      (scoreAfter[round.teamAId] ?? 0) === 12 &&
      (scoreAfter[round.teamBId] ?? 0) === 12
    ) {
      add(
        "overtime-entry",
        "Entrada en overtime",
        "La victoria dejó el marcador empatado 12-12.",
        round.winnerTeamId,
        0.6,
      );
    }

    const winnerKills = kills.filter(
      (kill) => playerTeam(kill.killerId) === round.winnerTeamId,
    ).length;
    const rivalKills = kills.filter(
      (kill) => playerTeam(kill.killerId) === rivalTeamId,
    ).length;
    if (winnerKills < rivalKills) {
      add(
        "win-with-fewer-kills",
        "Victoria con menos bajas",
        `El ganador consiguió ${winnerKills} bajas frente a ${rivalKills} del rival y resolvió la ronda por objetivo o tiempo.`,
        round.winnerTeamId,
        0.4,
      );
    }
  }

  for (const teamId of [round.teamAId, round.teamBId]) {
    const teamPlayers = players.filter((player) => player.teamId === teamId);
    const multiKillPlayers = teamPlayers.filter((player) => player.kills >= 2);
    if (multiKillPlayers.length >= 2) {
      add(
        `distributed-multikill-${teamId}`,
        "Multikill repartida",
        `${multiKillPlayers.length} jugadores del equipo consiguieron al menos dos bajas.`,
        teamId,
        0.45,
      );
    }

    const teamDamage = teamPlayers.reduce(
      (sum, player) => sum + player.damage,
      0,
    );
    const damageContributors = teamPlayers.filter(
      (player) => player.damage >= 100,
    ).length;
    if (
      teamDamage >= 500 &&
      damageContributors >= 3 &&
      !teamPlayers.some((player) => player.kills >= 3)
    ) {
      add(
        `collective-damage-${teamId}`,
        "Daño colectivo alto",
        `${damageContributors} jugadores aportaron al menos 100 de daño, con ${formatNumber(teamDamage)} en total.`,
        teamId,
        0.4,
      );
    }

    const positivePlayers = teamPlayers.filter(
      (player) => player.totalImpact > 0,
    );
    const teamPositiveImpact = positivePlayers.reduce(
      (sum, player) => sum + player.totalImpact,
      0,
    );
    const topImpact = Math.max(
      0,
      ...positivePlayers.map((player) => player.totalImpact),
    );
    if (
      positivePlayers.length >= 3 &&
      teamPositiveImpact > 0 &&
      topImpact / teamPositiveImpact <= 0.42
    ) {
      add(
        `collective-impact-${teamId}`,
        "Impacto colectivo",
        "La contribución estuvo repartida entre al menos tres jugadores.",
        teamId,
        0.35,
      );
    } else if (
      teamPositiveImpact >= 1 &&
      topImpact / teamPositiveImpact >= 0.65
    ) {
      const leader = positivePlayers.find(
        (player) => player.totalImpact === topImpact,
      );
      add(
        `single-player-dependence-${teamId}`,
        "Dependencia de un jugador",
        `${leader?.agentName ?? leader?.playerName ?? "Un jugador"} concentró ${formatPercent((topImpact / teamPositiveImpact) * 100, 0)} del impacto positivo del equipo.`,
        teamId,
        0.3,
      );
    }

    for (const player of teamPlayers) {
      const hasObjectiveOrSupport = player.milestones.some((milestone) =>
        [
          "assists",
          "plant",
          "plant_win",
          "defuse",
          "defuse_win",
          "immediate_trade",
          "useful_trade",
          "damage",
        ].includes(milestone.type),
      );
      if (
        player.kills === 0 &&
        player.totalImpact >= 0.75 &&
        hasObjectiveOrSupport
      ) {
        add(
          `zero-kill-decisive-${player.playerId}`,
          "Jugador sin bajas pero decisivo",
          `${player.agentName ?? player.playerName ?? "Un jugador"} alcanzó ${formatNumber(player.totalImpact, 2)} de impacto mediante apoyo, daño u objetivo.`,
          teamId,
          0.45,
        );
      }
      if (player.kills >= 5 && round.winnerTeamId !== teamId) {
        const beneficiary =
          teamId === round.teamAId ? round.teamBId : round.teamAId;
        add(
          `lost-ace-${player.playerId}`,
          "Ace rival sin convertir",
          `${player.agentName ?? player.playerName ?? "Un jugador rival"} registró cinco bajas, pero su equipo perdió la ronda.`,
          beneficiary,
          0.65,
        );
      }
    }
  }

  const nextRounds = orderedRounds.slice(
    currentRoundIndex + 1,
    currentRoundIndex + 4,
  );
  const nextWins = round.winnerTeamId
    ? nextRounds.filter(
        (candidate) => candidate.winnerTeamId === round.winnerTeamId,
      ).length
    : 0;
  const hasLargeCurrentEvent =
    events.some(
      (event) =>
        event.isHighlight ||
        event.isTurningPoint ||
        event.totalImpactScore >= 1.5,
    ) || players.some((player) => player.totalImpact >= 1.5);
  if (
    round.winnerTeamId &&
    currentMomentum?.tags.includes("Cambio de dominio") &&
    nextWins >= 2
  ) {
    add(
      "confirmed-domain-change",
      "Cambio de dominio confirmado",
      "El cambio de control fue seguido por al menos dos victorias en las tres rondas posteriores.",
      round.winnerTeamId,
      0.7,
    );
  } else if (
    round.winnerTeamId &&
    hasLargeCurrentEvent &&
    nextRounds.length >= 2 &&
    nextWins <= 1
  ) {
    add(
      "failed-domain-change",
      "Cambio de dominio no consolidado",
      "La ronda produjo una señal fuerte, pero el equipo no mantuvo la ventaja en el tramo posterior.",
      round.winnerTeamId === round.teamAId ? round.teamBId : round.teamAId,
      0.35,
    );
  }

  const individualEventTypes: MomentumEvent["type"][] = [
    "CLUTCH_INFERRED",
    "ACE",
    "MULTIKILL",
    "PLAYER_ACTIVATION",
    "CARRY_DROP",
    "DUEL_REVERSAL",
  ];
  for (const event of events) {
    if (individualEventTypes.includes(event.type)) continue;
    if (event.type === "FIRST_BLOOD_SWING") continue;
    if (
      event.type === "FULL_LOSS_VS_ECO" &&
      events.some((candidate) =>
        ["ECO_WIN", "SEMIECO_WIN_VS_FULL"].includes(candidate.type),
      )
    ) {
      continue;
    }
    if (
      event.type === "OBJECTIVE_CONTROL" &&
      events.some((candidate) => candidate.type === "EXTREME_DEFUSE")
    ) {
      continue;
    }
    const disadvantaged = ["FULL_LOSS_VS_ECO", "CARRY_DROP"].includes(event.type);
    const beneficiaryTeamId = disadvantaged
      ? event.teamId === round.teamAId
        ? round.teamBId
        : round.teamAId
      : event.teamId;
    add(
      `advanced-${event.id}`,
      getEventDisplayTitle(event),
      getEventDisplayDescription(event),
      beneficiaryTeamId,
      Math.max(0.1, event.totalImpactScore),
      [
        "STREAK_BREAKER",
        "COMEBACK_SIGNAL",
        "SIDE_SWITCH_DOMINANCE",
      ].includes(event.type),
    );
  }

  return consolidateRoundTicketEvents([...ticket.values()]).sort(
    (a, b) =>
      Number(a.isContext) - Number(b.isContext) ||
      Math.abs(b.contribution) - Math.abs(a.contribution) ||
      a.label.localeCompare(b.label),
  );
}

function buildRoundMomentumTicketPlayers(
  players: AdvancedMomentumResult["playerImpacts"][number]["players"],
  selectedTeamId: string,
): RoundMomentumTicketPlayer[] {
  const representedByGeneralEvent = new Set([
    "first_blood",
    "double_kill",
    "triple_kill",
    "quad_kill",
    "ace",
    "rapid_double",
    "rapid_triple",
    "plant",
    "plant_win",
    "plant_survival",
    "defuse",
    "defuse_win",
    "defuse_under_one",
    "extreme_defuse",
    "eco_kill",
    "semi_eco_kill",
    "critical_action",
    "side_switch_action",
  ]);
  return players
    .map((player) => {
      const residualMilestones = player.milestones.filter(
        (milestone) =>
          !representedByGeneralEvent.has(milestone.type) &&
          !milestone.type.startsWith("clutch_"),
      );
      const residualImpact = residualMilestones.reduce(
        (sum, milestone) => sum + milestone.value,
        0,
      );
      return {
        playerId: player.playerId,
        playerName: player.playerName ?? "Jugador",
        agentName: player.agentName,
        agentIcon: player.agentIcon,
        teamLabel:
          player.teamId === selectedTeamId
            ? ("Tu equipo" as const)
            : ("Rival" as const),
        contribution:
          player.teamId === selectedTeamId
            ? residualImpact
            : -residualImpact,
        breakdown: residualMilestones
        .map((milestone) => ({
          label: milestone.label,
          value:
            player.teamId === selectedTeamId
              ? milestone.value
              : -milestone.value,
        }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.contribution) - Math.abs(a.contribution) ||
        a.playerName.localeCompare(b.playerName),
    );
}

function eventsAreRedundant(primary: MomentumEvent, candidate: MomentumEvent): boolean {
  if (primary.id === candidate.id) return true;
  if (
    primary.type === "CLUTCH_INFERRED" &&
    ["ACE", "MULTIKILL"].includes(candidate.type) &&
    primary.playerId === candidate.playerId
  ) {
    return true;
  }
  if (
    primary.type === "EXTREME_DEFUSE" &&
    candidate.type === "OBJECTIVE_CONTROL"
  ) {
    return true;
  }
  if (
    ["ECO_WIN", "SEMIECO_WIN_VS_FULL"].includes(primary.type) &&
    candidate.type === "FULL_LOSS_VS_ECO"
  ) {
    return true;
  }
  return getMomentumEventReason(primary) === getMomentumEventReason(candidate);
}

function selectRoundNarrativeEvents(
  events: MomentumEvent[],
  winningTeamId: string,
) {
  const relevant = events
    .filter(
      (event) =>
        event.isTurningPoint ||
        event.isHighlight ||
        event.totalImpactScore >= 0.7,
    )
    .sort(
      (a, b) =>
        Number(b.isTurningPoint) - Number(a.isTurningPoint) ||
        Number(b.teamId === winningTeamId) - Number(a.teamId === winningTeamId) ||
        momentumEventPriority[b.type] - momentumEventPriority[a.type] ||
        b.totalImpactScore - a.totalImpactScore,
    );
  const primary = relevant[0];
  const secondary = primary
    ? relevant
        .filter((event) => !eventsAreRedundant(primary, event))
        .slice(0, 3)
    : [];
  return { primary, secondary };
}

function getEventConsequence(
  event: MomentumEvent | undefined,
  currentMomentum: MatchMomentumResult["rounds"][number] | undefined,
  selectedTeamId: string,
) {
  if (!event) {
    return currentMomentum?.isSwingRound
      ? "La ronda produjo un cambio visible en la curva de control."
      : "La ronda modificó el control reciente, pero no dejó una consecuencia sostenida.";
  }
  if (event.isTurningPoint && currentMomentum?.tags.includes("Cambio de dominio")) {
    const controller =
      currentMomentum.dominantTeamId === selectedTeamId
        ? "Tu equipo"
        : currentMomentum.dominantTeamId
          ? "Rival"
          : null;
    return controller
      ? `${controller} pasó a controlar la partida después de esta ronda.`
      : "La ronda desplazó el control, pero la partida quedó cerca del equilibrio.";
  }
  if (event.isTurningPoint) {
    return "El tramo posterior confirmó la acción como punto de inflexión.";
  }
  if (Math.abs(event.postEventMomentumDelta) >= 1) {
    return event.postEventMomentumDelta > 0
      ? "El control aumentó de forma observable en las rondas posteriores."
      : "La acción fue destacada, pero su ventaja no se mantuvo en las rondas posteriores.";
  }
  return "Fue una acción relevante, aunque no generó un cambio sostenido de dominio.";
}

function getConfidenceLabel(event?: MomentumEvent) {
  if (!event) return "Estimación";
  if (event.confidence === "high") return "Confirmado";
  if (event.confidence === "medium") return event.missingData?.length ? "Inferido" : "Patrón";
  return "Estimación";
}

function getConfidenceReason(event?: MomentumEvent) {
  if (!event) {
    return "Estimación basada en resultado, economía disponible y curva de control.";
  }
  if (event.confidence === "high") {
    return "Confirmado con datos directos de la ronda: resultado, kills, economía u objetivo.";
  }
  if (event.missingData?.length) {
    return `Inferido mediante señales parciales. Falta: ${event.missingData.join(" ")}`;
  }
  if (event.confidence === "medium") {
    return "Patrón detectado comparando varias rondas antes y después del evento.";
  }
  return "Estimación de baja confianza; se muestra como contexto y no como hecho decisivo.";
}

function getRoundReasonLabel(reason: RoundMomentumReason): string {
  const labels: Record<RoundMomentumReason, string> = {
    economy: "Economía",
    individual_play: "Jugada individual",
    first_blood: "Primera baja",
    streak: "Racha",
    side_switch: "Cambio de lado",
    objective: "Objetivo",
    multikill: "Multikill",
    clutch: "Clutch",
    carry_drop: "Caída de impacto",
    activation: "Activación",
    normal: "Ronda de control",
  };
  return labels[reason];
}

function getRoundEventIcon(reason: RoundMomentumReason): RoundMomentumViewModel["eventIcon"] {
  if (reason === "economy") return "economy";
  if (reason === "clutch") return "clutch";
  if (reason === "multikill") return "multikill";
  if (reason === "first_blood") return "first_blood";
  if (reason === "side_switch") return "side_switch";
  if (reason === "objective") return "defuse";
  if (reason === "activation") return "up";
  if (reason === "carry_drop") return "down";
  return undefined;
}

function inferSelectedPlayerContribution({
  round,
  selectedPlayer,
  selectedTeamId,
  opponentTeamId,
  teamByPuuid,
  playerImpact,
  roundMvp,
}: {
  round: RawRound;
  selectedPlayer: RawPlayer;
  selectedTeamId: string;
  opponentTeamId: string;
  teamByPuuid: Map<string, string>;
  playerImpact?: PlayerRoundImpactBreakdown;
  roundMvp?: PlayerRoundImpactBreakdown;
}): RoundMomentumViewModel["selectedPlayerContribution"] {
  const selectedPlayerId = cleanId(selectedPlayer.puuid);
  const selectedStats = (round.playerStats ?? []).find(
    (stat) => cleanId(stat.puuid) === selectedPlayerId,
  );
  const allRoundKills = collectRoundKills(round);
  const competitiveKills = allRoundKills.filter(({ kill, ownerPuuid }) =>
    isValidKill(kill, teamByPuuid, ownerPuuid),
  );
  const kills = competitiveKills.filter(
    ({ kill, ownerPuuid }) =>
      (cleanId(kill.killer) || ownerPuuid) === selectedPlayerId,
  ).length;
  const damage = (selectedStats?.damage ?? []).reduce(
    (sum, entry) =>
      sum +
      (isEnemyDamage(selectedPlayerId, entry, teamByPuuid)
        ? toNumber(entry.damage)
        : 0),
    0,
  );
  const assists = competitiveKills.filter(({ kill, ownerPuuid }) =>
    validAssistants(kill, teamByPuuid, ownerPuuid).includes(selectedPlayerId),
  ).length;
  const firstKill = competitiveKills[0] ?? null;
  const selectedFirstKill =
    (cleanId(firstKill?.kill.killer) || firstKill?.ownerPuuid) ===
    selectedPlayerId;
  const selectedFirstDeath =
    cleanId(firstKill?.kill.victim) === selectedPlayerId;
  const stats = [
    { label: "Bajas", value: String(kills) },
    { label: "Asistencias", value: String(assists) },
    { label: "Daño", value: formatNumber(damage) },
    { label: "Impacto", value: formatNumber(playerImpact?.totalImpact ?? 0, 2) },
    { label: "Loadout", value: formatNumber(toNumber(selectedStats?.economy?.loadoutValue)) },
  ];
  const primaryMilestone = playerImpact?.milestones.find(
    (milestone) => milestone.value > 0,
  );
  const selectedIsMvp = roundMvp?.playerId === selectedPlayerId;
  const otherMvpName =
    roundMvp && !selectedIsMvp
      ? roundMvp.playerName ?? "otro jugador"
      : null;

  if (primaryMilestone?.type.startsWith("clutch_")) {
    return {
      title: "Clutch inferido",
      description: `${primaryMilestone.label}. Fue la acción individual principal de tu ronda${selectedIsMvp ? " y te convirtió en MVP" : ""}.`,
      tone: "positive",
      stats,
    };
  }
  if (["ace", "quad_kill", "triple_kill"].includes(primaryMilestone?.type ?? "")) {
    return {
      title: primaryMilestone?.label ?? "Multikill",
      description: `Tu ${primaryMilestone?.label.toLowerCase()} fue tu contribución principal${selectedIsMvp ? " y te convirtió en MVP de la ronda" : ""}.`,
      tone: "positive",
      stats,
    };
  }
  if (["extreme_defuse", "defuse_under_one", "defuse"].includes(primaryMilestone?.type ?? "")) {
    return {
      title: primaryMilestone?.label ?? "Defuse",
      description: "Tu acción sobre el objetivo fue la contribución individual más relevante de tu ronda.",
      tone: "positive",
      stats,
    };
  }
  if (["plant", "plant_win"].includes(primaryMilestone?.type ?? "")) {
    return {
      title: "Plant decisivo",
      description: "Tu plant aportó control objetivo verificable a la ronda.",
      tone: "positive",
      stats,
    };
  }
  if (primaryMilestone?.type === "first_blood" || selectedFirstKill) {
    return {
      title: "Primera baja favorable",
      description: "Conseguiste la primera baja y abriste la ronda para tu equipo.",
      tone: "positive",
      stats,
    };
  }
  if (primaryMilestone?.type.includes("trade")) {
    return {
      title: primaryMilestone.label,
      description: "Recuperaste una baja aliada dentro de una ventana temporal útil.",
      tone: "positive",
      stats,
    };
  }
  if (kills > 0 || damage >= 100) {
    return {
      title: kills > 0 ? "Impacto directo" : "Daño relevante",
      description: otherMvpName
        ? `La ronda se inclinó por la actuación de ${otherMvpName}, mientras tu impacto fue ${playerImpact && playerImpact.totalImpact >= 0.75 ? "secundario" : "limitado"}.`
        : `Aportaste ${kills > 0 ? `${kills} ${kills === 1 ? "baja" : "bajas"}` : `${formatNumber(damage)} de daño`}, con impacto ${formatNumber(playerImpact?.totalImpact ?? 0, 2)}.`,
      tone: cleanId(round.winningTeam) === selectedTeamId ? "positive" : "neutral",
      stats,
    };
  }
  if (selectedFirstDeath) {
    return {
      title: "Primera muerte del equipo",
      description: otherMvpName
        ? `${otherMvpName} fue el jugador más influyente; tu primera muerte redujo tu contribución en esta ronda.`
        : "Fuiste la primera muerte y no se detectó una contribución positiva posterior que la compensara.",
      tone: "negative",
      stats,
    };
  }
  return {
    title: "Sin acción directa detectada",
    description: otherMvpName
      ? `La ronda se inclinó por la actuación de ${otherMvpName}, mientras tu impacto fue limitado.`
      : "No se detectó una acción directa del jugador seleccionado en el cambio de momentum de esta ronda.",
    tone: cleanId(round.winningTeam) === opponentTeamId ? "negative" : "neutral",
    stats,
  };
}

function buildRoundMomentumViewModels({
  match,
  advancedMomentumAnalysis,
  selectedPlayer,
  selectedTeamId,
  opponentTeamId,
  teamAId,
}: {
  match: RawMatchDetail | null;
  advancedMomentumAnalysis: AdvancedMomentumResult | null;
  selectedPlayer: RawPlayer | null;
  selectedTeamId: string;
  opponentTeamId: string;
  teamAId: string;
}): RoundMomentumViewModel[] {
  if (!match || !selectedPlayer || !advancedMomentumAnalysis?.existingMomentum) return [];

  const momentum = advancedMomentumAnalysis.existingMomentum;
  const eventsByRound = new Map<number, MomentumEvent[]>();
  for (const event of advancedMomentumAnalysis.events) {
    const list = eventsByRound.get(event.roundNumber) ?? [];
    list.push(event);
    eventsByRound.set(event.roundNumber, list);
  }

  const playerTeamByPuuid = new Map<string, string>();
  for (const player of match.players ?? []) {
    const puuid = cleanId(player.puuid);
    const teamId = cleanId(player.teamId);
    if (puuid && teamId) playerTeamByPuuid.set(puuid, teamId);
  }

  const orientValue = (value: number) => (selectedTeamId === teamAId ? value : -value);
  const momentumByRound = new Map(momentum.rounds.map((round) => [round.roundNumber, round]));
  const playerImpactsByRound = new Map<number, RoundPlayerImpactResult>(
    advancedMomentumAnalysis.playerImpacts.map((round) => [round.roundNumber, round]),
  );
  const advancedRoundsByNumber = new Map(
    advancedMomentumAnalysis.rounds.map((round) => [round.roundNumber, round]),
  );

  return (match.roundResults ?? []).map((round, index) => {
    const roundNumber = Number.isFinite(round.roundNum) ? Number(round.roundNum) + 1 : index + 1;
    const currentMomentum = momentumByRound.get(roundNumber);
    const roundPlayerImpact = playerImpactsByRound.get(roundNumber);
    const advancedRound = advancedRoundsByNumber.get(roundNumber);
    const roundEvents = eventsByRound.get(roundNumber) ?? [];
    const selectedPlayerImpact = roundPlayerImpact?.players.find(
      (player) => player.playerId === cleanId(selectedPlayer.puuid),
    );
    const previousMomentum = momentumByRound.get(roundNumber - 1);
    const momentumBefore = previousMomentum ? orientValue(previousMomentum.momentumDiff) : 0;
    const momentumAfter = currentMomentum ? orientValue(currentMomentum.momentumDiff) : momentumBefore;
    const momentumChange = momentumAfter - momentumBefore;
    const rawRoundImpact = Number.isFinite(currentMomentum?.roundImpact)
      ? orientValue(currentMomentum?.roundImpact ?? 0)
      : 0;
    const selectedEconomy = getTeamLoadoutForRound(round, selectedTeamId, playerTeamByPuuid);
    const opponentEconomy = getTeamLoadoutForRound(round, opponentTeamId, playerTeamByPuuid);
    const winningTeamId = cleanId(round.winningTeam);
    const { primary: sourceEvent, secondary: secondaryEvents } =
      selectRoundNarrativeEvents(
        roundEvents,
        winningTeamId,
      );
    const isSelectedTeamWin = winningTeamId === selectedTeamId;
    const roundPerspective = isSelectedTeamWin
      ? "Tu equipo"
      : winningTeamId
        ? "Rival"
        : "Ronda";
    const eventReason = getMomentumEventReason(sourceEvent);
    const economyUpset =
      selectedEconomy.economy === "FULL" &&
      opponentEconomy.economy !== "FULL" &&
      !isSelectedTeamWin;
    const mainReason =
      eventReason ??
      (economyUpset ? "economy" : currentMomentum?.isStreakBreaker ? "streak" : roundNumber === 13 ? "side_switch" : "normal");
    const impactLevel = impactLevelFromValue(rawRoundImpact);
    const eventPerspective = sourceEvent
      ? getEventPerspective(sourceEvent, selectedTeamId)
      : roundPerspective;
    const eventTitle = sourceEvent
      ? getEventDisplayTitle(sourceEvent)
      : getRoundReasonLabel(mainReason);
    const eventDescription =
      (sourceEvent
        ? getEventDisplayDescription(sourceEvent)
        : null) ??
      (isSelectedTeamWin
        ? "Ganó la ronda y reforzó su control competitivo reciente."
        : "Ganó la ronda y desplazó el control competitivo a su favor.");
    const roundType =
      sourceEvent?.isTurningPoint
        ? "La ronda que cambió la partida"
        : mainReason === "economy"
          ? "Swing económico"
          : mainReason === "clutch"
            ? "Clutch inferido"
            : mainReason === "multikill"
              ? "Multikill"
              : mainReason === "streak"
                ? "Ruptura de racha"
                : mainReason === "side_switch"
                  ? "Cambio de lado"
                  : Math.abs(rawRoundImpact) < 0.4
                    ? "Ronda equilibrada"
                    : isSelectedTeamWin
                      ? "Recuperación"
                      : "Dominio rival";
    const evidences = [
      ...(sourceEvent?.factualEvidence ?? []),
      economyUpset
        ? `Tu equipo tenía ${selectedEconomy.economy} contra ${opponentEconomy.economy}.`
        : "",
      Math.abs(selectedEconomy.loadout - opponentEconomy.loadout) >= 2500
        ? `Diferencia de equipamiento: ${formatNumber(selectedEconomy.loadout - opponentEconomy.loadout)} desde tu equipo.`
        : "",
      currentMomentum?.isStreakBreaker ? "Rompió una racha previa." : "",
    ].filter(Boolean).slice(0, 3);
    const safeEvidences =
      evidences.length > 0
        ? evidences
        : ["No se detectaron eventos extraordinarios; el impacto procede principalmente del resultado de la ronda."];
    const shortComment =
      sourceEvent
        ? sourceEvent.description
        : mainReason === "economy" && economyUpset
        ? `Tu equipo perdió una ${selectedEconomy.economy} contra una ${opponentEconomy.economy} rival. Fue una ronda de impacto ${impactLevelLabel(impactLevel).toLowerCase()} que desplazó el momentum hacia el rival.`
        : roundNumber === 13
            ? "Esta ronda marca el inicio del nuevo lado. El tramo posterior indica si el cambio modificó el dominio de la partida."
            : isSelectedTeamWin
              ? `Tu equipo ganó la ronda y ${rawRoundImpact >= 0 ? "empujó el dominio a favor" : "redujo el dominio rival"}. ${Math.abs(rawRoundImpact) >= 1 ? "Fue un cambio observable en la curva." : "No fue el punto de inflexión principal."}`
              : `El rival ganó la ronda y ${rawRoundImpact < 0 ? "aumentó su dominio" : "mantuvo la partida cerca del equilibrio"}. No se afirma causalidad psicológica, solo cambio competitivo observable.`;
    const learning =
      mainReason === "economy"
        ? "Revisa las rondas donde juegas con ventaja de compra; suelen ser oportunidades de alto valor."
        : mainReason === "clutch"
          ? "Revisa cómo se cierran las ventajas numéricas cuando el rival convierte situaciones difíciles."
          : mainReason === "first_blood"
            ? "Revisa la entrada o el posicionamiento inicial: la primera baja condicionó el control."
            : impactLevel === "low"
              ? "Ronda de impacto bajo. No requiere revisión específica más allá del resultado."
              : "Identifica qué cambió antes y después de esta ronda para repetir o evitar el patrón.";
    const contextualTicketEvents =
      advancedRound && roundPlayerImpact
        ? buildRoundMomentumTicketEvents({
            round: advancedRound,
            allRounds: advancedMomentumAnalysis.rounds,
            events: roundEvents,
            players: roundPlayerImpact.players,
            selectedTeamId,
            currentMomentum,
          }).filter((event) => event.isContext)
        : [];
    const rawTicketPlayers = roundPlayerImpact
      ? buildRoundMomentumTicketPlayers(roundPlayerImpact.players, selectedTeamId)
      : [];
    const orientAccountingValue = (value: number) =>
      selectedTeamId === teamAId ? value : -value;
    const playerAccountingContribution = orientAccountingValue(
      currentMomentum?.contributions.find(
        (contribution) => contribution.kind === "players",
      )?.value ?? 0,
    );
    const normalizedPlayers = normalizeTicketContributions({
      events: [],
      players: rawTicketPlayers,
      target: playerAccountingContribution,
    }).players;
    const accountingEvents: RoundMomentumTicketEvent[] = (
      currentMomentum?.contributions ?? []
    )
      .filter((contribution) => contribution.kind !== "players")
      .map((contribution) => {
        const contributionValue = orientAccountingValue(contribution.value);
        return {
          id: `accounting-${contribution.id}`,
          label: contribution.label,
          detail: contribution.detail,
          teamLabel:
            contributionValue >= 0
              ? ("Tu equipo" as const)
              : ("Rival" as const),
          contribution: contributionValue,
        };
      });
    const playerNetAccountingEvent: RoundMomentumTicketEvent = {
      id: "accounting-player-net",
      label: "Balance neto por aportación de jugadores",
      detail:
        "Suma neta de las aportaciones individuales de los jugadores en esta ronda.",
      teamLabel:
        playerAccountingContribution >= 0
          ? ("Tu equipo" as const)
          : ("Rival" as const),
      contribution: playerAccountingContribution,
    };
    const accountingLabels = new Set(
      accountingEvents.map((event) => event.label.toLowerCase()),
    );
    const accountingFamilies = new Set(
      accountingEvents
        .map(getMomentumTicketSemanticFamily)
        .filter((family): family is string => Boolean(family)),
    );
    const ticketEvents = [
      ...accountingEvents,
      playerNetAccountingEvent,
      ...contextualTicketEvents.filter(
        (event) => {
          const semanticFamily = getMomentumTicketSemanticFamily(event);
          return (
            !accountingLabels.has(event.label.toLowerCase()) &&
            (!semanticFamily || !accountingFamilies.has(semanticFamily))
          );
        },
      ),
    ].sort(
      (a, b) =>
        Number(b.id === "accounting-carryover") -
          Number(a.id === "accounting-carryover") ||
        Number(a.isContext) - Number(b.isContext) ||
        Math.abs(b.contribution) - Math.abs(a.contribution),
    );
    const ticketPlayers = normalizedPlayers.sort(
      (a, b) =>
        Math.abs(b.contribution) - Math.abs(a.contribution) ||
        a.playerName.localeCompare(b.playerName),
    );
    const timelinePlayerName = new Map(
      (roundPlayerImpact?.players ?? []).map((player) => [
        player.playerId,
        player.playerName ?? player.agentName ?? "Jugador",
      ]),
    );
    const timeline: RoundMomentumTimelineItem[] = advancedRound
      ? [
          ...advancedRound.kills.map((kill, killIndex) => {
            const killerTeam = playerTeamByPuuid.get(kill.killerId);
            const tone: RoundMomentumTone =
              killerTeam === selectedTeamId
                ? "positive"
                : killerTeam === opponentTeamId
                  ? "negative"
                  : "neutral";
            return {
              id: `timeline-kill-${killIndex}-${kill.timeMs}`,
              label: killIndex === 0 ? "Primera baja" : "Eliminación",
              detail: `${timelinePlayerName.get(kill.killerId) ?? "Jugador"} eliminó a ${timelinePlayerName.get(kill.victimId) ?? "rival"}`,
              timeMs: kill.timeMs,
              tone,
            };
          }),
          ...(advancedRound.bombPlanter
            ? [{
                id: "timeline-plant",
                label: "Spike plantada",
                detail: `${timelinePlayerName.get(advancedRound.bombPlanter) ?? "Jugador"} completó el plant`,
                timeMs: advancedRound.plantRoundTime,
                tone:
                  playerTeamByPuuid.get(advancedRound.bombPlanter) === selectedTeamId
                    ? "positive" as const
                    : "negative" as const,
              }]
            : []),
          ...(advancedRound.bombDefuser
            ? [{
                id: "timeline-defuse",
                label: "Defuse completado",
                detail: `${timelinePlayerName.get(advancedRound.bombDefuser) ?? "Jugador"} cerró la ronda`,
                timeMs: advancedRound.defuseRoundTime,
                tone:
                  playerTeamByPuuid.get(advancedRound.bombDefuser) === selectedTeamId
                    ? "positive" as const
                    : "negative" as const,
              }]
            : []),
        ].sort((a, b) => (a.timeMs ?? Number.MAX_SAFE_INTEGER) - (b.timeMs ?? Number.MAX_SAFE_INTEGER))
      : [];

    return {
      roundNumber,
      winningTeamId,
      isSelectedTeamWin,
      momentumBefore,
      momentumAfter,
      momentumChange,
      roundImpact: rawRoundImpact,
      impactLevel,
      dominanceBefore: dominanceFromMomentum(momentumBefore),
      dominanceAfter: dominanceFromMomentum(momentumAfter),
      selectedTeamEconomy: selectedEconomy.economy,
      opponentTeamEconomy: opponentEconomy.economy,
      selectedTeamLoadout: selectedEconomy.loadout,
      opponentTeamLoadout: opponentEconomy.loadout,
      loadoutDiff: selectedEconomy.loadout - opponentEconomy.loadout,
      mainReason,
      eventIcon: getRoundEventIcon(mainReason),
      eventPerspective,
      eventTitle,
      eventDescription,
      roundType,
      shortComment,
      consequence: getEventConsequence(
        sourceEvent,
        currentMomentum,
        selectedTeamId,
      ),
      secondaryEvents: secondaryEvents.map((event) => ({
        type: event.type,
        label: `${getEventPerspective(event, selectedTeamId)} · ${getEventDisplayTitle(event)}`,
      })),
      ticketEvents,
      ticketPlayers,
      timeline,
      confidenceLabel: getConfidenceLabel(sourceEvent),
      evidences: safeEvidences,
      learning,
      beforeItems: [
        { label: "Dominio", value: dominanceLabel(dominanceFromMomentum(momentumBefore)), tone: dominanceFromMomentum(momentumBefore) === "selected" ? "positive" : dominanceFromMomentum(momentumBefore) === "opponent" ? "negative" : "neutral" },
        { label: "Momentum", value: formatNumber(momentumBefore, 1) },
        { label: "Economía", value: `Tu equipo ${selectedEconomy.economy}` },
      ],
      duringItems: [
        { label: "Compras", value: `${selectedEconomy.economy} vs ${opponentEconomy.economy}` },
        { label: "Eventos", value: `${ticketEvents.length} registrados` },
        { label: "Resultado", value: isSelectedTeamWin ? "Gana tu equipo" : "Gana el rival", tone: isSelectedTeamWin ? "positive" : "negative" },
      ],
      afterItems: [
        { label: "Dominio", value: dominanceLabel(dominanceFromMomentum(momentumAfter)), tone: dominanceFromMomentum(momentumAfter) === "selected" ? "positive" : dominanceFromMomentum(momentumAfter) === "opponent" ? "negative" : "neutral" },
        { label: "Momentum", value: formatNumber(momentumAfter, 1) },
        { label: "Variación neta", value: formatMomentumDelta(momentumChange), tone: momentumChange > 0 ? "positive" : momentumChange < 0 ? "negative" : "neutral" },
        { label: "Impacto de ronda", value: formatMomentumDelta(rawRoundImpact), tone: rawRoundImpact > 0 ? "positive" : rawRoundImpact < 0 ? "negative" : "neutral" },
      ],
      selectedPlayerContribution: inferSelectedPlayerContribution({
        round,
        selectedPlayer,
        selectedTeamId,
        opponentTeamId,
        teamByPuuid: playerTeamByPuuid,
        playerImpact: selectedPlayerImpact,
        roundMvp: roundPlayerImpact?.mvp,
      }),
      confidence: sourceEvent?.confidence ?? (currentMomentum ? "medium" : "low"),
      confidenceReason: getConfidenceReason(sourceEvent),
      sourceEvent,
      isKeyRound: Boolean(sourceEvent?.isTurningPoint || currentMomentum?.isSwingRound),
      winnerLabel: isSelectedTeamWin ? "Tu equipo" : winningTeamId ? "Rival" : "Sin ganador",
      winMethod: getRoundWinMethod(round.roundResult, round.roundCeremony),
    };
  });
}

function MatchMomentumPanel({
  momentum,
  advancedMomentum,
  match,
  selectedPlayer,
  teamAId,
  selectedTeamId,
  opponentTeamId,
  agentById,
  agentNameMap,
  mode = "summary",
  selectedRoundNumber,
}: {
  momentum: MatchMomentumResult | null;
  advancedMomentum: AdvancedMomentumResult | null;
  match: RawMatchDetail | null;
  selectedPlayer: RawPlayer | null;
  teamAId: string;
  selectedTeamId: string;
  opponentTeamId: string;
  agentById: Map<string, AgentContent>;
  agentNameMap: Record<string, string>;
  mode?: "summary" | "explorer";
  selectedRoundNumber?: number;
}) {
  const roundViewModels = useMemo(
    () =>
      buildRoundMomentumViewModels({
        match,
        advancedMomentumAnalysis: advancedMomentum,
        selectedPlayer,
        selectedTeamId,
        opponentTeamId,
        teamAId,
      }),
    [advancedMomentum, match, opponentTeamId, selectedPlayer, selectedTeamId, teamAId],
  );
  const defaultSelectedRound = useMemo(() => {
    const primary =
      roundViewModels.find((round) => round.sourceEvent?.isTurningPoint) ??
      roundViewModels.find((round) => round.isKeyRound) ??
      roundViewModels.find((round) => round.sourceEvent) ??
      roundViewModels[0];
    return primary?.roundNumber ?? 1;
  }, [roundViewModels]);
  const [internalSelectedRoundNumber, setInternalSelectedRoundNumber] = useState(defaultSelectedRound);
  const [activePlayerTooltip, setActivePlayerTooltip] = useState<{
    player: RoundMomentumTicketPlayer;
    top: number;
    left: number;
  } | null>(null);
  const playersByPuuid = useMemo(
    () =>
      new Map(
        (match?.players ?? [])
          .map((player) => [cleanId(player.puuid), player] as const)
          .filter(([puuid]) => Boolean(puuid)),
      ),
    [match],
  );

  useEffect(() => {
    setInternalSelectedRoundNumber(defaultSelectedRound);
  }, [defaultSelectedRound]);
  const activeRoundNumber = selectedRoundNumber ?? internalSelectedRoundNumber;
  useEffect(() => {
    setActivePlayerTooltip(null);
  }, [activeRoundNumber]);
  useEffect(() => {
    if (!activePlayerTooltip) return;
    const closeTooltip = () => setActivePlayerTooltip(null);
    window.addEventListener("scroll", closeTooltip, true);
    window.addEventListener("resize", closeTooltip);
    return () => {
      window.removeEventListener("scroll", closeTooltip, true);
      window.removeEventListener("resize", closeTooltip);
    };
  }, [activePlayerTooltip]);
  const showPlayerTooltip = (
    player: RoundMomentumTicketPlayer,
    target: HTMLElement,
  ) => {
    const rect = target.getBoundingClientRect();
    setActivePlayerTooltip({
      player,
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 280)),
      left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 300)),
    });
  };

  if (!momentum || momentum.rounds.length === 0) {
    return (
      <section className="match-analytics-panel match-momentum-panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">Historia del momentum</h3>
            <p className="panel-subtitle">
              No hay rondas suficientes para calcular cambios de dominio.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const orientValue = (value: number) =>
    selectedTeamId === teamAId ? value : -value;
  const selectedRound =
    roundViewModels.find((round) => round.roundNumber === activeRoundNumber) ??
    roundViewModels[0];
  const selectedRoundPlayerImpactMax = Math.max(
    0.01,
    ...(selectedRound?.ticketPlayers.map((player) => Math.abs(player.contribution)) ?? []),
  );
  const selectedControlPercentage =
    selectedTeamId === teamAId
      ? momentum.summary.teamAControlPercentage
      : momentum.summary.teamBControlPercentage;
  const opponentControlPercentage =
    opponentTeamId === teamAId
      ? momentum.summary.teamAControlPercentage
      : momentum.summary.teamBControlPercentage;
  const neutralControlPercentage = Math.max(
    0,
    100 - selectedControlPercentage - opponentControlPercentage,
  );
  const chartData = momentum.rounds.map((round) => {
    const diff = orientValue(round.momentumDiff);
    const vm = roundViewModels.find((entry) => entry.roundNumber === round.roundNumber);
    return {
      round: round.roundNumber,
      diff,
      positiveDiff: diff >= 0.4 ? diff : null,
      negativeDiff: diff <= -0.4 ? diff : null,
      neutralDiff: Math.abs(diff) < 0.4 ? diff : null,
      impact: vm?.roundImpact ?? 0,
      momentumChange: vm?.momentumChange ?? 0,
      impactLabel: vm ? formatMomentumDelta(vm.roundImpact) : "sin cambio claro",
      eventTitle: vm?.eventTitle ?? "Ronda normal",
      eventPerspective: vm?.eventPerspective ?? "Ronda",
      impactLevel: vm ? impactLevelLabel(vm.impactLevel) : "Bajo",
      dominance: vm ? dominanceLabel(vm.dominanceAfter) : diff > 0 ? "Tu equipo" : diff < 0 ? "Rival" : "Equilibrio",
      isSelected: round.roundNumber === selectedRound?.roundNumber,
      isKeyRound: Boolean(vm?.isKeyRound),
      swing: round.isSwingRound ? diff : null,
      event: advancedMomentum?.events.some(
        (event) => event.roundNumber === round.roundNumber && event.totalImpactScore >= 1.5,
      )
        ? diff
        : null,
    };
  });
  const domainChartData = chartData.flatMap((point, index) => {
    const plottedPoint = {
      ...point,
      chartRound: point.round,
      positiveDomain: point.diff >= 0 ? point.diff : null,
      negativeDomain: point.diff <= 0 ? point.diff : null,
      actualDomain: point.diff,
      isSynthetic: false,
    };
    const nextPoint = chartData[index + 1];
    if (
      !nextPoint ||
      point.diff === 0 ||
      nextPoint.diff === 0 ||
      Math.sign(point.diff) === Math.sign(nextPoint.diff)
    ) {
      return [plottedPoint];
    }

    const zeroProgress =
      Math.abs(point.diff) / (Math.abs(point.diff) + Math.abs(nextPoint.diff));
    const crossingRound = point.round + zeroProgress * (nextPoint.round - point.round);
    return [
      plottedPoint,
      {
        ...point,
        round: crossingRound,
        chartRound: crossingRound,
        diff: 0,
        positiveDomain: 0,
        negativeDomain: 0,
        actualDomain: null,
        event: null,
        eventTitle: "",
        impactLevel: "",
        isSynthetic: true,
      },
    ];
  });
  const keyRoundLabel = selectedRound?.isKeyRound
    ? `Ronda ${selectedRound.roundNumber}`
    : "Sin punto único";
  const sideSwitchRound = roundViewModels.find((round) => round.roundNumber === 13);
  const overtimeRound = roundViewModels.find((round) => round.roundNumber >= 25);
  const domainLimit = Math.max(
    2.5,
    ...chartData.map((entry) => Math.abs(entry.diff)),
  );

  return (
    <section className="match-analytics-panel match-momentum-panel">
      {mode === "summary" ? (
        <>
          <div className="panel-header">
            <div>
              <h3 className="panel-title">HISTORIA DEL MOMENTUM</h3>
              <p className="panel-subtitle">
                Cómo cambió el dominio y qué rondas marcaron la diferencia.
              </p>
            </div>
          </div>

          <div className="match-momentum-summary-grid">
            <article>
              <span>Ronda clave</span>
              <strong>{keyRoundLabel}</strong>
              <small>{selectedRound?.roundType ?? "Sin evento claro"}</small>
            </article>
            <article>
              <span>Cambios de dominio</span>
              <strong>{formatNumber(momentum.summary.totalDomainChanges)}</strong>
              <small>veces que cambió el control</small>
            </article>
            <article className="match-momentum-balance-card">
              <span>Balance visual</span>
              <div className="match-momentum-balance-bar" aria-label={`Tu equipo ${selectedControlPercentage}%, rival ${opponentControlPercentage}%, neutral ${neutralControlPercentage}%`}>
                <i className="is-positive" style={{ width: `${selectedControlPercentage}%` }} />
                <i className="is-negative" style={{ width: `${opponentControlPercentage}%` }} />
                {neutralControlPercentage > 0 ? <i className="is-neutral" style={{ width: `${neutralControlPercentage}%` }} /> : null}
              </div>
              <small>Tu equipo {formatPercent(selectedControlPercentage, 0)} · Rival {formatPercent(opponentControlPercentage, 0)}</small>
            </article>
          </div>

          <div className="match-momentum-chart match-momentum-domain-chart">
            <header className="match-momentum-chart-header">
              <div>
                <h4>Evolución del dominio</h4>
                <span>Por encima de cero domina tu equipo; por debajo domina el rival.</span>
              </div>
            </header>
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={domainChartData}>
                <ReferenceArea y1={0} y2={domainLimit} fill="rgba(70,200,120,0.08)" />
                <ReferenceArea y1={-domainLimit} y2={0} fill="rgba(255,70,85,0.08)" />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" strokeDasharray="4 4" />
                {selectedRound ? <ReferenceLine x={selectedRound.roundNumber} stroke="#f3c567" strokeWidth={2} /> : null}
                {sideSwitchRound ? <ReferenceLine x={sideSwitchRound.roundNumber} stroke="rgba(243,197,103,0.45)" strokeDasharray="3 3" /> : null}
                {overtimeRound ? <ReferenceLine x={overtimeRound.roundNumber} stroke="rgba(255,255,255,0.25)" strokeDasharray="2 4" /> : null}
                <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                <XAxis
                  dataKey="chartRound"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  ticks={chartData.map((point) => point.round)}
                  stroke="#9ea8b8"
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis stroke="#9ea8b8" tickLine={false} axisLine={false} domain={[-domainLimit, domainLimit]} />
                <ReTooltip
                  content={({ active, payload }) => {
                    const point = payload?.[0]?.payload as
                      | (typeof domainChartData)[number]
                      | undefined;
                    if (!active || !point || point.isSynthetic) return null;
                    const beneficiary =
                      point.impact > 0
                        ? "Tu equipo"
                        : point.impact < 0
                          ? "Rival"
                          : point.eventPerspective;
                    return (
                      <div className="match-domain-tooltip">
                        <strong>Ronda {point.round}</strong>
                        <span>Momentum: {formatNumber(point.diff, 1)}</span>
                        <span>Equipo beneficiado: {beneficiary}</span>
                        <span>Motivo: {point.eventTitle}</span>
                        <span>Variación neta: {formatMomentumDelta(point.momentumChange)}</span>
                        <span>Impacto de ronda: {formatMomentumDelta(point.impact)}</span>
                      </div>
                    );
                  }}
                />
                <Line
                  type="linear"
                  dataKey="positiveDomain"
                  name="Momentum"
                  stroke="#46c878"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 5, fill: "#f3c567", stroke: "#ffffff" }}
                  connectNulls={false}
                />
                <Line
                  type="linear"
                  dataKey="negativeDomain"
                  name="Momentum"
                  stroke="#ff4655"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 5, fill: "#f3c567", stroke: "#ffffff" }}
                  connectNulls={false}
                />
                <Line
                  type="linear"
                  dataKey="actualDomain"
                  name="Ronda"
                  stroke="#f3c567"
                  strokeWidth={0}
                  dot={{ r: 5, fill: "#f3c567", stroke: "#ffffff" }}
                  tooltipType="none"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </>
      ) : (
        <>
          <div className="panel-header">
            <div>
              <h3 className="panel-title">EXPLORADOR DE MOMENTUM</h3>
              <p className="panel-subtitle">
                Revisa el impacto y el contexto de cada ronda.
              </p>
            </div>
          </div>

      {selectedRound ? (
        <article className="round-analysis-dashboard">
          <header className="round-analysis-hero">
            <div className="round-analysis-identity">
              <span>Ronda {selectedRound.roundNumber}</span>
              <strong className={selectedRound.isSelectedTeamWin ? "is-positive" : "is-negative"}>
                {selectedRound.isSelectedTeamWin ? "Victoria" : "Derrota"}
              </strong>
              <small>{selectedRound.winMethod ?? selectedRound.roundType}</small>
            </div>
            <div className={`round-analysis-momentum ${selectedRound.momentumAfter > 0 ? "is-positive" : selectedRound.momentumAfter < 0 ? "is-negative" : "is-neutral"}`}>
              <span>Momentum final</span>
              <strong>{selectedRound.momentumAfter > 0 ? "+" : ""}{formatNumber(selectedRound.momentumAfter, 1)}</strong>
              <small>{formatMomentumDelta(selectedRound.momentumChange)}</small>
            </div>
            <div className="round-analysis-hero-metrics">
              <div><span>Economía</span><strong>{selectedRound.selectedTeamEconomy ?? "Sin datos"}</strong></div>
            </div>
          </header>

          <section className="round-analysis-executive">
            <div>
              <span>Resumen ejecutivo</span>
              <h4>{selectedRound.eventTitle}</h4>
              <p>{selectedRound.eventDescription || selectedRound.shortComment}</p>
            </div>
            <strong className={selectedRound.momentumChange >= 0 ? "is-positive" : "is-negative"}>
              {selectedRound.momentumChange > 0 ? "+" : ""}{formatNumber(selectedRound.momentumChange, 2)}
              <small>variación neta</small>
            </strong>
          </section>

          <div className="round-analysis-main-grid">
            <section className="round-analysis-card round-analysis-breakdown">
              <header>
                <div><span>Desglose de momentum</span><h4>Acumulado por jugadores</h4></div>
                <small>Ordenado por impacto absoluto</small>
              </header>
              <div className="round-impact-player-list">
                {selectedRound.ticketPlayers.map((player) => {
                  const fallbackAgent = getAgentMeta(
                    playersByPuuid.get(cleanId(player.playerId)),
                    agentById,
                    agentNameMap,
                  );
                  const agentIcon = player.agentIcon ?? fallbackAgent.icon;
                  const agentName = player.agentName ?? fallbackAgent.name;
                  return (
                  <article key={`round-impact-player-${player.playerId}`}>
                    <div className="round-impact-player-name">
                      {agentIcon ? <img src={agentIcon} alt={agentName} /> : <i>{(agentName || player.playerName).charAt(0)}</i>}
                      <div><strong>{player.playerName}</strong><span>{agentName || player.teamLabel}</span></div>
                    </div>
                    <div className="round-impact-player-bar">
                      <i
                        className={player.contribution >= 0 ? "is-positive" : "is-negative"}
                        style={{ width: `${Math.max(4, (Math.abs(player.contribution) / selectedRoundPlayerImpactMax) * 100)}%` }}
                      />
                    </div>
                    <b className={player.contribution >= 0 ? "is-positive" : "is-negative"}>
                      {player.contribution > 0 ? "+" : ""}{formatMomentumContribution(player.contribution)}
                    </b>
                    <button
                      type="button"
                      className="match-momentum-ticket-info"
                      aria-label={`Ver descomposición de ${player.playerName}`}
                      onPointerEnter={(event) => showPlayerTooltip(player, event.currentTarget)}
                      onPointerLeave={() => setActivePlayerTooltip(null)}
                      onFocus={(event) => showPlayerTooltip(player, event.currentTarget)}
                      onBlur={() => setActivePlayerTooltip(null)}
                    >
                      <Info aria-hidden="true" />
                    </button>
                  </article>
                  );
                })}
              </div>
            </section>

            <section className="round-analysis-card round-analysis-events">
              <header>
                <div><span>Causas observadas</span><h4>Eventos que modificaron el momentum</h4></div>
                <small>{selectedRound.ticketEvents.length} eventos</small>
              </header>
              <div className="round-analysis-event-list">
                {selectedRound.ticketEvents.length > 0 ? selectedRound.ticketEvents.map((event) => (
                  <article key={`round-event-${event.id}`} title={event.detail}>
                    <em data-category={getMomentumEventCategory(event)}>{getMomentumEventCategory(event)}</em>
                    <div><strong>{event.label}</strong><span>{event.teamLabel} · {event.detail}</span></div>
                    <b className={event.contribution >= 0 ? "is-positive" : "is-negative"}>
                      {event.isContext ? "Contexto" : `${event.contribution > 0 ? "+" : ""}${formatMomentumContribution(event.contribution)}`}
                    </b>
                  </article>
                )) : <p>Sin eventos extraordinarios; el resultado de ronda explica la mayor parte del cambio.</p>}
              </div>
            </section>

            <section className={`round-analysis-card round-analysis-user is-${selectedRound.selectedPlayerContribution.tone}`}>
              <header><div><span>Contribución del usuario</span><h4>{selectedRound.selectedPlayerContribution.title}</h4></div><Crosshair aria-hidden="true" /></header>
              <p>{selectedRound.selectedPlayerContribution.description}</p>
              <div className="round-analysis-user-stats">
                {selectedRound.selectedPlayerContribution.stats?.map((stat) => (
                  <div key={`player-role-${stat.label}`}><span>{stat.label}</span><strong>{stat.value}</strong></div>
                ))}
              </div>
            </section>

            <section className="round-analysis-card round-analysis-timeline">
              <header><div><span>Secuencia verificable</span><h4>Timeline de la ronda</h4></div><Clock3 aria-hidden="true" /></header>
              <div className="round-analysis-timeline-list">
                <article className="is-neutral"><time>0.0s</time><i /><div><strong>Inicio de ronda</strong><span>Estado inicial</span></div></article>
                {selectedRound.timeline.map((item) => (
                  <article key={item.id} className={`is-${item.tone}`}>
                    <time>{formatRoundTimelineTime(item.timeMs)}</time><i />
                    <div><strong>{item.label}</strong><span>{item.detail}</span></div>
                  </article>
                ))}
                <article className={selectedRound.isSelectedTeamWin ? "is-positive" : "is-negative"}><time>Fin</time><i /><div><strong>{selectedRound.winnerLabel}</strong><span>{selectedRound.winMethod ?? "Ronda finalizada"}</span></div></article>
              </div>
            </section>
          </div>
        </article>
      ) : null}
        </>
      )}
      {activePlayerTooltip &&
        createPortal(
          <div
            className="round-impact-player-tooltip"
            role="tooltip"
            style={{
              top: activePlayerTooltip.top,
              left: activePlayerTooltip.left,
            }}
          >
            <strong>Descomposición · {activePlayerTooltip.player.playerName}</strong>
            {activePlayerTooltip.player.breakdown.map((item, itemIndex) => (
              <span
                key={`${activePlayerTooltip.player.playerId}-${item.label}-${itemIndex}`}
              >
                {item.label}
                <b className={item.value >= 0 ? "is-positive" : "is-negative"}>
                  {item.value > 0 ? "+" : ""}
                  {formatMomentumContribution(item.value)}
                </b>
              </span>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
}

function getEfficiencyLabel(efficiency: EconomyEfficiency): string {
  switch (efficiency) {
    case "optimal":
      return "Óptima";
    case "acceptable":
      return "Aceptable";
    case "risky":
      return "Arriesgada";
    case "inefficient":
      return "Ineficiente";
    default:
      return efficiency;
  }
}

function economyRecommendationStatusLabel(status?: string | null): string {
  switch (status) {
    case "no_supported_counterfactual":
      return "Sin contrafactual";
    case "only_one_viable_action":
      return "Única viable";
    case "matched_real":
      return "Coincide real";
    case "actionable_recommendation":
      return "Accionable";
    default:
      return "Observacional";
  }
}

function economyCreditQualityLabel(quality?: string | null): string {
  switch (quality) {
    case "exact_observed":
      return "Exacta";
    case "reconciled_team":
      return "Reconciliada";
    case "rules_only":
      return "Reglas";
    case "inconsistent":
      return "Inconsistente";
    case "observed_economy":
      return "Observada";
    case "observed_with_reconciliation_warnings":
      return "Avisos";
    default:
      return "N/D";
  }
}

function economyCaseLabel(value?: string | null): string {
  if (!value) return "N/D";
  const labels: Record<string, string> = {
    PISTOL_UTILITY: "Pistola con utilidad",
    PISTOL_SIDEARM: "Pistola mejorada",
    PISTOL_ARMOR: "Pistola con escudo",
    PISTOL_DEFAULT: "Pistola estándar",
    POST_PISTOL_CONVERSION: "Conversión tras pistola",
    ANTI_ECO: "Antieco",
    ECO: "Ahorro",
    HALF_BUY: "Compra parcial",
    FORCE_BUY: "Compra forzada",
    FULL_BUY: "Compra completa",
    BONUS_UPGRADE: "Mejora de la ronda de bonificación",
    BONUS_KEEP_WEAPONS: "Ronda de bonificación conservando armas",
    BONUS_KEEP_INVENTORY: "Ronda de bonificación conservando equipamiento",
    BROKEN_BUY: "Compra descoordinada",
    UNDERINVESTED_BUY: "Compra insuficiente",
    LAST_HALF_ROUND_BUY: "Compra de última ronda de mitad",
    ELIMINATION_BUY: "Compra para evitar eliminación",
    CLOSING_BUY: "Compra para cerrar la partida",
    OVERTIME_BUY: "Compra de prórroga",
    ENEMY_PISTOL: "Ronda de pistolas",
  };
  if (labels[value]) return labels[value];
  return value.replaceAll("_", " ").toLocaleLowerCase("es-ES");
}

function economyItemLabel(item?: { displayName?: string | null } | null): string {
  return item?.displayName || "No comprar";
}

function normalizeAgentReference(value?: string | null): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/[^a-z0-9]/g, "");
}

function PlayerFirstEconomyPanel({
  ml,
  teamAId,
  teamBId,
  teamALabel,
  teamBLabel,
  agents,
}: {
  ml: EconomyMlResponse;
  teamAId: string;
  teamBId: string;
  teamALabel: string;
  teamBLabel: string;
  agents: AgentContent[];
}) {
  const agentsByReference = useMemo(() => {
    const references = new Map<string, AgentContent>();
    for (const agent of agents) {
      for (const reference of [agent.uuid, agent.id, agent.displayName, agent.name]) {
        const key = normalizeAgentReference(reference);
        if (key) references.set(key, agent);
      }
    }
    return references;
  }, [agents]);
  const roundsByNumber = useMemo(() => {
    const grouped = new Map<number, Map<string, EconomyMlResponse["rounds"][number]>>();
    for (const round of ml.rounds) {
      const teams = grouped.get(round.round_number) ?? new Map();
      teams.set(round.team_id, round);
      grouped.set(round.round_number, teams);
    }
    return [...grouped.entries()].sort(([a], [b]) => a - b);
  }, [ml.rounds]);

  const buyLabel = (round?: EconomyMlResponse["rounds"][number]) =>
    round ? economyCaseLabel(round.recommended_team_buy) : "Sin datos";
  const observedSpend = (round?: EconomyMlResponse["rounds"][number]) => {
    const actualPlayers = (round?.actual_plan as { players?: Array<{ total_outlay?: number | null }> } | undefined)?.players ?? [];
    return actualPlayers.reduce((sum, player) => sum + Number(player.total_outlay ?? 0), 0);
  };
  const recommendedSpend = (round?: EconomyMlResponse["rounds"][number]) =>
    (((round?.recommended_plan as { players?: Array<{ total_outlay?: number | null }> } | undefined)?.players) ?? [])
      .reduce((sum, player) => sum + Number(player.total_outlay ?? 0), 0);
  const creditsBefore = (round?: EconomyMlResponse["rounds"][number]) =>
    (round?.players ?? []).reduce((sum, player) => sum + Number(player.credits_before_buy ?? 0), 0);
  const creditsRemaining = (round?: EconomyMlResponse["rounds"][number]) =>
    (((round?.recommended_plan as { players?: Array<{ expected_remaining?: number | null }> } | undefined)?.players) ?? [])
      .reduce((sum, player) => sum + Number(player.expected_remaining ?? 0), 0);
  const roundNote = (round?: EconomyMlResponse["rounds"][number]) =>
    round?.warnings?.[0] ?? "El plan recomendado mantiene una economía de equipo coherente.";
  const scoreLabel = (round?: EconomyMlResponse["rounds"][number]) => {
    if (round?.team_purchase_score == null) return "Sin nota";
    if (round.team_recommendation_equivalent_to_actual) return "Sin diferencia";
    const range = round.score_range;
    if (range && range[0] !== range[1]) return `${formatNumber(range[0], 0)}–${formatNumber(range[1], 0)}`;
    return `${formatNumber(round.team_purchase_score, 0)}/100`;
  };
  const observedBuyLabel = (round?: EconomyMlResponse["rounds"][number]) => {
    const kind = classifyTeamEconomy(observedSpend(round));
    return kind === "FULL" ? "Compra completa" : kind === "SEMIECO" ? "Compra parcial" : "Ahorro";
  };

  const renderTeamRound = (
    roundNumber: number,
    round: EconomyMlResponse["rounds"][number] | undefined,
    teamLabel: string,
    isOpponent = false,
  ) => {
    if (!round) {
      return (
        <div key={`${roundNumber}-${teamLabel}`} className={`match-economy-board-round is-missing ${isOpponent ? "is-opponent" : ""}`}>
          <span className="match-economy-board-team-dot" />
          <span><strong>{teamLabel}</strong><small>Sin recomendación disponible</small></span>
        </div>
      );
    }
    const side = String(round.side ?? "").toLowerCase();
    const isAttack = side.includes("attack") || side.includes("ataque");
    const actualBuy = observedBuyLabel(round);
    return (
      <details key={`${roundNumber}-${round.team_id}`} className={`match-economy-board-round ${isAttack ? "is-attack" : "is-defense"} ${isOpponent ? "is-opponent" : ""}`}>
        <summary>
          <span className="match-economy-board-team-identity">
            <span className="match-economy-board-team-dot" />
            <span><strong>{teamLabel}</strong><small>{isAttack ? "Ataque" : "Defensa"}</small></span>
          </span>
          <span className="match-economy-board-buy is-observed"><small>Compra realizada</small><strong>{actualBuy}</strong></span>
          <span className="match-economy-board-buy"><small>Recomendación</small><strong>{buyLabel(round)}</strong></span>
          <span className="match-economy-board-grade"><small>Nota de compra</small><strong>{scoreLabel(round)}</strong><em>{round.team_grade ?? ""}</em></span>
          <span className="match-economy-board-confidence"><small>Confianza</small>{formatPercent(round.confidence * 100, 0)}</span>
        </summary>
        <div className="match-economy-board-round-body">
          <div className="match-economy-board-notes">
            <p><small>Compra realizada</small><strong>{actualBuy}</strong><span>{round.warnings?.[0] ?? "Sin incidencia económica destacable."}</span></p>
            <p className="is-recommendation"><small>Recomendación económica</small><strong>{buyLabel(round)}</strong><span>{roundNote(round)}</span></p>
          </div>
          <div className="match-economy-board-totals">
            <span><small>Créditos inicio</small><strong>{formatNumber(creditsBefore(round))}</strong></span>
            <span><small>Compra real</small><strong>{formatNumber(observedSpend(round))}</strong></span>
            <span><small>Plan recomendado</small><strong>{formatNumber(recommendedSpend(round))}</strong></span>
            <span><small>Restante plan</small><strong>{formatNumber(creditsRemaining(round))}</strong></span>
            <span><small>Valor perdido</small><strong>{formatNumber(round.value_gap ?? 0, 3)}</strong></span>
          </div>
          {round.ambiguity_reason && <p className="match-economy-board-uncertainty">{round.ambiguity_reason}</p>}
          {round.coordination_only_improvement && <p className="match-economy-board-uncertainty">Las compras son buenas individualmente; la mejora estimada requiere cambiar la distribución del equipo de forma coordinada.</p>}
          <div className="match-economy-board-players">
            {round.players.map((player) => {
              const purchase = player.recommended_purchase;
              const agent = agentsByReference.get(normalizeAgentReference(player.agent));
              const agentName = agent?.displayName ?? player.agent ?? "Agente no identificado";
              const agentIcon = agent?.displayIconSmall ?? agent?.displayIcon;
              const observed = [player.observed_weapon, player.observed_armor].filter(Boolean).join(" + ") || "Sin datos";
              const recommended = purchase.display?.loadout_label ?? `${economyItemLabel(purchase.weapon)} + ${economyItemLabel(purchase.armor)}`;
              const abilities = purchase.display?.ability_label ?? (purchase.abilities.length ? purchase.abilities.map((ability) => `${ability.name} ×${ability.charges}`).join(", ") : "Sin compra de habilidades");
              const includedAbilities = purchase.display?.included_ability_label;
              return <article key={player.puuid} className="match-economy-board-player">
                <header>
                  {agentIcon ? <img src={agentIcon} alt={agentName} onError={({ currentTarget }) => {
                    const fallbackIcon = agent?.displayIcon;
                    if (fallbackIcon && currentTarget.dataset.fallbackAttempted !== "true") {
                      currentTarget.dataset.fallbackAttempted = "true";
                      currentTarget.src = fallbackIcon;
                    } else {
                      currentTarget.classList.add("is-unavailable");
                    }
                  }} /> : <span className="match-economy-board-agent-fallback" aria-label={agentName} />}
                  <div><strong>{player.player_name ?? "Jugador"}</strong><small>{agentName}</small></div>
                </header>
                <div className="match-economy-board-player-grade">
                  <span><small>Nota individual</small><strong>{player.recommendation_equivalent_to_actual ? "Equivalente" : player.score_range && player.score_range[0] !== player.score_range[1] ? `${formatNumber(player.score_range[0], 0)}–${formatNumber(player.score_range[1], 0)}` : `${formatNumber(player.purchase_score ?? 0, 0)}/100`}</strong></span>
                  <em>{player.grade ?? "Sin calificar"}</em>
                </div>
                <div className="match-economy-board-player-loadouts"><span><small>Compra real</small>{observed}</span><span className="is-recommended"><small>Mejor decisión individual</small>{recommended}</span></div>
                <p className="match-economy-board-player-reason">{player.reason || "El modelo no identifica una mejora concreta."}</p>
                <p className="match-economy-board-ability"><small>Habilidades recomendadas</small>{abilities}</p>
                {includedAbilities && includedAbilities !== "Ninguna" && <p className="match-economy-board-ability"><small>Habilidades gratuitas o conservadas</small>{includedAbilities}</p>}
                <footer><span><small>Inicio</small>{formatNumber(player.credits_before_buy ?? 0)}</span><span><small>Compra</small>{formatNumber(purchase.self_cost)}</span><span><small>Restante</small>{formatNumber(purchase.expected_remaining)}</span></footer>
                {player.ambiguity_reason && <p className="match-economy-board-uncertainty">{player.ambiguity_reason}</p>}
              </article>;
            })}
          </div>
        </div>
      </details>
    );
  };

  return (
    <section className="match-economy-optimal-panel match-economy-board-panel">
      <h3 className="panel-title match-economy-board-title">Recomendaciones económicas</h3>
      <div className="match-economy-board">
        <article className="match-economy-board-team">
          <header><span className="match-economy-board-team-dot" /><div><small>Equipo</small><h4>{teamALabel}</h4></div></header>
          {roundsByNumber.map(([roundNumber, teams]) => renderTeamRound(roundNumber, teams.get(teamAId), teamALabel))}
        </article>
        <article className="match-economy-board-score">
          <header><small>Seguimiento de rondas</small><h4>Marcador</h4></header>
          {roundsByNumber.map(([roundNumber, teams]) => {
            const round = teams.get(teamAId) ?? teams.get(teamBId);
            const isTeamA = round?.team_id === teamAId;
            const scoreA = isTeamA ? round?.score_before.team : round?.score_before.enemy;
            const scoreB = isTeamA ? round?.score_before.enemy : round?.score_before.team;
            return <div key={roundNumber} className="match-economy-board-score-row"><small>Ronda {roundNumber}</small><strong>{scoreA ?? "?"}<i>–</i>{scoreB ?? "?"}</strong></div>;
          })}
        </article>
        <article className="match-economy-board-team is-opponent">
          <header><span className="match-economy-board-team-dot" /><div><small>Equipo rival</small><h4>{teamBLabel}</h4></div></header>
          {roundsByNumber.map(([roundNumber, teams]) => renderTeamRound(roundNumber, teams.get(teamBId), teamBLabel, true))}
        </article>
      </div>
    </section>
  );
}

function EconomyOptimalPanel({
  ml,
  analysis,
  momentum,
  teamAId,
  teamBId,
  teamALabel,
  teamBLabel,
  selectedTeamKey,
  agents,
}: {
  ml: EconomyMlResponse | undefined;
  analysis: EconomyEfficiencyAnalysis | null;
  momentum: MatchMomentumResult | null;
  teamAId: string;
  teamBId: string;
  teamALabel: string;
  teamBLabel: string;
  selectedTeamKey: "teamA" | "teamB";
  agents: AgentContent[];
}) {
  if (ml?.available && (ml.engine === "player_first_v10" || ml.engine === "player_first_v12_decision_grade") && ml.rounds.length > 0) {
    return <PlayerFirstEconomyPanel ml={ml} teamAId={teamAId} teamBId={teamBId} teamALabel={teamALabel} teamBLabel={teamBLabel} agents={agents} />;
  }
  // LEGACY read-only fallback for saved responses. Production routes only emit player_first_v10.
  if (ml?.available && ml.rounds.length > 0) {
    const different = ml.rounds.filter(
      (round) => round.real_buy_action !== round.recommended_action,
    );
    const validDeltas = ml.rounds
      .map((round) => round.delta_team_plan_value)
      .filter((value): value is number => typeof value === "number");
    const averageConfidence = safeDivide(
      ml.rounds.reduce((sum, round) => sum + round.confidence, 0),
      ml.rounds.length,
    );
    const similarRounds = ml.rounds.reduce(
      (sum, round) => sum + round.similar_rounds_summary.similar_rounds_found,
      0,
    );
    const scopes = [...new Set(ml.rounds.map((round) => round.model_scope))].join(", ");
    const ranks = [...new Set(ml.rounds.map((round) => round.rank_name))].join(", ");
    const metadata = ml.model_metadata;
    const modelCounts = metadata?.model_counts;
    const globalMetrics = metadata?.global_metrics;
    const trainedAt = metadata?.created_at
      ? new Date(metadata.created_at).toLocaleString("es-ES", {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "N/D";
    const teamLabel = (teamId: string) =>
      teamId === teamAId ? teamALabel : teamId === teamBId ? teamBLabel : teamId;

    return (
      <section className="match-economy-optimal-panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">Predicción de economía útil</h3>
            <p className="panel-subtitle">
              Estimación observacional calibrada para mejorar el valor de partida. Solo compara acciones viables con soporte histórico suficiente.
            </p>
          </div>
        </div>
        <div className="match-economy-optimal-summary">
          <article><span>Modelo usado</span><strong>{scopes} · calibrado</strong></article>
          <article><span>Rango analizado</span><strong>{ranks}</strong></article>
          <article><span>Recomendaciones distintas</span><strong>{different.length}</strong></article>
          <article><span>Mayor mejora estimada</span><strong>{formatPercent(Math.max(0, ...validDeltas) * 100, 1)}</strong></article>
          <article><span>Confianza media</span><strong>{formatPercent(averageConfidence * 100, 1)}</strong></article>
          <article><span>Rondas similares usadas</span><strong>{formatNumber(similarRounds)}</strong></article>
          <article><span>Filas entrenamiento</span><strong>{formatNumber(metadata?.dataset_rows ?? 0)}</strong></article>
          <article><span>Entrenado</span><strong>{trainedAt}</strong></article>
          <article><span>Schema</span><strong>{metadata?.schema_version ? `v${metadata.schema_version}` : "N/D"}</strong></article>
          <article>
            <span>Modelos entrenados</span>
            <strong>
              G {modelCounts?.global ?? 0} · Gr {modelCounts?.rank_groups ?? 0} · R {modelCounts?.rank_names ?? 0}
            </strong>
          </article>
          <article>
            <span>Utilidad agentes</span>
            <strong>{metadata?.includes_agent_utility ? `Sí · ${metadata.agent_utility_features_count ?? 0} señales` : "No"}</strong>
          </article>
          <article>
            <span>ROC AUC global</span>
            <strong>{globalMetrics?.roc_auc == null ? "N/D" : formatNumber(globalMetrics.roc_auc, 3)}</strong>
          </article>
        </div>
        <div className="match-economy-optimal-table-wrap">
          <table className="match-economy-optimal-table">
            <thead><tr>
              <th>Ronda</th><th>Equipo</th><th>Rango</th><th>Compra real</th>
              <th>Créditos inicio</th><th>Spent</th><th>Loadout</th>
              <th>Calidad créditos</th><th>Caso</th>
              <th>Recomendación</th><th>Estado</th><th>Δ plan</th><th>Δ ronda</th><th>Δ fullbuy</th><th>Valor real</th><th>Valor recomendado</th>
              <th>Δ prob. partida</th><th>Confianza</th><th>Motivo</th>
            </tr></thead>
            <tbody>
              {ml.rounds.map((round) => (
                <tr key={`${round.round_number}-${round.team_id}`}>
                  <td>{round.round_number}</td>
                  <td>{teamLabel(round.team_id)}</td>
                  <td>{round.rank_name}</td>
                  <td>{round.real_buy_action}</td>
                  <td className="match-economy-number-cell">
                    {formatNumber(round.prebuy_credits_selected ?? round.team_credits_before_buy ?? 0)}
                    <small>selected</small>
                  </td>
                  <td className="match-economy-number-cell">{formatNumber(round.team_spent ?? 0)}</td>
                  <td className="match-economy-number-cell">{formatNumber(round.team_loadout ?? 0)}</td>
                  <td>
                    <span className={`match-economy-quality-pill is-${round.credit_estimate_quality ?? "unknown"}`}>
                      {economyCreditQualityLabel(round.credit_estimate_quality)}
                    </span>
                    {(round.team_possible_drop_credit_gap ?? 0) > 0 ? (
                      <small>gap {formatNumber(round.team_possible_drop_credit_gap ?? 0)}</small>
                    ) : null}
                  </td>
                  <td>
                    <span className="match-economy-case-label">{economyCaseLabel(round.target_loadout_case)}</span>
                    <small>obs. {economyCaseLabel(round.observed_cashflow_case ?? round.cashflow_case)}</small>
                    <small>plan {economyCaseLabel(round.planned_cashflow_case)}</small>
                  </td>
                  <td>{round.recommended_action}</td>
                  <td>
                    <span className={`match-economy-status-pill is-${round.recommendation_status ?? "unknown"}`}>
                      {economyRecommendationStatusLabel(round.recommendation_status)}
                    </span>
                    <small>{round.num_viable_alternatives ?? 0} viables</small>
                    {round.credit_estimate_quality === "inconsistent" ? (
                      <small>Baja confianza por créditos</small>
                    ) : null}
                    {round.in_sample ? <small>En entrenamiento</small> : null}
                  </td>
                  <td>{round.delta_team_plan_value == null ? "N/D" : `${round.delta_team_plan_value >= 0 ? "+" : ""}${formatPercent(round.delta_team_plan_value * 100, 1)}`}</td>
                  <td>{round.delta_round_win == null ? "N/D" : `${round.delta_round_win >= 0 ? "+" : ""}${formatPercent(round.delta_round_win * 100, 1)}`}</td>
                  <td>{round.delta_next_fullbuy == null ? "N/D" : `${round.delta_next_fullbuy >= 0 ? "+" : ""}${formatPercent(round.delta_next_fullbuy * 100, 1)}`}</td>
                  <td>{round.real_action_estimated_match_win_probability === null ? "N/D" : formatPercent(round.real_action_estimated_match_win_probability * 100, 1)}</td>
                  <td>{formatPercent(round.estimated_match_win_probability * 100, 1)}</td>
                  <td>{round.delta_vs_real === null ? "N/D" : `${round.delta_vs_real >= 0 ? "+" : ""}${formatPercent(round.delta_vs_real * 100, 1)}`}</td>
                  <td>{formatPercent(round.confidence * 100, 1)}</td>
                  <td>
                    <details className="match-economy-ml-detail">
                      <summary>{round.explanation[0] ?? "Ver explicación"}</summary>
                      <p>{round.explanation.join(" ")}</p>
                      <small>
                        Scope: {round.model_scope} · Similares: {round.similar_rounds_summary.similar_rounds_found}
                        {" · "}Créditos: {economyCreditQualityLabel(round.credit_estimate_quality)}
                        {" · "}Rules {formatNumber(round.prebuy_credits_rules ?? 0)}
                        {" · "}Observed {round.prebuy_credits_observed == null ? "N/D" : formatNumber(round.prebuy_credits_observed)}
                        {" · "}Selected {formatNumber(round.prebuy_credits_selected ?? round.team_credits_before_buy ?? 0)}
                        {round.in_sample ? " · Partida dentro del entrenamiento" : ""}
                        {round.credit_estimate_inconsistency_reason ? ` · ${round.credit_estimate_inconsistency_reason}` : ""}
                        {round.team_drop_reconciliation_status ? ` · ${economyCaseLabel(round.team_drop_reconciliation_status)}` : ""}
                      </small>
                      {round.utility_summary && (
                        <div className="match-economy-ml-utility">
                          <span>Utilidad de composición: <strong>{formatPercent((round.utility_summary.team_total_utility_score ?? 0) * 100, 1)}</strong></span>
                          <span>Resiliencia baja economía: <strong>{formatPercent((round.utility_summary.team_low_economy_resilience ?? 0) * 100, 1)}</strong></span>
                          <span>Dependencia de armas: <strong>{formatPercent((round.utility_summary.team_weapon_dependency_score ?? 0) * 100, 1)}</strong></span>
                          <span>Ventaja utilidad: <strong>{`${(round.utility_summary.utility_score_diff ?? 0) >= 0 ? "+" : ""}${formatPercent((round.utility_summary.utility_score_diff ?? 0) * 100, 1)}`}</strong></span>
                        </div>
                      )}
                      {round.recommended_team_plan && (
                        <div className="match-economy-ml-plan">
                          <span>Estrategia <strong>{round.recommended_team_plan.macro_case ?? round.recommended_team_plan.team_buy_case ?? round.recommended_action}</strong></span>
                          <span>Subtipo <strong>{round.recommended_team_plan.subtype ?? round.recommended_team_plan.team_buy_subtype ?? "N/D"}</strong></span>
                          <span>Valor plan <strong>{formatPercent((round.recommended_team_plan.team_plan_value ?? 0) * 100, 1)}</strong></span>
                          <span>Ganar ronda <strong>{round.recommended_team_plan.predicted_round_win == null ? "N/D" : formatPercent(round.recommended_team_plan.predicted_round_win * 100, 1)}</strong></span>
                          <span>Ganar partida <strong>{round.recommended_team_plan.predicted_match_win == null ? formatPercent(round.estimated_match_win_probability * 100, 1) : formatPercent(round.recommended_team_plan.predicted_match_win * 100, 1)}</strong></span>
                          <span>Fullbuy sig. <strong>{round.recommended_team_plan.next_round_fullbuy_probability == null ? "N/D" : formatPercent(round.recommended_team_plan.next_round_fullbuy_probability * 100, 1)}</strong></span>
                          <span>Coherencia <strong>{formatPercent((round.recommended_team_plan.coherence_score ?? 0) * 100, 1)}</strong></span>
                          <span>Riesgo <strong>{formatPercent((round.recommended_team_plan.economic_risk_score ?? 0) * 100, 1)}</strong></span>
                          <span>Armas <strong>{formatNumber(round.recommended_team_plan.estimated_weapon_spend ?? round.recommended_team_plan.weapon_spend_estimate ?? 0)}</strong></span>
                          <span>Escudos <strong>{formatNumber(round.recommended_team_plan.estimated_armor_spend ?? round.recommended_team_plan.armor_spend_estimate ?? 0)}</strong></span>
                          <span>Utilidad <strong>{round.recommended_team_plan.estimated_ability_spend == null ? "N/D" : formatNumber(round.recommended_team_plan.estimated_ability_spend)}</strong></span>
                          <span>Restante <strong>{formatNumber(round.recommended_team_plan.expected_remaining ?? round.recommended_team_plan.expected_remaining_after_buy ?? 0)}</strong></span>
                        </div>
                      )}
                      {round.recommended_team_plan?.ability_budget_unknown ? (
                        <p className="match-economy-ml-warning">Coste de habilidades no disponible. Se muestra foco de utilidad, no presupuesto exacto.</p>
                      ) : null}
                      {(round.recommended_team_plan?.warnings?.length ?? 0) > 0 ? (
                        <ul className="match-economy-ml-warnings">
                          {round.recommended_team_plan?.warnings?.map((warning: string) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      ) : null}
                      {(round.limitations?.length ?? 0) > 0 ? (
                        <ul className="match-economy-ml-limitations">
                          {round.limitations?.map((limitation: string) => (
                            <li key={limitation}>{limitation}</li>
                          ))}
                        </ul>
                      ) : null}
                      <ul>
                        {round.alternatives.map((alternative) => (
                          <li key={alternative.action}>
                            {alternative.action}: {alternative.estimated_match_win_probability === null
                              ? alternative.reason_if_unavailable ?? "No disponible"
                              : `${formatPercent(alternative.estimated_match_win_probability * 100, 1)} · soporte ${alternative.historical_support ?? "N/D"}`}
                          </li>
                        ))}
                      </ul>
                      {(round.player_recommendations?.length ?? 0) > 0 && (
                        <div className="match-economy-ml-players">
                          <div className="match-economy-ml-players-header">
                            <strong>Plan por jugador</strong>
                            <span>{teamLabel(round.team_id)} · ronda {round.round_number}</span>
                          </div>
                          <table className="match-economy-player-table">
                            <thead>
                              <tr>
                                <th>Jugador</th>
                                <th>Agente</th>
                                <th>Créditos inicio</th>
                                <th>Spent</th>
                                <th>Loadout</th>
                                <th>Compra real</th>
                                <th>Recomendación</th>
                                <th>Utilidad / ajuste</th>
                              </tr>
                            </thead>
                            <tbody>
                              {round.player_recommendations?.map((player: any) => (
                                <tr key={player.puuid}>
                                  <td>
                                    <strong className="match-economy-player-name">{player.player_name}</strong>
                                  </td>
                                  <td>
                                    <span className="match-economy-player-agent">{player.agent ?? "N/D"}</span>
                                    <small>{player.role ?? "N/D"}</small>
                                  </td>
                                  <td className="match-economy-number-cell">
                                    {formatNumber(player.credits_before_buy ?? player.estimated_credits ?? 0)}
                                    <small>pre-buy</small>
                                  </td>
                                  <td className="match-economy-number-cell">
                                    {formatNumber(player.real_spent ?? 0)}
                                    <small>gastado</small>
                                  </td>
                                  <td className="match-economy-number-cell">
                                    {formatNumber(player.real_loadout_value ?? 0)}
                                    <small>equipo</small>
                                  </td>
                                  <td>
                                    <span className="match-economy-loadout-chip">
                                      {[player.real_weapon, player.real_armor].filter(Boolean).join(" + ") || "N/D"}
                                    </span>
                                  </td>
                                  <td>
                                    <span className="match-economy-loadout-chip is-recommended">
                                      {[player.recommended_weapon, player.recommended_armor].filter(Boolean).join(" + ") || "Ahorrar"}
                                    </span>
                                    <small>
                                      Utilidad {formatPercent((player.agent_utility_score ?? 0) * 100, 1)}
                                      {" · "}
                                      Dep. arma {formatPercent((player.agent_weapon_dependency_score ?? 0) * 100, 1)}
                                    </small>
                                    {player.reason?.[0] ? <small>{player.reason[0]}</small> : null}
                                  </td>
                                  <td>
                                    <small>
                                      Presupuesto utilidad {player.recommended_ability_budget == null ? "N/D" : formatNumber(player.recommended_ability_budget)}
                                    </small>
                                    <small>
                                      Foco {(player.recommended_utility_focus ?? player.recommended_ability_focus ?? []).join(", ") || "N/D"}
                                    </small>
                                    <small>
                                      Estilo {formatPercent((Number(player.player_fit_score) || 0) * 100, 1)}
                                      {" · "}
                                      Racha {formatPercent((Number(player.player_form_score) || 0) * 100, 1)}
                                    </small>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (!analysis || analysis.rounds.length === 0) {
    return (
      <section className="match-economy-optimal-panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">Predicción de economía útil</h3>
            <p className="panel-subtitle">
              {ml?.reason ?? "No hay modelo entrenado ni datos heurísticos suficientes."}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const momentumByRound = new Map(
    (momentum?.rounds ?? []).map((round) => [round.roundNumber, round]),
  );
  const chartData = analysis.rounds.map((round) => ({
    round: round.roundNumber,
    teamA: round.teamA.efficiencyScore,
    teamB: round.teamB.efficiencyScore,
  }));
  const teamRows = (round: EconomyEfficiencyAnalysis["rounds"][number]) => [
    {
      key: "teamA" as const,
      roundNumber: round.roundNumber,
      team: `${teamALabel}${selectedTeamKey === "teamA" ? " · Tu equipo" : " · Rival"}`,
      data: round.teamA,
      momentum: momentumByRound.get(round.roundNumber),
    },
    {
      key: "teamB" as const,
      roundNumber: round.roundNumber,
      team: `${teamBLabel}${selectedTeamKey === "teamB" ? " · Tu equipo" : " · Rival"}`,
      data: round.teamB,
      momentum: momentumByRound.get(round.roundNumber),
    },
  ].sort((a, b) => (a.key === selectedTeamKey ? -1 : b.key === selectedTeamKey ? 1 : 0));
  const flattenedRows = analysis.rounds.flatMap(teamRows);
  const biggestError = [
    analysis.summary.teamAMostInefficientRound,
    analysis.summary.teamBMostInefficientRound,
  ]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];

  return (
    <section className="match-economy-optimal-panel">
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Predicción de economía útil</h3>
          <p className="panel-subtitle">
            {ml?.reason ?? "Modelo no disponible."} Mostrando heurística actual como fallback visual.
          </p>
        </div>
      </div>

      <div className="match-economy-optimal-summary">
        <article>
          <span>Eficiencia de tu equipo</span>
          <strong>
            {formatPercent(
              selectedTeamKey === "teamA"
                ? analysis.summary.teamAAverageEfficiency
                : analysis.summary.teamBAverageEfficiency,
              0,
            )}
          </strong>
        </article>
        <article>
          <span>Eficiencia rival</span>
          <strong>
            {formatPercent(
              selectedTeamKey === "teamA"
                ? analysis.summary.teamBAverageEfficiency
                : analysis.summary.teamAAverageEfficiency,
              0,
            )}
          </strong>
        </article>
        <article>
          <span>Óptima equipo seleccionado</span>
          <strong>
            {selectedTeamKey === "teamA"
              ? analysis.summary.teamAOptimalRounds
              : analysis.summary.teamBOptimalRounds}
          </strong>
        </article>
        <article>
          <span>Óptima rival</span>
          <strong>
            {selectedTeamKey === "teamA"
              ? analysis.summary.teamBOptimalRounds
              : analysis.summary.teamAOptimalRounds}
          </strong>
        </article>
        <article>
          <span>Mayor error económico</span>
          <strong>{biggestError ? roundLabel(biggestError - 1) : "Sin datos"}</strong>
        </article>
        <article>
          <span>Mejor aprovechamiento económico</span>
          <strong>
            {analysis.summary.biggestEconomicUpsetRound
              ? roundLabel(analysis.summary.biggestEconomicUpsetRound - 1)
              : "Sin datos"}
          </strong>
        </article>
      </div>

      <div className="match-economy-efficiency-chart">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
            <XAxis dataKey="round" stroke="#9ea8b8" tickLine={false} axisLine={false} />
            <YAxis stroke="#9ea8b8" tickLine={false} axisLine={false} domain={[0, 100]} />
            <ReTooltip
              contentStyle={{
                background: "#11151c",
                border: "1px solid rgba(255,70,85,0.35)",
                borderRadius: 10,
                color: "#f4f7fb",
              }}
              labelFormatter={(label) => `Ronda ${label}`}
            />
            <Line
              type="monotone"
              dataKey="teamA"
              name={teamALabel}
              stroke={selectedTeamKey === "teamA" ? "#46c878" : "#ff4655"}
              strokeWidth={selectedTeamKey === "teamA" ? 3 : 2}
              dot={{ r: selectedTeamKey === "teamA" ? 3 : 2 }}
            />
            <Line
              type="monotone"
              dataKey="teamB"
              name={teamBLabel}
              stroke={selectedTeamKey === "teamB" ? "#46c878" : "#ff4655"}
              strokeWidth={selectedTeamKey === "teamB" ? 3 : 2}
              dot={{ r: selectedTeamKey === "teamB" ? 3 : 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="match-economy-optimal-table-wrap">
        <table className="match-economy-optimal-table">
          <thead>
            <tr>
              <th>Ronda</th>
              <th>Equipo</th>
              <th>Compra real</th>
              <th>Compra recomendada</th>
              <th>Créditos inicio</th>
              <th>Spent</th>
              <th>Loadout</th>
              <th>Resultado</th>
              <th>Eficiencia</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {flattenedRows.map((row) => {
              const momentumTag = row.momentum?.isSwingRound
                ? "Ronda de alto momentum"
                : row.data.isEconomicSwing
                  ? "Swing económico"
                  : "";
              return (
                <tr key={`${row.roundNumber}-${row.team}`}>
                  <td>{row.roundNumber}</td>
                  <td>{row.team}</td>
                  <td>{row.data.realType}</td>
                  <td>{row.data.recommendedType}</td>
                  <td className="match-economy-number-cell">{formatNumber(row.data.credits ?? 0)}</td>
                  <td className="match-economy-number-cell">{formatNumber(row.data.spent ?? 0)}</td>
                  <td>{formatNumber(row.data.loadout)}</td>
                  <td>{row.data.result === "win" ? "Victoria" : "Derrota"}</td>
                  <td>
                    <span className={`match-efficiency-pill is-${row.data.efficiency}`}>
                      {getEfficiencyLabel(row.data.efficiency)} · {row.data.efficiencyScore}
                    </span>
                  </td>
                  <td>
                    {row.data.reason}
                    {momentumTag ? <em>{momentumTag}</em> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function summarizeTeamEconomy(
  data: RoundTeamLoadout[],
  team: "teamA" | "teamB",
  label: string,
): TeamEconomySummary {
  const valueKey = team === "teamA" ? "teamAValue" : "teamBValue";
  const spentKey = team === "teamA" ? "teamASpent" : "teamBSpent";
  const wonKey = team === "teamA" ? "teamAWon" : "teamBWon";
  const buyTypes = (["eco", "semiEco", "fullBuy"] as const).reduce(
    (acc, key) => {
      const rounds = data.filter(
        (round) => classifyRoundEconomy(round[spentKey], round[valueKey]) === key,
      );
      const wins = rounds.filter((round) => round[wonKey]).length;
      acc[key] = {
        rounds: rounds.length,
        wins,
        winRate: safeDivide(wins, Math.max(rounds.length, 1)) * 100,
      };
      return acc;
    },
    {} as TeamEconomySummary["buyTypes"],
  );

  const totalLoadout = data.reduce((sum, round) => sum + round[valueKey], 0);
  const totalSpent = data.reduce((sum, round) => sum + round[spentKey], 0);

  return {
    key: team,
    label,
    totalLoadout,
    avgLoadout: safeDivide(totalLoadout, Math.max(data.length, 1)),
    totalSpent,
    avgSpent: safeDivide(totalSpent, Math.max(data.length, 1)),
    buyTypes,
  };
}

function buildPlayerScoreboardStats({
  player,
  currentMatch,
  sideFilter,
  teamByPuuid,
  agentById,
  agentNameMap,
  tierByNumber,
}: {
  player: RawPlayer;
  currentMatch: RawMatchDetail;
  sideFilter: ScoreboardSideFilter;
  teamByPuuid: Map<string, string>;
  agentById: Map<string, AgentContent>;
  agentNameMap: Record<string, string>;
  tierByNumber: Map<number, CompetitiveTierContent>;
}): PlayerScoreboardStats {
  const puuid = cleanId(player.puuid);
  const teamId = cleanId(player.teamId) || "Sin equipo";
  const agent = getAgentMeta(player, agentById, agentNameMap);
  const rankTier =
    typeof player.competitiveTier === "number" ? player.competitiveTier : null;
  const tierAsset = rankTier !== null ? tierByNumber.get(rankTier) : undefined;
  const rankIcon = resolveCompetitiveTierIcon(
    rankTier,
    tierAsset?.smallIcon ?? tierAsset?.largeIcon ?? player.competitiveTierImage ?? null,
    [...tierByNumber.values()],
  );

  let rounds = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let score = 0;
  let damageDealt = 0;
  let damageReceived = 0;
  let headshots = 0;
  let bodyshots = 0;
  let legshots = 0;
  let firstKills = 0;
  let firstDeaths = 0;
  let kastRounds = 0;
  let multikillRounds = 0;

  for (const [roundIndex, round] of (currentMatch.roundResults ?? []).entries()) {
    const roundNum = Number.isFinite(round.roundNum)
      ? Number(round.roundNum)
      : roundIndex;
    const side = determineRoundSide(teamId, roundNum);
    if (sideFilter !== "all" && side !== sideFilter) continue;

    rounds += 1;
    const roundState = { kills: 0, assists: 0, deaths: 0, traded: false };
    const timelineKills = collectRoundKills(round);

    for (const stat of round.playerStats ?? []) {
      const ownerPuuid = cleanId(stat.puuid);
      if (ownerPuuid === puuid) {
        score += toNumber(stat.score);
        for (const damageEntry of stat.damage ?? []) {
          if (!isEnemyDamage(ownerPuuid, damageEntry, teamByPuuid)) continue;
          damageDealt += toNumber(damageEntry.damage);
          headshots += toNumber(damageEntry.headshots);
          bodyshots += toNumber(damageEntry.bodyshots);
          legshots += toNumber(damageEntry.legshots);
        }
      }

      for (const damageEntry of stat.damage ?? []) {
        if (
          cleanId(damageEntry.receiver) === puuid &&
          isEnemyDamage(ownerPuuid, damageEntry, teamByPuuid)
        ) {
          damageReceived += toNumber(damageEntry.damage);
        }
      }
    }

    const firstKill =
      timelineKills.find(({ kill, ownerPuuid }) =>
        isValidKill(kill, teamByPuuid, ownerPuuid),
      )?.kill ?? null;

    for (let killIndex = 0; killIndex < timelineKills.length; killIndex += 1) {
      const { kill, ownerPuuid } = timelineKills[killIndex];
      const killerId = cleanId(kill.killer) || ownerPuuid;
      const victimId = cleanId(kill.victim);
      const timeMs = toNumber(kill.timeSinceRoundStartMillis);
      const validKill = isValidKill(kill, teamByPuuid, ownerPuuid);

      if (validKill && killerId === puuid) {
        roundState.kills += 1;
        if (firstKill === kill) firstKills += 1;
      }

      if (victimId === puuid) {
        roundState.deaths += 1;
        if (firstKill === kill) firstDeaths += 1;

        for (let forward = killIndex + 1; forward < timelineKills.length; forward += 1) {
          const next = timelineKills[forward].kill;
          const nextTime = toNumber(next.timeSinceRoundStartMillis);
          if (nextTime - timeMs > TRADE_WINDOW_MS) break;

          const nextKiller = cleanId(next.killer);
          const nextVictim = cleanId(next.victim);
          if (
            isValidKill(next, teamByPuuid) &&
            nextVictim === killerId &&
            nextKiller &&
            teamByPuuid.get(nextKiller) === teamByPuuid.get(victimId)
          ) {
            roundState.traded = true;
            break;
          }
        }
      }

      if (
        killerId !== puuid &&
        validAssistants(kill, teamByPuuid, ownerPuuid).includes(puuid)
      ) {
        roundState.assists += 1;
      }
    }

    kills += roundState.kills;
    deaths += roundState.deaths;
    assists += roundState.assists;
    if (roundState.kills >= 2) multikillRounds += 1;
    if (
      roundState.kills > 0 ||
      roundState.assists > 0 ||
      roundState.deaths === 0 ||
      roundState.traded
    ) {
      kastRounds += 1;
    }
  }

  const totalHits = headshots + bodyshots + legshots;
  return {
    player,
    puuid,
    teamId,
    agentName: agent.name,
    agentIcon: agent.icon,
    rankTier,
    rankName: getRankNameFromTier(rankTier),
    rankIcon,
    kills,
    deaths,
    assists,
    score,
    rounds,
    acs: safeDivide(score, Math.max(rounds, 1)),
    kd: safeDivide(kills, Math.max(deaths, 1)),
    plusMinus: kills - deaths,
    damageDealt,
    damageReceived,
    damageDelta: safeDivide(damageDealt - damageReceived, Math.max(rounds, 1)),
    adr: safeDivide(damageDealt, Math.max(rounds, 1)),
    headshots,
    bodyshots,
    legshots,
    hsPct: safeDivide(headshots, Math.max(totalHits, 1)) * 100,
    kastRounds,
    kastPct: safeDivide(kastRounds, Math.max(rounds, 1)) * 100,
    firstKills,
    firstDeaths,
    multikillRounds,
  };
}

function buildRoundScoreboardRows({
  round,
  players,
  selectedTeamId,
  teamByPuuid,
  agentById,
  agentNameMap,
  weaponById,
}: {
  round: RawRound | null;
  players: RawPlayer[];
  selectedTeamId: string;
  teamByPuuid: Map<string, string>;
  agentById: Map<string, AgentContent>;
  agentNameMap: Record<string, string>;
  weaponById: Map<string, WeaponCatalogEntry>;
}): RoundScoreboardRow[] {
  if (!round) return [];
  const kills = collectRoundKills(round);
  const playerById = new Map(
    players
      .map((player) => [cleanId(player.puuid), player] as const)
      .filter(([playerId]) => Boolean(playerId)),
  );

  const rows = (round.playerStats ?? []).map((stat) => {
    const playerId = cleanId(stat.puuid);
    const player = playerById.get(playerId);
    const agent = getAgentMeta(player, agentById, agentNameMap);
    const validPlayerKills = kills.filter(
      ({ kill, ownerPuuid }) =>
        isValidKill(kill, teamByPuuid, ownerPuuid) &&
        (cleanId(kill.killer) || ownerPuuid) === playerId,
    );
    const deaths = kills.filter(
      ({ kill }) => cleanId(kill.victim) === playerId,
    ).length;
    const assists = kills.filter(({ kill, ownerPuuid }) =>
      validAssistants(kill, teamByPuuid, ownerPuuid).includes(playerId),
    ).length;
    const weaponId = cleanId(stat.economy?.weapon);

    return {
      playerId,
      teamId: teamByPuuid.get(playerId) ?? cleanId(player?.teamId),
      agentName: agent.name,
      agentIcon: agent.icon ?? undefined,
      playerName: getPlayerShortDisplay(player),
      score: toNumber(stat.score),
      kills: validPlayerKills.length,
      deaths,
      assists,
      loadout: toNumber(stat.economy?.loadoutValue),
      spent: toNumber(stat.economy?.spent),
      weaponName: weaponId
        ? weaponById.get(weaponId)?.displayName ?? weaponId
        : undefined,
      armorName: cleanId(stat.economy?.armor) || undefined,
    };
  });

  return rows.sort(
    (a, b) =>
      Number(b.teamId === selectedTeamId) -
        Number(a.teamId === selectedTeamId) ||
      a.teamId.localeCompare(b.teamId) ||
      b.score - a.score ||
      b.kills - a.kills ||
      a.playerName.localeCompare(b.playerName),
  );
}

function buildDuelMatrix(
  playersByTeam: Array<[string, RawPlayer[]]>,
  allRoundEvents: RoundEvent[],
): PlayerDuelCell[] {
  const teamAPlayers = playersByTeam[0]?.[1] ?? [];
  const teamBPlayers = playersByTeam[1]?.[1] ?? [];
  const teamAIds = new Set(teamAPlayers.map((player) => cleanId(player.puuid)).filter(Boolean));
  const teamBIds = new Set(teamBPlayers.map((player) => cleanId(player.puuid)).filter(Boolean));
  const cells = new Map<string, PlayerDuelCell>();

  for (const teamAPlayer of teamAPlayers) {
    const teamAId = cleanId(teamAPlayer.puuid);
    if (!teamAId) continue;
    for (const teamBPlayer of teamBPlayers) {
      const teamBId = cleanId(teamBPlayer.puuid);
      if (!teamBId) continue;
      cells.set(`${teamAId}:${teamBId}`, {
        key: `${teamAId}:${teamBId}`,
        teamAPlayer,
        teamBPlayer,
        teamAKillsOnB: 0,
        teamBKillsOnA: 0,
        total: 0,
        leader: "tie",
        events: [],
      });
    }
  }

  for (const event of allRoundEvents) {
    if (event.kind !== "kill" || !event.isValidKill) continue;
    const killer = cleanId(event.killer);
    const victim = cleanId(event.victim);
    if (!killer || !victim) continue;

    let key = "";
    let teamAKill = false;
    if (teamAIds.has(killer) && teamBIds.has(victim)) {
      key = `${killer}:${victim}`;
      teamAKill = true;
    } else if (teamBIds.has(killer) && teamAIds.has(victim)) {
      key = `${victim}:${killer}`;
    }

    const cell = key ? cells.get(key) : undefined;
    if (!cell) continue;
    if (teamAKill) {
      cell.teamAKillsOnB += 1;
    } else {
      cell.teamBKillsOnA += 1;
    }
    cell.total += 1;
    cell.events.push(event);
  }

  for (const cell of cells.values()) {
    cell.events.sort((a, b) => a.roundNum - b.roundNum || a.timeMs - b.timeMs);
    cell.leader =
      cell.teamAKillsOnB > cell.teamBKillsOnA
        ? "teamA"
        : cell.teamBKillsOnA > cell.teamAKillsOnB
          ? "teamB"
          : "tie";
  }

  return [...cells.values()];
}

function MatchRoundResultTimeline({
  rounds,
  playersByTeam,
  currentMatch,
  bestRoundNum,
  importantEventsByRound,
}: {
  rounds: RoundSummary[];
  playersByTeam: Array<[string, RawPlayer[]]>;
  currentMatch: RawMatchDetail | null;
  bestRoundNum?: number | null;
  importantEventsByRound?: Map<number, MomentumEvent[]>;
}) {
  const teams = playersByTeam.slice(0, 2).map(([teamId], index) => ({
    teamId,
    label: `Team ${String.fromCharCode(65 + index)}`,
    score: getTeamRoundsWon(currentMatch, teamId),
  }));

  if (teams.length < 2 || rounds.length === 0) {
    return (
      <div className="match-summary-round-timeline empty-panel">
        No hay rondas suficientes para construir el timeline.
      </div>
    );
  }

  return (
    <section className="match-summary-round-timeline" aria-label="Resultado por ronda">
      {teams.map((team) => (
        <div key={`summary-team-${team.teamId}`} className="match-summary-round-row">
          <div className="match-summary-round-line">
            <div className="match-summary-round-team-label">{team.label}</div>
            <div className="match-summary-round-score">{team.score}</div>
            <div className="match-summary-round-track">
              {rounds.map((round) => {
                const isWin = round.winningTeam === team.teamId;
                const condition = getRoundWinCondition(round);
                const RoundIcon = isWin ? getRoundWinIcon(condition) : Circle;
                const isBestRound = round.roundNum === bestRoundNum;
                const roundEvents = importantEventsByRound?.get(round.roundNum + 1) ?? [];
                return (
                  <span
                    key={`summary-${team.teamId}-${round.roundNum}`}
                    className={`match-summary-round-cell ${isWin ? "is-win" : "is-loss"} ${
                      isBestRound ? "is-best-round" : ""
                    } ${roundEvents.length > 0 ? "has-momentum-event" : ""}`}
                    title={`${roundLabel(round.roundNum)} · ${
                      isWin ? "ganada" : "perdida"
                    }${roundEvents[0] ? ` · ${roundEvents[0].title}` : ""}`}
                  >
                    {isWin ? <RoundIcon aria-hidden="true" size={15} strokeWidth={2.4} /> : <span aria-hidden="true" />}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      ))}
      <div className="match-summary-round-numbers" aria-hidden="true">
        <div className="match-summary-round-line">
          <span />
          <span />
          <div className="match-summary-round-track">
            {rounds.map((round) => (
              <small key={`summary-number-${round.roundNum}`}>
                {round.roundNum + 1}
              </small>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function buildEventMapState({
  event,
  roundEvents,
  mapTransform,
  playersByPuuid,
  playerTeam,
  selectedPlayerId,
  agentById,
}: {
  event: RoundEvent | null;
  roundEvents?: RoundEvent[];
  mapTransform: MapTransform | null;
  playersByPuuid: Map<string, RawPlayer>;
  playerTeam: string;
  selectedPlayerId: string;
  agentById: Map<string, AgentContent>;
}): EventMapState {
  if (!event) {
    return { markers: [], hasSnapshot: false };
  }

  const markers: EventMapMarker[] = [];
  const usedIds = new Set<string>();
  const objectiveActorId =
    event.kind === "plant" || event.kind === "defuse"
      ? cleanId(event.actor)
      : "";
  const resolveFacingRadians = (
    puuid: string,
    currentViewRadians?: number,
  ) => {
    if (Number.isFinite(currentViewRadians)) {
      return transformViewRadians(currentViewRadians, mapTransform);
    }

    const eventsByDistance = [...(roundEvents ?? [])].sort(
      (a, b) =>
        Math.abs(a.timeMs - event.timeMs) -
          Math.abs(b.timeMs - event.timeMs) ||
        b.timeMs - a.timeMs,
    );
    for (const roundEvent of eventsByDistance) {
      const location = roundEvent.playerLocations.find(
        (entry) =>
          cleanId(entry.puuid) === puuid &&
          Number.isFinite(entry.viewRadians),
      );
      if (location) {
        return transformViewRadians(location.viewRadians, mapTransform);
      }
    }

    return transformViewRadians(0, mapTransform);
  };

  const pushMarker = (marker: EventMapMarker) => {
    if (usedIds.has(marker.id)) return;
    usedIds.add(marker.id);
    markers.push(marker);
  };

  const addSnapshotMarker = (entry: RawPlayerLocation, index: number) => {
    const puuid = cleanId(entry.puuid);

    const position = transformLocation(entry.location, mapTransform);
    if (!position) return;

    const player = puuid ? playersByPuuid.get(puuid) : undefined;
    const agent = cleanId(player?.characterId)
      ? agentById.get(cleanId(player?.characterId))
      : undefined;
    const teamId = puuid ? cleanId(player?.teamId) : "";
    const isVictim =
      event.kind === "kill" && puuid === cleanId(event.victim);
    const isObjectiveActor =
      (event.kind === "plant" || event.kind === "defuse") &&
      puuid === objectiveActorId;
    const facingRadians = resolveFacingRadians(puuid, entry.viewRadians);

    pushMarker({
      id: `snapshot-${event.id}-${puuid || index}`,
      x: position.x,
      y: position.y,
      label: isObjectiveActor
        ? event.kind === "plant"
          ? "Spike plantada"
          : "Spike defusada"
        : getPlayerDisplay(player),
      icon: isObjectiveActor
        ? undefined
        : agent?.displayIconSmall ?? agent?.displayIcon ?? undefined,
      actorIcon: isObjectiveActor
        ? agent?.displayIconSmall ?? agent?.displayIcon ?? undefined
        : undefined,
      actorLabel: isObjectiveActor ? getPlayerDisplay(player) : undefined,
      team:
        !teamId || !playerTeam
          ? "neutral"
          : teamId === playerTeam
            ? "ally"
            : "enemy",
      kind: isObjectiveActor
        ? "objective"
        : isVictim
          ? "victim"
          : "player",
      isTarget: puuid === selectedPlayerId,
      facingRadians,
      deathIcon: isVictim ? "X" : undefined,
      objectiveIcon: isObjectiveActor
        ? event.kind
        : undefined,
      weaponIcon:
        event.kind === "kill" && puuid === cleanId(event.killer)
          ? event.weaponIcon
          : undefined,
      weaponLabel:
        event.kind === "kill" && puuid === cleanId(event.killer)
          ? event.weaponName
          : undefined,
    });
  };

  event.playerLocations.forEach(addSnapshotMarker);

  if (event.kind === "kill") {
    const killerId = cleanId(event.killer);
    const hasKillerSnapshot = event.playerLocations.some(
      (entry) => cleanId(entry.puuid) === killerId,
    );
    const killerPos = transformLocation(event.killerLocation, mapTransform);
    if (killerId && killerPos && !hasKillerSnapshot) {
      const killer = playersByPuuid.get(killerId);
      const killerTeamId = cleanId(killer?.teamId);
      const killerAgent = cleanId(killer?.characterId)
        ? agentById.get(cleanId(killer?.characterId))
        : undefined;

      pushMarker({
        id: `killer-${event.id}`,
        x: killerPos.x,
        y: killerPos.y,
        label: event.killerName,
        icon: killerAgent?.displayIconSmall ?? killerAgent?.displayIcon ?? undefined,
        weaponIcon: event.weaponIcon,
        weaponLabel: event.weaponName,
        team:
          !killerTeamId || !playerTeam
            ? "neutral"
            : killerTeamId === playerTeam
              ? "ally"
              : "enemy",
        kind: "player",
        isTarget: killerId === selectedPlayerId,
        facingRadians: resolveFacingRadians(killerId),
      });
    }

    const victimId = cleanId(event.victim);
    const victimSnapshot = event.playerLocations.find(
      (entry) => cleanId(entry.puuid) === victimId,
    );
    const hasVictimSnapshot = Boolean(victimSnapshot);
    const victimPos = transformLocation(event.victimLocation, mapTransform);
    if (victimPos && !hasVictimSnapshot) {
      const victim = victimId
        ? playersByPuuid.get(victimId)
        : undefined;
      const victimTeamId = cleanId(victim?.teamId);
      const victimAgent = cleanId(victim?.characterId)
        ? agentById.get(cleanId(victim?.characterId))
        : undefined;

      pushMarker({
        id: `victim-${event.id}`,
        x: victimPos.x,
        y: victimPos.y,
        label: `Posición de ${event.victimName}`,
        icon: victimAgent?.displayIconSmall ?? victimAgent?.displayIcon ?? undefined,
        deathIcon: "X",
        team:
          !victimTeamId || !playerTeam
            ? "neutral"
            : victimTeamId === playerTeam
              ? "ally"
              : "enemy",
        kind: "victim",
        isTarget: victimId === selectedPlayerId,
        facingRadians: resolveFacingRadians(
          victimId,
          victimSnapshot?.viewRadians,
        ),
      });
    }
  }

  if (event.kind === "plant" || event.kind === "defuse") {
    const hasActorSnapshot = event.playerLocations.some(
      (entry) => cleanId(entry.puuid) === objectiveActorId,
    );
    const objectivePos = transformLocation(event.location, mapTransform);
    if (objectivePos && !hasActorSnapshot) {
      const actor = objectiveActorId
        ? playersByPuuid.get(objectiveActorId)
        : undefined;
      const actorAgent = cleanId(actor?.characterId)
        ? agentById.get(cleanId(actor?.characterId))
        : undefined;
      const actorTeamId = cleanId(actor?.teamId);

      pushMarker({
        id: `${event.kind}-${event.id}-objective`,
        x: objectivePos.x,
        y: objectivePos.y,
        label:
          event.kind === "plant" ? "Spike plantada" : "Spike defusada",
        actorIcon:
          actorAgent?.displayIconSmall ??
          actorAgent?.displayIcon ??
          undefined,
        actorLabel: getPlayerDisplay(actor) || event.actorName,
        objectiveIcon: event.kind,
        team:
          !actorTeamId || !playerTeam
            ? "neutral"
            : actorTeamId === playerTeam
              ? "ally"
              : "enemy",
        kind: "objective",
        isTarget: objectiveActorId === selectedPlayerId,
        facingRadians: resolveFacingRadians(objectiveActorId),
      });
    }
  }

  return {
    markers,
    hasSnapshot: event.playerLocations.length > 0,
  };
}

function MatchEventMapCanvas({
  mapName,
  mapImageUrl,
  selectedEvent,
  eventMapState,
  mapTransform,
  compact = false,
}: {
  mapName: string;
  mapImageUrl: string;
  selectedEvent: RoundEvent | null;
  eventMapState: EventMapState;
  mapTransform: MapTransform | null;
  compact?: boolean;
}) {
  if (!selectedEvent) {
    return (
      <div className="empty-panel">
        Selecciona un evento de la ronda para ver el mapa.
      </div>
    );
  }

  const killConnection =
    selectedEvent.kind === "kill" && !selectedEvent.suppressConnectionLine
      ? (() => {
          const killerId = cleanId(selectedEvent.killer);
          const killerMarker = eventMapState.markers.find(
            (marker) =>
              marker.id === `killer-${selectedEvent.id}` ||
              marker.id === `snapshot-${selectedEvent.id}-${killerId}`,
          );
          const victimMarker = eventMapState.markers.find(
            (marker) => marker.id === `victim-${selectedEvent.id}`,
          );
          return killerMarker && victimMarker
            ? { killer: killerMarker, victim: victimMarker }
            : null;
        })()
      : null;
  const killConnectionLine = killConnection
    ? (() => {
        const x1 = killConnection.killer.x * 100;
        const y1 = killConnection.killer.y * 100;
        const x2 = killConnection.victim.x * 100;
        const y2 = killConnection.victim.y * 100;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.hypot(dx, dy);
        if (distance <= 0) return null;

        const markerEdgeOffset = Math.min(2.2, distance / 3);
        const ux = dx / distance;
        const uy = dy / distance;

        return {
          x1: x1 + ux * markerEdgeOffset,
          y1: y1 + uy * markerEdgeOffset,
          x2: x2 - ux * markerEdgeOffset,
          y2: y2 - uy * markerEdgeOffset,
        };
      })()
    : null;

  return (
    <>
      <div className={`match-event-map-header ${compact ? "is-hidden" : ""}`}>
        <strong>
          {roundLabel(selectedEvent.roundNum)} ·{" "}
          {toSecondsLabel(selectedEvent.timeMs)}
        </strong>
        <span>{getEventDescription(selectedEvent)}</span>
      </div>

      {mapImageUrl ? (
        <div className="match-event-map-stage">
          <img src={mapImageUrl} alt={mapName} />
          <div className="match-event-map-overlay">
            {killConnectionLine && (
              <svg
                className="event-map-action-line"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line
                  x1={killConnectionLine.x1}
                  y1={killConnectionLine.y1}
                  x2={killConnectionLine.x2}
                  y2={killConnectionLine.y2}
                />
              </svg>
            )}
            <div className="event-map-facing-layer" aria-hidden="true">
              {eventMapState.markers.map((marker) =>
                typeof marker.facingRadians === "number" ? (
                  <span
                    key={`facing-${marker.id}`}
                    className={`event-map-facing-anchor event-map-facing-anchor--${marker.team} ${
                      marker.kind === "objective"
                        ? "event-map-facing-anchor--objective"
                        : ""
                    }`}
                    style={{
                      left: `${marker.x * 100}%`,
                      top: `${marker.y * 100}%`,
                    }}
                  >
                    <span
                      className="event-map-marker-facing-arrow"
                      style={{
                        transform: `translate(-50%, -50%) rotate(${marker.facingRadians}rad) translateX(${
                          marker.kind === "objective" ? 18 : 20
                        }px)`,
                      }}
                    />
                  </span>
                ) : null,
              )}
            </div>
            <div className="event-map-weapon-layer">
              {eventMapState.markers.map((marker) =>
                marker.weaponIcon || marker.weaponLabel ? (
                  <span
                    key={`weapon-${marker.id}`}
                    className="event-map-weapon-anchor"
                    style={{
                      left: `${marker.x * 100}%`,
                      top: `${marker.y * 100}%`,
                    }}
                  >
                    <span
                      className="event-map-marker-weapon-badge"
                      title={marker.weaponLabel}
                    >
                      {marker.weaponIcon ? (
                        <img src={marker.weaponIcon} alt={marker.weaponLabel ?? ""} />
                      ) : (
                        marker.weaponLabel?.charAt(0).toUpperCase()
                      )}
                    </span>
                  </span>
                ) : null,
              )}
            </div>
            {eventMapState.markers.map((marker) => (
              <div
                key={marker.id}
                className={`event-map-marker event-map-marker--${marker.team} event-map-marker--${marker.kind} ${marker.isTarget ? "is-target" : ""}`}
                style={{
                  left: `${marker.x * 100}%`,
                  top: `${marker.y * 100}%`,
                }}
                title={marker.label}
              >
                {marker.kind === "objective" ? (
                  <>
                    <img
                      className="event-map-marker-objective-icon"
                      src={
                        marker.objectiveIcon === "plant"
                          ? "/content/site/matches/spike-planted.png"
                          : "/content/site/matches/spike-defused.png"
                      }
                      alt={marker.label}
                    />
                    {marker.actorIcon || marker.actorLabel ? (
                      <span
                        className={`event-map-marker-linked-agent event-map-marker-linked-agent--${marker.team}`}
                        title={marker.actorLabel}
                      >
                        {marker.actorIcon ? (
                          <img src={marker.actorIcon} alt={marker.actorLabel ?? ""} />
                        ) : (
                          marker.actorLabel?.charAt(0).toUpperCase()
                        )}
                      </span>
                    ) : null}
                  </>
                ) : marker.icon ? (
                  <>
                    <img src={marker.icon} alt={marker.label} />
                  </>
                ) : (
                  <>
                    <span>{marker.label.charAt(0).toUpperCase()}</span>
                  </>
                )}
                {marker.objectiveIcon && marker.kind !== "objective" ? (
                  <span
                    className="event-map-marker-objective-badge"
                    title={
                      marker.objectiveIcon === "plant"
                        ? "Spike plantada"
                        : "Spike defusada"
                    }
                  >
                    <img
                      src={
                        marker.objectiveIcon === "plant"
                          ? "/content/site/matches/spike-planted.png"
                          : "/content/site/matches/spike-defused.png"
                      }
                      alt=""
                    />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-chart">No hay imagen de mapa disponible.</div>
      )}

      {!compact && !mapTransform && (
        <p className="match-event-map-note">
          Este mapa no tiene transformación de coordenadas disponible.
        </p>
      )}

      {!compact && mapTransform && eventMapState.markers.length === 0 && (
        <p className="match-event-map-note">
          No hay posiciones válidas para este evento en el dataset.
        </p>
      )}

      {!compact &&
        mapTransform &&
        eventMapState.markers.length > 0 &&
        !eventMapState.hasSnapshot && (
          <p className="match-event-map-note">
            Se muestra solo la posición del evento porque no hay snapshot
            completo de jugadores.
          </p>
        )}

      <div className={`match-event-map-legend ${compact ? "is-hidden" : ""}`}>
        <span>
          <i className="dot ally" /> Aliado
        </span>
        <span>
          <i className="dot enemy" /> Enemigo
        </span>
        <span>
          <i className="dot neutral" /> Objetivo
        </span>
        <span>
          <i className="dot target" /> Posición del jugador
        </span>
      </div>
    </>
  );
}

export default function MatchDetailModal({
  matchId,
  playerId,
  agentNameMap,
  onClose,
}: Props) {
  const matchDetailPanelRef = useRef<HTMLDivElement | null>(null);
  const playbackActionListRef = useRef<HTMLDivElement | null>(null);
  const { data: matchData, isLoading: matchLoading } = useMatchById(matchId);
  const { data: agentsData, isLoading: agentsLoading } = useAgentes();
  const { data: weaponsData, isLoading: weaponsLoading } = useArmas();
  const { data: mapsData, isLoading: mapsLoading } = useMapasGeo();
  const { data: tiersData, isLoading: tiersLoading } = useCompetitiveTiers();

  const [selectedPlayerState, setSelectedPlayerState] = useState(() => ({
    matchId,
    playerId,
    selectedPlayerId: playerId,
  }));
  const selectedPlayerId =
    selectedPlayerState.matchId === matchId &&
    selectedPlayerState.playerId === playerId
      ? selectedPlayerState.selectedPlayerId
      : playerId;
  const [selectedRoundNum, setSelectedRoundNum] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [activeSectionState, setActiveSectionState] = useState(() => ({
    matchId,
    section: "summary" as MatchDetailSection,
  }));
  const activeSection =
    activeSectionState.matchId === matchId
      ? activeSectionState.section
      : "summary";
  const setActiveSection = (section: MatchDetailSection) => {
    setActiveSectionState({
      matchId,
      section,
    });
  };
  const {
    data: economyMlData,
    isLoading: economyMlLoading,
    isFetching: economyMlFetching,
  } = useMatchEconomyMl(matchId, activeSection === "economy");
  const [teamScoreboardMode, setTeamScoreboardMode] =
    useState<TeamScoreboardMode>("grouped");
  const [scoreboardSideFilter, setScoreboardSideFilter] =
    useState<ScoreboardSideFilter>("all");
  const [selectedDuelKey, setSelectedDuelKey] = useState<string | null>(null);
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const [playbackEvents, setPlaybackEvents] = useState<RoundEvent[]>([]);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);
  const [playbackTitle, setPlaybackTitle] = useState("");
  const [playbackMode, setPlaybackMode] = useState<"match" | "round">("round");
  const [isMatchDetailOverflowing, setIsMatchDetailOverflowing] =
    useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, []);

  const loading =
    matchLoading ||
    agentsLoading ||
    weaponsLoading ||
    mapsLoading ||
    tiersLoading;

  const currentMatch = (matchData as RawMatchDetail | null) ?? null;
  const agents = useMemo(
    () => normalizeArrayResponse<AgentContent>(agentsData),
    [agentsData],
  );
  const weapons = useMemo(
    () => normalizeArrayResponse<Arma>(weaponsData),
    [weaponsData],
  );
  const mapsGeo = useMemo(
    () => normalizeArrayResponse<MapGeoContent>(mapsData),
    [mapsData],
  );
  const competitiveTiers = useMemo(
    () => normalizeArrayResponse<CompetitiveTierContent>(tiersData),
    [tiersData],
  );

  const players = useMemo(() => currentMatch?.players ?? [], [currentMatch]);

  const playersByPuuid = useMemo(() => {
    const map = new Map<string, RawPlayer>();
    for (const player of players) {
      const puuid = cleanId(player.puuid);
      if (puuid) map.set(puuid, player);
    }
    return map;
  }, [players]);

  const partyMarkerByPuuid = useMemo(() => buildPartyMarkerMap(players), [players]);

  const playersByTeam = useMemo(() => {
    return getStableTeamEntries(currentMatch);
  }, [currentMatch]);

  const teamByPuuid = useMemo(() => {
    const map = new Map<string, string>();
    for (const player of players) {
      const puuid = cleanId(player.puuid);
      const teamId = cleanId(player.teamId);
      if (puuid && teamId) {
        map.set(puuid, teamId);
      }
    }
    return map;
  }, [players]);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentContent>();
    for (const agent of agents) {
      const id = cleanId(agent.uuid ?? agent.id);
      if (id) {
        map.set(id, agent);
      }
    }
    return map;
  }, [agents]);

  const mapById = useMemo(() => {
    const map = new Map<string, MapGeoContent>();
    for (const mapEntry of mapsGeo) {
      const id = cleanId(mapEntry.uuid);
      if (id) map.set(id, mapEntry);
    }
    return map;
  }, [mapsGeo]);

  const weaponById = useMemo(() => {
    const map = new Map<string, WeaponCatalogEntry>();
    for (const weapon of weapons) {
      const weaponId = getWeaponIdFromIcon(weapon.displayIcon);
      const displayName =
        (weapon.displayName ?? "").trim() || "Arma desconocida";
      if (!weaponId) continue;

      map.set(weaponId, {
        id: weaponId,
        displayName,
        displayIcon: weapon.displayIcon ?? null,
      });
    }
    return map;
  }, [weapons]);

  const tierByNumber = useMemo(() => {
    const map = new Map<number, CompetitiveTierContent>();
    for (const tier of competitiveTiers) {
      const numericTier = Number(tier.tier);
      if (!Number.isFinite(numericTier)) continue;
      map.set(numericTier, tier);
    }
    return map;
  }, [competitiveTiers]);

  const mvp = useMemo(
    () => (currentMatch ? getMvp(currentMatch) : null),
    [currentMatch],
  );

  const perspective = useMemo(
    () => buildMatchPerspective(currentMatch, selectedPlayerId),
    [currentMatch, selectedPlayerId],
  );

  const effectiveSelectedPlayerId =
    perspective?.selectedPlayerId || selectedPlayerId;
  const playerInfo = perspective?.selectedPlayer ?? null;

  const playerTeam = perspective?.selectedTeamId ?? cleanId(playerInfo?.teamId);
  const {
    name: playerAgentName,
    icon: playerAgentIcon,
  } = getAgentMeta(playerInfo, agentById, agentNameMap);

  const mapId = cleanId(currentMatch?.matchInfo?.mapId);
  const mapMeta = mapId ? (mapById.get(mapId) ?? null) : null;
  const mapName = (mapMeta?.displayName ?? mapId) || "Mapa desconocido";
  const mapImageUrl =
    mapMeta?.displayIcon?.trim() ||
    (mapId ? `/content/maps/${mapId}/displayIcon.png` : "");
  const mapTransform = useMemo(() => toMapTransform(mapMeta), [mapMeta]);
  const queueLabel = formatQueueLabel(currentMatch?.matchInfo?.queueId);
  const gameModeLabel = formatQueueLabel(currentMatch?.matchInfo?.gameMode);

  const playerTier = playerInfo?.competitiveTier;
  const tierAsset =
    typeof playerTier === "number" ? tierByNumber.get(playerTier) : undefined;
  const playerRankName = getRankNameFromTier(playerTier ?? null);
  const playerRankIcon = resolveCompetitiveTierIcon(
    playerTier ?? null,
    tierAsset?.smallIcon ?? tierAsset?.largeIcon ?? playerInfo?.competitiveTierImage ?? null,
    [...tierByNumber.values()],
  );

  const matchAnalysis = useMemo<MatchAnalysis | null>(() => {
    if (!currentMatch || !playerInfo || !playerTeam) return null;

    const roundsRaw = currentMatch.roundResults ?? [];
    const totalRounds = roundsRaw.length;

    let totalHeadshots = 0;
    let totalBodyshots = 0;
    let totalLegshots = 0;
    let totalDamage = 0;
    let openingWon = 0;
    let openingLost = 0;
    let tradeKills = 0;

    const rounds: RoundSummary[] = [];
    const playerKillEvents: KillRoundEvent[] = [];

    for (let roundIndex = 0; roundIndex < roundsRaw.length; roundIndex += 1) {
      const round = roundsRaw[roundIndex];
      const roundNum = Number.isFinite(round.roundNum)
        ? Number(round.roundNum)
        : roundIndex;

      const side = determineRoundSide(playerTeam, roundNum);
      const didWin = cleanId(round.winningTeam) === playerTeam;

      const playerRoundStats = (round.playerStats ?? []).find(
        (stat) => cleanId(stat.puuid) === effectiveSelectedPlayerId,
      );

      const playerScore = toNumber(playerRoundStats?.score);
      const playerSpent = toNumber(playerRoundStats?.economy?.spent);
      const playerLoadout = toNumber(playerRoundStats?.economy?.loadoutValue);
      let teamSpent = 0;
      let teamLoadout = 0;
      for (const stat of round.playerStats ?? []) {
        const statPuuid = cleanId(stat.puuid);
        if (statPuuid && teamByPuuid.get(statPuuid) === playerTeam) {
          teamSpent += toNumber(stat.economy?.spent);
          teamLoadout += toNumber(stat.economy?.loadoutValue);
        }
      }
      const buyType = classifyRoundEconomy(
        teamSpent || playerSpent,
        teamLoadout || playerLoadout,
      );

      let playerRoundDamage = 0;
      for (const damageEntry of playerRoundStats?.damage ?? []) {
        if (
          !isEnemyDamage(
            effectiveSelectedPlayerId,
            damageEntry,
            teamByPuuid,
          )
        ) {
          continue;
        }
        playerRoundDamage += toNumber(damageEntry.damage);
        totalHeadshots += toNumber(damageEntry.headshots);
        totalBodyshots += toNumber(damageEntry.bodyshots);
        totalLegshots += toNumber(damageEntry.legshots);
      }
      totalDamage += playerRoundDamage;

      const timelineKills = collectRoundKills(round);
      const firstKill = timelineKills.find(({ kill, ownerPuuid }) =>
        isValidKill(kill, teamByPuuid, ownerPuuid),
      )?.kill;

      let playerKills = 0;
      let playerDeaths = 0;
      let playerAssists = 0;
      let playerWasTraded = false;
      const roundEvents: RoundEvent[] = [];

      for (
        let killIndex = 0;
        killIndex < timelineKills.length;
        killIndex += 1
      ) {
        const { kill, ownerPuuid } = timelineKills[killIndex];
        const killerId = cleanId(kill.killer) || ownerPuuid;
        const victimId = cleanId(kill.victim);
        const timeMs = toNumber(kill.timeSinceRoundStartMillis);
        const validKill = isValidKill(kill, teamByPuuid, ownerPuuid);

        if (validKill && killerId === effectiveSelectedPlayerId) {
          playerKills += 1;
        }

        if (victimId === effectiveSelectedPlayerId) {
          playerDeaths += 1;
          for (let forward = killIndex + 1; forward < timelineKills.length; forward += 1) {
            const next = timelineKills[forward].kill;
            const nextTime = toNumber(next.timeSinceRoundStartMillis);
            if (nextTime - timeMs > TRADE_WINDOW_MS) break;

            const nextKiller = cleanId(next.killer);
            const nextVictim = cleanId(next.victim);
            if (
              isValidKill(next, teamByPuuid) &&
              nextVictim === killerId &&
              nextKiller &&
              teamByPuuid.get(nextKiller) === playerTeam
            ) {
              playerWasTraded = true;
              break;
            }
          }
        }

        const assistants = validAssistants(kill, teamByPuuid, ownerPuuid);
        if (
          killerId !== effectiveSelectedPlayerId &&
          assistants.includes(effectiveSelectedPlayerId)
        ) {
          playerAssists += 1;
        }

        const killer = killerId ? playersByPuuid.get(killerId) : undefined;
        const victim = victimId ? playersByPuuid.get(victimId) : undefined;

        const killerAgentId = cleanId(killer?.characterId);
        const victimAgentId = cleanId(victim?.characterId);

        const killerAgent = killerAgentId
          ? agentById.get(killerAgentId)
          : undefined;
        const victimAgent = victimAgentId
          ? agentById.get(victimAgentId)
          : undefined;

        const damageType = String(
          kill.finishingDamage?.damageType ?? "",
        ).trim();
        const damageSource = resolveKillDamageSource(
          kill,
          killer,
          weaponById,
          agentById,
        );

        const isPlayerKill =
          validKill && killerId === effectiveSelectedPlayerId;
        const isPlayerDeath = victimId === effectiveSelectedPlayerId;
        const isOpening = Boolean(
          firstKill && firstKill === kill && (isPlayerKill || isPlayerDeath),
        );

        if (isOpening) {
          if (isPlayerKill) openingWon += 1;
          if (isPlayerDeath) openingLost += 1;
        }

        let isTrade = false;
        if (isPlayerKill && victimId) {
          for (let back = killIndex - 1; back >= 0; back -= 1) {
            const previous = timelineKills[back].kill;
            const previousTime = toNumber(previous.timeSinceRoundStartMillis);
            if (timeMs - previousTime > TRADE_WINDOW_MS) break;

            const previousVictim = cleanId(previous.victim);
            const previousKiller = cleanId(previous.killer);
            if (!previousVictim || !previousKiller) continue;

            if (
              isValidKill(previous, teamByPuuid) &&
              teamByPuuid.get(previousVictim) === playerTeam &&
              previousKiller === victimId
            ) {
              isTrade = true;
              tradeKills += 1;
              break;
            }
          }
        }

        const event: KillRoundEvent = {
          id: `kill-${roundNum}-${killIndex}-${killerId}-${victimId}-${timeMs}`,
          kind: "kill",
          roundNum,
          timeMs,
          killer: killerId,
          victim: victimId,
          killerName: getPlayerShortDisplay(killer),
          victimName: getPlayerShortDisplay(victim),
          killerIcon:
            killerAgent?.displayIconSmall ??
            killerAgent?.displayIcon ??
            undefined,
          victimIcon:
            victimAgent?.displayIconSmall ??
            victimAgent?.displayIcon ??
            undefined,
          weaponId: damageSource.id || undefined,
          weaponName: damageSource.name,
          weaponIcon: damageSource.icon ?? null,
          damageType: damageType || undefined,
          damageSourceType: damageSource.type,
          abilityId: damageSource.isAbility ? damageSource.id : undefined,
          abilityName: damageSource.isAbility ? damageSource.name : undefined,
          abilityIcon: damageSource.isAbility ? damageSource.icon ?? null : undefined,
          isAbilityKill: damageSource.isAbility,
          suppressConnectionLine: shouldSuppressKillConnectionLine(
            damageSource,
            killerAgent,
          ),
          playerLocations: Array.isArray(kill.playerLocations)
            ? kill.playerLocations
            : [],
          killerLocation: kill.killerLocation,
          victimLocation: kill.victimLocation,
          isPlayerKill,
          isPlayerDeath,
          isValidKill: validKill,
          isOpening,
          isTrade,
        };

        roundEvents.push(event);
        if (isPlayerKill) playerKillEvents.push(event);
      }

      const planterId = cleanId(round.bombPlanter);
      if (planterId) {
        roundEvents.push({
          id: `plant-${roundNum}-${planterId}`,
          kind: "plant",
          roundNum,
          timeMs: toNumber(round.plantRoundTime),
          actor: planterId,
          actorName: getPlayerShortDisplay(playersByPuuid.get(planterId)),
          site: cleanSite(round.plantSite),
          location: round.plantLocation,
          playerLocations: Array.isArray(round.plantPlayerLocations)
            ? round.plantPlayerLocations
            : [],
        });
      }

      const defuserId = cleanId(round.bombDefuser);
      if (defuserId) {
        roundEvents.push({
          id: `defuse-${roundNum}-${defuserId}`,
          kind: "defuse",
          roundNum,
          timeMs: toNumber(round.defuseRoundTime),
          actor: defuserId,
          actorName: getPlayerShortDisplay(playersByPuuid.get(defuserId)),
          site: cleanSite(round.plantSite),
          location: round.defuseLocation,
          playerLocations: Array.isArray(round.defusePlayerLocations)
            ? round.defusePlayerLocations
            : [],
        });
      }

      roundEvents.sort((a, b) => a.timeMs - b.timeMs);

      rounds.push({
        roundNum,
        side,
        didWin,
        winningTeam: cleanId(round.winningTeam),
        roundResult: cleanId(round.roundResult) || "Sin detalle",
        roundCeremony: cleanId(round.roundCeremony),
        playerKills,
        playerDeaths,
        playerAssists,
        playerScore,
        playerSpent,
        playerLoadout,
        teamSpent,
        teamLoadout,
        buyType,
        playerDamage: playerRoundDamage,
        playerWasTraded,
        hadPlant: Boolean(planterId),
        hadDefuse: Boolean(defuserId),
        events: roundEvents,
      });
    }

    const kills = rounds.reduce((sum, round) => sum + round.playerKills, 0);
    const deaths = rounds.reduce((sum, round) => sum + round.playerDeaths, 0);
    const assists = rounds.reduce((sum, round) => sum + round.playerAssists, 0);
    const score =
      toNumber(playerInfo.stats?.score) ||
      rounds.reduce((sum, round) => sum + round.playerScore, 0);

    const kd = safeDivide(kills, Math.max(deaths, 1));
    const kda = safeDivide(kills + assists, Math.max(deaths, 1));
    const killsPerRound = safeDivide(kills, Math.max(totalRounds, 1));
    const adr = safeDivide(totalDamage, Math.max(totalRounds, 1));
    const acs = safeDivide(score, Math.max(totalRounds, 1));

    const roundsWon = rounds.filter((round) => round.didWin).length;
    const roundsWonWithImpact = rounds.filter(
      (round) =>
        round.didWin &&
        (round.playerKills + round.playerAssists > 0 || round.playerScore > 0),
    ).length;
    const winRoundParticipationPct =
      safeDivide(roundsWonWithImpact, Math.max(roundsWon, 1)) * 100;

    const survivalRounds = rounds.filter(
      (round) => round.playerDeaths === 0,
    ).length;
    const survivalPct =
      safeDivide(survivalRounds, Math.max(totalRounds, 1)) * 100;
    const roundsWithKills = rounds.filter(
      (round) => round.playerKills > 0,
    ).length;
    const kastRounds = rounds.filter(
      (round) =>
        round.playerKills > 0 ||
        round.playerAssists > 0 ||
        round.playerDeaths === 0 ||
        round.playerWasTraded,
    ).length;
    const kastPct = safeDivide(kastRounds, Math.max(totalRounds, 1)) * 100;
    const multikillRounds = rounds.filter(
      (round) => round.playerKills >= 2,
    ).length;
    const maxKillsInRound = rounds.reduce(
      (maxKills, round) => Math.max(maxKills, round.playerKills),
      0,
    );

    const totalHits = totalHeadshots + totalBodyshots + totalLegshots;
    const headshotPct =
      safeDivide(totalHeadshots, Math.max(totalHits, 1)) * 100;

    const weaponTotals = new Map<string, WeaponSummary>();
    for (const event of playerKillEvents) {
      const key = event.weaponId || event.weaponName;
      const existing = weaponTotals.get(key);
      if (existing) {
        existing.kills += 1;
      } else {
        weaponTotals.set(key, {
          id: key,
          name: event.weaponName,
          icon: event.weaponIcon,
          kills: 1,
        });
      }
    }

    const topWeapons = [...weaponTotals.values()]
      .sort((a, b) => b.kills - a.kills)
      .slice(0, 3);

    const bestRound =
      rounds.length > 0
        ? [...rounds].sort((a, b) => {
            const impactA =
              a.playerScore +
              a.playerKills * 180 +
              a.playerAssists * 60 -
              a.playerDeaths * 70 +
              (a.didWin ? 80 : 0);
            const impactB =
              b.playerScore +
              b.playerKills * 180 +
              b.playerAssists * 60 -
              b.playerDeaths * 70 +
              (b.didWin ? 80 : 0);
            return impactB - impactA;
          })[0]
        : null;

    const sideAccumulator: Record<
      SideKey,
      Omit<
        SideSummary,
        | "key"
        | "label"
        | "kd"
        | "kda"
        | "winRate"
        | "killsPerRound"
        | "avgSpent"
        | "avgLoadout"
      >
    > = {
      attack: {
        rounds: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        score: 0,
        spent: 0,
        loadout: 0,
      },
      defense: {
        rounds: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        score: 0,
        spent: 0,
        loadout: 0,
      },
    };

    for (const round of rounds) {
      const target = sideAccumulator[round.side];
      target.rounds += 1;
      target.wins += round.didWin ? 1 : 0;
      target.kills += round.playerKills;
      target.deaths += round.playerDeaths;
      target.assists += round.playerAssists;
      target.score += round.playerScore;
      target.spent += round.playerSpent;
      target.loadout += round.playerLoadout;
    }

    const sideSummary: SideSummary[] = (
      [
        ["attack", "Ataque"],
        ["defense", "Defensa"],
      ] as const
    ).map(([key, label]) => {
      const side = sideAccumulator[key];
      return {
        key,
        label,
        ...side,
        kd: safeDivide(side.kills, Math.max(side.deaths, 1)),
        kda: safeDivide(side.kills + side.assists, Math.max(side.deaths, 1)),
        winRate: safeDivide(side.wins, Math.max(side.rounds, 1)) * 100,
        killsPerRound: safeDivide(side.kills, Math.max(side.rounds, 1)),
        avgSpent: safeDivide(side.spent, Math.max(side.rounds, 1)),
        avgLoadout: safeDivide(side.loadout, Math.max(side.rounds, 1)),
      };
    });

    const totalSpent = rounds.reduce(
      (sum, round) => sum + round.playerSpent,
      0,
    );
    const avgSpent = safeDivide(totalSpent, Math.max(totalRounds, 1));
    const avgLoadout = safeDivide(
      rounds.reduce((sum, round) => sum + round.playerLoadout, 0),
      Math.max(totalRounds, 1),
    );

    const ecoRounds = rounds.filter((round) => round.buyType === "eco").length;
    const ecoWins = rounds.filter(
      (round) => round.buyType === "eco" && round.didWin,
    ).length;
    const fullBuyRounds = rounds.filter(
      (round) => round.buyType === "fullBuy",
    ).length;
    const fullBuyWins = rounds.filter(
      (round) => round.buyType === "fullBuy" && round.didWin,
    ).length;

    const insights: string[] = [];
    if (topWeapons[0]) {
      insights.push(
        `Arma más efectiva: ${topWeapons[0].name} con ${formatNumber(topWeapons[0].kills)} kills.`,
      );
    }
    if (bestRound) {
      insights.push(
        `Ronda de mayor impacto: ${roundLabel(bestRound.roundNum)} (${bestRound.playerKills}K/${bestRound.playerAssists}A, ${bestRound.playerScore} score).`,
      );
    }
    if (openingWon + openingLost > 0) {
      insights.push(
        `Duelos iniciales: ${openingWon} ganados y ${openingLost} perdidos.`,
      );
    }
    if (tradeKills > 0) {
      insights.push(`Trade kills detectados: ${formatNumber(tradeKills)}.`);
    }

    return {
      rounds,
      totalRounds,
      kills,
      deaths,
      assists,
      score,
      kd,
      kda,
      killsPerRound,
      totalDamage,
      adr,
      acs,
      kastPct,
      headshotPct,
      survivalRounds,
      survivalPct,
      multikillRounds,
      maxKillsInRound,
      roundsWon,
      roundsWonWithImpact,
      winRoundParticipationPct,
      tradeKills,
      openingWon,
      openingLost,
      roundsWithKills,
      topWeapons,
      bestRound,
      sideSummary,
      totalSpent,
      avgSpent,
      avgLoadout,
      ecoRounds,
      ecoWins,
      fullBuyRounds,
      fullBuyWins,
      insights,
    };
  }, [
    currentMatch,
    playerInfo,
    playerTeam,
    effectiveSelectedPlayerId,
    playersByPuuid,
    teamByPuuid,
    agentById,
    weaponById,
  ]);

  const allRoundEvents = useMemo(
    () => matchAnalysis?.rounds.flatMap((round) => round.events) ?? [],
    [matchAnalysis],
  );

  const selectedRound = useMemo(() => {
    if (!matchAnalysis) return null;
    if (selectedRoundNum === null) return matchAnalysis.rounds[0] ?? null;
    return (
      matchAnalysis.rounds.find((round) => round.roundNum === selectedRoundNum) ??
      matchAnalysis.rounds[0] ??
      null
    );
  }, [matchAnalysis, selectedRoundNum]);
  const selectedRawRound = useMemo(
    () =>
      (currentMatch?.roundResults ?? []).find(
        (round, index) =>
          (Number.isFinite(round.roundNum) ? Number(round.roundNum) : index) ===
          selectedRound?.roundNum,
      ) ?? null,
    [currentMatch, selectedRound?.roundNum],
  );
  const selectedRoundScoreboardRows = useMemo(
    () =>
      buildRoundScoreboardRows({
        round: selectedRawRound,
        players,
        selectedTeamId: playerTeam,
        teamByPuuid,
        agentById,
        agentNameMap,
        weaponById,
      }),
    [
      agentById,
      agentNameMap,
      playerTeam,
      players,
      selectedRawRound,
      teamByPuuid,
      weaponById,
    ],
  );

  const selectedRoundEvents = useMemo(
    () =>
      [...(selectedRound?.events ?? [])].sort(
        (a, b) => a.timeMs - b.timeMs,
      ),
    [selectedRound],
  );

  const sortedAllRoundEvents = useMemo(
    () =>
      [...allRoundEvents].sort(
        (a, b) => a.roundNum - b.roundNum || a.timeMs - b.timeMs,
      ),
    [allRoundEvents],
  );

  const selectedEvent = useMemo(() => {
    const explicitEvent =
      selectedRoundEvents.find((event) => event.id === selectedEventId) ??
      null;
    return explicitEvent ?? selectedRoundEvents[0] ?? null;
  }, [selectedRoundEvents, selectedEventId]);

  const eventMapState = useMemo(
    () =>
      buildEventMapState({
        event: selectedEvent,
        roundEvents: selectedRoundEvents,
        mapTransform,
        playersByPuuid,
        playerTeam,
        selectedPlayerId: effectiveSelectedPlayerId,
        agentById,
      }),
    [
      selectedEvent,
      selectedRoundEvents,
      mapTransform,
      playersByPuuid,
      playerTeam,
      effectiveSelectedPlayerId,
      agentById,
    ],
  );
  const sideBest = useMemo(() => {
    if (!matchAnalysis) return null;
    return [...matchAnalysis.sideSummary]
      .filter((side) => side.rounds > 0)
      .sort((a, b) => b.winRate - a.winRate || b.kda - a.kda)[0];
  }, [matchAnalysis]);

  const playerScoreboardStatsByPuuid = useMemo(() => {
    const stats = new Map<string, PlayerScoreboardStats>();
    if (!currentMatch) return stats;

    for (const player of players) {
      const puuid = cleanId(player.puuid);
      if (!puuid) continue;
      stats.set(
        puuid,
        buildPlayerScoreboardStats({
          player,
          currentMatch,
          sideFilter: scoreboardSideFilter,
          teamByPuuid,
          agentById,
          agentNameMap,
          tierByNumber,
        }),
      );
    }

    return stats;
  }, [
    currentMatch,
    players,
    scoreboardSideFilter,
    teamByPuuid,
    agentById,
    agentNameMap,
    tierByNumber,
  ]);


  const teamScoreboardGroups = useMemo(() => {
    return playersByTeam.map(([teamId, teamPlayers], index) => {
      const teamLabel = `Team ${String.fromCharCode(65 + index)}`;
      const tone = index === 0 ? "team-a" : "team-b";
      const rows = teamPlayers
        .map((player) => {
          const puuid = cleanId(player.puuid);
          return puuid ? playerScoreboardStatsByPuuid.get(puuid) : undefined;
        })
        .filter((entry): entry is PlayerScoreboardStats => Boolean(entry))
        .sort(compareScoreboardPlayers);

      return {
        teamId,
        teamLabel,
        tone,
        averageRank: getAverageTeamRank(teamPlayers, tierByNumber),
        rows,
      };
    });
  }, [playersByTeam, playerScoreboardStatsByPuuid, tierByNumber]);

  const combinedScoreboardRows = useMemo(
    () =>
      [...playerScoreboardStatsByPuuid.values()].sort(compareScoreboardPlayers),
    [playerScoreboardStatsByPuuid],
  );

  const roundTeamLoadoutTimeline = useMemo(
    () =>
      currentMatch
        ? buildRoundTeamLoadoutTimeline(currentMatch, playersByTeam)
        : [],
    [currentMatch, playersByTeam],
  );

  const teamAId = perspective?.teamAId ?? cleanId(playersByTeam[0]?.[0]);
  const teamBId = perspective?.teamBId ?? cleanId(playersByTeam[1]?.[0]);
  const teamALabel = perspective?.teamALabel ?? "Team A";
  const teamBLabel = perspective?.teamBLabel ?? "Team B";
  const selectedTeamKey = perspective?.selectedTeamKey ?? "teamA";
  const opponentTeamId = perspective?.opponentTeamId ?? (selectedTeamKey === "teamA" ? teamBId : teamAId);

  const teamEconomySummaries = useMemo(() => {
    return [
      summarizeTeamEconomy(
        roundTeamLoadoutTimeline,
        "teamA",
        teamALabel,
      ),
      summarizeTeamEconomy(
        roundTeamLoadoutTimeline,
        "teamB",
        teamBLabel,
      ),
    ];
  }, [roundTeamLoadoutTimeline, teamALabel, teamBLabel]);

  const momentumAnalysis = useMemo<MatchMomentumResult | null>(() => {
    if (!currentMatch || !teamAId || !teamBId) return null;

    let teamAScore = 0;
    let teamBScore = 0;
    const loadoutByRound = new Map(
      roundTeamLoadoutTimeline.map((round) => [round.roundNum, round]),
    );

    const rounds: MomentumInputRound[] = (currentMatch.roundResults ?? []).map(
      (round, index) => {
        const roundNum = Number.isFinite(round.roundNum)
          ? Number(round.roundNum)
          : index;
        const loadout = loadoutByRound.get(roundNum);
        const winningTeam = cleanId(round.winningTeam);
        if (winningTeam === teamAId) teamAScore += 1;
        if (winningTeam === teamBId) teamBScore += 1;

        const impactPlayers = players
          .filter(
            (player) =>
              !player.isObserver &&
              [teamAId, teamBId].includes(cleanId(player.teamId)),
          )
          .map((player) => ({
            id: cleanId(player.puuid),
            teamId: cleanId(player.teamId),
            playerName: getPlayerShortDisplay(player),
          }))
          .filter((player) => player.id && player.teamId);
        const impactKills = collectRoundKills(round)
          .filter(({ kill, ownerPuuid }) =>
            isValidKill(kill, teamByPuuid, ownerPuuid),
          )
          .map(({ kill, ownerPuuid }) => ({
            killerId: cleanId(kill.killer) || ownerPuuid,
            victimId: cleanId(kill.victim),
            timeMs: toNumber(kill.timeSinceRoundStartMillis),
            assistants: validAssistants(kill, teamByPuuid, ownerPuuid),
          }))
          .sort((a, b) => a.timeMs - b.timeMs);
        const firstKill = impactKills[0];
        const impactStats = new Map(
          impactPlayers.map((player) => [
            player.id,
            {
              playerId: player.id,
              kills: 0,
              assists: 0,
              deaths: 0,
              damage: 0,
              firstKill: false,
              firstDeath: false,
            },
          ]),
        );
        for (const stat of round.playerStats ?? []) {
          const entry = impactStats.get(cleanId(stat.puuid));
          if (!entry) continue;
          entry.kills = impactKills.filter(
            (kill) => kill.killerId === entry.playerId,
          ).length;
          entry.damage = (stat.damage ?? []).reduce(
            (sum, damageEntry) =>
              sum +
              (isEnemyDamage(entry.playerId, damageEntry, teamByPuuid)
                ? toNumber(damageEntry.damage)
                : 0),
            0,
          );
        }
        for (const kill of impactKills) {
          const killer = impactStats.get(kill.killerId);
          const victim = impactStats.get(kill.victimId);
          if (killer && kill === firstKill) killer.firstKill = true;
          if (victim) {
            victim.deaths += 1;
            if (kill === firstKill) victim.firstDeath = true;
          }
          for (const assistantId of kill.assistants) {
            const assistant = impactStats.get(assistantId);
            if (assistant) assistant.assists += 1;
          }
        }
        const teamAKills = impactKills.filter(
          (kill) => teamByPuuid.get(kill.killerId) === teamAId,
        ).length;
        const teamBKills = impactKills.filter(
          (kill) => teamByPuuid.get(kill.killerId) === teamBId,
        ).length;
        const playerImpact = calculateRoundPlayerImpacts(
          {
            roundNumber: roundNum + 1,
            winnerTeamId: winningTeam,
            teamAId,
            teamBId,
            teamAScore,
            teamBScore,
            teamALoadout: loadout?.teamAValue ?? 0,
            teamBLoadout: loadout?.teamBValue ?? 0,
            bombPlanter: cleanId(round.bombPlanter),
            bombDefuser: cleanId(round.bombDefuser),
            plantRoundTime: round.plantRoundTime,
            defuseRoundTime: round.defuseRoundTime,
            kills: impactKills,
            playerRounds: [...impactStats.values()],
          },
          impactPlayers,
        );

        // winningTeamRole is not reliable in the stored Riot-like documents
        // (older payloads keep "string" as a placeholder), so side is inferred
        // from team id and round number.
        const winnerSide = winningTeam
          ? determineRoundSide(winningTeam, roundNum)
          : undefined;

        return {
          roundNumber: roundNum + 1,
          winnerTeamId: winningTeam,
          winnerSide,
          teamAId,
          teamBId,
          teamAScore,
          teamBScore,
          teamALoadout: loadout?.teamAValue ?? 0,
          teamBLoadout: loadout?.teamBValue ?? 0,
          teamAKills,
          teamBKills,
          kills: impactKills.map((kill) => ({
            killerId: kill.killerId,
            victimId: kill.victimId,
            timeMs: kill.timeMs,
          })),
          playerTeams: Object.fromEntries(
            impactPlayers.map((player) => [player.id, player.teamId]),
          ),
          playerNames: Object.fromEntries(
            impactPlayers.map((player) => [player.id, player.playerName]),
          ),
          bombPlanter: cleanId(round.bombPlanter),
          bombDefuser: cleanId(round.bombDefuser),
          plantRoundTime: round.plantRoundTime,
          defuseRoundTime: round.defuseRoundTime,
          roundResult: round.roundResult,
          roundCeremony: round.roundCeremony,
          playerImpact,
        };
      },
    );

    return calculateMatchMomentum(rounds, { teamAId, teamBId });
  }, [
    currentMatch,
    roundTeamLoadoutTimeline,
    teamAId,
    teamBId,
    teamByPuuid,
    players,
  ]);

  const economyEfficiencyAnalysis = useMemo<EconomyEfficiencyAnalysis | null>(() => {
    if (!teamAId || !teamBId || roundTeamLoadoutTimeline.length === 0) return null;

    let teamAScore = 0;
    let teamBScore = 0;
    const rounds = roundTeamLoadoutTimeline.map((round) => {
      const beforeTeamAScore = teamAScore;
      const beforeTeamBScore = teamBScore;
      const winnerTeamId = round.teamAWon ? teamAId : round.teamBWon ? teamBId : "";
      if (round.teamAWon) teamAScore += 1;
      if (round.teamBWon) teamBScore += 1;

      return {
        roundNumber: round.roundNum + 1,
        teamALoadout: round.teamAValue,
        teamBLoadout: round.teamBValue,
        teamASpent: round.teamASpent,
        teamBSpent: round.teamBSpent,
        teamACredits: round.teamACredits > 0 ? round.teamACredits : undefined,
        teamBCredits: round.teamBCredits > 0 ? round.teamBCredits : undefined,
        teamAScore: beforeTeamAScore,
        teamBScore: beforeTeamBScore,
        winnerTeamId,
        teamAId,
        teamBId,
        teamASide: determineRoundSide(teamAId, round.roundNum),
        teamBSide: determineRoundSide(teamBId, round.roundNum),
      };
    });

    return analyzeEconomyEfficiency(rounds);
  }, [roundTeamLoadoutTimeline, teamAId, teamBId]);

  const advancedMomentumAnalysis = useMemo<AdvancedMomentumResult | null>(() => {
    if (!currentMatch || !teamAId || !teamBId || !momentumAnalysis) return null;
    const loadoutByRound = new Map(
      roundTeamLoadoutTimeline.map((round) => [round.roundNum, round]),
    );
    const advancedPlayers = players
      .filter(
        (player) =>
          !player.isObserver &&
          [teamAId, teamBId].includes(cleanId(player.teamId)),
      )
      .map((player) => {
        const id = cleanId(player.puuid);
        if (!id) return null;
        const agent = getAgentMeta(player, agentById, agentNameMap);
        return {
          id,
          teamId: cleanId(player.teamId),
          playerName: getPlayerShortDisplay(player),
          agentName: agent.name,
          agentIcon: agent.icon,
        };
      })
      .filter((player): player is NonNullable<typeof player> => Boolean(player));

    let teamAScore = 0;
    let teamBScore = 0;
    const rounds: AdvancedMomentumRound[] = (currentMatch.roundResults ?? []).map(
      (round, index) => {
        const roundNum = Number.isFinite(round.roundNum)
          ? Number(round.roundNum)
          : index;
        const roundNumber = roundNum + 1;
        const loadout = loadoutByRound.get(roundNum);
        const winningTeam = cleanId(round.winningTeam);
        const scoreBefore = {
          [teamAId]: teamAScore,
          [teamBId]: teamBScore,
        };
        if (winningTeam === teamAId) teamAScore += 1;
        if (winningTeam === teamBId) teamBScore += 1;
        const scoreAfter = {
          [teamAId]: teamAScore,
          [teamBId]: teamBScore,
        };

        const kills = collectRoundKills(round)
          .filter(({ kill, ownerPuuid }) =>
            isValidKill(kill, teamByPuuid, ownerPuuid),
          )
          .map(({ kill, ownerPuuid }) => ({
            killerId: cleanId(kill.killer) || ownerPuuid,
            victimId: cleanId(kill.victim),
            timeMs: toNumber(kill.timeSinceRoundStartMillis),
            assistants: validAssistants(kill, teamByPuuid, ownerPuuid),
          }))
          .sort((a, b) => a.timeMs - b.timeMs);
        const firstKill = kills[0] ?? null;
        const playerRoundMap = new Map<string, AdvancedMomentumRound["playerRounds"][number]>();

        for (const player of advancedPlayers) {
          playerRoundMap.set(player.id, {
            playerId: player.id,
            kills: 0,
            assists: 0,
            deaths: 0,
            score: 0,
            firstKill: false,
            firstDeath: false,
          });
        }

        for (const stat of round.playerStats ?? []) {
          const playerId = cleanId(stat.puuid);
          const entry = playerRoundMap.get(playerId);
          if (!entry) continue;
          entry.score = toNumber(stat.score);
          entry.kills = kills.filter(
            (kill) => kill.killerId === playerId,
          ).length;
          entry.damage = (stat.damage ?? []).reduce(
            (sum, damageEntry) =>
              sum +
              (isEnemyDamage(playerId, damageEntry, teamByPuuid)
                ? toNumber(damageEntry.damage)
                : 0),
            0,
          );
        }

        for (const kill of kills) {
          const killerEntry = playerRoundMap.get(kill.killerId);
          const victimEntry = playerRoundMap.get(kill.victimId);
          if (killerEntry && firstKill === kill) killerEntry.firstKill = true;
          if (victimEntry) {
            victimEntry.deaths += 1;
            if (firstKill === kill) victimEntry.firstDeath = true;
          }
          for (const assistant of kill.assistants) {
            const assistantEntry = playerRoundMap.get(assistant);
            if (assistantEntry) assistantEntry.assists += 1;
          }
        }

        return {
          roundNumber,
          winnerTeamId: winningTeam,
          teamAId,
          teamBId,
          teamAScore,
          teamBScore,
          scoreBefore,
          scoreAfter,
          teamALoadout: loadout?.teamAValue ?? 0,
          teamBLoadout: loadout?.teamBValue ?? 0,
          teamASpent: loadout?.teamASpent ?? 0,
          teamBSpent: loadout?.teamBSpent ?? 0,
          teamARemaining: loadout?.teamACredits ?? 0,
          teamBRemaining: loadout?.teamBCredits ?? 0,
          teamASide: determineRoundSide(teamAId, roundNum),
          teamBSide: determineRoundSide(teamBId, roundNum),
          roundResult: round.roundResult,
          roundCeremony: round.roundCeremony,
          plantRoundTime: round.plantRoundTime,
          defuseRoundTime: round.defuseRoundTime,
          bombPlanter: cleanId(round.bombPlanter),
          bombDefuser: cleanId(round.bombDefuser),
          kills,
          playerRounds: [...playerRoundMap.values()],
        };
      },
    );

    return analyzeAdvancedMomentum({
      existingMomentum: momentumAnalysis,
      rounds,
      players: advancedPlayers,
      teamAId,
      teamBId,
      economyAnalysis: economyEfficiencyAnalysis,
      playerImpacts: momentumAnalysis.rounds.flatMap((round) =>
        round.playerImpact ? [round.playerImpact] : [],
      ),
    });
  }, [
    currentMatch,
    momentumAnalysis,
    economyEfficiencyAnalysis,
    roundTeamLoadoutTimeline,
    players,
    teamAId,
    teamBId,
    agentById,
    agentNameMap,
    teamByPuuid,
  ]);

  const importantMomentumEventsByRound = useMemo(() => {
    const map = new Map<number, MomentumEvent[]>();
    for (const event of advancedMomentumAnalysis?.events ?? []) {
      if (event.totalImpactScore < 1.5 && !event.isTurningPoint) continue;
      const current = map.get(event.roundNumber) ?? [];
      current.push(event);
      map.set(event.roundNumber, current);
    }
    return map;
  }, [advancedMomentumAnalysis]);

  const teamEconomyDistributionData = useMemo(
    () =>
      (["eco", "semiEco", "fullBuy"] as const).map((key) => ({
        name: economyBuyLabels[key],
        teamA: teamEconomySummaries[0]?.buyTypes[key].rounds ?? 0,
        teamB: teamEconomySummaries[1]?.buyTypes[key].rounds ?? 0,
      })),
    [teamEconomySummaries],
  );

  const teamEconomyTimelineData = useMemo(
    () =>
      roundTeamLoadoutTimeline.map((round) => ({
        round: round.roundNum + 1,
        teamA: round.teamAValue,
        teamB: round.teamBValue,
      })),
    [roundTeamLoadoutTimeline],
  );

  const orderedPlayersByTeam = useMemo<Array<[string, RawPlayer[]]>>(
    () =>
      teamScoreboardGroups.map((group) => [
        group.teamId,
        group.rows.map((row) => row.player),
      ]),
    [teamScoreboardGroups],
  );

  const duelMatrix = useMemo(
    () => buildDuelMatrix(orderedPlayersByTeam, allRoundEvents),
    [orderedPlayersByTeam, allRoundEvents],
  );

  const filteredDuelMatrix = duelMatrix;

  const activeDuel =
    duelMatrix.find((cell) => cell.key === selectedDuelKey) ??
    filteredDuelMatrix.find((cell) => cell.total > 0) ??
    filteredDuelMatrix[0] ??
    null;

  const selectedDuelDetailEvent = useMemo(() => {
    if (!activeDuel) return null;
    return (
      activeDuel.events.find((event) => event.id === selectedEventId) ??
      activeDuel.events[0] ??
      null
    );
  }, [activeDuel, selectedEventId]);

  const selectedDuelMapState = useMemo(
    () =>
      buildEventMapState({
        event: selectedDuelDetailEvent,
        roundEvents: allRoundEvents.filter(
          (event) => event.roundNum === selectedDuelDetailEvent?.roundNum,
        ),
        mapTransform,
        playersByPuuid,
        playerTeam,
        selectedPlayerId: effectiveSelectedPlayerId,
        agentById,
      }),
    [
      selectedDuelDetailEvent,
      allRoundEvents,
      mapTransform,
      playersByPuuid,
      playerTeam,
      effectiveSelectedPlayerId,
      agentById,
    ],
  );

  const duelSummary = useMemo(() => {
    const selectedCells = duelMatrix.filter((cell) =>
      [cleanId(cell.teamAPlayer.puuid), cleanId(cell.teamBPlayer.puuid)].includes(effectiveSelectedPlayerId),
    );
    const sourceCells = selectedCells.length > 0 ? selectedCells : duelMatrix;
    const playedCells = sourceCells.filter((cell) => cell.total > 0);
    const selectedKills = playedCells.reduce((sum, cell) => {
      if (cleanId(cell.teamAPlayer.puuid) === effectiveSelectedPlayerId) return sum + cell.teamAKillsOnB;
      if (cleanId(cell.teamBPlayer.puuid) === effectiveSelectedPlayerId) return sum + cell.teamBKillsOnA;
      return sum;
    }, 0);
    const rivalKills = playedCells.reduce((sum, cell) => {
      if (cleanId(cell.teamAPlayer.puuid) === effectiveSelectedPlayerId) return sum + cell.teamBKillsOnA;
      if (cleanId(cell.teamBPlayer.puuid) === effectiveSelectedPlayerId) return sum + cell.teamAKillsOnB;
      return sum;
    }, 0);
    return {
      selectedKills,
      rivalKills,
      selectedWon: playedCells.filter((cell) =>
        cleanId(cell.teamAPlayer.puuid) === effectiveSelectedPlayerId
          ? cell.leader === "teamA"
          : cleanId(cell.teamBPlayer.puuid) === effectiveSelectedPlayerId
            ? cell.leader === "teamB"
            : false,
      ).length,
      rivalWon: playedCells.filter((cell) =>
        cleanId(cell.teamAPlayer.puuid) === effectiveSelectedPlayerId
          ? cell.leader === "teamB"
          : cleanId(cell.teamBPlayer.puuid) === effectiveSelectedPlayerId
            ? cell.leader === "teamA"
            : false,
      ).length,
      ties: playedCells.filter((cell) => cell.leader === "tie").length,
    };
  }, [duelMatrix, effectiveSelectedPlayerId]);

  const duelHighlights = useMemo(() => {
    const played = duelMatrix.filter(
      (cell) =>
        cell.total > 0 &&
        [cleanId(cell.teamAPlayer.puuid), cleanId(cell.teamBPlayer.puuid)].includes(effectiveSelectedPlayerId),
    );
    const selectedMargin = (cell: PlayerDuelCell) =>
      cleanId(cell.teamAPlayer.puuid) === effectiveSelectedPlayerId
        ? cell.teamAKillsOnB - cell.teamBKillsOnA
        : cell.teamBKillsOnA - cell.teamAKillsOnB;
    return {
      top: [...played].sort((a, b) => b.total - a.total)[0] ?? null,
      teamA: [...played].sort((a, b) => selectedMargin(b) - selectedMargin(a))[0] ?? null,
      teamB: [...played].sort((a, b) => selectedMargin(a) - selectedMargin(b))[0] ?? null,
    };
  }, [duelMatrix, effectiveSelectedPlayerId]);

  const visibleDuelTeamAPlayers = useMemo(() => {
    const allowed = new Set(filteredDuelMatrix.map((cell) => cleanId(cell.teamAPlayer.puuid)));
    return (orderedPlayersByTeam[0]?.[1] ?? []).filter((player) =>
      allowed.has(cleanId(player.puuid)),
    );
  }, [filteredDuelMatrix, orderedPlayersByTeam]);

  const visibleDuelTeamBPlayers = useMemo(() => {
    const allowed = new Set(filteredDuelMatrix.map((cell) => cleanId(cell.teamBPlayer.puuid)));
    return (orderedPlayersByTeam[1]?.[1] ?? []).filter((player) =>
      allowed.has(cleanId(player.puuid)),
    );
  }, [filteredDuelMatrix, orderedPlayersByTeam]);

  const duelCellByKey = useMemo(() => {
    const map = new Map<string, PlayerDuelCell>();
    for (const cell of filteredDuelMatrix) {
      map.set(cell.key, cell);
    }
    return map;
  }, [filteredDuelMatrix]);

  const scoreState = useMemo(
    () => getTeamScoreState(currentMatch, playerTeam),
    [currentMatch, playerTeam],
  );
  const { resultState } = scoreState;

  const buyTypeSummary = useMemo(() => {
    const empty = { rounds: 0, wins: 0, winRate: 0 };
    if (!matchAnalysis) {
      return {
        eco: empty,
        semiEco: empty,
        fullBuy: empty,
      };
    }

    const summarize = (predicate: (round: RoundSummary) => boolean) => {
      const rounds = matchAnalysis.rounds.filter(predicate);
      const wins = rounds.filter((round) => round.didWin).length;
      return {
        rounds: rounds.length,
        wins,
        winRate: safeDivide(wins, Math.max(rounds.length, 1)) * 100,
      };
    };

    return {
      eco: summarize((round) => round.buyType === "eco"),
      semiEco: summarize((round) => round.buyType === "semiEco"),
      fullBuy: summarize((round) => round.buyType === "fullBuy"),
    };
  }, [matchAnalysis]);

  const economyChartData = useMemo(() => {
    if (!matchAnalysis) return [];

    return (["eco", "semiEco", "fullBuy"] as const).map((key) => {
      const summary = buyTypeSummary[key];
      const rounds = matchAnalysis.rounds.filter((round) => round.buyType === key);
      return {
        key,
        name: economyBuyLabels[key],
        rounds: summary.rounds,
        wins: summary.wins,
        winRate: summary.winRate,
        acs: safeDivide(
          rounds.reduce((sum, round) => sum + round.playerScore, 0),
          Math.max(rounds.length, 1),
        ),
        color: economyBuyColors[key],
      };
    });
  }, [buyTypeSummary, matchAnalysis]);

  const activeSectionLabel =
    matchDetailSections.find((section) => section.key === activeSection)
      ?.label ?? "Resumen";

  useEffect(() => {
    if (!playbackOpen || !playbackPlaying || playbackEvents.length <= 1) return;
    const interval = window.setInterval(() => {
      setPlaybackIndex((current) => {
        if (current >= playbackEvents.length - 1) {
          setPlaybackPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1400);
    return () => window.clearInterval(interval);
  }, [playbackEvents.length, playbackOpen, playbackPlaying]);

  useEffect(() => {
    if (!playbackOpen) return;
    const list = playbackActionListRef.current;
    if (!list) return;
    const frameId = window.requestAnimationFrame(() => {
      const activeItem =
        list.querySelector<HTMLElement>(
          `[data-playback-index="${playbackIndex}"]`,
        ) ??
        list.querySelector<HTMLElement>(".match-playback-round-group.is-open");
      if (!activeItem) return;

      const listRect = list.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      if (itemRect.top < listRect.top) {
        list.scrollBy({
          top: itemRect.top - listRect.top - 8,
          behavior: "smooth",
        });
      } else if (itemRect.bottom > listRect.bottom) {
        list.scrollBy({
          top: itemRect.bottom - listRect.bottom + 8,
          behavior: "smooth",
        });
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [playbackIndex, playbackOpen]);

  useEffect(() => {
    const panel = matchDetailPanelRef.current;
    if (!panel) return;

    const updateOverflowState = () => {
      const viewportHeight = window.innerHeight;
      const panelHeight = panel.scrollHeight;
      const verticalPadding = 32;
      setIsMatchDetailOverflowing(
        panelHeight + verticalPadding > viewportHeight,
      );
    };

    updateOverflowState();

    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(panel);

    window.addEventListener("resize", updateOverflowState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateOverflowState);
    };
  }, [
    loading,
    matchAnalysis,
    activeSection,
    effectiveSelectedPlayerId,
    selectedRoundNum,
    selectedEventId,
    playbackOpen,
  ]);

  if (!loading && !currentMatch) {
    return (
      <div
        className={`modal-overlay match-detail-modal-overlay ${
          isMatchDetailOverflowing ? "is-overflowing" : "is-centered"
        }`}
        onClick={onClose}
      >
        <div
          ref={matchDetailPanelRef}
          className="modal-panel modal-panel-lg match-detail-modal-panel"
          onClick={(event) => event.stopPropagation()}
        >
          <button className="content-detail-close modal-close" type="button" aria-label="Cerrar detalle" onClick={onClose}>
            <span className="content-detail-close-icon modal-close-icon" aria-hidden="true" />
          </button>
          <div className="empty-panel">No se pudo cargar la partida.</div>
        </div>
      </div>
    );
  }

  if (!loading && currentMatch && !playerInfo) {
    return (
      <div
        className={`modal-overlay match-detail-modal-overlay ${
          isMatchDetailOverflowing ? "is-overflowing" : "is-centered"
        }`}
        onClick={onClose}
      >
        <div
          ref={matchDetailPanelRef}
          className="modal-panel modal-panel-lg match-detail-modal-panel"
          onClick={(event) => event.stopPropagation()}
        >
          <button className="content-detail-close modal-close" type="button" aria-label="Cerrar detalle" onClick={onClose}>
            <span className="content-detail-close-icon modal-close-icon" aria-hidden="true" />
          </button>
          <div className="empty-panel">
            El jugador objetivo no aparece en esta partida.
          </div>
        </div>
      </div>
    );
  }

  const handleRoundSelect = (round: RoundSummary) => {
    setSelectedRoundNum(round.roundNum);
    setSelectedEventId(round.events[0]?.id ?? null);
  };

  const handlePlayerSelect = (nextPlayerId: string) => {
    if (!nextPlayerId || nextPlayerId === selectedPlayerId) return;
    setSelectedPlayerState({
      matchId,
      playerId,
      selectedPlayerId: nextPlayerId,
    });
    setSelectedRoundNum(null);
    setSelectedEventId(null);
    setSelectedDuelKey(null);
    setPlaybackOpen(false);
    setPlaybackPlaying(false);
  };

  const renderRoundEventButton = (event: RoundEvent) => {
    const isActive = selectedEvent?.id === event.id;
    const renderActionParticipant = (
      puuid: string | undefined,
      name: string,
      icon?: string,
    ) => {
      const cleanPuuid = cleanId(puuid);
      const participantTeam = cleanPuuid
        ? cleanId(playersByPuuid.get(cleanPuuid)?.teamId)
        : "";
      const tone =
        cleanPuuid === effectiveSelectedPlayerId
          ? "target"
          : participantTeam && participantTeam === playerTeam
            ? "ally"
            : "enemy";

      return (
        <span className={`match-action-player is-${tone}`}>
          {icon ? (
            <img src={icon} alt="" />
          ) : (
            <span>{name.charAt(0).toUpperCase()}</span>
          )}
          <strong>{name}</strong>
        </span>
      );
    };

    if (event.kind === "kill") {
      return (
        <button
          key={event.id}
          type="button"
          className={`match-round-event-btn ${isActive ? "is-active" : ""}`}
          onClick={() => {
            setSelectedRoundNum(event.roundNum);
            setSelectedEventId(event.id);
          }}
          aria-pressed={isActive}
        >
          <div className="match-round-event-top">
            <span className="match-action-text">
              {renderActionParticipant(
                event.killer,
                event.killerName,
                event.killerIcon,
              )}
              <span>eliminó a</span>
              {renderActionParticipant(
                event.victim,
                event.victimName,
                event.victimIcon,
              )}
            </span>
          </div>

          <div className="match-round-event-meta">
            <span className="match-round-event-weapon">
              {(event.isAbilityKill ? event.abilityIcon : event.weaponIcon) && (
                <img
                  src={(event.isAbilityKill ? event.abilityIcon : event.weaponIcon) ?? ""}
                  alt={event.isAbilityKill ? event.abilityName ?? event.weaponName : event.weaponName}
                />
              )}
              <span>
                {event.isAbilityKill
                  ? event.abilityName ?? event.weaponName
                  : event.weaponName}
              </span>
            </span>
            <span className="match-round-event-time">
              {toSecondsLabel(event.timeMs)}
            </span>
          </div>
        </button>
      );
    }

    const actorMeta = getAgentMeta(
      event.actor ? playersByPuuid.get(event.actor) : null,
      agentById,
      agentNameMap,
    );

    return (
      <button
        key={event.id}
        type="button"
        className={`match-round-event-btn match-round-event-btn-objective ${isActive ? "is-active" : ""}`}
        onClick={() => {
          setSelectedRoundNum(event.roundNum);
          setSelectedEventId(event.id);
        }}
        aria-pressed={isActive}
      >
        <div className="match-round-event-top">
          <span className="match-action-text">
            {renderActionParticipant(
              event.actor,
              event.actorName,
              actorMeta.icon ?? undefined,
            )}
            <span>
              ha {event.kind === "plant" ? "plantado" : "defusado"}
            </span>
          </span>
        </div>
        <div className="match-round-event-meta">
          <span>{event.site ? `Sitio ${event.site}` : "Objetivo"}</span>
          <span className="match-round-event-time">
            {toSecondsLabel(event.timeMs)}
          </span>
        </div>
      </button>
    );
  };

  const openRoundPlayback = (round: RoundSummary) => {
    if (round.events.length === 0) return;
    setPlaybackEvents(round.events);
    setPlaybackMode("round");
    setPlaybackIndex(0);
    setPlaybackTitle(`Reproducción de ${roundLabel(round.roundNum)}`);
    setPlaybackPlaying(true);
    setPlaybackOpen(true);
  };

  const openMatchPlayback = () => {
    if (allRoundEvents.length === 0) return;
    setPlaybackEvents(sortedAllRoundEvents);
    setPlaybackMode("match");
    setPlaybackIndex(0);
    setPlaybackTitle("Reproducción de partida");
    setPlaybackPlaying(true);
    setPlaybackOpen(true);
  };

  const closePlayback = () => {
    setPlaybackOpen(false);
    setPlaybackPlaying(false);
  };

  const nextPlaybackEvent = () => {
    setPlaybackIndex((current) => {
      if (current >= playbackEvents.length - 1) {
        setPlaybackPlaying(false);
        return current;
      }
      return current + 1;
    });
  };

  const previousPlaybackEvent = () => {
    setPlaybackIndex((current) => Math.max(0, current - 1));
  };

  const restartPlayback = () => {
    setPlaybackIndex(0);
    setPlaybackPlaying(playbackEvents.length > 0);
  };

  const playbackEvent = playbackEvents[playbackIndex] ?? null;
  const playbackRounds = (() => {
    const grouped = new Map<number, Array<{ event: RoundEvent; index: number }>>();
    playbackEvents.forEach((event, index) => {
      const entries = grouped.get(event.roundNum) ?? [];
      entries.push({ event, index });
      grouped.set(event.roundNum, entries);
    });
    return [...grouped.entries()];
  })();
  const playbackIndexByEventId = new Map(
    playbackEvents.map((event, index) => [event.id, index] as const),
  );
  const activePlaybackRoundNum = playbackEvent?.roundNum ?? null;
  const nextPlaybackRoundIndex =
    playbackMode === "match" && playbackEvent
      ? playbackEvents.findIndex(
          (event, index) =>
            index > playbackIndex && event.roundNum !== playbackEvent.roundNum,
        )
      : -1;
  const nextPlaybackRound = () => {
    if (nextPlaybackRoundIndex >= 0) {
      setPlaybackIndex(nextPlaybackRoundIndex);
    }
  };
  const activePlaybackRoundEntries = playbackEvent
    ? playbackRounds.find(([roundNum]) => roundNum === playbackEvent.roundNum)?.[1] ??
      []
    : [];
  const activePlaybackActionIndex = playbackEvent
    ? activePlaybackRoundEntries.findIndex(
        ({ index }) => index === playbackIndex,
      )
    : -1;
  const playbackProgressLabel = playbackEvent
    ? `${roundLabel(playbackEvent.roundNum)}, acción ${
        activePlaybackActionIndex + 1
      } de ${activePlaybackRoundEntries.length} acciones de esta ronda`
    : "No hay acciones para reproducir";
  const getPlaybackRoundHighlights = (
    roundNum: number,
    entries: Array<{ event: RoundEvent; index: number }>,
  ) => {
    const highlights: string[] = [];
    const round = matchAnalysis?.rounds.find(
      (entry) => entry.roundNum === roundNum,
    );
    const validKills = entries
      .map(({ event }) => event)
      .filter(
        (event): event is KillRoundEvent =>
          event.kind === "kill" && event.isValidKill,
      );
    const firstBlood = validKills[0];
    if (firstBlood) {
      highlights.push(`Primera sangre: ${firstBlood.killerName}`);
    }
    const killsByPlayer = new Map<string, number>();
    validKills.forEach((event) => {
      const key = cleanId(event.killer) || event.killerName;
      killsByPlayer.set(key, (killsByPlayer.get(key) ?? 0) + 1);
    });
    const multikill = [...killsByPlayer.values()].sort((a, b) => b - a)[0] ?? 0;
    if (multikill >= 2) highlights.push(`Multikill ${multikill}K`);
    if (round?.hadPlant) highlights.push("Plant");
    if (round?.hadDefuse) highlights.push("Defuse");
    const momentumHighlight = importantMomentumEventsByRound
      .get(roundNum + 1)
      ?.find((event) => event.type.toLowerCase().includes("clutch"));
    if (momentumHighlight) highlights.push("Clutch");
    return highlights;
  };
  const playbackMapState = buildEventMapState({
    event: playbackEvent,
    roundEvents: activePlaybackRoundEntries.map(({ event }) => event),
    mapTransform,
    playersByPuuid,
    playerTeam,
    selectedPlayerId: effectiveSelectedPlayerId,
    agentById,
  });

  const renderPlaybackEventButton = (event: RoundEvent) => {
    const index = playbackIndexByEventId.get(event.id) ?? 0;
    const isActive = index === playbackIndex;
    const renderActionParticipant = (
      puuid: string | undefined,
      name: string,
      icon?: string,
    ) => {
      const cleanPuuid = cleanId(puuid);
      const participantTeam = cleanPuuid
        ? cleanId(playersByPuuid.get(cleanPuuid)?.teamId)
        : "";
      const tone =
        cleanPuuid === effectiveSelectedPlayerId
          ? "target"
          : participantTeam && participantTeam === playerTeam
            ? "ally"
            : "enemy";

      return (
        <span className={`match-action-player is-${tone}`}>
          {icon ? (
            <img src={icon} alt="" />
          ) : (
            <span>{name.charAt(0).toUpperCase()}</span>
          )}
          <strong>{name}</strong>
        </span>
      );
    };
    const actorMeta =
      event.kind === "kill"
        ? null
        : getAgentMeta(
            event.actor ? playersByPuuid.get(event.actor) : null,
            agentById,
            agentNameMap,
          );

    return (
      <button
        key={event.id}
        type="button"
        className={`match-playback-action ${
          event.kind === "plant" || event.kind === "defuse" ? "is-objective" : ""
        } ${isActive ? "is-active" : ""}`}
        data-playback-index={index}
        onClick={() => setPlaybackIndex(index)}
        aria-current={isActive ? "true" : undefined}
      >
        <span className="match-round-event-time">
          {toSecondsLabel(event.timeMs)}
        </span>
        <span className="match-action-text">
          {event.kind === "kill" ? (
            <>
              {renderActionParticipant(
                event.killer,
                event.killerName,
                event.killerIcon,
              )}
              <span>eliminó a</span>
              {renderActionParticipant(
                event.victim,
                event.victimName,
                event.victimIcon,
              )}
            </>
          ) : (
            <>
              {renderActionParticipant(
                event.actor,
                event.actorName,
                actorMeta?.icon ?? undefined,
              )}
              <span>
                ha {event.kind === "plant" ? "plantado" : "defusado"}
              </span>
            </>
          )}
        </span>
      </button>
    );
  };

  const formatSignedNumber = (value: number) =>
    value > 0 ? `+${formatNumber(value)}` : formatNumber(value);

  const getValueToneClass = (value: number) =>
    value > 0
      ? "match-scoreboard-value-positive"
      : value < 0
        ? "match-scoreboard-value-negative"
        : "";

  const getTeamMetaForStats = (stats: PlayerScoreboardStats) =>
    teamScoreboardGroups.find((group) => group.teamId === stats.teamId) ??
    teamScoreboardGroups[0];

  const renderScoreboardTable = (
    rows: PlayerScoreboardStats[],
    options: { showTeamBadge?: boolean } = {},
  ) => (
    <div className="match-scoreboard-table-wrap">
      <div className="match-scoreboard-table">
        <div className="match-scoreboard-table-head">
          <span>Jugador</span>
          <span>Match Rank</span>
          <span>ACS</span>
          <span>K</span>
          <span>D</span>
          <span>A</span>
          <span>+/-</span>
          <span>K/D</span>
          <span>DDÎ”</span>
          <span>ADR</span>
          <span>HS%</span>
          <span>KAST</span>
          <span>FK</span>
          <span>FD</span>
          <span>MK</span>
        </div>

        {rows.map((row) => {
          const teamMeta = getTeamMetaForStats(row);
          const teamTone = teamMeta?.tone ?? "team-a";
          const playerName = getPlayerShortDisplay(row.player);
          const playerTag = row.player.tagLine?.trim();
          const accountLevel = toNumber(row.player.accountLevel);
          const isSelected = row.puuid === effectiveSelectedPlayerId;
          const partyMarker = partyMarkerByPuuid.get(row.puuid);
          const partyMarkerStyle = partyMarker
            ? ({ "--party-marker-color": partyMarker.color } as CSSProperties)
            : undefined;

          return (
            <button
              key={`scoreboard-row-${row.puuid}`}
              type="button"
              className={`match-scoreboard-row is-${teamTone} ${partyMarker ? "has-party-marker" : ""} ${isSelected ? "is-selected" : ""}`}
              style={partyMarkerStyle}
              onClick={() => handlePlayerSelect(row.puuid)}
              aria-label={`Ver partida desde la perspectiva de ${playerName}${partyMarker ? `, jugador en party ${partyMarker.partyId}` : ""}`}
              title={`Score: ${formatNumber(row.score)}${partyMarker ? ` · Party ${partyMarker.partyId}` : ""}`}
            >
              <span className="match-scoreboard-cell-player">
                {row.agentIcon ? (
                  <img src={row.agentIcon} alt="" />
                ) : (
                  <i>{row.agentName.charAt(0).toUpperCase()}</i>
                )}
                <span className="match-scoreboard-player-copy">
                  <strong>
                    {playerName}
                    {playerTag ? <small>#{playerTag}</small> : null}
                  </strong>
                  <em>
                    {accountLevel > 0 ? `Nivel ${accountLevel}` : row.agentName}
                  </em>
                </span>
                {options.showTeamBadge && teamMeta && (
                  <span className={`match-scoreboard-team-badge is-${teamTone}`}>
                    {teamMeta.teamLabel}
                  </span>
                )}
              </span>

              <span className="match-scoreboard-rank" title={row.rankName}>
                {row.rankIcon ? (
                  <img
                    src={row.rankIcon}
                    alt={row.rankName}
                    onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                  />
                ) : (
                  "-"
                )}
              </span>
              <span className="match-scoreboard-acs">{formatNumber(row.acs)}</span>
              <span>{formatNumber(row.kills)}</span>
              <span>{formatNumber(row.deaths)}</span>
              <span>{formatNumber(row.assists)}</span>
              <span className={getValueToneClass(row.plusMinus)}>
                {formatSignedNumber(row.plusMinus)}
              </span>
              <span
                className={
                  row.kd >= 1
                    ? "match-scoreboard-value-positive"
                    : "match-scoreboard-value-negative"
                }
              >
                {formatNumber(row.kd, 2)}
              </span>
              <span className={getValueToneClass(row.damageDelta)}>
                {row.damageDelta > 0
                  ? `+${formatNumber(row.damageDelta, 1)}`
                  : formatNumber(row.damageDelta, 1)}
              </span>
              <span>{formatNumber(row.adr, 1)}</span>
              <span>{formatPercent(row.hsPct, 1)}</span>
              <span
                className={
                  row.kastPct >= 70
                    ? "match-scoreboard-value-positive"
                    : row.kastPct < 55
                      ? "match-scoreboard-value-negative"
                      : ""
                }
              >
                {formatPercent(row.kastPct, 1)}
              </span>
              <span>{formatNumber(row.firstKills)}</span>
              <span>{formatNumber(row.firstDeaths)}</span>
              <span>{formatNumber(row.multikillRounds)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderDuelPlayer = (player: RawPlayer) => {
    const agent = getAgentMeta(player, agentById, agentNameMap);
    return (
      <span className="match-duel-player">
        {agent.icon ? <img src={agent.icon} alt="" /> : <i>{agent.name.charAt(0)}</i>}
        <strong>{getPlayerShortDisplay(player)}</strong>
      </span>
    );
  };

  const renderDuelAgentIcon = (player: RawPlayer) => {
    const agent = getAgentMeta(player, agentById, agentNameMap);
    const title = `${getPlayerShortDisplay(player)} · ${agent.name}`;

    return agent.icon ? (
      <img
        className="match-duel-score-agent-icon"
        src={agent.icon}
        alt={agent.name}
        title={title}
        loading="lazy"
      />
    ) : (
      <span
        className="match-duel-score-agent-icon match-duel-score-agent-fallback"
        title={title}
      >
        {agent.name.charAt(0).toUpperCase()}
      </span>
    );
  };

  const renderDuelInlineDetail = (cell: PlayerDuelCell) => (
    <div className="match-duel-inline-detail">
      <button
        type="button"
        className="content-detail-close modal-close match-duel-inline-close"
        aria-label="Cerrar detalle"
        onClick={() => {
          setSelectedDuelKey(null);
          setSelectedEventId(null);
        }}
      >
        <span className="content-detail-close-icon modal-close-icon" aria-hidden="true" />
      </button>
      <div className="match-duel-inline-events">
        {cell.events.length === 0 ? (
          <div className="empty-chart">No hay kills entre estos jugadores.</div>
        ) : (
          cell.events.map((event) => (
            <button
              key={`duel-event-${event.id}`}
              type="button"
              className={`match-round-event-btn ${
                selectedDuelDetailEvent?.id === event.id ? "is-active" : ""
              }`}
              onClick={() => {
                setSelectedRoundNum(event.roundNum);
                setSelectedEventId(event.id);
              }}
            >
              <span className="match-round-event-time">
                {roundLabel(event.roundNum)} · {toSecondsLabel(event.timeMs)}
              </span>
              <span className="match-action-text">
                {event.kind === "kill"
                  ? `${event.killerName} eliminó a ${event.victimName}`
                  : getEventDescription(event)}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="match-duel-inline-map">
        <MatchEventMapCanvas
          mapName={mapName}
          mapImageUrl={mapImageUrl}
          selectedEvent={selectedDuelDetailEvent}
          eventMapState={selectedDuelMapState}
          mapTransform={mapTransform}
        />
      </div>
    </div>
  );

  const renderDuelHighlight = (
    title: string,
    cell: PlayerDuelCell | null,
    tone: "top" | "team-a" | "team-b",
  ) => {
    const openDuel = () => {
      if (cell) setSelectedDuelKey(cell.key);
    };

    return (
      <article
        className={`match-duel-highlight-card match-duel-highlight-card--${tone} ${
          cell?.key === selectedDuelKey ? "is-selected" : ""
        } ${cell ? "is-clickable" : ""}`}
        role={cell ? "button" : undefined}
        tabIndex={cell ? 0 : undefined}
        onClick={openDuel}
        onKeyDown={(event) => {
          if (!cell) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDuel();
          }
        }}
      >
        <span>{title}</span>
        {cell ? (
          <div className="match-duel-highlight-content">
            <span className="match-duel-highlight-player">
              {renderDuelPlayer(cell.teamAPlayer)}
            </span>
            <strong className="match-duel-highlight-score">
              {cell.teamAKillsOnB} - {cell.teamBKillsOnA}
            </strong>
            <span className="match-duel-highlight-player">
              {renderDuelPlayer(cell.teamBPlayer)}
            </span>
          </div>
        ) : (
          <p>Sin datos suficientes</p>
        )}
      </article>
    );
  };

  if (loading || !matchAnalysis) {
    return <LoadingModal placement="overlay" />;
  }

  const matchDetailHero = (
    <header className={`match-detail-hero result-${resultState}`}>
      <div className="match-detail-hero-copy">
        <div className="match-detail-title-row">
          {playerAgentIcon && (
            <img
              src={playerAgentIcon}
              alt={playerAgentName}
              className="match-detail-player-agent"
            />
          )}
          <h2 className="stats-title modal-title-small">{mapName}</h2>
          <button
            type="button"
            className="match-map-play-button"
            onClick={openMatchPlayback}
            disabled={allRoundEvents.length === 0}
            aria-label="Reproducir partida"
            title="Reproducir partida"
          >
            <Play aria-hidden="true" />
          </button>
        </div>

        <div className="match-player-identity">
          <strong>{getPlayerDisplay(playerInfo)}</strong>
          <span>
            {playerRankIcon && (
              <img
                src={playerRankIcon}
                alt=""
                className="match-rank-icon-inline"
                onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
              />
            )}
            {playerRankName}
          </span>
        </div>

        <div className="match-detail-meta-row">
          <span className="meta-pill">
            Comienzo: {formatDateTime(currentMatch?.matchInfo?.gameStartMillis)}
          </span>
          <span className="meta-pill">
            Duración:{" "}
            {toGameDurationLabel(currentMatch?.matchInfo?.gameLengthMillis) ||
              "no disponible"}
          </span>
        </div>
      </div>

      <div className="match-result-card">
        <div className="match-score-main">
          <span className="match-score-label">Resultado</span>
          <div className="match-score-lockup">
            <strong className="match-score-value">
              {scoreState.selectedTeamRounds} - {scoreState.opponentTeamRounds}
            </strong>
            <div className="match-score-context">
              <span>
                {queueLabel ||
                  gameModeLabel ||
                  "Modo desconocido"}
              </span>
              <span>{matchAnalysis.totalRounds} rondas</span>
            </div>
          </div>
        </div>

        <div className="match-score-split">
          <div>
            <span>K / D / A</span>
            <strong>
              {matchAnalysis.kills}/{matchAnalysis.deaths}/{matchAnalysis.assists}
            </strong>
          </div>
          <div>
            <span>KD</span>
            <strong>{formatNumber(matchAnalysis.kd, 2)}</strong>
          </div>
          <div>
            <span>KDA</span>
            <strong>{formatNumber(matchAnalysis.kda, 2)}</strong>
          </div>
          <div>
            <span>Score</span>
            <strong>{formatNumber(matchAnalysis.score)}</strong>
          </div>
          <div>
            <span>ACS</span>
            <strong>{formatNumber(matchAnalysis.acs)}</strong>
          </div>
          <div>
            <span>ADR</span>
            <strong>{formatNumber(matchAnalysis.adr, 1)}</strong>
          </div>
          <div>
            <span>Supervivencia</span>
            <strong>{formatPercent(matchAnalysis.survivalPct, 1)}</strong>
          </div>
          <div>
            <span>Impacto en wins</span>
            <strong>{formatPercent(matchAnalysis.winRoundParticipationPct, 1)}</strong>
          </div>
        </div>

      </div>
    </header>
  );


  return (
    <div
      className={`modal-overlay match-detail-modal-overlay ${
        isMatchDetailOverflowing ? "is-overflowing" : "is-centered"
      }`}
      onClick={onClose}
    >
      <div
        ref={matchDetailPanelRef}
        className="modal-panel modal-panel-lg match-detail-modal-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="content-detail-close modal-close" type="button" aria-label="Cerrar detalle" onClick={onClose}>
          <span className="content-detail-close-icon modal-close-icon" aria-hidden="true" />
        </button>

        <div className="match-detail-shell">
            <div className="match-detail-navigation-sticky">
              <section className="match-teams-strip" aria-label="Jugadores de la partida">
                <div className="match-teams-strip-track">
                  {playersByTeam.map(([teamId, teamPlayers], teamIndex) => (
                    <div
                      key={teamId}
                      className={`match-team-roster match-team-roster--${teamIndex === 0 ? "a" : "b"}`}
                    >
                      {teamIndex === 0 && (
                        <span className="match-team-roster-label">Team A</span>
                      )}
                      <div className="match-team-roster-players">
                        {teamPlayers.map((player) => {
                        const puuid = cleanId(player.puuid);
                        const agent = getAgentMeta(player, agentById, agentNameMap);
                        const isSelected = puuid === effectiveSelectedPlayerId;
                        const isMvp = puuid !== "" && puuid === cleanId(mvp?.puuid);
                        const playerName = getPlayerShortDisplay(player);
                        return (
                          <button
                            key={puuid || `${teamId}-${playerName}`}
                            type="button"
                            className={`match-team-player-button ${isSelected ? "is-selected" : ""} ${isMvp ? "is-mvp" : ""}`}
                            onClick={() => puuid && handlePlayerSelect(puuid)}
                            aria-label={`Ver partida desde la perspectiva de ${playerName}, ${agent.name}, ${teamIndex === 0 ? "Team A" : "Team B"}`}
                            aria-pressed={isSelected}
                          >
                            {agent.icon ? (
                              <img src={agent.icon} alt="" />
                            ) : (
                              <span className="match-team-agent-fallback">
                                {agent.name.charAt(0).toUpperCase()}
                              </span>
                            )}
                            {isMvp && <strong className="match-team-mvp-badge">MVP</strong>}
                            <span>{playerName}</span>
                          </button>
                        );
                        })}
                      </div>
                      {teamIndex === 1 && (
                        <span className="match-team-roster-label">Team B</span>
                      )}
                      {teamIndex === 0 && playersByTeam.length > 1 && (
                        <span className="match-team-vs">VS</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <nav
                className="match-detail-tabs"
                aria-label="Secciones del detalle de partida"
              >
                {matchDetailSections.map((section) => (
                  <button
                    key={section.key}
                    type="button"
                    className={activeSection === section.key ? "is-active" : ""}
                    onClick={() => setActiveSection(section.key)}
                    aria-pressed={activeSection === section.key}
                  >
                    {section.label}
                  </button>
                ))}
              </nav>

              {activeSection === "rounds" && (
                <div className="match-round-strip-sticky" aria-label="Timeline de rondas">
                  <div className="match-round-strip-track">
                    {matchAnalysis.rounds.map((round) => {
                      const isOpen = selectedRound?.roundNum === round.roundNum;
                      const isKeyRound =
                        round.roundNum === matchAnalysis.bestRound?.roundNum;
                      return (
                        <button
                          key={`sticky-strip-${round.roundNum}`}
                          type="button"
                          className={`match-round-chip ${round.didWin ? "is-win" : "is-loss"} ${isOpen ? "is-open" : ""} ${isKeyRound ? "is-key-round" : ""}`}
                          onClick={() => handleRoundSelect(round)}
                          aria-label={`Abrir ronda ${round.roundNum + 1}, ${round.didWin ? "ganada" : "perdida"}, ${round.playerKills} kills`}
                          aria-current={isOpen ? "true" : undefined}
                          aria-pressed={isOpen}
                        >
                          <span className="match-round-chip-number">
                            {round.roundNum + 1}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="match-detail-section-body">
              {activeSection === "summary" && (
                <section
                  className="match-summary-section"
                  role="region"
                  aria-label={activeSectionLabel}
                >
                  {matchDetailHero}

                  <MatchRoundResultTimeline
                    rounds={matchAnalysis.rounds}
                    playersByTeam={playersByTeam}
                    currentMatch={currentMatch}
                    bestRoundNum={matchAnalysis.bestRound?.roundNum}
                    importantEventsByRound={importantMomentumEventsByRound}
                  />

                  <div className="match-summary-grid">
                    <article>
                      <span>Ronda clave</span>
                      <strong>
                        {matchAnalysis.bestRound
                          ? `${roundLabel(matchAnalysis.bestRound.roundNum)} · ${matchAnalysis.bestRound.playerKills}K`
                          : "Sin datos"}
                      </strong>
                    </article>
                    <article>
                      <span>Lado más sólido</span>
                      <strong>
                        {sideBest
                          ? `${sideBest.label} · ${formatPercent(sideBest.winRate, 1)}`
                          : "Sin datos"}
                      </strong>
                    </article>
                    <article>
                      <span>Arma principal</span>
                      <strong>
                        {matchAnalysis.topWeapons[0]
                          ? `${matchAnalysis.topWeapons[0].name} · ${matchAnalysis.topWeapons[0].kills}K`
                          : "Sin kills"}
                      </strong>
                    </article>
                    <article>
                      <span>Duelos iniciales</span>
                      <strong>
                        {matchAnalysis.openingWon} ganados /{" "}
                        {matchAnalysis.openingLost} perdidos
                      </strong>
                    </article>
                    <article>
                      <span>Trade kills</span>
                      <strong>{formatNumber(matchAnalysis.tradeKills)}</strong>
                    </article>
                    <article>
                      <span>Economía</span>
                      <strong>
                        ECO {matchAnalysis.ecoWins}/{matchAnalysis.ecoRounds} · SEMIECO{" "}
                        {buyTypeSummary.semiEco.wins}/{buyTypeSummary.semiEco.rounds} · FULL{" "}
                        {matchAnalysis.fullBuyWins}/{matchAnalysis.fullBuyRounds}
                      </strong>
                    </article>
                    <article>
                      <span>KAST</span>
                      <strong>{formatPercent(matchAnalysis.kastPct, 1)}</strong>
                    </article>
                    <article>
                      <span>Multikills</span>
                      <strong>
                        {matchAnalysis.multikillRounds} rondas · máximo{" "}
                        {matchAnalysis.maxKillsInRound}K
                      </strong>
                    </article>
                  </div>

                  <MatchMomentumPanel
                    momentum={momentumAnalysis}
                    advancedMomentum={advancedMomentumAnalysis}
                    match={currentMatch}
                    selectedPlayer={playerInfo}
                    teamAId={teamAId}
                    selectedTeamId={playerTeam}
                    opponentTeamId={opponentTeamId}
                    agentById={agentById}
                    agentNameMap={agentNameMap}
                  />
                </section>
              )}

            {activeSection === "rounds" && (
            <section
              className="match-round-strip"
              role="region"
              aria-label={activeSectionLabel}
            >
              {selectedRound && (
                <article className="match-selected-round-detail">
                  <div className="match-selected-round-header">
                    <div>
                      <h4>{roundLabel(selectedRound.roundNum)}</h4>
                      <p>
                        {selectedRound.side === "attack" ? "Ataque" : "Defensa"} ·{" "}
                        {selectedRound.roundResult}
                      </p>
                    </div>
                    <div className="round-trigger-summary">
                      <span
                        className={
                          selectedRound.didWin ? "text-positive" : "text-negative"
                        }
                      >
                        {selectedRound.didWin ? "Ganada" : "Perdida"}
                      </span>
                      <span>{selectedRound.playerKills}K</span>
                      <span>{selectedRound.playerDeaths}D</span>
                      <span>{selectedRound.playerAssists}A</span>
                      {selectedRound.hadPlant && <em>Plant</em>}
                      {selectedRound.hadDefuse && <em>Defuse</em>}
                      <button
                        type="button"
                        className="match-round-play-button"
                        onClick={() => openRoundPlayback(selectedRound)}
                        disabled={selectedRound.events.length === 0}
                        aria-label="Reproducir ronda"
                        title="Reproducir ronda"
                      >
                        <Play aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="match-selected-round-layout">
                    <div className="match-round-mini-scoreboard">
                      <h5>Clasificación</h5>
                      <div className="match-round-mini-table" role="table">
                        <div className="match-round-mini-row is-header" role="row">
                          <span aria-label="Agente" />
                          <span>Nombre</span>
                          <span>Score</span>
                          <span>K</span>
                          <span>D</span>
                          <span>A</span>
                          <span>Economía</span>
                        </div>
                        {selectedRoundScoreboardRows.map((row, index) => (
                          <Fragment key={`round-score-${row.playerId}`}>
                            {(index === 0 ||
                              selectedRoundScoreboardRows[index - 1]?.teamId !==
                                row.teamId) && (
                              <div
                                className={`match-round-mini-team-label ${
                                  row.teamId === playerTeam
                                    ? "is-selected-team"
                                    : ""
                                }`}
                              >
                                {row.teamId === playerTeam
                                  ? "Tu equipo"
                                  : "Equipo rival"}
                              </div>
                            )}
                            <div
                              className={`match-round-mini-row ${
                                row.teamId === playerTeam
                                  ? "is-selected-team"
                                  : ""
                              } ${
                                partyMarkerByPuuid.has(row.playerId)
                                  ? "has-party-marker"
                                  : ""
                              }`}
                              style={
                                partyMarkerByPuuid.has(row.playerId)
                                  ? ({
                                      "--party-marker-color":
                                        partyMarkerByPuuid.get(row.playerId)?.color,
                                    } as CSSProperties)
                                  : undefined
                              }
                              role="row"
                              aria-label={
                                partyMarkerByPuuid.has(row.playerId)
                                  ? `${row.playerName}, jugador en party ${partyMarkerByPuuid.get(row.playerId)?.partyId}`
                                  : row.playerName
                              }
                              title={
                                partyMarkerByPuuid.has(row.playerId)
                                  ? `Party ${partyMarkerByPuuid.get(row.playerId)?.partyId}`
                                  : undefined
                              }
                            >
                              <span title={row.agentName}>
                                {row.agentIcon ? (
                                  <img src={row.agentIcon} alt={row.agentName} />
                                ) : (
                                  <i>{row.agentName.charAt(0)}</i>
                                )}
                              </span>
                              <strong>{row.playerName}</strong>
                              <span>{formatNumber(row.score)}</span>
                              <span>{row.kills}</span>
                              <span>{row.deaths}</span>
                              <span>{row.assists}</span>
                              <span
                                className="match-round-mini-economy"
                                title={[row.weaponName, row.armorName]
                                  .filter(Boolean)
                                  .join(" · ")}
                              >
                                <small>
                                  Equipamiento <strong>{formatNumber(row.loadout)}</strong>
                                </small>
                                <small>
                                  Gastado <strong>{formatNumber(row.spent)}</strong>
                                </small>
                              </span>
                            </div>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                    <div className="match-selected-round-actions">
                      <h5>Acciones</h5>
                      <div className="match-round-events">
                        {selectedRoundEvents.length === 0 ? (
                          <div className="empty-chart">
                            No hay acciones registradas en la ronda seleccionada.
                          </div>
                        ) : (
                          selectedRoundEvents.map(renderRoundEventButton)
                        )}
                      </div>
                    </div>
                    <aside className="match-selected-round-map">
                      <h5>Mapa</h5>
                      <MatchEventMapCanvas
                        mapName={mapName}
                        mapImageUrl={mapImageUrl}
                        selectedEvent={selectedEvent}
                        eventMapState={eventMapState}
                        mapTransform={mapTransform}
                      />
                    </aside>
                  </div>
                </article>
              )}

              <MatchMomentumPanel
                momentum={momentumAnalysis}
                advancedMomentum={advancedMomentumAnalysis}
                match={currentMatch}
                selectedPlayer={playerInfo}
                teamAId={teamAId}
                selectedTeamId={playerTeam}
                opponentTeamId={opponentTeamId}
                agentById={agentById}
                agentNameMap={agentNameMap}
                mode="explorer"
                selectedRoundNumber={(selectedRound?.roundNum ?? 0) + 1}
              />
            </section>
            )}

            {activeSection === "duels" && (
              <section
                className="match-duels-section"
                role="region"
                aria-label={activeSectionLabel}
              >
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">Matriz de duelos</h3>
                    <p className="panel-subtitle">
                      Balance directo entre jugadores de Team A y Team B.
                    </p>
                  </div>
                </div>

                <div className="match-duel-highlights">
                  {renderDuelHighlight("Rivalidad del seleccionado", duelHighlights.top, "top")}
                  {renderDuelHighlight("Ventaja seleccionado", duelHighlights.teamA, "team-a")}
                  {renderDuelHighlight("Ventaja rival", duelHighlights.teamB, "team-b")}
                </div>
                {[duelHighlights.top, duelHighlights.teamA, duelHighlights.teamB]
                  .find((cell) => cell?.key === selectedDuelKey) &&
                  renderDuelInlineDetail(
                    [duelHighlights.top, duelHighlights.teamA, duelHighlights.teamB].find(
                      (cell) => cell?.key === selectedDuelKey,
                    )!,
                  )}

                <div className="match-duel-summary-grid">
                  <article>
                    <span>Kills seleccionado</span>
                    <strong>{duelSummary.selectedKills}</strong>
                  </article>
                  <article>
                    <span>Kills rivales</span>
                    <strong>{duelSummary.rivalKills}</strong>
                  </article>
                  <article>
                    <span>Duelos ganados</span>
                    <strong>{duelSummary.selectedWon}</strong>
                  </article>
                  <article>
                    <span>Duelos perdidos</span>
                    <strong>{duelSummary.rivalWon}</strong>
                  </article>
                  <article>
                    <span>Empates</span>
                    <strong>{duelSummary.ties}</strong>
                  </article>
                </div>

                <div className="match-duel-toolbar">
                  <div className="match-round-legend" aria-label="Leyenda de duelos">
                    <span className="match-round-legend-item">
                      <i className="match-round-legend-dot is-win" /> Gana Team A
                    </span>
                    <span className="match-round-legend-item">
                      <i className="match-round-legend-dot is-loss" /> Gana Team B
                    </span>
                    <span className="match-round-legend-item">
                      <b className="match-round-legend-symbol is-key">=</b> Empate
                    </span>
                    <span className="match-round-legend-item">
                      <b className="match-round-legend-symbol">—</b> Sin duelos
                    </span>
                    <span className="match-round-legend-item">
                      <b className="match-round-legend-symbol">Icono</b>
                      El icono indica qué agente hizo esas kills
                    </span>
                  </div>
                </div>

                <section className="match-duel-matrix-panel">
                    <div className="match-duel-matrix-scroll">
                      <div
                        className="match-duel-matrix"
                        style={{
                          gridTemplateColumns: `minmax(92px, 0.85fr) repeat(${Math.max(
                            visibleDuelTeamBPlayers.length,
                            1,
                          )}, minmax(0, 1fr))`,
                        }}
                      >
                        <div className="match-duel-matrix-corner">Team A \ Team B</div>
                        {visibleDuelTeamBPlayers.map((player) => (
                          <button
                            key={`duel-col-${cleanId(player.puuid)}`}
                            type="button"
                            className="match-duel-column-header"
                            onClick={() => handlePlayerSelect(cleanId(player.puuid))}
                          >
                            {renderDuelPlayer(player)}
                          </button>
                        ))}

                        {visibleDuelTeamAPlayers.map((teamAPlayer) => {
                          const teamAId = cleanId(teamAPlayer.puuid);
                          return (
                            <Fragment key={`duel-row-${teamAId}`}>
                              <button
                                type="button"
                                className="match-duel-row-header"
                                onClick={() => handlePlayerSelect(teamAId)}
                              >
                                {renderDuelPlayer(teamAPlayer)}
                              </button>
                              {visibleDuelTeamBPlayers.map((teamBPlayer) => {
                                const key = `${teamAId}:${cleanId(teamBPlayer.puuid)}`;
                                const cell = duelCellByKey.get(key);
                                const leader = cell?.leader ?? "tie";
                                return (
                                  <div
                                    key={key}
                                    className={`match-duel-cell ${
                                      !cell || cell.total === 0
                                        ? "is-empty"
                                        : leader === "teamA"
                                          ? "is-team-a"
                                          : leader === "teamB"
                                          ? "is-team-b"
                                            : "is-tie"
                                    }`}
                                    title={
                                      cell
                                        ? `${getPlayerShortDisplay(cell.teamAPlayer)} (${getAgentMeta(cell.teamAPlayer, agentById, agentNameMap).name}) ${cell.teamAKillsOnB} - ${cell.teamBKillsOnA} ${getPlayerShortDisplay(cell.teamBPlayer)} (${getAgentMeta(cell.teamBPlayer, agentById, agentNameMap).name})`
                                        : "Sin duelos"
                                    }
                                  >
                                    {cell && cell.total > 0 ? (
                                      <span className="match-duel-score-pill match-duel-score-pill--with-icons">
                                        <span className="match-duel-score-side match-duel-score-side--team-a">
                                          {renderDuelAgentIcon(cell.teamAPlayer)}
                                          <strong>{cell.teamAKillsOnB}</strong>
                                        </span>
                                        <span className="match-duel-score-separator">-</span>
                                        <span className="match-duel-score-side match-duel-score-side--team-b">
                                          <strong>{cell.teamBKillsOnA}</strong>
                                          {renderDuelAgentIcon(cell.teamBPlayer)}
                                        </span>
                                      </span>
                                    ) : (
                                      <span className="match-duel-empty">—</span>
                                    )}
                                  </div>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                </section>
              </section>
            )}
            {activeSection === "classification" && (
            <section
              className="match-classification-section"
              role="region"
              aria-label={activeSectionLabel}
            >
            <div className="match-scoreboard-panel">
              <div className="panel-header match-scoreboard-panel-header">
                <div>
                  <h3 className="panel-title">Scoreboard</h3>
                  <p className="panel-subtitle">
                    Cambia la perspectiva pulsando cualquier jugador.
                  </p>
                </div>

                <div className="match-scoreboard-controls">
                <div
                  className="match-scoreboard-mode-toggle"
                  aria-label="Modo de visualización del scoreboard"
                >
                  <button
                    type="button"
                    className={teamScoreboardMode === "grouped" ? "is-active" : ""}
                    onClick={() => setTeamScoreboardMode("grouped")}
                    aria-pressed={teamScoreboardMode === "grouped"}
                  >
                    Separado por equipos
                  </button>
                  <button
                    type="button"
                    className={teamScoreboardMode === "combined" ? "is-active" : ""}
                    onClick={() => setTeamScoreboardMode("combined")}
                    aria-pressed={teamScoreboardMode === "combined"}
                  >
                    Vista global
                  </button>
                </div>
                <div
                  className="match-scoreboard-side-toggle"
                  aria-label="Filtro de lado del scoreboard"
                >
                  {[
                    ["all", "Ambos"],
                    ["attack", "Ataque"],
                    ["defense", "Defensa"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={scoreboardSideFilter === key ? "is-active" : ""}
                      onClick={() => setScoreboardSideFilter(key as ScoreboardSideFilter)}
                      aria-pressed={scoreboardSideFilter === key}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                </div>
              </div>

              <div className="match-scoreboard-teams">
                {teamScoreboardMode === "grouped" ? (
                  teamScoreboardGroups.map((group) => (
                    <div
                      key={`scoreboard-${group.teamId}`}
                      className={`match-scoreboard-team-block is-${group.tone}`}
                    >
                      <div
                        className={`match-scoreboard-team-header is-${group.tone}`}
                      >
                        <strong>{group.teamLabel}</strong>
                        <span>Avg. Rank</span>
                        <span
                          className="match-scoreboard-rank-summary"
                          title={group.averageRank.name}
                        >
                          {group.averageRank.icon ? (
                            <img
                              src={group.averageRank.icon}
                              alt={group.averageRank.name}
                              onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                            />
                          ) : null}
                          {group.averageRank.name}
                        </span>
                      </div>
                      {renderScoreboardTable(group.rows)}
                    </div>
                  ))
                ) : (
                  <div className="match-scoreboard-team-block is-combined">
                    <div className="match-scoreboard-combined-summary">
                      {teamScoreboardGroups.map((group) => (
                        <span key={`combined-rank-${group.teamId}`}>
                          <strong>{group.teamLabel} Avg. Rank:</strong>{" "}
                          {group.averageRank.icon ? (
                            <img
                              src={group.averageRank.icon}
                              alt={group.averageRank.name}
                              onError={(event) => applyUnrankedRankIconFallback(event.currentTarget)}
                            />
                          ) : null}
                          {group.averageRank.name}
                        </span>
                      ))}
                    </div>
                    {renderScoreboardTable(combinedScoreboardRows, {
                      showTeamBadge: true,
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="match-side-comparison-zone">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Ataque vs Defensa</h3>
                  <p className="panel-subtitle">
                    Ataque y defensa derivados por orden real de rondas.
                  </p>
                </div>
              </div>

              <div className="match-side-cards">
                {matchAnalysis.sideSummary.map((side) => (
                  <article key={side.key} className="match-side-card">
                    <header>
                      <h4>{side.label}</h4>
                      <strong>{formatPercent(side.winRate, 1)}</strong>
                    </header>

                    <div className="match-side-grid">
                      <span>Rondas ganadas / jugadas</span>
                      <strong>
                        {side.wins}/{side.rounds}
                      </strong>

                      <span>K / D / A</span>
                      <strong>
                        {side.kills}/{side.deaths}/{side.assists}
                      </strong>

                      <span>KD</span>
                      <strong>{formatNumber(side.kd, 2)}</strong>

                      <span>KPR</span>
                      <strong>{formatNumber(side.killsPerRound, 2)}</strong>

                      <span>ACS</span>
                      <strong>
                        {formatNumber(safeDivide(side.score, Math.max(side.rounds, 1)))}
                      </strong>

                      <span>ADR aprox.</span>
                      <strong>
                        {formatNumber(
                          safeDivide(
                            matchAnalysis.rounds
                              .filter((round) => round.side === side.key)
                              .reduce((sum, round) => sum + round.playerDamage, 0),
                            Math.max(side.rounds, 1),
                          ),
                          1,
                        )}
                      </strong>

                      <span>Score total</span>
                      <strong>{formatNumber(side.score)}</strong>

                      <span>Gasto medio</span>
                      <strong>{formatNumber(side.avgSpent)}</strong>
                    </div>
                  </article>
                ))}
              </div>

            </div>

            <MatchLoadoutTimeline
              data={roundTeamLoadoutTimeline}
              teamALabel={teamScoreboardGroups[0]?.teamLabel ?? "Team A"}
              teamBLabel={teamScoreboardGroups[1]?.teamLabel ?? "Team B"}
            />

            </section>
            )}

            {activeSection === "economy" && (
            economyMlLoading || economyMlFetching ? (
              <LoadingModal placement="section" />
            ) : (
            <section
              className="match-economy-panel"
              role="region"
              aria-label={activeSectionLabel}
            >
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Economía</h3>
                  <p className="panel-subtitle">
                    Gasto y valor de equipamiento del jugador seleccionado.
                  </p>
                </div>
              </div>

              <div className="match-economy-cards">
                <div>
                  <span>Tu gasto total</span>
                  <strong>{formatNumber(matchAnalysis.totalSpent)}</strong>
                </div>
                <div>
                  <span>Tu gasto medio/ronda</span>
                  <strong>{formatNumber(matchAnalysis.avgSpent)}</strong>
                </div>
                <div>
                  <span>Tu equipamiento medio por ronda</span>
                  <strong>{formatNumber(matchAnalysis.avgLoadout)}</strong>
                </div>
              </div>

              <div className="match-team-economy-grid">
                {teamEconomySummaries.map((team) => (
                  <article key={team.key} className="match-team-economy-card">
                    <header>
                      <h4>{team.label}</h4>
                      <span className="match-team-economy-header-metric">
                        Loadout medio <strong>{formatNumber(team.avgLoadout)}</strong>
                      </span>
                    </header>
                    <div>
                      <span>Loadout total</span>
                      <strong>{formatNumber(team.totalLoadout)}</strong>
                    </div>
                    <div>
                      <span>Gasto total</span>
                      <strong>{formatNumber(team.totalSpent)}</strong>
                    </div>
                    <div className="match-team-economy-buy-row">
                      {(["eco", "semiEco", "fullBuy"] as const).map((key) => (
                        <span key={`${team.key}-${key}`}>
                          {economyBuyLabels[key]} {team.buyTypes[key].wins}/{team.buyTypes[key].rounds}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              <div className="match-economy-chart-grid">
                <article className="match-economy-chart-card">
                  <header>
                    <h4>Distribución por compra</h4>
                    <span>Comparativa por equipo</span>
                  </header>
                  <div className="match-economy-chart">
                    <ResponsiveContainer width="100%" height={190}>
                      <BarChart data={teamEconomyDistributionData}>
                        <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                        <XAxis dataKey="name" stroke="#9ea8b8" tickLine={false} axisLine={false} />
                        <YAxis stroke="#9ea8b8" tickLine={false} axisLine={false} allowDecimals={false} />
                        <ReTooltip
                          cursor={{ fill: "rgba(255,255,255,0.05)" }}
                          contentStyle={{
                            background: "#11151c",
                            border: "1px solid rgba(255,70,85,0.35)",
                            borderRadius: 10,
                            color: "#f4f7fb",
                          }}
                        />
                        <Bar
                          dataKey="teamA"
                          name={teamEconomySummaries[0]?.label ?? "Team A"}
                          fill={selectedTeamKey === "teamA" ? "#46c878" : "#ff4655"}
                          radius={[8, 8, 3, 3]}
                        />
                        <Bar
                          dataKey="teamB"
                          name={teamEconomySummaries[1]?.label ?? "Team B"}
                          fill={selectedTeamKey === "teamB" ? "#46c878" : "#ff4655"}
                          radius={[8, 8, 3, 3]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </article>

                <article className="match-economy-chart-card">
                  <header>
                    <h4>Rendimiento por compra</h4>
                    <span>Winrate y ACS exacto por tipo de compra</span>
                  </header>
                  <div className="match-economy-performance-list">
                    {economyChartData.map((entry) => (
                      <div key={`economy-performance-${entry.key}`} className="match-economy-performance-row">
                        <span className="match-economy-performance-name">
                          {entry.name}
                        </span>
                        <div className="match-economy-performance-bar">
                          <i
                            style={{
                              width: `${Math.max(4, Math.min(100, entry.winRate))}%`,
                              background: entry.color,
                            }}
                          />
                        </div>
                        <div className="match-economy-performance-metrics">
                          <span>
                            <small>Ganadas</small>
                            <strong>
                              {entry.wins}/{entry.rounds}
                            </strong>
                          </span>
                          <span>
                            <small>Winrate</small>
                            <strong>{formatPercent(entry.winRate, 1)}</strong>
                          </span>
                          <span>
                            <small>ACS</small>
                            <strong>{formatNumber(entry.acs)}</strong>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="match-economy-chart-card match-economy-chart-card--wide">
                  <header>
                    <h4>Evolución económica</h4>
                    <span>Loadout de ambos equipos ronda a ronda</span>
                  </header>
                  <div className="match-economy-chart">
                    <ResponsiveContainer width="100%" height={230}>
                      <LineChart data={teamEconomyTimelineData}>
                        <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                        <XAxis dataKey="round" stroke="#9ea8b8" tickLine={false} axisLine={false} />
                        <YAxis stroke="#9ea8b8" tickLine={false} axisLine={false} />
                        <ReTooltip
                          contentStyle={{
                            background: "#11151c",
                            border: "1px solid rgba(255,70,85,0.35)",
                            borderRadius: 10,
                            color: "#f4f7fb",
                          }}
                          labelFormatter={(label) => `Ronda ${label}`}
                        />
                        <Line
                          type="monotone"
                          dataKey="teamA"
                          name={teamEconomySummaries[0]?.label ?? "Team A"}
                          stroke={selectedTeamKey === "teamA" ? "#46c878" : "#ff4655"}
                          strokeWidth={selectedTeamKey === "teamA" ? 3 : 2}
                          dot={{ r: selectedTeamKey === "teamA" ? 3 : 2 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="teamB"
                          name={teamEconomySummaries[1]?.label ?? "Team B"}
                          stroke={selectedTeamKey === "teamB" ? "#46c878" : "#ff4655"}
                          strokeWidth={selectedTeamKey === "teamB" ? 3 : 2}
                          dot={{ r: selectedTeamKey === "teamB" ? 3 : 2 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </article>
              </div>

              <EconomyOptimalPanel
                ml={economyMlData}
                analysis={economyEfficiencyAnalysis}
                momentum={momentumAnalysis}
                teamAId={teamAId}
                teamBId={teamBId}
                teamALabel={teamALabel}
                teamBLabel={teamBLabel}
                selectedTeamKey={selectedTeamKey}
                agents={agents}
              />
            </section>
            )
            )}
            </div>

          </div>
      </div>
      {playbackOpen && createPortal(
        <div
          className="match-playback-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={playbackTitle}
          onClick={closePlayback}
        >
          <div
            className="match-playback-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="match-playback-header">
              <div>
                <span className="stats-eyebrow">{playbackTitle}</span>
              </div>
              <button type="button" className="content-detail-close modal-close" aria-label="Cerrar reproducción" onClick={closePlayback}>
                <X aria-hidden="true" />
              </button>
            </header>

            <div className="match-playback-body">
              <aside className="match-playback-actions">
                <div className="match-playback-progress">
                  {playbackProgressLabel}
                </div>
                <div
                  ref={playbackActionListRef}
                  className="match-playback-action-list"
                >
                  {playbackMode === "match"
                    ? playbackRounds.map(([roundNum, entries]) => {
                        const highlights = getPlaybackRoundHighlights(
                          roundNum,
                          entries,
                        );
                        const isOpen = roundNum === activePlaybackRoundNum;
                        return (
                          <section
                            key={`playback-round-${roundNum}`}
                            className={`match-playback-round-group ${
                              isOpen ? "is-open" : ""
                            }`}
                          >
                            <button
                              type="button"
                              className="match-playback-round-toggle"
                              onClick={() => setPlaybackIndex(entries[0].index)}
                              aria-expanded={isOpen}
                            >
                              <span>
                                <strong>{roundLabel(roundNum)}</strong>
                                {highlights.length > 0 ? (
                                  <small>{highlights.join(" · ")}</small>
                                ) : null}
                              </span>
                              <small>{entries.length} acciones</small>
                            </button>
                            {isOpen ? (
                              <div className="match-playback-round-events">
                                {entries.map(({ event }) =>
                                  renderPlaybackEventButton(event),
                                )}
                              </div>
                            ) : null}
                          </section>
                        );
                      })
                    : playbackEvents.map(renderPlaybackEventButton)}
                </div>
              </aside>

              <div className="match-playback-map">
                <MatchEventMapCanvas
                  mapName={mapName}
                  mapImageUrl={mapImageUrl}
                  selectedEvent={playbackEvent}
                  eventMapState={playbackMapState}
                  mapTransform={mapTransform}
                  compact
                />
              </div>

              <div className="match-playback-controls">
                <button
                  type="button"
                  onClick={restartPlayback}
                  aria-label="Reiniciar"
                  title="Reiniciar"
                >
                  <RotateCcw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={previousPlaybackEvent}
                  disabled={playbackIndex === 0}
                  aria-label="Anterior"
                  title="Anterior"
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setPlaybackPlaying((playing) => !playing)}
                  disabled={playbackEvents.length <= 1}
                  aria-label={playbackPlaying ? "Pausar" : "Reanudar"}
                  title={playbackPlaying ? "Pausar" : "Reanudar"}
                >
                  {playbackPlaying ? (
                    <Pause aria-hidden="true" />
                  ) : (
                    <Play aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={nextPlaybackEvent}
                  disabled={playbackIndex >= playbackEvents.length - 1}
                  aria-label="Siguiente acción"
                  title="Siguiente acción"
                >
                  <StepForward aria-hidden="true" />
                </button>
                {playbackMode === "match" ? (
                  <button
                    type="button"
                    onClick={nextPlaybackRound}
                    disabled={nextPlaybackRoundIndex < 0}
                    aria-label="Siguiente ronda"
                    title="Siguiente ronda"
                  >
                    <SkipForward aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}

