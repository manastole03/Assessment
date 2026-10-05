import { useMutation } from "@tanstack/react-query";
import { KeyRound, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStatus } from "@/hooks/use-status";
import { useAuth } from "@/features/auth/auth-context";
import { api, type RunStarted, type StartRun } from "@/lib/api";

const PRESETS = [
  {
    label: "Sign-on (session capability)",
    goal: "Sign on to LegacyCore with the operator's service account",
    kind: "session" as const,
    id: "legacycore.session.sign_on",
    inputs: [] as [string, string][],
  },
  {
    label: "Member savings balance",
    goal: "Look up member 12345 and read their current share savings balance and the member's name",
    kind: "task" as const,
    id: "legacycore.member.get_savings_balance",
    inputs: [["member_id", "12345"]] as [string, string][],
  },
];

export default function DiscoverPage() {
  const navigate = useNavigate();
  const status = useStatus();
  const [goal, setGoal] = useState(PRESETS[1].goal);
  const [kind, setKind] = useState<"task" | "session">("task");
  const [capabilityId, setCapabilityId] = useState(PRESETS[1].id);
  const [tenant, setTenant] = useState("acme");
  const [inputs, setInputs] = useState<[string, string][]>(PRESETS[1].inputs);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [maxTurns, setMaxTurns] = useState(30);

  const start = useMutation({
    mutationFn: (request: StartRun) => api<RunStarted>("/runs", { method: "POST", json: request }),
    onSuccess: (data) => navigate(`/runs/${encodeURIComponent(data.id)}`),
    onError: (e) => toast.error("Discovery could not start", { description: String(e) }),
  });
  const hasKey = !!status.data?.has_api_key;
  const mayDiscover = useAuth().can("REVIEWER");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discover a capability"
        description="The model accomplishes the goal on the live app once; the run is recorded as a draft artifact for review."
      />
      {status.data && !hasKey && (
        <Alert>
          <KeyRound />
          <AlertTitle>Discovery needs an Anthropic API key</AlertTitle>
          <AlertDescription>
            Add <code className="font-mono">ANTHROPIC_API_KEY=…</code> to <code className="font-mono">.env</code> and restart the
            engine. Replay, review and handoff work without it.
          </AlertDescription>
        </Alert>
      )}
      {!mayDiscover && (
        <Alert>
          <AlertTitle>Discovery is for reviewers</AlertTitle>
          <AlertDescription>
            It calls the model and records a draft for review, so it needs the reviewer role. You can still read every capability
            and run.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Goal</CardTitle>
            <CardDescription>
              Input values are hidden from the model: it only ever sees <code className="font-mono">{"{{inputs.name}}"}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                start.mutate({
                  kind: "discovery",
                  goal,
                  tenant,
                  discoveryKind: kind,
                  capabilityId: capabilityId || undefined,
                  inputs: Object.fromEntries(inputs.filter(([k]) => k.trim())),
                  model: model || undefined,
                  effort,
                  maxTurns,
                });
              }}
            >
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button
                    key={p.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setGoal(p.goal);
                      setKind(p.kind);
                      setCapabilityId(p.id);
                      setInputs(p.inputs);
                    }}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="goal">What should it accomplish?</Label>
                <Textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} required />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Kind</Label>
                  <Select value={kind} onValueChange={(v) => setKind(v as "task" | "session")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="task">Task (starts signed on)</SelectItem>
                      <SelectItem value="session">Session (records sign-on)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="cap-id">Capability id</Label>
                  <Input
                    id="cap-id"
                    value={capabilityId}
                    onChange={(e) => setCapabilityId(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Inputs (name → value used for this run)</Label>
                {inputs.map(([name, value], i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={name}
                      onChange={(e) => setInputs(inputs.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))}
                      placeholder="name"
                      className="font-mono text-xs"
                      aria-label="Input name"
                    />
                    <Input
                      value={value}
                      onChange={(e) => setInputs(inputs.map((row, j) => (j === i ? [row[0], e.target.value] : row)))}
                      placeholder="value"
                      aria-label="Input value"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setInputs(inputs.filter((_, j) => j !== i))}
                      aria-label="Remove input"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setInputs([...inputs, ["", ""]])}>
                  <Plus /> Add input
                </Button>
              </div>
              <Button type="submit" disabled={!hasKey || !mayDiscover || start.isPending}>
                <Sparkles /> {start.isPending ? "Starting…" : "Start discovery"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Run settings</CardTitle>
            <CardDescription>Discovery happens once per capability; quality matters more than cost.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <div className="grid gap-1.5">
              <Label>Model</Label>
              <Select value={model || "default"} onValueChange={(v) => setModel(v === "default" ? "" : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default ({status.data?.model ?? "claude-opus-5-5"})</SelectItem>
                  <SelectItem value="claude-opus-5-5">Claude Opus 5.5</SelectItem>
                  <SelectItem value="claude-sonnet-5-5">Claude Sonnet 5.5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Effort</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["low", "medium", "high", "xhigh"].map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="turns">Max turns</Label>
              <Input
                id="turns"
                type="number"
                min={3}
                max={80}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Stuck detection is automatic: three unchanged screens or three failed actions in a row hand the session to a person.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
