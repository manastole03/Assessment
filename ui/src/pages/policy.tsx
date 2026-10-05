import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/page-header";
import { HandlerKindBadge, RiskBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type PolicyResponse } from "@/lib/api";
import { locatorText } from "@/lib/format";

function Chips({ items, mono = true }: { items: string[]; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <Badge key={i} variant="outline" className={mono ? "font-mono text-[11px] font-normal" : "font-normal"}>
          {i}
        </Badge>
      ))}
    </div>
  );
}

export default function PolicyPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["policy"],
    queryFn: () => api<PolicyResponse>("/policy"),
  });
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const p = data.policy;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Policy & tenants"
        description="Guardrails enforced at the network, action and artifact layers; vendor knowledge shared by every tenant; per-tenant overrides."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Allowlist</CardTitle>
            <CardDescription>The browser aborts any request outside these origins, whatever the agent chose.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Chips items={p.allowed_origins} />
            {p.blocked_url_patterns.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Blocked URL patterns</div>
                <Chips items={p.blocked_url_patterns} />
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Irreversible actions</CardTitle>
            <CardDescription>
              The model never commits on its own; replay needs approval plus per-run confirmation.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <span className="text-muted-foreground">Discovery</span>
            <span>
              <code className="font-mono">{p.discovery.irreversible}</code> · actions{" "}
              <Chips items={p.discovery.allowed_actions} />
            </span>
            <span className="text-muted-foreground">Replay</span>
            <span>
              <code className="font-mono">{p.replay.irreversible}</code>
              {p.replay.require_approved && " · approved capabilities only"} · actions <Chips items={p.replay.allowed_actions} />
            </span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Risk rules & blocked targets</CardTitle>
          <CardDescription>
            Matched against a control's accessible name, visual label and button value at action time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Effect</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.risk_rules.map((r, i) => (
                <TableRow key={`r${i}`}>
                  <TableCell>
                    <RiskBadge risk={r.risk} />
                  </TableCell>
                  <TableCell className="max-w-md font-mono text-xs whitespace-normal">{r.name_pattern}</TableCell>
                  <TableCell className="text-xs whitespace-normal">{r.reason}</TableCell>
                </TableRow>
              ))}
              {p.blocked_targets.map((r, i) => (
                <TableRow key={`b${i}`}>
                  <TableCell>
                    <Badge variant="outline" className="border-red-600/25 bg-red-500/10 text-red-800 dark:text-red-300">
                      Blocked
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md font-mono text-xs whitespace-normal">{r.name_pattern}</TableCell>
                  <TableCell className="text-xs whitespace-normal">{r.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 space-y-1">
            <div className="text-xs text-muted-foreground">
              Sensitive labels — values next to these are masked in screenshots and text
            </div>
            <Chips items={p.sensitive_labels} />
          </div>
        </CardContent>
      </Card>

      {data.apps.map((app) => (
        <Card key={app.id}>
          <CardHeader>
            <CardTitle>App profile · {app.product}</CardTitle>
            <CardDescription>
              Vendor knowledge shared by every capability and tenant: session capability{" "}
              <code className="font-mono">{app.session_capability ?? "none"}</code>, locator preference{" "}
              <code className="font-mono">{app.locator_preference.join(" → ")}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {app.handlers.map((h) => (
              <div key={h.id} className="space-y-1 rounded-md border p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs font-medium">{h.id}</code>
                  <HandlerKindBadge kind={h.kind} />
                </div>
                <p className="text-xs text-muted-foreground">{h.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        {data.tenants.map((t) => (
          <Card key={t.id}>
            <CardHeader>
              <CardTitle>{t.name}</CardTitle>
              <CardDescription className="font-mono text-xs">tenant {t.id}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {Object.entries(t.apps).map(([appId, binding]) => (
                <div key={appId} className="space-y-2">
                  <div className="grid gap-1 text-xs sm:grid-cols-[7rem_1fr]">
                    <span className="text-muted-foreground">App</span>
                    <span className="font-mono">
                      {appId} v{binding.product_version ?? "?"}
                    </span>
                    <span className="text-muted-foreground">Base URL</span>
                    <span className="font-mono break-all">{binding.base_url}</span>
                    <span className="text-muted-foreground">Secrets</span>
                    <span className="font-mono">{Object.keys(binding.secrets).join(", ")} (names only)</span>
                  </div>
                  {binding.overrides?.length ? (
                    binding.overrides.map((o, i) => (
                      <div key={i} className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                        <div className="font-medium">
                          Override · {o.capability} {o.versions}
                        </div>
                        <div className="text-muted-foreground">{o.reason}</div>
                        {Object.entries(o.steps ?? {}).map(([step, patch]) => (
                          <div key={step}>
                            <code className="font-mono">{step}</code>: prepend{" "}
                            {(patch.prepend_locators ?? []).map((l) => locatorText(l)).join("; ")}
                          </div>
                        ))}
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">No overrides — runs the shared artifacts as recorded.</p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
