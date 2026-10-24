// Assertion kinds used by golden/p0/*/oracle.json. Every kind returns one or more results with the
// measured value next to the expectation, so a failing oracle says by how much it failed.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ContractViolation } from "../core/errors.ts";
import { jcs } from "../core/jcs.ts";
import type { Json } from "../core/json_strict.ts";
import { applyJsonPatch, applyScenePatch, jsonEqual, type PatchOp } from "../core/patch.ts";
import { HarnessRng, philox4x32R, rng4, toUnitFloat } from "../core/rng.ts";
import { type LoadedScene, loadSceneText, loadSceneValue } from "../core/scene.ts";
import type { Vec3 } from "../core/scene_types.ts";
import { sceneSchema, validateSceneSchema } from "../core/schema.ts";
import { dot, luminanceY, norm } from "../core/vec.ts";
import type { Gpu } from "../gpu/device.ts";
import { decodePngStored } from "../io/png.ts";
import { decodeBodies, dynamicBodies } from "../runtime/physics.ts";
import { ID_NONE } from "../runtime/render.ts";
import { exitCodeFor, type RunOutput } from "../runtime/run.ts";
import { compareRuns, determinismCheck } from "../tools/determinism.ts";
import { PHILOX_KAT } from "./kat.ts";
import { cosineBinProbability, HIST_MU, HIST_PHI, probeBsdf, type RngCase, rngCrossCheck } from "./probes.ts";
import { sampleScene } from "./schema_sampler.ts";
import { lintSchema } from "./schema_lint.ts";
import { chiSquare, olsSlope, pearson } from "./stats.ts";

export interface Result {
  id: string;
  pass: boolean;
  measured?: unknown;
  expected?: unknown;
  detail?: unknown;
}

export interface Run {
  loaded: LoadedScene;
  output: RunOutput;
}

export interface Context {
  root: string;
  dir: string;
  gpu: Gpu;
  cli: string;
  runs: Map<string, Run>;
}

type Params = Record<string, any>;
type Kind = (ctx: Context, a: Params) => Promise<Result[]> | Result[];

const one = (a: Params, pass: boolean, measured?: unknown, expected?: unknown, detail?: unknown): Result[] => [{ id: a["id"], pass, measured, expected, detail }];

function run(ctx: Context, name: string): Run {
  const r = ctx.runs.get(name);
  if (r === undefined) throw new Error(`oracle refers to unknown run ${name}`);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Named closed forms (design §3.9: functions, not evaluated strings)

const CLOSED_FORMS: Record<string, (args: Params) => number> = {
  /** Camera inside a uniformly emitting Lambert sphere: L = Le * sum_{k=0..D} rho^k. */
  enclosure_series: ({ le, rho, max_bounces }) => (le * (1 - rho ** (max_bounces + 1))) / (1 - rho),
  /** Lambert plane tilted by theta under a sky that is 1 above the horizon, 0 below: rho (1 + cos theta) / 2. */
  split_sky_tilted_plane: ({ rho, cos_theta }) => (rho * (1 + cos_theta)) / 2,
  /** Per-sample standard deviation of the above: rho sqrt(p (1 - p)), p = (1 + cos theta) / 2. */
  split_sky_sigma: ({ rho, cos_theta }) => {
    const p = (1 + cos_theta) / 2;
    return rho * Math.sqrt(p * (1 - p));
  },
};

function value(spec: number | { fn: string; args: Params }): number {
  if (typeof spec === "number") return spec;
  const f = CLOSED_FORMS[spec.fn];
  if (f === undefined) throw new Error(`unknown closed form ${spec.fn}`);
  return f(spec.args);
}

// ---------------------------------------------------------------------------------------------
// Image helpers

function mask(r: Run, m: Params): Uint8Array {
  const res = r.output.render!;
  const { width: W, height: H } = res;
  const ranks = new Set<number>();
  for (const id of (m["ids_in"] as string[] | undefined) ?? []) {
    const k = res.objectIds.indexOf(id);
    if (k < 0) throw new Error(`mask refers to unknown object ${id}`);
    ranks.add(k);
  }
  const want = (v: number) => (m["all"] ? true : m["ids_none"] ? v === ID_NONE : ranks.has(v));
  const e = (m["erode_px"] as number | undefined) ?? 0;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ok = want(res.ids[y * W + x]!);
      for (let dy = -e; ok && dy <= e; dy++) {
        for (let dx = -e; ok && dx <= e; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || !want(res.ids[yy * W + xx]!) || res.ids[yy * W + xx] !== res.ids[y * W + x]) ok = false;
        }
      }
      out[y * W + x] = ok ? 1 : 0;
    }
  }
  return out;
}

