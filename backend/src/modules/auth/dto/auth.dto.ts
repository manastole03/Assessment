import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { Role } from '../../../generated/prisma/enums.js';
import { IsStrongPassword } from '../../users/dto/password.validators.js';
import { UserEntity } from '../../users/entities/user.entity.js';
import type { AuthMethod } from '../../../common/interfaces/authenticated-user.interface.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class LoginDto {
  @Transform(trim)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RegisterDto {
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
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  /** At least 12 characters; not only letters or only digits. */
  @IsStrongPassword()
  newPassword!: string;
}

export class AuthSessionDto {
  @ApiProperty({ type: UserEntity }) user!: UserEntity;
  /**
   * Also set as an httpOnly cookie for browsers. Non-browser clients may send it as
   * `Authorization: Bearer <token>`, but should prefer API keys for anything long-running.
   */
  @ApiProperty() accessToken!: string;
  @ApiProperty() accessTokenExpiresAt!: Date;
}

export class IdentityDto {
  @ApiProperty({ type: UserEntity }) user!: UserEntity;
  /** The role this request acts with: the user's role, capped by the API key's role. */
  @ApiProperty({ enum: Role }) effectiveRole!: Role;
  @ApiProperty({ enum: ['session', 'bearer', 'api_key'] }) authMethod!: AuthMethod;
}

export class AuthOptionsDto {
  @ApiProperty() signupEnabled!: boolean;
  @ApiProperty() demoEnabled!: boolean;
}
