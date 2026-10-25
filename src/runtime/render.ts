// Host side of the P1 path tracer: packs the canonical scene into camera-relative f32 buffers,
// builds the light list and selection probabilities, runs the passes of an execution plan, and
// normalizes the sums on the CPU (design N11: the mean is f32(f64(sum) / spp), correctly rounded,
// never a GPU division).

import { readFileSync } from "node:fs";

import { canonicalEntries } from "../core/jcs.ts";
import type { Environment, Material, Scene, Vec3 } from "../core/scene_types.ts";
import { cross, dot, luminanceY, normalize, scale, sub } from "../core/vec.ts";
import { bindGroupAt, type Gpu } from "../gpu/device.ts";
import { kernelSource } from "../gpu/kernels.ts";
import { ALPHA_MIN, averageAlbedo, frDielectric } from "../oracle/ref_bsdf.ts";
import { batches, blockList, type ExecutionPlan } from "./plan.ts";

export const ID_NONE = 0xffffffff;

export interface RenderFaults {
  FAULT_KIND?: number;
  FAULT_X?: number;
  FAULT_Y?: number;
  FAULT_C?: number;
  BSDF_GAIN?: number;
}

/** Candidate selection (design P1 §3.4); test tooling only, never part of a scene. */
export interface RenderCandidates {
  MIS_HEURISTIC?: number;
  SPHERE_SAMPLER?: number;
  COUPLING?: number;
  GGX_SAMPLER?: number;
}

/**
 * The runtime's candidate choices: the override defaults declared in bsdf_p1.wgsl and render_p1.wgsl
 * (test/core/candidates.test.ts keeps the two in step). Oracles whose reference depends on the
 * candidate use these when a golden names none. Decisions F1-F4 in docs/P1-02-implementation.md.
 */
export const DEFAULT_CANDIDATES: Required<RenderCandidates> = { MIS_HEURISTIC: 1, SPHERE_SAMPLER: 0, COUPLING: 0, GGX_SAMPLER: 1 };

export interface RenderResult {
  width: number;
  height: number;
  spp: number;
  /** Per-pixel mean radiance, RGB interleaved, rows top to bottom. */
  mean: Float32Array;
  /** Per-pixel mean of squared radiance, for variance estimates. */
  m2: Float32Array;
  /** Rank (canonical order over all objects) of the object hit by the pixel-centre ray, or ID_NONE. */
  ids: Uint32Array;
  /** Canonical object ids, indexed by rank. */
  objectIds: string[];
  /** Total ray segments traced (exact, summed on the CPU). */
  segments: number;
  /** Ray-primitive tests: segments * primitives. */
  isectTests: number;
  shadowRays: number;
  specularChoices: number;
  /** Share of the image's summed luminance that came from light sampling. */
  neeShare: number;
  lightCount: number;
}

export const KIND = { LAMBERT: 0, MICROFACET: 1, DELTA: 2 } as const;
const LIGHT = { POINT: 0, SPHERE: 1, ENV: 2 } as const;
const STRATEGY = { bsdf: 0, nee: 1, mis: 2 } as const;

let kelemenTable: Uint8Array | undefined;
function kelemen(): Uint8Array {
  kelemenTable ??= new Uint8Array(readFileSync(new URL("./kelemen_es.f32", import.meta.url)));
  return kelemenTable;
}

/** Radiance RGB for a luminance and a chromaticity: L * color / Y(color) (design D6-A). */
export function radianceRgb(luminance: number, color: Vec3): Vec3 {
  if (luminance === 0) return [0, 0, 0];
  return scale(color, luminance / luminanceY(color));
}

function envRadiance(env: Environment): { type: number; up: Vec3; a: Vec3; b: Vec3 } {
  if (env.type === "constant") return { type: 0, up: [0, 0, 1], a: radianceRgb(env.luminance_cdm2, env.color), b: [0, 0, 0] };
  return { type: 1, up: normalize(env.up), a: radianceRgb(env.upper_cdm2, env.color), b: radianceRgb(env.lower_cdm2, env.color) };
}

