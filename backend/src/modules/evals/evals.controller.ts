import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Role } from '../../common/constants/roles.js';
import {
  ApiAuth,
  ApiEnvelope,
  ApiErrors,
  ApiPaginatedEnvelope,
  JSON_DOCUMENT,
} from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  MinRole,
  RawResponse,
  ResponseMessage,
} from '../../common/decorators/metadata.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type {
  AppRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-user.interface.js';
import type { JsonObject } from '../../common/interfaces/json.interface.js';
import { EngineIdPipe } from '../../common/pipes/resource-id.pipe.js';
import { EvidencePath } from '../../common/decorators/evidence-path.decorator.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { EngineProxyService } from '../../engine/engine-proxy.service.js';
import { evidenceHeaders } from '../../engine/evidence-headers.js';
import { EvalStartedDto, ListEvalResultsQueryDto, StartEvalDto } from './dto/eval.dto.js';
import { EvalsService } from './evals.service.js';

@ApiTags('evals')
@ApiAuth()
@Controller('evals')
export class EvalsController {
  constructor(
    private readonly evals: EvalsService,
    private readonly proxy: EngineProxyService,
  ) {}

  @Get('datasets')
  @ApiOperation({ summary: 'Eval datasets with their latest full result' })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  datasets(@Query() query: PaginationQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.evals.datasets(query);
  }

  @Get('datasets/:id')
  @ApiOperation({ summary: 'A dataset’s cases (schemas/eval-dataset.schema.json)' })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.NOT_FOUND)
  dataset(@Param('id', EngineIdPipe) id: string): Promise<JsonObject> {
    return this.evals.dataset(id);
  }

  @Get('results')
  @ApiOperation({ summary: 'Eval runs, newest first' })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  results(@Query() query: ListEvalResultsQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.evals.results(query);
  }

  @Get('results/:id')
  @ApiOperation({ summary: 'One eval run, with every check of every trial' })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.NOT_FOUND)
  result(@Param('id', EngineIdPipe) id: string): Promise<JsonObject> {
    return this.evals.result(id);
  }

  @Get('results/:id/files/*path')
  @RawResponse()
  @ApiParam({
    name: 'path',
    description: 'Path inside the eval run, e.g. `runs/<run>/report.html`',
  })
  @ApiProduces('text/html', 'image/jpeg', 'application/json')
  @ApiOperation({ summary: 'Evidence from an eval trial' })
  @ApiErrors(HttpStatus.NOT_FOUND)
  async file(
    @Param('id', EngineIdPipe) id: string,
    @EvidencePath() path: string,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = this.proxy.abortOnClose(req, res);
    const response = await this.evals.openFile(id, path, upstream.signal);
    await this.proxy.pipe(response, res, { upstream, headers: evidenceHeaders(response) });
  }

  @Post('runs')
  @MinRole(Role.REVIEWER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ResponseMessage('Eval started; poll /evals/results/{id}')
  @ApiOperation({ summary: 'Start an eval in the background (one at a time)' })
  @ApiEnvelope(EvalStartedDto, { status: HttpStatus.ACCEPTED })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  start(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: StartEvalDto,
  ): Promise<EvalStartedDto> {
    return this.evals.start(actor, dto);
  }
}
