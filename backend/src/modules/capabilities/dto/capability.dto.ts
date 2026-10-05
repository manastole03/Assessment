import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ListQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { UserRefDto } from '../../users/entities/user.entity.js';
import { TENANT_ID } from '../../runs/dto/run.dto.js';

export const CAPABILITY_SORT_FIELDS = ['id', 'title', 'status', 'kind'] as const;
export type CapabilitySortField = (typeof CAPABILITY_SORT_FIELDS)[number];

export class ListCapabilitiesQueryDto extends ListQueryDto {
  @IsOptional() @IsIn(['draft', 'approved', 'deprecated']) status?:
    'draft' | 'approved' | 'deprecated';
  @IsOptional() @IsIn(['task', 'session']) kind?: 'task' | 'session';
  /** Default: session capabilities first, then by id. */
  @IsOptional() @IsIn(CAPABILITY_SORT_FIELDS) sortBy?: CapabilitySortField;
}

export class CapabilityQueryDto {
  /** A specific version (default: the latest). */
  @IsOptional() @Matches(/^\d+\.\d+\.\d+$/) version?: string;
  /** Show the effective artifact for this tenant, with its override layers. */
  @IsOptional() @Matches(TENANT_ID) tenant?: string;
}

export class ApproveCapabilityDto {
  /** Review notes recorded with the approval (the reviewer is you, from your session). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ApprovalEntity {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() capabilityId!: string;
  @ApiProperty({ example: '1.0.3' }) version!: string;
  @ApiProperty({ example: 'legacycore.member.get_savings_balance@1.0.3' }) ref!: string;
  @ApiProperty({ type: UserRefDto, description: 'Snapshot of the reviewer at approval time' })
  approvedBy!: UserRefDto;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() approvedAt!: Date;
}
