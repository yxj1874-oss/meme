// P1 candidate contests (design mechanism ①, docs/P1-01-design.md §3.4): the rendering sets.
// Scoring, the Pareto front and the reports are in tools/contest_lib.ts.
// Run on the reference substrate:  ci/run-in-ref.sh node tools/contest.ts [set ...]
// Writes candidates/p1/<set>/REPORT.md and results.json.

import { readFileSync } from "node:fs";
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
import { DEFAULT_PLAN } from "../src/runtime/plan.ts";
import { DEFAULT_CANDIDATES, kelemenTableBytes, type RenderCandidates } from "../src/runtime/render.ts";
import { runScene } from "../src/runtime/run.ts";
import { type ContestSet, ROOT, runContests, type Score, timeIt, varianceNoise } from "./contest_lib.ts";

const table = new Float32Array(kelemenTableBytes().slice().buffer);
const RENDER_KERNELS = ["bsdf_p1.wgsl", "render_p1.wgsl"];

/** Median of REPEATS timed renders after a warm-up, and their spread. */
const timeRender = (gpu: Gpu, substrate: Substrate, loaded: LoadedScene, candidates: RenderCandidates) =>
  timeIt(() => runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN, candidates }));

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
    files: RENDER_KERNELS,
    defaultValue: DEFAULT_CANDIDATES.COUPLING,
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
    files: RENDER_KERNELS,
    defaultValue: DEFAULT_CANDIDATES.GGX_SAMPLER,
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
    files: RENDER_KERNELS,
    defaultValue: DEFAULT_CANDIDATES.MIS_HEURISTIC,
    candidates: [
      { value: 0, name: "power (beta = 2)", source: "Veach 1997 §9.2.4" },
      { value: 1, name: "balance", source: "Veach 1997 §9.2.2, Theorem 9.2" },
    ],
    measures: { error: "|z| of G26 against the view-factor closed form; floor 5", variance: "summed per-pixel variance on G26 + G27 floors", ms: "render of G26 + G27 (mis)", robustness: "share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5" },
    run: (gpu, substrate, value) => lightSamplingScore(gpu, substrate, "MIS_HEURISTIC", value),
  },
  {
    id: "c_sphere_light",
    title: "Sphere light sampling (P1D9)",
    override: "SPHERE_SAMPLER",
    files: RENDER_KERNELS,
    defaultValue: DEFAULT_CANDIDATES.SPHERE_SAMPLER,
    candidates: [
      { value: 0, name: "uniform cone", source: "PBRT-v4 ch. 6, sampling the cone subtended by a sphere" },
      { value: 1, name: "uniform area", source: "uniform point on the whole sphere, back side rejected" },
    ],
    measures: { error: "|z| of G26 against the view-factor closed form; floor 5", variance: "summed per-pixel variance on G26 + G27 floors", ms: "render of G26 + G27 (mis)", robustness: "share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5" },
    run: (gpu, substrate, value) => lightSamplingScore(gpu, substrate, "SPHERE_SAMPLER", value),
  },
];

const gpu = await openGpu();
const substrate = await fingerprint(gpu);
await runContests(SETS, join(ROOT, "candidates", "p1"), gpu, substrate, "tools/contest.ts");
gpu.destroy();
