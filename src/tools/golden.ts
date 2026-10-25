// meme golden verify [gid|set ...]  run every oracle (all sets under golden/, or the named ones); compare output hashes with expected.json when the
//                                substrate matches (L2), otherwise report the hash check as skipped (L3)
// meme golden rebase [gid ...]   same, then write expected.json; refuses while any assertion fails, so
//                                a golden can never be re-baselined onto a broken state
// --require-hashes               a skipped or missing hash check is a failure. CI and the mutation
//                                suite use it on the reference substrate: anything that changes the
//                                substrate id (including our own fingerprint code) must not silently
//                                turn the regression check off.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractViolation } from "../core/errors.ts";
import type { Json } from "../core/json_strict.ts";
import { applyScenePatch } from "../core/patch.ts";
import { type LoadedScene, loadSceneText } from "../core/scene.ts";
import { openGpu } from "../gpu/device.ts";
import { fingerprint, substrateId } from "../gpu/substrate.ts";
import { type Context, evaluate, type Result } from "../oracle/assertions.ts";
import { DEFAULT_PLAN, type ExecutionPlan } from "../runtime/plan.ts";
import { type RunOptions, runScene } from "../runtime/run.ts";
import { allGoldens, ROOT } from "./golden_sets.ts";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

interface RunSpec {
  name: string;
  scene: string;
  plan?: Partial<ExecutionPlan>;
  faults?: Omit<RunOptions, "plan" | "candidates">;
  candidates?: RunOptions["candidates"];
  physics_candidates?: RunOptions["physicsCandidates"];
  patches?: string[];
}

interface Oracle {
  id: string;
  title: string;
  runs: RunSpec[];
  asserts: Record<string, unknown>[];
}

interface Expected {
  substrate_id: string;
  runs: Record<string, Record<string, string>>;
}

export interface GoldenReport {
  id: string;
  pass: boolean;
  results: Result[];
  regression: { status: "pass" | "fail" | "skipped" | "none"; detail?: unknown };
}

function loadRunScene(dir: string, spec: RunSpec): LoadedScene {
  let loaded = loadSceneText(readFileSync(join(dir, spec.scene), "utf8"));
  for (const p of spec.patches ?? []) {
    const ops = JSON.parse(readFileSync(join(dir, p), "utf8")) as Json;
    loaded = applyScenePatch(loaded, { v: 1, base_scene_hash: loaded.scene_hash, ops } as unknown as Json);
  }
  return loaded;
}

export async function verifyGoldens(ids: string[], requireHashes = false, log: (s: string) => void = console.log): Promise<{ reports: GoldenReport[]; substrate: string; outputs: Map<string, Record<string, Record<string, string>>> }> {
  const gpu = await openGpu();
  const substrate = await fingerprint(gpu);
  const sid = substrateId(substrate);
  const all = allGoldens();
  const selected = ids.length > 0 ? all.filter((g) => ids.some((i) => g.id === i || g.id.startsWith(`${i}_`) || g.set === i)) : all;
  const reports: GoldenReport[] = [];
  const outputs = new Map<string, Record<string, Record<string, string>>>();
  log(`substrate ${sid} (${substrate.adapter.description})`);

  for (const { id: gid, dir } of selected) {
    const oracle = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as Oracle;
    const ctx: Context = { root: ROOT, dir, gpu, cli: CLI, runs: new Map() };
    const results: Result[] = [];
    try {
      for (const spec of oracle.runs) {
        const loaded = loadRunScene(dir, spec);
        const options: RunOptions = { plan: { ...DEFAULT_PLAN, ...(spec.plan ?? {}) }, ...(spec.faults ?? {}), ...(spec.candidates ? { candidates: spec.candidates } : {}), ...(spec.physics_candidates ? { physicsCandidates: spec.physics_candidates } : {}) };
        ctx.runs.set(spec.name, { loaded, output: await runScene(gpu, loaded, substrate, options) });
      }
      for (const a of oracle.asserts) results.push(...(await evaluate(ctx, a)));
    } catch (err) {
      results.push({ id: "harness", pass: false, detail: err instanceof ContractViolation ? err.errors : String(err instanceof Error ? err.stack : err) });
    }

    const produced: Record<string, Record<string, string>> = {};
    for (const [name, r] of ctx.runs) produced[name] = r.output.manifest.deterministic.outputs;
    outputs.set(gid, produced);

    let regression: GoldenReport["regression"] = { status: "none" };
    const expPath = join(dir, "expected.json");
    if (existsSync(expPath)) {
      const exp = JSON.parse(readFileSync(expPath, "utf8")) as Expected;
      if (exp.substrate_id !== sid) {
        regression = { status: "skipped", detail: `goldens were recorded on ${exp.substrate_id}; this is ${sid}` };
      } else {
        const diffs: unknown[] = [];
        for (const [name, files] of Object.entries(exp.runs)) {
          for (const [file, hash] of Object.entries(files)) {
            const got = produced[name]?.[file];
            if (got !== hash) diffs.push({ run: name, file, expected: hash, got: got ?? null });
          }
          for (const file of Object.keys(produced[name] ?? {})) if (!(file in files)) diffs.push({ run: name, file, expected: null, got: produced[name]![file] });
        }
        regression = diffs.length === 0 ? { status: "pass" } : { status: "fail", detail: diffs };
      }
    }

    if (requireHashes && oracle.runs.length > 0 && (regression.status === "skipped" || regression.status === "none")) {
      regression = { status: "fail", detail: { required: true, was: regression } };
    }
    const pass = results.every((r) => r.pass) && regression.status !== "fail";
    const report: GoldenReport = { id: gid, pass, results, regression };
    reports.push(report);
    const outDir = join(ROOT, "out", "golden", gid);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const failed = results.filter((r) => !r.pass);
    log(`${pass ? "PASS" : "FAIL"} ${gid}  ${results.length - failed.length}/${results.length} asserts, regression ${regression.status}${failed.length ? `  failing: ${failed.map((f) => f.id).join(", ")}` : ""}`);
  }
  gpu.destroy();
  return { reports, substrate: sid, outputs };
}

export async function cmdGolden(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const requireHashes = rest.includes("--require-hashes");
  const ids = rest.filter((a) => !a.startsWith("--"));
  if (sub !== "verify" && sub !== "rebase") {
    console.error("usage: meme golden verify|rebase [gid ...]");
    return 1;
  }
  const { reports, substrate, outputs } = await verifyGoldens(ids, requireHashes && sub === "verify");
  const assertionFailures = reports.filter((r) => r.results.some((x) => !x.pass));
  if (sub === "rebase") {
    if (assertionFailures.length > 0) {
      console.error(`refusing to rebase: ${assertionFailures.map((r) => r.id).join(", ")} fail their oracles`);
      return 6;
    }
    const dirs = new Map(allGoldens().map((g) => [g.id, g.dir]));
    for (const [gid, runs] of outputs) {
      if (Object.keys(runs).length === 0) continue;
      const expected: Expected = { substrate_id: substrate, runs };
      writeFileSync(join(dirs.get(gid)!, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
    }
    console.log(`rebased ${outputs.size} goldens on ${substrate}`);
    return 0;
  }
  const failed = reports.filter((r) => !r.pass);
  console.log(`golden: ${reports.length - failed.length}/${reports.length} pass`);
  return failed.length === 0 ? 0 : 6;
}
