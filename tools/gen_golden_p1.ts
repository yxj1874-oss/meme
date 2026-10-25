// Generates golden/p1/*: the P1 goldens G21-G33 (docs/P1-01-design.md ②) and G34 (plan invariance
// of the P1 kernel, P1-01 §3.3), bound to schema v2.
// golden/p1/g32_migration_v1_v2/p0_snapshot.json is not generated here: it freezes the P0 image,
// AOV and state hashes as recorded at the end of P0 and must never be regenerated from the
// current p0 expected.json files.
// Usage: node tools/gen_golden_p1.ts [--check]

import { HarnessRng, STREAM } from "../src/core/rng.ts";
import { emitSet, type GoldenDef, json, tol } from "./golden_lib.ts";

const ROOT = new URL("../golden/p1/", import.meta.url).pathname;
const check = process.argv.includes("--check");

type Vec3 = [number, number, number];
const U = "u = 2^-23 (WGSL rounding direction unspecified, §15.7.4: faithful rounding)";

const cam = (position: Vec3, lookAt: Vec3, vfov = 0.6, up: Vec3 = [0, 0, 1]) => ({ model: "pinhole", position_m: position, look_at_m: lookAt, up, vfov_rad: vfov });
const render = (w: number, h: number, spp: number, bounces: number, strategy = "mis", white = 1) => ({ width_px: w, height_px: h, spp, max_bounces: bounces, sampler: "independent", integrator: "pt_p1", strategy, display_white_cdm2: white });
const envConst = (L: number, color: Vec3 = [1, 1, 1]) => ({ type: "constant", luminance_cdm2: L, color });
const envSplit = (up: Vec3, upper: number, lower: number, color: Vec3 = [1, 1, 1]) => ({ type: "split", up, upper_cdm2: upper, lower_cdm2: lower, color });
const mat = (base: Vec3, o: { metallic?: number; roughness?: number; ior?: number; emissive?: number; color?: Vec3 } = {}) => ({
  base_color: base,
  metallic: o.metallic ?? 0,
  roughness: o.roughness ?? 1,
  ior: o.ior ?? 1,
  ...(o.emissive ? { emissive_cdm2: o.emissive, emissive_color: o.color ?? [1, 1, 1] } : {}),
});
const sphere = (center: Vec3, r: number, material: string) => ({ shape: "sphere", center_m: center, radius_m: r, material });
const plane = (point: Vec3, normal: Vec3, material: string) => ({ shape: "plane", point_m: point, normal, material });
const pointLight = (position: Vec3, cd: number, color: Vec3 = [1, 1, 1]) => ({ type: "point", position_m: position, intensity_cd: cd, color });
const scene = (seed: number, parts: Record<string, unknown>) => ({ v: 2, seed, ...parts });

const out: GoldenDef[] = [];
const tauConvex = (16 - 1 + 5 * 1) * 2 ** -23;

