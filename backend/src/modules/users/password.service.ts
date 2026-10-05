import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { hashPassword, passwordNeedsRehash, verifyPassword } from './password-hashing.js';

/**
 * Password hashing. Plaintext passwords exist only inside a request; what is stored is an argon2id
 * PHC string, which carries its own salt and parameters (so they can be raised later).
 */
@Injectable()
export class PasswordService {
  /** A valid hash of a random string, verified against when the user does not exist (equal timing). */
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verifyPassword(passwordHash, password);
  }

  /** Spend the same time as a real verification, so response timing does not reveal unknown emails. */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(await this.dummyHash, password);
  }

  needsRehash(passwordHash: string): boolean {
    return passwordNeedsRehash(passwordHash);
  }
}
