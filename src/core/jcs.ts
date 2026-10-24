// RFC 8785 JSON Canonicalization Scheme.
// Numbers use the ECMAScript Number-to-String algorithm (§3.2.2.3), strings use JSON.stringify
// escaping, and object members are ordered by UTF-16 code units (§3.2.3). Entity ids are ASCII,
// so this order is also the UTF-8 byte order that canonicalEntries() promises.

import type { Json } from "./json_strict.ts";

export function jcs(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: NaN and Infinity have no JSON representation (RFC 8785 §3.2.2.3)");
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
      const obj = value as { [key: string]: unknown };
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcs(value));
}

/** Entries of an id-keyed map in canonical order. All entity iteration in the runtime goes through here. */
export function canonicalEntries<T>(map: { [key: string]: T }): [string, T][] {
  return Object.keys(map).sort().map((k) => [k, map[k] as T]);
}

export function deepClone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
