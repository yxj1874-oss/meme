// Assertion kinds used by golden/<set>/*/oracle.json. Every kind returns one or more results with the
// measured value next to the expectation, so a failing oracle says by how much it failed.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ContractViolation } from "../core/errors.ts";
import { jcs } from "../core/jcs.ts";
import type { Json } from "../core/json_strict.ts";
import { applyJsonPatch, applyScenePatch, jsonEqual, type PatchOp } from "../core/patch.ts";
import { HarnessRng, philox4x32R, rng4, toUnitFloat } from "../core/rng.ts";
import { type LoadedScene, loadSceneText, loadSceneValue } from "../core/scene.ts";
import { parseStrict as parseStrictText } from "../core/json_strict.ts";
import type { Scene, Vec3 } from "../core/scene_types.ts";
import { declaredVersion, sceneSchema, validateSceneSchema } from "../core/schema.ts";
import { dot, luminanceY, norm } from "../core/vec.ts";
import type { Gpu } from "../gpu/device.ts";
import { decodePngStored } from "../io/png.ts";
import { decodeBodies, dynamicBodies } from "../runtime/physics.ts";
import { ID_NONE } from "../runtime/render.ts";
import { exitCodeFor, type RunOutput } from "../runtime/run.ts";
import { compareRuns, determinismCheck } from "../tools/determinism.ts";
import { allGoldens } from "../tools/golden_sets.ts";
import { PHILOX_KAT } from "./kat.ts";
import { cosineBinProbability, HIST_MU, HIST_PHI, probeBsdf, probeMaterial, type RngCase, rngCrossCheck } from "./probes.ts";
import { histogramExpectation, materialAlbedo, type RefMaterial } from "./ref_bsdf.ts";
import { deltaReflection, pointLightDirect, replay, type ReplayImage, type SampleValue, sphereLightPlane } from "./replay.ts";
import { migrateToLatest, rollbackTo } from "../core/migrate.ts";
import { DEFAULT_PLAN } from "../runtime/plan.ts";
import { runScene } from "../runtime/run.ts";
import { fingerprint, substrateId } from "../gpu/substrate.ts";
import { DEFAULT_CANDIDATES, kelemenTableBytes, type RenderCandidates } from "../runtime/render.ts";
import { sampleScene } from "./schema_sampler.ts";
import { lintSchema } from "./schema_lint.ts";
import { bound, type Context, type Kind, one, type Params, type Result, type Run, run } from "./assert_util.ts";
import { P2_KINDS } from "./physics_assertions.ts";
import { chiSquare, olsSlope, pearson } from "./stats.ts";

