// Host side of the XPBD rigid-body step (design P2-01, kernel physics_p2.wgsl). Bodies are the
// spheres with a `body`, in canonical id order; static colliders are the other spheres and the
// planes, also in canonical order. Positions are Q31.32 fixed point (design D15-A), velocities f32.
//
// Scenes without contacts and joints run the free-flight loop, many substeps per dispatch, exactly
// as the P0 kernel did (design P2D5). Everything else runs one dispatch per pass per substep:
// predict, count (contacts only), solve, velocity and commit (contacts only).

import { canonicalEntries } from "../core/jcs.ts";
import { PHYSICS_MATERIAL_DEFAULTS } from "../core/scene.ts";
import type { Joint, Quat, Scene, Sphere, Vec3 } from "../core/scene_types.ts";
import { WORLD } from "../core/scene_types.ts";
import { norm, normalize } from "../core/vec.ts";
import { bindGroupAt, type Gpu } from "../gpu/device.ts";
import { kernelSource } from "../gpu/kernels.ts";
import type { ExecutionPlan } from "./plan.ts";

export const BODY_BYTES = 48;
export const ROT_BYTES = 32;
export const DIAG_BYTES = 32;
const PRED_BYTES = 128;
const PROPS_BYTES = 48;
const STATIC_BYTES = 64;
const JOINT_BYTES = 128;
const NONE = 0xffffffff;
const JOINT_KIND = { distance: 0, ball: 1, hinge: 2, fixed: 3 } as const;

export interface PhysicsFaults {
  FAULT_KIND?: number;
  FAULT_BODY?: number;
  FAULT_STEP?: number;
  FAULT_C?: number;
  RESTITUTION_GAIN?: number;
}

/** Candidate selection (design P2 §3.5); test tooling only, never part of a scene. */
export interface PhysicsCandidates {
  SOLVER?: number;
  FRICTION?: number;
  RESTITUTION_THRESHOLD?: number;
  QUAT?: number;
}

/** The runtime's choices: the override defaults declared in physics_p2.wgsl (test/core/candidates.test.ts). */
export const DEFAULT_PHYSICS_CANDIDATES: Required<PhysicsCandidates> = { SOLVER: 0, FRICTION: 0, RESTITUTION_THRESHOLD: 0, QUAT: 1 };

export interface BodyState {
  x_m: Vec3;
  v_m_s: Vec3;
}

export interface RotState {
  q: Quat;
  omega_rad_s: Vec3;
}

export interface DiagState {
  max_disp_ratio: number;
  max_pen_m: number;
  e_proj_j: number;
  e_bounce_j: number;
  contacts: number;
  max_speed_m_s: number;
}

export interface PhysicsRecord {
  step: number;
  /** Raw body buffer for this step: BODY_BYTES per body in canonical order. */
  raw: Uint8Array;
  /** ROT_BYTES per body: orientation and angular velocity. */
  rot: Uint8Array;
  /** DIAG_BYTES per body: cumulative diagnostics (design P2D7, P2D13). */
  diag: Uint8Array;
}

