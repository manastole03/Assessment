import { Bot, Brain, CheckCircle2, FileCheck2, Hand, ShieldCheck, XCircle } from "lucide-react";

import { runFile } from "@/lib/api";
import type { TranscriptItem } from "@/lib/timeline";

import { ScreenshotThumb } from "./screenshot";

const ICON = { thinking: Brain, action: Bot, vendor: ShieldCheck, human: Hand, artifact: FileCheck2, error: XCircle };

export function TranscriptView({ items, runId }: { items: TranscriptItem[]; runId: string }) {
  if (!items.length) return <p className="py-6 text-sm text-muted-foreground">The agent hasn't acted yet…</p>;
  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const Icon = ICON[item.kind];
        return (
          <li key={item.seq} className="flex gap-3">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={item.kind === "action" ? "font-mono font-medium" : "font-medium"}>{item.title}</span>
                {item.ok === true && <CheckCircle2 className="size-3.5 text-emerald-600" aria-label="ok" />}
                {item.ok === false && <XCircle className="size-3.5 text-red-600" aria-label="error" />}
              </div>
              {item.body && (
                <p className={`text-xs whitespace-pre-wrap text-muted-foreground ${item.kind === "thinking" ? "italic" : ""}`}>
                  {item.body}
                </p>
              )}
              {item.result && <p className="text-xs">→ {item.result}</p>}
              {item.screenshot && <ScreenshotThumb src={runFile(runId, item.screenshot)} label={item.title} className="w-44" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
