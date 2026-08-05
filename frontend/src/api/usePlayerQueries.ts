import { useQuery } from "@tanstack/react-query";
import {
  getPlayerDashboard,
  getPlayerRankComparison,
  getMatchById,
  getMatchEconomyMl,
  searchPlayers,
  type DashboardFilters,
  type RankComparisonFilters,
} from "./playerApi";

// Keep dashboard data fairly fresh so analytics rebuilds show quickly in UI.
const DASHBOARD_STALE = 1000 * 30; // 30 s
// Match detail is immutable once played
const MATCH_STALE = Infinity;
// Search results are short-lived
const SEARCH_STALE = 1000 * 30; // 30 s

export function usePlayerDashboard(
  playerId: string | undefined,
  filters?: DashboardFilters,
) {
  return useQuery({
    queryKey: ["player", "dashboard", playerId, filters],
    queryFn: () => getPlayerDashboard(playerId!, filters),
    enabled: !!playerId,
    staleTime: DASHBOARD_STALE,
  });
}

export function usePlayerRankComparison(
  playerId: string | undefined,
  filters?: RankComparisonFilters,
  enabled = true,
) {
  return useQuery({
    queryKey: ["player", "rank-comparison", playerId, filters],
    queryFn: () => getPlayerRankComparison(playerId!, filters),
    enabled: !!playerId && enabled,
    staleTime: DASHBOARD_STALE,
  });
}

export function useSearchPlayers(
  gameName: string,
  tagLine: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["players", "search", gameName, tagLine],
    queryFn: () => searchPlayers(gameName, tagLine),
    enabled,
    staleTime: SEARCH_STALE,
  });
}

export function useMatchById(matchId: string | null) {
  return useQuery({
    queryKey: ["match", matchId],
    queryFn: () => getMatchById(matchId!),
    enabled: !!matchId,
    staleTime: MATCH_STALE,
  });
}

export function useMatchEconomyMl(
  matchId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["match", matchId, "economy-ml"],
    queryFn: () => getMatchEconomyMl(matchId!),
    enabled: !!matchId && enabled,
    staleTime: DASHBOARD_STALE,
    retry: false,
  });
}
