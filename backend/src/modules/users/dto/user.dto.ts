import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { ListQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Role, UserStatus } from '../../../generated/prisma/enums.js';
import { IsStrongPassword } from './password.validators.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateUserDto {
  @Transform(trim)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** At least 12 characters; not only letters or only digits. */
  @IsStrongPassword()
  password!: string;

  @IsOptional()
  @IsEnum(Role)
  role: Role = Role.VIEWER;
}

export class UpdateUserDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** DISABLED users cannot sign in, and their sessions and API keys stop working at once. */
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class UpdateProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export const USER_SORT_FIELDS = ['createdAt', 'email', 'name', 'lastLoginAt', 'role'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export class ListUsersQueryDto extends ListQueryDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsIn(USER_SORT_FIELDS) sortBy: UserSortField = 'createdAt';
}
