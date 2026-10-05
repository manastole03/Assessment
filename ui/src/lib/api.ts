// Typed client for the rote control plane (backend/, /api/v1). Every JSON response is an envelope
// ({ success, data, message, meta? }); `api()` returns `data`, `apiPage()` returns `{ items, meta }`.
// Engine documents (capabilities, run results, events, evals) keep the engine's snake_case keys;
// control-plane resources (users, runs, keys) use camelCase.

export type RunStatus = "running" | "succeeded" | "business_outcome" | "failed" | "error" | "interrupted";
export type RunKind = "replay" | "discovery" | "probe";
export type Risk = "read_only" | "reversible" | "irreversible";
export type Sensitivity = "public" | "internal" | "pii" | "secret";
export type LeaseState = "automated" | "awaiting_human" | "human";

export interface TenantStatus {
  id: string;
  name: string;
  app: string;
  base_url: string;
  product_version: string | null;
  overrides: number;
  reachable: boolean;
}

export interface Status {
  version: string;
  model: string;
  effort: string;
  has_api_key: boolean;
  tenants: TenantStatus[];
  active_runs: number;
  control_plane?: { version: string; demo_enabled: boolean };
}

export interface ParamSpec {
  type: string;
  description: string;
  required?: boolean;
  pattern?: string | null;
  enum?: string[] | null;
  sensitivity: Sensitivity;
  example?: string | null;
}

export interface Provenance {
  method: string;
  recorded_at: string;
  source_run?: string | null;
  model?: string | null;
  goal: string;
  tenant: string;
  product_version?: string | null;
  human_steps?: string[];
  review?: { reviewed_by: string; reviewed_at: string; notes?: string | null } | null;
}

export interface CapabilitySummary {
  id: string;
  version: string;
  title: string;
  description: string;
  status: "draft" | "approved" | "deprecated";
  kind: "task" | "session";
  side_effects: Risk;
  idempotent: boolean;
  requires_session: string | null;
  inputs: Record<string, ParamSpec>;
  outputs: Record<string, ParamSpec>;
  outcomes: string[];
  steps: number;
  versions: { version: string; status: string }[];
  provenance: Provenance;
}

export interface Locator {
  by: "attribute" | "role" | "label" | "table_cell" | "css";
  [key: string]: unknown;
}

export interface Target {
  description: string;
  frame?: { name?: string | null; path?: string | null } | null;
  role?: string | null;
  locators: Locator[];
}

export interface Step {
  id: string;
  intent: string;
  risk: Risk;
  source?: string;
  timeout_ms?: number;
  action: {
    type: "navigate" | "click" | "fill" | "select" | "press" | "extract";
    target?: Target | null;
    value?: string;
    option?: string;
    key?: string;
    url?: string;
    output?: string;
  };
}

export interface HandlerView {
  source: "tenant" | "capability" | "app";
  id: string;
  description: string;
  kind: "business_outcome" | "recoverable" | "failure";
  scope?: string[] | null;
  outcome?: { code: string; message: string } | null;
  recovery?: { do: string; [key: string]: unknown } | null;
  max_attempts?: number;
  origin?: string;
  when_text: string[];
  unless_text: string[];
}

export interface CapabilityDetail {
  summary: CapabilitySummary;
  capability: { steps: Step[]; success: { description: string } } & Record<string, unknown>;
  yaml: string;
  tenant: string | null;
  layers: string[];
  effective_hash: string | null;
  overridden: Record<string, number>;
  handlers: HandlerView[];
  expect_text: Record<string, string[]>;
  success_text: string[];
  tool: Record<string, unknown> | null;
}

export type Role = "VIEWER" | "OPERATOR" | "REVIEWER" | "ADMIN";

export interface UserRef {
  id: string;
  email: string;
  name: string;
}

