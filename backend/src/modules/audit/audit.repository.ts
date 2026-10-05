import { Injectable } from '@nestjs/common';

import { type PageRequest, toSkipTake } from '../../common/utils/pagination.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuditLog, Prisma } from '../../generated/prisma/client.js';

export interface AuditLogFilter {
  action?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditLog['outcome'];
  from?: Date;
  to?: Date;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AuditLogUncheckedCreateInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({ data });
  }

  async findPage(
    filter: AuditLogFilter,
    page: PageRequest,
    order: 'asc' | 'desc',
  ): Promise<[AuditLog[], number]> {
    const where: Prisma.AuditLogWhereInput = {
      action: filter.action,
      actorId: filter.actorId,
      resourceType: filter.resourceType,
      resourceId: filter.resourceId,
      outcome: filter.outcome,
      createdAt: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
    };
    return this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: order }, { id: order }],
        ...toSkipTake(page),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
  }
}
