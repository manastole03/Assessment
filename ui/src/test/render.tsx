import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";

import { AuthContext, type AuthApi } from "@/features/auth/auth-context";
import { hasRole, type Identity, type Role } from "@/lib/api";

export function identity(role: Role = "OPERATOR"): Identity {
  return {
    user: {
      id: "u-1",
      email: "dana@example.com",
      name: "Dana Ops",
      role,
      status: "ACTIVE",
      lastLoginAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    effectiveRole: role,
    authMethod: "session",
  };
}

/** An auth context with no network behind it: tests choose who is signed in. */
export function fakeAuth(who: Identity | null): AuthApi {
  return {
    status: who ? "authenticated" : "anonymous",
    identity: who,
    user: who?.user ?? null,
    role: who?.effectiveRole,
    can: (required) => hasRole(who?.effectiveRole, required),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
  };
}

/** Render with the app's providers; `who: null` renders signed out. */
export function renderWithProviders(
  ui: ReactElement,
  { who = identity(), route = "/" }: { who?: Identity | null; route?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={fakeAuth(who)}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

/** A success envelope, as the control plane answers. */
export function ok(data: unknown, init?: ResponseInit): Response {
  const meta = Array.isArray(data) ? { page: 1, limit: 100, total: data.length, totalPages: 1 } : undefined;
  return Response.json({ success: true, data, ...(meta ? { meta } : {}), message: "Request successful" }, init);
}

/** A page envelope with an explicit total (counts are read from meta.total). */
export function page(data: unknown[], total = data.length): Response {
  return Response.json({ success: true, data, meta: { page: 1, limit: data.length || 1, total, totalPages: total ? 1 : 0 } });
}

/** An error envelope. */
export function fail(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(
    { success: false, message, error: { code, ...(details === undefined ? {} : { details }) }, path: "/", timestamp: "" },
    { status },
  );
}

/** The path part of a fetched URL (tests route on it; query strings vary). */
export const pathOf = (url: string) => url.split("?")[0] ?? url;