function masked(r: Run, m: Params, channel: number, target: "mean" | "m2" = "mean"): number[] {
  const res = r.output.render!;
  const mk = mask(r, m);
  const out: number[] = [];
  for (let p = 0; p < mk.length; p++) if (mk[p]) out.push(res[target][p * 3 + channel]!);
  return out;
}

const imageConst: Kind = (ctx, a) => {
  const r = run(ctx, a["run"]);
  const res = r.output.render!;
  const target = (a["target"] as "mean" | "m2" | undefined) ?? "mean";
  const expect = value(a["expect"]);
  const t = a["tol"]["value"] as number;
  const mk = mask(r, a["mask"]);
  const pixels = mk.reduce((n, v) => n + v, 0);
  let maxErr = 0;
  let worst = -1;
  let bad = 0;
  for (let p = 0; p < mk.length; p++) {
    if (!mk[p]) continue;
    for (let c = 0; c < 3; c++) {
      const v = res[target][p * 3 + c]!;
      const err = t === 0 ? (v === Math.fround(expect) ? 0 : Math.abs(v - expect) || Infinity) : Math.abs(v - expect) / (a["relative"] ? Math.abs(expect) : 1);
      const ok = t === 0 ? err === 0 : err <= t;
      if (!ok || Number.isNaN(err)) bad++;
      if (!(err <= maxErr)) {
        maxErr = err;
        worst = p;
      }
    }
  }
  const minPixels = (a["min_pixels"] as number | undefined) ?? 1;
  return one(a, bad === 0 && pixels >= minPixels, { max_error: maxErr, worst_pixel: worst < 0 ? null : { x: worst % res.width, y: Math.floor(worst / res.width) }, pixels, failing_values: bad }, { expect, tol: t, relative: !!a["relative"], min_pixels: minPixels });
};

// ---------------------------------------------------------------------------------------------