export interface User extends UserRef {
  role: Role;
  status: "ACTIVE" | "DISABLED";
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Identity {
  user: User;
  /** The role this session acts with. */
  effectiveRole: Role;
  authMethod: "session" | "bearer" | "api_key";
}

export interface AuthSession {
  user: User;
  accessToken: string;
  accessTokenExpiresAt: string;
}

export interface AuthOptions {
  signupEnabled: boolean;
  demoEnabled: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  owner: UserRef;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** Shown once. */
  secret: string;
}

export type RunOrigin = "control_plane" | "engine" | "evidence";

export interface RunSummary {
  id: string;
  kind: RunKind;
  status: RunStatus;
  /** control_plane: started here; engine: CLI or stdio MCP; evidence: checked in. */
  origin: RunOrigin;
  subject: string;
  tenant: string | null;
  capabilityRef: string | null;
  resultCode: string | null;
  active: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  requestedBy: UserRef | null;
}

export interface Failure {
  code: string;
  message: string;
  app_code?: string | null;
  capability?: string | null;
  step_id?: string | null;
  step_intent?: string | null;
  expected?: string | null;
  observed?: string | null;
  retryable: boolean;
  evidence: Record<string, string>;
}

export interface RunResult {
  status: string;
  capability?: { id: string; version: string; effective_hash: string; layers: string[] } | string | null;
  tenant?: string;
  outputs?: Record<string, unknown> | null;
  outcome?: { code: string; message: string; step_id?: string | null } | null;
  failure?: Failure | string | null;
  recoveries?: { handler: string; source: string; step_id: string; action: string; attempt: number }[];
  warnings?: { code: string; step_id?: string | null; message: string }[];
  interventions?: string[];
  duration_ms?: number;
  turns?: number;
  estimated_cost_usd?: number;
  model?: string;
  usage?: Record<string, number>;
}

export interface HumanAction {
  at: string;
  kind: string;
  description: string;
}

export interface Intervention {
  id: string;
  run_kind: string;
  subject: string;
  step_id?: string | null;
  step_intent?: string | null;
  reason_code: string;
  reason: string;
  observation?: string | null;
  allowed_resolutions: string[];
  status: "open" | "claimed" | "resolved" | "expired";
  claimed_by?: string | null;
  resolution?: string | null;
  note?: string | null;
  human_actions: HumanAction[];
}

export interface RunDetail extends RunSummary {
  result: RunResult | null;
  caller: Record<string, unknown> | null;
  error: string | null;
  files: Record<string, string>;
  interventions: Intervention[];
  hasReport: boolean;
}

export interface RunEvent {
  seq: number;
  ts: string;
  t_ms: number;
  type: string;
  [key: string]: unknown;
}

export interface OperatorState {
  control: { state: LeaseState; holder: string; epoch: number; since: string };
  dialog: { kind: string; message: string } | null;
  active: Intervention | null;
  history: Partial<Intervention>[];
}

export interface ScreenElement {
  ref: string;
  role: string | null;
  name: string;
  label: string;
  x: number | null;
  y: number | null;
}

export interface StartRun {
  kind: RunKind;
  tenant: string;
  capability?: string;
  inputs?: Record<string, string>;
  escalation?: "fail" | "wait";
  allowDraft?: boolean;
  /** Demo deployments only (DEMO_ENABLED). */
  faults?: Record<string, unknown>;
  headed?: boolean;
  goal?: string;
  discoveryKind?: "task" | "session";
  capabilityId?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
}

export interface RunStarted {
  id: string;
  run: RunSummary;
}

export interface Approval {
  id: string;
  capabilityId: string;
  version: string;
  ref: string;
  approvedBy: UserRef;
  notes: string | null;
  approvedAt: string;
}

export interface DemoMember {
  member_id: string;
  label: string;
  expect: string;
}

export interface TargetRule {
  name_pattern: string;
  roles?: string[] | null;
  reason: string;
}

export interface PolicyView {
  id: string;
  allowed_origins: string[];
  blocked_url_patterns: string[];
  discovery: { allowed_actions: string[]; irreversible: "escalate" | "block" };
  replay: { allowed_actions: string[]; irreversible: "confirm" | "block" | "allow"; require_approved: boolean };
  risk_rules: (TargetRule & { risk: Risk })[];
  blocked_targets: TargetRule[];
  sensitive_labels: string[];
}

export interface AppProfileView {
  id: string;
  product: string;
  session_capability?: string | null;
  locator_preference: string[];
  handlers: { id: string; kind: HandlerView["kind"]; description: string }[];
}

export interface TenantOverride {
  capability: string;
  versions: string;
  reason: string;
  steps?: Record<string, { prepend_locators?: Locator[] }>;
}

export interface TenantView {
  id: string;
  name: string;
  apps: Record<
    string,
    { base_url: string; product_version?: string | null; secrets: Record<string, string>; overrides?: TenantOverride[] }
  >;
}

export interface PolicyResponse {
  policy: PolicyView;
  apps: AppProfileView[];
  tenants: TenantView[];
}

export interface EvidenceRun {
  name: string;
  shows: string;
  result: string;
  capability?: string;
  outputs?: Record<string, unknown>;
  outcome?: string;
  failure?: string;
  recoveries?: string[];
  warnings?: string[];
}

export interface EvidenceIndex {
  mode: "live" | "offline" | null;
  runs: EvidenceRun[];
}

// ============================================================================================ evals

export type EvalKind = "replay" | "probe" | "discovery";
export type EvalMode = "offline" | "live" | "deterministic";
export type EvalStatus = "running" | "completed" | "error";

export interface EvalCheck {
  name: string;
  /** null: not graded in this mode (e.g. the rubric needs the model). */
  passed: boolean | null;
  expected: string | null;
  observed: string | null;
}

export interface EvalTrial {
  trial: number;
  passed: boolean;
  checks: EvalCheck[];
  duration_ms: number;
  observed: string | null;
  run_id: string | null;
  evidence: string | null;
  cost_usd: number;
  error: string | null;
}

export interface EvalCase {
  id: string;
  title: string;
  tags: string[];
  trials: EvalTrial[];
  passed: boolean;
}

export interface EvalSummary {
  cases: number;
  passed: number;
  pass_rate: number;
  pass_at_k: number;
  pass_hat_k: number;
  checks: number;
  checks_passed: number;
  by_tag: Record<string, { cases: number; passed: number }>;
  p50_ms: number | null;
  p95_ms: number | null;
  cost_usd: number;
  gate: boolean;
}

interface EvalRunBase {
  id: string;
  dataset: string;
  dataset_title: string;
  kind: EvalKind;
  mode: EvalMode;
  model: string | null;
  trials: number;
  status: EvalStatus;
  started_at: string;
  finished_at: string | null;
  total_cases: number;
  summary: EvalSummary | null;
}

export interface EvalRunSummary extends EvalRunBase {
  done_cases: number;
}

export interface EvalRunDetail extends EvalRunBase {
  dataset_sha: string;
  threshold: number;
  error: string | null;
  cases: EvalCase[];
}

export interface EvalDatasetSummary {
  id: string;
  title: string;
  description: string;
  kind: EvalKind;
  uses_model: boolean;
  threshold: number;
  cases: number;
  tags: string[];
  latest: EvalRunSummary | null;
}

export interface StartEval {
  dataset: string;
  mode: "offline" | "live";
  trials: number;
  cases?: string[];
}

export const evalFile = (evalId: string, path: string) => `${API_BASE}/evals/results/${encodeURIComponent(evalId)}/files/${path}`;

// ============================================================================================ agents

export interface ToolProperty {
  type: string;
  description?: string;
  pattern?: string;
  enum?: string[];
  default?: string;
}

/** An approved capability as an MCP tool (GET /api/v1/agents/tools; the same list MCP clients see). */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, ToolProperty>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface InvokeRequest {
  tenant: string;
  inputs: Record<string, string>;
  escalation?: "fail" | "wait";
  waitSeconds?: number;
}

/** The capability's result contract, as an agent receives it. */
export interface Invocation {
  status: "succeeded" | "business_outcome" | "failed" | "running";
  capability: string;
  run_id: string;
  outputs?: Record<string, unknown>;
  outcome?: { code: string; message: string };
  failure?: { code: string; message: string; retryable: boolean };
  links: { run: string; ui: string };
}

// ============================================================================================ client

export const API_BASE = "/api/v1";
const CSRF_COOKIE = "rote_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message?: string;
  meta?: PageMeta;
}

