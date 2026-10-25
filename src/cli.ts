#!/usr/bin/env node
// meme CLI.
//   meme run <scene.json> [--out DIR] [--plan plan.json] [--faults faults.json] [--repeat-in-process]
//   meme determinism-check <scene.json> [<scene.json> ...]
//   meme golden verify|rebase [gid ...] [--require-hashes]
//   meme reduce <gid> [--assert ID] | --all-failing
//   meme probe fbh
// Exit codes: 0 ok, 1 usage/internal error, 2 contract violation, 3 nondeterminism,
//             4 non-finite values (V-NaN), 5 energy bound violated (V-Energy), 6 oracle failure.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractViolation } from "./core/errors.ts";
import { jcs } from "./core/jcs.ts";
import { loadSceneText } from "./core/scene.ts";
import { openGpu } from "./gpu/device.ts";
import { fingerprint, probeFbh } from "./gpu/substrate.ts";
import { nowMs } from "./perf/clock.ts";
import type { ExecutionPlan } from "./runtime/plan.ts";
import { DEFAULT_PLAN } from "./runtime/plan.ts";
import { exitCodeFor, type RunOptions, runScene } from "./runtime/run.ts";
import { compareRuns, determinismCheck } from "./tools/determinism.ts";
import { writeRun } from "./tools/io.ts";

export const EXIT = { OK: 0, USAGE: 1, CONTRACT: 2, NONDETERMINISM: 3, NONFINITE: 4, ENERGY: 5, ORACLE: 6, PHYSICS_LIMIT: 7 } as const;

const CLI = fileURLToPath(import.meta.url);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdRun(args: string[]): Promise<number> {
  const scenePath = args[0];
  if (scenePath === undefined) throw new Error("usage: meme run <scene.json> [--out DIR]");
  const loaded = loadSceneText(readFileSync(scenePath, "utf8"));
  const planPath = flag(args, "--plan");
  const plan: ExecutionPlan = planPath ? { ...DEFAULT_PLAN, ...(JSON.parse(readFileSync(planPath, "utf8")) as Partial<ExecutionPlan>) } : DEFAULT_PLAN;
  const faultsPath = flag(args, "--faults");
  const options: RunOptions = { plan, ...(faultsPath ? (JSON.parse(readFileSync(faultsPath, "utf8")) as RunOptions) : {}) };
  const gpu = await openGpu();
  const substrate = await fingerprint(gpu);
  const t0 = nowMs();
  const out = await runScene(gpu, loaded, substrate, options);
  out.manifest.perf.wall_ms = nowMs() - t0;
  if (args.includes("--repeat-in-process")) {
    const again = await runScene(gpu, loaded, substrate, options);
    const diffs = compareRuns(out.files, again.files);
    if (diffs.length > 0 || jcs(out.manifest.deterministic) !== jcs(again.manifest.deterministic)) {
      console.error(JSON.stringify({ error: "in-process rerun differs", diffs }, null, 2));
      return EXIT.NONDETERMINISM;
    }
  }
  const dir = flag(args, "--out") ?? join("out", basename(scenePath, ".json"));
  writeRun(dir, out);
  gpu.destroy();
  console.log(JSON.stringify({ out: dir, key: out.manifest.key, validators: out.manifest.deterministic.validators.map((v) => `${v.name}:${v.pass ? "pass" : "FAIL"}`) }));
  return exitCodeFor(out.manifest);
}

async function cmdDeterminism(args: string[]): Promise<number> {
  if (args.length === 0) throw new Error("usage: meme determinism-check <scene.json> [<scene.json> ...]");
  let ok = true;
  for (const scenePath of args) {
    const work = join("out", "determinism", basename(dirname(scenePath)), basename(scenePath, ".json"));
    const report = determinismCheck(CLI, scenePath, work);
    console.log(JSON.stringify({ scene: scenePath, pass: report.pass, divergences: report.divergences, report: join(work, "nondet_report.json") }));
    ok &&= report.pass;
  }
  return ok ? EXIT.OK : EXIT.NONDETERMINISM;
}

async function cmdProbe(args: string[]): Promise<number> {
  const gpu = await openGpu();
  if (args[0] === "fbh") console.log(JSON.stringify({ adapter: gpu.adapter, ...(await probeFbh(gpu)) }, null, 2));
  else throw new Error("usage: meme probe fbh");
  gpu.destroy();
  return EXIT.OK;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(rest);
      case "determinism-check":
        return await cmdDeterminism(rest);
      case "golden": {
        const { cmdGolden } = await import("./tools/golden.ts");
        return await cmdGolden(rest);
      }
      case "reduce": {
        const { cmdReduce } = await import("./tools/reduce.ts");
        return await cmdReduce(rest);
      }
      case "probe":
        return await cmdProbe(rest);
      default:
        console.error("commands: run, determinism-check, golden, reduce, probe");
        return EXIT.USAGE;
    }
  } catch (err) {
    if (err instanceof ContractViolation) {
      console.error(JSON.stringify({ errors: err.errors }, null, 2));
      return EXIT.CONTRACT;
    }
    console.error(err instanceof Error ? err.stack : err);
    return EXIT.USAGE;
  }
}

if (process.argv[1] === CLI) process.exitCode = await main(process.argv.slice(2));
