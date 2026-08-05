import type { HeaderAgentImageAdjustment } from "../types/dashboard";

export const ACT_FILTER_ALL = "__all_acts__";
export const ACT_FILTER_CURRENT = "__current_act__";
export const AGENT_FILTER_ALL = "__all_agents__";
export const MAP_FILTER_ALL = "__all_maps__";
export const QUEUE_FILTER_ALL = "__all_queues__";
export const QUEUE_FILTER_COMPETITIVE = "competitive";

export const INFO_ICON_TRIGGER_SELECTOR =
  ".metric-info-button, .tactical-info-trigger, .tactical-info-icon";

export const SHOT_CHART_COLORS = {
  headshots: "#dbb156",
  bodyshots: "#d07174",
  legshots: "#637b91",
} as const;

export const QUEUE_LABELS: Record<string, string> = {
  competitive: "Competitivo",
  unrated: "No competitivo",
  deathmatch: "Combate a muerte",
  spikerush: "Spike Rush",
  escalation: "Escalada",
  replication: "Replicación",
  snowball: "Bola de nieve",
  swiftplay: "Partida rápida",
  newmap: "Nuevo mapa",
  "": "Desconocido",
};

export const PARTY_SIZE_MAP: Record<string, number[]> = {
  solo: [1],
  duo: [2],
  trio: [3],
  team: [4, 5],
};

export function getPerformanceColor(percent: number): string {
  if (percent <= 25) return "#ff4655";
  if (percent <= 40) return "#ff8c42";
  if (percent <= 55) return "#ffd166";
  if (percent <= 70) return "#7ec880";
  return "#46c878";
}

export const DEFAULT_HEADER_AGENT_IMAGE_ADJUSTMENT: HeaderAgentImageAdjustment =
  {
    objX: 50,
    scale: 1.4,
    shiftY: 0,
    fadeStart: 72,
    fadeMid: 80,
    fadeEnd: 88,
  };

// Adjustments for the top "Agente mas jugado" image.
// All position values are in % — no px. Much easier to maintain.
//   objX         → horizontal focus (object-position X)
//   scale        → zoom level (1 = cover-fill, >1 = zoom in)
//   shiftY       → vertical shift after scaling (negative = up)
//   fadeStart/Mid/End → bottom fade gradient
//   flip         → mirror horizontally
export const HEADER_AGENT_IMAGE_ADJUSTMENTS_BY_DISPLAY_NAME: Record<
  string,
  Partial<HeaderAgentImageAdjustment>
