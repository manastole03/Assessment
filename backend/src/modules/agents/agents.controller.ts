import { Body, Controller, Get, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { MinRole } from '../../common/decorators/metadata.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { JsonObject } from '../../common/interfaces/json.interface.js';
import { EngineIdPipe } from '../../common/pipes/resource-id.pipe.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { AgentsService } from './agents.service.js';
import { InvocationDto, InvokeCapabilityDto } from './dto/invoke.dto.js';

@ApiTags('agents')
@ApiAuth()
@Controller()
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agents/tools')
  @ApiOperation({ summary: 'Approved task capabilities as MCP tools (what MCP clients list)' })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  tools(@Query() query: PaginationQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.agents.tools(query);
  }

  @Get('agents/catalog')
  @ApiOperation({
    summary: 'Approved capabilities as tool definitions (Anthropic tool-use format)',
  })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  catalog(@Query() query: PaginationQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.agents.catalog(query);
  }

  @Post('capabilities/:id/invoke')
  @MinRole(Role.OPERATOR)
  @ApiOperation({
    summary: 'Invoke an approved capability and wait for its result',
    description:
      'Replays the latest approved version. 200 with the result contract when it finishes within `waitSeconds`, ' +
      'otherwise 202 with the run to poll (`links.run`). 422 INPUT_CONTRACT_VIOLATION lists every input problem.',
  })
  @ApiEnvelope(InvocationDto, { description: 'Finished: succeeded, business_outcome or failed' })
  @ApiEnvelope(InvocationDto, {
    status: HttpStatus.ACCEPTED,
    description: 'Still running; poll links.run',
  })
  @ApiErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async invoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', EngineIdPipe) id: string,
    @Body() dto: InvokeCapabilityDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JsonObject> {
    const result = await this.agents.invoke(actor, id, dto);
    res.status(result.status);
    const runId = result.body['run_id'];
    if (result.status === 202 && typeof runId === 'string')
      res.setHeader('location', `/api/v1/runs/${runId}`);
    return result.body;
  }
}
