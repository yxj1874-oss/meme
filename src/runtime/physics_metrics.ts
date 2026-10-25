// CPU-side physics quantities of a recorded state (design P2 §3.6), in f64 from the decoded f32 and
// fixed-point words: energies, momenta, penetration and joint residuals. The run writes them into
// metrics.physics and V-Energy(c) and the P2 oracles read them; nothing here feeds back into the run.

import { type Joint, type Quat, type Scene, type Vec3, WORLD } from "../core/scene_types.ts";
import { add, cross, dot, norm, normalize, scale, sub } from "../core/vec.ts";
import { type BodyState, physicsLayout, type RotState } from "./physics.ts";

export interface PhysicsSnapshot {
  ke_j: number;
  ke_rot_j: number;
  pe_j: number;
  pe_spring_j: number;
  e_j: number;
  momentum_kg_m_s: Vec3;
  /** About the centre of mass, including the spin of every body. */
  angular_momentum_kg_m2_s: Vec3;
  max_penetration_m: number;
  joint_residual_m: number;
  joint_residual_rad: number;
}

export function qrot(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
  a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** World position of a joint end, and its orientation. */
function jointEnd(j: Joint, end: "a" | "b", index: Map<string, number>, states: BodyState[], rots: RotState[]): { p: Vec3; q: Quat } {
  const id = j[end];
  const anchor = end === "a" ? j.anchor_a_m : j.anchor_b_m;
  if (id === WORLD) return { p: anchor, q: [0, 0, 0, 1] };
  const i = index.get(id)!;
  const q = rots[i]?.q ?? [0, 0, 0, 1];
  return { p: add(states[i]!.x_m, qrot(q, anchor)), q };
}

type Layout = ReturnType<typeof physicsLayout>;

/** Residuals of one joint at a recorded state: positional (m) and angular (rad). */
export function jointResidual(j: Joint, states: BodyState[], rots: RotState[], initialRots: RotState[], index: Layout["index"]): { m: number; rad: number } {
  const a = jointEnd(j, "a", index, states, rots);
  const b = jointEnd(j, "b", index, states, rots);
  const d = norm(sub(b.p, a.p));
  const m = j.type === "distance" ? Math.abs(d - j.rest_length_m) : d;
  let rad = 0;
  if (j.type === "hinge") {
    const aa = qrot(a.q, normalize(j.axis_a));
    const ab = qrot(b.q, normalize(j.axis_b));
    rad = Math.atan2(norm(cross(aa, ab)), dot(aa, ab));
  } else if (j.type === "fixed") {
    const q0 = (e: "a" | "b"): Quat => (j[e] === WORLD ? [0, 0, 0, 1] : initialRots[index.get(j[e])!]!.q);
    const rest = qmul(qconj(q0("a")), q0("b"));
    const e = qmul(b.q, qconj(qmul(a.q, rest)));
    rad = 2 * Math.atan2(norm([e[0], e[1], e[2]]), Math.abs(e[3]));
  }
  return { m, rad };
}

/**
 * `layout` is physicsLayout(scene), computed once per run by the caller. Without `full` only the
 * energies of translation and gravity are computed (free flight reports nothing else; MT3).
 */
export function physicsSnapshot(scene: Scene, layout: Layout, states: BodyState[], rots: RotState[], initialRots: RotState[], full: boolean): PhysicsSnapshot {
  const { bodies, joints, contacts, statics, index } = layout;
  const g = scene.physics!.gravity_m_s2;
  if (!full) {
    let ke = 0;
    let pe = 0;
    bodies.forEach(([, s], i) => {
      const st = states[i]!;
      ke += 0.5 * s.body.mass_kg * dot(st.v_m_s, st.v_m_s);
      pe -= s.body.mass_kg * dot(g, st.x_m);
    });
    return { ke_j: ke, ke_rot_j: 0, pe_j: pe, pe_spring_j: 0, e_j: ke + pe, momentum_kg_m_s: [0, 0, 0], angular_momentum_kg_m2_s: [0, 0, 0], max_penetration_m: 0, joint_residual_m: 0, joint_residual_rad: 0 };
  }
  let ke = 0;
  let keRot = 0;
  let pe = 0;
  let mass = 0;
  let p: Vec3 = [0, 0, 0];
  let com: Vec3 = [0, 0, 0];
  bodies.forEach(([, s], i) => {
    const m = s.body.mass_kg;
    const inertia = 0.4 * m * s.radius_m * s.radius_m;
    const st = states[i]!;
    const w = rots[i]?.omega_rad_s ?? [0, 0, 0];
    ke += 0.5 * m * dot(st.v_m_s, st.v_m_s);
    keRot += 0.5 * inertia * dot(w, w);
    pe -= m * dot(g, st.x_m);
    mass += m;
    p = add(p, scale(st.v_m_s, m));
    com = add(com, scale(st.x_m, m));
  });
  com = mass > 0 ? scale(com, 1 / mass) : com;
  let l: Vec3 = [0, 0, 0];
  bodies.forEach(([, s], i) => {
    const m = s.body.mass_kg;
    const st = states[i]!;
    const w = rots[i]?.omega_rad_s ?? [0, 0, 0];
    l = add(l, add(scale(cross(sub(st.x_m, com), st.v_m_s), m), scale(w, 0.4 * m * s.radius_m * s.radius_m)));
  });

  let peSpring = 0;
  let resM = 0;
  let resRad = 0;
  for (const [, j] of joints) {
    const r = jointResidual(j, states, rots, initialRots, index);
    if (j.type === "distance" && (j.compliance_m_N ?? 0) > 0) {
      peSpring += (0.5 * r.m * r.m) / j.compliance_m_N!;
    } else {
      resM = Math.max(resM, r.m);
    }
    resRad = Math.max(resRad, r.rad);
  }

  let pen = 0;
  if (contacts) {
    bodies.forEach(([id, s], i) => {
      const x = states[i]!.x_m;
      bodies.forEach(([oid, o], k) => {
        if (oid <= id) return;
        pen = Math.max(pen, s.radius_m + o.radius_m - norm(sub(states[k]!.x_m, x)));
      });
      for (const [, o] of statics) {
        if (o.shape === "plane") pen = Math.max(pen, s.radius_m - dot(normalize(o.normal), sub(x, o.point_m)));
        else pen = Math.max(pen, s.radius_m + o.radius_m - norm(sub(o.center_m, x)));
      }
    });
  }
  return {
    ke_j: ke, ke_rot_j: keRot, pe_j: pe, pe_spring_j: peSpring, e_j: ke + keRot + pe + peSpring,
    momentum_kg_m_s: p, angular_momentum_kg_m2_s: l,
    max_penetration_m: Math.max(0, pen), joint_residual_m: resM, joint_residual_rad: resRad,
  };
}
