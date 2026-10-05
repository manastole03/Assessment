import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Role } from '../../common/constants/roles.js';
import {
  ApiAuth,
  ApiErrors,
  ApiPaginatedEnvelope,
} from '../../common/decorators/api-docs.decorators.js';
import { MinRole } from '../../common/decorators/metadata.decorators.js';
import type { PaginatedResult } from '../../common/utils/pagination.util.js';
import { AuditService } from './audit.service.js';
import { AuditLogDto, ListAuditLogsQueryDto } from './dto/audit-log.dto.js';

@ApiTags('audit')
@ApiAuth()
@MinRole(Role.ADMIN)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Security audit trail (admins)',
    description: 'Newest first; filter by action, actor, resource, outcome and time range.',
  })
  @ApiPaginatedEnvelope(AuditLogDto)
  @ApiErrors(HttpStatus.BAD_REQUEST)
  list(@Query() query: ListAuditLogsQueryDto): Promise<PaginatedResult<AuditLogDto>> {
    return this.audit.list(query);
  }
}