/** Material kind as the kernel sees it: metallic 0 with ior 1 is exactly the P0 Lambert. */
export function materialKind(m: Material): number {
  if ((m.metallic ?? 0) === 0 && (m.ior ?? 1) === 1) return KIND.LAMBERT;
  return (m.roughness ?? 1) ** 2 < ALPHA_MIN ? KIND.DELTA : KIND.MICROFACET;
}

/** The kernel's Material record: (base_color, metallic), emission, (alpha, ior, ebar_delta, 0), (kind, 0, 0, 0). */
export function packMaterial(m: Material, out: ArrayBuffer, index: number): void {
  const f = new Float32Array(out, index * 64, 16);
  const u = new Uint32Array(out, index * 64, 16);
  const kind = materialKind(m);
  const ior = m.ior ?? 1;
  const ebarDelta = kind === KIND.DELTA ? averageAlbedo((c) => frDielectric(c, ior)) : 0;
  f.set([...m.base_color, m.metallic ?? 0, ...radianceRgb(m.emissive_cdm2 ?? 0, m.emissive_color ?? [1, 1, 1]), 0, (m.roughness ?? 1) ** 2, ior, ebarDelta, 0]);
  u.set([kind, 0, 0, 0], 12);
}

export function kelemenTableBytes(): Uint8Array {
  return kelemen();
}

