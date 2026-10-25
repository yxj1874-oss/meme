// Shared by the golden generators (tools/gen_golden.ts, gen_golden_p1.ts, gen_golden_p2.ts):
// write a set's files, or with --check report every file that differs from what would be written.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GoldenDef {
  id: string;
  title: string;
  covers: string[];
  kills: string[];
  files: Record<string, string>;
  runs: unknown[];
  asserts: unknown[];
}

export const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export const tol = (value: number | null, derivation: string, source: string) => ({ value, derivation, source });

/** Writes (or checks) every golden of a set. Files a generator does not own (expected.json, frozen snapshots) are left alone. */
export function emitSet(setDir: string, goldens: GoldenDef[], check: boolean, keep: (gid: string, file: string) => boolean = () => false): number {
  let drift = 0;
  for (const g of goldens) {
    const dir = join(setDir, g.id);
    const oracle = { id: g.id, title: g.title, covers: g.covers, kills: g.kills, runs: g.runs, asserts: g.asserts };
    const files: Record<string, string> = { ...g.files, "oracle.json": json(oracle) };
    for (const [name, text] of Object.entries(files)) {
      const p = join(dir, name);
      if (check) {
        if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
          console.log(`out of date: ${p}`);
          drift++;
        }
      } else {
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, text);
      }
    }
    // Files left over from an earlier generator version: stale unless recorded (expected.json) or kept.
    for (const name of existsSync(dir) ? listFiles(dir) : []) {
      if (name in files || name === "expected.json" || keep(g.id, name)) continue;
      if (check) {
        console.log(`stale: ${join(dir, name)}`);
        drift++;
      } else {
        rmSync(join(dir, name));
      }
    }
  }
  if (!check) {
    for (const g of readdirSync(setDir, { withFileTypes: true })) {
      if (g.isDirectory() && !goldens.some((o) => o.id === g.name) && !keep(g.name, "")) rmSync(join(setDir, g.name), { recursive: true });
    }
  }
  return drift;
}

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, join(prefix, e.name)) : [join(prefix, e.name)]);
}
