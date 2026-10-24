// Generates golden/p0/*: scene files, raw-text variants and oracle.json for the 20 P0 goldens
// (golden/p0/MANIFEST.md). The committed files are this script's output; CI regenerates them and
// requires an empty diff, so a golden cannot drift from its definition.
// Usage: node tools/gen_golden.ts [--check]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessRng, STREAM } from "../src/core/rng.ts";

const ROOT = new URL("../golden/p0/", import.meta.url).pathname;
const check = process.argv.includes("--check");

type J = unknown;
type Vec3 = [number, number, number];
interface Golden {
  id: string;
  title: string;
  covers: string[];
  kills: string[];
  files: Record<string, string>;
  runs: J[];
  asserts: J[];
}

const tol = (value: number | null, derivation: string, source: string) => ({ value, derivation, source });
const U = "u = 2^-23 (WGSL rounding direction unspecified, §15.7.4: faithful rounding)";

// ---------------------------------------------------------------------------------------------
// Scene builders (field names as in scene.schema.json)

const cam = (position: Vec3, lookAt: Vec3, vfov = 0.6, up: Vec3 = [0, 0, 1]) => ({ model: "pinhole", position_m: position, look_at_m: lookAt, up, vfov_rad: vfov });
const render = (w: number, h: number, spp: number, bounces: number, white = 1) => ({ width_px: w, height_px: h, spp, max_bounces: bounces, sampler: "independent", integrator: "pt_bsdf_p0", display_white_cdm2: white });
const envConst = (L: number, color: Vec3 = [1, 1, 1]) => ({ type: "constant", luminance_cdm2: L, color });
const envSplit = (up: Vec3, upper: number, lower: number, color: Vec3 = [1, 1, 1]) => ({ type: "split", up, upper_cdm2: upper, lower_cdm2: lower, color });
const physics = (dt: number, steps: number, every: number, g: Vec3 = [0, 0, -9.81]) => ({ integrator: "xpbd_unconstrained_p0", gravity_m_s2: g, dt_s: dt, steps, record_every_steps: every });
const mat = (base: Vec3, emissive = 0, color: Vec3 = [1, 1, 1]) => (emissive > 0 ? { base_color: base, emissive_cdm2: emissive, emissive_color: color } : { base_color: base });
const sphere = (center: Vec3, r: number, material: string, body?: { mass_kg: number; velocity_m_s: Vec3 }) => ({ shape: "sphere", center_m: center, radius_m: r, material, ...(body ? { body } : {}) });
const plane = (point: Vec3, normal: Vec3, material: string) => ({ shape: "plane", point_m: point, normal, material });
const scene = (seed: number, parts: Record<string, J>) => ({ v: 1, seed, ...parts });

