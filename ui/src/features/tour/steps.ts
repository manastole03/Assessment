import type { Side } from "driver.js";

export interface TourStep {
  /** The route the step lives on; the tour navigates there before highlighting. */
  route: string;
  /** `data-tour` id of the element to highlight; omitted for a centred step. */
  target?: string;
  title: string;
  description: string;
  side?: Side;
}

// A short path through the product: what it is, then one stop per part of the studio a newcomer needs.
export const TOUR_STEPS: TourStep[] = [
  {
    route: "/",
    target: "hero",
    title: "Record once. Replay by rote.",
    description:
      "An AI agent works out a back-office task once, on a legacy UI with no API. The run becomes a typed, reviewable capability that production replays with no model in the loop.",
    side: "bottom",
  },
  {
    route: "/",
    target: "how-it-works",
    title: "Four stages",
    description:
      "Discover with the model, review and approve the artifact, replay it deterministically, and hand the live session to a person when it can't safely proceed.",
    side: "top",
  },
  {
    route: "/overview",
    target: "nav",
    title: "The studio",
    description: "Everything lives here: capabilities, runs, discovery, evidence, evals and the guardrail policy.",
    side: "right",
  },
  {
    route: "/overview",
    target: "scenarios",
    title: "Try a scenario",
    description:
      "One click runs a real replay against the bundled LegacyCore mock: the happy path, runtime errors it recovers from, a vendor redesign, or a human handoff.",
    side: "top",
  },
  {
    route: "/capabilities",
    target: "capabilities",
    title: "Review what was recorded",
    description:
      "Each capability is a versioned contract with ordered locators and handlers. Drafts never run unattended. Approve them here after review.",
    side: "bottom",
  },
  {
    route: "/run",
    target: "run-form",
    title: "Run with your own inputs",
    description:
      "Pick a tenant, type the inputs, and inject faults into the mock to watch recoveries, drift warnings and escalations happen live.",
    side: "top",
  },
  {
    route: "/evals",
    target: "evals",
    title: "Measured, not claimed",
    description:
      "Versioned eval datasets grade the replay engine, probe classification and the discovery agent. Run them here or with make eval; failures link to full evidence.",
    side: "bottom",
  },
  {
    route: "/agents",
    target: "agents",
    title: "Agents call it as a tool",
    description:
      "Approved capabilities are tools: connect any MCP client to /api/v1/mcp with an API key, or POST to /invoke. Every call is checked against the contract, replayed, and shows up under Runs.",
    side: "bottom",
  },
  {
    route: "/agents",
    target: "tour-relaunch",
    title: "That's the tour",
    description: "Start it again from here any time. A good first run: Overview → Try a scenario → Happy path.",
    side: "right",
  },
];
