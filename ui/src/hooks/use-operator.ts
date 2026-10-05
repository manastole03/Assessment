import { useQuery } from "@tanstack/react-query";

import { api, operatorUrl, type OperatorState } from "@/lib/api";

/**
 * The lease a human holds on a live session: who (the signed-in user's email, set by the server)
 * and the fencing epoch it issued. Only the epoch travels back; identity comes from the session.
 */
export interface Lease {
  operator: string;
  epoch: number;
}

export async function sendInput(runId: string, lease: Lease, command: Record<string, unknown>) {
  await api(operatorUrl(runId, "input"), { method: "POST", json: { epoch: lease.epoch, ...command } });
}

export function useOperatorState(runId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["operator", runId],
    queryFn: () => api<OperatorState>(operatorUrl(runId, "state")),
    refetchInterval: 1000,
    retry: false,
    enabled,
  });
}
