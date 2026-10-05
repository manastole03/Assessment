import { z } from 'zod';

import type { JsonObject } from '../common/interfaces/json.interface.js';

/**
 * The anti-corruption layer for the engine's API (src/rote/web on the Python side). Only the fields
 * the control plane *reads* are validated; everything else passes through untouched (loose objects),
 * because those documents are versioned by the engine's own JSON Schemas (schemas/*.schema.json).
 */
const json = z.custom<JsonObject>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);

export const engineRunKind = z.enum(['replay', 'discovery', 'probe']);
export const engineRunStatus = z.enum([
  'running',
  'succeeded',
  'business_outcome',
  'failed',
  'error',
  'interrupted',
]);
export type EngineRunKind = z.infer<typeof engineRunKind>;
export type EngineRunStatus = z.infer<typeof engineRunStatus>;

export const engineRunSummary = z.looseObject({
  id: z.string().min(1),
  source: z.enum(['active', 'runs', 'evidence']),
  kind: engineRunKind,
  subject: z.string(),
  tenant: z.string().nullable(),
  // Unknown statuses from older evidence read as interrupted rather than failing the whole sync.
  status: engineRunStatus.catch('interrupted'),
  started_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  active: z.boolean(),
});
export type EngineRunSummary = z.infer<typeof engineRunSummary>;
export const engineRunList = z.array(engineRunSummary);

export const engineIntervention = z.looseObject({
  id: z.string(),
  reason_code: z.string(),
  status: z.enum(['open', 'claimed', 'resolved', 'expired']),
  step_id: z.string().nullish(),
  claimed_by: z.string().nullish(),
  claimed_at: z.string().nullish(),
  resolved_at: z.string().nullish(),
  resolution: z.string().nullish(),
  note: z.string().nullish(),
});
export type EngineIntervention = z.infer<typeof engineIntervention>;

export const engineRunDetail = engineRunSummary.extend({
  result: json.nullable(),
  caller: json.nullable(),
  error: z.string().nullable(),
  files: z.record(z.string(), z.string()),
  interventions: z.array(engineIntervention),
  has_report: z.boolean(),
});
export type EngineRunDetail = z.infer<typeof engineRunDetail>;

export const engineRunStarted = z.object({ id: z.string().min(1) });

export const engineOperatorState = z.looseObject({
  control: z.looseObject({ state: z.string(), holder: z.string(), epoch: z.number().int() }),
  active: engineIntervention.nullable(),
  history: z.array(engineIntervention.partial().extend({ id: z.string() })),
});
export type EngineOperatorState = z.infer<typeof engineOperatorState>;

export const engineClaimResult = z.looseObject({ epoch: z.number().int() });

export const engineCapabilitySummary = z.looseObject({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'approved', 'deprecated']),
  kind: z.enum(['task', 'session']),
  versions: z.array(z.looseObject({ version: z.string(), status: z.string() })),
  provenance: z.looseObject({ source_run: z.string().nullish() }),
});
export type EngineCapabilitySummary = z.infer<typeof engineCapabilitySummary>;
export const engineCapabilityList = z.array(engineCapabilitySummary);

export const engineCapabilityDetail = z.looseObject({ summary: engineCapabilitySummary });
export type EngineCapabilityDetail = z.infer<typeof engineCapabilityDetail>;

export const engineApproved = z.object({ ok: z.boolean(), ref: z.string() });

export const engineInvocation = z.looseObject({
  status: z.enum(['succeeded', 'business_outcome', 'failed', 'running']),
  capability: z.string(),
  run_id: z.string(),
  links: z.looseObject({ run: z.string(), ui: z.string() }),
});
export type EngineInvocation = z.infer<typeof engineInvocation>;

export const engineStatus = z.looseObject({
  version: z.string(),
  has_api_key: z.boolean(),
  tenants: z.array(z.looseObject({ id: z.string(), name: z.string(), reachable: z.boolean() })),
  active_runs: z.number().int(),
});
export type EngineStatus = z.infer<typeof engineStatus>;

export const engineEvalSummary = z.looseObject({
  id: z.string(),
  dataset: z.string(),
  status: z.enum(['running', 'completed', 'error']),
  started_at: z.string(),
});
export type EngineEvalSummary = z.infer<typeof engineEvalSummary>;
export const engineEvalList = z.array(engineEvalSummary);

export const engineDatasetSummary = z.looseObject({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  uses_model: z.boolean(),
});
export type EngineDatasetSummary = z.infer<typeof engineDatasetSummary>;
export const engineDatasetList = z.array(engineDatasetSummary);

export const engineEvalStarted = z.object({ id: z.string().min(1) });

export const engineHealth = z.looseObject({ status: z.literal('ok'), version: z.string() });

export const jsonDocument = json;
export const jsonDocumentList = z.array(json);
