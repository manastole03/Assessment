import { afterEach, describe, expect, it, vi } from "vitest";

import { fail, ok } from "@/test/render";

import { api, apiAll, ApiError, apiPage, hasRole, setSessionLostHandler } from "./api";

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(responses.shift() ?? ok(null)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  setSessionLostHandler(null);
  document.cookie = "rote_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("api client", () => {
  it("prefixes /api/v1 and returns the envelope's data", async () => {
    const fetchMock = stubFetch(ok({ id: "run-1" }));
    expect(await api("/runs/run-1")).toEqual({ id: "run-1" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/runs/run-1");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("returns pages with their meta, and whole small collections", async () => {
    stubFetch(Response.json({ success: true, data: [1, 2], meta: { page: 2, limit: 2, total: 9, totalPages: 5 } }));
    expect(await apiPage("/runs?page=2&limit=2")).toEqual({
      items: [1, 2],
      meta: { page: 2, limit: 2, total: 9, totalPages: 5 },
    });
    const fetchMock = stubFetch(ok([{ id: "a" }]));
    expect(await apiAll("/capabilities?kind=task")).toEqual([{ id: "a" }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/capabilities?kind=task&limit=100");
  });

  it("sends the CSRF cookie back on writes only", async () => {
    document.cookie = "rote_csrf=token-123; path=/";
    const fetchMock = stubFetch(ok({}), ok({}));
    await api("/runs", { method: "POST", json: { kind: "replay" } });
    await api("/runs");
    const write = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(write.get("x-csrf-token")).toBe("token-123");
    expect(write.get("content-type")).toBe("application/json");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-csrf-token")).toBeNull();
  });

  it("turns error envelopes into ApiErrors with the stable code", async () => {
    stubFetch(fail(403, "SELF_APPROVAL_FORBIDDEN", "Another reviewer must approve it"));
    const error = await api("/capabilities/x/approve", { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "SELF_APPROVAL_FORBIDDEN", message: "Another reviewer must approve it" });

    stubFetch(fail(422, "INPUT_CONTRACT_VIOLATION", "bad inputs", { problems: ["member_id: required"] }));
    const invalid = (await api("/capabilities/x/invoke", { method: "POST" }).catch((e: unknown) => e)) as ApiError;
    expect(invalid.problems).toEqual(["member_id: required"]);
  });

  it("refreshes an expired session once and retries", async () => {
    const fetchMock = stubFetch(fail(401, "SESSION_EXPIRED", "expired"), ok({}), ok({ id: "run-1" }));
    expect(await api("/runs/run-1")).toEqual({ id: "run-1" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/runs/run-1",
      "/api/v1/auth/refresh",
      "/api/v1/runs/run-1",
    ]);
  });

  it("signs out when the session cannot be refreshed", async () => {
    const lost = vi.fn();
    setSessionLostHandler(lost);
    stubFetch(fail(401, "UNAUTHORIZED", "Authentication required"), fail(401, "INVALID_REFRESH_TOKEN", "no"));
    await expect(api("/runs")).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledOnce();
  });

  it("does not refresh in a loop on the auth endpoints themselves", async () => {
    const fetchMock = stubFetch(fail(401, "INVALID_CREDENTIALS", "Invalid email or password"));
    await expect(api("/auth/login", { method: "POST", json: {} })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("ranks roles", () => {
    expect(hasRole("ADMIN", "REVIEWER")).toBe(true);
    expect(hasRole("OPERATOR", "REVIEWER")).toBe(false);
    expect(hasRole(undefined, "VIEWER")).toBe(false);
  });
});