const KINDS: Record<string, Kind> = {
  fresh_process_determinism: (ctx, a) => {
    const report = determinismCheck(ctx.cli, join(ctx.dir, a["scene"]), join(ctx.root, "out", "golden", ctx.dir.split("/").pop()!, "determinism"));
    return one(a, report.pass, { divergences: report.divergences, manifest_equal: report.manifest_equal });
  },

  validators_pass: (ctx, a) => {
    const v = run(ctx, a["run"]).output.manifest.deterministic.validators;
    return one(a, v.every((x) => x.pass), v.map((x) => ({ name: x.name, pass: x.pass, detail: x.pass ? undefined : x.detail })));
  },

  outputs_equal: (ctx, a) => {
    const names = a["runs"] as string[];
    const base = run(ctx, names[0]!).output.files;
    const diffs = names.slice(1).map((n) => ({ run: n, divergences: compareRuns(base, run(ctx, n).output.files) }));
    return one(a, diffs.every((d) => d.divergences.length === 0), diffs);
  },

  files_equal: (ctx, a) => {
    const names = a["runs"] as string[];
    const pick = (n: string) => new Map([...run(ctx, n).output.files].filter(([k]) => k.startsWith(a["prefix"])));
    const base = pick(names[0]!);
    const diffs = names.slice(1).map((n) => compareRuns(base, pick(n)));
    return one(a, base.size > 0 && diffs.every((d) => d.length === 0), { files: base.size, diffs });
  },

  scene_hash_equal: (ctx, a) => {
    const hashes = (a["runs"] as string[]).map((n) => run(ctx, n).loaded.scene_hash);
    return one(a, hashes.every((h) => h === hashes[0]), hashes);
  },

  image_const: imageConst,

  // Photometric contract (D6-A): each pixel's RGB equals the expected radiance and its BT.709
  // luminance equals the requested cd/m2.
  image_luminance: (ctx, a) => {
    const r = run(ctx, a["run"]);
    const res = r.output.render!;
    const mk = mask(r, a["mask"]);
    const want = a["rgb"] as Vec3;
    const t = a["tol"]["value"] as number;
    let worstRgb = 0;
    let worstY = 0;
    let pixels = 0;
    for (let p = 0; p < mk.length; p++) {
      if (!mk[p]) continue;
      pixels++;
      const px = [0, 1, 2].map((c) => res.mean[p * 3 + c]!) as Vec3;
      for (let c = 0; c < 3; c++) {
        const err = want[c] === 0 ? (px[c] === 0 ? 0 : Infinity) : Math.abs(px[c]! - want[c]!) / want[c]!;
        worstRgb = Math.max(worstRgb, err);
      }
      worstY = Math.max(worstY, Math.abs(luminanceY(px) - a["expect"]) / a["expect"]);
    }
    return one(a, pixels > 0 && worstRgb <= t && worstY <= t, { worst_rgb_rel: worstRgb, worst_luminance_rel: worstY, pixels }, { rgb: want, luminance: a["expect"], tol: t });
  },

  png_all: (ctx, a) => {
    const { rgb } = decodePngStored(run(ctx, a["run"]).output.files.get("image.png")!);
    const want = a["rgb"] as number[];
    const bad = rgb.filter((v, i) => v !== want[i % 3]).length;
    return one(a, bad === 0, { mismatching_bytes: bad });
  },

  ids_all: (ctx, a) => {
    const ids = run(ctx, a["run"]).output.render!.ids;
    const want = a["value"] === "NONE" ? ID_NONE : run(ctx, a["run"]).output.render!.objectIds.indexOf(a["value"]);
    return one(a, ids.every((v) => v === want), { distinct: [...new Set(ids)].slice(0, 8) });
  },

  ids_valid: (ctx, a) => {
    const res = run(ctx, a["run"]).output.render!;
    const bad = res.ids.filter((v) => v !== ID_NONE && v >= res.objectIds.length).length;
    return one(a, bad === 0, { invalid: bad });
  },

  ids_row_in: (ctx, a) => {
    const res = run(ctx, a["run"]).output.render!;
    const allowed = new Set((a["allowed"] as string[]).map((s) => (s === "NONE" ? ID_NONE : res.objectIds.indexOf(s))));
    const row = a["row"] as number;
    const seen: number[] = [];
    for (let x = 0; x < (a["x_max"] as number); x++) seen.push(res.ids[row * res.width + x]!);
    const names = [...new Set(seen)].map((v) => (v === ID_NONE ? "NONE" : res.objectIds[v]));
    return one(a, seen.every((v) => allowed.has(v)), names, a["allowed"]);
  },

  image_mean_ksigma: (ctx, a) => {
    const r = run(ctx, a["run"]);
    const vals = masked(r, a["mask"], 0);
    const N = r.output.render!.spp;
    const mu = value(a["expect"]);
    const sigma = value(a["sigma"]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const bound = (a["k"] * sigma) / Math.sqrt(vals.length * N);
    return one(a, vals.length > 0 && Math.abs(mean - mu) <= bound, { mean, error: mean - mu, pixels: vals.length }, { mu, bound });
  },

  variance_ratio: (ctx, a) => {
    const r = run(ctx, a["run"]);
    const N = r.output.render!.spp;
    const mean = masked(r, a["mask"], 0, "mean");
    const m2 = masked(r, a["mask"], 0, "m2");
    let pooled = 0;
    for (let i = 0; i < mean.length; i++) pooled += ((m2[i]! - mean[i]! * mean[i]!) * N) / (N - 1);
    pooled /= mean.length;
    const sigma2 = value(a["sigma"]) ** 2;
    const ratio = pooled / sigma2;
    return one(a, Math.abs(ratio - 1) <= a["tol"]["value"], { pooled_variance: pooled, ratio }, { sigma2, tol: a["tol"]["value"] });
  },

  channels_equal: (ctx, a) => {
    const m = run(ctx, a["run"]).output.render!.mean;
    let bad = 0;
    for (let p = 0; p < m.length; p += 3) if (m[p] !== m[p + 1] || m[p] !== m[p + 2]) bad++;
    return one(a, bad === 0, { unequal_pixels: bad });
  },

  convergence: (ctx, a) => {
    const names = a["runs"] as string[];
    const spp = a["spp"] as number[];
    const mu = value(a["expect"]);
    const sigma = value(a["sigma"]);
    const rmse = names.map((n) => {
      const v = masked(run(ctx, n), a["mask"], 0);
      return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length);
    });
    const fit = olsSlope(spp.map(Math.log), rmse.map(Math.log));
    const calib = spp.map((n, i) => (rmse[i]! * Math.sqrt(n)) / sigma);
    const [lo, hi] = a["slope"] as [number, number];
    const [clo, chi] = a["calibration"] as [number, number];
    const calibOk = calib.every((c, i) => spp[i]! < a["calibration_min_spp"] || (c >= clo && c <= chi));
    return [
      { id: `${a["id"]}:slope`, pass: fit.slope >= lo && fit.slope <= hi, measured: { slope: fit.slope, rmse }, expected: [lo, hi] },
      { id: `${a["id"]}:calibration`, pass: calibOk, measured: calib, expected: [clo, chi] },
    ];
  },

  rng_kat: (_ctx, a) => {
    const results = PHILOX_KAT.map((k) => philox4x32R(k.rounds, ...k.ctr, ...k.key).map((x) => x.toString(16).padStart(8, "0")).join(" ") === k.out);
    return one(a, results.every(Boolean), { matching: results.filter(Boolean).length, vectors: PHILOX_KAT.length });
  },

  rng_gpu_cpu: async (ctx, a) => {
    const cases: RngCase[] = [];
    for (const seed of a["seeds"] as number[]) {
      for (const stream of a["streams"] as number[]) {
        for (let i = 0; i < Math.floor(a["sequential"] / 16); i++) cases.push({ seed, stream, ctr: [i, 0, 0, 0] });
      }
    }
    const h = new HarnessRng(404, 0);
    for (let i = 0; i < a["random"]; i++) cases.push({ seed: h.u32(), stream: h.below(6), ctr: [h.u32(), h.u32(), h.u32(), h.u32()] });
    const r = await rngCrossCheck(ctx.gpu, cases);
    // The exact maximum 1 - 2^-24 needs an input word >= 0xffffff00; the CPU unit test pins it with fixed inputs.
    return one(a, r.word_mismatches === 0 && r.unit_mismatches === 0 && r.unit_out_of_range === 0, r, { mismatches: 0, range: "[0, 1)" });
  },

  rng_quality: (_ctx, a) => {
    const n = a["n"] as number;
    const seed = a["seed"] as number;
    const [plo, phi] = a["p_range"] as [number, number];
    const bins1 = new Float64Array(1024);
    const bins2 = new Float64Array(64 * 64);
    const s0 = new Float64Array(n);
    const s3 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = rng4(seed, 0, i & 1023, i >>> 10, 0, 0);
      const u0 = toUnitFloat(r[0]);
      const u1 = toUnitFloat(r[1]);
      bins1[Math.floor(u0 * 1024)]!++;
      bins2[Math.floor(u0 * 64) * 64 + Math.floor(u1 * 64)]!++;
      s0[i] = u0;
      s3[i] = toUnitFloat(rng4(seed, 3, i & 1023, i >>> 10, 0, 0)[0]);
    }
    const c1 = chiSquare(bins1, new Float64Array(1024).fill(n / 1024));
    const c2 = chiSquare(bins2, new Float64Array(4096).fill(n / 4096));
    const corr = pearson(s0, s3);
    const popcount = (x: number) => {
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    };
    const avalanche = (count: number, flip: (c: number[], key: number[], bit: number) => void, bits: number) => {
      let worst = 0;
      for (let b = 0; b < bits; b++) {
        let flipped = 0;
        for (let i = 0; i < count; i++) {
          const ctr = [i, 0, 0, 0];
          const key = [seed, 0];
          const x = philox4x32R(10, ctr[0]!, ctr[1]!, ctr[2]!, ctr[3]!, key[0]!, key[1]!);
          flip(ctr, key, b);
          const y = philox4x32R(10, ctr[0]!, ctr[1]!, ctr[2]!, ctr[3]!, key[0]!, key[1]!);
          for (let k = 0; k < 4; k++) flipped += popcount((x[k]! ^ y[k]!) >>> 0);
        }
        worst = Math.max(worst, Math.abs(flipped / (count * 128) - 0.5));
      }
      return { worst, bound: a["avalanche_k"] * Math.sqrt(0.25 / (count * 128)) };
    };
    const seedAv = avalanche(a["avalanche_counters"], (_c, key, b) => (key[0] = (key[0]! ^ (1 << b)) >>> 0), 32);
    // Counter bit 0..31 of word 0 are the varying index; flip bits of words 1..3 and the high bits of word 0.
    const ctrAv = avalanche(a["avalanche_counters"] >> 2, (c, _key, b) => (c[b >> 5] = (c[b >> 5]! ^ (1 << (b & 31))) >>> 0), 128);
    return [
      { id: "A1", pass: c1.p >= plo && c1.p <= phi, measured: c1, expected: [plo, phi] },
      { id: "A2", pass: c2.p >= plo && c2.p <= phi, measured: c2, expected: [plo, phi] },
      { id: "A3", pass: Math.abs(corr) <= a["corr_k"] / Math.sqrt(n), measured: corr, expected: a["corr_k"] / Math.sqrt(n) },
      { id: "A4", pass: seedAv.worst <= seedAv.bound, measured: seedAv.worst, expected: seedAv.bound },
      { id: "A5", pass: ctrAv.worst <= ctrAv.bound, measured: ctrAv.worst, expected: ctrAv.bound },
    ];
  },

  bsdf_probe: async (ctx, a) => {
    const albedo = a["albedo"] as Vec3;
    const k = a["k"] as number;
    const r = await probeBsdf(ctx.gpu, { seed: a["seed"], albedo, directions: a["directions"], blocks: a["blocks"], samplesPerBlock: a["samples_per_block"], reciprocityPairs: a["reciprocity_pairs"], histogramSamples: a["histogram_samples"] });
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    let a4 = 0;
    let worstZ = 0;
    r.albedo.forEach((d, i) => {
      for (let c = 0; c < 3; c++) {
        const z = Math.abs(d.mean[c]! - albedo[c]!) / d.se[c]!;
        worstZ = Math.max(worstZ, z);
        if (!(z <= k)) a1++;
        if (!(d.mean[c]! <= 1 + k * d.se[c]!)) a2++;
        const s = r.sampler[i]!;
        if (!(Math.abs(s.mean[c]! - d.mean[c]!) <= k * Math.hypot(s.se[c]!, d.se[c]!))) a4++;
      }
      if (!(Math.abs(d.pdf - 1) <= k * d.pdfSe)) a3++;
    });
    const total = r.histogram.reduce((s, v) => s + v, 0);
    const expected = new Float64Array(HIST_MU * HIST_PHI);
    for (let m = 0; m < HIST_MU; m++) for (let p = 0; p < HIST_PHI; p++) expected[m * HIST_PHI + p] = total * cosineBinProbability(m);
    const chi = chiSquare(r.histogram, expected);
    const id = a["id"];
    return [
      { id: `${id}:A1 albedo`, pass: a1 === 0, measured: { failing: a1, worst_z: worstZ }, expected: `|a - rho| <= ${k} se` },
      { id: `${id}:A2 energy`, pass: a2 === 0, measured: { failing: a2 } },
      { id: `${id}:A3 pdf`, pass: a3 === 0, measured: { failing: a3 } },
      { id: `${id}:A4 sampler`, pass: a4 === 0 && r.maxWeightRelDiff <= 8 * 2 ** -23, measured: { failing_means: a4, max_weight_rel_diff: r.maxWeightRelDiff }, expected: { max_weight_rel_diff: 8 * 2 ** -23 } },
      { id: `${id}:A5 reciprocity`, pass: r.maxReciprocityDiff <= (2 ** -22 * Math.max(...albedo)) / Math.PI, measured: r.maxReciprocityDiff },
      { id: `${id}:A6 support`, pass: r.minF >= 0 && r.minPdf >= 0 && r.supportViolations === 0 && r.outsideHemisphere === 0 && r.zeroPdfSamples === 0 && r.maxLengthError <= 4 * 2 ** -23, measured: { min_f: r.minF, min_pdf: r.minPdf, support: r.supportViolations, outside: r.outsideHemisphere, zero_pdf: r.zeroPdfSamples, len_err: r.maxLengthError } },
      { id: `${id}:A7 chi2`, pass: chi.p >= 1e-4, measured: chi, expected: "p >= 1e-4" },
    ];
  },

  nonfinite_set: (ctx, a) => {
    const out = run(ctx, a["run"]).output;
    const v = out.manifest.deterministic.validators.find((x) => x.name === "nan.image")!;
    const detail = v.detail as { count: number; first: unknown[] };
    const want = a["image"] as unknown[];
    const pass = detail.count === want.length && jsonEqual(detail.first as Json, want as Json) && exitCodeFor(out.manifest) === a["exit_code"];
    return one(a, pass, { reported: detail.first, count: detail.count, exit_code: exitCodeFor(out.manifest) }, { image: want, exit_code: a["exit_code"] });
  },

  nonfinite_first: (ctx, a) => {
    const out = run(ctx, a["run"]).output;
    const v = out.manifest.deterministic.validators.find((x) => x.name === "nan.physics")!;
    const first = (v.detail as { first: unknown[] }).first[0];
    return one(a, jsonEqual(first as Json, a["physics"]) && exitCodeFor(out.manifest) === a["exit_code"], { first, exit_code: exitCodeFor(out.manifest) }, { physics: a["physics"], exit_code: a["exit_code"] });
  },

  validator_fails: (ctx, a) => {
    const out = run(ctx, a["run"]).output;
    const v = out.manifest.deterministic.validators.find((x) => x.name === a["name"]);
    return one(a, v !== undefined && !v.pass && exitCodeFor(out.manifest) === a["exit_code"], { pass: v?.pass, exit_code: exitCodeFor(out.manifest) }, { pass: false, exit_code: a["exit_code"] });
  },

  expect_fail: async (ctx, a) => {
    const inner = await evaluate(ctx, { ...a["inner"], id: `${a["id"]}:inner` });
    return one(a, inner.some((r) => !r.pass), inner.map((r) => ({ pass: r.pass, measured: r.measured })), "inner assertion fails");
  },

  traj_closed_form: (ctx, a) => physicsCheck(ctx, a, "trajectory"),
  ke_bounded: (ctx, a) => physicsCheck(ctx, a, "ke"),
  energy_drift: (ctx, a) => physicsCheck(ctx, a, "drift"),
  discretization_error: (ctx, a) => physicsCheck(ctx, a, "discretization"),

  dt_halving: (ctx, a) => {
    const errs = (a["runs"] as string[]).map((n) => {
      const r = run(ctx, n);
      const p = r.loaded.scene.physics!;
      const i = r.output.physics!.ids.indexOf(a["body"]);
      const last = r.output.physics!.records.at(-1)!;
      const s = decodeBodies(last.raw)[i]!;
      const body = dynamicBodies(r.loaded.scene)[i]![1];
      const t = last.step * p.dt_s;
      const z = body.center_m[2] + body.body.velocity_m_s[2] * t + 0.5 * p.gravity_m_s2[2] * t * t;
      return Math.abs(s.x_m[2] - z);
    });
    const ratio = errs[0]! / errs[1]!;
    const [lo, hi] = a["ratio"] as [number, number];
    return one(a, ratio >= lo && ratio <= hi, { errors: errs, ratio }, [lo, hi]);
  },

  traj_bits_equal: (ctx, a) => {
    const r = run(ctx, a["run"]).output.physics!;
    const [i, j] = (a["bodies"] as string[]).map((b) => r.ids.indexOf(b)) as [number, number];
    let bad = 0;
    for (const rec of r.records) {
      const w = new Uint32Array(rec.raw.buffer.slice(rec.raw.byteOffset, rec.raw.byteOffset + rec.raw.byteLength));
      for (let k = 0; k < 12; k++) if (k !== 7 && w[i * 12 + k] !== w[j * 12 + k]) bad++; // word 7 is inv_mass
    }
    return one(a, bad === 0, { differing_words: bad, records: r.records.length });
  },

  patch_rejects: (ctx, a) => {
    const base = loadSceneText(readFileSync(join(ctx.dir, a["base"]), "utf8"));
    const before = jcs(base.scene);
    return (a["cases"] as Params[]).map((c) => {
      let got: unknown = "accepted";
      try {
        applyScenePatch(base, { v: 1, base_scene_hash: c["base_scene_hash"] ?? base.scene_hash, ops: c["ops"] } as unknown as Json);
      } catch (err) {
        if (!(err instanceof ContractViolation)) throw err;
        const e = err.errors[0]!;
        got = { code: e.code, path: e.path, ...(e.op_index !== undefined ? { op_index: e.op_index } : {}), ...(e.cause ? { cause: e.cause.map((x) => `${x.code}@${x.path}`) } : {}) };
      }
      return { id: `${a["id"]}:${c["name"]}`, pass: jsonEqual(got as Json, c["expect"]) && jcs(base.scene) === before, measured: got, expected: c["expect"] };
    });
  },

  json_patch_conformance: (ctx, a) => {
    let failures = 0;
    let ran = 0;
    for (const f of a["files"] as string[]) {
      for (const c of JSON.parse(readFileSync(join(ctx.root, f), "utf8")) as Params[]) {
        if (c["disabled"]) continue;
        ran++;
        try {
          const outDoc = applyJsonPatch(c["doc"], c["patch"] as PatchOp[]);
          if (c["error"] !== undefined || (c["expected"] !== undefined && !jsonEqual(outDoc, c["expected"]))) failures++;
        } catch (err) {
          if (!(err instanceof ContractViolation) || c["error"] === undefined) failures++;
        }
      }
    }
    return one(a, failures === 0 && ran > 0, { ran, failures });
  },

  schema_lint: (_ctx, a) => {
    const v = lintSchema(sceneSchema);
    return one(a, v.length === 0, v);
  },

  golden_scenes_valid: (ctx, a) => {
    const failures: unknown[] = [];
    let count = 0;
    const p0 = join(ctx.root, "golden", "p0");
    for (const g of readdirSync(p0, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const oracle = JSON.parse(readFileSync(join(p0, g, "oracle.json"), "utf8")) as { runs: { scene: string }[] };
      for (const s of new Set(oracle.runs.map((r) => r.scene))) {
        count++;
        try {
          loadSceneText(readFileSync(join(p0, g, s), "utf8"));
        } catch (err) {
          failures.push({ scene: `${g}/${s}`, errors: err instanceof ContractViolation ? err.errors : String(err) });
        }
      }
    }
    return one(a, failures.length === 0 && count > 0, { scenes: count, failures });
  },

  reject_corpus: (ctx, a) =>
    (a["cases"] as Params[]).map((c) => {
      let got: unknown = "accepted";
      try {
        loadSceneText(readFileSync(join(ctx.dir, c["file"]), "utf8"));
      } catch (err) {
        if (!(err instanceof ContractViolation)) got = `crash: ${String(err)}`;
        else got = err.errors.map((e) => ({ code: e.code, path: e.path }));
      }
      return { id: `${a["id"]}:${c["file"]}`, pass: jsonEqual(got as Json, c["expect"]), measured: got, expected: c["expect"] };
    }),

  schema_fuzz: (_ctx, a) => {
    const h = new HarnessRng(a["seed"], 0x20);
    let accepted = 0;
    let rejected = 0;
    let unsound = 0;
    const crashes: string[] = [];
    const codes = new Map<string, number>();
    for (let i = 0; i < a["n"]; i++) {
      const s = sampleScene(h);
      // The sampler draws inside the schema; a schema error here means sampler and schema disagree.
      if (validateSceneSchema(s).length > 0) unsound++;
      try {
        loadSceneValue(s);
        accepted++;
      } catch (err) {
        if (err instanceof ContractViolation) {
          rejected++;
          for (const e of err.errors) codes.set(e.code, (codes.get(e.code) ?? 0) + 1);
        } else if (crashes.length < 5) {
          crashes.push(String(err));
        }
      }
    }
    return one(a, crashes.length === 0 && unsound === 0, { accepted, rejected, outside_schema: unsound, codes: Object.fromEntries([...codes].sort()), crashes });
  },
};

