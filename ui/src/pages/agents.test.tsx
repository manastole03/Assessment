import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Invocation, McpTool } from "@/lib/api";
import { fail, identity, ok, pathOf, renderWithProviders } from "@/test/render";

import AgentsPage from "./agents";

const TOOL: McpTool = {
  name: "legacycore__member__get_savings_balance",
  title: "Get a member's savings balance",
  description: "Looks up a member and reads their savings balance.",
  inputSchema: {
    type: "object",
    properties: {
      member_id: { type: "string", description: "Member number", pattern: "^[0-9]{5,10}$" },
      tenant: { type: "string", enum: ["acme", "bayview"], default: "acme" },
    },
    required: ["member_id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const SUCCEEDED: Invocation = {
  status: "succeeded",
  capability: "legacycore.member.get_savings_balance@1.0.3",
  run_id: "20261002T000000Z-replay-x",
  outputs: { savings_balance: "2418.07" },
  links: { run: "/api/v1/runs/20261002T000000Z-replay-x", ui: "http://localhost:3000/runs/20261002T000000Z-replay-x" },
};

function renderPage(invoke: (body: unknown) => Response, role: "OPERATOR" | "VIEWER" = "OPERATOR") {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (pathOf(url) === "/api/v1/agents/tools") return Promise.resolve(ok([TOOL]));
    if (pathOf(url) === "/api/v1/api-keys") return Promise.resolve(ok([]));
    return Promise.resolve(invoke(JSON.parse(init?.body as string)));
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWithProviders(<AgentsPage />, { who: identity(role) });
  return fetchMock;
}

describe("AgentsPage", () => {
  it("shows how to connect and lists the tools with their contract", async () => {
    renderPage(() => ok(SUCCEEDED));
    expect(await screen.findByText(TOOL.name)).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http rote .*\/api\/v1\/mcp/)).toBeInTheDocument();
    expect(screen.getAllByText(/Authorization: Bearer/).length).toBeGreaterThan(0);
    expect(screen.getByText("idempotent")).toBeInTheDocument();
    expect(screen.getByText("reversible")).toBeInTheDocument();
  });

  it("invokes a tool and shows exactly what the agent receives", async () => {
    const user = userEvent.setup();
    const fetchMock = renderPage(() => ok(SUCCEEDED));
    await user.click(await screen.findByRole("button", { name: "Invoke" }));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    // The contract is syntax-highlighted token by token; read the code block as a whole.
    const result = screen.getByText("What the agent receives").closest('[data-slot="card"]');
    expect(result?.querySelector("pre")?.textContent).toContain('"savings_balance": "2418.07"');
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/invoke"));
    expect(call?.[0]).toBe("/api/v1/capabilities/legacycore.member.get_savings_balance/invoke");
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ tenant: "acme", inputs: { member_id: "12345" } });
  });

  it("lists every contract problem from a 422", async () => {
    const user = userEvent.setup();
    renderPage(() =>
      fail(422, "INPUT_CONTRACT_VIOLATION", "the inputs do not match the capability's contract", {
        problems: ["input 'member_id' does not match"],
      }),
    );
    const input = await screen.findByLabelText(/member_id/);
    await user.clear(input);
    await user.type(input, "12-AB");
    await user.click(screen.getByRole("button", { name: "Invoke" }));
    expect(await screen.findByText("input 'member_id' does not match")).toBeInTheDocument();
    expect(screen.getByText(/nothing ran/)).toBeInTheDocument();
  });
});
