import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/auth-context";
import { apiPage, type RunStatus, type RunSummary } from "@/lib/api";

import { useStatus } from "./use-status";

/** The newest runs (one small page). */
export function useRecentRuns(limit: number, refetchInterval = 5000) {
  return useQuery({
    queryKey: ["runs", "recent", limit],
    queryFn: async () => (await apiPage<RunSummary>(`/runs?limit=${limit}`)).items,
    refetchInterval,
  });
}

/** How many runs have a status (or how many in total): an indexed count on the server, not a download. */
export function useRunCount(status?: RunStatus) {
  const signedIn = useAuth().status === "authenticated";
  return useQuery({
    queryKey: ["runs", "count", status ?? "all"],
    queryFn: async () => (await apiPage<RunSummary>(`/runs?limit=1${status ? `&status=${status}` : ""}`)).meta.total,
    refetchInterval: 10_000,
    enabled: signedIn,
  });
}

/** Whether this deployment offers the bundled mock's demo controls (fault injection, sample members). */
export function useDemoEnabled(): boolean {
  return useStatus().data?.control_plane?.demo_enabled ?? false;
}
