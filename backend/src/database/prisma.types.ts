import type { Prisma } from '../generated/prisma/client.js';

/** A client inside `$transaction(async (tx) => ...)`: repositories accept it to join a transaction. */
export type TransactionClient = Prisma.TransactionClient;

/** True for a unique-constraint violation (optionally on a given column). */
export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'P2002') return false;
  if (!field) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target)
    ? target.map((name) => String(name))
    : typeof target === 'string'
      ? [target]
      : [];
  return fields.some((name) => name.includes(field)) || JSON.stringify(error).includes(field);
}
