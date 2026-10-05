import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
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
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { JsonObject } from '../../common/interfaces/json.interface.js';
import { EngineIdPipe } from '../../common/pipes/resource-id.pipe.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { CapabilitiesService } from './capabilities.service.js';
import {
  ApprovalEntity,
  ApproveCapabilityDto,
  CapabilityQueryDto,
  ListCapabilitiesQueryDto,
} from './dto/capability.dto.js';

@ApiTags('capabilities')
@ApiAuth()
@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'The capability library (latest version of each)',
    description:
      'Summaries follow the engine’s artifact schema (schemas/capability.schema.json), so keys are snake_case.',
  })
  @ApiPaginatedEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.SERVICE_UNAVAILABLE)
  list(@Query() query: ListCapabilitiesQueryDto): Promise<PaginatedResult<JsonObject>> {
    return this.capabilities.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Review sheet; with ?tenant, the effective artifact after overrides' })
  @ApiEnvelope(JSON_DOCUMENT)
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND)
  get(
    @Param('id', EngineIdPipe) id: string,
    @Query() query: CapabilityQueryDto,
  ): Promise<JsonObject> {
    return this.capabilities.get(id, query);
  }

  @Get(':id/approvals')
  @ApiOperation({ summary: 'Who approved which version, and when' })
  @ApiEnvelope(ApprovalEntity, { isArray: true })
  approvals(@Param('id', EngineIdPipe) id: string): Promise<ApprovalEntity[]> {
    return this.capabilities.approvalsFor(id);
  }

  @Post(':ref/approve')
  @MinRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Capability approved')
  @ApiOperation({
    summary: 'Approve a reviewed draft (draft → approved)',
    description:
      'The reviewer is the signed-in user. Fails with SELF_APPROVAL_FORBIDDEN if you started the run that ' +
      'recorded this version (four-eyes rule), and CAPABILITY_NOT_APPROVABLE if it is approved or deprecated.',
  })
  @ApiEnvelope(ApprovalEntity)
  @ApiErrors(HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  approve(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('ref', EngineIdPipe) ref: string,
    @Body() dto: ApproveCapabilityDto,
  ): Promise<ApprovalEntity> {
    return this.capabilities.approve(actor, ref, dto.notes);
  }
}
