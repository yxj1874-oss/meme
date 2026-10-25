// GPU probes used by oracles: the RNG cross-check (G04) and the BSDF probe (G12).

import { HarnessRng, rng4, toUnitFloat } from "../core/rng.ts";
import type { Vec3 } from "../core/scene_types.ts";
import type { Material } from "../core/scene_types.ts";
import { bindGroupAt, dispatch, type Gpu } from "../gpu/device.ts";
import { kernelSource } from "../gpu/kernels.ts";
import { kelemenTableBytes, packMaterial } from "../runtime/render.ts";

export interface RngCase {
  seed: number;
  stream: number;
  ctr: [number, number, number, number];
}

export interface RngCheckResult {
  cases: number;
  word_mismatches: number;
  unit_mismatches: number;
  unit_out_of_range: number;
  unit_max: number;
  first_mismatch: RngCase | null;
}

/** G04 A2/A3: WGSL rng4 and to_unit_float against src/core/rng.ts, bit for bit. */
export async function rngCrossCheck(gpu: Gpu, cases: RngCase[]): Promise<RngCheckResult> {
  const input = new Uint32Array(cases.length * 8);
  cases.forEach((c, i) => input.set([...c.ctr, c.seed, c.stream, 0, 0], i * 8));
  const U = GPUBufferUsage;
  const inBuf = gpu.bufferWith(input, U.STORAGE, "rng inputs");
  const outBuf = gpu.buffer(cases.length * 16, U.STORAGE | U.COPY_SRC, "rng outputs");
  const unitBuf = gpu.buffer(cases.length * 16, U.STORAGE | U.COPY_SRC, "rng unit bits");
  const pipeline = await gpu.pipeline(kernelSource("rng_check"), "rng_check");
  dispatch(gpu, pipeline, bindGroupAt(gpu, pipeline, [[0, inBuf], [1, outBuf], [2, unitBuf]]), Math.ceil(cases.length / 64));
  const words = new Uint32Array(await gpu.read(outBuf, cases.length * 16));
  const unitBits = new Uint32Array(await gpu.read(unitBuf, cases.length * 16));
  const unit = new Float32Array(unitBits.buffer);
  for (const b of [inBuf, outBuf, unitBuf]) gpu.release(b);

  let wordMismatches = 0;
  let unitMismatches = 0;
  let outOfRange = 0;
  let unitMax = 0;
  let first: RngCase | null = null;
  const f = new Float32Array(1);
  const fu = new Uint32Array(f.buffer);
  cases.forEach((c, i) => {
    const ref = rng4(c.seed, c.stream, ...c.ctr);
    for (let k = 0; k < 4; k++) {
      if (words[i * 4 + k] !== ref[k]) {
        wordMismatches++;
        first ??= c;
      }
      f[0] = toUnitFloat(ref[k]!);
      if (unitBits[i * 4 + k] !== fu[0]) unitMismatches++;
      const x = unit[i * 4 + k]!;
      if (!(x >= 0 && x < 1)) outOfRange++;
      unitMax = Math.max(unitMax, x);
    }
  });
  return { cases: cases.length, word_mismatches: wordMismatches, unit_mismatches: unitMismatches, unit_out_of_range: outOfRange, unit_max: unitMax, first_mismatch: first };
}

export interface BsdfProbeConfig {
  seed: number;
  albedo: Vec3;
  directions: number;
  blocks: number;
  samplesPerBlock: number;
  reciprocityPairs: number;
  histogramSamples: number;
}

export interface BsdfProbeResult {
  /** Per direction: albedo estimate, its standard error (rgb), pdf integral estimate and error. */
  albedo: { mean: Vec3; se: Vec3; pdf: number; pdfSe: number; mu: number }[];
  /** Per direction: mean sampler weight and its standard error (rgb). */
  sampler: { mean: Vec3; se: Vec3 }[];
  maxWeightRelDiff: number;
  outsideHemisphere: number;
  maxLengthError: number;
  zeroPdfSamples: number;
  maxReciprocityDiff: number;
  minF: number;
  minPdf: number;
  supportViolations: number;
  histogram: Uint32Array;
}

export const HIST_MU = 32;
export const HIST_PHI = 64;

