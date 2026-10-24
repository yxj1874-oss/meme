// MT5 threshold lock (design §② MT5): "no widening a threshold instead of fixing the bug", made
// machine-checkable. Every tolerance in golden/p0/*/oracle.json must carry a derivation and a source,
// and the set of tolerances is locked in golden/p0/thresholds.lock. A change to any locked value
// passes only when docs/adr/ has a record naming the golden whose tolerance changed.
// Usage: node tools/thresholds.ts --check | --write

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const P0 = join(ROOT, "golden", "p0");
const LOCK = join(P0, "thresholds.lock");
const ADR = join(ROOT, "docs", "adr");

interface Tol {
  value: number | null;
  derivation: string;
  source: string;
}

function collect(): { entries: Record<string, Tol>; missing: string[] } {
  const entries: Record<string, Tol> = {};
  const missing: string[] = [];
  for (const gid of readdirSync(P0, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const oracle = JSON.parse(readFileSync(join(P0, gid, "oracle.json"), "utf8")) as { asserts: Record<string, unknown>[] };
    const visit = (a: Record<string, unknown>, id: string) => {
      const tol = a["tol"] as Tol | undefined;
      if (tol !== undefined) {
        if (!tol.derivation || !tol.source) missing.push(`${gid}/${id}`);
        entries[`${gid}/${id}`] = { value: tol.value, derivation: tol.derivation, source: tol.source };
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
const changed: string[] = [];
for (const key of [...new Set([...Object.keys(locked), ...Object.keys(entries)])].sort()) {
  const was = locked[key];
  const now = entries[key];
  if (was === undefined || now === undefined || was.value !== now.value) {
    const gid = key.split("/")[0]!;
    const justified = adrText.includes(gid);
    changed.push(`${key}: ${JSON.stringify(was?.value)} -> ${JSON.stringify(now?.value)}${justified ? " (ADR present)" : ""}`);
    if (!justified) console.log(`tolerance changed without an ADR naming ${gid}: ${changed.at(-1)}`);
  }
}
const unjustified = changed.filter((c) => !c.endsWith("(ADR present)"));
console.log(`thresholds: ${Object.keys(entries).length} locked, ${changed.length} changed, ${unjustified.length} unjustified, ${missing.length} undocumented`);
process.exit(unjustified.length === 0 && missing.length === 0 ? 0 : 1);
