// code_hash (design §3.2): every source byte that can influence an output, by sorted path.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { sha256Tag } from "../core/hash.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|wgsl)$/.test(name)) out.push(p);
  }
  return out;
}

let cached: string | undefined;

export function codeHash(): string {
  if (cached !== undefined) return cached;
  const schemas = readdirSync(join(ROOT, "schema")).filter((f) => f.endsWith(".json")).map((f) => join(ROOT, "schema", f));
  const paths = [...files(join(ROOT, "src")), ...schemas, join(ROOT, "package-lock.json")]
    .map((p) => relative(ROOT, p))
    .sort();
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const p of paths) {
    const bytes = readFileSync(join(ROOT, p));
    parts.push(enc.encode(`${p}\u0000${bytes.length}\u0000`), bytes);
  }
  const total = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) {
    total.set(b, o);
    o += b.length;
  }
  cached = sha256Tag(total);
  return cached;
}
