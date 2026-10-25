// Candidate contests (design mechanism ①, docs/P1-01-design.md §3.4). For each candidate set the
// same benchmarks run with every candidate compiled in through its override constant, and each
// candidate is scored on error, variance, ms, robustness (failure rate on randomly perturbed
// inputs) and lines of code. A candidate with a non-zero failure rate is disqualified; the others
// not dominated on all five form the Pareto front. Differences the measurement cannot resolve
// (an error below its statistical floor, variance or ms within their noise) count as ties, so the
// front is not decided by noise. The report lists every candidate with the reason it was kept or
// dropped.
// Run on the reference substrate:  ci/run-in-ref.sh node tools/contest.ts [set ...]
// Writes candidates/p1/<set>/REPORT.md and results.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessRng } from "../src/core/rng.ts";
import { loadSceneText, loadSceneValue, type LoadedScene } from "../src/core/scene.ts";
import type { Json } from "../src/core/json_strict.ts";
import type { Vec3 } from "../src/core/scene_types.ts";
import { type Gpu, openGpu } from "../src/gpu/device.ts";
import { fingerprint, type Substrate } from "../src/gpu/substrate.ts";
import { probeMaterial } from "../src/oracle/probes.ts";
import { materialAlbedo, type RefMaterial } from "../src/oracle/ref_bsdf.ts";
import { replay, sphereLightPlane } from "../src/oracle/replay.ts";
import { nowMs } from "../src/perf/clock.ts";
import { DEFAULT_PLAN } from "../src/runtime/plan.ts";
import { DEFAULT_CANDIDATES, kelemenTableBytes, type RenderCandidates } from "../src/runtime/render.ts";
import { runScene } from "../src/runtime/run.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = join(ROOT, "candidates", "p1");
const table = new Float32Array(kelemenTableBytes().slice().buffer);

interface Score {
  candidate: string;
  value: number;
  error: number;
  variance: number;
  ms: number;
  failure_rate: number;
  loc: number;
  /** Smallest error the benchmark resolves (5 sigma); errors below it are compared as equal. */
  errorFloor: number;
  /** Half-widths below which variance and ms differences are noise. */
  noise: { variance: number; ms: number };
  notes: string[];
}

interface ContestSet {
  id: string;
  title: string;
  override: keyof RenderCandidates;
  candidates: { value: number; name: string; source: string }[];
  measures: { error: string; variance: string; ms: string; robustness: string };
  run: (gpu: Gpu, substrate: Substrate, value: number) => Promise<Score>;
}

// --- Lines of code per candidate (brace matching over the WGSL) --------------------------------

function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Lines a candidate executes in every function that switches on `name`: its own `if (name == v)` block, or the fall-through code when it has none. */
function locOf(files: string[], name: string, value: number): number {
  let total = 0;
  for (const f of files) {
    const lines = readFileSync(join(ROOT, "src", "kernels", f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^fn /.test(lines[i]!)) continue;
      const end = blockEnd(lines, i);
      const body = lines.slice(i, end + 1);
      const ifs = body.map((l, j) => [l, j] as const).filter(([l]) => new RegExp(`if \\(${name} == (\\d+)u\\)`).test(l));
      if (ifs.length === 0) continue;
      // The chain is inside the innermost block that holds the first `if`.
      let open = ifs[0]![1] - 1;
      let depth = 0;
      for (; open > 0; open--) {
        for (const ch of [...body[open]!].reverse()) {
          if (ch === "}") depth++;
          if (ch === "{") depth--;
        }
        if (depth < 0) break;
      }
      const scopeEnd = blockEnd(body, open);
      let own = 0;
      let chain = 0;
      for (const [l, j] of ifs) {
        const n = blockEnd(body, j) - j + 1;
        chain += n;
        if (Number(new RegExp(`${name} == (\\d+)u`).exec(l)![1]) === value) own += n;
      }
      total += own > 0 ? own : scopeEnd - open - 1 - chain;
    }
  }
  return total;
}

// --- Shared measurements ------------------------------------------------------------------------

const REPEATS = 5;

