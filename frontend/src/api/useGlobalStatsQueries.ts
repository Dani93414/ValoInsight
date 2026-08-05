import { useQuery } from "@tanstack/react-query";
import type { GlobalAgentStatsFilters, GlobalMapStatsFilters } from "../types/globalStats";
import {
  getGlobalAgentStats,
  getGlobalMapStats,
  getRegionOptions,
  getRegionSummaries,
  getRegionWeaponStats,
  getRegions,
} from "./globalStats";

const GLOBAL_STATS_STALE = 1000 * 60 * 10;

export function useRegions() {
  return useQuery({
    queryKey: ["global-stats", "regions"],
    queryFn: getRegions,
    staleTime: GLOBAL_STATS_STALE,
  });
}

export function useRegionOptions() {
  return useQuery({
    queryKey: ["global-stats", "region-options"],
    queryFn: getRegionOptions,
    staleTime: GLOBAL_STATS_STALE,
  });
}

export function useRegionSummaries() {
  return useQuery({
    queryKey: ["global-stats", "region-summaries"],
    queryFn: getRegionSummaries,
    staleTime: GLOBAL_STATS_STALE,
  });
}

export function useRegionWeaponStats() {
  return useQuery({
    queryKey: ["global-stats", "region-weapon-stats"],
    queryFn: getRegionWeaponStats,
    staleTime: GLOBAL_STATS_STALE,
  });
}

export function useGlobalAgentStats(filters: GlobalAgentStatsFilters, enabled = true) {
  return useQuery({
    queryKey: [
      "global-stats",
      "agent-stats",
      filters.region ?? "",
      filters.rank ?? "all",
      filters.map ?? "all",
      filters.act ?? "all",
    ],
    queryFn: () => getGlobalAgentStats(filters),
    enabled,
    placeholderData: (previousData) => previousData,
    staleTime: 1000 * 60 * 10,
  });
}

export function useGlobalMapStats(filters: GlobalMapStatsFilters, enabled = true) {
  return useQuery({
    queryKey: [
      "global-stats",
      "map-stats",
      filters.region ?? "",
      filters.rank ?? "all",
      filters.map ?? "all",
      filters.act ?? "all",
      filters.agent ?? "all",
    ],
    queryFn: () => getGlobalMapStats(filters),
    enabled,
    placeholderData: (previousData) => previousData,
    staleTime: GLOBAL_STATS_STALE,
  });
}
