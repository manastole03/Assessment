import { Body, Controller, Get, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Role } from '../../common/constants/roles.js';
import {
  ApiAuth,
  ApiEnvelope,
  ApiErrors,
  ApiPaginatedEnvelope,
  JSON_DOCUMENT,
} from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { MinRole, ResponseMessage } from '../../common/decorators/metadata.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { JsonObject } from '../../common/interfaces/json.interface.js';
import { EngineIdPipe } from '../../common/pipes/resource-id.pipe.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { SetFaultsDto } from './dto/demo.dto.js';
import { PlatformService } from './platform.service.js';

@ApiTags('platform')
@ApiAuth()
@Controller()
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('status')
  @ApiOperation({ summary: 'Environment: model, tenants and their reachability, live runs' })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.SERVICE_UNAVAILABLE)
  status(): Promise<JsonObject> {
    return this.platform.status();
  }

  @Get('policy')
  @ApiOperation({
    summary: 'Guardrails, app profiles (vendor handlers) and tenants with their overrides',
  })
  @ApiEnvelope(JSON_DOCUMENT)
  policy(): Promise<JsonObject> {
    return this.platform.policy();
  }

  @Get('evidence')
  @ApiOperation({ summary: 'The checked-in evidence index (which run shows what)' })
  @ApiEnvelope(JSON_DOCUMENT)
  evidence(): Promise<JsonObject> {
    return this.platform.evidence();
  }
}

/** Controls for the bundled LegacyCore mock. 404 FEATURE_DISABLED unless DEMO_ENABLED. */
@ApiTags('demo')
@ApiAuth()
@Controller('demo')
export class DemoController {
  constructor(private readonly platform: PlatformService) {}

  @Get('members')
  @ApiOperation({ summary: 'Synthetic members offered as one-click inputs' })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.NOT_FOUND)
  members(@Query() query: PaginationQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.platform.demoMembers(query);
  }

  @Get('faults/:tenant')
  @ApiOperation({ summary: 'The mock’s current fault switches for a tenant' })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.SERVICE_UNAVAILABLE)
  faults(@Param('tenant', EngineIdPipe) tenant: string): Promise<JsonObject> {
    return this.platform.getFaults(tenant);
  }

  @Put('faults/:tenant')
  @MinRole(Role.OPERATOR)
  @ResponseMessage('Faults set')
  @ApiOperation({
    summary: 'Replace the mock’s fault switches for a tenant (empty object clears them)',
  })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND, HttpStatus.SERVICE_UNAVAILABLE)
  setFaults(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('tenant', EngineIdPipe) tenant: string,
    @Body() dto: SetFaultsDto,
  ): Promise<JsonObject> {
    return this.platform.setFaults(actor, tenant, dto.faults);
  }
}
