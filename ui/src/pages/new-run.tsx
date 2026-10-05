import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Hand, Play, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { CapabilityStatusBadge, SensitivityBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useStatus } from "@/hooks/use-status";
import { useAuth } from "@/features/auth/auth-context";
import { useDemoEnabled } from "@/hooks/use-runs";
import { api, apiAll, type CapabilitySummary, type DemoMember, type RunStarted, type StartRun } from "@/lib/api";
import { text } from "@/lib/format";
import { SCENARIOS } from "@/lib/scenarios";

const FAULTS: { key: string; label: string; help: string; kind: "bool" | "number"; placeholder?: string }[] = [
  {
    key: "maintenance_notice",
    label: "Maintenance interstitial",
    help: "An HTML notice page in place of the requested page.",
    kind: "bool",
  },
  {
    key: "session_warning_dialog",
    label: "Session-expiry warning",
    help: "A native confirm() dialog on the next page load.",
    kind: "bool",
  },
  {
    key: "transient_errors",
    label: "HTTP 503 errors",
    help: "The next N pages return 'service temporarily unavailable'.",
    kind: "number",
    placeholder: "0",
  },
  {
    key: "session_expire_after",
    label: "Session timeout after N pages",
    help: "The session expires; replay must sign on again.",
    kind: "number",
    placeholder: "off",
  },
  {
    key: "slow_ms",
    label: "Slow pages (ms)",
    help: "Delay every page; absorbed by condition-based waits.",
    kind: "number",
    placeholder: "0",
  },
  {
    key: "compliance_popup",
    label: "Unknown attestation screen",
    help: "No automation knows it — forces a human handoff.",
    kind: "bool",
  },
  {
    key: "vendor_upgrade",
    label: "Vendor redesign",
    help: "The search screen changes overnight — a hard failure.",
    kind: "bool",
  },
];