export interface PhysicsResult {
  ids: string[];
  masses: number[];
  radii: number[];
  /** Contacts or joints present: the multi-pass solver ran. */
  interacting: boolean;
  /** Orientation state is meaningful (interacting, or some body starts spinning or rotated): rot files are written. */
  rotational: boolean;
  records: PhysicsRecord[];
  work: { physics_substeps: number; pair_tests: number; constraint_solves: number };
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

export function decodeRot(raw: Uint8Array): RotState[] {
  const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const out: RotState[] = [];
  for (let i = 0; i + 8 <= f.length; i += 8) out.push({ q: [f[i]!, f[i + 1]!, f[i + 2]!, f[i + 3]!], omega_rad_s: [f[i + 4]!, f[i + 5]!, f[i + 6]!] });
  return out;
}

export function decodeDiag(raw: Uint8Array): DiagState[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: DiagState[] = [];
  for (let o = 0; o + DIAG_BYTES <= raw.byteLength; o += DIAG_BYTES) {
    out.push({ max_disp_ratio: dv.getFloat32(o, true), max_pen_m: dv.getFloat32(o + 4, true), e_proj_j: dv.getFloat32(o + 8, true), e_bounce_j: dv.getFloat32(o + 12, true), contacts: dv.getUint32(o + 16, true), max_speed_m_s: dv.getFloat32(o + 20, true) });
  }
  return out;
}

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
  a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qnormalize = (q: Quat): Quat => {
  const l = Math.hypot(...q);
  return q.map((c) => c / l) as Quat;
};

/** Scene-level facts the solver and the metrics both need. */
export function physicsLayout(scene: Scene) {
  const bodies = dynamicBodies(scene);
  const index = new Map(bodies.map(([id], i) => [id, i]));
  const joints = canonicalEntries(scene.joints ?? {});
  const contacts = scene.physics?.contacts === "all_pairs";
  const interacting = contacts || joints.length > 0;
  const rotational = interacting || bodies.some(([, s]) => norm(s.body.angular_velocity_rad_s ?? [0, 0, 0]) !== 0 || !(s.body.orientation ?? [0, 0, 0, 1]).every((c, k) => c === (k === 3 ? 1 : 0)));
  const statics = canonicalEntries(scene.objects).filter(([, o]) => o.shape === "plane" || o.body === undefined);
  return { bodies, index, joints, contacts, interacting, rotational, statics };
}

/** Physics material of an object, defaults expanded. */
export function contactMaterial(scene: Scene, id: string | undefined) {
  const pm = id === undefined ? undefined : scene.physics_materials?.[id];
  return { ...PHYSICS_MATERIAL_DEFAULTS, ...(pm ?? {}) };
}

/** Constraints a joint contributes to each of its bodies (the counts mass splitting and averaging use). */
export const jointConstraintCount = (j: Joint) => (j.type === "hinge" || j.type === "fixed" ? 2 : 1);

/**
 * Solver inputs for scenes with contacts or joints: joints and each body's list of them, constant
 * per-body data and the static colliders. Free-flight scenes never build them (MT3: P0-shaped scenes
 * keep the P0 kernel's host cost).
 */
function packSolver(scene: Scene, layout: ReturnType<typeof physicsLayout>) {
  const { bodies, index, joints, statics } = layout;
  const n = bodies.length;
  // Joints and each body's list of them.
  const lists: number[][] = bodies.map(() => []);
  const jointBuf = new ArrayBuffer(Math.max(1, joints.length) * JOINT_BYTES);
  const jf = new Float32Array(jointBuf);
  const ju = new Uint32Array(jointBuf);
  const ji = new Int32Array(jointBuf);
  joints.forEach(([, j], k) => {
    const a = j.a === WORLD ? NONE : index.get(j.a)!;
    const b = j.b === WORLD ? NONE : index.get(j.b)!;
    const o = (k * JOINT_BYTES) / 4;
    ju.set([JOINT_KIND[j.type], a, b, 0], o);
    jf.set([...(a === NONE ? [0, 0, 0] : j.anchor_a_m), j.type === "distance" ? j.rest_length_m : 0], o + 4);
    jf.set([...(b === NONE ? [0, 0, 0] : j.anchor_b_m), j.type === "distance" ? (j.compliance_m_N ?? 0) : 0], o + 8);
    const world = a === NONE ? j.anchor_a_m : b === NONE ? j.anchor_b_m : [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = toFixed(world[c]!);
      ju[o + 12 + c] = lo;
      ji[o + 16 + c] = hi;
    }
    if (j.type === "hinge") {
      jf.set(normalize(j.axis_a), o + 20);
      jf.set(normalize(j.axis_b), o + 24);
    }
    const q0 = (e: number): Quat => (e === NONE ? [0, 0, 0, 1] : qnormalize(bodies[e]![1].body.orientation ?? [0, 0, 0, 1]));
    jf.set(j.type === "fixed" ? qmul(qconj(q0(a)), q0(b)) : [0, 0, 0, 1], o + 28);
    if (a !== NONE) lists[a]!.push(k);
    if (b !== NONE) lists[b]!.push(k);
  });
  const jlist = new Uint32Array(Math.max(1, lists.reduce((s, l) => s + l.length, 0)));

  // Constant per-body data.
  const propsBuf = new ArrayBuffer(Math.max(1, n) * PROPS_BYTES);
  const pf = new Float32Array(propsBuf);
  const pu = new Uint32Array(propsBuf);
  let cursor = 0;
  bodies.forEach(([, s], i) => {
    const m = contactMaterial(scene, s.physics_material);
    const o = (i * PROPS_BYTES) / 4;
    pf.set([s.radius_m, 1 / s.body.mass_kg, 5 / (2 * s.body.mass_kg * s.radius_m * s.radius_m), m.restitution, m.static_friction, m.dynamic_friction], o);
    const nJoint = lists[i]!.reduce((acc, k) => acc + jointConstraintCount(joints[k]![1]), 0);
    pu.set([nJoint, cursor, lists[i]!.length], o + 6);
    jlist.set(lists[i]!, cursor);
    cursor += lists[i]!.length;
  });

  // Static colliders.
  const staticBuf = new ArrayBuffer(Math.max(1, statics.length) * STATIC_BYTES);
  const sf = new Float32Array(staticBuf);
  const su = new Uint32Array(staticBuf);
  const si = new Int32Array(staticBuf);
  statics.forEach(([, o], k) => {
    const base = (k * STATIC_BYTES) / 4;
    const point = o.shape === "plane" ? o.point_m : o.center_m;
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = toFixed(point[c]!);
      su[base + c] = lo;
      si[base + 4 + c] = hi;
    }
    const m = contactMaterial(scene, o.physics_material);
    su[base + 3] = o.shape === "plane" ? 1 : 0;
    sf[base + 7] = o.shape === "plane" ? 0 : o.radius_m;
    sf.set([...(o.shape === "plane" ? normalize(o.normal) : [0, 0, 0]), m.restitution, m.static_friction, m.dynamic_friction], base + 8);
  });

