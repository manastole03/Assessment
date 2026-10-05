import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/auth-context";
import { api, type Status } from "@/lib/api";

/** The environment (engine, model, tenants). Only polled with a session: it is not public. */
export function useStatus() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api<Status>("/status"),
    refetchInterval: 15_000,
    enabled: status === "authenticated",
  });
}