/** Median of REPEATS timed renders after a warm-up, and their spread (max - min) as the noise. */
async function timeRender(gpu: Gpu, substrate: Substrate, loaded: LoadedScene, candidates: RenderCandidates): Promise<{ ms: number; spread: number; out: Awaited<ReturnType<typeof runScene>> }> {
  const out = await runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN, candidates });
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = nowMs();
    await runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN, candidates });
    times.push(nowMs() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: times[REPEATS >> 1]!, spread: times.at(-1)! - times[0]!, out };
}

/** 5 standard errors of a sample variance from n draws (Gaussian approximation, 2 / (n - 1) relative). */
const varianceNoise = (v: number, n: number) => 5 * v * Math.sqrt(2 / (n - 1));

const load = (p: string) => loadSceneText(readFileSync(join(ROOT, p), "utf8"));

/** z of the image against the sphere-light closed form, and the summed per-pixel light-transport variance. */
function sphereLightStats(loaded: LoadedScene, out: Awaited<ReturnType<typeof runScene>>): { z: number; variance: number; samples: number } {
  const rep = replay(loaded.scene, sphereLightPlane);
  const res = out.render!;
  let diff = 0;
  let v = 0;
  let varSum = 0;
  let samples = 0;
  for (let p = 0; p < res.width * res.height; p++) {
    if (rep.fragile[p] || res.ids[p] !== res.objectIds.indexOf("floor")) continue;
    samples += res.spp;
    const mean = res.mean[p * 3]!;
    const pv = Math.max(0, ((res.m2[p * 3]! - mean * mean) * res.spp) / (res.spp - 1) - rep.jitterVar[p * 3]!);
    diff += mean - rep.expected[p * 3]!;
    v += pv / res.spp;
    varSum += pv;
  }
  return { z: Math.abs(diff) / Math.sqrt(v), variance: varSum, samples };
}

function randomSphereLightScene(h: HarnessRng, i: number, strategy: string): LoadedScene {
  const r = 0.05 + h.uniform() * 0.95;
  const lift = i % 3 === 0 ? 0 : h.uniform() * 2; // every third one touches the floor
  const rho = 0.2 + h.uniform() * 0.7;
  return loadSceneValue({
    v: 2, seed: 9000 + i,
    camera: { model: "pinhole", position_m: [0, -5, 3], look_at_m: [0, 0, r], up: [0, 0, 1], vfov_rad: 0.8 },
    environment: { type: "constant", luminance_cdm2: 0, color: [1, 1, 1] },
    render: { width_px: 48, height_px: 36, spp: 64, max_bounces: 1, sampler: "independent", integrator: "pt_p1", strategy, display_white_cdm2: 1 },
    materials: { floor: { base_color: [rho, rho, rho] }, lamp: { base_color: [0, 0, 0], emissive_cdm2: 1 + h.uniform() * 50 } },
    objects: { floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "floor" }, lamp: { shape: "sphere", center_m: [h.uniform() - 0.5, h.uniform() - 0.5, r + lift], radius_m: r, material: "lamp" } },
  } as unknown as Json);
}

async function lightSamplingScore(gpu: Gpu, substrate: Substrate, override: "MIS_HEURISTIC" | "SPHERE_SAMPLER", value: number): Promise<Omit<Score, "candidate" | "value" | "loc">> {
  const candidates = { [override]: value } as RenderCandidates;
  const g26 = load("golden/p1/g26_sphere_light_lambert_plane/scene_mis.json");
  const t26 = await timeRender(gpu, substrate, g26, candidates);
  const s26 = sphereLightStats(g26, t26.out);
  const g27 = load("golden/p1/g27_mis_glossy_consistency/scene_mis.json");
  const t27 = await timeRender(gpu, substrate, g27, candidates);
  const res27 = t27.out.render!;
  let var27 = 0;
  let n27 = 0;
  for (let p = 0; p < res27.width * res27.height; p++) {
    if (res27.ids[p] !== res27.objectIds.indexOf("floor")) continue;
    n27 += res27.spp;
    const mean = res27.mean[p * 3]!;
    var27 += ((res27.m2[p * 3]! - mean * mean) * res27.spp) / (res27.spp - 1);
  }
  const h = new HarnessRng(0xc0, override === "MIS_HEURISTIC" ? 1 : 2);
  let failures = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const sc = randomSphereLightScene(h, i, "mis");
    const out = await runScene(gpu, sc, substrate, { plan: DEFAULT_PLAN, candidates });
    const ok = out.manifest.deterministic.validators.every((v) => v.pass) && sphereLightStats(sc, out).z <= 5;
    if (!ok) failures++;
  }
  return {
    error: s26.z,
    errorFloor: 5,
    variance: s26.variance + var27,
    noise: { variance: varianceNoise(s26.variance, s26.samples) + varianceNoise(var27, n27), ms: t26.spread + t27.spread },
    ms: t26.ms + t27.ms,
    failure_rate: failures / N,
    notes: [`G26 z = ${s26.z.toFixed(2)}`, `G26 variance ${s26.variance.toExponential(3)}, G27 variance ${var27.toExponential(3)}`],
  };
}

