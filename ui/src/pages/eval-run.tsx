import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, RotateCcw } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { PassRateMeter } from "@/components/evals/pass-rate-meter";
import { Mono, PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import { EvalModeBadge, EvalStatusBadge, VerdictBadge } from "@/components/status";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { api, evalFile, type EvalCase, type EvalRunDetail, type EvalTrial, type StartEval } from "@/lib/api";
import { percent } from "@/lib/evals";
import { formatDuration, formatWhen } from "@/lib/format";

function TrialChecks({ evalId, trial, label }: { evalId: string; trial: EvalTrial; label?: string }) {
  return (
    <div className="space-y-2">
      {label && <div className="text-xs font-medium text-muted-foreground">{label}</div>}
      {trial.error && (
        <Alert variant="destructive">
          <AlertTitle>The trial did not complete</AlertTitle>
          <AlertDescription className="font-mono text-xs">{trial.error}</AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Result</TableHead>
              <TableHead>Check</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Observed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trial.checks.map((check) => (
              <TableRow key={check.name}>
                <TableCell>
                  <VerdictBadge passed={check.passed} />
                </TableCell>
                <TableCell className="text-xs font-medium">{check.name}</TableCell>
                <TableCell className="max-w-64 font-mono text-[11px] whitespace-normal text-muted-foreground">
                  {check.expected ?? "—"}
                </TableCell>
                <TableCell className="max-w-96 font-mono text-[11px] whitespace-normal">{check.observed ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatDuration(trial.duration_ms)}</span>
        {trial.cost_usd > 0 && <span className="tabular-nums">${trial.cost_usd.toFixed(3)}</span>}
        {trial.evidence && (
          <Button asChild variant="outline" size="xs">
            <a href={evalFile(evalId, `${trial.evidence}/report.html`)} target="_blank" rel="noreferrer">
              <FileText /> Evidence report
            </a>
          </Button>
        )}
        {trial.run_id && <Mono className="text-[11px]">{trial.run_id}</Mono>}
      </div>
    </div>
  );
}

function CaseRow({ evalId, item, trials }: { evalId: string; item: EvalCase; trials: number }) {
  const last = item.trials.at(-1);
  const done = item.trials.length === trials;
  return (
    <AccordionItem value={item.id}>
      <AccordionTrigger className="gap-3 hover:no-underline">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left">
          {done ? <VerdictBadge passed={item.passed} className="shrink-0" /> : <EvalStatusBadge status="running" />}
          <span className="min-w-0">
            <span className="block text-sm font-medium">{item.title}</span>
            <span className="block truncate font-mono text-[11px] font-normal text-muted-foreground">
              {item.id}
              {last?.observed && ` · ${last.observed}`}
            </span>
          </span>
        </span>
        {trials > 1 && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {item.trials.filter((t) => t.passed).length}/{item.trials.length} trials
          </span>
        )}
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        {item.trials.map((trial) => (
          <TrialChecks key={trial.trial} evalId={evalId} trial={trial} label={trials > 1 ? `Trial ${trial.trial}` : undefined} />
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}

export default function EvalRunPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const run = useQuery({
    queryKey: ["eval", id],
    queryFn: () => api<EvalRunDetail>(`/evals/results/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1000 : false),
  });
  const mayRun = useAuth().can("REVIEWER");
  const again = useMutation({
    mutationFn: (request: StartEval) => api<{ id: string }>("/evals/runs", { method: "POST", json: request }),
    onSuccess: (data) => void navigate(`/evals/${encodeURIComponent(data.id)}`),
    onError: (error) => toast.error("The eval could not start", { description: String(error) }),
  });

  if (run.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!run.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">This eval could not be loaded: {String(run.error)}</p>
        <Button asChild variant="outline">
          <Link to="/evals">
            <ArrowLeft /> All evals
          </Link>
        </Button>
      </div>
    );
  }

  const data = run.data;
  const summary = data.summary;
  const finished = data.cases.filter((c) => c.trials.length === data.trials);
  const passed = summary?.passed ?? finished.filter((c) => c.passed).length;
  const total = summary?.cases ?? finished.length;
  const rate = total ? passed / total : 0;
  const tags = Object.entries(summary?.by_tag ?? {});

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.dataset_title}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <EvalStatusBadge status={data.status} />
            <EvalModeBadge mode={data.mode} />
            {data.model && <Mono>{data.model}</Mono>}
            {data.trials > 1 && <span>{data.trials} trials per case</span>}
            <span>started {formatWhen(data.started_at)}</span>
            <span title="Dataset content hash: scores compare only on identical datasets">
              dataset <Mono>{data.dataset_sha}</Mono>
            </span>
          </div>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/evals">
                <ArrowLeft /> All evals
              </Link>
            </Button>
            <Button
              disabled={data.status === "running" || again.isPending || !mayRun}
              onClick={() =>
                again.mutate({ dataset: data.dataset, mode: data.mode === "live" ? "live" : "offline", trials: data.trials })
              }
            >
              <RotateCcw /> Run again
            </Button>
          </>
        }
      />

      {data.status === "running" && (
        <div className="space-y-1.5" aria-live="polite">
          <Progress value={(finished.length / Math.max(1, data.total_cases)) * 100} aria-label="Eval progress" />
          <p className="text-xs text-muted-foreground tabular-nums">
            {finished.length} of {data.total_cases} cases done. Each case runs in its own sandbox against a private mock bank.
          </p>
        </div>
      )}
      {data.error && (
        <Alert variant="destructive">
          <AlertTitle>The eval stopped with an error</AlertTitle>
          <AlertDescription className="font-mono text-xs">{data.error}</AlertDescription>
        </Alert>
      )}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Gate"
          value={summary ? <VerdictBadge passed={summary.gate} className="text-sm" /> : "—"}
          detail={`needs ${percent(data.threshold)} of cases`}
        />
        <StatTile label="Pass rate" value={percent(rate)} detail={`${passed} of ${total} cases`} />
        <StatTile
          label={data.trials > 1 ? `Consistency (pass^${data.trials})` : "Checks passed"}
          value={
            data.trials > 1 && summary
              ? percent(summary.pass_hat_k)
              : summary
                ? `${summary.checks_passed}/${summary.checks}`
                : "—"
          }
          detail={data.trials > 1 && summary ? `pass@${data.trials} ${percent(summary.pass_at_k)}` : "graded checks"}
        />
        <StatTile
          label="Latency p50"
          value={formatDuration(summary?.p50_ms)}
          detail={
            <>
              p95 {formatDuration(summary?.p95_ms)}
              {summary && summary.cost_usd > 0 && ` · model cost $${summary.cost_usd.toFixed(2)}`}
            </>
          }
        />
      </section>

      {tags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By tag</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {tags.map(([tag, stat]) => (
              <PassRateMeter key={tag} label={tag} passed={stat.passed} total={stat.cases} threshold={data.threshold} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cases</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" defaultValue={data.cases.filter((c) => !c.passed && c.trials.length).map((c) => c.id)}>
            {data.cases.map((item) => (
              <CaseRow key={item.id} evalId={data.id} item={item} trials={data.trials} />
            ))}
          </Accordion>
          {data.cases.length < data.total_cases && (
            <p className="mt-3 text-xs text-muted-foreground">
              {data.total_cases - data.cases.length} more case{data.total_cases - data.cases.length === 1 ? "" : "s"} queued.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
