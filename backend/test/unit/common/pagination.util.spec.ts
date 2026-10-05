import {
  compareBy,
  PaginatedResult,
  paginateArray,
  toSkipTake,
} from '../../../src/common/utils/pagination.util.js';

describe('pagination', () => {
  it('computes meta, including the empty case', () => {
    expect(new PaginatedResult([1, 2], 41, { page: 1, limit: 20 }).meta).toEqual({
      page: 1,
      limit: 20,
      total: 41,
      totalPages: 3,
    });
    expect(new PaginatedResult([], 0, { page: 1, limit: 20 }).meta.totalPages).toBe(0);
  });

  it('turns a page into skip/take', () => {
    expect(toSkipTake({ page: 3, limit: 25 })).toEqual({ skip: 50, take: 25 });
  });

  it('pages in-memory lists', () => {
    const page = paginateArray([1, 2, 3, 4, 5], { page: 2, limit: 2 });
    expect(page.items).toEqual([3, 4]);
    expect(page.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(paginateArray([1, 2], { page: 9, limit: 2 }).items).toEqual([]);
  });

  it('maps items without touching meta', () => {
    const page = new PaginatedResult([1, 2], 2, { page: 1, limit: 2 }).map((n) => n * 10);
    expect(page.items).toEqual([10, 20]);
    expect(page.meta.total).toBe(2);
  });

  it('sorts by a key in either direction, nulls last', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 1 }, { v: 3 }];
    expect([...rows].sort(compareBy((r) => r.v, 'asc')).map((r) => r.v)).toEqual([1, 2, 3, null]);
    expect([...rows].sort(compareBy((r) => r.v, 'desc')).map((r) => r.v)).toEqual([3, 2, 1, null]);
  });
});

describe('search terms', () => {
  it('escapes LIKE wildcards and drops blanks', async () => {
    const { escapeLike, searchTerm } = await import('../../../src/common/utils/strings.util.js');
    expect(escapeLike('member_not 100%')).toBe('member\\_not 100\\%');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(searchTerm('   ')).toBeUndefined();
    expect(searchTerm(' a_b ')).toBe('a\\_b');
  });
});