function randomMaterial(h: HarnessRng, metallicFixed?: number): { base_color: Vec3; metallic: number; roughness: number; ior: number } {
  return {
    base_color: [0.1 + 0.85 * h.uniform(), 0.1 + 0.85 * h.uniform(), 0.1 + 0.85 * h.uniform()],
    metallic: metallicFixed ?? (h.below(3) === 0 ? 0 : h.uniform()),
    roughness: 0.05 + 0.95 * h.uniform(),
    ior: 1 + 2 * h.uniform(),
  };
}

async function probeScore(gpu: Gpu, material: { base_color: Vec3; metallic: number; roughness: number; ior: number }, candidates: { COUPLING?: number; GGX_SAMPLER?: number }, seed: number) {
  const r = await probeMaterial(gpu, { seed, material, directions: 64, blocks: 32, samplesPerBlock: 256, reciprocityPairs: 4096, histogramSamples: 1 << 16, histogramWo: [0.8660254037844386, 0, 0.5], candidates });
  const ref: RefMaterial = { albedo: material.base_color, metallic: material.metallic, alpha: material.roughness ** 2, ior: material.ior };
  let zMax = 0;
  let errMax = 0;
  let albedoFailures = 0;
  let energy = 0;
  let wVar = 0;
  let invalid = 0;
  r.sampler.forEach((s, i) => {
    const want = materialAlbedo(ref, r.albedo[i]!.mu, candidates.COUPLING ?? 0, table);
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(s.mean[c]! - want[c]!);
      errMax = Math.max(errMax, diff);
      // The G24 A1 rule, |diff| <= max(5 se_robust, 2e-4), as a z: diff / max(se_robust, 4e-5) <= 5.
      zMax = Math.max(zMax, diff / Math.max(s.seRobust[c]!, 4e-5));
      if (!(diff <= Math.max(5 * s.seRobust[c]!, 2e-4))) albedoFailures++;
      energy = Math.max(energy, s.mean[c]! - 5 * s.seRobust[c]!);
      wVar += s.se[c]! * s.se[c]! * 32 * 256;
    }
    invalid += s.invalid;
  });
  return { zMax, errMax, albedoFailures, energy, recip: r.maxReciprocityRel, wVar: wVar / (r.sampler.length * 3), samples: r.sampler.length * 32 * 256, invalid: invalid / r.sampler.length, finite: r.minF >= 0 && r.supportViolations === 0 };
}

// --- The four sets --------------------------------------------------------------------------------