export async function probeBsdf(gpu: Gpu, cfg: BsdfProbeConfig): Promise<BsdfProbeResult> {
  // Outgoing directions stratified over the hemisphere (16 x 16 strata in cos theta and phi), jittered
  // from the harness stream; normals are uniform on the sphere for the sampler test.
  const h = new HarnessRng(cfg.seed, 0x6b);
  const side = Math.round(Math.sqrt(cfg.directions));
  const dirs = new Float32Array(cfg.directions * 4);
  const normals = new Float32Array(cfg.directions * 4);
  const mus: number[] = [];
  for (let d = 0; d < cfg.directions; d++) {
    const mu = 1 - ((d % side) + h.uniform()) / side; // in (0, 1]
    const phi = 2 * Math.PI * ((Math.floor(d / side) + h.uniform()) / side) - Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - mu * mu));
    dirs.set([r * Math.cos(phi), r * Math.sin(phi), mu, 0], d * 4);
    mus.push(mu);
    const z = 2 * h.uniform() - 1;
    const pn = 2 * Math.PI * h.uniform() - Math.PI;
    const rn = Math.sqrt(Math.max(0, 1 - z * z));
    normals.set([rn * Math.cos(pn), rn * Math.sin(pn), z, 0], d * 4);
  }

  const U = GPUBufferUsage;
  const code = kernelSource("probe_bsdf");
  const params = (count: number) => {
    const buf = new ArrayBuffer(64);
    new Uint32Array(buf).set([cfg.seed, count, cfg.blocks, cfg.samplesPerBlock]);
    new Float32Array(buf).set([...cfg.albedo, 0], 4);
    return gpu.bufferWith(new Uint8Array(buf), U.UNIFORM, "probe params");
  };
  const dirBuf = gpu.bufferWith(dirs, U.STORAGE, "probe dirs");
  const normalBuf = gpu.bufferWith(normals, U.STORAGE, "probe normals");
  const inv = cfg.directions * cfg.blocks;
  const M = cfg.blocks * cfg.samplesPerBlock;

  // Albedo and pdf normalization.
  const pa = await gpu.pipeline(code, "probe albedo", {}, "albedo_main");
  const pAlb = params(cfg.directions);
  const outA = gpu.buffer(inv * 8 * 4, U.STORAGE | U.COPY_SRC, "probe albedo out");
  dispatch(gpu, pa, bindGroupAt(gpu, pa, [[0, pAlb], [1, dirBuf], [3, outA]]), Math.ceil(inv / 64));
  const a = new Float32Array(await gpu.read(outA, inv * 32));

  // Sampler consistency.
  const ps = await gpu.pipeline(code, "probe sample", {}, "sample_main");
  const outS = gpu.buffer(inv * 12 * 4, U.STORAGE | U.COPY_SRC, "probe sample out");
  dispatch(gpu, ps, bindGroupAt(gpu, ps, [[0, pAlb], [1, dirBuf], [2, normalBuf], [3, outS]]), Math.ceil(inv / 64));
  const s = new Float32Array(await gpu.read(outS, inv * 48));

  // Reciprocity and support.
  const pr = await gpu.pipeline(code, "probe recip", {}, "recip_main");
  const pRec = params(cfg.reciprocityPairs);
  const outR = gpu.buffer(cfg.reciprocityPairs * 16, U.STORAGE | U.COPY_SRC, "probe recip out");
  dispatch(gpu, pr, bindGroupAt(gpu, pr, [[0, pRec], [3, outR]]), Math.ceil(cfg.reciprocityPairs / 64));
  const rr = new Float32Array(await gpu.read(outR, cfg.reciprocityPairs * 16));

  // Sampling histogram.
  const ph = await gpu.pipeline(code, "probe hist", {}, "hist_main");
  const pHist = params(cfg.histogramSamples);
  const histBuf = gpu.buffer(HIST_MU * HIST_PHI * 4, U.STORAGE | U.COPY_SRC, "probe hist");
  dispatch(gpu, ph, bindGroupAt(gpu, ph, [[0, pHist], [4, histBuf]]), Math.ceil(cfg.histogramSamples / 64));
  const histogram = new Uint32Array(await gpu.read(histBuf, HIST_MU * HIST_PHI * 4));
  for (const b of [dirBuf, normalBuf, pAlb, outA, outS, pRec, outR, pHist, histBuf]) gpu.release(b);

  const albedo: BsdfProbeResult["albedo"] = [];
  const sampler: BsdfProbeResult["sampler"] = [];
  let maxRel = 0;
  let outside = 0;
  let lenErr = 0;
  let zeroPdf = 0;
  for (let d = 0; d < cfg.directions; d++) {
    const sf = [0, 0, 0];
    const qf = [0, 0, 0];
    let sp = 0;
    let qp = 0;
    const sw = [0, 0, 0];
    const qw = [0, 0, 0];
    for (let b = 0; b < cfg.blocks; b++) {
      const k = d * cfg.blocks + b;
      for (let c = 0; c < 3; c++) {
        sf[c]! += a[k * 8 + c]!;
        qf[c]! += a[k * 8 + 4 + c]!;
        sw[c]! += s[k * 12 + c]!;
        qw[c]! += s[k * 12 + 4 + c]!;
      }
      sp += a[k * 8 + 3]!;
      qp += a[k * 8 + 7]!;
      maxRel = Math.max(maxRel, s[k * 12 + 3]!);
      outside += s[k * 12 + 7]!;
      lenErr = Math.max(lenErr, s[k * 12 + 8]!);
      zeroPdf += s[k * 12 + 9]!;
    }
    const meanSe = (sum: number, sq: number) => {
      const m = sum / M;
      return [m, Math.sqrt(Math.max(0, sq / M - m * m) / M)] as const;
    };
    const fa = [0, 1, 2].map((c) => meanSe(sf[c]!, qf[c]!));
    const fp = meanSe(sp, qp);
    const fw = [0, 1, 2].map((c) => meanSe(sw[c]!, qw[c]!));
    albedo.push({ mean: fa.map((x) => x[0]) as Vec3, se: fa.map((x) => x[1]) as Vec3, pdf: fp[0], pdfSe: fp[1], mu: mus[d]! });
    sampler.push({ mean: fw.map((x) => x[0]) as Vec3, se: fw.map((x) => x[1]) as Vec3 });
  }
  let maxRecip = 0;
  let minF = Infinity;
  let minPdf = Infinity;
  let support = 0;
  for (let k = 0; k < cfg.reciprocityPairs; k++) {
    maxRecip = Math.max(maxRecip, rr[k * 4]!);
    minF = Math.min(minF, rr[k * 4 + 1]!);
    minPdf = Math.min(minPdf, rr[k * 4 + 2]!);
    support += rr[k * 4 + 3]!;
  }
  return { albedo, sampler, maxWeightRelDiff: maxRel, outsideHemisphere: outside, maxLengthError: lenErr, zeroPdfSamples: zeroPdf, maxReciprocityDiff: maxRecip, minF, minPdf, supportViolations: support, histogram };
}

