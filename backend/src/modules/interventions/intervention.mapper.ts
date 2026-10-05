import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { EngineIntervention } from '../../engine/engine.types.js';
import { InterventionStatus } from '../../generated/prisma/enums.js';
import { toUserRef, UserRefDto } from '../users/entities/user.entity.js';
import type { InterventionSnapshot, InterventionWithRefs } from './interventions.repository.js';

const STATUS: Record<EngineIntervention['status'], InterventionStatus> = {
  open: InterventionStatus.OPEN,
  claimed: InterventionStatus.CLAIMED,
  resolved: InterventionStatus.RESOLVED,
  expired: InterventionStatus.EXPIRED,
};

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toInterventionSnapshot(item: EngineIntervention): InterventionSnapshot {
  return {
    engineId: item.id,
    reasonCode: item.reason_code.slice(0, 64),
    status: STATUS[item.status],
    stepId: item.step_id?.slice(0, 100) ?? null,
    claimedBy: item.claimed_by?.slice(0, 254) ?? null,
    resolution: item.resolution?.slice(0, 32) ?? null,
    note: item.note?.slice(0, 2000) ?? null,
    claimedAt: date(item.claimed_at),
    resolvedAt: date(item.resolved_at),
  };
}

export class InterventionRunRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() subject!: string;
  @ApiPropertyOptional({ nullable: true }) tenant!: string | null;
  @ApiProperty({ example: 'replay' }) kind!: string;
  @ApiProperty({ example: 'running' }) status!: string;
}

export class InterventionEntity {
  @ApiProperty({ format: 'uuid' }) id!: string;
  /** The engine's id within the run; use it with the run's operator endpoints. */
  @ApiProperty({ example: 'iv_c294640d' }) engineId!: string;
  @ApiProperty({ example: 'UNEXPECTED_STATE' }) reasonCode!: string;
  @ApiProperty({ enum: ['open', 'claimed', 'resolved', 'expired'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) stepId!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The operator handle on the lease.' })
  claimedBy!: string | null;
  @ApiPropertyOptional({ type: UserRefDto, nullable: true }) claimedByUser!: UserRefDto | null;
  @ApiPropertyOptional({ nullable: true }) resolution!: string | null;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiPropertyOptional({ nullable: true }) claimedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: InterventionRunRefDto }) run!: InterventionRunRefDto;
}

export function toInterventionEntity(item: InterventionWithRefs): InterventionEntity {
  return {
    id: item.id,
    engineId: item.engineId,
    reasonCode: item.reasonCode,
    status: item.status.toLowerCase(),
    stepId: item.stepId,
    claimedBy: item.claimedBy,
    claimedByUser: item.claimedByUser ? toUserRef(item.claimedByUser) : null,
    resolution: item.resolution,
    note: item.note,
    claimedAt: item.claimedAt,
    resolvedAt: item.resolvedAt,
    createdAt: item.createdAt,
    run: {
      id: item.run.id,
      subject: item.run.subject,
      tenant: item.run.tenant,
      kind: item.run.kind.toLowerCase(),
      status: item.run.status.toLowerCase(),
    },
  };
}
