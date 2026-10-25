// MT5 threshold lock (design §② MT5): "no widening a threshold instead of fixing the bug", made
// machine-checkable. Every tolerance in golden/<set>/*/oracle.json (an assertion's `tol` and each of
// its named `bounds`) must carry a derivation and a source, and the set is locked in
// golden/thresholds.lock. A change to any locked value
// passes only when docs/adr/ has a record naming the golden whose tolerance changed.
// Usage: node tools/thresholds.ts --check | --write

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { allGoldens } from "../src/tools/golden_sets.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const LOCK = join(ROOT, "golden", "thresholds.lock");
const ADR = join(ROOT, "docs", "adr");

interface Tol {
  value: number | null;
  derivation: string;
  source: string;
}

function collect(): { entries: Record<string, Tol>; missing: string[] } {
  const entries: Record<string, Tol> = {};
  const missing: string[] = [];
  for (const { id: gid, dir } of allGoldens()) {
    const oracle = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as { asserts: Record<string, unknown>[] };
    const visit = (a: Record<string, unknown>, id: string) => {
      const tol = a["tol"] as Tol | undefined;
      if (tol !== undefined) {
        if (!tol.derivation || !tol.source) missing.push(`${gid}/${id}`);
        entries[`${gid}/${id}`] = { value: tol.value, derivation: tol.derivation, source: tol.source };
      }
      for (const [name, b] of Object.entries((a["bounds"] ?? {}) as Record<string, Tol>)) {
        if (!b.derivation || !b.source) missing.push(`${gid}/${id}#${name}`);
        entries[`${gid}/${id}#${name}`] = { value: b.value, derivation: b.derivation, source: b.source };
      }
      if (typeof a["inner"] === "object" && a["inner"] !== null) visit(a["inner"] as Record<string, unknown>, `${id}:inner`);
    };
    for (const a of oracle.asserts) visit(a, String(a["id"]));
  }
  return { entries, missing };
}

const { entries, missing } = collect();
for (const m of missing) console.log(`tolerance without derivation or source: ${m}`);

if (process.argv.includes("--write")) {
  writeFileSync(LOCK, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`locked ${Object.keys(entries).length} tolerances`);
  process.exit(missing.length === 0 ? 0 : 1);
}

const locked = existsSync(LOCK) ? (JSON.parse(readFileSync(LOCK, "utf8")) as Record<string, Tol>) : {};
const adrText = existsSync(ADR) ? readdirSync(ADR).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(ADR, f), "utf8")).join("\n") : "";
// A new or removed tolerance (a golden added or retired) only needs the lock rewritten; changing a
// locked value is what needs an ADR.
const changed: string[] = [];
const stale: string[] = [];
for (const key of [...new Set([...Object.keys(locked), ...Object.keys(entries)])].sort()) {
  const was = locked[key];
  const now = entries[key];
  if (was === undefined || now === undefined) {
    stale.push(key);
    console.log(`lock out of date (${was === undefined ? "new" : "removed"} tolerance ${key}): run node tools/thresholds.ts --write`);
  } else if (was.value !== now.value) {
    const gid = key.split("/")[0]!;
    const justified = adrText.includes(gid);
    changed.push(`${key}: ${JSON.stringify(was.value)} -> ${JSON.stringify(now.value)}${justified ? " (ADR present)" : ""}`);
    if (!justified) console.log(`tolerance changed without an ADR naming ${gid}: ${changed.at(-1)}`);
  }
}
const unjustified = changed.filter((c) => !c.endsWith("(ADR present)"));
console.log(`thresholds: ${Object.keys(entries).length} in oracles, ${changed.length} changed, ${unjustified.length} unjustified, ${stale.length} not in the lock, ${missing.length} undocumented`);
process.exit(unjustified.length === 0 && stale.length === 0 && missing.length === 0 ? 0 : 1);
