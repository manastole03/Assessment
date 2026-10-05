import type { RunEvent } from "@/lib/api";
import { text } from "@/lib/format";

export type NoteTone = "info" | "warn" | "recover" | "outcome" | "human" | "policy" | "output" | "error";

export interface TimelineNote {
  seq: number;
  tone: NoteTone;
  text: string;
}

export interface TimelineStep {
  key: string;
  capability: string;
  stepId: string;
  intent: string;
  nested: boolean;
  status: "running" | "ok" | "failed" | "human";
  durationMs?: number;
  locator?: string;
  notes: TimelineNote[];
  screenshot?: string;
}

export interface Timeline {
  steps: TimelineStep[];
  preamble: TimelineNote[];
  finished?: RunEvent;
  screenshots: { label: string; path: string }[];
}

const s = text;

/** Fold the run's event stream into a per-step timeline. Pure: same events, same timeline. */
export function buildTimeline(events: RunEvent[]): Timeline {
  const steps: TimelineStep[] = [];
  const preamble: TimelineNote[] = [];
  const screenshots: { label: string; path: string }[] = [];
  let current: TimelineStep | undefined;
  let finished: RunEvent | undefined;

  const note = (seq: number, tone: NoteTone, text: string) => (current ? current.notes : preamble).push({ seq, tone, text });

  for (const e of events) {
    switch (e.type) {
      case "session.establishing":
        current = undefined;
        preamble.push({ seq: e.seq, tone: "info", text: `Signing on via ${s(e.capability)}` });
        break;
      case "step.started":
        current = {
          key: String(e.seq),
          capability: s(e.capability),
          stepId: s(e.step),
          intent: s(e.intent),
          nested: Boolean(e.nested),
          status: "running",
          notes: [],
        };
        steps.push(current);
        break;
      case "step.completed": {
        const step = [...steps].reverse().find((x) => x.stepId === e.step && x.status !== "ok");
        if (step) {
          // A step the operator completed by hand stays "human" (no step.completed is emitted for it);
          // one they asked automation to retry completes normally.
          step.status = "ok";
          step.durationMs = Number(e.duration_ms ?? 0);
          step.locator = e.locator ? s(e.locator) : undefined;
        }
        break;
      }
      case "locator.warning":
        note(e.seq, "warn", `${s(e.code)}: ${s(e.message)}`);
        break;
      case "handler.fired": {
        const tone: NoteTone = e.kind === "business_outcome" ? "outcome" : e.kind === "failure" ? "error" : "recover";
        note(e.seq, tone, `${s(e.handler)} (${s(e.source)}) — ${s(e.description)}`);
        break;
      }
      case "recovery.performed":
        note(e.seq, "recover", `Recovered: ${s(e.action)}${Number(e.attempt) > 1 ? ` (attempt ${s(e.attempt)})` : ""}`);
        break;
      case "capability.restarted":
        note(e.seq, "recover", "Signed on again; capability restarted from step one");
        break;
      case "policy.decision":
        if (e.verdict !== "allow") note(e.seq, "policy", `Policy ${s(e.verdict)}: ${s(e.reason)}`);
        break;
      case "output.extracted":
        note(e.seq, "output", `${s(e.output)} = ${s(e.value)}`);
        break;
      case "intervention.raised":
        if (current) current.status = "human";
        note(e.seq, "human", `Escalated to a human — ${s(e.reason_code)}: ${s(e.reason)}`);
        break;
      case "intervention.claimed":
        note(e.seq, "human", `${s(e.operator)} took control (lease epoch ${s(e.epoch)})`);
        break;
      case "human.action":
        note(e.seq, "human", `Operator ${s(e.description)}`);
        break;
      case "intervention.resolved":
        note(e.seq, "human", `Handed back: ${s(e.resolution).replace(/_/g, " ")}${e.note ? ` — “${s(e.note)}”` : ""}`);
        break;
      case "intervention.expired":
        note(e.seq, "error", "No operator responded in time; automation reclaimed the session");
        break;
      case "policy.network_blocked":
        note(e.seq, "policy", `Blocked request to ${s(e.url)}`);
        break;
      case "evidence.captured":
        if (e.screenshot) {
          screenshots.push({ label: s(e.label), path: s(e.screenshot) });
          if (current && e.label === current.stepId) current.screenshot = s(e.screenshot);
        }
        break;
      case "run.finished":
      case "discovery.finished":
        finished = e;
        if (e.failure) {
          const open = [...steps].reverse().find((x) => x.status === "running" || x.status === "human");
          if (open) open.status = "failed";
        }
        break;
      case "run.error":
        preamble.push({ seq: e.seq, tone: "error", text: s(e.message) });
        break;
    }
  }
  return { steps, preamble, finished, screenshots };
}

export interface TranscriptItem {
  seq: number;
  kind: "thinking" | "action" | "vendor" | "human" | "artifact" | "error";
  title: string;
  body?: string;
  ok?: boolean;
  result?: string;
  screenshot?: string;
}

/** Discovery runs: the model's turns, actions and their results, in order. */
export function buildTranscript(events: RunEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let lastAction: TranscriptItem | undefined;
  for (const e of events) {
    switch (e.type) {
      case "agent.turn":
        if (e.reasoning) items.push({ seq: e.seq, kind: "thinking", title: "Reasoning", body: s(e.reasoning) });
        break;
      case "agent.action":
        lastAction = { seq: e.seq, kind: "action", title: s(e.tool), body: s(e.summary), result: undefined };
        if (e.rationale) lastAction.body = `${s(e.summary)}\nWhy: ${s(e.rationale)}`;
        items.push(lastAction);
        break;
      case "agent.action_result":
        if (lastAction) {
          lastAction.ok = Boolean(e.ok);
          lastAction.result = s(e.message);
        }
        break;
      case "evidence.captured":
        if (lastAction && e.screenshot && s(e.label).startsWith("turn-")) lastAction.screenshot = s(e.screenshot);
        break;
      case "handler.fired":
        items.push({ seq: e.seq, kind: "vendor", title: `Known screen handled: ${s(e.handler)}`, body: s(e.description) });
        break;
      case "intervention.raised":
        items.push({ seq: e.seq, kind: "human", title: `Asked a human: ${s(e.reason_code)}`, body: s(e.reason) });
        break;
      case "intervention.resolved":
        items.push({ seq: e.seq, kind: "human", title: `Human handed back: ${s(e.resolution)}`, body: s(e.note) });
        break;
      case "artifact.recorded":
        items.push({
          seq: e.seq,
          kind: "artifact",
          title: `Recorded ${s(e.capability)}`,
          body: `${s(e.steps)} steps · ${s(e.summary)}`,
        });
        break;
      case "run.error":
        items.push({ seq: e.seq, kind: "error", title: "Run error", body: s(e.message) });
        break;
    }
  }
  return items;
}
