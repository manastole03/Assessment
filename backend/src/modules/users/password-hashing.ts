import { argon2id, hash, needsRehash, verify } from 'argon2';

/** OWASP's recommended argon2id baseline: 19 MiB, 2 iterations, 1 lane. */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** The password policy (see dto/password.validators.ts), for code paths outside DTO validation. */
export const PASSWORD_RULE = /^(?![A-Za-z]+$)(?!\d+$).{12,128}$/s;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export const passwordNeedsRehash = (passwordHash: string): boolean =>
  needsRehash(passwordHash, ARGON2_OPTIONS);
