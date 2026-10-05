/** The internal path to return to after signing in (never an absolute or protocol-relative URL). */
export function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/overview";
}
