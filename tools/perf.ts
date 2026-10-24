// MT3 performance gate (design §② MT3). Per benchmark scene and per substrate:
//  - deterministic work counters (rays, ray-primitive tests, physics steps, gpu_bytes_peak, which is
//    the D12-A "VRAM" metric) may not exceed 1.10x the baseline; they are exact, so no noise margin;
//  - wall time: median of 5 runs after a warm-up may not exceed 1.10x the baseline median. A miss is
//    re-measured twice before it counts, because shared CI runners are noisy.
// Usage: node tools/perf.ts --check [--require-baseline] | --write

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSceneText } from "../src/core/scene.ts";
import { openGpu } from "../src/gpu/device.ts";
import { fingerprint, substrateId } from "../src/gpu/substrate.ts";
import { nowMs } from "../src/perf/clock.ts";
import { DEFAULT_PLAN } from "../src/runtime/plan.ts";
import { runScene } from "../src/runtime/run.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const BASELINE = join(ROOT, "ci", "perf-baseline.json");
const BENCH = ["golden/p0/g01_det_double_run/scene.json", "golden/p0/g16_physics_extremes/scene_far.json"];
const RUNS = 5;
const LIMIT = 1.1;

interface Measure {
  work: Record<string, number>;
  wall_ms_median: number;
}
type Baseline = Record<string, { adapter: string; scenes: Record<string, Measure> }>;

const gpu = await openGpu();
const substrate = await fingerprint(gpu);
const sid = substrateId(substrate);

async function measure(path: string): Promise<Measure> {
  const loaded = loadSceneText(readFileSync(join(ROOT, path), "utf8"));
  const first = await runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN }); // warm-up: pipeline compilation
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = nowMs();
    await runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN });
    times.push(nowMs() - t0);
  }
  times.sort((a, b) => a - b);
  return { work: { ...first.manifest.deterministic.work }, wall_ms_median: times[Math.floor(RUNS / 2)]! };
}

const baseline: Baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline) : {};

if (process.argv.includes("--write")) {
  const scenes: Record<string, Measure> = {};
  for (const b of BENCH) scenes[b] = await measure(b);
  baseline[sid] = { adapter: substrate.adapter.description, scenes };
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(JSON.stringify(scenes, null, 2));
  console.log(`perf baseline written for ${sid}`);
  gpu.destroy();
  process.exit(0);
}

const base = baseline[sid];
if (base === undefined) {
  console.log(`no perf baseline for substrate ${sid} (${substrate.adapter.description})`);
  gpu.destroy();
  process.exit(process.argv.includes("--require-baseline") ? 1 : 0);
}

let failures = 0;
for (const b of BENCH) {
  const want = base.scenes[b];
  if (want === undefined) {
    console.log(`FAIL ${b}: no baseline entry`);
    failures++;
    continue;
  }
  let got = await measure(b);
  for (const [k, v] of Object.entries(got.work)) {
    const limit = (want.work[k] ?? 0) * LIMIT;
    if (v > limit) {
      console.log(`FAIL ${b}: work.${k} = ${v} > ${LIMIT} x ${want.work[k]}`);
      failures++;
    }
  }
  for (let retry = 0; got.wall_ms_median > want.wall_ms_median * LIMIT && retry < 2; retry++) got = await measure(b);
  const ratio = got.wall_ms_median / want.wall_ms_median;
  const ok = ratio <= LIMIT;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${b}: wall median ${got.wall_ms_median.toFixed(1)} ms vs ${want.wall_ms_median.toFixed(1)} ms (x${ratio.toFixed(3)}), work ${JSON.stringify(got.work)}`);
}
gpu.destroy();
console.log(`perf: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
