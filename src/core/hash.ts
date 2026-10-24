import { createHash } from "node:crypto";

import { jcsBytes } from "./jcs.ts";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** "sha256:<hex>", the prefixed form used in manifests and patch envelopes. */
export function sha256Tag(data: Uint8Array | string): string {
  return `sha256:${sha256Hex(data)}`;
}

export function jcsHash(value: unknown): string {
  return sha256Tag(jcsBytes(value));
}

/** FNV-1a 32-bit over UTF-8 bytes. Used as the entity word in RNG counters (x-rng-streams.id_word). */
export function idhash32(id: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(id)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
