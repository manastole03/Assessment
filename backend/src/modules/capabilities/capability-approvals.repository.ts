import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service.js';
import type { CapabilityApproval, Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class CapabilityApprovalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One approval per version; approving again (after a library reset) replaces the record. */
  upsert(data: Prisma.CapabilityApprovalUncheckedCreateInput): Promise<CapabilityApproval> {
    const { capabilityId, version, ...rest } = data;
    return this.prisma.capabilityApproval.upsert({
      where: { capabilityId_version: { capabilityId, version } },
      create: data,
      update: { ...rest, createdAt: new Date() },
    });
  }

  findForCapability(capabilityId: string): Promise<CapabilityApproval[]> {
    return this.prisma.capabilityApproval.findMany({
      where: { capabilityId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
