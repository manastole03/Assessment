const FALLBACK = "/overview";
/** Any fixed origin works: only "does it stay on this origin?" matters. */
const BASE = "http://rote.invalid";

/**
 * The internal path to return to after signing in. It is resolved the way the browser will resolve
 * it (where "/\evil.com" and "/<tab>/evil.com" both mean //evil.com) and must stay on this origin;
 * anything else falls back to the overview, so a crafted ?next= cannot redirect off the site.
 */
export function safeNext(value: string | null): string {
  if (!value?.startsWith("/")) return FALLBACK;
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? url.pathname + url.search + url.hash : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
