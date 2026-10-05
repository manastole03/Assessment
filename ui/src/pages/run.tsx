import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock, FileText, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { CodeBlock } from "@/components/code-block";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/run/events-table";
import { InterventionPanel } from "@/components/run/intervention-panel";
import { LiveView } from "@/components/run/live-view";
import { ResultCard } from "@/components/run/result-card";
import { TimelineView } from "@/components/run/timeline-view";
import { TranscriptView } from "@/components/run/transcript-view";
import { KindBadge, RunStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sendInput, useOperatorState, type Lease } from "@/hooks/use-operator";
import { useRunStream } from "@/hooks/use-run-stream";
import { api, runFile, type RunDetail } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { buildTimeline, buildTranscript } from "@/lib/timeline";

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!since) return null;
  return <span className="tabular-nums">{formatDuration(now - new Date(since).getTime())}</span>;
}

export default function RunPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { events, ended } = useRunStream(id);
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<RunDetail>(`/runs/${encodeURIComponent(id)}`) });
  const live = !!run.data?.active && !ended;
  const operator = useOperatorState(id, live);
  const [lease, setLease] = useState<Lease>();

  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: ["run", id] });
  }, [ended, id, queryClient]);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const transcript = useMemo(() => buildTranscript(events), [events]);

  if (run.isLoading) return <Skeleton className="h-96 w-full" />;
  if (run.error || !run.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">This run could not be loaded: {String(run.error)}</p>
        <Button asChild variant="outline">
          <Link to="/runs">
            <ArrowLeft /> All runs
          </Link>
        </Button>
      </div>
    );
  }

  const data = run.data;
  const status = ended ? data.status : live ? "running" : data.status;
  const inControl = !!lease && operator.data?.control.state === "human";
  const lastScreenshot = timeline.screenshots.at(-1)?.path;

  const liveView = (
    <LiveView
      runId={id}
      interactive={inControl}
      onClickAt={(x, y) => {
        if (!lease) return;
        sendInput(id, lease, { kind: "click", x, y })
          .then(() => queryClient.invalidateQueries({ queryKey: ["operator", id] }))
          .catch((e: unknown) => toast.error("Click rejected", { description: String(e) }));
      }}
    />
  );

  const rerun = () => {
    const capability =
      typeof data.result?.capability === "object" && data.result.capability ? data.result.capability.id : data.subject;
    void navigate(`/run?capability=${encodeURIComponent(capability.split("@")[0])}&tenant=${data.tenant ?? "acme"}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="[overflow-wrap:anywhere]">{data.subject}</span>}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={status} />
            <KindBadge kind={data.kind} />
            {data.tenant && <span>tenant {data.tenant}</span>}
            {data.requestedBy && <span>started by {data.requestedBy.name}</span>}
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden />
              {live ? <Elapsed since={data.startedAt} /> : formatDuration(data.result?.duration_ms ?? data.durationMs)}
            </span>
            <code className="hidden font-mono text-[11px] md:inline">{data.id}</code>
          </div>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/runs">
                <ArrowLeft /> Runs
              </Link>
            </Button>
            {data.kind === "replay" && !live && (
              <Button variant="outline" size="sm" onClick={rerun}>
                <RotateCcw /> Run again
              </Button>
            )}
            {data.hasReport && !live && (
              <Button asChild variant="outline" size="sm">
                <a href={runFile(data.id, "report.html")} target="_blank" rel="noreferrer">
                  <FileText /> Report
                </a>
              </Button>
            )}
          </>
        }
      />

      {live && operator.data && (
        <InterventionPanel
          runId={id}
          state={operator.data}
          lease={lease}
          setLease={setLease}
          liveView={inControl ? liveView : undefined}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Tabs defaultValue={data.kind === "discovery" ? "agent" : "timeline"}>
            <TabsList>
              {data.kind === "discovery" && <TabsTrigger value="agent">Agent</TabsTrigger>}
              <TabsTrigger value="timeline">Steps</TabsTrigger>
              <TabsTrigger value="events">Events ({events.length})</TabsTrigger>
              {Object.keys(data.files).length > 0 && <TabsTrigger value="files">Artifacts</TabsTrigger>}
            </TabsList>
            {data.kind === "discovery" && (
              <TabsContent value="agent" className="pt-3">
                <TranscriptView items={transcript} runId={id} />
              </TabsContent>
            )}
            <TabsContent value="timeline" className="pt-3">
              <TimelineView timeline={timeline} runId={id} />
            </TabsContent>
            <TabsContent value="events" className="pt-3">
              <EventsTable events={events} />
            </TabsContent>
            <TabsContent value="files" className="space-y-4 pt-3">
              {Object.entries(data.files).map(([name, text]) => (
                <div key={name} className="space-y-1.5">
                  <div className="font-mono text-xs text-muted-foreground">{name}</div>
                  <CodeBlock code={text} />
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </div>

        <div className="order-first space-y-4 lg:order-none lg:col-span-2">
          {live ? (
            !inControl && (
              <Card>
                <CardHeader>
                  <CardTitle>Live session</CardTitle>
                </CardHeader>
                <CardContent>{liveView}</CardContent>
              </Card>
            )
          ) : (
            <ResultCard run={{ ...data, status }} lastScreenshot={lastScreenshot} />
          )}
        </div>
      </div>
    </div>
  );
}
