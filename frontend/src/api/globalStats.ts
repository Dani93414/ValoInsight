import { apiUrl } from "./config";
import type {
  GlobalAgentStatsFilters,
  GlobalAgentStatsPayload,
  GlobalMapStatsFilters,
  GlobalMapStatsPayload,
  RegionStats,
} from "../types/globalStats";

export async function getRegions(): Promise<RegionStats[]> {
  const res = await fetch(apiUrl("/regions/"));
  if (!res.ok) throw new Error("Error regiones");
  return res.json();
}

export async function getRegionOptions(): Promise<Array<{ region: string; updatedAt?: string }>> {
  const res = await fetch(apiUrl("/regions/options"));
  if (!res.ok) throw new Error("Error opciones de regiones");
  return res.json();
}

export async function getRegionSummaries(): Promise<RegionStats[]> {
  const res = await fetch(apiUrl("/regions/summaries"));
  if (!res.ok) throw new Error("Error resúmenes regionales");
  return res.json();
}

export async function getRegionWeaponStats(): Promise<RegionStats[]> {
  const res = await fetch(apiUrl("/regions/weapon-stats"));
  if (!res.ok) throw new Error("Error estadísticas regionales de armas");
  return res.json();
}

export async function getGlobalAgentStats(
  filters: GlobalAgentStatsFilters,
): Promise<GlobalAgentStatsPayload> {
  const params = new URLSearchParams();
  if (filters.region) params.set("region", filters.region.toUpperCase());
  if (filters.rank && filters.rank !== "all") params.set("rank", filters.rank);
  if (filters.map && filters.map !== "all") params.set("map", filters.map);
  if (filters.act && filters.act !== "all") params.set("act", filters.act);
  if (filters.role && filters.role !== "all") params.set("role", filters.role);

  const query = params.toString();
  const res = await fetch(apiUrl(`/regions/agent-stats${query ? `?${query}` : ""}`), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Error estadisticas globales de agentes");
  return res.json();
}

export async function getGlobalMapStats(
  filters: GlobalMapStatsFilters,
): Promise<GlobalMapStatsPayload> {
  const params = new URLSearchParams();
  if (filters.region) params.set("region", filters.region.toUpperCase());
  if (filters.rank && filters.rank !== "all") params.set("rank", filters.rank);
  if (filters.map && filters.map !== "all") params.set("map", filters.map);
  if (filters.act && filters.act !== "all") params.set("act", filters.act);
  if (filters.agent && filters.agent !== "all") params.set("agent", filters.agent);

  const query = params.toString();
  const res = await fetch(apiUrl(`/regions/map-stats${query ? `?${query}` : ""}`));
  if (!res.ok) throw new Error("Error estadisticas globales de mapas");
  return res.json();
}