const SETS: ContestSet[] = [
  {
    id: "c_coupling",
    title: "Diffuse/specular coupling of the dielectric (P1D2)",
    override: "COUPLING",
    candidates: [
      { value: 0, name: "Kelemen", source: "Kelemen & Szirmay-Kalos 2001, coupled with the tabulated coat albedo" },
      { value: 1, name: "Ashikhmin-Shirley", source: "Ashikhmin & Shirley 2000, analytic Schlick-based coupling" },
      { value: 2, name: "naive F-weighting", source: "(1 - F(mu_o)) Lambert; negative control, not reciprocal" },
    ],
    measures: {
      error: "continuity at ior -> 1: |mean over 64 directions of the albedo at ior = 1.0001 - rho| (the ior = 1 material is exactly Lambert, albedo rho); floor 5 se of that mean",
      variance: "mean per-sample variance of the sampler weight",
      ms: "render of a rough dielectric sphere (128x128, 64 spp)",
      robustness: "share of 12 random dielectric materials failing energy <= 1 + 5 se, reciprocity <= 1e-4 or support",
    },
    async run(gpu, substrate, value) {
      const c = { COUPLING: value };
      const base: Vec3 = [0.8, 0.6, 0.4];
      const near = await probeScore(gpu, { base_color: base, metallic: 0, roughness: 0.5, ior: 1.0001 }, c, 1);
      // Jump at ior -> 1: sampler albedo against the Lambert albedo rho.
      const nearRaw = await probeMaterial(gpu, { seed: 1, material: { base_color: base, metallic: 0, roughness: 0.5, ior: 1.0001 }, directions: 64, blocks: 32, samplesPerBlock: 256, reciprocityPairs: 64, histogramSamples: 64, histogramWo: [0, 0, 1], candidates: c });
      const nd = nearRaw.sampler.length;
      const jumps = [0, 1, 2].map((k) => Math.abs(nearRaw.sampler.reduce((a, s) => a + s.mean[k]!, 0) / nd - base[k]!));
      const jumpSe = [0, 1, 2].map((k) => Math.sqrt(nearRaw.sampler.reduce((a, s) => a + s.seRobust[k]! ** 2, 0)) / nd);
      const jump = Math.max(...jumps);
      const scores = [near];
      for (const [ior, rough] of [[1.5, 0.3], [1.5, 0.8], [2.5, 0.5]] as const) scores.push(await probeScore(gpu, { base_color: base, metallic: 0, roughness: rough, ior }, c, 2));
      const h = new HarnessRng(0xc1, value);
      let failures = 0;
      for (let i = 0; i < 12; i++) {
        const s = await probeScore(gpu, randomMaterial(h, 0), c, 100 + i);
        if (!(s.energy <= 1) || !(s.recip <= 1e-4) || !s.finite) failures++;
      }
      const sphere = load("golden/p1/g30_roughness_to_zero/scene_a4e3.json");
      const scene = structuredClone(sphere.scene) as any;
      scene.materials.coat = { ...scene.materials.coat, base_color: base, roughness: 0.5 };
      const t = await timeRender(gpu, substrate, loadSceneValue(scene as Json), c);
      const recip = Math.max(...scores.map((s) => s.recip));
      const variance = scores.reduce((a, s) => a + s.wVar, 0) / scores.length;
      return {
        candidate: "", value, loc: 0,
        error: jump,
        errorFloor: 5 * Math.max(...jumpSe),
        variance,
        noise: { variance: varianceNoise(variance, scores.reduce((a, s) => a + s.samples, 0)), ms: t.spread },
        ms: t.ms,
        failure_rate: failures / 12,
        notes: [`max reciprocity error ${recip.toExponential(2)}`, `albedo jump at ior 1.0001: ${jumps.map((j) => j.toExponential(2)).join(" / ")} (se ${jumpSe.map((j) => j.toExponential(1)).join(" / ")})`, `max energy (E[w] - 5 se) ${Math.max(...scores.map((s) => s.energy)).toFixed(4)}`],
      };
    },
  },
  {
    id: "c_ggx_sampler",
    title: "GGX microfacet sampling (P1D8)",
    override: "GGX_SAMPLER",
    candidates: [
      { value: 0, name: "VNDF (Heitz 2018)", source: "Heitz, Sampling the GGX Distribution of Visible Normals, JCGT 7(4), 2018" },
      { value: 1, name: "spherical caps", source: "Dupuy & Benyoub, Sampling Visible GGX Normals with Spherical Caps, CGF 2023" },
      { value: 2, name: "D(m) cos", source: "Walter et al. 2007, full NDF sampling" },
    ],
    measures: {
      error: "largest z = |E[w] - E_ref| / max(se_robust, 4e-5) of the sampler's albedo against the f64 reference, 64 directions x 3 channels x 3 metals (the G24 A1 rule); floor 5",
      variance: "mean per-sample variance of the sampler weight (metals, roughness 0.1 / 0.3 / 0.7)",
      ms: "render of G23 r03 (GGX metal furnace)",
      robustness: "share of 12 random materials failing energy <= 1 + 5 se, albedo z <= 5, reciprocity or support",
    },
    async run(gpu, substrate, value) {
      const c = { GGX_SAMPLER: value };
      const scores = [];
      for (const rough of [0.1, 0.3, 0.7]) scores.push(await probeScore(gpu, { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: rough, ior: 1 }, c, 3));
      const h = new HarnessRng(0xc2, value);
      let failures = 0;
      for (let i = 0; i < 12; i++) {
        const s = await probeScore(gpu, randomMaterial(h), c, 200 + i);
        if (!(s.energy <= 1) || s.albedoFailures > 0 || !(s.recip <= 1e-4) || !s.finite) failures++;
      }
      const t = await timeRender(gpu, substrate, load("golden/p1/g23_ggx_conductor_furnace/scene_r03.json"), c);
      const variance = scores.reduce((a, s) => a + s.wVar, 0) / scores.length;
      return {
        candidate: "", value, loc: 0,
        error: Math.max(...scores.map((s) => s.zMax)),
        errorFloor: 5,
        variance,
        noise: { variance: varianceNoise(variance, scores.reduce((a, s) => a + s.samples, 0)), ms: t.spread },
        ms: t.ms,
        failure_rate: failures / 12,
        notes: [`invalid (below-horizon) sample share at roughness 0.1 / 0.3 / 0.7: ${scores.map((s) => s.invalid.toFixed(4)).join(" / ")}`, `albedo checks failing the G24 rule: ${scores.reduce((a, s) => a + s.albedoFailures, 0)}`],
      };
    },
  },
  {
    id: "c_mis",
    title: "MIS weighting heuristic (P1D7)",
    override: "MIS_HEURISTIC",
    candidates: [
      { value: 0, name: "power (beta = 2)", source: "Veach 1997 §9.2.4" },
      { value: 1, name: "balance", source: "Veach 1997 §9.2.2, Theorem 9.2" },
    ],
    measures: { error: "|z| of G26 against the view-factor closed form; floor 5", variance: "summed per-pixel variance on G26 + G27 floors", ms: "render of G26 + G27 (mis)", robustness: "share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5" },
    run: async (gpu, substrate, value) => ({ candidate: "", value, loc: 0, ...(await lightSamplingScore(gpu, substrate, "MIS_HEURISTIC", value)) }),
  },
  {
    id: "c_sphere_light",
    title: "Sphere light sampling (P1D9)",
    override: "SPHERE_SAMPLER",
    candidates: [
      { value: 0, name: "uniform cone", source: "PBRT-v4 ch. 6, sampling the cone subtended by a sphere" },
      { value: 1, name: "uniform area", source: "uniform point on the whole sphere, back side rejected" },
    ],
    measures: { error: "|z| of G26 against the view-factor closed form; floor 5", variance: "summed per-pixel variance on G26 + G27 floors", ms: "render of G26 + G27 (mis)", robustness: "share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5" },
    run: async (gpu, substrate, value) => ({ candidate: "", value, loc: 0, ...(await lightSamplingScore(gpu, substrate, "SPHERE_SAMPLER", value)) }),
  },
];