// ---------------------------------------------------------------------------------------------
// Physics checks against the semi-implicit Euler closed form (golden G16-G18).

function ulpF32(v: number): number {
  if (v === 0) return 0;
  return 2 ** (Math.floor(Math.log2(Math.abs(v))) - 23);
}

function physicsCheck(ctx: Context, a: Params, mode: "trajectory" | "ke" | "drift" | "discretization"): Result[] {
  const r = run(ctx, a["run"]);
  const p = r.loaded.scene.physics!;
  const g = p.gravity_m_s2;
  const gn = norm(g);
  const dt = p.dt_s;
  const q = 2 ** -32;
  const bodies = dynamicBodies(r.loaded.scene);
  const only = a["body"] as string | undefined;
  let worst = 0;
  let bad = 0;
  const notes: unknown[] = [];
  for (const rec of r.output.physics!.records) {
    const n = rec.step;
    const states = decodeBodies(rec.raw);
    bodies.forEach(([id, s], i) => {
      if (only !== undefined && id !== only) return;
      const x0 = s.center_m;
      const v0 = s.body.velocity_m_s;
      const m = s.body.mass_kg;
      const V = norm(v0) + gn * dt * p.steps;
      const tauV = 2 * n * ulpF32(V);
      const tauX = n * q + n * ulpF32(V * dt) + n * n * dt * ulpF32(V);
      const st = states[i]!;
      const xHat = [0, 1, 2].map((c) => x0[c]! + n * dt * v0[c]! + dt * dt * g[c]! * ((n * (n + 1)) / 2)) as Vec3;
      const vHat = [0, 1, 2].map((c) => v0[c]! + n * dt * g[c]!) as Vec3;
      let err = 0;
      let bound = 0;
      if (mode === "trajectory") {
        const ex = Math.max(...[0, 1, 2].map((c) => Math.abs(st.x_m[c]! - xHat[c]!)));
        const ev = Math.max(...[0, 1, 2].map((c) => Math.abs(st.v_m_s[c]! - vHat[c]!)));
        if (!(ex <= tauX) || !(ev <= tauV)) bad++;
        err = Math.max(ex / (tauX || 1), ev / (tauV || 1));
        bound = 1;
        if (n === p.steps) notes.push({ body: id, x_error: ex, tau_x: tauX, v_error: ev, tau_v: tauV });
      } else if (mode === "discretization") {
        const t = n * dt;
        const ex = Math.max(...[0, 1, 2].map((c) => Math.abs(st.x_m[c]! - (x0[c]! + v0[c]! * t + 0.5 * g[c]! * t * t) - (g[c]! * dt * t) / 2)));
        err = ex;
        bound = tauX;
        if (!(ex <= tauX)) bad++;
        if (n === p.steps) notes.push({ body: id, residual: ex, tau_x: tauX });
      } else {
        const perMass = (x: Vec3, v: Vec3) => 0.5 * dot(v, v) - dot(g, x);
        const tauE = V * tauV + gn * tauX;
        if (mode === "drift") {
          const pred = perMass(x0, v0) - n * 0.5 * gn * gn * dt * dt;
          err = Math.abs(perMass(st.x_m, st.v_m_s) - pred);
          bound = tauE;
          if (n === p.steps) notes.push({ body: id, drift: perMass(st.x_m, st.v_m_s) - perMass(x0, v0), predicted: -n * 0.5 * gn * gn * dt * dt, residual: err, tau_e: tauE });
        } else {
          const ke = 0.5 * m * dot(st.v_m_s, st.v_m_s);
          const ke0 = 0.5 * m * dot(v0, v0);
          const work = m * dot(g, [st.x_m[0] - x0[0], st.x_m[1] - x0[1], st.x_m[2] - x0[2]]);
          err = ke - ke0 - work;
          bound = m * tauE;
          if (n === p.steps) notes.push({ body: id, excess: err, bound });
        }
        if (!(err <= bound)) bad++;
      }
      worst = Math.max(worst, bound > 0 ? err / bound : err === 0 ? 0 : Infinity);
    });
  }
  return one(a, bad === 0, { failing: bad, worst_ratio_to_tolerance: worst, final: notes });
}

export async function evaluate(ctx: Context, a: Params): Promise<Result[]> {
  const kind = KINDS[a["kind"]];
  if (kind === undefined) throw new Error(`unknown assertion kind ${a["kind"]}`);
  return kind(ctx, a);
}