  return { jointBuf, jlist, propsBuf, staticBuf, lists };
}

export async function simulate(gpu: Gpu, scene: Scene, plan: ExecutionPlan, faults: PhysicsFaults = {}, candidates: PhysicsCandidates = {}): Promise<PhysicsResult> {
  const p = scene.physics!;
  const layout = physicsLayout(scene);
  const { bodies, contacts, interacting, rotational, statics } = layout;
  const n = bodies.length;
  const h = p.dt_s / p.substeps;

  // Bodies (P0 layout) and orientation state.
  const init = new ArrayBuffer(Math.max(1, n) * BODY_BYTES);
  const dv = new DataView(init);
  const rotInit = new Float32Array(Math.max(1, n) * 8);
  bodies.forEach(([, s], i) => {
    const o = i * BODY_BYTES;
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = toFixed(s.center_m[c]!);
      dv.setUint32(o + 4 * c, lo, true);
      dv.setInt32(o + 16 + 4 * c, hi, true);
      dv.setFloat32(o + 32 + 4 * c, s.body.velocity_m_s[c]!, true);
    }
    dv.setFloat32(o + 28, 1 / s.body.mass_kg, true);
    rotInit.set([...(s.body.orientation ?? [0, 0, 0, 1]), ...(s.body.angular_velocity_rad_s ?? [0, 0, 0]), 0], i * 8);
  });

  const records = recordSteps(p.steps, p.record_every_steps);
  const U = GPUBufferUsage;
  // Orientation and diagnostics only exist where they mean something, so P0-shaped scenes keep the
  // P0 kernel's memory footprint (work counter gpu_bytes_peak, MT3).
  const bodyBuf = gpu.bufferWith(new Uint8Array(init), U.STORAGE | U.COPY_SRC, "bodies");
  const rotBuf = rotational ? gpu.bufferWith(new Uint8Array(rotInit.buffer), U.STORAGE | U.COPY_SRC, "body rotations") : undefined;
  const diagBuf = interacting ? gpu.buffer(Math.max(1, n) * DIAG_BYTES, U.STORAGE | U.COPY_SRC, "physics diagnostics") : undefined;
  const size = Math.max(1, n) * BODY_BYTES;
  const rotSize = rotBuf ? Math.max(1, n) * ROT_BYTES : 0;
  const diagSize = diagBuf ? Math.max(1, n) * DIAG_BYTES : 0;
  const recordSize = size + rotSize + diagSize;
  const staging = gpu.buffer(records.length * recordSize, U.COPY_DST | U.MAP_READ, "physics records");
  const code = kernelSource("physics_p2");
  const constants = { ...faults, ...candidates } as Record<string, number>;
  const groups = Math.max(1, Math.ceil(n / 64));

  const params = (k: number, firstSubstep: number, faultNow: boolean) => {
    const buf = new ArrayBuffer(80);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const g = norm(p.gravity_m_s2);
    // g * h * h in f64, the P0 kernel's order; h = dt exactly when substeps = 1.
    f.set([...p.gravity_m_s2.map((gc) => gc * h * h), h], 0);
    f.set([1 / h, g, 2 * g * h, 0], 4);
    u.set([n, k, firstSubstep, 0x7fc00000], 8);
    u.set([statics.length, contacts ? 1 : 0, p.substeps, faultNow ? 1 : 0], 12);
    f.set([...p.gravity_m_s2.map((gc) => gc * h), 0], 16);
    return gpu.bufferWith(new Uint8Array(buf), U.UNIFORM, "physics params");
  };

  const copyRecord = (enc: GPUCommandEncoder, r: number) => {
    enc.copyBufferToBuffer(bodyBuf, 0, staging, r * recordSize, size);
    if (rotBuf) enc.copyBufferToBuffer(rotBuf, 0, staging, r * recordSize + size, rotSize);
    if (diagBuf) enc.copyBufferToBuffer(diagBuf, 0, staging, r * recordSize + size + rotSize, diagSize);
  };
  {
    const enc = gpu.device.createCommandEncoder();
    copyRecord(enc, 0);
    gpu.device.queue.submit([enc.finish()]);
  }

  const owned: GPUBuffer[] = [];
  let jointLists: number[][] = [];
  if (!interacting) {
    const entry = rotBuf ? "free_main" : "translate_main";
    const pipeline = await gpu.pipeline(code, `physics_p2 ${entry}`, constants, entry);
    let step = 0;
    for (let r = 1; r < records.length; r++) {
      const target = records[r]!;
      while (step < target) {
        const k = Math.min(plan.physics_steps_per_dispatch, target - step);
        const paramBuf = params(k * p.substeps, step * p.substeps, false);
        const enc = gpu.device.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeline);
        cp.setBindGroup(0, bindGroupAt(gpu, pipeline, rotBuf ? [[0, paramBuf], [1, bodyBuf], [2, rotBuf]] : [[0, paramBuf], [1, bodyBuf]]));
        cp.dispatchWorkgroups(groups);
        cp.end();
        gpu.device.queue.submit([enc.finish()]);
        gpu.release(paramBuf);
        step += k;
      }
      const enc = gpu.device.createCommandEncoder();
      copyRecord(enc, r);
      gpu.device.queue.submit([enc.finish()]);
    }
  } else {
    const { jointBuf, jlist, propsBuf, staticBuf, lists } = packSolver(scene, layout);
    jointLists = lists;
    const predBuf = gpu.buffer(Math.max(1, n) * PRED_BYTES, U.STORAGE, "physics prediction");
    const propsGpu = gpu.bufferWith(new Uint8Array(propsBuf), U.STORAGE, "body props");
    const staticGpu = gpu.bufferWith(new Uint8Array(staticBuf), U.STORAGE, "static colliders");
    const jointGpu = gpu.bufferWith(new Uint8Array(jointBuf), U.STORAGE, "joints");
    const jlistGpu = gpu.bufferWith(new Uint8Array(jlist.buffer), U.STORAGE, "joint lists");
    owned.push(predBuf, propsGpu, staticGpu, jointGpu, jlistGpu);
    const normal = params(1, 0, false);
    const flagged = params(1, 0, true);
    owned.push(normal, flagged);
    const all: Record<number, GPUBuffer> = { 1: bodyBuf, 2: rotBuf!, 3: predBuf, 4: propsGpu, 5: staticGpu, 6: jointGpu, 7: jlistGpu, 8: diagBuf! };
    const stage = async (entry: string, bindings: number[]) => {
      const pipeline = await gpu.pipeline(code, `physics_p2 ${entry}`, constants, entry);
      const bind = (u: GPUBuffer) => bindGroupAt(gpu, pipeline, [[0, u], ...bindings.map((b) => [b, all[b]!] as [number, GPUBuffer])]);
      return { pipeline, normal: bind(normal), flagged: bind(flagged) };
    };
    const predict = await stage("predict_main", [1, 2, 3, 4]);
    // Plain Jacobi does not use the constraint counts, so it skips the count pass.
    const solver = candidates.SOLVER ?? DEFAULT_PHYSICS_CANDIDATES.SOLVER;
    const count = contacts && solver !== 1 ? await stage("count_main", [3, 4, 5]) : undefined;
    const solve = await stage("solve_main", [1, 2, 3, 4, 5, 6, 7, 8]);
    const velocity = contacts ? await stage("velocity_main", [1, 2, 3, 4, 5, 8]) : undefined;
    const commit = contacts ? await stage("commit_main", [1, 2, 3]) : undefined;
    const passes = [predict, count, solve, velocity, commit].filter((s) => s !== undefined);

    let step = 0;
    for (let r = 1; r < records.length; r++) {
      const target = records[r]!;
      while (step < target) {
        const k = Math.min(plan.physics_steps_per_dispatch, target - step);
        const enc = gpu.device.createCommandEncoder();
        const cp = enc.beginComputePass();
        for (let s = step; s < step + k; s++) {
          for (let sub = 0; sub < p.substeps; sub++) {
            // FAULT_KIND 5 corrupts the orientation in the last substep of step FAULT_STEP - 1 -> FAULT_STEP.
            const faultNow = faults.FAULT_KIND === 5 && s + 1 === faults.FAULT_STEP && sub === p.substeps - 1;
            for (const st of passes) {
              cp.setPipeline(st.pipeline);
              cp.setBindGroup(0, faultNow && st === solve ? st.flagged : st.normal);
              cp.dispatchWorkgroups(groups);
            }
          }
        }
        cp.end();
        if (step + k === target) copyRecord(enc, r);
        gpu.device.queue.submit([enc.finish()]);
        step += k;
      }
    }
  }

  await staging.mapAsync(GPUMapMode.READ);
  const all = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  gpu.release(staging);
  for (const b of [bodyBuf, ...(rotBuf ? [rotBuf] : []), ...(diagBuf ? [diagBuf] : []), ...owned]) gpu.release(b);
  gpu.throwIfErrors();

  const subs = n * p.steps * p.substeps;
  return {
    ids: bodies.map(([id]) => id),
    masses: bodies.map(([, s]) => s.body.mass_kg),
    radii: bodies.map(([, s]) => s.radius_m),
    interacting,
    rotational,
    records: records.map((s, i) => {
      const o = i * recordSize;
      return {
        step: s,
        raw: all.slice(o, o + n * BODY_BYTES),
        rot: rotBuf ? all.slice(o + size, o + size + n * ROT_BYTES) : new Uint8Array(0),
        diag: diagBuf ? all.slice(o + size + rotSize, o + size + rotSize + n * DIAG_BYTES) : new Uint8Array(0),
      };
    }),
    work: {
      physics_substeps: subs,
      pair_tests: contacts ? n * (n - 1 + statics.length) * p.steps * p.substeps : 0,
      constraint_solves: jointLists.reduce((acc, l) => acc + l.length, 0) * p.steps * p.substeps,
    },
  };
}
