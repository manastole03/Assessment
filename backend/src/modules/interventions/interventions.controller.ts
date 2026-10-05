import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiAuth,
  ApiErrors,
  ApiPaginatedEnvelope,
} from '../../common/decorators/api-docs.decorators.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { ListInterventionsQueryDto } from './dto/intervention.dto.js';
import { InterventionEntity } from './intervention.mapper.js';
import { InterventionsService } from './interventions.service.js';

@ApiTags('interventions')
@ApiAuth()
@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventions: InterventionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Human handoffs across all runs',
    description:
      '`status=open` is the queue of live runs waiting for an operator. Act on one through /runs/{runId}/operator.',
  })
  @ApiPaginatedEnvelope(InterventionEntity)
  @ApiErrors(HttpStatus.BAD_REQUEST)
  list(@Query() query: ListInterventionsQueryDto): Promise<PaginatedResult<InterventionEntity>> {
    return this.interventions.list(query);
  }
}
