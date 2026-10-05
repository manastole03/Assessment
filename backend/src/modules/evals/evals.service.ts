import { Injectable } from '@nestjs/common';

import { ErrorCode } from '../../common/constants/error-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { fromParsedJson, type JsonObject } from '../../common/interfaces/json.interface.js';
import {
  type PageRequest,
  paginateArray,
  type PaginatedResult,
} from '../../common/utils/pagination.util.js';
import { EngineClient } from '../../engine/engine.client.js';
import {
  engineDatasetList,
  engineEvalList,
  engineEvalStarted,
  jsonDocument,
} from '../../engine/engine.types.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import type { EvalStartedDto, ListEvalResultsQueryDto, StartEvalDto } from './dto/eval.dto.js';

/** Eval datasets and results live with the engine (versioned in git); this adds access control and audit. */
@Injectable()
export class EvalsService {
  constructor(
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
  ) {}

  async datasets(page: PageRequest): Promise<PaginatedResult<JsonObject>> {
    const datasets = await this.engine.get('/api/evals/datasets', { schema: engineDatasetList });
    return paginateArray(fromParsedJson(datasets), page);
  }

  dataset(id: string): Promise<JsonObject> {
    return this.engine.get(`/api/evals/datasets/${encodeURIComponent(id)}`, {
      schema: jsonDocument,
      errors: { 404: ErrorCode.DATASET_NOT_FOUND },
    });
  }

  async results(query: ListEvalResultsQueryDto): Promise<PaginatedResult<JsonObject>> {
    const results = await this.engine.get('/api/evals/results', { schema: engineEvalList });
    const matches = results.filter(
      (run) =>
        (!query.dataset || run.dataset === query.dataset) &&
        (!query.status || run.status === query.status),
    );
    return paginateArray(fromParsedJson(matches), query);
  }

  result(id: string): Promise<JsonObject> {
    return this.engine.get(`/api/evals/results/${encodeURIComponent(id)}`, {
      schema: jsonDocument,
      errors: { 404: ErrorCode.EVAL_NOT_FOUND },
    });
  }

  openFile(id: string, path: string, signal: AbortSignal): Promise<Response> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return this.engine.raw('GET', `/api/evals/results/${encodeURIComponent(id)}/files/${encoded}`, {
      signal,
      timeoutMs: 60_000,
      errors: { 404: ErrorCode.FILE_NOT_FOUND },
    });
  }

  /** Start an eval in the background. One runs at a time (the engine answers 409 otherwise). */
  async start(actor: AuthenticatedUser, dto: StartEvalDto): Promise<EvalStartedDto> {
    const started = await this.engine.post('/api/evals/runs', {
      schema: engineEvalStarted,
      body: { dataset: dto.dataset, mode: dto.mode, trials: dto.trials, cases: dto.cases ?? null },
      errors: { 404: ErrorCode.DATASET_NOT_FOUND, 409: ErrorCode.EVAL_ALREADY_RUNNING },
    });
    await this.audit.record({
      actor,
      action: AuditAction.EVAL_STARTED,
      resourceType: 'eval',
      resourceId: started.id,
      metadata: {
        dataset: dto.dataset,
        mode: dto.mode,
        trials: dto.trials,
        cases: dto.cases?.length ?? null,
      },
    });
    return started;
  }
}
