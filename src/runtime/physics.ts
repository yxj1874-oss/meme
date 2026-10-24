// Host side of the unconstrained XPBD step. Bodies are the spheres with a `body`, in canonical id
// order; positions are Q31.32 fixed point (design D15-A), velocities f32.

import { canonicalEntries } from "../core/jcs.ts";
import type { Scene, Sphere, Vec3 } from "../core/scene_types.ts";
import { bindGroup, type Gpu } from "../gpu/device.ts";
import { kernelSource } from "../gpu/kernels.ts";
import type { ExecutionPlan } from "./plan.ts";

export const BODY_BYTES = 48;

export interface PhysicsFaults {
  FAULT_KIND?: number;
  FAULT_BODY?: number;
  FAULT_STEP?: number;
  FAULT_C?: number;
}

export interface BodyState {
  x_m: Vec3;
  v_m_s: Vec3;
}

export interface PhysicsRecord {
  step: number;
  /** Raw body buffer for this step: BODY_BYTES per body in canonical order. */
  raw: Uint8Array;
}

export interface PhysicsResult {
  ids: string[];
  masses: number[];
  records: PhysicsRecord[];
}

const Q32 = 2n ** 32n;

/** f64 metres -> Q31.32 [lo, hi] words (lo unsigned, hi signed), rounding to the nearest quantum. */
export function toFixed(x: number): [number, number] {
  const q = BigInt(Math.round(x * 2 ** 32));
  const hi = q >> 32n; // arithmetic shift: floor division
  const lo = q - hi * Q32;
  return [Number(lo), Number(hi)];
}

export function fromFixed(lo: number, hi: number): number {
  return hi + lo * 2 ** -32;
}

export function dynamicBodies(scene: Scene): [string, Sphere & { body: NonNullable<Sphere["body"]> }][] {
  return canonicalEntries(scene.objects).filter((e): e is [string, Sphere & { body: NonNullable<Sphere["body"]> }] => e[1].shape === "sphere" && e[1].body !== undefined);
}

export function recordSteps(steps: number, every: number): number[] {
  const out: number[] = [];
  for (let s = 0; s <= steps; s += every) out.push(s);
  if (out[out.length - 1] !== steps) out.push(steps);
  return out;
}

export function decodeBodies(raw: Uint8Array): BodyState[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: BodyState[] = [];
  for (let o = 0; o + BODY_BYTES <= raw.byteLength; o += BODY_BYTES) {
    const x: Vec3 = [0, 1, 2].map((c) => fromFixed(dv.getUint32(o + 4 * c, true), dv.getInt32(o + 16 + 4 * c, true))) as Vec3;
    const v: Vec3 = [0, 1, 2].map((c) => dv.getFloat32(o + 32 + 4 * c, true)) as Vec3;
    out.push({ x_m: x, v_m_s: v });
  }
  return out;
}

export async function simulate(gpu: Gpu, scene: Scene, plan: ExecutionPlan, faults: PhysicsFaults = {}): Promise<PhysicsResult> {
  const p = scene.physics!;
  const bodies = dynamicBodies(scene);
  const n = bodies.length;
  const init = new ArrayBuffer(Math.max(1, n) * BODY_BYTES);
  const dv = new DataView(init);
  bodies.forEach(([, s], i) => {
    const o = i * BODY_BYTES;
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = toFixed(s.center_m[c]!);
      dv.setUint32(o + 4 * c, lo, true);
      dv.setInt32(o + 16 + 4 * c, hi, true);
      dv.setFloat32(o + 32 + 4 * c, s.body.velocity_m_s[c]!, true);
    }
    dv.setFloat32(o + 28, 1 / s.body.mass_kg, true);
  });

  const records = recordSteps(p.steps, p.record_every_steps);
  const U = GPUBufferUsage;
  const bodyBuf = gpu.bufferWith(new Uint8Array(init), U.STORAGE | U.COPY_SRC, "bodies");
  const staging = gpu.buffer(records.length * Math.max(1, n) * BODY_BYTES, U.COPY_DST | U.MAP_READ, "physics records");
  const pipeline = await gpu.pipeline(kernelSource("physics_p0"), "physics_p0", { ...faults });
  const size = Math.max(1, n) * BODY_BYTES;

  const copyRecord = (index: number) => {
    const enc = gpu.device.createCommandEncoder();
    enc.copyBufferToBuffer(bodyBuf, 0, staging, index * size, size);
    gpu.device.queue.submit([enc.finish()]);
  };

  copyRecord(0);
  let step = 0;
  for (let r = 1; r < records.length; r++) {
    const target = records[r]!;
    while (step < target) {
      const k = Math.min(plan.physics_steps_per_dispatch, target - step);
      const params = new ArrayBuffer(48);
      const f = new Float32Array(params);
      const u = new Uint32Array(params);
      f.set([...p.gravity_m_s2.map((g) => g * p.dt_s * p.dt_s), p.dt_s], 0);
      f.set([1 / p.dt_s, 0, 0, 0], 4);
      u.set([n, k, step, 0x7fc00000], 8);
      const paramBuf = gpu.bufferWith(new Uint8Array(params), U.UNIFORM, "step params");
      const enc = gpu.device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(pipeline);
      cp.setBindGroup(0, bindGroup(gpu, pipeline, [paramBuf, bodyBuf]));
      cp.dispatchWorkgroups(Math.max(1, Math.ceil(n / 64)));
      cp.end();
      gpu.device.queue.submit([enc.finish()]);
      gpu.release(paramBuf);
      step += k;
    }
    copyRecord(r);
  }

  await staging.mapAsync(GPUMapMode.READ);
  const all = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  gpu.release(staging);
  gpu.release(bodyBuf);
  gpu.throwIfErrors();

  return {
    ids: bodies.map(([id]) => id),
    masses: bodies.map(([, s]) => s.body.mass_kg),
    records: records.map((s, i) => ({ step: s, raw: all.slice(i * size, i * size + n * BODY_BYTES) })),
  };
}
