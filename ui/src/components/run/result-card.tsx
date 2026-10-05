import { ArrowRight, BadgeInfo, FileText, RotateCw, TriangleAlert, XCircle } from "lucide-react";
import { Link } from "react-router";

import { RunStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { runFile, type Failure, type RunDetail } from "@/lib/api";
import { formatDuration } from "@/lib/format";

import { ScreenshotThumb } from "./screenshot";

function Block({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`space-y-1.5 ${className}`}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function FailureBlock({ failure, runId }: { failure: Failure; runId: string }) {
  return (
    <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
        <div>
          <div className="font-mono text-xs font-semibold">{failure.code}</div>
          <div>{failure.message}</div>
        </div>
      </div>
      {failure.step_id && (
        <div className="text-xs text-muted-foreground">
          at <code className="font-mono">{failure.step_id}</code> — {failure.step_intent}
        </div>
      )}
      {failure.expected && (
        <div className="text-xs">
          <span className="font-medium">Expected:</span> {failure.expected}
        </div>
      )}
      {failure.observed && (
        <div className="space-y-1 text-xs">
          <span className="font-medium">Observed:</span>
          <pre className="max-h-48 overflow-auto rounded border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap">
            {failure.observed}
          </pre>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        {failure.retryable ? "Retrying later may help." : "Retrying won't help: the capability or its inputs need attention."}
      </div>
      {failure.evidence.screenshot && (
        <ScreenshotThumb src={runFile(runId, failure.evidence.screenshot)} label="Screen at failure (masked)" className="w-56" />
      )}
    </div>
  );
}

export function ResultCard({ run, lastScreenshot }: { run: RunDetail; lastScreenshot?: string }) {
  const result = run.result;
  const outputs = (run.caller?.outputs as Record<string, unknown> | undefined) ?? result?.outputs ?? undefined;
  const failure = result?.failure && typeof result.failure === "object" ? result.failure : undefined;
  const capability = typeof result?.capability === "object" && result.capability ? result.capability : undefined;
  const discovered = run.kind === "discovery" && typeof result?.capability === "string" ? result.capability : undefined;
  const proposed = run.kind === "probe" ? (run.caller?.proposed as string | undefined) : undefined;
  const reviewRef = discovered ?? proposed;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Result</CardTitle>
        <CardAction>
          <RunStatusBadge status={run.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {run.error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
            <span>{run.error}</span>
          </div>
        )}
        {outputs && Object.keys(outputs).length > 0 && (
          <Block title="Outputs returned to the caller">
            <Table>
              <TableBody>
                {Object.entries(outputs).map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="font-mono text-xs">{k}</TableCell>
                    <TableCell className="text-right font-medium">{String(v)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {run.caller?.outputs != null && (
              <p className="text-xs text-muted-foreground">
                PII outputs are shown to you here but never written to the evidence.
              </p>
            )}
          </Block>
        )}
        {result?.outcome && (
          <div className="flex items-start gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-3">
            <BadgeInfo className="mt-0.5 size-4 shrink-0 text-violet-600" aria-hidden />
            <div>
              <div className="font-mono text-xs font-semibold">{result.outcome.code}</div>
              <div>{result.outcome.message}</div>
              <div className="mt-1 text-xs text-muted-foreground">A legitimate answer for the calling agent — not an error.</div>
            </div>
          </div>
        )}
        {failure && <FailureBlock failure={failure} runId={run.id} />}
        {typeof result?.failure === "string" && <div className="text-red-700 dark:text-red-300">{result.failure}</div>}
        {!!result?.recoveries?.length && (
          <Block title="Recovered along the way">
            <ul className="space-y-1">
              {result.recoveries.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <RotateCw className="mt-0.5 size-3.5 text-sky-600" aria-hidden />
                  <span>
                    <span className="font-mono">{r.handler}</span> ({r.source}) — {r.action}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}
        {!!result?.warnings?.length && (
          <Block title="Drift warnings (did not stop the run)">
            <ul className="space-y-1">
              {result.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <TriangleAlert className="mt-0.5 size-3.5 text-amber-600" aria-hidden />
                  <span>
                    <span className="font-mono">{w.code}</span> {w.step_id && <code className="font-mono">{w.step_id}</code>} —{" "}
                    {w.message}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}
        {capability && (
          <Block title="Executed artifact">
            <div className="font-mono text-xs">
              {capability.id}@{capability.version} · {capability.effective_hash}
            </div>
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {capability.layers.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Block>
        )}
        {run.kind === "discovery" && result && (
          <Block title="Discovery">
            <div className="text-xs text-muted-foreground">
              {result.model} · {result.turns} turns · est. ${(result.estimated_cost_usd ?? 0).toFixed(3)}
            </div>
          </Block>
        )}
        {result?.duration_ms != null && (
          <div className="text-xs text-muted-foreground">Took {formatDuration(result.duration_ms)}</div>
        )}
        {lastScreenshot && <ScreenshotThumb src={runFile(run.id, lastScreenshot)} label="Final screen (masked)" />}
        <div className="flex flex-wrap gap-2">
          {reviewRef && (
            <Button asChild size="sm">
              <Link to={`/capabilities/${reviewRef.split("@")[0]}?version=${reviewRef.split("@")[1] ?? ""}`}>
                Review the {proposed ? "proposed version" : "recorded capability"} <ArrowRight />
              </Link>
            </Button>
          )}
          {run.hasReport && (
            <Button asChild size="sm" variant="outline">
              <a href={runFile(run.id, "report.html")} target="_blank" rel="noreferrer">
                <FileText /> Static report
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
