import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { User } from '../../../generated/prisma/client.js';
import { Role, UserStatus } from '../../../generated/prisma/enums.js';

/** A user as the API exposes it. There is deliberately no path from here to the password hash. */
export class UserEntity {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'dana@example.com' }) email!: string;
  @ApiProperty({ example: 'Dana Ops' }) name!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiPropertyOptional({ nullable: true }) lastLoginAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

/** Mapping by allow-list: new columns stay private until added here on purpose. */
export function toUserEntity(user: User): UserEntity {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** The compact form embedded in other resources (who started a run, who approved). */
export class UserRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
}

export function toUserRef(user: Pick<User, 'id' | 'email' | 'name'>): UserRefDto {
  return { id: user.id, email: user.email, name: user.name };
}
