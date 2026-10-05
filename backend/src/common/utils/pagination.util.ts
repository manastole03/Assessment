import type { PaginationMeta } from '../interfaces/api-response.interface.js';

export interface PageRequest {
  page: number;
  limit: number;
}

/**
 * A page of results. Services return this; the response interceptor turns it into
 * `{ success, data: items, meta }`, so every collection endpoint has the same shape.
 */
export class PaginatedResult<T> {
  readonly meta: PaginationMeta;

  constructor(
    readonly items: T[],
    total: number,
    { page, limit }: PageRequest,
  ) {
    this.meta = { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) };
  }

  map<U>(fn: (item: T) => U): PaginatedResult<U> {
    return new PaginatedResult(this.items.map(fn), this.meta.total, this.meta);
  }
}

/** Prisma `skip`/`take` for a page. */
export function toSkipTake({ page, limit }: PageRequest): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

/** Page an in-memory list (engine-backed collections, which are small and come whole). */
export function paginateArray<T>(items: readonly T[], request: PageRequest): PaginatedResult<T> {
  const { skip, take } = toSkipTake(request);
  return new PaginatedResult(items.slice(skip, skip + take), items.length, request);
}

/** A comparator for in-memory sorting on a whitelisted key. */
export function compareBy<T>(
  key: (item: T) => string | number | null | undefined,
  order: 'asc' | 'desc',
) {
  const direction = order === 'asc' ? 1 : -1;
  return (a: T, b: T): number => {
    const left = key(a);
    const right = key(b);
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return (left < right ? -1 : 1) * direction;
  };
}
