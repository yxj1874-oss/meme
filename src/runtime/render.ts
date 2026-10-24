// Host side of the P0 path tracer: packs the canonical scene into camera-relative f32 buffers,
// runs the passes of an execution plan, and normalizes the sums on the CPU (design N11: the mean
// is f32(f64(sum) / spp), correctly rounded, never a GPU division).

import { canonicalEntries } from "../core/jcs.ts";
import type { Environment, Scene, Vec3 } from "../core/scene_types.ts";
import { cross, dot, luminanceY, normalize, scale, sub } from "../core/vec.ts";
import { bindGroup, type Gpu } from "../gpu/device.ts";
import { kernelSource } from "../gpu/kernels.ts";
import { batches, blockList, type ExecutionPlan } from "./plan.ts";

export const ID_NONE = 0xffffffff;

export interface RenderFaults {
  FAULT_KIND?: number;
  FAULT_X?: number;
  FAULT_Y?: number;
  FAULT_C?: number;
  BSDF_GAIN?: number;
}

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

export async function renderScene(gpu: Gpu, scene: Scene, plan: ExecutionPlan, faults: RenderFaults = {}): Promise<RenderResult> {
  const r = scene.render!;
  const cam = scene.camera!;
  const W = r.width_px;
  const H = r.height_px;

  const objects = canonicalEntries(scene.objects);
  const materialIds = canonicalEntries(scene.materials).map(([id]) => id);
  const materialIndex = new Map(materialIds.map((id, i) => [id, i]));

  // Camera basis in f64; every position becomes camera-relative before it is rounded to f32.
  const fwd = normalize(sub(cam.look_at_m, cam.position_m));
  const right = normalize(cross(fwd, normalize(cam.up)));
  const up = cross(right, fwd);
  const tanHalf = Math.tan(cam.vfov_rad / 2);
  const camRight = scale(right, tanHalf * (W / H));
  const camUp = scale(up, tanHalf);

  const sphereData: number[] = [];
  const sphereInfo: number[] = [];
  const planeData: number[] = [];
  const planeInfo: number[] = [];
  objects.forEach(([, o], rank) => {
    const mat = materialIndex.get(o.material)!;
    if (o.shape === "sphere") {
      sphereData.push(...sub(o.center_m, cam.position_m), o.radius_m);
      sphereInfo.push(mat, rank, 0, 0);
    } else {
      const n = normalize(o.normal);
      planeData.push(...n, dot(n, sub(o.point_m, cam.position_m)));
      planeInfo.push(mat, rank, 0, 0);
    }
  });
  const spheres = interleave(sphereData, sphereInfo);
  const planes = interleave(planeData, planeInfo);

  const materials = new Float32Array(Math.max(1, materialIds.length) * 8);
  canonicalEntries(scene.materials).forEach(([, m], i) => {
    materials.set([...m.base_color, 0, ...radianceRgb(m.emissive_cdm2 ?? 0, m.emissive_color ?? [1, 1, 1]), 0], i * 8);
  });

  const env = envRadiance(scene.environment!);
  const blocks = blockList(W, H, plan);
  const blockCount = blocks.length / 2;

  const U = GPUBufferUsage;
  const sphereBuf = gpu.bufferWith(spheres, U.STORAGE, "spheres");
  const planeBuf = gpu.bufferWith(planes, U.STORAGE, "planes");
  const materialBuf = gpu.bufferWith(materials, U.STORAGE, "materials");
  const tileBuf = gpu.bufferWith(blocks, U.STORAGE, "tiles");
  const accumBuf = gpu.buffer(W * H * 6 * 4, U.STORAGE | U.COPY_SRC, "accum");
  const idBuf = gpu.buffer(W * H * 4, U.STORAGE | U.COPY_SRC, "ids");
  const workBuf = gpu.buffer(W * H * 4, U.STORAGE | U.COPY_SRC, "work");

  const pipeline = await gpu.pipeline(kernelSource("render_p0"), "render_p0", { ...faults });

  for (let first = 0, pass = 0; first < r.spp; first += plan.pass_spp, pass++) {
    const count = Math.min(plan.pass_spp, r.spp - first);
    for (const [offset, n] of batches(blockCount, plan)) {
      const params = new ArrayBuffer(144);
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
      const paramBuf = gpu.bufferWith(new Uint8Array(params), U.UNIFORM, "render params");
      const bg = bindGroup(gpu, pipeline, [paramBuf, sphereBuf, planeBuf, materialBuf, tileBuf, accumBuf, idBuf, workBuf]);
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
  const work = new Uint32Array(await gpu.read(workBuf, W * H * 4));
  for (const b of [sphereBuf, planeBuf, materialBuf, tileBuf, accumBuf, idBuf, workBuf]) gpu.release(b);

  const mean = new Float32Array(W * H * 3);
  const m2 = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      mean[p * 3 + c] = sums[p * 6 + c]! / r.spp;
      m2[p * 3 + c] = sums[p * 6 + 3 + c]! / r.spp;
    }
  }
  let segments = 0;
  for (const s of work) segments += s;
  return {
    width: W,
    height: H,
    spp: r.spp,
    mean,
    m2,
    ids,
    objectIds: objects.map(([id]) => id),
    segments,
    isectTests: segments * objects.length,
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
