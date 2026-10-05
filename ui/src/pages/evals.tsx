import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, Gauge, Play, ScanSearch, Sparkles, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { PassRateMeter } from "@/components/evals/pass-rate-meter";
import { EmptyState, Mono, PageHeader } from "@/components/page-header";
import { EvalModeBadge, EvalStatusBadge, VerdictBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStatus } from "@/hooks/use-status";
import { useAuth } from "@/features/auth/auth-context";
import { api, apiAll, type EvalDatasetSummary, type EvalKind, type EvalRunSummary, type StartEval } from "@/lib/api";
import { percent } from "@/lib/evals";
import { formatDuration, formatWhen } from "@/lib/format";

const KIND_ICON: Record<EvalKind, LucideIcon> = { replay: Bot, probe: ScanSearch, discovery: Sparkles };

function DatasetCard({
  dataset,
  hasApiKey,
  busy,
  onRun,
}: {
  dataset: EvalDatasetSummary;
  hasApiKey: boolean;
  busy: boolean;
  onRun: (request: StartEval) => void;
}) {
  const [mode, setMode] = useState<"offline" | "live">("offline");
  const mayRun = useAuth().can("REVIEWER");
  const [trials, setTrials] = useState("1");
  const Icon = KIND_ICON[dataset.kind];
  const latest = dataset.latest;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {dataset.title}
        </CardTitle>
        <CardDescription>{dataset.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="font-normal">
            {dataset.cases} cases
          </Badge>
          <Badge variant="outline" className="font-normal">
            gate {percent(dataset.threshold)}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {dataset.uses_model ? "model or stand-in" : "no model"}
          </Badge>
        </div>
        {latest?.summary ? (
          <Link
            to={`/evals/${encodeURIComponent(latest.id)}`}
            className="block space-y-1.5 rounded-md border p-2.5 hover:bg-muted/50"
          >
            <PassRateMeter
              label="Latest run"
              passed={latest.summary.passed}
              total={latest.summary.cases}
              threshold={dataset.threshold}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <EvalModeBadge mode={latest.mode} />
              {formatWhen(latest.finished_at ?? latest.started_at)}
            </div>
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">Not run yet.</p>
        )}
      </CardContent>
      <CardFooter className="gap-2 border-t pt-(--card-spacing)">
        {dataset.uses_model && (
          <div className="min-w-0 flex-1">
            <Label htmlFor={`mode-${dataset.id}`} className="sr-only">
              Mode
            </Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "offline" | "live")}>
              <SelectTrigger id={`mode-${dataset.id}`} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="offline">Offline stand-in</SelectItem>
                <SelectItem value="live" disabled={!hasApiKey}>
                  Live model{hasApiKey ? "" : " (needs API key)"}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <Label htmlFor={`trials-${dataset.id}`} className="sr-only">
          Trials per case
        </Label>
        <Select value={trials} onValueChange={setTrials}>
          <SelectTrigger id={`trials-${dataset.id}`} size="sm" className="w-24 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["1", "3", "5"].map((n) => (
              <SelectItem key={n} value={n}>
                {n === "1" ? "1 trial" : `${n} trials`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="ml-auto shrink-0"
          disabled={busy || !mayRun}
          title={mayRun ? undefined : "Running evals needs the reviewer role"}
          onClick={() => onRun({ dataset: dataset.id, mode, trials: Number(trials) })}
        >
          <Play /> Run
        </Button>
      </CardFooter>
    </Card>
  );
}

function History({ results }: { results: EvalRunSummary[] }) {
  if (!results.length) {
    return (
      <EmptyState icon={<Gauge />} title="No eval runs yet">
        Run a dataset above, or from a terminal: <Mono>make eval</Mono>.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Dataset</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead className="w-48">Cases</TableHead>
            <TableHead className="hidden md:table-cell">Checks</TableHead>
            <TableHead className="hidden lg:table-cell">p95</TableHead>
            <TableHead>Gate</TableHead>
            <TableHead className="hidden sm:table-cell">Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link to={`/evals/${encodeURIComponent(r.id)}`} className="font-medium hover:underline">
                  {r.dataset_title}
                </Link>
                {r.trials > 1 && <span className="text-xs text-muted-foreground"> · {r.trials} trials</span>}
              </TableCell>
              <TableCell>
                <EvalModeBadge mode={r.mode} />
              </TableCell>
              <TableCell>
                {r.summary ? (
                  <PassRateMeter passed={r.summary.passed} total={r.summary.cases} label="" />
                ) : (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {r.done_cases}/{r.total_cases} done
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden text-xs tabular-nums md:table-cell">
                {r.summary ? `${r.summary.checks_passed}/${r.summary.checks}` : "—"}
              </TableCell>
              <TableCell className="hidden text-xs tabular-nums lg:table-cell">{formatDuration(r.summary?.p95_ms)}</TableCell>
              <TableCell>
                {r.status === "completed" && r.summary ? (
                  <VerdictBadge passed={r.summary.gate} />
                ) : (
                  <EvalStatusBadge status={r.status} />
                )}
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{formatWhen(r.started_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function EvalsPage() {
  const navigate = useNavigate();
  const status = useStatus();
  const results = useQuery({
    queryKey: ["eval-results"],
    queryFn: () => apiAll<EvalRunSummary>("/evals/results"),
    refetchInterval: 3000,
  });
  const datasets = useQuery({ queryKey: ["eval-datasets"], queryFn: () => apiAll<EvalDatasetSummary>("/evals/datasets") });
  const running = results.data?.find((r) => r.status === "running");
  const start = useMutation({
    mutationFn: (request: StartEval) => api<{ id: string }>("/evals/runs", { method: "POST", json: request }),
    onSuccess: (data) => void navigate(`/evals/${encodeURIComponent(data.id)}`),
    onError: (error) => toast.error("The eval could not start", { description: String(error) }),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Evals"
        description={
          <>
            Versioned datasets that grade the replay engine, probe classification and the discovery agent, each case in its own
            sandbox. Also from a terminal: <Mono>make eval</Mono> · <Mono>make eval-live</Mono>.
          </>
        }
        actions={
          running && (
            <Button asChild variant="outline">
              <Link to={`/evals/${encodeURIComponent(running.id)}`}>
                Running: {running.dataset_title} <ArrowRight />
              </Link>
            </Button>
          )
        }
      />

      <section aria-label="Datasets" data-tour="evals" className="grid gap-4 lg:grid-cols-3">
        {datasets.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}
        {datasets.data?.map((d) => (
          <DatasetCard
            key={d.id}
            dataset={d}
            hasApiKey={!!status.data?.has_api_key}
            busy={!!running || start.isPending}
            onRun={(request) => start.mutate(request)}
          />
        ))}
      </section>

      <section aria-label="History" className="space-y-3">
        <h2 className="text-sm font-medium">History</h2>
        {results.isLoading ? <Skeleton className="h-32" /> : <History results={results.data ?? []} />}
      </section>
    </div>
  );
}
