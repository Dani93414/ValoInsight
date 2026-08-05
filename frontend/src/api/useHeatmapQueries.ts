import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getHeatmapEvents,
  getHeatmapAgentStats,
  getHeatmapFilterOptions,
  type HeatmapFilters,
  type HeatmapAgentStatsFilters,
  type HeatmapFilterOptionsFilters,
  type HeatmapEventsResponse,
} from "./heatmapApi";

const HEATMAP_STALE = 1000 * 60 * 15; // 15 min

export function useHeatmapEvents(
  playerId: string | undefined,
  filters: HeatmapFilters | null,
) {
  return useQuery<HeatmapEventsResponse>({
    queryKey: ["heatmap", playerId, filters],
    queryFn: () => getHeatmapEvents(playerId!, filters!),
    enabled: !!playerId && !!filters?.map_id,
    staleTime: HEATMAP_STALE,
    gcTime: HEATMAP_STALE * 3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useHeatmapAgentStats(
  playerId: string | undefined,
  filters: HeatmapAgentStatsFilters | null,
) {
  return useQuery({
    queryKey: ["heatmap-agent-stats", playerId, filters],
    queryFn: () => getHeatmapAgentStats(playerId!, filters!),
    enabled: !!playerId && !!filters?.map_id,
    staleTime: HEATMAP_STALE,
    gcTime: HEATMAP_STALE * 3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });
}

export function useHeatmapFilterOptions(
  playerId: string | undefined,
  filters?: HeatmapFilterOptionsFilters,
) {
  return useQuery({
    queryKey: ["heatmap-filter-options", playerId, filters],
    queryFn: () => getHeatmapFilterOptions(playerId!, filters),
    enabled: !!playerId && !!filters?.map_id,
    staleTime: HEATMAP_STALE,
    gcTime: HEATMAP_STALE * 3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });
}