> = {
  jett: {
    objX: 70,
    scale: 1.35,
    shiftY: -17,
    fadeStart: 68,
    fadeMid: 83,
    fadeEnd: 91,
  },
  sova: {
    objX: 82,
    scale: 1.34,
    shiftY: -18,
    fadeStart: 72,
    fadeMid: 80,
    fadeEnd: 88,
  },
  waylay: {
    objX: 79,
    scale: 1.35,
    shiftY: -16,
    fadeStart: 79,
    fadeMid: 83,
    fadeEnd: 88,
  },
  sage: {
    objX: 79,
    scale: 1.35,
    shiftY: -18,
    fadeStart: 73,
    fadeMid: 83,
    fadeEnd: 90,
  },
  killjoy: {
    objX: 81,
    scale: 1.35,
    shiftY: -19,
    fadeStart: 82,
    fadeMid: 85,
    fadeEnd: 90,
  },
  gekko: {
    objX: 79,
    scale: 1.35,
    shiftY: -19,
    fadeStart: 81,
    fadeMid: 88,
    fadeEnd: 91,
    flip: true,
  },
  reyna: {
    objX: 78,
    scale: 1.35,
    shiftY: -16,
    fadeStart: 78,
    fadeMid: 86,
    fadeEnd: 88,
    flip: true,
  },
    miks: {
    objX: 77,
    scale: 1.26,
    shiftY: -8,
    fadeStart: 82,
    fadeMid: 84,
    fadeEnd: 88,
    flip: false,
  },
  raze: {
    objX: 79,
    scale: 1.35,
    shiftY: -13,
    fadeStart: 64,
    fadeMid: 72,
    fadeEnd: 88,
  },
  "kay/o": {
    objX: 79,
    scale: 1.3,
    shiftY: -11,
    fadeStart: 81,
    fadeMid: 82,
    fadeEnd: 87,
  },
  tejo: {
    objX: 78,
    scale: 1.3,
    shiftY: -16,
    fadeStart: 83,
    fadeMid: 86,
    fadeEnd: 92,
  },
  veto: {
    objX: 75,
    scale: 1.3,
    shiftY: -12,
    fadeStart: 78,
    fadeMid: 82,
    fadeEnd: 86,
  },
  deadlock: {
    objX: 79,
    scale: 1.3,
    shiftY: -17,
    fadeStart: 85,
    fadeMid: 89,
    fadeEnd: 93,
  },
  vyse: {
    objX: 84,
    scale: 1.35,
    shiftY: -10,
    fadeStart: 76,
    fadeMid: 80,
    fadeEnd: 83,
  },
  cypher: {
    objX: 76,
    scale: 1.3,
    shiftY: -17,
    fadeStart: 85,
    fadeMid: 88,
    fadeEnd: 90,
  },
  phoenix: {
    objX: 77,
    scale: 1.35,
    shiftY: -19,
    fadeStart: 86,
    fadeMid: 88,
    fadeEnd: 90,
  },
  harbor: {
    objX: 79,
    scale: 1.35,
    shiftY: -17,
    fadeStart: 82,
    fadeMid: 87,
    fadeEnd: 91,
  },
  skye: {
    objX: 77,
    scale: 1.35,
    shiftY: -19,
    fadeStart: 83,
    fadeMid: 87,
    fadeEnd: 90,
    flip: true,
  },
  fade: {
    objX: 78,
    scale: 1.3,
    shiftY: -14,
    fadeStart: 83,
    fadeMid: 87,
    fadeEnd: 90,
  },
  brimstone: {
    objX: 76,
    scale: 1.35,
    shiftY: -13,
    fadeStart: 78,
    fadeMid: 81,
    fadeEnd: 85,
  },
  astra: {
    objX: 88,
    scale: 1.3,
    shiftY: -12,
    fadeStart: 78,
    fadeMid: 82,
    fadeEnd: 87,
  },
  chamber: {
    objX: 77,
    scale: 1.35,
    shiftY: -20,
    fadeStart: 81,
    fadeMid: 83,
    fadeEnd: 90,
  },
  yoru: {
    objX: 76,
    scale: 1.35,
    shiftY: -19,
    fadeStart: 80,
    fadeMid: 87,
    fadeEnd: 91,
    flip: true,
  },
  neon: {
    objX: 79,
    scale: 1.35,
    shiftY: -14,
    fadeStart: 78,
    fadeMid: 80,
    fadeEnd: 86,
  },
  viper: {
    objX: 73,
    scale: 1.35,
    shiftY: -21,
    fadeStart: 80,
    fadeMid: 86,
    fadeEnd: 91,
  },
  iso: {
    objX: 84,
    scale: 1.3,
    shiftY: -15,
    fadeStart: 76,
    fadeMid: 81,
    fadeEnd: 87,
  },
  clove: {
    objX: 78,
    scale: 1.35,
    shiftY: -15,
    fadeStart: 74,
    fadeMid: 80,
    fadeEnd: 88,
  },
  breach: {
    objX: 79,
    scale: 1.35,
    shiftY: -18,
    fadeStart: 78,
    fadeMid: 82,
    fadeEnd: 90,
  },
  omen: {
    objX: 79,
    scale: 1.3,
    shiftY: -17,
    fadeStart: 78,
    fadeMid: 85,
    fadeEnd: 92,
  },
};

function normalizeDisplayName(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

export function getHeaderAgentImageAdjustmentByDisplayName(
  displayName?: string | null,
): HeaderAgentImageAdjustment {
  const key = normalizeDisplayName(displayName);
  const c = key
    ? HEADER_AGENT_IMAGE_ADJUSTMENTS_BY_DISPLAY_NAME[key]
    : undefined;
  const d = DEFAULT_HEADER_AGENT_IMAGE_ADJUSTMENT;

  return {
    objX: c?.objX ?? d.objX,
    scale: c?.scale ?? d.scale,
    shiftY: c?.shiftY ?? d.shiftY,
    fadeStart: c?.fadeStart ?? d.fadeStart,
    fadeMid: c?.fadeMid ?? d.fadeMid,
    fadeEnd: c?.fadeEnd ?? d.fadeEnd,
    flip: c?.flip ?? d.flip,
  };
}

export function buildSvgPlaceholder(
  title: string,
  subtitle: string,
  accent = "#ff4655",
) {
  const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const safeSubtitle = subtitle.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#21252d"/>
          <stop offset="100%" stop-color="#11141a"/>
        </linearGradient>
        <radialGradient id="g2" cx="80%" cy="20%" r="60%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="640" height="360" rx="24" fill="url(#g1)"/>
      <rect width="640" height="360" rx="24" fill="url(#g2)"/>
      <rect x="20" y="20" width="600" height="320" rx="18" fill="none" stroke="rgba(255,255,255,0.10)"/>
      <text x="40" y="70" fill="#8d94a1" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">${safeSubtitle}</text>
      <text x="40" y="130" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="900">${safeTitle}</text>
      <circle cx="535" cy="105" r="54" fill="${accent}" opacity="0.14"/>
      <circle cx="535" cy="105" r="34" fill="${accent}" opacity="0.24"/>
      <rect x="40" y="250" width="180" height="12" rx="6" fill="rgba(255,255,255,0.10)"/>
      <rect x="40" y="276" width="260" height="12" rx="6" fill="rgba(255,255,255,0.06)"/>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function getHeaderCardKind(
  subtitle: string,
): "agent" | "map" | "weapon" | "default" {
  const normalized = subtitle.toLowerCase();
  if (normalized.includes("arma")) return "weapon";
  if (normalized.includes("mapa")) return "map";
  if (normalized.includes("agente")) return "agent";
  return "default";
}
