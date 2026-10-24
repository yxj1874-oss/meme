// MT2 mutation suite (design §3.9, D11-A): every curated mutant in ci/mutants.json, applied alone to
// a copy of the tree, must turn at least one golden red. Run it on the reference substrate so the
// golden hash check is active:  ci/run-in-ref.sh node tools/mutate.ts [mutant-id ...]
// A survivor means the goldens cannot see that change; the report says whether each kill came
// from an oracle assertion or only from the output hashes. --keep leaves each mutated tree in
// out/mutants/<id>/ (for example to run `meme reduce` against it).

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const WORK = join(ROOT, "out", "mutants");

interface Mutant {
  id: string;
  module: string;
  file: string;
  edits: { find: string; replace: string }[];
  expected_red: string[];
}

interface Outcome {
  id: string;
  killed: boolean;
  by_oracle: string[];
  by_hash_only: string[];
  exit: number | null;
  seconds: number;
}

// Plain byte copies: fs.cpSync also copies extended attributes, which the macOS-to-container
// virtiofs mount refuses.
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
    else writeFileSync(join(to, e.name), readFileSync(join(from, e.name)));
  }
}

function prepareTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const d of ["src", "schema", "golden", "test"]) copyTree(join(ROOT, d), join(dir, d));
  for (const f of ["package.json", "package-lock.json"]) writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
}

function applyEdits(dir: string, m: Mutant): void {
  const path = join(dir, m.file);
  let text = readFileSync(path, "utf8");
  for (const e of m.edits) {
    const count = text.split(e.find).length - 1;
    if (count !== 1) throw new Error(`mutant ${m.id}: expected exactly one occurrence in ${m.file}, found ${count}: ${JSON.stringify(e.find)}`);
    text = text.replace(e.find, e.replace);
  }
  writeFileSync(path, text);
}

function verify(dir: string): { exit: number | null; red: { gid: string; oracle: boolean }[]; seconds: number; output: string } {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(dir, "src", "cli.ts"), "golden", "verify", "--require-hashes"], { cwd: dir, encoding: "utf8", timeout: 900_000 });
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const red: { gid: string; oracle: boolean }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^FAIL (\S+)\s+(\d+)\/(\d+) asserts, regression (\S+)/.exec(line);
    if (m) red.push({ gid: m[1]!, oracle: m[2] !== m[3] });
  }
  return { exit: r.status, red, seconds, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const config = JSON.parse(readFileSync(join(ROOT, "ci", "mutants.json"), "utf8")) as { mutants: Mutant[] };
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mutants = only.length > 0 ? config.mutants.filter((m) => only.includes(m.id)) : config.mutants;

// The suite only means something if the unmutated tree is green.
if (!process.argv.includes("--skip-baseline")) {
  const dir = join(WORK, "_baseline");
  prepareTree(dir);
  const base = verify(dir);
  if (base.exit !== 0) {
    console.log(base.output);
    console.log("baseline is red; fix the goldens before running mutants");
    process.exit(1);
  }
  console.log(`baseline green (${base.seconds.toFixed(1)} s)`);
}

const outcomes: Outcome[] = [];
for (const m of mutants) {
  const dir = join(WORK, m.id);
  prepareTree(dir);
  applyEdits(dir, m);
  const v = verify(dir);
  const outcome: Outcome = {
    id: m.id,
    killed: v.exit !== 0,
    by_oracle: v.red.filter((r) => r.oracle).map((r) => r.gid),
    by_hash_only: v.red.filter((r) => !r.oracle).map((r) => r.gid),
    exit: v.exit,
    seconds: v.seconds,
  };
  if (outcome.killed && v.red.length === 0) outcome.by_oracle.push(`(exit ${v.exit}: ${v.output.split("\n").find((l) => /Error/.test(l)) ?? "no FAIL line"})`);
  outcomes.push(outcome);
  console.log(`${outcome.killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(32)} oracle: ${outcome.by_oracle.join(",") || "-"}  hash-only: ${outcome.by_hash_only.join(",") || "-"}  (${v.seconds.toFixed(1)} s)`);
  if (!process.argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
}

const survivors = outcomes.filter((o) => !o.killed);
const hashOnly = outcomes.filter((o) => o.killed && o.by_oracle.length === 0);
writeFileSync(join(WORK, "report.json"), `${JSON.stringify({ outcomes, survivors: survivors.map((s) => s.id), hash_only: hashOnly.map((s) => s.id) }, null, 2)}\n`);
console.log(`mutants: ${outcomes.length - survivors.length}/${outcomes.length} killed, ${hashOnly.length} only by output hashes, ${survivors.length} survived`);
process.exit(survivors.length === 0 ? 0 : 1);