export type { Context, Result, Run } from "./assert_util.ts";

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
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    let bound: number;
    if (a["sigma"]?.["from_m2"]) {
      // Per-pixel variances from the second moment: the image mean's standard error.
      const res = r.output.render!;
      const mk = mask(r, a["mask"]);
      let v = 0;
      for (let p = 0; p < mk.length; p++) if (mk[p]) v += pixelVariance(res, p, 0) / N;
      bound = (a["k"] * Math.sqrt(v)) / vals.length;
    } else {
      bound = (a["k"] * value(a["sigma"])) / Math.sqrt(vals.length * N);
    }
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
    let rmse: number[];
    let sigma: number;
    if (a["expect"]?.["replay"]) {
      // Per-pixel expectations from the f64 replay; sigma from the per-pixel variance of one run.
      rmse = names.map((n) => {
        const rep = replayed(ctx, a["expect"]["replay"], n);
        const res = run(ctx, n).output.render!;
        const px = usable(ctx, n, a["mask"], rep);
        return Math.sqrt(px.reduce((s, p) => s + (res.mean[p * 3]! - rep.expected[p * 3]!) ** 2, 0) / px.length);
      });
      // Light-transport noise of one sample: the reference run's per-sample variance minus the
      // anti-aliasing variance of the replayed expectations across the same pixel's samples.
      const refName = a["sigma"]["from_run_m2"] as string;
      const ref = run(ctx, refName).output.render!;
      const refRep = replayed(ctx, a["expect"]["replay"], refName);
      const px = usable(ctx, refName, a["mask"], refRep);
      const v = px.reduce((s, p) => s + Math.max(0, pixelVariance(ref, p, 0) - refRep.jitterVar[p * 3]!), 0);
      sigma = Math.sqrt(v / px.length);
    } else {
      const mu = value(a["expect"]);
      sigma = value(a["sigma"]);
      rmse = names.map((n) => {
        const v = masked(run(ctx, n), a["mask"], 0);
        return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length);
      });
    }
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
      { id: `${id}:A4 sampler`, pass: a4 === 0 && r.maxWeightRelDiff <= bound(a, "weight_rel"), measured: { failing_means: a4, max_weight_rel_diff: r.maxWeightRelDiff }, expected: { max_weight_rel_diff: bound(a, "weight_rel") } },
      { id: `${id}:A5 reciprocity`, pass: r.maxReciprocityDiff <= (bound(a, "reciprocity_per_max_f") * Math.max(...albedo)) / Math.PI, measured: r.maxReciprocityDiff },
      { id: `${id}:A6 support`, pass: r.minF >= 0 && r.minPdf >= 0 && r.supportViolations === 0 && r.outsideHemisphere === 0 && r.zeroPdfSamples === 0 && r.maxLengthError <= bound(a, "length"), measured: { min_f: r.minF, min_pdf: r.minPdf, support: r.supportViolations, outside: r.outsideHemisphere, zero_pdf: r.zeroPdfSamples, len_err: r.maxLengthError } },
      { id: `${id}:A7 chi2`, pass: chi.p >= bound(a, "chi2_p"), measured: chi, expected: `p >= ${bound(a, "chi2_p")}` },
    ];
  },

  // G24: the P1 material against an f64 reference. Albedo through the material's own sampler
  // (importance sampled, so low-roughness lobes do not produce the heavy tails a uniform estimator
  // has) must match the quadrature reference; everything else as in G12.
  material_probe: async (ctx, a) => {
    const material = a["material"] as { base_color: Vec3; metallic: number; roughness: number; ior: number };
    const k = a["k"] as number;
    const candidates = (a["candidates"] ?? {}) as { COUPLING?: number; GGX_SAMPLER?: number };
    const cfg = {
      seed: a["seed"], material, directions: a["directions"], blocks: a["blocks"], samplesPerBlock: a["samples_per_block"],
      reciprocityPairs: a["reciprocity_pairs"], histogramSamples: a["histogram_samples"], histogramWo: a["histogram_wo"], candidates,
    };
    const r = await probeMaterial(ctx.gpu, cfg);
    const table = new Float32Array(kelemenTableBytes().slice().buffer);
    const ref: RefMaterial = { albedo: material.base_color, metallic: material.metallic, alpha: material.roughness ** 2, ior: material.ior };
    const floor = bound(a, "albedo_floor");
    const albedoChecks = (res: typeof r) => {
      let failing = 0;
      let worstZ = 0;
      let energy = 0;
      let maxAlbedo = 0;
      res.sampler.forEach((s, i) => {
        const want = materialAlbedo(ref, res.albedo[i]!.mu, candidates.COUPLING ?? DEFAULT_CANDIDATES.COUPLING, table);
        for (let c = 0; c < 3; c++) {
          const diff = Math.abs(s.mean[c]! - want[c]!);
          const z = diff / Math.max(s.seRobust[c]!, 1e-12);
          worstZ = Math.max(worstZ, Math.min(z, (k * diff) / floor));
          if (!(diff <= Math.max(k * s.seRobust[c]!, floor))) failing++;
          if (!(s.mean[c]! <= 1 + k * s.seRobust[c]!)) energy++;
          maxAlbedo = Math.max(maxAlbedo, s.mean[c]!);
        }
      });
      return { failing, worst_z: worstZ, energy, max_albedo: maxAlbedo };
    };
    // Sampler weights of glossy coats are heavy-tailed: a direction that draws none of its rare large
    // weights reads low with a small sample se (G24 coat_r06, seed 2404: z = -5.55 at 16 384 samples,
    // -0.52 at 16x). Any k-sigma exceedance is therefore re-measured with retest_factor times the
    // samples (the first blocks included, so it is deterministic); a bias grows by sqrt(factor) in z,
    // an outlier shrinks by it. The verdict is the retest's.
    const first = albedoChecks(r);
    let final = first;
    let retest: ReturnType<typeof albedoChecks> | undefined;
    if (first.failing > 0 || first.energy > 0) {
      retest = albedoChecks(await probeMaterial(ctx.gpu, { ...cfg, blocks: cfg.blocks * bound(a, "retest_factor") }));
      final = retest;
    }
    const failing = final.failing;
    const energy = final.energy;
    const worstZ = final.worst_z;
    const maxAlbedo = final.max_albedo;
    const stage = (firstStage: object) => (retest ? { first: firstStage, retest_factor: bound(a, "retest_factor") } : {});
    const total = r.histogram.reduce((x, v) => x + v, 0);
    const shares = histogramExpectation(ref, a["histogram_wo"], HIST_MU, HIST_PHI, candidates.GGX_SAMPLER ?? DEFAULT_CANDIDATES.GGX_SAMPLER);
    const chi = chiSquare(r.histogram, shares.map((p) => p * total));
    const weightTol = bound(a, "weight_rel");
    const id = a["id"];
    return [
      { id: `${id}:A1 albedo vs f64 reference`, pass: failing === 0, measured: { failing, worst_z: worstZ, ...stage({ failing: first.failing, worst_z: first.worst_z }) }, expected: `|E[w] - E_ref| <= max(${k} se_robust, ${floor})` },
      { id: `${id}:A2 energy`, pass: energy === 0, measured: { failing: energy, max_albedo: maxAlbedo, ...stage({ failing: first.energy, max_albedo: first.max_albedo }) }, expected: `E[w] <= 1 + ${k} se_robust` },
      { id: `${id}:A3 sampler weight`, pass: r.maxWeightRelDiff <= weightTol, measured: r.maxWeightRelDiff, expected: weightTol },
      { id: `${id}:A4 reciprocity`, pass: r.maxReciprocityRel <= bound(a, "reciprocity_rel"), measured: r.maxReciprocityRel, expected: bound(a, "reciprocity_rel") },
      { id: `${id}:A5 support`, pass: r.minF >= 0 && r.supportViolations === 0 && r.zeroPdfSamples === 0 && r.maxLengthError <= bound(a, "length"), measured: { min_f: r.minF, support: r.supportViolations, zero_pdf: r.zeroPdfSamples, len_err: r.maxLengthError }, expected: { len_err: bound(a, "length") } },
      { id: `${id}:A6 chi2`, pass: chi.p >= bound(a, "chi2_p"), measured: chi, expected: `p >= ${bound(a, "chi2_p")}` },
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
    for (const g of allGoldens(join(ctx.root, "golden"))) {
      const oracle = JSON.parse(readFileSync(join(g.dir, "oracle.json"), "utf8")) as { runs: { scene: string }[] };
      for (const s of new Set(oracle.runs.map((r) => r.scene))) {
        count++;
        try {
          loadSceneText(readFileSync(join(g.dir, s), "utf8"));
        } catch (err) {
          failures.push({ scene: `${g.set}/${g.id}/${s}`, errors: err instanceof ContractViolation ? err.errors : String(err) });
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
// P1: replay-based and multi-strategy checks (goldens G21-G33).

/** GGX conductor with F0 = base_color under a constant environment: E(mu) per channel, interpolated. */
function ggxFurnace(scene: Scene): SampleValue {
  const sphereMat = Object.values(scene.objects).find((o) => o.shape === "sphere")!.material;
  const m = scene.materials[sphereMat]!;
  const ref: RefMaterial = { albedo: m.base_color, metallic: m.metallic ?? 0, alpha: (m.roughness ?? 1) ** 2, ior: m.ior ?? 1 };
  const table = new Float32Array(kelemenTableBytes().slice().buffer);
  const N = 128;
  const grid = Array.from({ length: N + 1 }, (_, i) => materialAlbedo(ref, i / N, 0, table));
  return (ctx, d, hit) => {
    const env = ctx.environment(d);
    if (hit === null || env === "fragile") return env;
    const mu = Math.min(1, Math.max(0, -dot(d, hit.n)));
    const t = mu * N;
    const i = Math.min(N - 1, Math.floor(t));
    const f = t - i;
    const L = ctx.environment(hit.n);
    if (L === "fragile") return "fragile";
    return [0, 1, 2].map((c) => (grid[i]![c]! * (1 - f) + grid[i + 1]![c]! * f) * L[c]!) as Vec3;
  };
}

function replayed(ctx: Context, name: string, runName: string): ReplayImage {
  const r = run(ctx, runName);
  const cache = (ctx as Context & { replays?: Map<string, ReplayImage> }).replays ?? new Map<string, ReplayImage>();
  (ctx as Context & { replays?: Map<string, ReplayImage> }).replays = cache;
  const key = `${name}@${r.loaded.scene_hash}`;
  if (!cache.has(key)) {
    const scene = r.loaded.scene;
    const fn: SampleValue = name === "delta_reflection" ? deltaReflection : name === "point_light_direct" ? pointLightDirect : name === "sphere_light_plane" ? sphereLightPlane : name === "ggx_furnace" ? ggxFurnace(scene) : (() => {
      throw new Error(`unknown replay ${name}`);
    })();
    cache.set(key, replay(scene, fn));
  }
  return cache.get(key)!;
}

/** Pixels in the mask whose replay is not fragile. */
function usable(ctx: Context, runName: string, m: Params | undefined, rep: ReplayImage): number[] {
  const mk = m ? mask(run(ctx, runName), m) : new Uint8Array(rep.width * rep.height).fill(1);
  const out: number[] = [];
  for (let p = 0; p < mk.length; p++) if (mk[p] && !rep.fragile[p]) out.push(p);
  return out;
}

function pixelVariance(res: NonNullable<RunOutput["render"]>, p: number, c: number): number {
  const N = res.spp;
  const mean = res.mean[p * 3 + c]!;
  return N > 1 ? (Math.max(0, res.m2[p * 3 + c]! - mean * mean) * N) / (N - 1) : 0;
}

const P1_KINDS: Record<string, Kind> = {
  // Deterministic paths: every usable pixel within abs + rel * |expected| of the f64 replay.
  replay_exact: (ctx, a) => {
    const rep = replayed(ctx, a["replay"], a["run"]);
    const res = run(ctx, a["run"]).output.render!;
    const pixels = usable(ctx, a["run"], a["mask"], rep);
    const abs = a["tol"]["value"] as number;
    const rel = (a["rel"] as number | undefined) ?? 0;
    let bad = 0;
    let worst = 0;
    for (const p of pixels) {
      for (let c = 0; c < 3; c++) {
        const e = rep.expected[p * 3 + c]!;
        const err = Math.abs(res.mean[p * 3 + c]! - e);
        worst = Math.max(worst, err / (abs + rel * Math.abs(e)));
        if (!(err <= abs + rel * Math.abs(e))) bad++;
      }
    }
    const minPixels = (a["min_pixels"] as number | undefined) ?? 16;
    return one(a, bad === 0 && pixels.length >= minPixels, { pixels: pixels.length, fragile: rep.fragile.reduce((n, f) => n + f, 0), failing: bad, worst_ratio_to_tolerance: worst }, { abs, rel, min_pixels: minPixels });
  },

  // Stochastic paths: in each of `groups` groups of pixels (sorted by expected luminance),
  // |mean(I - E)| <= k * sqrt(sum var_p / N) / n.
  replay_stat: (ctx, a) => {
    const rep = replayed(ctx, a["replay"], a["run"]);
    const res = run(ctx, a["run"]).output.render!;
    const pixels = usable(ctx, a["run"], a["mask"], rep);
    const lum = (p: number) => 0.2126 * rep.expected[p * 3]! + 0.7152 * rep.expected[p * 3 + 1]! + 0.0722 * rep.expected[p * 3 + 2]!;
    const sorted = [...pixels].sort((x, y) => lum(x) - lum(y) || x - y);
    const groups = (a["groups"] as number | undefined) ?? 1;
    const k = a["k"] as number;
    let worst = 0;
    let bad = 0;
    const detail: unknown[] = [];
    for (let g = 0; g < groups; g++) {
      const part = sorted.slice(Math.floor((g * sorted.length) / groups), Math.floor(((g + 1) * sorted.length) / groups));
      for (let c = 0; c < 3; c++) {
        let diff = 0;
        let v = 0;
        for (const p of part) {
          diff += res.mean[p * 3 + c]! - rep.expected[p * 3 + c]!;
          // The expectation is conditioned on the sample positions: only light-transport noise remains.
          v += Math.max(0, pixelVariance(res, p, c) - rep.jitterVar[p * 3 + c]!) / res.spp;
        }
        const z = v > 0 ? Math.abs(diff) / Math.sqrt(v) : diff === 0 ? 0 : Infinity;
        worst = Math.max(worst, z);
        if (!(z <= k)) {
          bad++;
          detail.push({ group: g, channel: c, z, mean_diff: diff / part.length });
        }
      }
    }
    return one(a, bad === 0 && pixels.length >= groups * 8, { pixels: pixels.length, worst_z: worst, failing: detail }, { k, groups });
  },

  // Unbiasedness across estimators: pairwise aggregate z over the masked pixels.
  strategies_agree: (ctx, a) => {
    const names = a["runs"] as string[];
    const k = a["k"] as number;
    const mk = mask(run(ctx, names[0]!), a["mask"]);
    const results: Result[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const A = run(ctx, names[i]!).output.render!;
        const B = run(ctx, names[j]!).output.render!;
        let worst = 0;
        for (let c = 0; c < 3; c++) {
          let diff = 0;
          let v = 0;
          for (let p = 0; p < mk.length; p++) {
            if (!mk[p]) continue;
            diff += A.mean[p * 3 + c]! - B.mean[p * 3 + c]!;
            v += pixelVariance(A, p, c) / A.spp + pixelVariance(B, p, c) / B.spp;
          }
          worst = Math.max(worst, v > 0 ? Math.abs(diff) / Math.sqrt(v) : diff === 0 ? 0 : Infinity);
        }
        results.push({ id: `${a["id"]}:${names[i]}~${names[j]}`, pass: worst <= k, measured: { z: worst }, expected: { k } });
      }
    }
    return results;
  },

  // Veach 1997, Theorem 9.2: the balance heuristic's per-sample variance is at most that of any
  // other weighting of the same samples (in particular BSDF-only or light-only) plus
  // (1/min n_i - 1/sum n_i) mu^2 = mu^2 / 2 for one sample of each technique.
  mis_variance_bound: (ctx, a) => {
    const bal = run(ctx, a["balance"]).output.render!;
    const bsdf = run(ctx, a["bsdf"]).output.render!;
    const nee = run(ctx, a["nee"]).output.render!;
    const mk = mask(run(ctx, a["balance"]), a["mask"]);
    let lhs = 0;
    let rhs = 0;
    let P = 0;
    for (let p = 0; p < mk.length; p++) {
      if (!mk[p]) continue;
      P++;
      for (let c = 0; c < 3; c++) {
        const mu = bal.mean[p * 3 + c]!;
        lhs += pixelVariance(bal, p, c);
        rhs += Math.min(pixelVariance(bsdf, p, c), pixelVariance(nee, p, c)) + (mu * mu) / 2;
      }
    }
    const slack = 1 + a["k"] * Math.sqrt(2 / ((bal.spp - 1) * Math.max(1, P * 3)));
    return one(a, lhs <= rhs * slack && P > 0, { sum_var_balance: lhs, bound: rhs, ratio: lhs / rhs }, { slack });
  },

  // Roughness -> 0 continuity: mean |I_alpha - I_delta| decreases with alpha and the last is at
  // most ratio_max of the first.
  roughness_limit: (ctx, a) => {
    const delta = run(ctx, a["delta"]).output.render!;
    const mk = mask(run(ctx, a["delta"]), a["mask"]);
    const d = (a["runs"] as string[]).map((n) => {
      const res = run(ctx, n).output.render!;
      let s = 0;
      let cnt = 0;
      for (let p = 0; p < mk.length; p++) {
        if (!mk[p]) continue;
        for (let c = 0; c < 3; c++) {
          s += Math.abs(res.mean[p * 3 + c]! - delta.mean[p * 3 + c]!);
          cnt++;
        }
      }
      return s / Math.max(1, cnt);
    });
    const monotone = d.every((x, i) => i === 0 || x < d[i - 1]!);
    return one(a, monotone && d.at(-1)! <= a["ratio_max"] * d[0]!, { mean_abs_diff: d }, { decreasing: true, last_over_first: `<= ${a["ratio_max"]}` });
  },

  // G32: every p0 run, executed by today's runtime, reproduces the P0 image, AOV and state bytes.
  p0_byte_identity: async (ctx, a) => {
    const snap = JSON.parse(readFileSync(join(ctx.dir, a["snapshot"]), "utf8")) as { substrate_id: string; goldens: Record<string, Record<string, Record<string, string>>> };
    const substrate = await fingerprint(ctx.gpu);
    const sid = substrateId(substrate);
    if (sid !== snap.substrate_id) return one(a, false, { skipped: `snapshot recorded on ${snap.substrate_id}; this is ${sid}` });
    const diffs: unknown[] = [];
    let files = 0;
    const sets = (a["sets"] as string[] | undefined) ?? ["p0"];
    for (const g of allGoldens(join(ctx.root, "golden")).filter((x) => sets.includes(x.set))) {
      const oracle = JSON.parse(readFileSync(join(g.dir, "oracle.json"), "utf8")) as { runs: { name: string; scene: string; plan?: object; faults?: object; patches?: string[]; candidates?: RenderCandidates }[] };
      for (const spec of oracle.runs) {
        const want = snap.goldens[g.id]?.[spec.name];
        if (want === undefined) continue;
        let loaded = loadSceneText(readFileSync(join(g.dir, spec.scene), "utf8"));
        for (const pth of spec.patches ?? []) loaded = applyScenePatch(loaded, { v: 1, base_scene_hash: loaded.scene_hash, ops: JSON.parse(readFileSync(join(g.dir, pth), "utf8")) } as unknown as Json);
        const out = await runScene(ctx.gpu, loaded, substrate, { plan: { ...DEFAULT_PLAN, ...(spec.plan ?? {}) }, ...(spec.faults ?? {}), ...(spec.candidates ? { candidates: spec.candidates } : {}) });
        for (const [file, hash] of Object.entries(want)) {
          files++;
          if (out.manifest.deterministic.outputs[file] !== hash) diffs.push({ golden: g.id, run: spec.name, file });
        }
      }
    }
    return one(a, diffs.length === 0 && files > 0, { files_compared: files, differing: diffs.slice(0, 20) });
  },

  // Every scene of the named sets, from the version it declares: migrate -> rollback -> migrate is the identity.
  migration_roundtrip: (ctx, a) => {
    const failures: unknown[] = [];
    let count = 0;
    const sets = (a["sets"] as string[] | undefined) ?? ["p0"];
    for (const g of allGoldens(join(ctx.root, "golden")).filter((x) => sets.includes(x.set))) {
      const oracle = JSON.parse(readFileSync(join(g.dir, "oracle.json"), "utf8")) as { runs: { scene: string }[] };
      for (const s of new Set(oracle.runs.map((r) => r.scene))) {
        count++;
        const scene = parseStrictText(readFileSync(join(g.dir, s), "utf8"));
        const v = declaredVersion(scene);
        const up = migrateToLatest(scene, v).scene;
        const again = migrateToLatest(rollbackTo(up, v), v).scene;
        if (jcs(up) !== jcs(again)) failures.push(`${g.id}/${s}`);
      }
    }
    return one(a, failures.length === 0 && count > 0, { scenes: count, failures });
  },

  rollback_lossy: (ctx, a) =>
    (a["cases"] as Params[]).map((c) => {
      const loaded = loadSceneText(readFileSync(join(ctx.dir, c["file"]), "utf8"));
      let got: unknown = "lossless";
      try {
        rollbackTo(loaded.scene as unknown as Json, (a["to_version"] as number | undefined) ?? 1);
      } catch (err) {
        if (!(err instanceof ContractViolation)) throw err;
        got = err.errors.map((e) => `${e.code}@${e.path}`);
      }
      return { id: `${a["id"]}:${c["file"]}`, pass: jsonEqual(got as Json, c["expect"]), measured: got, expected: c["expect"] };
    }),
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
  const kind = KINDS[a["kind"]] ?? P1_KINDS[a["kind"]] ?? P2_KINDS[a["kind"]];
  if (kind === undefined) throw new Error(`unknown assertion kind ${a["kind"]}`);
  return kind(ctx, a);
}
