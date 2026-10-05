import { Injectable } from '@nestjs/common';

import { PaginatedResult } from '../../common/utils/pagination.util.js';
import { InterventionStatus } from '../../generated/prisma/enums.js';
import type { ListInterventionsQueryDto } from './dto/intervention.dto.js';
import { type InterventionEntity, toInterventionEntity } from './intervention.mapper.js';
import { InterventionsRepository } from './interventions.repository.js';

const STATUS = {
  open: InterventionStatus.OPEN,
  claimed: InterventionStatus.CLAIMED,
  resolved: InterventionStatus.RESOLVED,
  expired: InterventionStatus.EXPIRED,
} as const;

@Injectable()
export class InterventionsService {
  constructor(private readonly interventions: InterventionsRepository) {}

  async list(query: ListInterventionsQueryDto): Promise<PaginatedResult<InterventionEntity>> {
    const page = { page: query.page, limit: query.limit };
    const [rows, total] = await this.interventions.findPage(
      {
        status: query.status ? STATUS[query.status] : undefined,
        reasonCode: query.reasonCode,
        runId: query.runId,
      },
      page,
      query.sortOrder,
    );
    return new PaginatedResult(rows.map(toInterventionEntity), total, page);
  }
}