interface ErrorEnvelope {
  success: false;
  message: string;
  error: { code: string; details?: unknown };
  requestId?: string;
}

export class ApiError extends Error {
  status: number;
  /** Stable machine-readable code from the server (e.g. SELF_APPROVAL_FORBIDDEN). */
  code: string;
  details: unknown;
  requestId: string | undefined;
  constructor(status: number, message: string, code = "UNKNOWN", details?: unknown, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** Individual problems a 422 listed, if any. */
  get problems(): string[] {
    const problems = (this.details as { problems?: unknown } | undefined)?.problems;
    return Array.isArray(problems) ? problems.map(String) : [];
  }
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Called when the session is gone for good (refresh failed): the auth provider signs the UI out. */
let onSessionLost: (() => void) | null = null;
export function setSessionLostHandler(handler: (() => void) | null) {
  onSessionLost = handler;
}

let refreshing: Promise<boolean> | null = null;

/** Rotate the session cookies. Concurrent callers share one refresh. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-csrf-token": readCookie(CSRF_COOKIE) ?? "" },
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const toUrl = (path: string) => (path.startsWith("/api/") ? path : `${API_BASE}${path}`);

async function send(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const build = () => {
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set("content-type", "application/json");
    if (!SAFE_METHODS.has(method)) headers.set("x-csrf-token", readCookie(CSRF_COOKIE) ?? "");
    return {
      ...rest,
      method,
      headers,
      credentials: "same-origin" as const,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    };
  };
  let response = await fetch(toUrl(path), build());
  const isAuthCall = path.startsWith("/auth/");
  if (response.status === 401 && !isAuthCall) {
    // The access cookie expired: rotate once and retry; give up (sign out) if that fails too.
    if (await refreshSession()) response = await fetch(toUrl(path), build());
    if (response.status === 401) onSessionLost?.();
  }
  return response;
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ErrorEnvelope>;
    return new ApiError(
      response.status,
      body.message ?? response.statusText,
      body.error?.code,
      body.error?.details,
      body.requestId,
    );
  } catch {
    return new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
}

/** Call the API and return the envelope's `data` (undefined for 204). */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await send(path, init);
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as SuccessEnvelope<T>).data;
}

/** A page of a collection endpoint. */
export async function apiPage<T>(path: string, init?: RequestInit): Promise<Page<T>> {
  const response = await send(path, init);
  if (!response.ok) throw await toError(response);
  const body = (await response.json()) as SuccessEnvelope<T[]>;
  return { items: body.data, meta: body.meta ?? { page: 1, limit: body.data.length, total: body.data.length, totalPages: 1 } };
}

/** Every item of a small collection (the library, datasets, tools): one page of up to 100. */
export async function apiAll<T>(path: string): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  return (await apiPage<T>(`${path}${separator}limit=100`)).items;
}

export const runFile = (runId: string, path: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/files/${path}`;
export const operatorUrl = (runId: string, path: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/operator/${path}`;
export const runStreamUrl = (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/stream`;

/** Roles rank VIEWER < OPERATOR < REVIEWER < ADMIN. */
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, REVIEWER: 2, ADMIN: 3 };
export const hasRole = (actual: Role | undefined, required: Role) => !!actual && RANK[actual] >= RANK[required];