// G21 ---------------------------------------------------------------------------------------------
out.push({
  id: "g21_mirror_sphere_constant_env",
  title: "Delta metal sphere (F0 = 1) in a constant environment: exactly 1; any self-hit zeroes a sample",
  covers: ["energy.furnace", "delta"],
  kills: ["delta-no-offset", "delta-weight", "schlick-f0"],
  files: { "scene.json": json(scene(2101, { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(1), render: render(128, 128, 16, 1), materials: { mirror: mat([1, 1, 1], { metallic: 1, roughness: 0 }) }, objects: { ball: sphere([0, 0, 0], 1, "mirror") } })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "image_const", run: "a", mask: { ids_in: ["ball"], erode_px: 1 }, expect: 1, target: "mean", tol: tol(tauConvex, "(spp-1 + 5*D) * u, spp = 16, D = 1: the delta weight is Schlick(F0 = 1) = 1 exactly", `Higham 2002 §4.2; ${U}`) },
    { id: "A2", kind: "image_const", run: "a", mask: { ids_none: true, erode_px: 1 }, expect: 1, target: "mean", tol: tol(0, "exact: escaping rays return 1.0", "as G07") },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

// G22 ---------------------------------------------------------------------------------------------
out.push({
  id: "g22_dielectric_mirror_fresnel",
  title: "Smooth dielectric (ior 1.5, black base) under a split sky: per pixel F_diel(mu) times what the mirrored ray sees",
  covers: ["fresnel", "delta", "replay"],
  kills: ["fresnel-schlick-for-dielectric", "fresnel-eta-inverted", "delta-reflect-direction"],
  files: { "scene.json": json(scene(2201, { camera: cam([0, -4, 0.5], [0, 0, 0]), environment: envSplit([0, 0, 1], 1, 0.25), render: render(128, 128, 8, 1), materials: { coat: mat([0, 0, 0], { roughness: 0, ior: 1.5 }) }, objects: { ball: sphere([0, 0, 0], 1, "coat") } })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "replay_exact", run: "a", replay: "delta_reflection", mask: { ids_in: ["ball"], erode_px: 1 }, min_pixels: 2000, rel: 1e-5, tol: tol(2e-5, "abs: mu error <= 16 ulp(1) from f32 intersection and normal (sphere at 4 m, r = 1), |dF/dmu| <= 9.6 for ior in [1, 3] (measured) -> 1.8e-5; rel 1e-5 for the f32 Fresnel evaluation and the mean over spp", `f64 replay of the same Philox jitter; PBRT-v4 ch. 9 FrDielectric; ${U}`) },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

// G23 ---------------------------------------------------------------------------------------------
const furnace = (rough: number) => scene(2300 + Math.round(rough * 10), { camera: cam([0, -4, 0], [0, 0, 0]), environment: envConst(1), render: render(128, 128, 64, 1), materials: { metal: mat([1, 1, 1], { metallic: 1, roughness: rough }) }, objects: { ball: sphere([0, 0, 0], 1, "metal") } });
out.push({
  id: "g23_ggx_conductor_furnace",
  title: "GGX conductor (F0 = 1) white furnace: pixels match the single-scattering albedo E_ss(mu, alpha), not 1",
  covers: ["energy.furnace", "ggx", "mis.env"],
  kills: ["g2-as-g1", "ggx-d-alpha", "vndf-pdf", "mis-env-weight"],
  files: { "scene_r03.json": json(furnace(0.3)), "scene_r06.json": json(furnace(0.6)), "scene_r10.json": json(furnace(1.0)) },
  runs: [{ name: "r03", scene: "scene_r03.json" }, { name: "r06", scene: "scene_r06.json" }, { name: "r10", scene: "scene_r10.json" }],
  asserts: ["r03", "r06", "r10"].flatMap((r) => [
    { id: `A1.${r}`, kind: "replay_stat", run: r, replay: "ggx_furnace", mask: { ids_in: ["ball"], erode_px: 1 }, groups: 16, k: 5, tol: tol(null, "per group of pixels (16 groups by expected value): |sum(I - E)| <= 5 sqrt(sum var_p / N); E from adaptive Simpson in the VNDF domain (agrees with an independent slope-space integral to 1e-7), linearly interpolated on a 129-point mu grid: <= 4e-5 for mu >= 0.15, and every sample of the 1-px eroded mask has mu >= 0.18 (sphere radius 53 px), against 5 sigma ~ 2e-3 per group", "Heitz 2014 G2 / Heitz 2018 VNDF; CLT with per-pixel variance from m2; Bonferroni over 48 tests") },
    { id: `V.${r}`, kind: "validators_pass", run: r },
  ]),
});

// G24 ---------------------------------------------------------------------------------------------
// Roughness 0.1 (alpha 0.01) is the smooth-but-not-delta regime: below-horizon samples are rare
// (p ~ 1e-4) and the f32 D is most exposed to cancellation. The runtime samples GGX with spherical
// caps (decision F2); the last two probes keep Heitz 2018 VNDF, still compiled in, under test.
const probeMaterials: [string, Record<string, unknown>, Record<string, number>?][] = [
  ["metal_r03", { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: 0.3, ior: 1 }],
  ["metal_r06", { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: 0.6, ior: 1 }],
  ["metal_r10", { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: 1.0, ior: 1 }],
  ["coat_r03", { base_color: [0.8, 0.5, 0.2], metallic: 0, roughness: 0.3, ior: 1.5 }],
  ["coat_r06", { base_color: [0.8, 0.5, 0.2], metallic: 0, roughness: 0.6, ior: 1.5 }],
  ["coat_r10", { base_color: [0.8, 0.5, 0.2], metallic: 0, roughness: 1.0, ior: 1.5 }],
  ["mixed", { base_color: [0.3, 0.7, 0.9], metallic: 0.5, roughness: 0.45, ior: 1.8 }],
  ["metal_r01", { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: 0.1, ior: 1 }],
  ["coat_r01", { base_color: [0.8, 0.5, 0.2], metallic: 0, roughness: 0.1, ior: 1.5 }],
  ["metal_r03_vndf", { base_color: [0.9, 0.6, 0.3], metallic: 1, roughness: 0.3, ior: 1 }, { GGX_SAMPLER: 0 }],
  ["coat_r01_vndf", { base_color: [0.8, 0.5, 0.2], metallic: 0, roughness: 0.1, ior: 1.5 }, { GGX_SAMPLER: 0 }],
];
out.push({
  id: "g24_ggx_bsdf_probe",
  title: "P1 material: albedo vs f64 quadrature, energy <= 1, sampler weights, reciprocity, support, chi-square",
  covers: ["energy.bsdf", "reciprocity", "ggx"],
  kills: ["coupling-not-reciprocal", "kelemen-ebar", "spec-probability-pdf", "vndf-sampling"],
  files: {},
  runs: [],
  asserts: probeMaterials.map(([name, material, candidates], i) => ({
    id: `A.${name}`,
    kind: "material_probe",
    seed: 2400 + i,
    material,
    ...(candidates ? { candidates } : {}),
    directions: 256,
    blocks: 64,
    samples_per_block: 256,
    reciprocity_pairs: 4096,
    histogram_samples: 1 << 20,
    histogram_wo: [0.8660254037844386, 0, 0.5],
    k: 5,
    tol: tol(null, "albedo: |E[w] - E_ref| <= max(5 se_robust, albedo_floor) (Bonferroni over 768 tests; se_robust takes the invalid-sample share at its Wilson 95% upper bound, since smooth lobes see ~1e-4 invalid samples and a direction can draw none; the adaptive-quadrature reference agrees with an independent slope-space integral to 1e-7, the Kelemen table enters both sides identically)", "f64 reference src/oracle/ref_bsdf.ts; Wilson 1927; Veach 1997 ch. 6"),
    bounds: {
      albedo_floor: tol(2e-4, "f32 block sums of 256 weights carry <= 256u = 3e-5 relative error and the reference 1e-7; the floor only binds where 5 se_robust < 2e-4", U),
      retest_factor: tol(16, "a 5-sigma exceedance (A1 or A2) is re-measured with 16x the samples, the first blocks included: a bias grows 4x in z, a heavy-tail outlier shrinks 4x (coat_r06 seed 2404: -5.55 -> -0.52; 48 other seeds: max |z| 3.82)", "two-stage re-measurement; numbers measured on the reference substrate, docs/P1-01-design.md R16"),
      weight_rel: tol(512 * 2 ** -23, "the same ~40-operation expression compiled at two call sites may round differently (divisions 2.5 ulp, reassociation allowed: WGSL §15.7.4, §15.7.5); D takes sin^2 from the tangent components, so it does not cancel near the normal", U),
      reciprocity_rel: tol(1e-4, "dot(wo, h) and dot(wi, h) round separately (<= 6u apart) and enter F; |F'| / F reaches ~10 for ior 1.5 near grazing", U),
      length: tol(8 * 2 ** -23, "wi = 2 (wo.h) h - wo with |h|, |wo| = 1 +- 2u; the cosine-lobe sample as in G12 (sin / cos to ~1 ulp on the reference substrate, WGSL guarantees only 2^-11)", U),
      chi2_p: tol(1e-4, "chi-square p-value floor, deterministic under the fixed seed", "pbrt-v3 src/tests/bsdfs.cpp chi2 test"),
    },
  })),
});

// G25 ---------------------------------------------------------------------------------------------
out.push({
  id: "g25_point_light_lambert_plane",
  title: "Point light over a Lambert plane, nee: per pixel (rho / pi) I cos(theta) / r^2",
  covers: ["nee.point", "replay", "units.cd"],
  kills: ["point-inverse-square", "point-select-probability", "intensity-units"],
  files: { "scene.json": json(scene(2501, { camera: cam([0, -5, 3], [0, 0, 0], 0.8), environment: envConst(0), render: render(128, 96, 4, 1, "nee"), materials: { floor: mat([0.8, 0.6, 0.4]) }, objects: { floor: plane([0, 0, 0], [0, 0, 1], "floor") }, lights: { key: pointLight([0, 0, 2], 10) } })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "replay_exact", run: "a", replay: "point_light_direct", mask: { ids_in: ["floor"] }, min_pixels: 5000, rel: 2e-5, tol: tol(1e-7, "rel: r^2 and cos from f32 camera-relative points (|p| ~ 6 m, r ~ 2-6 m) carry <= 16 ulp relative error -> 2e-6, times 4 for the product and margin; abs floor for pixels near the horizon", `f64 replay; inverse-square law; ${U}`) },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

// G26 ---------------------------------------------------------------------------------------------
const sphereLight = (seed: number, w: number, h: number, spp: number, strategy: string) =>
  scene(seed, { camera: cam([0, -6, 4], [0, 0, 0], 0.7), environment: envConst(0), render: render(w, h, spp, 1, strategy), materials: { floor: mat([0.5, 0.5, 0.5]), lamp: mat([0, 0, 0], { emissive: 8 }) }, objects: { floor: plane([0, 0, 0], [0, 0, 1], "floor"), lamp: sphere([0, 0, 1.5], 0.5, "lamp") } });
const STRATS = ["bsdf", "nee", "mis"] as const;
// The runtime's MIS weight is the balance heuristic (decision F3), so "mis" is the run Theorem 9.2
// bounds; the power heuristic stays compiled in as a candidate and is checked for bias as "power".
const power = { name: "power", scene: "scene_mis.json", candidates: { MIS_HEURISTIC: 0 } };
const statTol = tol(null, "per group: |sum(I - E)| <= 5 sqrt(sum var_p / N), 8 groups x 3 channels", "sphere view factor E = pi L (R/d)^2 cos(theta); CLT; Bonferroni");
out.push({
  id: "g26_sphere_light_lambert_plane",
  title: "Sphere light over a Lambert plane: all estimators unbiased against the view-factor closed form; balance MIS (the default) within Veach's bound",
  covers: ["nee.sphere", "mis", "unbiasedness"],
  kills: ["cone-pdf", "mis-weight-swap", "nee-bsdf-double-count", "light-select-unnormalized"],
  files: Object.fromEntries(STRATS.map((s) => [`scene_${s}.json`, json(sphereLight(2601, 96, 72, 256, s))])),
  runs: [...STRATS.map((s) => ({ name: s, scene: `scene_${s}.json` })), power],
  asserts: [
    ...[...STRATS, "power"].map((s) => ({ id: `A1.${s}`, kind: "replay_stat", run: s, replay: "sphere_light_plane", mask: { ids_in: ["floor"], erode_px: 1 }, groups: 8, k: 5, tol: statTol })),
    { id: "A2", kind: "strategies_agree", runs: [...STRATS, "power"], mask: { ids_in: ["floor"], erode_px: 1 }, k: 5, tol: tol(null, "pairwise aggregate z over the floor pixels", "unbiasedness of every estimator") },
    { id: "A3", kind: "mis_variance_bound", balance: "mis", bsdf: "bsdf", nee: "nee", mask: { ids_in: ["floor"], erode_px: 1 }, k: 5, tol: tol(null, "sum_p var_balance <= sum_p (min(var_bsdf, var_nee) + mu^2 / 2) * (1 + 5 sqrt(2 / ((N-1) P)))", "Veach 1997 Theorem 9.2 with one sample per technique") },
  ],
});

// G27 ---------------------------------------------------------------------------------------------
const glossy = (strategy: string) =>
  scene(2701, {
    camera: cam([0, -5, 2.5], [0, 0, 0], 0.8),
    environment: envConst(0),
    render: render(96, 72, 256, 1, strategy),
    materials: { gloss: mat([0.9, 0.9, 0.9], { metallic: 1, roughness: 0.3 }), small: mat([0, 0, 0], { emissive: 200 }), big: mat([0, 0, 0], { emissive: 4 }) },
    objects: { floor: plane([0, 0, 0], [0, 0, 1], "gloss"), small: sphere([-1, 0, 0.8], 0.08, "small"), big: sphere([1.2, 0.5, 1.5], 0.8, "big") },
  });
out.push({
  id: "g27_mis_glossy_consistency",
  title: "Glossy floor under a small bright and a large dim light: estimators agree; balance MIS (the default) within Veach's bound",
  covers: ["mis", "unbiasedness", "ggx"],
  kills: ["mis-weight-swap", "bsdf-pdf-for-mis", "light-select-unnormalized"],
  files: Object.fromEntries(STRATS.map((s) => [`scene_${s}.json`, json(glossy(s))])),
  runs: [...STRATS.map((s) => ({ name: s, scene: `scene_${s}.json` })), power],
  asserts: [
    { id: "A1", kind: "strategies_agree", runs: [...STRATS, "power"], mask: { ids_in: ["floor"] }, k: 5, tol: tol(null, "pairwise aggregate z over the floor pixels", "unbiasedness of every estimator") },
    { id: "A2", kind: "mis_variance_bound", balance: "mis", bsdf: "bsdf", nee: "nee", mask: { ids_in: ["floor"] }, k: 5, tol: tol(null, "as G26 A3", "Veach 1997 Theorem 9.2") },
    ...STRATS.map((s) => ({ id: `V.${s}`, kind: "validators_pass", run: s })),
  ],
});

// G28 ---------------------------------------------------------------------------------------------
const theta = Math.PI / 3;
const nTilt: Vec3 = [Math.sin(theta), 0, Math.cos(theta)];
const tilted = (strategy: string) => scene(2801, { camera: cam([3 * nTilt[0], 0, 3 * nTilt[2]], [0, 0, 0], 0.6), environment: envSplit([0, 0, 1], 1, 0), render: render(64, 64, 64, 1, strategy), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { slab: plane([0, 0, 0], nTilt, "m") } });
const skyArgs = { rho: 0.5, cos_theta: Math.cos(theta) };
out.push({
  id: "g28_env_nee_split_sky",
  title: "Environment light sampling on the G10 tilted plane: nee and mis keep the closed form rho (1 + cos theta) / 2",
  covers: ["nee.env", "mis"],
  kills: ["env-pdf-hemisphere", "env-mis-weight"],
  files: { "scene_nee.json": json(tilted("nee")), "scene_mis.json": json(tilted("mis")) },
  runs: [{ name: "nee", scene: "scene_nee.json" }, { name: "mis", scene: "scene_mis.json" }],
  asserts: ["nee", "mis"].flatMap((s) => [
    { id: `A1.${s}`, kind: "image_mean_ksigma", run: s, mask: { ids_in: ["slab"] }, expect: { fn: "split_sky_tilted_plane", args: skyArgs }, sigma: { from_m2: true }, k: 4, tol: tol(null, "|mean - mu| <= 4 sqrt(sum var_p / N) / P", "isotropic sky view factor (Duffie & Beckman); CLT") },
    { id: `A2.${s}`, kind: "channels_equal", run: s },
  ]),
});

// G29 ---------------------------------------------------------------------------------------------
const SPP = [1, 4, 16, 64, 256, 1024];
out.push({
  id: "g29_mis_convergence_slope",
  title: "MIS on the sphere light: RMSE against the closed form falls as N^-1/2 with the right constant",
  covers: ["convergence", "mis"],
  kills: ["sample-index-not-in-nee-counter", "nee-dims-reused"],
  files: Object.fromEntries(SPP.map((n) => [`scene_n${n}.json`, json(sphereLight(2901, 32, 24, n, "mis"))])),
  runs: SPP.map((n) => ({ name: `n${n}`, scene: `scene_n${n}.json` })),
  asserts: [
    { id: "A1-A2", kind: "convergence", runs: SPP.map((n) => `n${n}`), spp: SPP, mask: { ids_in: ["floor"], erode_px: 1 }, expect: { replay: "sphere_light_plane" }, sigma: { from_run_m2: "n1024" }, slope: [-0.55, -0.45], calibration: [0.85, 1.15], calibration_min_spp: 4, tol: tol(0.05, "slope as G11; calibration +-15%: sigma itself is estimated from the N = 1024 run (relative sd ~ sqrt(kappa/(4 P N)) small) and RMSE from ~600 pixels (relative sd <= 3%) -> about 5 sd", "OLS slope variance; G11") },
  ],
});

// G30 ---------------------------------------------------------------------------------------------
const toZero = (rough: number) => scene(3001, { camera: cam([0, -4, 0.5], [0, 0, 0]), environment: envSplit([0, 0, 1], 1, 0.25), render: render(96, 96, 64, 1), materials: { coat: mat([0, 0, 0], { roughness: rough, ior: 1.5 }) }, objects: { ball: sphere([0, 0, 0], 1, "coat") } });
const ROUGH: [string, number][] = [["a4e3", Math.sqrt(4e-3)], ["a2e3", Math.sqrt(2e-3)], ["a125e4", Math.sqrt(1.25e-3)]];
out.push({
  id: "g30_roughness_to_zero",
  title: "Roughness -> 0: the GGX image converges to the delta-lobe image as alpha falls to alpha_min",
  covers: ["delta", "continuity"],
  kills: ["delta-fresnel-differs", "alpha-min-threshold"],
  files: { ...Object.fromEntries(ROUGH.map(([n, r]) => [`scene_${n}.json`, json(toZero(r))])), "scene_delta.json": json(toZero(0)) },
  runs: [...ROUGH.map(([n]) => ({ name: n, scene: `scene_${n}.json` })), { name: "delta", scene: "scene_delta.json" }],
  asserts: [
    { id: "A1", kind: "roughness_limit", runs: ROUGH.map(([n]) => n), delta: "delta", mask: { ids_in: ["ball"], erode_px: 1 }, ratio_max: 0.5, tol: tol(0.5, "lobe blur scales with alpha; alpha_last / alpha_first = 0.3125, so a continuous limit gives <= ~0.31 plus noise; a constant offset in the delta branch would not shrink", "continuity of GGX at alpha -> 0 (Walter et al. 2007)") },
    { id: "V", kind: "validators_pass", run: "delta" },
  ],
});

// G31 ---------------------------------------------------------------------------------------------
out.push({
  id: "g31_light_touching_surface",
  title: "A sphere light resting on a plane and a point light 1 mm above it: finite, bounded, and on the closed form",
  covers: ["extreme.light_touching", "nee.sphere", "nee.point"],
  kills: ["cone-at-contact", "r2-guard"],
  files: {
    "scene_sphere.json": json(scene(3101, { camera: cam([0, -4, 1.2], [0, 0, 0.3], 0.9), environment: envConst(0), render: render(128, 96, 256, 1), materials: { floor: mat([0.5, 0.5, 0.5]), lamp: mat([0, 0, 0], { emissive: 4 }) }, objects: { floor: plane([0, 0, 0], [0, 0, 1], "floor"), lamp: sphere([0, 0, 0.5], 0.5, "lamp") } })),
    "scene_point.json": json(scene(3102, { camera: cam([0, -0.02, 0.01], [0, 0, 0], 1.2), environment: envConst(0), render: render(96, 72, 4, 1, "nee"), materials: { floor: mat([0.5, 0.5, 0.5]) }, objects: { floor: plane([0, 0, 0], [0, 0, 1], "floor") }, lights: { tip: pointLight([0, 0, 1e-3], 1e-3) } })),
  },
  runs: [{ name: "sphere", scene: "scene_sphere.json" }, { name: "point", scene: "scene_point.json" }],
  asserts: [
    { id: "A1", kind: "validators_pass", run: "sphere" },
    { id: "A2", kind: "replay_stat", run: "sphere", replay: "sphere_light_plane", mask: { ids_in: ["floor"], erode_px: 1 }, groups: 8, k: 5, tol: tol(null, "as G26; touching sphere: cos(theta) = R / d = sin(alpha), the sphere sits exactly on the horizon and the closed form still holds", "sphere view factor; CLT") },
    { id: "A3", kind: "validators_pass", run: "point" },
    { id: "A4", kind: "replay_exact", run: "point", replay: "point_light_direct", mask: { ids_in: ["floor"] }, min_pixels: 2000, rel: 1e-4, tol: tol(1e-6, "rel: camera-relative f32 points within 2 cm carry ~16 ulp(0.02) = 3e-8 m error against r >= 1e-3 m -> 3e-5 on r^2, margin x3", `f64 replay; ${U}`) },
  ],
});

// G32 ---------------------------------------------------------------------------------------------
const lossy = scene(3201, {
  camera: cam([0, -4, 1], [0, 0, 0]),
  environment: envConst(1),
  render: render(8, 8, 1, 1, "mis"),
  materials: { a: mat([1, 1, 1], { metallic: 0.5 }), b: mat([1, 1, 1], { ior: 1.5 }), c: mat([0.5, 0.5, 0.5]) },
  objects: { s: sphere([0, 0, 0], 1, "a"), t: sphere([3, 0, 0], 1, "b") },
  lights: { key: pointLight([0, 0, 3], 10) },
});
out.push({
  id: "g32_migration_v1_v2",
  title: "Every p0 run, migrated to v2 and rendered by the P1 kernel, reproduces its P0 bytes; migrations round-trip; lossy rollbacks are refused",
  covers: ["contract.migration", "regression"],
  kills: ["lambert-path-changed", "migration-defaults", "rollback-not-lossy"],
  files: { "lossy.json": json(lossy) },
  runs: [],
  asserts: [
    { id: "A1", kind: "p0_byte_identity", snapshot: "p0_snapshot.json" },
    { id: "A2", kind: "migration_roundtrip" },
    { id: "A3", kind: "rollback_lossy", cases: [{ file: "lossy.json", expect: ["E_ROLLBACK_LOSSY@/lights/key", "E_ROLLBACK_LOSSY@/materials/a/metallic", "E_ROLLBACK_LOSSY@/materials/b/ior", "E_ROLLBACK_LOSSY@/render/strategy"] }] },
  ],
});

// G33 ---------------------------------------------------------------------------------------------
const base33 = () => scene(3301, { camera: cam([0, -4, 1], [0, 0, 0]), environment: envConst(1), render: render(16, 16, 1, 1), materials: { m: mat([0.5, 0.5, 0.5]) }, objects: { a: sphere([0, 0, 0], 1, "m") }, lights: { l: pointLight([0, 0, 3], 10) } });
type Mut = (s: any) => void;
const invalid: [string, Mut, string, string][] = [
  ["metallic_over_one", (s) => (s.materials.m.metallic = 1.5), "E_RANGE", "/materials/m/metallic"],
  ["roughness_negative", (s) => (s.materials.m.roughness = -0.1), "E_RANGE", "/materials/m/roughness"],
  ["ior_below_one", (s) => (s.materials.m.ior = 0.9), "E_RANGE", "/materials/m/ior"],
  ["ior_over_three", (s) => (s.materials.m.ior = 3.5), "E_RANGE", "/materials/m/ior"],
  ["intensity_negative", (s) => (s.lights.l.intensity_cd = -1), "E_RANGE", "/lights/l/intensity_cd"],
  ["light_type_spot", (s) => (s.lights.l.type = "spot"), "E_VARIANT", "/lights/l/type"],
  ["light_missing_color", (s) => delete s.lights.l.color, "E_REQUIRED", "/lights/l"],
  ["light_inside_sphere", (s) => (s.lights.l.position_m = [0, 0, 0.5]), "E_LIGHT_INSIDE", "/lights/l"],
  ["light_black", (s) => (s.lights.l.color = [0, 0, 0]), "E_COLOR_LUMINANCE", "/lights/l"],
  ["light_id_uppercase", (s) => { s.lights.L = s.lights.l; delete s.lights.l; }, "E_PATTERN", "/lights"],
  ["too_many_lights", (s) => { for (let i = 0; i < 64; i++) s.lights[`x${i}`] = pointLight([i, 5, 3], 1); }, "E_TOO_MANY", "/lights"],
  ["strategy_unknown", (s) => (s.render.strategy = "fast"), "E_ENUM", "/render/strategy"],
  ["integrator_v1_in_v2", (s) => (s.render.integrator = "pt_bsdf_p0"), "E_ENUM", "/render/integrator"],
  // 4096^2 * 4096 spp * 1 bounce slot * 1 object = 2^36 exactly: allowed for bsdf, doubled by light sampling.
  ["budget_doubles_with_mis", (s) => { s.render = render(4096, 4096, 4096, 1, "mis"); s.render.max_bounces = 0; delete s.lights; }, "E_BUDGET", "/render"],
  ["light_id_collision", (s) => { s.lights = { c2ya8: pointLight([0, 0, 3], 1), czki6: pointLight([1, 0, 3], 1) }; }, "E_ID_HASH_COLLISION", "/lights"],
];
const g33Files: Record<string, string> = {};
const g33Cases = invalid.map(([name, mut, code, path]) => {
  const s = base33();
  mut(s);
  g33Files[`invalid/${name}.json`] = json(s);
  return { file: `invalid/${name}.json`, expect: [{ code, path }] };
});
out.push({
  id: "g33_schema_v2_corpus",
  title: "Schema v2: 15 invalid scenes rejected with exact code and path",
  covers: ["contract.schema"],
  kills: ["light-inside-check", "v2-error-mapping"],
  files: g33Files,
  runs: [],
  asserts: [{ id: "A1", kind: "reject_corpus", cases: g33Cases }],
});

// G34 ---------------------------------------------------------------------------------------------
// G03's five plans on a scene that takes every P1 path: delta mirror, microfacet metal and coat,
// Lambert, a point light, a sphere light and a split sky, strategy mis, three bounces.
const allPaths = scene(3401, {
  camera: cam([0, -6, 2.5], [0, 0, 0.6], 0.7),
  environment: envSplit([0, 0, 1], 0.5, 0.1),
  render: render(64, 48, 64, 3),
  materials: { floor: mat([0.6, 0.6, 0.6]), mirror: mat([1, 1, 1], { metallic: 1, roughness: 0 }), gold: mat([0.9, 0.6, 0.3], { metallic: 1, roughness: 0.4 }), coat: mat([0.2, 0.4, 0.8], { roughness: 0.3, ior: 1.5 }), lamp: mat([0, 0, 0], { emissive: 20 }) },
  objects: { floor: plane([0, 0, 0], [0, 0, 1], "floor"), a: sphere([-1.2, 0, 0.5], 0.5, "mirror"), b: sphere([0, 0.3, 0.5], 0.5, "gold"), c: sphere([1.2, 0, 0.5], 0.5, "coat"), lamp: sphere([0, 1.5, 2.2], 0.3, "lamp") },
  lights: { key: pointLight([2, -2, 3], 30) },
});
const order34 = new HarnessRng(3403, 0, STREAM.HARNESS_SCHEDULE).shuffle(Array.from({ length: Math.ceil(64 / 16) * Math.ceil(48 / 16) }, (_, i) => i));
const plans34 = [
  { pass_spp: 64, tile_px: 64, submit_batches: 1, physics_steps_per_dispatch: 1 },
  { pass_spp: 16, tile_px: 16, submit_batches: 1, physics_steps_per_dispatch: 1 },
  { pass_spp: 1, tile_px: 8, submit_batches: 1, physics_steps_per_dispatch: 1 },
  { pass_spp: 16, tile_px: 16, tile_order: order34, submit_batches: 1, physics_steps_per_dispatch: 1 },
  { pass_spp: 64, tile_px: 16, submit_batches: 7, physics_steps_per_dispatch: 1 },
];
out.push({
  id: "g34_det_plan_invariance_p1",
  title: "P1 kernel: pass split, tile size, tile order and dispatch batching do not change any output byte (every P1 path, mis, 3 bounces)",
  covers: ["determinism"],
  kills: ["pass-local-sum", "cross-tile-race", "dispatch-dependent-state", "nee-dims-reused"],
  files: { "scene.json": json(allPaths) },
  runs: plans34.map((plan, i) => ({ name: `p${i + 1}`, scene: "scene.json", plan })),
  asserts: [
    { id: "A1", kind: "outputs_equal", runs: plans34.map((_, i) => `p${i + 1}`) },
    { id: "V", kind: "validators_pass", run: "p1" },
  ],
});

if (out.length !== 14) throw new Error(`expected 14 goldens, got ${out.length}`);
const drift = emitSet(ROOT, out, check);
console.log(check ? `gen_golden_p1 --check: ${drift} file(s) out of date` : `wrote ${out.length} goldens to ${ROOT}`);
process.exit(drift === 0 ? 0 : 1);
