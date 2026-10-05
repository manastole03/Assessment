/** JSON documents passed through from the engine without reshaping (artifacts, results, events). */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Re-type values that were parsed from a JSON body (and so can only hold JSON) after a schema with
 * open-ended fields (`z.looseObject`) widened them to `unknown`.
 */
export function fromParsedJson<T extends object>(values: T[]): JsonObject[] {
  return values as unknown as JsonObject[];
}

export function fromParsedJsonObject<T extends object>(value: T): JsonObject {
  return value as unknown as JsonObject;
}
