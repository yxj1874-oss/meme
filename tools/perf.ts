// MT3 performance gate (design §② MT3), two parts:
//  - Work counters (rays, ray-primitive tests, physics steps, gpu_bytes_peak, which is the D12-A
//    "VRAM" metric) are deterministic for a substrate and do not depend on the CPU, so they are
//    gated exactly against ci/perf-baseline.json: at most 1.10x.
//  - Wall time is only compared on one machine, in one process, against the parent commit: --base
//    points at a git worktree of it, and base and head runs alternate (the order flips every round
//    so drift cancels); each timed sample covers at least 100 ms, repeating short scenes. median(head) / median(base) may not exceed 1.10; a miss is re-measured
//    twice before it counts. A stored wall-time baseline compares two machines, not two versions:
//    the first CI run measured the GitHub runner 2.56x slower than the M6 with identical work.
// Usage (--expose-gc lets each timed sample start after a full collection):
//   node tools/perf.ts --write                                    record work counters for this substrate
//   node --expose-gc tools/perf.ts --check [--require-baseline] [--base DIR]   no --base: A/B skipped

import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { nowMs } from "../src/perf/clock.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const BASELINE = join(ROOT, "ci", "perf-baseline.json");
const BENCH = ["golden/p0/g01_det_double_run/scene.json", "golden/p0/g16_physics_extremes/scene_far.json", "golden/p2/g45_det_plan_invariance_p2/scene.json"];
const ROUNDS = 9;
const LIMIT = 1.1;

type Work = Record<string, number>;
type Baseline = Record<string, { adapter: string; scenes: Record<string, { work: Work }> }>;

interface Tree {
  label: string;
  substrateId: string;
  adapter: string;
  run(scene: string): Promise<{ wallMs: number; work: Work }>;
  destroy(): void;
}

/**
 * Loads the runtime of a source tree (this checkout or a worktree of another commit) through its
 * own modules, so each tree runs its own code on its own device.
 */
async function loadTree(root: string, label: string): Promise<Tree> {
  if (!existsSync(join(root, "node_modules"))) {
    // Worktrees have no dependencies of their own; borrow the ones of the checkout we run from.
    const deps = join(process.cwd(), "node_modules");
    if (!existsSync(deps) || resolve(deps) === resolve(root, "node_modules")) throw new Error(`no node_modules to link into ${root}; run from the repository root`);
    symlinkSync(relative(root, deps), join(root, "node_modules"));
  }
  const mod = (p: string) => import(pathToFileURL(join(root, p)).href);
  const [{ loadSceneText }, { openGpu }, { fingerprint, substrateId }, { DEFAULT_PLAN }, { runScene }] = await Promise.all([
    mod("src/core/scene.ts"),
    mod("src/gpu/device.ts"),
    mod("src/gpu/substrate.ts"),
    mod("src/runtime/plan.ts"),
    mod("src/runtime/run.ts"),
  ]);
  const gpu = await openGpu();
  const substrate = await fingerprint(gpu);
  const scenes = new Map<string, unknown>();
  const load = (scene: string) => {
    if (!scenes.has(scene)) {
      // The head's scene file first; if this tree's schema rejects it, the tree's own copy.
      try {
        scenes.set(scene, loadSceneText(readFileSync(join(ROOT, scene), "utf8")));
      } catch (err) {
        if (!existsSync(join(root, scene))) throw err;
        scenes.set(scene, loadSceneText(readFileSync(join(root, scene), "utf8")));
      }
    }
    return scenes.get(scene);
  };
  return {
    label,
    substrateId: substrateId(substrate),
    adapter: substrate.adapter.description,
    async run(scene) {
      const loaded = load(scene);
      const t0 = nowMs();
      const out = await runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN });
      return { wallMs: nowMs() - t0, work: { ...out.manifest.deterministic.work } };
    },
    destroy: () => gpu.destroy(),
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Shortest timed sample; short scenes repeat inside one sample so timer and scheduler noise stay small. */
const MIN_SAMPLE_MS = 100;

