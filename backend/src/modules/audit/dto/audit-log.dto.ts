import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import {
  PaginationQueryDto,
  SORT_ORDERS,
  type SortOrder,
} from '../../../common/dto/pagination-query.dto.js';
import { ActorType, AuditOutcome } from '../../../generated/prisma/enums.js';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  /** e.g. `capability.approved`, `auth.login_failed` */
  @IsOptional() @IsString() @MaxLength(64) action?: string;
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsString() @MaxLength(64) resourceType?: string;
  @IsOptional() @IsString() @MaxLength(200) resourceId?: string;
  @IsOptional() @IsEnum(AuditOutcome) outcome?: AuditOutcome;
  /** ISO 8601 lower bound (inclusive). */
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  /** ISO 8601 upper bound (inclusive). */
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @IsOptional() @IsIn(SORT_ORDERS) sortOrder: SortOrder = 'desc';
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ActorType }) actorType!: ActorType;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) actorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) actorEmail!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) apiKeyId!: string | null;
  @ApiProperty({ example: 'capability.approved' }) action!: string;
  @ApiPropertyOptional({ nullable: true }) resourceType!: string | null;
  @ApiPropertyOptional({ nullable: true }) resourceId!: string | null;
  @ApiProperty({ enum: AuditOutcome }) outcome!: AuditOutcome;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  metadata!: unknown;
  @ApiPropertyOptional({ nullable: true }) ipAddress!: string | null;
  @ApiPropertyOptional({ nullable: true }) requestId!: string | null;
  @ApiProperty() createdAt!: Date;
}