export async function renderScene(gpu: Gpu, scene: Scene, plan: ExecutionPlan, faults: RenderFaults = {}, candidates: RenderCandidates = {}): Promise<RenderResult> {
  const r = scene.render!;
  const cam = scene.camera!;
  const W = r.width_px;
  const H = r.height_px;
  const strategy = STRATEGY[r.strategy ?? "mis"];

  const objects = canonicalEntries(scene.objects);
  const materials = canonicalEntries(scene.materials);
  const materialIndex = new Map(materials.map(([id], i) => [id, i]));

  // Camera basis in f64; every position becomes camera-relative before it is rounded to f32.
  const fwd = normalize(sub(cam.look_at_m, cam.position_m));
  const right = normalize(cross(fwd, normalize(cam.up)));
  const up = cross(right, fwd);
  const tanHalf = Math.tan(cam.vfov_rad / 2);
  const camRight = scale(right, tanHalf * (W / H));
  const camUp = scale(up, tanHalf);
  const rel = (p: Vec3) => sub(p, cam.position_m);

  // Lights: point lights, then emissive spheres, then the environment (design P1D9).
  interface LightRec { kind: number; pos: Vec3; radius: number; rad: Vec3; power: number; rank: number; envMode: number }
  const lightRecs: LightRec[] = [];
  const sphereLight = new Map<number, number>();
  for (const [, l] of canonicalEntries(scene.lights ?? {})) {
    const rad = radianceRgb(l.intensity_cd, l.color);
    lightRecs.push({ kind: LIGHT.POINT, pos: rel(l.position_m), radius: 0, rad, power: 4 * Math.PI * luminanceY(rad), rank: 0, envMode: 0 });
  }
  objects.forEach(([, o], rank) => {
    if (o.shape !== "sphere") return;
    const m = scene.materials[o.material]!;
    const rad = radianceRgb(m.emissive_cdm2 ?? 0, m.emissive_color ?? [1, 1, 1]);
    if (luminanceY(rad) <= 0) return;
    sphereLight.set(rank, lightRecs.length);
    lightRecs.push({ kind: LIGHT.SPHERE, pos: rel(o.center_m), radius: o.radius_m, rad, power: 4 * Math.PI * Math.PI * o.radius_m * o.radius_m * luminanceY(rad), rank, envMode: 0 });
  });
  const env = envRadiance(scene.environment!);
  const envLit = luminanceY(env.a) > 0 || luminanceY(env.b) > 0;
  let envIndex = ID_NONE;
  if (strategy !== STRATEGY.bsdf && envLit) {
    envIndex = lightRecs.length;
    lightRecs.push({ kind: LIGHT.ENV, pos: [0, 0, 0], radius: 0, rad: [0, 0, 0], power: 0, rank: 0, envMode: env.type === 1 && luminanceY(env.b) === 0 ? 1 : 0 });
  }
  // Selection probabilities: proportional to power; an environment has no finite power, so it gets
  // a fixed half when other lights exist (implementation choice for P1D10, see docs/P1-02).
  const finite = lightRecs.filter((l) => l.kind !== LIGHT.ENV).reduce((s, l) => s + l.power, 0);
  const envShare = envIndex === ID_NONE ? 0 : finite > 0 ? 0.5 : 1;
  const prob = lightRecs.map((l) => (l.kind === LIGHT.ENV ? envShare : finite > 0 ? ((1 - envShare) * l.power) / finite : 0));
  const lightCount = strategy === STRATEGY.bsdf ? 0 : lightRecs.length;

  const sphereData: number[] = [];
  const sphereInfo: number[] = [];
  const planeData: number[] = [];
  const planeInfo: number[] = [];
  objects.forEach(([, o], rank) => {
    const mat = materialIndex.get(o.material)!;
    if (o.shape === "sphere") {
      sphereData.push(...rel(o.center_m), o.radius_m);
      sphereInfo.push(mat, rank, sphereLight.get(rank) ?? ID_NONE, 0);
    } else {
      const n = normalize(o.normal);
      planeData.push(...n, dot(n, rel(o.point_m)));
      planeInfo.push(mat, rank, ID_NONE, 0);
    }
  });
  // One primitive buffer: spheres first, then planes (render_p1.wgsl prims).
  const prims = interleave([...sphereData, ...planeData], [...sphereInfo, ...planeInfo]);

  // Material records: albedo+metallic, emission, (alpha, ior, ebar_delta), flags.
  const matBuf = new ArrayBuffer(Math.max(1, materials.length) * 64);
  materials.forEach(([, m], i) => packMaterial(m, matBuf, i));

  const lightBuf = new ArrayBuffer(Math.max(1, lightRecs.length) * 48);
  const lf = new Float32Array(lightBuf);
  const lu = new Uint32Array(lightBuf);
  lightRecs.forEach((l, i) => {
    lf.set([...l.pos, l.radius, ...l.rad, prob[i]!], i * 12);
    lu.set([l.kind, l.rank, l.envMode, 0], i * 12 + 8);
  });

  const blocks = blockList(W, H, plan);
  const blockCount = blocks.length / 2;

  // Pipeline specialization (render_p1.wgsl STRATEGY, MATERIALS, WORK_STRIDE).
  const kinds = materials.reduce((mask, [, m]) => mask | (1 << materialKind(m)), 0);
  const stride = strategy === STRATEGY.bsdf && kinds === 1 ? 1 : 4;

  const U = GPUBufferUsage;
  const primBuf = gpu.bufferWith(prims, U.STORAGE, "prims");
  const materialBuf = gpu.bufferWith(new Uint8Array(matBuf), U.STORAGE, "materials");
  const lightsBuf = gpu.bufferWith(new Uint8Array(lightBuf), U.STORAGE, "lights");
  // Only microfacet materials read the coupling table; other scenes bind a stub.
  const kelemenBuf = gpu.bufferWith(kinds & (1 << KIND.MICROFACET) ? kelemen() : new Uint8Array(16), U.STORAGE, "kelemen");
  const tileBuf = gpu.bufferWith(blocks, U.STORAGE, "tiles");
  const accumBuf = gpu.buffer(W * H * 6 * 4, U.STORAGE | U.COPY_SRC, "accum");
  const idBuf = gpu.buffer(W * H * 4, U.STORAGE | U.COPY_SRC, "ids");
  const workBuf = gpu.buffer(W * H * stride * 4, U.STORAGE | U.COPY_SRC, "work");

  const pipeline = await gpu.pipeline(kernelSource("render_p1"), "render_p1", { ...faults, ...candidates, STRATEGY: strategy, MATERIALS: kinds || 1, WORK_STRIDE: stride });

  for (let first = 0, pass = 0; first < r.spp; first += plan.pass_spp, pass++) {
    const count = Math.min(plan.pass_spp, r.spp - first);
    for (const [offset, n] of batches(blockCount, plan)) {
      const params = new ArrayBuffer(160);
      const u = new Uint32Array(params);
      const f = new Float32Array(params);
      u.set([W, H, r.max_bounces, scene.seed], 0);
      u.set([first, count, offset, sphereInfo.length / 4], 4);
      u.set([planeInfo.length / 4, env.type, pass === 0 ? 1 : 0, 0], 8);
      f.set([...fwd, 1 / W], 12);
      f.set([...camRight, 1 / H], 16);
      f.set([...camUp, 0], 20);
      f.set([...env.up, 0], 24);
      f.set([...env.a, 0], 28);
      f.set([...env.b, 0], 32);
      u.set([lightCount, strategy, envIndex, 0], 36);
      const paramBuf = gpu.bufferWith(new Uint8Array(params), U.UNIFORM, "render params");
      const bg = bindGroupAt(gpu, pipeline, [[0, paramBuf], [1, primBuf], [3, materialBuf], [4, tileBuf], [5, accumBuf], [6, idBuf], [7, workBuf], [8, lightsBuf], [15, kelemenBuf]]);
      const enc = gpu.device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(pipeline);
      cp.setBindGroup(0, bg);
      cp.dispatchWorkgroups(n);
      cp.end();
      gpu.device.queue.submit([enc.finish()]);
      gpu.release(paramBuf);
    }
  }

  const sums = new Float32Array(await gpu.read(accumBuf, W * H * 6 * 4));
  const ids = new Uint32Array(await gpu.read(idBuf, W * H * 4));
  const work = new Uint32Array(await gpu.read(workBuf, W * H * stride * 4));
  const workF = new Float32Array(work.buffer);
  for (const b of [primBuf, materialBuf, lightsBuf, kelemenBuf, tileBuf, accumBuf, idBuf, workBuf]) gpu.release(b);

  const mean = new Float32Array(W * H * 3);
  const m2 = new Float32Array(W * H * 3);
  let lumTotal = 0;
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      mean[p * 3 + c] = sums[p * 6 + c]! / r.spp;
      m2[p * 3 + c] = sums[p * 6 + 3 + c]! / r.spp;
    }
    lumTotal += 0.2126 * sums[p * 6]! + 0.7152 * sums[p * 6 + 1]! + 0.0722 * sums[p * 6 + 2]!;
  }
  let segments = 0;
  let shadowRays = 0;
  let specularChoices = 0;
  let neeLum = 0;
  for (let p = 0; p < W * H; p++) {
    segments += work[p * stride]!;
    if (stride === 4) {
      shadowRays += work[p * 4 + 1]!;
      specularChoices += work[p * 4 + 2]!;
      neeLum += workF[p * 4 + 3]!;
    }
  }
  return {
    width: W,
    height: H,
    spp: r.spp,
    mean,
    m2,
    ids,
    objectIds: objects.map(([id]) => id),
    segments,
    isectTests: (segments + shadowRays) * objects.length,
    shadowRays,
    specularChoices,
    neeShare: lumTotal > 0 && Number.isFinite(neeLum) ? neeLum / lumTotal : 0,
    lightCount,
  };
}

/** [vec4<f32> data, vec4<u32> info] records, 32 bytes each. */
function interleave(data: number[], info: number[]): Uint8Array {
  const n = info.length / 4;
  const buf = new ArrayBuffer(Math.max(1, n) * 32);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  for (let i = 0; i < n; i++) {
    f.set(data.slice(i * 4, i * 4 + 4), i * 8);
    u.set(info.slice(i * 4, i * 4 + 4), i * 8 + 4);
  }
  return new Uint8Array(buf);
}