/**
 * Per measure, b against a: -1 better, 0 tie, 1 worse. Errors are compared after raising each to its
 * floor; variance and ms differences within the summed noise are ties; robustness and LOC are exact.
 */
function compare(b: Score, a: Score, key: "error" | "variance" | "ms" | "failure_rate" | "loc"): number {
  if (key === "error") return Math.sign(Math.max(b.error, b.errorFloor) - Math.max(a.error, a.errorFloor));
  if (key === "variance" || key === "ms") {
    const d = b[key] - a[key];
    return Math.abs(d) <= b.noise[key] + a.noise[key] || !Number.isFinite(d) && b[key] === a[key] ? 0 : Math.sign(d);
  }
  return Math.sign(b[key] - a[key]);
}

const KEYS = ["error", "variance", "ms", "failure_rate", "loc"] as const;
const dominates = (b: Score, a: Score) => KEYS.every((k) => compare(b, a, k) <= 0) && KEYS.some((k) => compare(b, a, k) < 0);

/**
 * A candidate that breaks an invariant on any perturbed input (non-zero failure rate: reciprocity,
 * energy, non-finite output) is disqualified; the Pareto front is taken over the rest.
 */
function pareto(scores: Score[]): Set<number> {
  const valid = scores.map((s) => s.failure_rate === 0);
  const front = new Set<number>();
  scores.forEach((a, i) => {
    if (valid[i] && !scores.some((b, j) => j !== i && valid[j] && dominates(b, a))) front.add(i);
  });
  return front;
}

