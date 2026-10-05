import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Role } from '../../../generated/prisma/enums.js';
import { UserRefDto } from '../../users/entities/user.entity.js';

export class CreateApiKeyDto {
  /** What the key is for, e.g. "Claude Code on dana's laptop". */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** The key's role; at most your own. OPERATOR is enough to invoke capabilities and use MCP. */
  @IsEnum(Role)
  role!: Role;

  /** Optional expiry, 1 to 365 days. Without it the key lives until revoked. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

export class ListApiKeysQueryDto extends PaginationQueryDto {
  /** Admins only: keys of one user (default: your own). */
  @IsOptional() @IsUUID() userId?: string;

  /** Admins only: every user's keys. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  all?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeRevoked?: boolean;
}

export class ApiKeyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  /** Identifies the key in listings; the secret part is never shown again. */
  @ApiProperty({ example: 'rote_3f9a1c2b' }) prefix!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty({ type: UserRefDto }) owner!: UserRefDto;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) lastUsedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class CreatedApiKeyDto {
  @ApiProperty({ type: ApiKeyDto }) apiKey!: ApiKeyDto;
  /** The full key. Shown once: store it now. Send it as `Authorization: Bearer <key>` or `X-API-Key`. */
  @ApiProperty({ example: 'rote_3f9a1c2b_9QnM…' }) secret!: string;
}