/** Expected histogram probability of bin (mu, phi) under the cosine pdf: (mu_hi^2 - mu_lo^2) / HIST_PHI. */
export function cosineBinProbability(muBin: number): number {
  const lo = muBin / HIST_MU;
  const hi = (muBin + 1) / HIST_MU;
  return (hi * hi - lo * lo) / HIST_PHI;
}


// --- P1 material probe (golden G24) ----------------------------------------------------------------

export interface MaterialProbeConfig {
  seed: number;
  material: Material;
  directions: number;
  blocks: number;
  samplesPerBlock: number;
  reciprocityPairs: number;
  histogramSamples: number;
  /** Local-frame outgoing direction of the histogram test. */
  histogramWo: Vec3;
  candidates?: { COUPLING?: number; GGX_SAMPLER?: number };
}

export interface MaterialProbeResult {
  /** Per direction: uniform-sampling estimates of the directional albedo and of the pdf's integral. */
  albedo: { mean: Vec3; se: Vec3; pdf: number; pdfSe: number; mu: number }[];
  /**
   * Per direction: mean sampler weight, its standard error, the share of invalid samples, and the
   * standard error with the invalid share at its Wilson 95% upper bound (see seRobust below).
   */
  sampler: { mean: Vec3; se: Vec3; seRobust: Vec3; invalid: number }[];
  maxWeightRelDiff: number;
  maxLengthError: number;
  zeroPdfSamples: number;
  maxReciprocityRel: number;
  minF: number;
  supportViolations: number;
  histogram: Uint32Array;
}

