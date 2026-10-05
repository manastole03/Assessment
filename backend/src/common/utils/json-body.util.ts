/** Keys that reach object prototypes when a parsed body is copied, merged or transformed. */
const POISONED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor']);

/** Carried in the parser error's message so the exception filter can answer FORBIDDEN_JSON_KEY. */
export const FORBIDDEN_JSON_KEY_MARKER = 'forbidden JSON key';

/**
 * `JSON.parse` reviver for request bodies: reject prototype-poisoning keys outright, as Fastify
 * does by default. Downstream (class-transformer) treats them inconsistently, dropping them, passing
 * them on or throwing, so a body carrying one is refused before any of that code sees it.
 */
export function rejectPoisonedKeys(key: string, value: unknown): unknown {
  if (POISONED_KEYS.has(key)) throw new SyntaxError(`${FORBIDDEN_JSON_KEY_MARKER}: "${key}"`);
  return value;
}
