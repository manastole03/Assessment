import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Password policy, NIST SP 800-63B style: length over composition rules. At least 12 characters
 * (at most 128, bounding hashing cost), and not entirely letters or entirely digits.
 */
export function IsStrongPassword() {
  return applyDecorators(
    IsString(),
    MinLength(12, { message: 'password must be at least 12 characters' }),
    MaxLength(128, { message: 'password must be at most 128 characters' }),
    Matches(/^(?![A-Za-z]+$)(?!\d+$).+$/s, {
      message: 'password must not be only letters or only digits',
    }),
  );
}