const fmt = (x: number) => (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e4 ? x.toFixed(4) : x.toExponential(2));

const only = process.argv.slice(2);
const gpu = await openGpu();
const substrate = await fingerprint(gpu);
for (const set of SETS.filter((s) => only.length === 0 || only.includes(s.id))) {
  const files = ["bsdf_p1.wgsl", "render_p1.wgsl"];
  const scores: Score[] = [];
  for (const c of set.candidates) {
    const s = await set.run(gpu, substrate, c.value);
    for (const k of ["error", "variance", "ms"] as const) {
      if (!Number.isFinite(s[k])) {
        s.notes.push(`${k} is not finite (non-finite pixels or estimates): scored as infinity`);
        s[k] = Infinity;
        if (k !== "error") s.noise[k] = Infinity;
      }
    }
    scores.push({ ...s, candidate: c.name, value: c.value, loc: locOf(files, set.override, c.value) });
    console.log(`${set.id} ${c.name}: error ${fmt(s.error)} variance ${fmt(s.variance)} ms ${s.ms.toFixed(1)} failures ${s.failure_rate.toFixed(3)}`);
  }
  const front = pareto(scores);
  const dir = join(OUT, set.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), `${JSON.stringify({ set: set.id, substrate: substrate.adapter.description, measures: set.measures, scores, pareto: [...front].map((i) => scores[i]!.candidate) }, null, 2)}\n`);
  const lines = [
    `# ${set.title}`,
    "",
    `Override \`${set.override}\`, runtime default ${set.candidates.find((c) => c.value === DEFAULT_CANDIDATES[set.override])!.name}. Measured on ${substrate.adapter.description} by \`tools/contest.ts\`; numbers are reproducible (seeded inputs) except ms, the median of ${REPEATS} renders with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.`,
    "",
    "| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |",
    "|---|---|---|---|---|---|---|---|",
    ...scores.map((s, i) => `| ${s.candidate} | ${fmt(s.error)} (${fmt(s.errorFloor)}) | ${fmt(s.variance)} (± ${fmt(s.noise.variance)}) | ${s.ms.toFixed(1)} (± ${s.noise.ms.toFixed(1)}) | ${s.failure_rate.toFixed(3)} | ${s.loc} | ${front.has(i) ? "yes" : "no"} | ${set.candidates[i]!.source} |`),
    "",
    "Measures:",
    `- Error: ${set.measures.error}`,
    `- Variance: ${set.measures.variance}`,
    `- ms: ${set.measures.ms}`,
    `- Robustness: ${set.measures.robustness}`,
    "",
    "Notes:",
    ...scores.map((s) => `- ${s.candidate}: ${s.notes.join("; ")}`),
    "",
    "Dropped (not on the Pareto front):",
    ...scores.filter((_, i) => !front.has(i)).map((s) => {
      if (s.failure_rate > 0) return `- ${s.candidate}: disqualified, breaks an invariant on ${(s.failure_rate * 100).toFixed(1)}% of perturbed inputs (${s.notes.join("; ")})`;
      const better = scores.find((b, j) => front.has(j) && dominates(b, s))!;
      return `- ${s.candidate}: dominated by ${better.candidate} (better on ${KEYS.filter((k) => compare(better, s, k) < 0).join(", ")}, no worse elsewhere)`;
    }),
    ...(scores.every((_, i) => front.has(i)) ? ["- none"] : []),
    "",
  ];
  writeFileSync(join(dir, "REPORT.md"), `${lines.join("\n")}\n`);
}
gpu.destroy();