const json = (v: J) => `${JSON.stringify(v, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// G01 base scene, reused by G02, G03, G15, G19

const G01_SCENE = scene(101, {
  camera: cam([0, -6, 2.5], [0, 0, 0.8], 0.8),
  environment: envConst(0.5),
  render: render(128, 96, 64, 4, 2),
  physics: physics(2 ** -8, 256, 32),
  materials: {
    floor: mat([0.6, 0.6, 0.6]),
    red: mat([0.8, 0.2, 0.2]),
    green: mat([0.2, 0.8, 0.3]),
    blue: mat([0.2, 0.3, 0.9]),
    grey: mat([0.5, 0.5, 0.5]),
    white: mat([0.9, 0.9, 0.9]),
    lamp: mat([0.1, 0.1, 0.1], 20, [1, 0.9, 0.7]),
  },
  objects: {
    floor: plane([0, 0, 0], [0, 0, 1], "floor"),
    ball_a: sphere([-1.5, 0, 0.6], 0.6, "red", { mass_kg: 1, velocity_m_s: [0.5, 0, 2] }),
    ball_b: sphere([0, 0.5, 0.8], 0.8, "green"),
    ball_c: sphere([1.6, -0.2, 0.5], 0.5, "blue", { mass_kg: 2, velocity_m_s: [-0.3, 0.1, 1] }),
    ball_d: sphere([0.6, -1.4, 0.3], 0.3, "white"),
    ball_e: sphere([-0.4, -1.2, 0.25], 0.25, "grey", { mass_kg: 0.5, velocity_m_s: [0, 0, 3] }),
    lamp: sphere([0.5, 1.5, 2.6], 0.4, "lamp"),
  },
});

const out: Golden[] = [];

out.push({
  id: "g01_det_double_run",
  title: "Two fresh processes and an in-process rerun produce identical bytes",
  covers: ["determinism"],
  kills: ["implicit-random", "pool-no-clear", "completion-order", "clock-in-deterministic"],
  files: { "scene.json": json(G01_SCENE) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1-A3", kind: "fresh_process_determinism", scene: "scene.json", tol: tol(0, "bit-exact", "determinism contract") },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

// ---------------------------------------------------------------------------------------------
// G02: canonical order. Raw text with shuffled key order and respelled numbers.

function respell(n: number, h: HarnessRng): string {
  const forms = new Set<string>([String(n), n.toExponential(), n.toPrecision(17)]);
  if (Number.isInteger(n)) forms.add(`${n}.0`).add(`${n}e0`);
  const list = [...forms].filter((f) => Number(f) === n).sort();
  return list[h.below(list.length)]!;
}

function shuffledText(v: J, h: HarnessRng, indent = ""): string {
  if (typeof v === "number") return respell(v, h);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const inner = `${indent}    `;
  if (Array.isArray(v)) return `[ ${v.map((x) => shuffledText(x, h, inner)).join(" ,  ")} ]`;
  const keys = h.shuffle(Object.keys(v).sort());
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)} :\t${shuffledText((v as Record<string, J>)[k], h, inner)}`).join(",\n")}\n${indent}}`;
}

function manyBodies(n: number): J {
  const h = new HarnessRng(202, 1);
  const objects: Record<string, J> = {};
  for (let i = 0; i < n; i++) {
    const c: Vec3 = [Math.round((h.uniform() * 40 - 20) * 1e6) / 1e6, Math.round((h.uniform() * 40 - 20) * 1e6) / 1e6, Math.round(h.uniform() * 30 * 1e6) / 1e6];
    const v: Vec3 = [Math.round((h.uniform() * 10 - 5) * 1e4) / 1e4, Math.round((h.uniform() * 10 - 5) * 1e4) / 1e4, Math.round(h.uniform() * 10 * 1e4) / 1e4];
    objects[`b${String(i).padStart(4, "0")}`] = sphere(c, 0.1, "m", { mass_kg: Math.round((0.1 + h.uniform() * 9.9) * 1e3) / 1e3, velocity_m_s: v });
  }
  return scene(202, { physics: physics(2 ** -7, 200, 25), materials: { m: mat([0.5, 0.5, 0.5]) }, objects });
}

const G02B = manyBodies(1024);
out.push({
  id: "g02_det_canonical_order",
  title: "Key order, number spelling and whitespace do not change any output byte",
  covers: ["determinism"],
  kills: ["insertion-order-iteration", "jcs-number-format"],
  files: {
    "scene_a.json": json(G01_SCENE),
    "scene_a_shuffled.json": `${shuffledText(G01_SCENE, new HarnessRng(202, 2))}\n`,
    "scene_b.json": json(G02B),
    "scene_b_shuffled.json": `${shuffledText(G02B, new HarnessRng(202, 3))}\n`,
  },
  runs: [
    { name: "a", scene: "scene_a.json" },
    { name: "a_shuffled", scene: "scene_a_shuffled.json" },
    { name: "b", scene: "scene_b.json" },
    { name: "b_shuffled", scene: "scene_b_shuffled.json" },
  ],
  asserts: [
    { id: "A1a", kind: "scene_hash_equal", runs: ["a", "a_shuffled"] },
    { id: "A2a", kind: "outputs_equal", runs: ["a", "a_shuffled"] },
    { id: "A1b", kind: "scene_hash_equal", runs: ["b", "b_shuffled"] },
    { id: "A2b", kind: "outputs_equal", runs: ["b", "b_shuffled"] },
  ],
});

// ---------------------------------------------------------------------------------------------
// G03: plan invariance

const tilesG01 = Math.ceil(128 / 16) * Math.ceil(96 / 16);
const permutation = new HarnessRng(303, 0, STREAM.HARNESS_SCHEDULE).shuffle(Array.from({ length: tilesG01 }, (_, i) => i));
out.push({
  id: "g03_det_plan_invariance",
  title: "Pass split, tile size, tile order and dispatch batching do not change any output byte",
  covers: ["determinism"],
  kills: ["pass-local-sum", "cross-tile-race", "dispatch-dependent-state"],
  files: { "scene.json": json(G01_SCENE) },
  runs: [
    { name: "p1", scene: "scene.json", plan: { pass_spp: 64, tile_px: 128, submit_batches: 1, physics_steps_per_dispatch: 256 } },
    { name: "p2", scene: "scene.json", plan: { pass_spp: 16, tile_px: 16, submit_batches: 1, physics_steps_per_dispatch: 32 } },
    { name: "p3", scene: "scene.json", plan: { pass_spp: 1, tile_px: 8, submit_batches: 1, physics_steps_per_dispatch: 1 } },
    { name: "p4", scene: "scene.json", plan: { pass_spp: 16, tile_px: 16, tile_order: permutation, submit_batches: 1, physics_steps_per_dispatch: 7 } },
    { name: "p5", scene: "scene.json", plan: { pass_spp: 64, tile_px: 16, submit_batches: 7, physics_steps_per_dispatch: 5 } },
  ],
  asserts: [{ id: "A1", kind: "outputs_equal", runs: ["p1", "p2", "p3", "p4", "p5"] }],
});

// ---------------------------------------------------------------------------------------------
// G04, G05: RNG

out.push({
  id: "g04_rng_kat_crosscheck",
  title: "Philox4x32-10 equals Random123 known answers; WGSL equals TypeScript bit for bit",
  covers: ["rng"],
  kills: ["philox-rounds", "philox-constant", "unit-float-shift", "mulhi-limbs"],
  files: {},
  runs: [],
  asserts: [
    { id: "A1", kind: "rng_kat", source: "Random123 tests/kat_vectors, philox4x32 rows" },
    { id: "A2-A4", kind: "rng_gpu_cpu", seeds: [0, 1, 0x9e3779b9, 0xffffffff], streams: [0, 3, 4, 5], sequential: 524288, random: 524288, tol: tol(0, "bit-exact", "WGSL §6.2.3: integer ops wrap modulo 2^32 exactly; u>>8 < 2^24 converts exactly") },
  ],
});

out.push({
  id: "g05_rng_stream_quality",
  title: "Uniformity, stream independence and avalanche of the RNG",
  covers: ["rng"],
  kills: ["seed-not-in-key", "dim-block-reuse"],
  files: {},
  runs: [],
  asserts: [
    { id: "A1-A5", kind: "rng_quality", seed: 505, n: 1 << 20, p_range: [1e-4, 1 - 1e-4], corr_k: 4, avalanche_k: 5, avalanche_counters: 1 << 16, tol: tol(null, "chi-square p in [1e-4, 1-1e-4]; |r| <= 4/sqrt(n); bit-flip share within 5 sigma of Binomial(N, 1/2) (Bonferroni over 32 or 128 tests)", "null distributions; Bonferroni") },
  ],
});

// ---------------------------------------------------------------------------------------------
// G06-G12: energy and rendering closed forms

out.push({
  id: "g06_empty_black",
  title: "No light, no objects: every pixel is exactly zero",
  covers: ["energy"],
  kills: ["accum-not-cleared", "emission-leak", "aov-uninitialized"],
  files: { "scene.json": json(scene(606, { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(0), render: render(64, 64, 4, 1), materials: {}, objects: {} })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "image_const", run: "a", mask: { all: true }, expect: 0, target: "mean", tol: tol(0, "exact: every sample is 0", "construction") },
    { id: "A2", kind: "image_const", run: "a", mask: { all: true }, expect: 0, target: "m2", tol: tol(0, "exact", "construction") },
    { id: "A3", kind: "png_all", run: "a", rgb: [0, 0, 0] },
    { id: "A4", kind: "ids_all", run: "a", value: "NONE" },
  ],
});

out.push({
  id: "g07_env_constant_exact",
  title: "Constant environment, no objects, spp = 48: every pixel is exactly 1.0",
  covers: ["energy", "analytic.render"],
  kills: ["luminance-normalization", "dropped-sample", "gpu-division"],
  files: {
    "scene.json": json(scene(707, { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(1), render: render(64, 64, 48, 1), materials: {}, objects: {} })),
    "scene_red.json": json(scene(708, { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(1, [1, 0, 0]), render: render(64, 64, 16, 1), materials: {}, objects: {} })),
  },
  runs: [{ name: "a", scene: "scene.json" }, { name: "red", scene: "scene_red.json" }],
  asserts: [
    { id: "A1", kind: "image_const", run: "a", mask: { all: true }, expect: 1, target: "mean", tol: tol(0, "exact: samples are 1.0, a sum of 48 ones is exact in f32, mean f32(48/48) on the CPU", "WGSL §15.7.4 (correct rounding of a representable result is exact)") },
    { id: "A2", kind: "image_const", run: "a", mask: { all: true }, expect: 1, target: "m2", tol: tol(0, "exact", "as A1") },
    { id: "A3", kind: "image_luminance", run: "red", mask: { all: true }, expect: 1, rgb: [1 / 0.2126, 0, 0], tol: tol((16 + 2) * 2 ** -23, "(spp + 2) * u relative: one f32 rounding of L/Y(color), spp-1 additions, one luminance dot product", `photometric contract D6-A: radiance = L * color / Y(color), Y = BT.709 luma; ${U}`) },
  ],
});

const tauConvex = (16 - 1 + 5 * 1) * 2 ** -23;
const furnaceScene = (rho: number) => scene(808, { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(1), render: render(128, 128, 16, 1), materials: { m: mat([rho, rho, rho]) }, objects: { ball: sphere([0, 0, 0], 1, "m") } });
out.push({
  id: "g08_furnace_convex",
  title: "White furnace, one convex sphere, max_bounces = 1 (any self-intersection zeroes a sample)",
  covers: ["energy.furnace"],
  kills: ["no-ray-offset", "albedo-weight", "cosine-pdf"],
  files: { "scene.json": json(furnaceScene(1)), "scene_half.json": json(furnaceScene(0.5)) },
  runs: [{ name: "a", scene: "scene.json" }, { name: "half", scene: "scene_half.json" }],
  asserts: [
    { id: "A1", kind: "image_const", run: "a", mask: { ids_in: ["ball"], erode_px: 1 }, expect: 1, target: "mean", tol: tol(tauConvex, "(spp-1 + 5*D) * u, spp = 16, D = 1", `Higham 2002 §4.2 recursive summation; ${U}`) },
    { id: "A2", kind: "image_const", run: "a", mask: { ids_none: true, erode_px: 1 }, expect: 1, target: "mean", tol: tol(0, "exact: escaping rays return 1.0", "as G07") },
    { id: "A1b", kind: "image_const", run: "half", mask: { ids_in: ["ball"], erode_px: 1 }, expect: 0.5, target: "mean", tol: tol(0.5 * tauConvex, "0.5 * tau", "as A1") },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

const enclosure = (D: number) => scene(909, { camera: cam([0, 0, 0], [0, 1, 0], 1.0), environment: envConst(0), render: render(64, 64, 16, D), materials: { wall: mat([0.75, 0.75, 0.75], 1) }, objects: { shell: sphere([0, 0, 0], 1, "wall") } });
out.push({
  id: "g09_furnace_enclosure_series",
  title: "Camera inside an emitting Lambert sphere: L_D = Le (1 - rho^(D+1)) / (1 - rho), zero variance",
  covers: ["energy.furnace", "analytic.render"],
  kills: ["first-hit-emission", "bounce-off-by-one", "inside-root", "double-emission"],
  files: { "scene_d0.json": json(enclosure(0)), "scene_d1.json": json(enclosure(1)), "scene_d8.json": json(enclosure(8)) },
  runs: [{ name: "d0", scene: "scene_d0.json" }, { name: "d1", scene: "scene_d1.json" }, { name: "d8", scene: "scene_d8.json" }],
  asserts: [0, 1, 8].flatMap((D) => [
    { id: `A1.D${D}`, kind: "image_const", run: `d${D}`, mask: { all: true }, expect: { fn: "enclosure_series", args: { le: 1, rho: 0.75, max_bounces: D } }, target: "mean", relative: true, tol: tol((16 - 1 + 5 * (D + 1)) * 2 ** -23, `(spp-1 + 5*(D+1)) * u, spp = 16, D = ${D}`, `geometric series; Higham 2002 §4.2; ${U}`) },
    { id: `V.D${D}`, kind: "validators_pass", run: `d${D}` },
  ]),
});

const theta = Math.PI / 3;
const nTilt: Vec3 = [Math.sin(theta), 0, Math.cos(theta)];
const tilted = (w: number, spp: number, seed: number) =>
  scene(seed, {
    camera: cam([3 * nTilt[0], 0, 3 * nTilt[2]], [0, 0, 0], 0.6),
    environment: envSplit([0, 0, 1], 1, 0),
    render: render(w, w, spp, 1),
    materials: { m: mat([0.5, 0.5, 0.5]) },
    objects: { slab: plane([0, 0, 0], nTilt, "m") },
  });
const skyArgs = { rho: 0.5, cos_theta: Math.cos(theta) };
out.push({
  id: "g10_tilted_plane_split_sky",
  title: "Tilted Lambert plane under a split sky: mean = rho (1 + cos theta) / 2",
  covers: ["analytic.render"],
  kills: ["uniform-sampling-cosine-weight", "dimension-correlation", "split-env-inverted"],
  files: { "scene.json": json(tilted(64, 64, 1010)) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "image_mean_ksigma", run: "a", mask: { ids_in: ["slab"] }, expect: { fn: "split_sky_tilted_plane", args: skyArgs }, sigma: { fn: "split_sky_sigma", args: skyArgs }, k: 4, tol: tol(null, "|mean - mu| <= 4 sigma_X / sqrt(P N)", "isotropic sky view factor (1+cos b)/2, Duffie & Beckman; CLT") },
    { id: "A2", kind: "variance_ratio", run: "a", mask: { ids_in: ["slab"] }, sigma: { fn: "split_sky_sigma", args: skyArgs }, tol: tol(0.01, "relative sd of pooled s^2 = sqrt((kappa-1)/(P N)) = 2.26e-3, kappa = 2.33 (Bernoulli); 0.01 ~ 4.4 sd", "sampling distribution of the variance") },
    { id: "A3", kind: "channels_equal", run: "a" },
  ],
});

const sppSeries = [1, 4, 16, 64, 256, 1024];
out.push({
  id: "g11_mc_convergence_slope",
  title: "RMSE falls as N^-1/2 with the right constant (independent sampler)",
  covers: ["convergence"],
  kills: ["sample-index-not-in-counter", "pixel-correlation"],
  files: Object.fromEntries(sppSeries.map((n) => [`scene_n${n}.json`, json(tilted(32, n, 1111))])),
  runs: sppSeries.map((n) => ({ name: `n${n}`, scene: `scene_n${n}.json` })),
  asserts: [
    { id: "A1-A2", kind: "convergence", runs: sppSeries.map((n) => `n${n}`), spp: sppSeries, mask: { ids_in: ["slab"] }, expect: { fn: "split_sky_tilted_plane", args: skyArgs }, sigma: { fn: "split_sky_sigma", args: skyArgs }, slope: [-0.55, -0.45], calibration: [0.9, 1.1], calibration_min_spp: 4, tol: tol(0.05, "slope sd = 0.022 / sqrt(sum (x_i - xbar)^2) = 3.8e-3 (13 sd); RMSE relative sd <= 2.2% with P = 1024 (calibration 10% ~ 4.5 sd)", "OLS slope variance") },
  ],
});

out.push({
  id: "g12_bsdf_probe_lambert",
  title: "Lambert BSDF: albedo, energy <= 1, pdf normalization, sampler consistency, reciprocity, support, chi-square",
  covers: ["energy.bsdf", "reciprocity"],
  kills: ["pdf-missing-pi", "abs-cos-misplaced", "hemisphere-flip"],
  files: {},
  runs: [],
  asserts: [[0.8, 0.5, 0.2], [1, 1, 1]].map((albedo, i) => ({
    id: `A1-A7.${i}`,
    kind: "bsdf_probe",
    seed: 1212 + i,
    albedo,
    directions: 256,
    blocks: 256,
    samples_per_block: 256,
    reciprocity_pairs: 4096,
    histogram_samples: 1 << 20,
    k: 5,
    tol: tol(null, "5 sigma (Bonferroni over 768 direction x channel tests); weights within 8 ulp; reciprocity 2^-22 max f; chi-square p >= 1e-4", "pbrt-v3 src/tests/bsdfs.cpp chi2 test; Mitsuba 3 chi2; Veach 1997 ch. 6"),
  })),
});

// ---------------------------------------------------------------------------------------------
// G13-G16: numerical robustness

const grazing = (z: number) =>
  scene(1313, {
    camera: cam([-5, 0, z], [5, 0, z], 0.6),
    environment: envSplit([0, 0, 1], 1, 0),
    render: render(65, 65, 16, 2),
    materials: { m: mat([0.7, 0.7, 0.7]) },
    objects: { ground: plane([0, 0, 0], [0, 0, 1], "m"), tangent: sphere([2, 0, 0.5], 0.5, "m"), tiny: sphere([1, 0.3, 0.3], 0.001, "m") },
  });
out.push({
  id: "g13_grazing_degenerate_rays",
  title: "Rays inside a plane (0/0), tangent rays, grazing hits: finite and bounded",
  covers: ["numeric.nan", "energy"],
  kills: ["no-parallel-guard", "negative-discriminant-sqrt"],
  files: { "scene_on_plane.json": json(grazing(0)), "scene_grazing.json": json(grazing(1e-3)) },
  runs: [{ name: "on_plane", scene: "scene_on_plane.json" }, { name: "grazing", scene: "scene_grazing.json" }],
  asserts: [
    ...["on_plane", "grazing"].flatMap((r) => [
      { id: `A1-A2.${r}`, kind: "validators_pass", run: r },
      { id: `A4.${r}`, kind: "ids_valid", run: r },
    ]),
    { id: "A3", kind: "ids_row_in", run: "on_plane", row: 32, x_max: 32, allowed: ["NONE", "tangent"] },
  ],
});

const furnaceAt = (seed: number, camPos: Vec3, look: Vec3, vfov: number, objects: Record<string, J>, materials: Record<string, J>, L = 1) =>
  scene(seed, { camera: cam(camPos, look, vfov), environment: envConst(L), render: render(128, 128, 16, 1), materials, objects });
const white = { m: mat([1, 1, 1]) };
out.push({
  id: "g14_scale_extremes_furnace",
  title: "White furnace at 1e-3 m, 1e3 m, a 1e6 size ratio in one scene, and on the E_PRECISION boundary",
  covers: ["energy.furnace", "numeric.scale"],
  kills: ["fixed-epsilon-offset", "naive-quadratic", "camera-relative"],
  files: {
    "scene_tiny.json": json(furnaceAt(1401, [0, -4e-3, 0], [0, 0, 0], 0.6, { ball: sphere([0, 0, 0], 1e-3, "m") }, white)),
    "scene_huge.json": json(furnaceAt(1402, [0, -4e3, 0], [0, 0, 0], 0.6, { ball: sphere([0, 0, 0], 1e3, "m") }, white)),
    "scene_mixed.json": json(furnaceAt(1403, [0, -4e-3, 0], [0, 0, 0], 0.6, { ball: sphere([0, 0, 0], 1e-3, "m"), shell: sphere([0, 0, 0], 1e3, "glow") }, { m: mat([1, 1, 1]), glow: mat([0, 0, 0], 1) }, 0)),
    "scene_far.json": json(furnaceAt(1404, [0, 0, 0], [1e4, 0, 0], 0.01, { ball: sphere([1e4, 0, 0], 2.5, "m") }, white)),
  },
  runs: ["tiny", "huge", "mixed", "far"].map((n) => ({ name: n, scene: `scene_${n}.json` })),
  asserts: ["tiny", "huge", "mixed", "far"].flatMap((r) => [
    { id: `A1.${r}`, kind: "image_const", run: r, mask: { ids_in: ["ball"], erode_px: 1 }, expect: 1, target: "mean", min_pixels: 8, tol: tol(tauConvex, "as G08", `Wächter & Binder 2019 (RTG ch. 6); Haines et al. 2019 (RTG ch. 7); ${U}`) },
    ...(r === "mixed" ? [] : [{ id: `A2.${r}`, kind: "image_const", run: r, mask: { ids_none: true, erode_px: 1 }, expect: 1, target: "mean", tol: tol(0, "exact", "as G07") }]),
  ]),
});

const FREE_FALL = (dt: number, steps: number, every: number) => scene(1717, { physics: physics(dt, steps, every), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { ball: sphere([0, 0, 0], 1, "m", { mass_kg: 1, velocity_m_s: [0, 0, 0] }) } });
out.push({
  id: "g15_validator_negative_controls",
  title: "Injected NaN/Inf and a 1.001 BSDF gain are caught exactly where they were injected",
  covers: ["numeric.nan", "validators"],
  kills: ["nan-mask", "scan-first-frame-only", "scan-red-only", "validator-always-pass"],
  files: { "scene_furnace.json": json(furnaceScene(1)), "scene_fall.json": json(FREE_FALL(2 ** -6, 128, 1)) },
  runs: [
    { name: "clean", scene: "scene_furnace.json" },
    { name: "nan_pixel", scene: "scene_furnace.json", faults: { renderFaults: { FAULT_KIND: 1, FAULT_X: 17, FAULT_Y: 9, FAULT_C: 1 } } },
    { name: "inf_pixel", scene: "scene_furnace.json", faults: { renderFaults: { FAULT_KIND: 2, FAULT_X: 0, FAULT_Y: 0, FAULT_C: 0 } } },
    { name: "nan_body", scene: "scene_fall.json", faults: { physicsFaults: { FAULT_KIND: 3, FAULT_BODY: 0, FAULT_STEP: 100, FAULT_C: 2 } } },
    { name: "gain", scene: "scene_furnace.json", faults: { renderFaults: { BSDF_GAIN: 1.001 } } },
  ],
  asserts: [
    { id: "15a", kind: "nonfinite_set", run: "nan_pixel", image: [{ x: 17, y: 9, c: 1, kind: "nan" }], exit_code: 4 },
    { id: "15b", kind: "nonfinite_set", run: "inf_pixel", image: [{ x: 0, y: 0, c: 0, kind: "inf" }], exit_code: 4 },
    { id: "15c", kind: "nonfinite_first", run: "nan_body", physics: { step: 100, body: "ball", field: "v.z" }, exit_code: 4 },
    { id: "15d", kind: "nonfinite_set", run: "clean", image: [], exit_code: 0 },
    { id: "15e.furnace", kind: "expect_fail", inner: { kind: "image_const", run: "gain", mask: { ids_in: ["ball"], erode_px: 1 }, expect: 1, target: "mean", tol: tol(tauConvex, "as G08", "as G08") } },
    { id: "15e.energy", kind: "validator_fails", run: "gain", name: "energy.image", exit_code: 5 },
  ],
});

const physicsTol = tol(null, "tau_v(n) = 2 n ulp(V); tau_x(n) = n q + n ulp(V dt) + n^2 dt ulp(V); V = |v0| + |g| dt steps; q = 2^-32 m", `per step: two roundings of v (fl(dx), * 1/dt), one quantization and one rounding of x, plus the integrated velocity error; ${U}`);
out.push({
  id: "g16_physics_extremes",
  title: "Far from the origin, huge speed, tiny dt, extreme masses: finite, closed form, mass-independent",
  covers: ["numeric.nan", "numeric.ke_bounded", "analytic.physics"],
  kills: ["f32-world-position", "subtractive-velocity", "mass-in-integrator"],
  files: {
    "scene_far.json": json(scene(1601, {
      physics: physics(1e-3, 1000, 100),
      materials: { m: mat([0.5, 0.5, 0.5]) },
      objects: {
        b_far: sphere([9000, 9000, 9000], 4, "m", { mass_kg: 1, velocity_m_s: [0, 0, 0] }),
        b_heavy: sphere([-9000, 0, 0], 4, "m", { mass_kg: 1e6, velocity_m_s: [0, 0, 0] }),
        b_light: sphere([1, 1, 1], 0.01, "m", { mass_kg: 1e-6, velocity_m_s: [1, 2, 3] }),
        b_light_twin: sphere([1, 1, 1], 0.01, "m", { mass_kg: 1, velocity_m_s: [1, 2, 3] }),
      },
    })),
    "scene_fast.json": json(scene(1602, { physics: physics(1e-3, 1000, 100, [0, 0, 0]), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { b_fast: sphere([0, 0, 0], 1, "m", { mass_kg: 1, velocity_m_s: [1e4, -1e4, 1e4] }) } })),
    "scene_small_dt.json": json(scene(1603, { physics: physics(1e-5, 10000, 1000), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { b_slow: sphere([1, 1, 1], 0.1, "m", { mass_kg: 1, velocity_m_s: [0, 0, 0] }) } })),
  },
  runs: [{ name: "far", scene: "scene_far.json" }, { name: "fast", scene: "scene_fast.json" }, { name: "small_dt", scene: "scene_small_dt.json" }],
  asserts: [
    ...["far", "fast", "small_dt"].flatMap((r) => [
      { id: `A1.${r}`, kind: "validators_pass", run: r },
      { id: `A2-A3.${r}`, kind: "traj_closed_form", run: r, tol: physicsTol },
      { id: `A4.${r}`, kind: "ke_bounded", run: r, tol: physicsTol },
    ]),
    { id: "A5", kind: "traj_bits_equal", run: "far", bodies: ["b_light", "b_light_twin"] },
  ],
});

// ---------------------------------------------------------------------------------------------
// G17, G18: physics closed forms

out.push({
  id: "g17_free_fall_analytic",
  title: "Free fall: discrete closed form, discretization error g dt t / 2, first-order convergence",
  covers: ["analytic.physics"],
  kills: ["gravity-dt-not-dt2", "record-step-off-by-one", "explicit-euler"],
  files: { "scene_dt.json": json(FREE_FALL(2 ** -6, 128, 8)), "scene_dt2.json": json(FREE_FALL(2 ** -7, 256, 16)) },
  runs: [{ name: "dt", scene: "scene_dt.json" }, { name: "dt2", scene: "scene_dt2.json" }],
  asserts: [
    { id: "A1.dt", kind: "traj_closed_form", run: "dt", tol: physicsTol },
    { id: "A1.dt2", kind: "traj_closed_form", run: "dt2", tol: physicsTol },
    { id: "A2.dt", kind: "discretization_error", run: "dt", body: "ball", tol: physicsTol },
    { id: "A2.dt2", kind: "discretization_error", run: "dt2", body: "ball", tol: physicsTol },
    { id: "A3", kind: "dt_halving", runs: ["dt", "dt2"], body: "ball", ratio: [1.96, 2.04], tol: tol(0.04, "e(dt) = 0.15328 +- 4.92e-4, e(dt/2) = 0.07664 +- 9.80e-4 -> ratio in [1.968, 2.032]", "A1 tolerances") },
  ],
});

out.push({
  id: "g18_projectile_energy_drift",
  title: "Semi-implicit Euler energy drift is exactly -n |g|^2 dt^2 / 2; kinetic energy bounded",
  covers: ["analytic.physics", "numeric.ke_bounded"],
  kills: ["explicit-euler", "double-gravity"],
  files: { "scene.json": json(scene(1818, { physics: physics(2 ** -7, 256, 16), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { shot: sphere([0, 0, 0], 0.1, "m", { mass_kg: 1, velocity_m_s: [10, 0, 10] }) } })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "energy_drift", run: "a", tol: physicsTol },
    { id: "A2", kind: "ke_bounded", run: "a", tol: physicsTol },
  ],
});

// ---------------------------------------------------------------------------------------------
// G19: patches

const G19_BASE = scene(1919, {
  camera: cam([0, -6, 2.5], [0, 0, 0.8], 0.8),
  environment: envConst(0.5),
  render: render(64, 48, 16, 3, 2),
  physics: physics(2 ** -8, 64, 32),
  materials: { m1: mat([0.7, 0.3, 0.3]), m2: mat([0.3, 0.7, 0.3]), floor: mat([0.6, 0.6, 0.6]) },
  objects: {
    floor: plane([0, 0, 0], [0, 0, 1], "floor"),
    ball_a: sphere([-1, 0, 0.6], 0.6, "m1", { mass_kg: 1, velocity_m_s: [0, 0, 2] }),
    ball_b: sphere([1, 0, 0.5], 0.5, "m2"),
  },
});
const g19Direct = structuredClone(G19_BASE) as unknown as { objects: Record<string, J> };
(g19Direct.objects["ball_a"] as { radius_m: number }).radius_m = 0.25;
g19Direct.objects["ball_new"] = sphere([0, 1, 1], 0.4, "m1", { mass_kg: 0.5, velocity_m_s: [0, 0, 1] });
delete g19Direct.objects["ball_b"];
const g19Recolor = structuredClone(G19_BASE) as unknown as { materials: Record<string, { base_color: Vec3 }> };
g19Recolor.materials["m1"]!.base_color = [0.2, 0.2, 0.9];
const op = (o: J) => o;
out.push({
  id: "g19_patch_semantics",
  title: "RFC 6902 patches: incremental equals direct, rejections are atomic and exact, render-only patches leave physics untouched",
  covers: ["contract.patch"],
  kills: ["patch-in-place", "patch-no-revalidation", "pointer-by-index"],
  files: {
    "base.json": json(G19_BASE),
    "direct.json": json(g19Direct),
    "patch_edit.json": json([op({ op: "replace", path: "/objects/ball_a/radius_m", value: 0.25 }), op({ op: "add", path: "/objects/ball_new", value: sphere([0, 1, 1], 0.4, "m1", { mass_kg: 0.5, velocity_m_s: [0, 0, 1] }) }), op({ op: "remove", path: "/objects/ball_b" })]),
    "patch_recolor.json": json([op({ op: "replace", path: "/materials/m1/base_color", value: [0.2, 0.2, 0.9] })]),
    "recolor.json": json(g19Recolor),
  },
  runs: [
    { name: "base", scene: "base.json" },
    { name: "patched", scene: "base.json", patches: ["patch_edit.json"] },
    { name: "direct", scene: "direct.json" },
    { name: "recolored", scene: "base.json", patches: ["patch_recolor.json"] },
  ],
  asserts: [
    { id: "A1.hash", kind: "scene_hash_equal", runs: ["patched", "direct"] },
    { id: "A1.bytes", kind: "outputs_equal", runs: ["patched", "direct"] },
    { id: "A2-A3", kind: "patch_rejects", base: "base.json", cases: [
      { name: "dangling-ref", ops: [{ op: "move", from: "/materials/m1", path: "/materials/m9" }], expect: { code: "E_PATCH_INVALID_RESULT", path: "/objects/ball_a/material", cause: ["E_REF_MISSING@/objects/ball_a/material"] } },
      { name: "test-fails", ops: [{ op: "test", path: "/seed", value: 2 }], expect: { code: "E_PATCH_TEST_FAILED", path: "/seed", op_index: 0 } },
      { name: "out-of-range", ops: [{ op: "replace", path: "/materials/m1/base_color/0", value: 1.5 }], expect: { code: "E_PATCH_INVALID_RESULT", path: "/materials/m1/base_color/0", cause: ["E_RANGE@/materials/m1/base_color/0"] } },
      { name: "version", ops: [{ op: "replace", path: "/v", value: 2 }], expect: { code: "E_PATCH_FORBIDDEN_PATH", path: "/v", op_index: 0 } },
      { name: "whole-scene", ops: [{ op: "replace", path: "", value: {} }], expect: { code: "E_PATCH_FORBIDDEN_PATH", path: "", op_index: 0 } },
      { name: "missing-id", ops: [{ op: "remove", path: "/objects/nope" }], expect: { code: "E_PATCH_PATH_NOT_FOUND", path: "/objects/nope", op_index: 0 } },
      { name: "atomic-5th-fails", ops: [{ op: "replace", path: "/seed", value: 9 }, { op: "remove", path: "/objects/ball_b" }, { op: "add", path: "/materials/m3", value: { base_color: [1, 1, 1] } }, { op: "replace", path: "/objects/ball_a/radius_m", value: 0.3 }, { op: "test", path: "/seed", value: 1 }], expect: { code: "E_PATCH_TEST_FAILED", path: "/seed", op_index: 4 } },
      { name: "base-mismatch", base_scene_hash: `sha256:${"0".repeat(64)}`, ops: [{ op: "remove", path: "/seed" }], expect: { code: "E_PATCH_BASE_MISMATCH", path: "/base_scene_hash" } },
    ] },
    { id: "A4", kind: "files_equal", runs: ["base", "recolored"], prefix: "state/" },
    { id: "A5", kind: "json_patch_conformance", files: ["test/vendor/json-patch-tests/tests.json", "test/vendor/json-patch-tests/spec_tests.json"] },
  ],
});

// ---------------------------------------------------------------------------------------------
// G20: schema contract corpus

const minimal = () => scene(2020, { physics: physics(0.01, 10, 5), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { a: sphere([0, 0, 1], 1, "m") } });
const withRender = () => ({ ...minimal(), camera: cam([0, -4, 1], [0, 0, 1]), environment: envConst(1), render: render(16, 16, 1, 1) });
type Mut = (s: any) => void;
const invalid: [string, Mut | string, string, string][] = [
  ["radius_zero", (s) => (s.objects.a.radius_m = 0), "E_RANGE", "/objects/a/radius_m"],
  ["albedo_over_one", (s) => (s.materials.m.base_color = [1.01, 0, 0]), "E_RANGE", "/materials/m/base_color/0"],
  ["dt_zero", (s) => (s.physics.dt_s = 0), "E_RANGE", "/physics/dt_s"],
  ["spp_zero", (s) => Object.assign(s, withRender(), { render: { ...render(16, 16, 1, 1), spp: 0 } }), "E_RANGE", "/render/spp"],
  ["spp_fraction", (s) => Object.assign(s, withRender(), { render: { ...render(16, 16, 1, 1), spp: 1.5 } }), "E_TYPE", "/render/spp"],
  ["radius_string", (s) => (s.objects.a.radius_m = "1"), "E_TYPE", "/objects/a/radius_m"],
  ["typo_property", (s) => (s.objects.a.radius = 1), "E_UNKNOWN_PROPERTY", "/objects/a"],
  ["missing_material", (s) => delete s.objects.a.material, "E_REQUIRED", "/objects/a"],
  ["radius_1e999", '{"v":1,"seed":2020,"physics":{"integrator":"xpbd_unconstrained_p0","gravity_m_s2":[0,0,-9.81],"dt_s":0.01,"steps":10,"record_every_steps":5},"materials":{"m":{"base_color":[0.5,0.5,0.5]}},"objects":{"a":{"shape":"sphere","center_m":[0,0,1],"radius_m":1e999,"material":"m"}}}', "E_NONFINITE", "/objects/a/radius_m"],
  ["coord_minus_1e999", '{"v":1,"seed":2020,"physics":{"integrator":"xpbd_unconstrained_p0","gravity_m_s2":[0,0,-9.81],"dt_s":0.01,"steps":10,"record_every_steps":5},"materials":{"m":{"base_color":[0.5,0.5,0.5]}},"objects":{"a":{"shape":"sphere","center_m":[-1e999,0,1],"radius_m":1,"material":"m"}}}', "E_NONFINITE", "/objects/a/center_m/0"],
  ["duplicate_key", '{"v":1,"seed":2020,"physics":{"integrator":"xpbd_unconstrained_p0","gravity_m_s2":[0,0,-9.81],"dt_s":0.01,"steps":10,"record_every_steps":5},"materials":{"m":{"base_color":[0.5,0.5,0.5]}},"objects":{"a":{"shape":"sphere","center_m":[0,0,1],"radius_m":1,"radius_m":2,"material":"m"}}}', "E_DUPLICATE_KEY", "/objects/a/radius_m"],
  ["id_uppercase", (s) => { s.objects.Ball = s.objects.a; delete s.objects.a; }, "E_PATTERN", "/objects"],
  ["id_slash", (s) => { s.objects["a/b"] = s.objects.a; delete s.objects.a; }, "E_PATTERN", "/objects"],
  ["id_too_long", (s) => { s.objects[`a${"b".repeat(32)}`] = s.objects.a; delete s.objects.a; }, "E_PATTERN", "/objects"],
  ["dangling_material", (s) => (s.objects.a.material = "nope"), "E_REF_MISSING", "/objects/a/material"],
  ["camera_at_target", (s) => Object.assign(s, withRender(), { camera: cam([0, 0, 1], [0, 0, 1]) }), "E_CAMERA_DEGENERATE", "/camera"],
  ["camera_up_parallel", (s) => Object.assign(s, withRender(), { camera: cam([0, -4, 1], [0, 0, 1], 0.6, [0, 1, 0]) }), "E_CAMERA_DEGENERATE", "/camera"],
  ["plane_zero_normal", (s) => (s.objects.p = plane([0, 0, 0], [0, 0, 0], "m")), "E_ZERO_VECTOR", "/objects/p/normal"],
  ["env_up_tiny", (s) => Object.assign(s, withRender(), { environment: envSplit([0, 0, 1e-4], 1, 0) }), "E_ZERO_VECTOR", "/environment/up"],
  ["precision_tiny_far", (s) => (s.objects.a = sphere([9000, 0, 0], 1e-3, "m")), "E_PRECISION", "/objects/a"],
  ["emissive_black", (s) => (s.materials.m = mat([0.5, 0.5, 0.5], 5, [0, 0, 0])), "E_COLOR_LUMINANCE", "/materials/m"],
  ["env_black_color", (s) => Object.assign(s, withRender(), { environment: envConst(1, [0, 0, 0]) }), "E_COLOR_LUMINANCE", "/environment"],
  ["render_budget", (s) => Object.assign(s, withRender(), { render: render(4096, 4096, 65536, 256) }), "E_BUDGET", "/render"],
  ["id_hash_collision", (s) => { s.objects = { c2ya8: sphere([0, 0, 1], 1, "m"), czki6: sphere([3, 0, 1], 1, "m") }; }, "E_ID_HASH_COLLISION", "/objects"],
  ["version_2", (s) => (s.v = 2), "E_ENUM", "/v"],
  ["seed_negative", (s) => (s.seed = -1), "E_RANGE", "/seed"],
  ["seed_2_32", (s) => (s.seed = 4294967296), "E_RANGE", "/seed"],
  ["render_without_camera", (s) => Object.assign(s, { environment: envConst(1), render: render(16, 16, 1, 1) }), "E_RENDER_REQUIRES", ""],
  ["empty_run", (s) => delete s.physics, "E_EMPTY_RUN", ""],
  ["plane_with_body", (s) => (s.objects.p = { ...plane([0, 0, 0], [0, 0, 1], "m"), body: { mass_kg: 1, velocity_m_s: [0, 0, 0] } }), "E_UNKNOWN_PROPERTY", "/objects/p"],
  ["shape_cube", (s) => (s.objects.a.shape = "cube"), "E_VARIANT", "/objects/a/shape"],
  ["fast_with_gravity", (s) => { s.physics = physics(1e-5, 100000, 10000); s.objects.b = sphere([0, 0, 5], 1, "m", { mass_kg: 1, velocity_m_s: [1e4, -1e4, 1e4] }); }, "E_PRECISION_DT", "/objects/b/body"],
  ["center_two_components", (s) => (s.objects.a.center_m = [0, 0]), "E_ARITY", "/objects/a/center_m"],
  ["too_many_objects", (s) => { for (let i = 0; i < 4097; i++) s.objects[`o${i}`] = sphere([0, 0, 1], 1, "m"); }, "E_TOO_MANY", "/objects"],
  ["nan_literal", '{"v":1,"seed":NaN,"materials":{},"objects":{}}', "E_JSON_SYNTAX", ""],
  ["meta_control_char", (s) => (s.meta = { name: "a\tb" }), "E_PATTERN", "/meta/name"],
  ["proto_key", '{"v":1,"seed":2020,"__proto__":{"x":1},"physics":{"integrator":"xpbd_unconstrained_p0","gravity_m_s2":[0,0,-9.81],"dt_s":0.01,"steps":10,"record_every_steps":5},"materials":{"m":{"base_color":[0.5,0.5,0.5]}},"objects":{"a":{"shape":"sphere","center_m":[0,0,1],"radius_m":1,"material":"m"}}}', "E_UNKNOWN_PROPERTY", ""],
];
const g20Files: Record<string, string> = {};
const g20Cases = invalid.map(([name, mut, code, path]) => {
  if (typeof mut === "string") {
    g20Files[`invalid/${name}.json`] = `${mut}\n`;
  } else {
    const s = minimal();
    mut(s);
    g20Files[`invalid/${name}.json`] = json(s);
  }
  return { file: `invalid/${name}.json`, expect: [{ code, path }] };
});
out.push({
  id: "g20_schema_contract_corpus",
  title: "Schema lint, every golden scene accepted, 37 invalid scenes rejected with exact code and path, fuzzed scenes never crash",
  covers: ["contract.schema"],
  kills: ["no-duplicate-key-check", "no-precision-check", "error-code-mapping"],
  files: g20Files,
  runs: [],
  asserts: [
    { id: "A1", kind: "schema_lint" },
    { id: "A2", kind: "golden_scenes_valid", glob: "golden/p0/*/scene*.json" },
    { id: "A3", kind: "reject_corpus", cases: g20Cases },
    { id: "A4", kind: "schema_fuzz", seed: 2020, n: 10000, tol: tol(0, "zero crashes; every failure is a structured ContractViolation", "contract") },
  ],
});

// ---------------------------------------------------------------------------------------------

if (out.length !== 20) throw new Error(`expected 20 goldens, got ${out.length}`);
let drift = 0;
for (const g of out) {
  const dir = join(ROOT, g.id);
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
}
if (!check) {
  // Remove generated files that no longer belong to any golden (expected.json is kept: it comes from golden rebase).
  for (const g of readdirSync(ROOT, { withFileTypes: true })) {
    if (g.isDirectory() && !out.some((o) => o.id === g.name)) rmSync(join(ROOT, g.name), { recursive: true });
  }
}
console.log(check ? `gen_golden --check: ${drift} file(s) out of date` : `wrote ${out.length} goldens to ${ROOT}`);
process.exit(drift === 0 ? 0 : 1);