export async function probeMaterial(gpu: Gpu, cfg: MaterialProbeConfig): Promise<MaterialProbeResult> {
  const h = new HarnessRng(cfg.seed, 0x24);
  const side = Math.round(Math.sqrt(cfg.directions));
  const dirs = new Float32Array(cfg.directions * 4);
  const mus: number[] = [];
  for (let d = 0; d < cfg.directions; d++) {
    const mu = 1 - ((d % side) + h.uniform()) / side;
    const phi = 2 * Math.PI * ((Math.floor(d / side) + h.uniform()) / side) - Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - mu * mu));
    dirs.set([r * Math.cos(phi), r * Math.sin(phi), mu, 0], d * 4);
    mus.push(mu);
  }
  const histDirs = new Float32Array([...cfg.histogramWo, 0]);

  const U = GPUBufferUsage;
  const code = kernelSource("probe_bsdf");
  const constants = { ...(cfg.candidates ?? {}) };
  const matRecord = new ArrayBuffer(64);
  packMaterial(cfg.material, matRecord, 0);
  const params = (count: number) => {
    const buf = new ArrayBuffer(64);
    new Uint32Array(buf).set([cfg.seed, count, cfg.blocks, cfg.samplesPerBlock]);
    const mf = new Float32Array(matRecord);
    const mu32 = new Uint32Array(matRecord);
    new Float32Array(buf).set([mf[0]!, mf[1]!, mf[2]!, mf[3]!, mf[8]!, mf[9]!, mf[10]!, 0], 4);
    new Uint32Array(buf).set([mu32[12]!, 0, 0, 0], 12);
    return gpu.bufferWith(new Uint8Array(buf), U.UNIFORM, "material probe params");
  };
  const dirBuf = gpu.bufferWith(dirs, U.STORAGE, "probe dirs");
  const histDirBuf = gpu.bufferWith(histDirs, U.STORAGE, "probe hist dir");
  const kelBuf = gpu.bufferWith(kelemenTableBytes(), U.STORAGE, "kelemen");
  const inv = cfg.directions * cfg.blocks;
  const M = cfg.blocks * cfg.samplesPerBlock;
  const pDir = params(cfg.directions);

  const pa = await gpu.pipeline(code, "p1 albedo", constants, "p1_albedo_main");
  const outA = gpu.buffer(inv * 32, U.STORAGE | U.COPY_SRC, "p1 albedo out");
  dispatch(gpu, pa, bindGroupAt(gpu, pa, [[0, pDir], [1, dirBuf], [3, outA], [15, kelBuf]]), Math.ceil(inv / 64));
  const a = new Float32Array(await gpu.read(outA, inv * 32));

  const ps = await gpu.pipeline(code, "p1 sample", constants, "p1_sample_main");
  const outS = gpu.buffer(inv * 48, U.STORAGE | U.COPY_SRC, "p1 sample out");
  dispatch(gpu, ps, bindGroupAt(gpu, ps, [[0, pDir], [1, dirBuf], [3, outS], [15, kelBuf]]), Math.ceil(inv / 64));
  const s = new Float32Array(await gpu.read(outS, inv * 48));

  const pr = await gpu.pipeline(code, "p1 recip", constants, "p1_recip_main");
  const pRec = params(cfg.reciprocityPairs);
  const outR = gpu.buffer(cfg.reciprocityPairs * 16, U.STORAGE | U.COPY_SRC, "p1 recip out");
  dispatch(gpu, pr, bindGroupAt(gpu, pr, [[0, pRec], [3, outR], [15, kelBuf]]), Math.ceil(cfg.reciprocityPairs / 64));
  const rr = new Float32Array(await gpu.read(outR, cfg.reciprocityPairs * 16));

  const ph = await gpu.pipeline(code, "p1 hist", constants, "p1_hist_main");
  const pHist = params(cfg.histogramSamples);
  const histBuf = gpu.buffer(HIST_MU * HIST_PHI * 4, U.STORAGE | U.COPY_SRC, "p1 hist");
  dispatch(gpu, ph, bindGroupAt(gpu, ph, [[0, pHist], [1, histDirBuf], [4, histBuf], [15, kelBuf]]), Math.ceil(cfg.histogramSamples / 64));
  const histogram = new Uint32Array(await gpu.read(histBuf, HIST_MU * HIST_PHI * 4));
  for (const b of [dirBuf, histDirBuf, kelBuf, pDir, outA, outS, pRec, outR, pHist, histBuf]) gpu.release(b);

  const albedo: MaterialProbeResult["albedo"] = [];
  const sampler: MaterialProbeResult["sampler"] = [];
  let maxRel = 0;
  let lenErr = 0;
  let zeroPdf = 0;
  for (let d = 0; d < cfg.directions; d++) {
    const sf = [0, 0, 0];
    const qf = [0, 0, 0];
    const sw = [0, 0, 0];
    const qw = [0, 0, 0];
    let sp = 0;
    let qp = 0;
    let invalid = 0;
    for (let b = 0; b < cfg.blocks; b++) {
      const k = d * cfg.blocks + b;
      for (let c = 0; c < 3; c++) {
        sf[c]! += a[k * 8 + c]!;
        qf[c]! += a[k * 8 + 4 + c]!;
        sw[c]! += s[k * 12 + c]!;
        qw[c]! += s[k * 12 + 4 + c]!;
      }
      sp += a[k * 8 + 3]!;
      qp += a[k * 8 + 7]!;
      maxRel = Math.max(maxRel, s[k * 12 + 3]!);
      invalid += s[k * 12 + 7]!;
      lenErr = Math.max(lenErr, s[k * 12 + 8]!);
      zeroPdf += s[k * 12 + 9]!;
    }
    const meanSe = (sum: number, sq: number) => {
      const m = sum / M;
      return [m, Math.sqrt(Math.max(0, sq / M - m * m) / M)] as const;
    };
    const fa = [0, 1, 2].map((c) => meanSe(sf[c]!, qf[c]!));
    const fp = meanSe(sp, qp);
    const fw = [0, 1, 2].map((c) => meanSe(sw[c]!, qw[c]!));
    // A sampler weight is a point mass at 0 (invalid samples, share p) plus the valid part, so
    // Var = (1 - p) Var_valid + p (1 - p) E_valid^2. A smooth lobe has p ~ 1e-4 and a direction can
    // draw no invalid sample at all, which collapses the sample variance (at alpha = 0.01 to a tenth
    // of the true one). seRobust uses the Wilson 95% upper bound on p for that term (Wilson 1927).
    const p = invalid / M;
    const zw = 1.959963984540054;
    const pu = (p + (zw * zw) / (2 * M) + zw * Math.sqrt((p * (1 - p)) / M + (zw * zw) / (4 * M * M))) / (1 + (zw * zw) / M);
    const seRobust = fw.map(([m, se]) => {
      const valid = p < 1 ? m / (1 - p) : 0;
      return Math.sqrt(se * se + (Math.max(0, pu * (1 - pu) - p * (1 - p)) * valid * valid) / M);
    }) as Vec3;
    albedo.push({ mean: fa.map((x) => x[0]) as Vec3, se: fa.map((x) => x[1]) as Vec3, pdf: fp[0], pdfSe: fp[1], mu: mus[d]! });
    sampler.push({ mean: fw.map((x) => x[0]) as Vec3, se: fw.map((x) => x[1]) as Vec3, seRobust, invalid: p });
  }
  let maxRecip = 0;
  let minF = Infinity;
  let support = 0;
  for (let k = 0; k < cfg.reciprocityPairs; k++) {
    maxRecip = Math.max(maxRecip, rr[k * 4]!);
    minF = Math.min(minF, rr[k * 4 + 1]!);
    support += rr[k * 4 + 3]!;
  }
  return { albedo, sampler, maxWeightRelDiff: maxRel, maxLengthError: lenErr, zeroPdfSamples: zeroPdf, maxReciprocityRel: maxRecip, minF, supportViolations: support, histogram };
}