async function abRatio(head: Tree, base: Tree, scene: string): Promise<{ head: number; base: number; ratio: number; reps: number }> {
  await head.run(scene); // warm-up: pipeline compilation
  const warm = (await base.run(scene)).wallMs;
  const reps = Math.max(1, Math.ceil(MIN_SAMPLE_MS / Math.max(warm, 0.01)));
  const sample = async (t: Tree) => {
    // A collection inside a timed sample is the largest noise source left; start every sample clean.
    (globalThis as { gc?: () => void }).gc?.();
    let total = 0;
    for (let i = 0; i < reps; i++) total += (await t.run(scene)).wallMs;
    return total / reps;
  };
  const th: number[] = [];
  const tb: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const order = r % 2 === 0 ? [base, head] : [head, base];
    for (const t of order) (t === head ? th : tb).push(await sample(t));
  }
  const h = median(th);
  const b = median(tb);
  return { head: h, base: b, ratio: h / b, reps };
}

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const baseDir = baseIdx >= 0 ? resolve(args[baseIdx + 1]!) : undefined;
const baseline: Baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline) : {};
const head = await loadTree(ROOT, "head");

if (args.includes("--write")) {
  const scenes: Record<string, { work: Work }> = {};
  for (const s of BENCH) scenes[s] = { work: (await head.run(s)).work };
  baseline[head.substrateId] = { adapter: head.adapter, scenes };
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(JSON.stringify(scenes, null, 2));
  console.log(`work-counter baseline written for ${head.substrateId}`);
  head.destroy();
  process.exit(0);
}

let failures = 0;

// Work counters against the stored baseline.
const stored = baseline[head.substrateId];
if (stored === undefined) {
  console.log(`no work-counter baseline for substrate ${head.substrateId} (${head.adapter})`);
  if (args.includes("--require-baseline")) failures++;
} else {
  for (const s of BENCH) {
    const want = stored.scenes[s]?.work;
    const got = (await head.run(s)).work;
    if (want === undefined) {
      console.log(`FAIL ${s}: no baseline entry`);
      failures++;
      continue;
    }
    const over = Object.entries(got).filter(([k, v]) => v > (want[k] ?? 0) * LIMIT);
    for (const [k, v] of over) console.log(`FAIL ${s}: work.${k} = ${v} > ${LIMIT} x ${want[k]}`);
    failures += over.length;
    if (over.length === 0) console.log(`PASS ${s}: work ${JSON.stringify(got)}`);
  }
}

// Wall time, A/B against the base tree on this machine.
if (baseDir === undefined || !existsSync(join(baseDir, "src"))) {
  console.log(`wall-time A/B skipped: no base tree${baseDir ? ` at ${baseDir}` : " (--base DIR)"}`);
} else {
  let base: Tree;
  try {
    base = await loadTree(baseDir, "base");
  } catch (err) {
    console.log(`FAIL wall-time A/B: cannot load the base tree's runtime: ${String(err)}`);
    head.destroy();
    process.exit(1);
  }
  for (const s of BENCH) {
    try {
      await base.run(s);
    } catch (err) {
      // A scene of a newer schema than the base supports has no base to compare with; its work
      // counters are still gated above.
      console.log(`SKIP ${s}: wall-time A/B needs the base tree to run it (${String(err).split("\n")[0]})`);
      continue;
    }
    let m = await abRatio(head, base, s);
    for (let retry = 0; m.ratio > LIMIT && retry < 2; retry++) m = await abRatio(head, base, s);
    const ok = m.ratio <= LIMIT;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${s}: wall median head ${m.head.toFixed(2)} ms vs base ${m.base.toFixed(2)} ms (x${m.ratio.toFixed(3)}, limit x${LIMIT}, ${m.reps} run(s) per sample)`);
  }
  base.destroy();
}

head.destroy();
console.log(`perf: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
