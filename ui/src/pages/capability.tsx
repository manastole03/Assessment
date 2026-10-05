import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Layers, Play, ScanSearch, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CodeBlock } from "@/components/code-block";
import { PageHeader } from "@/components/page-header";
import { CapabilityStatusBadge, HandlerKindBadge, RiskBadge, SensitivityBadge, SourceBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/auth-context";
import { useStatus } from "@/hooks/use-status";
import { api, type Approval, type CapabilityDetail, type ParamSpec, type RunStarted, type Step } from "@/lib/api";
import { LOCATOR_WHY, formatWhen, locatorText } from "@/lib/format";

const BASE = "__base__";

function ParamTable({ params, empty }: { params: Record<string, ParamSpec>; empty: string }) {
  const rows = Object.entries(params);
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Sensitivity</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([name, spec]) => (
          <TableRow key={name}>
            <TableCell className="font-mono text-xs">{name}</TableCell>
            <TableCell className="text-xs">
              {spec.type}
              {spec.pattern && <div className="font-mono text-[11px] text-muted-foreground">{spec.pattern}</div>}
            </TableCell>
            <TableCell>
              <SensitivityBadge sensitivity={spec.sensitivity} />
            </TableCell>
            <TableCell className="text-xs whitespace-normal text-muted-foreground">{spec.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StepCard({ step, index, expect, overridden }: { step: Step; index: number; expect: string[]; overridden: number }) {
  const { action } = step;
  const target = action.target;
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <div className="z-10 grid size-6 shrink-0 place-items-center rounded-full border bg-background text-[11px] font-medium tabular-nums">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1 space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs font-medium">{step.id}</code>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {action.type}
            {action.output ? ` → ${action.output}` : ""}
          </Badge>
          <RiskBadge risk={step.risk} />
          {step.source && step.source !== "agent" && <SourceBadge source={step.source} />}
        </div>
        <p className="text-sm">{step.intent}</p>
        {action.url && <div className="font-mono text-xs text-muted-foreground">{action.url}</div>}
        {action.value && (
          <div className="text-xs">
            value <code className="font-mono">{action.value}</code>
          </div>
        )}
        {target && (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">
              Target: {target.description}
              {target.frame?.name && (
                <>
                  {" "}
                  · frame <code className="font-mono">{target.frame.name}</code>
                </>
              )}
            </div>
            <ol className="space-y-1">
              {target.locators.map((loc, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="w-4 shrink-0 pt-0.5 text-right text-muted-foreground tabular-nums">{i + 1}.</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="shrink-0 cursor-help font-mono text-[10px]">
                        {loc.by}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72">{LOCATOR_WHY[loc.by]}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 font-mono break-all">{locatorText(loc)}</span>
                  {i < overridden && <SourceBadge source="tenant" />}
                </li>
              ))}
            </ol>
          </div>
        )}
        {expect.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Then expect</span>
            {expect.map((e) => (
              <Badge key={e} variant="outline" className="font-normal whitespace-normal">
                {e}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function ApproveDialog({ reference, onDone }: { reference: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const [notes, setNotes] = useState("");
  const approve = useMutation({
    mutationFn: () =>
      api<Approval>(`/capabilities/${encodeURIComponent(reference)}/approve`, {
        method: "POST",
        json: notes.trim() ? { notes: notes.trim() } : {},
      }),
    onSuccess: (approval) => {
      toast.success(`${approval.ref} approved`, { description: `Recorded against ${approval.approvedBy.name}` });
      setOpen(false);
      onDone();
    },
    // The server explains rule failures (e.g. you recorded this draft yourself): show its words.
    onError: (e) => toast.error("Approval failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <ShieldCheck /> Approve
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {reference}</DialogTitle>
          <DialogDescription>
            Approved capabilities can run unattended and appear in the agent catalog. Check the steps, locators and handlers
            first.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            The approval is recorded against you ({user?.name}, {user?.email}). Whoever started the run that recorded a draft
            cannot approve it: a second reviewer must.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Review notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What you checked"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProbeDialog({ capability, inputs }: { capability: string; inputs: string[] }) {
  const navigate = useNavigate();
  const status = useStatus();
  const [values, setValues] = useState<Record<string, string>>({ member_id: "99999" });
  const probe = useMutation({
    mutationFn: () =>
      api<RunStarted>("/runs", { method: "POST", json: { kind: "probe", capability, tenant: "acme", inputs: values } }),
    onSuccess: (data) => navigate(`/runs/${encodeURIComponent(data.id)}`),
    onError: (e) => toast.error("Probe could not start", { description: String(e) }),
  });
  const disabled = !status.data?.has_api_key;
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={disabled}>
                <ScanSearch /> Probe an outcome
              </Button>
            </DialogTrigger>
          </span>
        </TooltipTrigger>
        {disabled && <TooltipContent>Needs ANTHROPIC_API_KEY in .env</TooltipContent>}
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Teach it a business outcome</DialogTitle>
          <DialogDescription>
            Replays this capability with an input that leaves the happy path. If it stops on a screen no handler knows, one model
            call classifies it and proposes a guarded handler as a new draft version for your review. The model never acts.
          </DialogDescription>
        </DialogHeader>
        {inputs.map((name) => (
          <div key={name} className="grid gap-1.5">
            <Label htmlFor={`probe-${name}`} className="font-mono">
              {name}
            </Label>
            <Input
              id={`probe-${name}`}
              value={values[name] ?? ""}
              onChange={(e) => setValues({ ...values, [name]: e.target.value })}
            />
          </div>
        ))}
        <DialogFooter>
          <Button onClick={() => probe.mutate()} disabled={probe.isPending}>
            Start probe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CapabilityPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const status = useStatus();
  const reviewer = useAuth().can("REVIEWER");
  const version = params.get("version") ?? "";
  const tenant = params.get("tenant") ?? "";
  const query = new URLSearchParams();
  if (version) query.set("version", version);
  if (tenant) query.set("tenant", tenant);
  const { data, isLoading, error } = useQuery({
    queryKey: ["capability", id, version, tenant],
    queryFn: () => api<CapabilityDetail>(`/capabilities/${encodeURIComponent(id)}?${query}`),
  });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== BASE) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error || !data)
    return (
      <p className="text-sm text-muted-foreground">
        Could not load {id}: {String(error)}
      </p>
    );

  const s = data.summary;
  const reference = `${s.id}@${s.version}`;
  const steps = data.capability.steps;

  return (
    <div className="space-y-6">
      <PageHeader
        title={s.title}
        description={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{reference}</code>
              <CapabilityStatusBadge status={s.status} />
              <RiskBadge risk={s.side_effects} />
              {s.requires_session && (
                <span className="text-xs">
                  needs session <code className="font-mono">{s.requires_session}</code>
                </span>
              )}
            </div>
            <p className="max-w-3xl">{s.description}</p>
          </div>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/capabilities">
                <ArrowLeft /> Library
              </Link>
            </Button>
            {s.kind === "task" && reviewer && <ProbeDialog capability={reference} inputs={Object.keys(s.inputs)} />}
            {s.status !== "approved" && reviewer && (
              <ApproveDialog reference={reference} onDone={() => queryClient.invalidateQueries({ queryKey: ["capability"] })} />
            )}
            {s.kind === "task" && (
              <Button asChild size="sm" variant={s.status === "approved" ? "default" : "outline"}>
                <Link to={`/run?capability=${s.id}${tenant ? `&tenant=${tenant}` : ""}`}>
                  <Play /> Run
                </Link>
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Version</Label>
          <Select value={version || s.version} onValueChange={(v) => set("version", v)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {s.versions.map((v) => (
                <SelectItem key={v.version} value={v.version}>
                  {v.version} · {v.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">View as</Label>
          <Select value={tenant || BASE} onValueChange={(v) => set("tenant", v)}>
            <SelectTrigger size="sm" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BASE}>Base artifact</SelectItem>
              {(status.data?.tenants ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} (effective)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {data.layers.length > 0 && (
        <div className="space-y-1.5 rounded-lg border p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <Layers className="size-3.5 text-muted-foreground" aria-hidden /> Effective artifact for {tenant}
            <code className="font-mono font-normal text-muted-foreground">{data.effective_hash}</code>
          </div>
          <ol className="space-y-1 pl-5">
            {data.layers.map((l, i) => (
              <li key={l} className="list-decimal">
                {l.includes("override") ? (
                  <span>
                    <SourceBadge source="tenant" /> {l.replace(/^tenant \S+ override: /, "")}
                  </span>
                ) : (
                  <span className="font-mono text-muted-foreground">{l}</span>
                )}
                {i === 0 && <span className="text-muted-foreground"> — shared base, recorded once</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      <Tabs defaultValue="steps">
        <TabsList className="flex-wrap">
          <TabsTrigger value="steps">Steps ({steps.length})</TabsTrigger>
          <TabsTrigger value="contract">Contract</TabsTrigger>
          <TabsTrigger value="handlers">Handlers ({data.handlers.length})</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
          <TabsTrigger value="provenance">Provenance</TabsTrigger>
        </TabsList>

        <TabsContent value="steps" className="pt-4">
          <ol className="relative before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border">
            {steps.map((step, i) => (
              <StepCard
                key={step.id}
                step={step}
                index={i}
                expect={data.expect_text[step.id] ?? []}
                overridden={data.overridden[step.id] ?? 0}
              />
            ))}
          </ol>
          <Card className="mt-5">
            <CardHeader>
              <CardTitle>Success checkpoint</CardTitle>
              <CardDescription>Verified after the last step; the run only succeeds if every condition holds.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {data.success_text.map((t) => (
                <Badge key={t} variant="outline" className="font-normal">
                  {t}
                </Badge>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contract" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Inputs</CardTitle>
              <CardDescription>
                Validated before any UI work. PII inputs never appear as values in artifacts, logs or model input.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ParamTable params={s.inputs} empty="No inputs." />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Outputs</CardTitle>
              <CardDescription>Typed; a mis-targeted read fails to parse instead of returning the wrong value.</CardDescription>
            </CardHeader>
            <CardContent>
              <ParamTable params={s.outputs} empty="No outputs." />
            </CardContent>
          </Card>
          {s.outcomes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Business outcomes</CardTitle>
                <CardDescription>Legitimate non-happy-path answers the caller must handle — not errors.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {s.outcomes.map((o) => (
                  <Badge key={o} variant="outline" className="font-mono">
                    {o}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}
          {data.tool && (
            <Card>
              <CardHeader>
                <CardTitle>As an agent tool</CardTitle>
                <CardDescription>What a calling agent sees in the catalog (`rote catalog`).</CardDescription>
              </CardHeader>
              <CardContent>
                <CodeBlock code={JSON.stringify(data.tool, null, 2)} language="json" maxHeight="20rem" />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="handlers" className="space-y-3 pt-4">
          <p className="text-sm text-muted-foreground">
            Known states, checked on every poll while a step waits. Tenant handlers win over capability handlers, which win over
            the vendor's app profile.
          </p>
          {data.handlers.map((h) => (
            <div key={`${h.source}-${h.id}`} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs font-medium">{h.id}</code>
                <HandlerKindBadge kind={h.kind} />
                <SourceBadge source={h.source} />
                {h.origin && h.origin !== "authored" && <SourceBadge source={h.origin} />}
              </div>
              <p className="text-sm text-muted-foreground">{h.description}</p>
              <div className="grid gap-1 text-xs sm:grid-cols-[5rem_1fr]">
                <span className="text-muted-foreground">when</span>
                <span>{h.when_text.join(" · ")}</span>
                {h.unless_text.length > 0 && (
                  <>
                    <span className="text-muted-foreground">unless</span>
                    <span>{h.unless_text.join(" · ")}</span>
                  </>
                )}
                {h.scope && (
                  <>
                    <span className="text-muted-foreground">only during</span>
                    <span className="font-mono">{h.scope.join(", ")}</span>
                  </>
                )}
                <span className="text-muted-foreground">then</span>
                <span>
                  {h.outcome ? (
                    <>
                      <code className="font-mono">{h.outcome.code}</code> — {h.outcome.message}
                    </>
                  ) : (
                    <code className="font-mono">{h.recovery?.do}</code>
                  )}
                </span>
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="yaml" className="pt-4">
          <CodeBlock code={data.yaml} maxHeight="40rem" />
        </TabsContent>

        <TabsContent value="provenance" className="pt-4">
          <Card>
            <CardContent className="grid gap-x-6 gap-y-2 pt-6 text-sm sm:grid-cols-[10rem_1fr]">
              <span className="text-muted-foreground">Method</span>
              <span>{s.provenance.method}</span>
              <span className="text-muted-foreground">Goal</span>
              <span>{s.provenance.goal}</span>
              <span className="text-muted-foreground">Model</span>
              <span>{s.provenance.model ?? "—"}</span>
              <span className="text-muted-foreground">Recorded</span>
              <span>
                {formatWhen(s.provenance.recorded_at)} on {s.provenance.tenant} (v{s.provenance.product_version})
              </span>
              <span className="text-muted-foreground">Source run</span>
              <span>
                {s.provenance.source_run ? (
                  <Link className="font-mono text-xs underline-offset-2 hover:underline" to={`/runs/${s.provenance.source_run}`}>
                    {s.provenance.source_run}
                  </Link>
                ) : (
                  "—"
                )}
              </span>
              <span className="text-muted-foreground">Review</span>
              <span>
                {s.provenance.review
                  ? `${s.provenance.review.reviewed_by}, ${formatWhen(s.provenance.review.reviewed_at)}${s.provenance.review.notes ? ` — ${s.provenance.review.notes}` : ""}`
                  : "Not reviewed yet"}
              </span>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
