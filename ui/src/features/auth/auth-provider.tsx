import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";

import {
  api,
  ApiError,
  type AuthSession,
  hasRole,
  type Identity,
  refreshSession,
  type Role,
  setSessionLostHandler,
} from "@/lib/api";

import { AuthContext, type AuthApi } from "./auth-context";

const IDENTITY = ["identity"] as const;
/** Rotate the session this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;

async function fetchIdentity(): Promise<Identity | null> {
  try {
    return await api<Identity>("/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The access cookie may just have expired: one refresh before declaring the user signed out.
      if (await refreshSession()) return api<Identity>("/auth/me");
      return null;
    }
    throw error;
  }
}

/**
 * The browser session. Credentials live in httpOnly cookies the UI never sees; this provider only
 * knows who is signed in (GET /auth/me), keeps the session fresh before the access token lapses
 * (so EventSource streams and evidence images keep working), and signs out when it cannot.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const identity = useQuery({ queryKey: IDENTITY, queryFn: fetchIdentity, retry: false, staleTime: 5 * 60_000 });

  const signedOut = useCallback(() => {
    queryClient.setQueryData(IDENTITY, null);
    // Drop everything fetched as the previous user.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== IDENTITY[0] });
  }, [queryClient]);

  useEffect(() => {
    setSessionLostHandler(signedOut);
    return () => setSessionLostHandler(null);
  }, [signedOut]);

  const startSession = useCallback(
    async (session: AuthSession) => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== IDENTITY[0] });
      queryClient.setQueryData(IDENTITY, await fetchIdentity());
      scheduleRefresh(session.accessTokenExpiresAt);
      return session;
    },
    [queryClient],
  );

  // Keep the access cookie fresh while the tab is open.
  useEffect(() => {
    if (!identity.data) return;
    const id = window.setInterval(() => void refreshSession(), 10 * 60_000);
    return () => window.clearInterval(id);
  }, [identity.data]);

  const value = useMemo<AuthApi>(() => {
    const data = identity.data ?? null;
    const role: Role | undefined = data?.effectiveRole;
    return {
      status: identity.isPending ? "loading" : data ? "authenticated" : "anonymous",
      identity: data,
      user: data?.user ?? null,
      role,
      can: (required: Role) => hasRole(role, required),
      login: async (email, password) =>
        startSession(await api<AuthSession>("/auth/login", { method: "POST", json: { email, password } })),
      register: async (email, name, password) =>
        startSession(await api<AuthSession>("/auth/register", { method: "POST", json: { email, name, password } })),
      logout: async () => {
        try {
          await api("/auth/logout", { method: "POST" });
        } finally {
          signedOut();
        }
      },
    };
  }, [identity.data, identity.isPending, signedOut, startSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

let refreshTimer: number | undefined;

/** One refresh shortly before the new access token expires (the interval above is the backstop). */
function scheduleRefresh(expiresAt: string) {
  window.clearTimeout(refreshTimer);
  const delay = new Date(expiresAt).getTime() - Date.now() - REFRESH_EARLY_MS;
  if (Number.isFinite(delay) && delay > 0) refreshTimer = window.setTimeout(() => void refreshSession(), delay);
}
