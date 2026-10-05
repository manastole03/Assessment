import {
  BadgeInfo,
  CheckCircle2,
  CircleDot,
  Hand,
  Info,
  Loader2,
  OctagonX,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { runFile } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import type { NoteTone, Timeline, TimelineNote, TimelineStep } from "@/lib/timeline";
import { cn } from "@/lib/utils";

import { ScreenshotThumb } from "./screenshot";

const NOTE: Record<NoteTone, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: "border-border text-muted-foreground" },
  warn: { icon: TriangleAlert, className: "border-amber-500/50 text-amber-800 dark:text-amber-300" },
  recover: { icon: RotateCw, className: "border-sky-500/50 text-sky-800 dark:text-sky-300" },
  outcome: { icon: BadgeInfo, className: "border-violet-500/50 text-violet-800 dark:text-violet-300" },
  human: { icon: Hand, className: "border-amber-500/60 text-amber-900 dark:text-amber-200" },
  policy: { icon: ShieldAlert, className: "border-red-500/50 text-red-800 dark:text-red-300" },
  output: { icon: Upload, className: "border-emerald-500/50 text-emerald-800 dark:text-emerald-300" },
  error: { icon: OctagonX, className: "border-red-500/60 text-red-800 dark:text-red-300" },
};

function Note({ note }: { note: TimelineNote }) {
  const { icon: Icon, className } = NOTE[note.tone];
  return (
    <div className={cn("flex items-start gap-2 border-l-2 py-0.5 pl-2 text-xs", className)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="break-words">{note.text}</span>
    </div>
  );
}

const STEP_ICON: Record<TimelineStep["status"], { icon: LucideIcon; className: string; label: string }> = {
  running: { icon: Loader2, className: "animate-spin text-sky-600", label: "running" },
  ok: { icon: CheckCircle2, className: "text-emerald-600", label: "completed" },
  failed: { icon: XCircle, className: "text-red-600", label: "failed" },
  human: { icon: Hand, className: "text-amber-600", label: "completed by a human" },
};

function StepRow({ step, runId }: { step: TimelineStep; runId: string }) {
  const { icon: Icon, className, label } = STEP_ICON[step.status];
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <div className="relative z-10 mt-0.5 rounded-full bg-background">
        <Icon className={cn("size-5", className)} aria-label={label} />
      </div>
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono text-[12px] font-medium">{step.stepId}</code>
            {step.nested && (
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                sign-on
              </Badge>
            )}
            {step.locator && (
              <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                via {step.locator}
              </Badge>
            )}
            {step.durationMs != null && <span className="text-xs text-muted-foreground">{formatDuration(step.durationMs)}</span>}
            {step.status === "human" && (
              <span className="text-xs text-amber-700 dark:text-amber-300">completed by an operator</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{step.intent}</p>
          {step.notes.length > 0 && (
            <div className="space-y-1">
              {step.notes.map((n) => (
                <Note key={n.seq} note={n} />
              ))}
            </div>
          )}
        </div>
        {step.screenshot && (
          <ScreenshotThumb
            src={runFile(runId, step.screenshot)}
            label={`${step.stepId} — screen after the step (masked)`}
            className="hidden h-fit w-28 shrink-0 sm:block"
          />
        )}
      </div>
    </li>
  );
}

export function TimelineView({ timeline, runId }: { timeline: Timeline; runId: string }) {
  if (!timeline.steps.length && !timeline.preamble.length) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <CircleDot className="size-4 animate-pulse" aria-hidden /> Waiting for the first step…
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {timeline.preamble.map((n) => (
        <Note key={n.seq} note={n} />
      ))}
      <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-[9px] before:w-px before:bg-border">
        {timeline.steps.map((step) => (
          <StepRow key={step.key} step={step} runId={runId} />
        ))}
      </ol>
    </div>
  );
}