export default function NewRunPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = useStatus();
  const auth = useAuth();
  const demo = useDemoEnabled();
  const mayRun = auth.can("OPERATOR");
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: () => apiAll<CapabilitySummary>("/capabilities") });
  const members = useQuery({
    queryKey: ["demo-members"],
    queryFn: () => apiAll<DemoMember>("/demo/members"),
    enabled: demo,
  });

  const tasks = useMemo(() => (capabilities.data ?? []).filter((c) => c.kind === "task"), [capabilities.data]);
  const [chosenCapability, setCapabilityId] = useState(params.get("capability") ?? "");
  const [tenant, setTenant] = useState(params.get("tenant") ?? "acme");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [escalation, setEscalation] = useState<"wait" | "fail">("wait");
  const [allowDraft, setAllowDraft] = useState(false);
  const [faults, setFaults] = useState<Record<string, unknown>>({});

  // Until the user picks one, default to the first task capability (derived, not synced via an effect).
  const capabilityId = chosenCapability || (tasks[0]?.id ?? "");
  const capability = tasks.find((c) => c.id === capabilityId);

  const start = useMutation({
    mutationFn: (request: StartRun) => api<RunStarted>("/runs", { method: "POST", json: request }),
    onSuccess: (data) => void navigate(`/runs/${encodeURIComponent(data.id)}`),
    onError: (error) => toast.error("The run could not start", { description: String(error) }),
  });

  const submit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capability) return;
    const cleanFaults = Object.fromEntries(Object.entries(faults).filter(([, v]) => v !== "" && v !== false && v != null));
    start.mutate({
      kind: "replay",
      capability: capability.id,
      tenant,
      inputs,
      escalation,
      allowDraft,
      // Demo deployments reset the mock before each run (an empty object clears its faults).
      ...(demo ? { faults: cleanFaults } : {}),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Run a capability"
        description="Deterministic replay: the recorded artifact drives the live app with no model in the loop."
      />

      {!mayRun && (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          You can browse capabilities, but starting a run needs the operator role. Ask an administrator.
        </p>
      )}

      {demo && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Zap className="size-4" aria-hidden /> One-click scenarios
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={start.isPending || !mayRun}
                onClick={() => start.mutate(s.request)}
                className="group rounded-lg border bg-card p-3.5 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40 disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{s.title}</span>
                  <Play className="size-3.5 text-muted-foreground group-hover:text-foreground" aria-hidden />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-5" data-tour="run-form">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Custom run</CardTitle>
            <CardDescription>Choose the capability, the institution and the inputs a calling agent would send.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Capability</Label>
                <Select value={capabilityId} onValueChange={setCapabilityId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {tasks.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.title} · v{c.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Tenant</Label>
                <Select value={tenant} onValueChange={setTenant}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(status.data?.tenants ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {capability && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CapabilityStatusBadge status={capability.status} />
                <span>{capability.description}</span>
              </div>
            )}

            {capability &&
              Object.entries(capability.inputs).map(([name, spec]) => {
                const value = inputs[name] ?? "";
                const invalid = !!value && !!spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(value);
                return (
                  <div key={name} className="grid gap-1.5">
                    <Label htmlFor={`in-${name}`} className="flex items-center gap-2">
                      <code className="font-mono">{name}</code> <SensitivityBadge sensitivity={spec.sensitivity} />
                    </Label>
                    <Input
                      id={`in-${name}`}
                      value={value}
                      onChange={(e) => setInputs({ ...inputs, [name]: e.target.value })}
                      placeholder={spec.description}
                      aria-invalid={invalid}
                      required={spec.required !== false}
                    />
                    {invalid ? (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Doesn't match <code>{spec.pattern}</code> — replay will reject it before touching the UI (try it).
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{spec.description}</p>
                    )}
                    {name === "member_id" && members.data && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {members.data.map((m) => (
                          <button key={m.member_id} type="button" onClick={() => setInputs({ ...inputs, [name]: m.member_id })}>
                            <Badge variant={value === m.member_id ? "default" : "outline"} className="cursor-pointer font-normal">
                              <span className="font-mono">{m.member_id}</span> · {m.label}
                            </Badge>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

            <div className="grid gap-2">
              <Label>If the run reaches a screen it doesn't recognise</Label>
              <RadioGroup
                value={escalation}
                onValueChange={(v) => setEscalation(v as "wait" | "fail")}
                className="grid gap-2 sm:grid-cols-2"
              >
                <Label
                  htmlFor="esc-wait"
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem id="esc-wait" value="wait" className="mt-0.5" />
                  <span>
                    <span className="flex items-center gap-1.5 font-medium">
                      <Hand className="size-3.5" aria-hidden /> Pause for an operator
                    </span>
                    <span className="text-xs text-muted-foreground">You can take over the live session here.</span>
                  </span>
                </Label>
                <Label
                  htmlFor="esc-fail"
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem id="esc-fail" value="fail" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Fail fast</span>
                    <span className="block text-xs text-muted-foreground">Return a structured failure with evidence.</span>
                  </span>
                </Label>
              </RadioGroup>
            </div>

            {capability?.status !== "approved" && auth.can("REVIEWER") && (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="text-sm">
                  <div className="font-medium">Allow a draft</div>
                  <div className="text-xs text-muted-foreground">Drafts never run unattended; this is a supervised trial.</div>
                </div>
                <Switch checked={allowDraft} onCheckedChange={setAllowDraft} aria-label="Allow draft" />
              </div>
            )}

            <Button type="submit" disabled={!capability || start.isPending || !mayRun} className="w-full sm:w-auto">
              <Play /> {start.isPending ? "Starting…" : "Start replay"}
            </Button>
          </CardContent>
        </Card>

        {demo && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="size-4" aria-hidden /> Inject runtime faults
              </CardTitle>
              <CardDescription>
                Demo controls for the bundled mock app. Applied to <span className="font-mono">{tenant}</span> just before the
                run.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {FAULTS.map((f) => (
                <div key={f.key} className="flex items-start justify-between gap-3">
                  <Label htmlFor={`fault-${f.key}`} className="grid gap-0.5 font-normal">
                    <span className="text-sm font-medium">{f.label}</span>
                    <span className="text-xs text-muted-foreground">{f.help}</span>
                  </Label>
                  {f.kind === "bool" ? (
                    <Switch
                      id={`fault-${f.key}`}
                      checked={!!faults[f.key]}
                      onCheckedChange={(v) => {
                        setFaults({ ...faults, [f.key]: v });
                        if (v && f.key === "compliance_popup") setEscalation("wait");
                      }}
                    />
                  ) : (
                    <Input
                      id={`fault-${f.key}`}
                      type="number"
                      min={0}
                      className="w-20"
                      placeholder={f.placeholder}
                      value={text(faults[f.key])}
                      onChange={(e) => setFaults({ ...faults, [f.key]: e.target.value === "" ? "" : Number(e.target.value) })}
                    />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </form>
    </div>
  );
}
