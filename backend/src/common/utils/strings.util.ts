/** Emails are compared case-insensitively; store them one way. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Trim a free-text query and treat blank as absent. */
export function cleanSearch(search: string | undefined): string | undefined {
  const trimmed = search?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Escape LIKE wildcards in user input: Prisma's `contains` passes `%` and `_` through to SQL LIKE,
 * so a search for "member_not" would otherwise also match "member-not".
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A trimmed, wildcard-escaped search term, or undefined when blank. */
export function searchTerm(search: string | undefined): string | undefined {
  const cleaned = cleanSearch(search);
  return cleaned === undefined ? undefined : escapeLike(cleaned);
}
