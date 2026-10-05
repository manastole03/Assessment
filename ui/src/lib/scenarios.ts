import type { StartRun } from "@/lib/api";

export const BALANCE = "legacycore.member.get_savings_balance";

export interface Scenario {
  id: string;
  title: string;
  description: string;
  expect: string;
  request: StartRun;
}

// One-click demonstrations against the bundled LegacyCore mock. `faults` are injected into the mock
// before the run starts ({} clears any left over from earlier runs).
export const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    title: "Happy path",
    description: "Sign on, find member 12345, read the savings balance and name.",
    expect: "succeeded",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "12345" },
      escalation: "wait",
      faults: {},
    },
  },
  {
    id: "reordered",
    title: "Another member, rows re-ordered",
    description: "Same artifact; the savings row is third, so positional selectors would read the wrong cell.",
    expect: "succeeded",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "20417" },
      escalation: "wait",
      faults: {},
    },
  },
  {
    id: "not-found",
    title: "No such member",
    description: "A legitimate business answer, returned as an outcome — not an error.",
    expect: "business_outcome",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "99999" },
      escalation: "fail",
      faults: {},
    },
  },
  {
    id: "recoveries",
    title: "Runtime errors, recovered",
    description: "HTTP 503, a maintenance interstitial, a native dialog and a session timeout — all recognised and handled.",
    expect: "succeeded",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "12345" },
      escalation: "wait",
      faults: { maintenance_notice: true, session_warning_dialog: true, transient_errors: 1, session_expire_after: 4 },
    },
  },
  {
    id: "handoff",
    title: "Unknown screen → human takes over",
    description: "An attestation screen nobody automated. Replay pauses; you take the live session and hand it back.",
    expect: "succeeded",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "12345" },
      escalation: "wait",
      faults: { compliance_popup: true },
    },
  },
  {
    id: "hard-failure",
    title: "Vendor redesign → hard failure",
    description: "The search screen changed overnight. Replay stops with expected vs observed, a screenshot and the DOM.",
    expect: "failed",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "acme",
      inputs: { member_id: "12345" },
      escalation: "fail",
      faults: { vendor_upgrade: true },
    },
  },
  {
    id: "tenant",
    title: "Same artifact, another institution",
    description: "Bayview runs the same vendor product, relabelled and renamed. One reviewed override makes it work.",
    expect: "succeeded",
    request: {
      kind: "replay",
      capability: BALANCE,
      tenant: "bayview",
      inputs: { member_id: "20417" },
      escalation: "wait",
      faults: {},
    },
  },
];
