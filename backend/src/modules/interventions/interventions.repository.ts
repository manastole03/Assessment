import { Injectable } from '@nestjs/common';

import { type PageRequest, toSkipTake } from '../../common/utils/pagination.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Intervention, Prisma, Run, User } from '../../generated/prisma/client.js';
import { InterventionStatus } from '../../generated/prisma/enums.js';

export type InterventionWithRefs = Intervention & {
  run: Pick<Run, 'id' | 'subject' | 'tenant' | 'kind' | 'status'>;
  claimedByUser: Pick<User, 'id' | 'email' | 'name'> | null;
};

const REFS = {
  run: { select: { id: true, subject: true, tenant: true, kind: true, status: true } },
  claimedByUser: { select: { id: true, email: true, name: true } },
} as const;

/** One intervention as the engine reports it, in database terms. */
export interface InterventionSnapshot {
  engineId: string;
  reasonCode: string;
  status: InterventionStatus;
  stepId: string | null;
  claimedBy: string | null;
  resolution: string | null;
  note: string | null;
  claimedAt: Date | null;
  resolvedAt: Date | null;
}

export interface InterventionFilter {
  status?: InterventionStatus;
  reasonCode?: string;
  runId?: string;
}

@Injectable()
export class InterventionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a run's interventions (one transaction). The engine owns their state; the claimant's
   * user id is resolved from the operator handle, which control-plane claims set to the user's email.
   */
  async upsertForRun(runId: string, items: InterventionSnapshot[]): Promise<void> {
    if (items.length === 0) return;
    const handles = [
      ...new Set(items.map((item) => item.claimedBy).filter((h): h is string => Boolean(h))),
    ];
    const claimants = handles.length
      ? await this.prisma.user.findMany({
          where: { email: { in: handles } },
          select: { id: true, email: true },
        })
      : [];
    const userIds = new Map(claimants.map((user) => [user.email, user.id]));

    await this.prisma.$transaction(
      items.map((item) => {
        const data = {
          reasonCode: item.reasonCode,
          status: item.status,
          stepId: item.stepId,
          claimedBy: item.claimedBy,
          claimedById: item.claimedBy ? (userIds.get(item.claimedBy) ?? null) : null,
          resolution: item.resolution,
          note: item.note,
          claimedAt: item.claimedAt,
          resolvedAt: item.resolvedAt,
        };
        return this.prisma.intervention.upsert({
          where: { runId_engineId: { runId, engineId: item.engineId } },
          create: { runId, engineId: item.engineId, ...data },
          update: data,
        });
      }),
    );
  }

  /** Record a hand-back the control plane performed (the engine's history confirms it later). */
  async markResolved(
    runId: string,
    engineId: string,
    resolution: string,
    note: string | null,
  ): Promise<void> {
    await this.prisma.intervention.updateMany({
      where: { runId, engineId },
      data: { status: InterventionStatus.RESOLVED, resolution, note, resolvedAt: new Date() },
    });
  }

  async findPage(
    filter: InterventionFilter,
    page: PageRequest,
    order: 'asc' | 'desc',
  ): Promise<[InterventionWithRefs[], number]> {
    const where: Prisma.InterventionWhereInput = {
      status: filter.status,
      reasonCode: filter.reasonCode,
      runId: filter.runId,
    };
    return this.prisma.$transaction([
      this.prisma.intervention.findMany({
        where,
        include: REFS,
        orderBy: [{ createdAt: order }, { id: order }],
        ...toSkipTake(page),
      }),
      this.prisma.intervention.count({ where }),
    ]);
  }
}
