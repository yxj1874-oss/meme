// Minimal reproducing scene (design §3.10, "最小复现 scene.json"). Given a scene and an assertion it
// fails, shrink the scene while the same assertion keeps failing:
//   1. ddmin (Zeller & Hildebrandt, "Simplifying and Isolating Failure-Inducing Input", IEEE TSE
//      28(2), 2002) over object ids, then material ids;
//   2. halve render size, spp and bounces, and physics steps;
//   3. round numbers to fewer significant digits.
// Candidates are tried in canonical order with no randomness, so a reduction is reproducible.
//
//   meme reduce <gid> [--assert ID]       first failing assertion of out/golden/<gid>/report.json
//   meme reduce --all-failing             every failing golden in out/golden/*/report.json

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractViolation } from "../core/errors.ts";
import { deepClone } from "../core/jcs.ts";
import type { Json } from "../core/json_strict.ts";
import { applyScenePatch } from "../core/patch.ts";
import { loadSceneText, loadSceneValue } from "../core/scene.ts";
import { type Gpu, openGpu } from "../gpu/device.ts";
import { fingerprint, type Substrate } from "../gpu/substrate.ts";
import { type Context, evaluate } from "../oracle/assertions.ts";
import { DEFAULT_PLAN, planProblem } from "../runtime/plan.ts";
import { type RunOptions, runScene } from "../runtime/run.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** ddmin: a 1-minimal subset of items on which fails() still holds (fails(items) must be true). */
export async function ddmin<T>(items: T[], fails: (subset: T[]) => Promise<boolean>): Promise<T[]> {
  let current = items;
  let n = 2;
  while (current.length >= 2) {
    const size = Math.ceil(current.length / n);
    const chunks: T[][] = [];
    for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (await fails(chunk)) {
        current = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced && chunks.length > 2) {
      for (let i = 0; i < chunks.length; i++) {
        const complement = chunks.filter((_, j) => j !== i).flat();
        if (await fails(complement)) {
          current = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  if (current.length === 1 && (await fails([]))) return [];
  return current;
}

interface RunSpec {
  name: string;
  scene: string;
  plan?: Record<string, unknown>;
  faults?: Omit<RunOptions, "plan">;
  patches?: string[];
}

export interface ReduceTarget {
  /** Directory the oracle's relative paths resolve against. */
  dir: string;
  scene: Json;
  /** Runs the assertion reads; they all use `scene` (with their own plan, faults, patches). */
  runs: RunSpec[];
  assertion: Record<string, unknown>;
}

export interface ReduceResult {
  scene: Json;
  evaluations: number;
  before: { objects: number; materials: number };
  after: { objects: number; materials: number };
  steps: string[];
}

export async function reduce(gpu: Gpu, substrate: Substrate, target: ReduceTarget, maxEvaluations = 400): Promise<ReduceResult> {
  let evaluations = 0;
  const cache = new Map<string, boolean>();
  const fails = async (candidate: Json): Promise<boolean> => {
    const key = JSON.stringify(candidate);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (evaluations >= maxEvaluations) return false;
    evaluations++;
    let result: boolean;
    const render = (candidate as { render?: { width_px: number; height_px: number } }).render;
    if (render !== undefined && target.runs.some((r) => planProblem(render.width_px, render.height_px, { ...DEFAULT_PLAN, ...(r.plan ?? {}) }) !== null)) {
      cache.set(key, false); // e.g. an explicit tile_order no longer covers a smaller image
      return false;
    }
    try {
      const base = loadSceneValue(candidate);
      const ctx: Context = { root: ROOT, dir: target.dir, gpu, cli: CLI, runs: new Map() };
      for (const spec of target.runs) {
        let loaded = base;
        for (const p of spec.patches ?? []) {
          const ops = JSON.parse(readFileSync(join(target.dir, p), "utf8")) as Json;
          loaded = applyScenePatch(loaded, { v: 1, base_scene_hash: loaded.scene_hash, ops } as unknown as Json);
        }
        const options: RunOptions = { plan: { ...DEFAULT_PLAN, ...(spec.plan ?? {}) }, ...(spec.faults ?? {}) };
        ctx.runs.set(spec.name, { loaded, output: await runScene(gpu, loaded, substrate, options) });
      }
      result = (await evaluate(ctx, target.assertion)).some((r) => !r.pass);
    } catch (err) {
      // An invalid candidate does not reproduce the failure; anything else is a harness bug.
      if (!(err instanceof ContractViolation)) throw err;
      result = false;
    }
    cache.set(key, result);
    return result;
  };

  const steps: string[] = [];
  let scene = deepClone(target.scene) as Record<string, any>;
  if (!(await fails(scene))) throw new Error("the assertion does not fail on the starting scene");
  const before = { objects: Object.keys(scene["objects"]).length, materials: Object.keys(scene["materials"]).length };

  for (const map of ["objects", "materials"] as const) {
    const keys = Object.keys(scene[map]).sort();
    const keep = await ddmin(keys, (subset) => {
      const s = deepClone(scene) as Record<string, any>;
      s[map] = Object.fromEntries(subset.map((k) => [k, scene[map][k]]));
      return fails(s);
    });
    if (keep.length < keys.length) steps.push(`${map}: ${keys.length} -> ${keep.length} (${keep.join(", ")})`);
    scene[map] = Object.fromEntries(keep.map((k) => [k, scene[map][k]]));
  }

  const tryShrink = async (label: string, mutate: (s: Record<string, any>) => boolean) => {
    for (;;) {
      const s = deepClone(scene) as Record<string, any>;
      if (!mutate(s) || !(await fails(s))) return;
      scene = s;
      steps.push(label);
    }
  };
  if (scene["render"]) {
    await tryShrink("render: halve resolution", (s) => {
      if (s["render"].width_px <= 8 || s["render"].height_px <= 8) return false;
      s["render"].width_px = Math.ceil(s["render"].width_px / 2);
      s["render"].height_px = Math.ceil(s["render"].height_px / 2);
      return true;
    });
    await tryShrink("render: halve spp", (s) => (s["render"].spp > 1 ? ((s["render"].spp = Math.ceil(s["render"].spp / 2)), true) : false));
    await tryShrink("render: one bounce fewer", (s) => (s["render"].max_bounces > 0 ? (s["render"].max_bounces--, true) : false));
  }
  if (scene["physics"]) {
    await tryShrink("physics: halve steps", (s) => {
      if (s["physics"].steps <= 1) return false;
      s["physics"].steps = Math.ceil(s["physics"].steps / 2);
      s["physics"].record_every_steps = Math.min(s["physics"].record_every_steps, s["physics"].steps);
      return true;
    });
  }

  // Round numbers to 2 significant digits where the failure survives it, one value at a time.
  const paths: (string | number)[][] = [];
  const collect = (v: any, path: (string | number)[]) => {
    if (typeof v === "number" && !Number.isInteger(v)) paths.push(path);
    else if (Array.isArray(v)) v.forEach((x, i) => collect(x, [...path, i]));
    else if (v !== null && typeof v === "object") for (const k of Object.keys(v).sort()) collect(v[k], [...path, k]);
  };
  collect(scene, []);
  let rounded = 0;
  for (const path of paths) {
    const s = deepClone(scene) as Record<string, any>;
    let node: any = s;
    for (const k of path.slice(0, -1)) node = node[k];
    const last = path.at(-1)!;
    const simpler = Number(Number(node[last]).toPrecision(2));
    if (simpler === node[last]) continue;
    node[last] = simpler;
    if (await fails(s)) {
      scene = s;
      rounded++;
    }
  }
  if (rounded > 0) steps.push(`numbers: ${rounded} rounded to 2 significant digits`);

  return { scene, evaluations, before, after: { objects: Object.keys(scene["objects"]).length, materials: Object.keys(scene["materials"]).length }, steps };
}

function resolveGolden(id: string): string | undefined {
  const p0 = join(ROOT, "golden", "p0");
  return readdirSync(p0).find((g) => g === id || g.startsWith(`${id}_`));
}

function targetFromGolden(gid: string, assertId?: string): ReduceTarget | string {
  const dir = join(ROOT, "golden", "p0", gid);
  const oracle = JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as { runs: RunSpec[]; asserts: Record<string, unknown>[] };
  const reportPath = join(ROOT, "out", "golden", gid, "report.json");
  let id = assertId;
  if (id === undefined && existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { results: { id: string; pass: boolean }[] };
    const failed = report.results.find((r) => !r.pass);
    if (failed !== undefined) id = oracle.asserts.find((a) => failed.id === a["id"] || failed.id.startsWith(`${String(a["id"])}:`))?.["id"] as string | undefined;
  }
  const assertion = oracle.asserts.find((a) => a["id"] === id);
  if (assertion === undefined) return `${gid}: no failing assertion to reduce`;
  const names = [assertion["run"], ...((assertion["runs"] as string[] | undefined) ?? [])].filter((x): x is string => typeof x === "string");
  const runs = oracle.runs.filter((r) => names.includes(r.name));
  const scenes = new Set(runs.map((r) => r.scene));
  if (runs.length === 0 || scenes.size !== 1) return `${gid}/${String(id)}: assertion does not read exactly one scene file; not reducible`;
  const sceneFile = [...scenes][0]!;
  return { dir, scene: loadSceneText(readFileSync(join(dir, sceneFile), "utf8")).scene as unknown as Json, runs, assertion };
}

export async function cmdReduce(args: string[]): Promise<number> {
  const assertIdx = args.indexOf("--assert");
  const assertId = assertIdx >= 0 ? args[assertIdx + 1] : undefined;
  let gids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--assert");
  if (args.includes("--all-failing")) {
    const dir = join(ROOT, "out", "golden");
    gids = existsSync(dir) ? readdirSync(dir).filter((g) => existsSync(join(dir, g, "report.json")) && !JSON.parse(readFileSync(join(dir, g, "report.json"), "utf8")).pass).sort() : [];
  }
  if (gids.length === 0) {
    console.log("nothing to reduce");
    return 0;
  }
  const gpu = await openGpu();
  const substrate = await fingerprint(gpu);
  for (const id of gids) {
    const gid = resolveGolden(id);
    if (gid === undefined) {
      console.log(`${id}: no such golden`);
      continue;
    }
    const target = targetFromGolden(gid, assertId);
    if (typeof target === "string") {
      console.log(target);
      continue;
    }
    const r = await reduce(gpu, substrate, target);
    const out = join(ROOT, "out", "reduce", gid, String(target.assertion["id"]));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "min_repro.scene.json"), `${JSON.stringify(r.scene, null, 2)}\n`);
    writeFileSync(join(out, "repro.oracle.json"), `${JSON.stringify({ runs: target.runs.map((s) => ({ ...s, scene: "min_repro.scene.json" })), asserts: [target.assertion] }, null, 2)}\n`);
    writeFileSync(join(out, "log.json"), `${JSON.stringify({ evaluations: r.evaluations, before: r.before, after: r.after, steps: r.steps }, null, 2)}\n`);
    console.log(`${gid}/${String(target.assertion["id"])}: objects ${r.before.objects} -> ${r.after.objects}, materials ${r.before.materials} -> ${r.after.materials}, ${r.evaluations} evaluations -> ${join(out, "min_repro.scene.json")}`);
  }
  gpu.destroy();
  return 0;
}
