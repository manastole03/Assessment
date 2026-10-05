import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, KeyRound, Plug, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { CodeBlock } from "@/components/code-block";
import { EmptyState, Mono, PageHeader } from "@/components/page-header";
import { RunStatusBadge } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-context";
import {
  api,
  apiAll,
  ApiError,
  apiPage,
  type ApiKey,
  type CreatedApiKey,
  hasRole,
  type Invocation,
  type InvokeRequest,
  type McpTool,
  type Role,
  type ToolProperty,
} from "@/lib/api";
import { formatDuration, formatWhen } from "@/lib/format";

const toCapability = (tool: string) => tool.replaceAll("__", ".");

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** A shell command: monospace, wraps, copyable. */
function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps text-muted-foreground">{title}</span>
        <CopyButton text={text} label={`Copy the ${title} command`} />
      </div>
      <pre className="rounded-sm border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

function Annotations({ tool }: { tool: McpTool }) {
  const a = tool.annotations ?? {};
  const hints: string[] = [
    a.readOnlyHint ? "read only" : a.destructiveHint ? "destructive" : "reversible",
    ...(a.idempotentHint ? ["idempotent"] : []),
    ...(a.openWorldHint === false ? ["closed world"] : []),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {hints.map((hint) => (
        <Badge key={hint} variant="outline">
          {hint}
        </Badge>
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: McpTool }) {
  const required = new Set(tool.inputSchema.required ?? []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tool.title ?? tool.name}</CardTitle>
        <CardDescription>
          <Mono>{tool.name}</Mono>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Annotations tool={tool} />
        <dl className="divide-y rounded-sm border">
          {Object.entries(tool.inputSchema.properties).map(([name, prop]) => (
            <div key={name} className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[9rem_1fr]">
              <dt className="font-mono">
                {name}
                {required.has(name) && <span className="text-muted-foreground"> *</span>}
              </dt>
              <dd className="text-muted-foreground">
                {prop.description}
                {prop.pattern && (
                  <>
                    {" "}
                    · pattern <Mono>{prop.pattern}</Mono>
                  </>
                )}
                {prop.enum && <> · one of {prop.enum.join(", ")}</>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{tool.description}</p>
      </CardContent>
    </Card>
  );
}

function Playground({ tools }: { tools: McpTool[] }) {
  const [toolName, setToolName] = useState(tools.at(0)?.name ?? "");
  const tool = tools.find((t) => t.name === toolName) ?? tools.at(0);
  const properties: Partial<Record<string, ToolProperty>> = tool?.inputSchema.properties ?? {};
  const tenants = properties.tenant?.enum ?? ["acme"];
  const [tenant, setTenant] = useState(tenants.at(0) ?? "acme");
  const [values, setValues] = useState<Partial<Record<string, string>>>({ member_id: "12345" });
  const [elapsed, setElapsed] = useState<number>();
  const fields = Object.entries(tool?.inputSchema.properties ?? {}).filter(([name]) => name !== "tenant");

  const invoke = useMutation({
    mutationFn: async (request: InvokeRequest) => {
      const t0 = performance.now();
      const result = await api<Invocation>(`/capabilities/${encodeURIComponent(toCapability(toolName))}/invoke`, {
        method: "POST",
        json: request,
      });
      setElapsed(performance.now() - t0);
      return result;
    },
  });

  if (!tool) return null;
  const error = invoke.error instanceof ApiError ? invoke.error : undefined;
  const request: InvokeRequest = {
    tenant,
    inputs: Object.fromEntries(fields.map(([name]): [string, string] => [name, values[name] ?? ""]).filter(([, v]) => v !== "")),
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Call a tool</CardTitle>
          <CardDescription>
            Exactly what an agent's tool call does: checked against the contract, then replayed with no model in the loop.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              invoke.mutate(request);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tool">Tool</Label>
                <Select value={toolName} onValueChange={setToolName}>
                  <SelectTrigger id="tool" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tools.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.title ?? t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tenant">Tenant</Label>
                <Select value={tenant} onValueChange={setTenant}>
                  <SelectTrigger id="tenant" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {fields.map(([name, prop]) => (
              <div key={name} className="space-y-1.5">
                <Label htmlFor={`in-${name}`}>
                  {name} <span className="font-normal text-muted-foreground">{prop.description}</span>
                </Label>
                <Input
                  id={`in-${name}`}
                  value={values[name] ?? ""}
                  placeholder={prop.pattern ?? prop.type}
                  className="font-mono"
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={invoke.isPending}>
                <Send /> {invoke.isPending ? "Running…" : "Invoke"}
              </Button>
              <span className="text-xs text-muted-foreground">Try 99999 (business outcome) or 12-AB (rejected).</span>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card aria-live="polite">
        <CardHeader>
          <CardTitle>What the agent receives</CardTitle>
          <CardDescription>The result contract, identical over REST and MCP.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {invoke.isPending && <Skeleton className="h-40" />}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>
                {error.status} · {error.message}
              </AlertTitle>
              {error.problems.length > 0 && (
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {error.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  Rejected before a browser started: nothing ran.
                </AlertDescription>
              )}
            </Alert>
          )}
          {invoke.data && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <RunStatusBadge status={invoke.data.status} />
                {elapsed !== undefined && <span className="tabular-nums">{formatDuration(Math.round(elapsed))}</span>}
                <Button asChild variant="outline" size="xs">
                  <Link to={`/runs/${encodeURIComponent(invoke.data.run_id)}`}>
                    Evidence <ArrowUpRight />
                  </Link>
                </Button>
              </div>
              <CodeBlock code={JSON.stringify(invoke.data, null, 2)} language="json" />
            </>
          )}
          {!invoke.data && !invoke.isPending && !error && (
            <p className="text-sm text-muted-foreground">Invoke a tool to see its result here.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const KEY_ROLES: Role[] = ["VIEWER", "OPERATOR", "REVIEWER", "ADMIN"];

/** Long-lived credentials for MCP clients and scripts. The secret is shown once; only a hash is kept. */
function ApiKeys() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => apiPage<ApiKey>("/api-keys?limit=50") });
  const roles = KEY_ROLES.filter((role) => hasRole(auth.role, role));
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(auth.can("OPERATOR") ? "OPERATOR" : "VIEWER");
  const [created, setCreated] = useState<CreatedApiKey>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  const create = useMutation({
    mutationFn: () => api<CreatedApiKey>("/api-keys", { method: "POST", json: { name: name.trim(), role } }),
    onSuccess: (data) => {
      setCreated(data);
      setName("");
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden /> API keys
        </CardTitle>
        <CardDescription>
          For MCP clients and scripts. A key acts as you, capped at the role you give it; calling tools needs operator.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Code on my laptop"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="key-role" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Create key
          </Button>
        </form>
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
        {created && (
          <Alert>
            <KeyRound />
            <AlertTitle>Copy this key now; it will not be shown again</AlertTitle>
            <AlertDescription>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 font-mono text-xs break-all text-foreground">{created.secret}</code>
                <CopyButton text={created.secret} label="Copy the API key" />
              </div>
            </AlertDescription>
          </Alert>
        )}
        {keys.data?.items.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {keys.data.items.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{key.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <Mono>{key.prefix}…</Mono> · {key.role.toLowerCase()} ·{" "}
                    {key.lastUsedAt ? `used ${formatWhen(key.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${key.name}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(key.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AgentsPage() {
  const auth = useAuth();
  const tools = useQuery({ queryKey: ["agent-tools"], queryFn: () => apiAll<McpTool>("/agents/tools") });
  const origin = window.location.origin;
  const mcp = `${origin}/api/v1/mcp`;
  const first = tools.data?.[0];
  const exampleInputs = first
    ? Object.fromEntries(
        Object.keys(first.inputSchema.properties)
          .filter((k) => k !== "tenant")
          .map((k) => [k, k === "member_id" ? "12345" : "…"]),
      )
    : {};

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Agent interface"
        title="Agents & MCP"
        description="Every approved capability is a tool. Any MCP client can list and call them; each call is checked against the contract, replayed deterministically, and shows up live under Runs with full evidence."
      />

      <section
        data-tour="agents"
        aria-label="Connect"
        className="grid gap-px overflow-hidden rounded-sm border bg-border lg:grid-cols-3"
      >
        <div className="space-y-3 bg-card p-5">
          <div className="label-caps text-muted-foreground">MCP endpoint · Streamable HTTP</div>
          <div className="flex items-center gap-2">
            <Plug className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 font-mono text-base break-all">{mcp}</span>
            <CopyButton text={mcp} label="Copy the MCP endpoint" />
          </div>
          <p className="text-xs text-muted-foreground">
            Authenticated: send an API key as <Mono>Authorization: Bearer …</Mono>. Every call is attributed to the key’s owner
            and audited.
          </p>
        </div>
        <div className="bg-card p-5">
          <Snippet
            title="Claude Code"
            text={`claude mcp add --transport http rote ${mcp} \\\n  --header "Authorization: Bearer $ROTE_API_KEY"`}
          />
        </div>
        <div className="bg-card p-5">
          <Snippet
            title="REST"
            text={`curl -s ${origin}/api/v1/capabilities/${first ? toCapability(first.name) : "<capability>"}/invoke \\\n  -H "Authorization: Bearer $ROTE_API_KEY" \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ tenant: "acme", inputs: exampleInputs })}'`}
          />
        </div>
      </section>

      <section aria-label="API keys">
        <ApiKeys />
      </section>

      <section aria-label="Playground" className="space-y-3">
        <h2 className="text-2xl tracking-[-0.05em]">Playground</h2>
        {!auth.can("OPERATOR") ? (
          <p className="text-sm text-muted-foreground">Calling tools needs the operator role.</p>
        ) : tools.isLoading ? (
          <Skeleton className="h-72" />
        ) : tools.data?.length ? (
          <Playground tools={tools.data} />
        ) : null}
      </section>

      <section aria-label="Tools" className="space-y-3">
        <h2 className="text-2xl tracking-[-0.05em]">Tools</h2>
        {tools.isLoading && <Skeleton className="h-48" />}
        {tools.data?.length === 0 && (
          <EmptyState icon={<Plug />} title="No approved capabilities yet">
            Approve one on the Capabilities page and it becomes a tool here.
          </EmptyState>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {tools.data?.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </section>
    </div>
  );
}
