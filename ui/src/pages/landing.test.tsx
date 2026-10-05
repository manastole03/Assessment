import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TOUR_STORAGE_KEY } from "@/features/tour/state";
import { TourProvider } from "@/features/tour/tour-provider";
import { ok, page, pathOf, renderWithProviders } from "@/test/render";

import LandingPage from "./landing";

const API: Partial<Record<string, () => Response>> = {
  "/api/v1/status": () =>
    ok({
      version: "0.1.0",
      model: "claude-opus-5-5",
      effort: "high",
      has_api_key: false,
      active_runs: 0,
      tenants: [
        { id: "acme", reachable: true },
        { id: "bayview", reachable: false },
      ],
    }),
  "/api/v1/capabilities": () => ok([{ status: "approved" }, { status: "draft" }]),
  "/api/v1/runs": () => page([{}], 3),
  "/api/v1/evals/datasets": () =>
    ok([
      {
        id: "replay",
        title: "Deterministic replay",
        description: "Every case must pass.",
        kind: "replay",
        uses_model: false,
        threshold: 1,
        cases: 13,
        tags: [],
        latest: { mode: "deterministic", summary: { passed: 13, cases: 13, pass_rate: 1 } },
      },
    ]),
};

describe("LandingPage", () => {
  it("leads with the product and shows live workspace numbers", async () => {
    localStorage.setItem(TOUR_STORAGE_KEY, "completed");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => Promise.resolve(API[pathOf(url)]?.() ?? ok(null))),
    );
    renderWithProviders(
      <TourProvider>
        <LandingPage />
      </TourProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Autopilot for softwarethat has no API.");
    expect(screen.getByRole("button", { name: "Start the tour" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Open the studio/ })[0]).toHaveAttribute("href", "/overview");

    // The instrument strip reads this workspace.
    const workspace = within(screen.getByLabelText("From this workspace", { selector: "dl" }));
    expect(await workspace.findByText("1")).toBeInTheDocument(); // approved capabilities
    expect(await workspace.findByText("3")).toBeInTheDocument(); // runs: meta.total, not a download
    expect(await workspace.findByText("100%")).toBeInTheDocument(); // replay eval
    expect(await workspace.findByText("1/2")).toBeInTheDocument(); // tenants reachable

    // Every story chapter is there (stacked below the desktop breakpoint), each with its drawing.
    for (const title of ["The model flies it once.", "The flight becomes a plan.", "Autopilot. No model aboard."]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole("img", { name: /legacy screen/ })).toBeInTheDocument();

    // Eval dials are labelled with their reading, not just drawn.
    expect(await screen.findByRole("img", { name: "Deterministic replay: 100%" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // the tour was already completed
  });

  it("stays public: signed-out visitors see the story without calling the API", async () => {
    localStorage.setItem(TOUR_STORAGE_KEY, "completed");
    const fetchMock = vi.fn(() => Promise.resolve(ok(null)));
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(
      <TourProvider>
        <LandingPage />
      </TourProvider>,
      { who: null },
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    const workspace = within(screen.getByLabelText("From this workspace", { selector: "dl" }));
    expect(workspace.getAllByText("—").length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
