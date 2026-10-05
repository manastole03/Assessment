import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, Play } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { KindBadge, RunStatusBadge } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStatus } from "@/hooks/use-status";
import { useAuth } from "@/features/auth/auth-context";
import { useDemoEnabled, useRecentRuns, useRunCount } from "@/hooks/use-runs";
import { api, apiAll, type CapabilitySummary, type RunStarted, type StartRun } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { SCENARIOS } from "@/lib/scenarios";

const FLOW = [
  { title: "Discover", text: "The model flies the task once on the real UI.", to: "/discover" },
  { title: "Review", text: "The run becomes a typed, versioned plan you approve.", to: "/capabilities" },
  { title: "Replay", text: "Deterministic, no model aboard; known errors recovered.", to: "/run" },
  { title: "Hand off", text: "Unknown screen: a person takes the same live session.", to: "/run" },
];

/** The four stages as a route: waypoints on one line, like the landing page's flight rail. */
function Route() {
  return (
    <nav aria-label="How it works" className="relative">
      <div aria-hidden className="absolute top-[7px] right-[12.5%] left-[12.5%] hidden h-px bg-border sm:block" />
      <ol className="relative grid gap-6 sm:grid-cols-4">
        {FLOW.map(({ title, text, to }, i) => (
          <li key={title}>
            <Link to={to} className="group flex flex-col items-start gap-3 sm:items-center sm:text-center">
              <span className="relative grid size-[15px] place-items-center rounded-full border-[1.5px] border-sky bg-background transition-colors duration-300 group-hover:bg-sky">
                <span className="size-[5px] rounded-full bg-sky group-hover:bg-background" />
              </span>
              <span className="annotation text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-heading text-xl leading-none text-foreground group-hover:text-sky-ink">{title}</span>
              <span className="max-w-[16rem] text-sm leading-snug font-light text-muted-foreground">{text}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Readings in a hairline row: label, figure, detail. No card chrome. */
function Readings({ items }: { items: [string, number, string][] }) {
  return (
    <dl aria-label="At a glance" className="grid grid-cols-2 border-y lg:grid-cols-4">
      {items.map(([label, value, detail], i) => (
        <div key={label} className={i > 0 ? "border-l py-5 pl-5" : "py-5 pr-5"}>
          <dt className="label-caps text-[0.62rem] text-muted-foreground">{label}</dt>
          <dd className="mt-3 font-heading text-[2.6rem] leading-none text-foreground">{value}</dd>
          <dd className="mt-2 annotation text-muted-foreground">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const status = useStatus();
  const auth = useAuth();
  const demo = useDemoEnabled();
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: () => apiAll<CapabilitySummary>("/capabilities") });
  const recent = useRecentRuns(8);
  const total = useRunCount();
  const succeeded = useRunCount("succeeded");
  const outcomes = useRunCount("business_outcome");
  const failed = useRunCount("failed");
  const errored = useRunCount("error");
  const start = useMutation({
    mutationFn: (request: StartRun) => api<RunStarted>("/runs", { method: "POST", json: request }),
    onSuccess: (data) => void navigate(`/runs/${encodeURIComponent(data.id)}`),
    onError: (e) => toast.error("The run could not start", { description: String(e) }),
  });

  const caps = capabilities.data ?? [];
  const all = recent.data ?? [];
  const offline = status.data?.tenants.filter((t) => !t.reachable) ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Operations"
        title="Capability studio"
        description="Teach automation a back-office task once, then run it reliably — and safely hand it to a person when it can't proceed."
        actions={
          <Button asChild>
            <Link to="/run">
              <Play /> Run a capability
            </Link>
          </Button>
        }
      />

      {offline.length > 0 && (
        <Alert>
          <Bot />
          <AlertTitle>The LegacyCore mock isn't running</AlertTitle>
          <AlertDescription>
            Start it in another terminal with <code className="font-mono">make bank</code>, then refresh. (
            {offline.map((t) => t.id).join(", ")} unreachable)
          </AlertDescription>
        </Alert>
      )}

      <Route />

      <Readings
        items={[
          ["Approved capabilities", caps.filter((c) => c.status === "approved").length, `${caps.length} in the library`],
          ["Runs succeeded", succeeded.data ?? 0, `of ${total.data ?? 0} recorded runs`],
          ["Business outcomes", outcomes.data ?? 0, "legitimate answers, not errors"],
          ["Failures with evidence", (failed.data ?? 0) + (errored.data ?? 0), "expected vs observed + screenshot"],
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" data-tour="scenarios">
          <CardHeader>
            <CardTitle>Try a scenario</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {!demo && (
              <p className="text-sm text-muted-foreground">
                Scenarios drive the bundled LegacyCore mock; this deployment has demo controls turned off.
              </p>
            )}
            {demo && !auth.can("OPERATOR") && (
              <p className="text-xs text-muted-foreground">Running scenarios needs the operator role.</p>
            )}
            {demo &&
              SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={start.isPending || !auth.can("OPERATOR")}
                  onClick={() => start.mutate(s.request)}
                  className="flex items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
                >
                  <span>
                    <span className="text-sm font-medium">{s.title}</span>
                    <span className="block text-xs text-muted-foreground">{s.description}</span>
                  </span>
                  <RunStatusBadge status={s.expect} className="shrink-0" />
                </button>
              ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <Link to="/runs">
                  All <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {all.slice(0, 8).map((r) => (
              <Link
                key={r.id}
                to={`/runs/${encodeURIComponent(r.id)}`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{r.subject}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <KindBadge kind={r.kind} /> {r.tenant} · {formatWhen(r.startedAt)}
                  </span>
                </span>
                <RunStatusBadge status={r.active ? "running" : r.status} className="shrink-0" />
              </Link>
            ))}
            {!all.length && <p className="text-sm text-muted-foreground">No runs yet — try a scenario.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
