// P2 assertion kinds (golden/p2, design P2-01 ②). Physics oracles read the recorded states (exact
// fixed-point positions, f32 velocities) and compare them with closed forms in f64: the exact period
// of a pendulum and the modified equation of the XPBD scheme, the scheme's own closed form for a
// compliant spring, Newton's collision law, rigid-body motion on an incline, conservation laws.
// Tolerances come from the oracle's `tol` and `bounds` (locked by MT5) or are derived here from u.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadSceneText } from "../core/scene.ts";
import type { Scene, Vec3 } from "../core/scene_types.ts";
import { add, cross, dot, norm, normalize, scale, sub } from "../core/vec.ts";
import { DEFAULT_PLAN } from "../runtime/plan.ts";
import { BODY_BYTES, type BodyState, decodeBodies, decodeRot, type RotState, ROT_BYTES, simulate } from "../runtime/physics.ts";
import { type Context, type Kind, one, type Params, type Result, run } from "./assert_util.ts";

const U = 2 ** -23;
const Q32 = 2 ** -32;

interface Track {
  scene: Scene;
  dt: number;
  h: number;
  substeps: number;
  steps: number[];
  states: BodyState[][];
  rots: RotState[][];
  metrics: Record<string, any>[];
  ids: string[];
}

function track(ctx: Context, name: string): Track {
  const r = run(ctx, name);
  const p = r.loaded.scene.physics!;
  const phys = r.output.physics!;
  return {
    scene: r.loaded.scene,
    dt: p.dt_s,
    h: p.dt_s / p.substeps,
    substeps: p.substeps,
    steps: phys.records.map((x) => x.step),
    states: phys.records.map((x) => decodeBodies(x.raw)),
    rots: phys.records.map((x) => decodeRot(x.rot)),
    metrics: (r.output.manifest.deterministic.metrics as any).physics.records,
    ids: phys.ids,
  };
}

const bodyIndex = (t: Track, id: string) => {
  const i = t.ids.indexOf(id);
  if (i < 0) throw new Error(`no body ${id}`);
  return i;
};

/** Complete elliptic integral of the first kind by the arithmetic-geometric mean. */
export function ellipticK(k: number): number {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 40; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

/** Times where a sampled signal crosses zero downward (+ to -), linearly interpolated. */
function downCrossings(t: number[], y: number[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < y.length; k++) {
    if (y[k - 1]! > 0 && y[k]! <= 0) out.push(t[k]! - ((t[k]! - t[k - 1]!) * y[k]!) / (y[k]! - y[k - 1]!));
  }
  return out;
}

/** Swing angle about the y axis of a body hanging from `anchor` (the swing plane is x-z). */
function swingAngles(t: Track, body: number, anchor: Vec3): number[] {
  return t.states.map((s) => {
    const d = sub(s[body]!.x_m, anchor);
    return Math.atan2(d[0], -d[2]);
  });
}

/**
 * Modified equation of the XPBD pendulum (one distance constraint, one projection per substep onto
 * the nearest point of the circle): theta'' = -(g/L) sin(theta) - h (theta'^3 + (g/L) cos(theta) theta').
 * The h terms are the scheme's damping (design P2-02); integrated by RK4 at h/16 and sampled at the
 * record times so the period is measured exactly as on the GPU run.
 */
function modifiedPendulum(theta0: number, gOverL: number, h: number, times: number[]): number[] {
  const f = (th: number, w: number) => [w, -gOverL * Math.sin(th) - h * (w ** 3 + gOverL * Math.cos(th) * w)] as const;
  let th = theta0;
  let w = 0;
  let now = 0;
  const step = h / 16;
  return times.map((target) => {
    while (now < target - step / 2) {
      const a = f(th, w);
      const b = f(th + (step / 2) * a[0], w + (step / 2) * a[1]);
      const c = f(th + (step / 2) * b[0], w + (step / 2) * b[1]);
      const d = f(th + step * c[0], w + step * c[1]);
      th += (step / 6) * (a[0] + 2 * b[0] + 2 * c[0] + d[0]);
      w += (step / 6) * (a[1] + 2 * b[1] + 2 * c[1] + d[1]);
      now += step;
    }
    return th;
  });
}

/**
 * Position rounding accumulated over n substeps (design D15-A): each substep adds the free-flight
 * step and the correction in fixed point (<= 1 quantum q = 2^-32 m each) after rounding them to f32
 * (<= u |dx|); dxMax bounds |dx| per substep.
 */
const positionRounding = (n: number, dxMax: number) => n * (2 * Q32 + 2 * U * dxMax);

export const P2_KINDS: Record<string, Kind> = {
  // G35: period of a point pendulum against the modified equation (absolute) and the exact period.
  pendulum_period: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const anchor = a["anchor_m"] as Vec3;
    const L = a["length_m"] as number;
    const theta0 = a["theta0"] as number;
    const g = norm(t.scene.physics!.gravity_m_s2);
    const w0 = Math.sqrt(g / L);
    const times = t.steps.map((k) => k * t.dt);
    const tMeas = downCrossings(times, swingAngles(t, i, anchor));
    const tMod = downCrossings(times, modifiedPendulum(theta0, g / L, t.h, times));
    const exact = 4 * Math.sqrt(L / g) * ellipticK(Math.sin(theta0 / 2));
    const measured = tMeas[1]! - tMeas[0]!;
    const predicted = tMod[1]! - tMod[0]!;
    // Second-order remainder of the modified equation: 5/24 (w0 h)^2 for the linearized scheme
    // (f64 analysis of the scheme in docs/P2-02, smaller at larger amplitude), plus position rounding
    // over the run turned into time at the zero crossing (angular speed sqrt(2 (g/L)(1 - cos theta0))).
    const nSub = t.steps.at(-1)! * t.substeps;
    const speed = Math.sqrt(2 * g * L * (1 - Math.cos(theta0)));
    // Rounding, two parts: (1) position quantization and f32 steps, turned into time at the zero
    // crossing; (2) the energy's random walk from rounding the velocity each substep (4 roundings
    // enter it, probabilistic model with lambda = 5: dE/E <= 5 * 4u sqrt(n); Higham 2002 §3.4), which
    // shifts the period through its amplitude dependence d ln T / d ln E.
    const periodOf = (th: number) => ellipticK(Math.sin(th / 2));
    const dth = 1e-4;
    const dlnTdlnE = ((Math.log(periodOf(theta0 + dth)) - Math.log(periodOf(theta0 - dth))) / (2 * dth)) * ((1 - Math.cos(theta0)) / Math.sin(theta0));
    const rounding = positionRounding(nSub, speed * t.h) / speed / exact + 5 * 4 * U * Math.sqrt(nSub) * Math.abs(dlnTdlnE);
    const remainder = (5 / 24) * (w0 * t.h) ** 2;
    const tol = remainder + rounding;
    const resid = Math.max(...t.states.map((s) => Math.abs(norm(sub(s[i]!.x_m, anchor)) - L)));
    return [
      { id: `${a["id"]}:period vs modified equation`, pass: Math.abs(measured - predicted) / exact <= tol, measured: { period_s: measured, predicted_s: predicted, rel_diff: (measured - predicted) / exact }, expected: { tol, remainder, rounding } },
      { id: `${a["id"]}:period vs exact`, pass: true, measured: { rel_error: (measured - exact) / exact, exact_s: exact }, detail: "reported: the scheme's O(h) damping shortens the period at finite amplitude" },
      { id: `${a["id"]}:constraint residual`, pass: resid <= 8 * U * L, measured: resid, expected: 8 * U * L },
    ];
  },

  // G35: the period error is first order in h (modified equation): halving h halves it.
  pendulum_order: (ctx, a) => {
    const errs = (a["runs"] as string[]).map((name) => {
      const t = track(ctx, name);
      const i = bodyIndex(t, a["body"]);
      const g = norm(t.scene.physics!.gravity_m_s2);
      const times = t.steps.map((k) => k * t.dt);
      const c = downCrossings(times, swingAngles(t, i, a["anchor_m"]));
      const exact = 4 * Math.sqrt(a["length_m"] / g) * ellipticK(Math.sin(a["theta0"] / 2));
      return (c[1]! - c[0]! - exact) / exact;
    });
    const ratio = errs[0]! / errs[1]!;
    const [lo, hi] = a["ratio"] as [number, number];
    return one(a, ratio >= lo && ratio <= hi, { rel_errors: errs, ratio }, [lo, hi]);
  },

  // G36: physical pendulum (ball joint off the centre): the exact period with I_p = 2/5 m r^2 + m d^2.
  physical_pendulum: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const anchor = a["anchor_m"] as Vec3;
    const sphere = t.scene.objects[a["body"]] as { radius_m: number; body: { mass_kg: number } };
    const r = sphere.radius_m;
    const d = a["pivot_distance_m"] as number;
    const g = norm(t.scene.physics!.gravity_m_s2);
    const ip = 0.4 * r * r + d * d; // per unit mass
    const exact = 4 * Math.sqrt(ip / (g * d)) * ellipticK(Math.sin(a["theta0"] / 2));
    const times = t.steps.map((k) => k * t.dt);
    const c = downCrossings(times, swingAngles(t, i, anchor));
    const measured = c[1]! - c[0]!;
    const resid = Math.max(...t.metrics.map((m) => m["joint_residual_m"] as number));
    const tol = a["tol"]["value"] as number;
    return [
      { id: `${a["id"]}:period`, pass: Math.abs(measured - exact) / exact <= tol, measured: { period_s: measured, exact_s: exact, rel_error: (measured - exact) / exact }, expected: tol },
      { id: `${a["id"]}:joint residual`, pass: resid <= a["bounds"]["residual_m"]["value"], measured: resid, expected: a["bounds"]["residual_m"]["value"] },
    ];
  },

  // G37: a compliant distance joint is the scheme x_{n+1} = (x_n + h v_n) / (1 + w^2 h^2),
  // v_{n+1} = (x_{n+1} - x_n) / h with w^2 = 1 / (m alpha) (XPBD alpha~ = alpha / h^2): compared in closed form.
  spring_scheme: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const anchor = a["anchor_m"] as Vec3;
    const sphere = t.scene.objects[a["body"]] as { body: { mass_kg: number } };
    const joint = Object.values(t.scene.joints!)[0] as { rest_length_m: number; compliance_m_N: number };
    const w2 = 1 / (sphere.body.mass_kg * joint.compliance_m_N);
    const ext = (s: BodyState) => norm(sub(s.x_m, anchor)) - joint.rest_length_m;
    let x = ext(t.states[0]![i]!);
    let v = 0;
    let k = 0;
    let worst = 0;
    let dxMax = 0;
    const want: number[] = [];
    for (let rec = 0; rec < t.steps.length; rec++) {
      for (; k < t.steps[rec]! * t.substeps; k++) {
        const nx = (x + t.h * v) / (1 + w2 * t.h * t.h);
        dxMax = Math.max(dxMax, Math.abs(nx - x));
        v = (nx - x) / t.h;
        x = nx;
      }
      want.push(x);
      worst = Math.max(worst, Math.abs(ext(t.states[rec]![i]!) - x));
    }
    // Rounding: fixed point and f32 steps as for G35, plus the f32 rounding of the 1 m offset to the
    // anchor in each substep's constraint (u L), which the compliance does not re-project away.
    const nSub = t.steps.at(-1)! * t.substeps;
    const tol = positionRounding(nSub, dxMax) + nSub * U * joint.rest_length_m * Math.sqrt(w2) * t.h;
    const T = (2 * Math.PI * t.h) / Math.atan(Math.sqrt(w2) * t.h);
    return [
      { id: `${a["id"]}:trajectory`, pass: worst <= tol, measured: worst, expected: tol },
      { id: `${a["id"]}:period`, pass: true, measured: { scheme_period_s: T, exact_s: (2 * Math.PI) / Math.sqrt(w2), amplitude_ratio_per_s: (1 + w2 * t.h * t.h) ** (-0.5 / t.h) }, detail: "reported: T = 2 pi h / atan(w h), amplitude factor (1 + w^2 h^2)^(-1/2) per substep" },
    ];
  },

  // G38: apex heights of a bouncing sphere: H_{k+1} / H_k = e^2 (Newton), e = 0: no bounce.
  bounce_heights: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const r = (t.scene.objects[a["body"]] as { radius_m: number }).radius_m;
    const e = a["restitution"] as number;
    const g = norm(t.scene.physics!.gravity_m_s2);
    const z = t.states.map((s) => s[i]!.x_m[2] - r);
    // Apexes: local maxima, refined by a parabola through the three records around them.
    const apex: number[] = [];
    for (let k = 1; k + 1 < z.length; k++) {
      if (z[k]! > z[k - 1]! && z[k]! >= z[k + 1]! && z[k]! > 1e-3) {
        const denom = z[k - 1]! - 2 * z[k]! + z[k + 1]!;
        apex.push(denom < 0 ? z[k]! - (z[k + 1]! - z[k - 1]!) ** 2 / (8 * denom) : z[k]!);
      }
    }
    const heights = [z[0]!, ...apex];
    const results: Result[] = [];
    if (e === 0) {
      const firstContact = z.findIndex((v) => v < 1e-3);
      const after = z.slice(firstContact);
      const speedAfter = t.states.slice(firstContact + 1).map((s) => norm(s[i]!.v_m_s));
      const vTol = 2 * g * t.h;
      results.push({ id: `${a["id"]}:no bounce`, pass: Math.max(...after) <= g * t.h * t.h + 8 * U && Math.max(...speedAfter) <= vTol, measured: { max_height_m: Math.max(...after), max_speed_m_s: Math.max(...speedAfter) }, expected: { height_m: g * t.h * t.h + 8 * U, speed_m_s: vTol } });
      return results;
    }
    const count = Math.min(a["bounces"] as number, heights.length - 1);
    for (let k = 0; k < count; k++) {
      // The scheme's discrete apex after leaving with speed w: positions x_n = x_0 + h (n w - g h n(n+1)/2),
      // a parabola in n whose maximum is w^2 / 2g - w h / 2 + g h^2 / 8 (the parabola refinement through
      // three records finds it exactly). w = e v with v the pre-solve approach speed, which is within
      // [v_k - g h, v_k + 2 g h] of v_k = sqrt(2 g H_k) (the fall is discretized the same way).
      const v = Math.sqrt(2 * g * heights[k]!);
      const want = (e * v) ** 2 / (2 * g) - (e * v * t.h) / 2;
      const tol = 2 * e * e * v * t.h + 2 * e * e * g * t.h * t.h + g * t.h * t.h + 8 * U;
      results.push({ id: `${a["id"]}:bounce ${k + 1}`, pass: Math.abs(heights[k + 1]! - want) <= tol, measured: { height_m: heights[k + 1], ratio: heights[k + 1]! / heights[k]! }, expected: { height_m: want, tol } });
    }
    if (count < (a["bounces"] as number)) results.push({ id: `${a["id"]}:bounces found`, pass: false, measured: count, expected: a["bounces"] });
    return results;
  },

  // G39: two smooth spheres, zero gravity: Newton's law along the impact normal, tangential velocity kept.
  collision: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const [ia, ib] = (a["bodies"] as string[]).map((b) => bodyIndex(t, b)) as [number, number];
    const ob = (id: string) => t.scene.objects[id] as { center_m: Vec3; radius_m: number; body: { mass_kg: number; velocity_m_s: Vec3 } };
    const A = ob(a["bodies"][0]);
    const B = ob(a["bodies"][1]);
    const e = a["restitution"] as number;
    const ma = A.body.mass_kg;
    const mb = B.body.mass_kg;
    // Exact impact: first time |xb - xa| = ra + rb on the straight paths.
    const dx = sub(B.center_m, A.center_m);
    const dv = sub(B.body.velocity_m_s, A.body.velocity_m_s);
    const R = A.radius_m + B.radius_m;
    const qa = dot(dv, dv);
    const qb = 2 * dot(dx, dv);
    const qc = dot(dx, dx) - R * R;
    const tImpact = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
    const n = normalize(add(dx, scale(dv, tImpact)));
    const van = dot(A.body.velocity_m_s, n);
    const vbn = dot(B.body.velocity_m_s, n);
    const vanAfter = (ma * van + mb * vbn - mb * e * (van - vbn)) / (ma + mb);
    const vbnAfter = (ma * van + mb * vbn + ma * e * (van - vbn)) / (ma + mb);
    const wantA = add(A.body.velocity_m_s, scale(n, vanAfter - van));
    const wantB = add(B.body.velocity_m_s, scale(n, vbnAfter - vbn));
    const end = t.states.at(-1)!;
    const errA = norm(sub(end[ia]!.v_m_s, wantA));
    const errB = norm(sub(end[ib]!.v_m_s, wantB));
    const vrel = Math.sqrt(qa);
    // The contact is found one substep after touching at the latest, so its normal is off by at most
    // the angle the line of centres turns in h, |v_rel| h / R; head-on that angle is zero. Velocities:
    // 32 u relative for the dozen f32 operations of one contact.
    const angle = a["head_on"] ? 0 : (vrel * t.h) / R;
    const tol = 2 * vrel * angle + 32 * U * vrel;
    const p0 = add(scale(A.body.velocity_m_s, ma), scale(B.body.velocity_m_s, mb));
    const p1 = add(scale(end[ia]!.v_m_s, ma), scale(end[ib]!.v_m_s, mb));
    const pScale = ma * norm(A.body.velocity_m_s) + mb * norm(B.body.velocity_m_s);
    const pTol = 8 * U * pScale * t.steps.at(-1)! * t.substeps;
    return [
      { id: `${a["id"]}:velocities`, pass: Math.max(errA, errB) <= tol, measured: { a: end[ia]!.v_m_s, b: end[ib]!.v_m_s, err: Math.max(errA, errB) }, expected: { a: wantA, b: wantB, tol } },
      { id: `${a["id"]}:momentum`, pass: norm(sub(p1, p0)) <= pTol, measured: norm(sub(p1, p0)), expected: pTol },
    ];
  },

  // G40: a sphere on an incline: rolling (a = 5/7 g sin) or sliding (a = g (sin - mu_d cos), spin
  // alpha = 5 mu_d g cos / 2r); positions follow the scheme's s_n = a t_n (t_n + h) / 2 exactly.
  incline: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const sphere = t.scene.objects[a["body"]] as { radius_m: number };
    const plane = t.scene.objects[a["plane"]] as { normal: Vec3 };
    const n = normalize(plane.normal);
    const gv = t.scene.physics!.gravity_m_s2;
    const g = norm(gv);
    const gt = sub(gv, scale(n, dot(gv, n)));
    const down = normalize(gt);
    const sin = norm(gt) / g;
    const cos = Math.sqrt(1 - sin * sin);
    const roll = a["regime"] === "roll";
    const acc = roll ? (5 / 7) * g * sin : g * (sin - a["mu_d"] * cos);
    const x0 = t.states[0]![i]!.x_m;
    let worst = 0;
    t.states.forEach((s, rec) => {
      const tt = t.steps[rec]! * t.dt;
      const want = 0.5 * acc * tt * (tt + t.h);
      worst = Math.max(worst, Math.abs(dot(sub(s[i]!.x_m, x0), down) - want));
    });
    const end = t.states.at(-1)!;
    const tEnd = t.steps.at(-1)! * t.dt;
    const nSub = t.steps.at(-1)! * t.substeps;
    // Rounding of the free-flight and correction steps, plus the first substep's settling into the
    // plane (|g| h^2), which shifts the start of the motion by at most one substep.
    const tol = positionRounding(nSub, acc * tEnd * t.h) + g * t.h * t.h + acc * tEnd * t.h;
    const omega = t.rots.at(-1)![i]!.omega_rad_s;
    const contactVel = add(end[i]!.v_m_s, cross(omega, scale(n, -sphere.radius_m)));
    const slip = norm(contactVel);
    const out: Result[] = [{ id: `${a["id"]}:distance`, pass: worst <= tol, measured: worst, expected: tol }];
    if (roll) {
      // Rolling: the contact point is at rest up to the per-substep gravity increment.
      out.push({ id: `${a["id"]}:no slip`, pass: slip <= 2 * g * t.h, measured: slip, expected: 2 * g * t.h });
    } else {
      const alpha = (5 * a["mu_d"] * g * cos) / (2 * sphere.radius_m);
      const spin = norm(omega);
      const spinTol = alpha * t.h * 2 + 32 * U * spin;
      out.push({ id: `${a["id"]}:spin`, pass: Math.abs(spin - alpha * tEnd) <= spinTol, measured: spin, expected: { omega_rad_s: alpha * tEnd, tol: spinTol } });
      out.push({ id: `${a["id"]}:slipping`, pass: slip > 10 * g * t.h, measured: slip, expected: `> ${10 * g * t.h}` });
    }
    return out;
  },

  // G40: rolling below the critical angle tan(theta_c) = 3.5 mu_s, slipping above it.
  incline_regime: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const i = bodyIndex(t, a["body"]);
    const r = (t.scene.objects[a["body"]] as { radius_m: number }).radius_m;
    const n = normalize((t.scene.objects[a["plane"]] as { normal: Vec3 }).normal);
    const end = t.states.at(-1)![i]!;
    const slip = norm(add(end.v_m_s, cross(t.rots.at(-1)![i]!.omega_rad_s, scale(n, -r))));
    const g = norm(t.scene.physics!.gravity_m_s2);
    const rolls = slip <= 2 * g * t.h;
    return one(a, rolls === (a["expect"] === "roll"), { slip_m_s: slip, regime: rolls ? "roll" : "slide" }, a["expect"]);
  },

  // G41: resting contacts and stacks: penetration requirement, rest speed, energy, exact symmetry.
  stack: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const r = Math.min(...t.ids.map((id) => (t.scene.objects[id] as { radius_m: number }).radius_m));
    const pen = Math.max(...t.metrics.map((m) => m["max_penetration_m"] as number));
    const penTol = a["tol"]["value"] * r;
    const g = norm(t.scene.physics!.gravity_m_s2);
    const vEnd = Math.max(...t.states.at(-1)!.map((s) => norm(s.v_m_s)));
    const e0 = t.metrics[0]!["e_j"] as number;
    const eMax = Math.max(...t.metrics.map((m) => m["e_j"] as number));
    const eScale = Math.max(...t.metrics.map((m) => Math.abs(m["pe_j"] as number)));
    const nSub = t.steps.at(-1)! * t.substeps;
    const lateral = t.states.every((s) => s.every((b) => b.x_m[0] === 0 && b.x_m[1] === 0 && b.v_m_s[0] === 0 && b.v_m_s[1] === 0));
    return [
      { id: `${a["id"]}:penetration`, pass: pen <= penTol, measured: { max_penetration_m: pen, per_radius: pen / r }, expected: penTol },
      // At rest a body's velocity is what one substep of gravity leaves before the next correction.
      { id: `${a["id"]}:at rest`, pass: vEnd <= 2 * g * t.h, measured: vEnd, expected: 2 * g * t.h },
      // Energy: never above the start, up to 16 u per substep on the potential energy scale.
      { id: `${a["id"]}:energy`, pass: eMax <= e0 + 16 * U * nSub * eScale, measured: { e0_j: e0, e_max_j: eMax }, expected: e0 + 16 * U * nSub * eScale },
      ...(a["column"] ? [{ id: `${a["id"]}:symmetry`, pass: lateral, measured: lateral, expected: "x, y and their velocities exactly 0" }] : []),
    ];
  },

  // G42: linear momentum of colliding bodies with no external force.
  momentum: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const masses = t.ids.map((id) => (t.scene.objects[id] as { body: { mass_kg: number } }).body.mass_kg);
    const p = t.states.map((s) => s.reduce((acc, b, k) => add(acc, scale(b.v_m_s, masses[k]!)), [0, 0, 0] as Vec3));
    const pScale = Math.max(...t.states.map((s) => s.reduce((acc, b, k) => acc + masses[k]! * norm(b.v_m_s), 0)));
    let worst = 0;
    let pass = true;
    t.steps.forEach((step, rec) => {
      // Each substep rounds every velocity once (v = dx / h in f32): <= 2 u |v| per body.
      const tol = 2 * U * step * t.substeps * pScale;
      const d = norm(sub(p[rec]!, p[0]!));
      worst = Math.max(worst, d / Math.max(tol, 1e-300));
      if (!(d <= tol)) pass = false;
    });
    const l = t.metrics.map((m) => m["angular_momentum_kg_m2_s"] as Vec3);
    return [
      { id: `${a["id"]}:linear momentum`, pass, measured: { worst_ratio_to_tol: worst, p_end: p.at(-1) }, expected: "|p(t) - p(0)| <= 2 u substeps max sum m|v|" },
      { id: `${a["id"]}:angular momentum`, pass: true, measured: { change: norm(sub(l.at(-1)!, l[0]!)), scale: norm(l[0]!) }, detail: "reported: corrections act along the predicted line of centres, so L about the centre of mass is conserved to O(h)" },
    ];
  },

  // G43: joint residuals stay within the requirement; momentum and spin about the hinge axis are kept.
  joints: (ctx, a) => {
    const t = track(ctx, a["run"]);
    const resM = Math.max(...t.metrics.map((m) => m["joint_residual_m"] as number));
    const resRad = Math.max(...t.metrics.map((m) => m["joint_residual_rad"] as number));
    const out: Result[] = [
      { id: `${a["id"]}:position residual`, pass: resM <= a["bounds"]["residual_m"]["value"], measured: resM, expected: a["bounds"]["residual_m"]["value"] },
      { id: `${a["id"]}:angle residual`, pass: resRad <= a["bounds"]["residual_rad"]["value"], measured: resRad, expected: a["bounds"]["residual_rad"]["value"] },
    ];
    if (a["axis"] !== undefined) {
      const i = bodyIndex(t, a["body"]);
      const axis = normalize(a["axis"]);
      const w0 = dot(t.rots[0]![i]!.omega_rad_s, axis);
      const spin = t.rots.map((r) => dot(r[i]!.omega_rad_s, axis));
      const perp = Math.max(...t.rots.slice(1).map((r) => norm(sub(r[i]!.omega_rad_s, scale(axis, dot(r[i]!.omega_rad_s, axis))))));
      const drift = Math.max(...spin.map((s) => Math.abs(s - w0)));
      out.push({ id: `${a["id"]}:spin about the axis`, pass: drift <= a["bounds"]["spin_rel"]["value"] * Math.abs(w0), measured: { drift, w0 }, expected: a["bounds"]["spin_rel"]["value"] * Math.abs(w0) });
      out.push({ id: `${a["id"]}:spin off the axis`, pass: perp <= a["bounds"]["off_axis_rad_s"]["value"], measured: perp, expected: a["bounds"]["off_axis_rad_s"]["value"] });
    }
    return out;
  },

  // G44: the same scene shifted by an exact whole number of metres moves the same, bit for bit.
  translation_invariance: (ctx, a) => {
    const [ra, rb] = (a["runs"] as string[]).map((n) => run(ctx, n).output.physics!);
    const off = a["offset_m"] as Vec3;
    let differing = 0;
    ra!.records.forEach((rec, k) => {
      const wa = new Int32Array(rec.raw.buffer.slice(rec.raw.byteOffset, rec.raw.byteOffset + rec.raw.byteLength));
      const other = rb!.records[k]!.raw;
      const wb = new Int32Array(other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength));
      for (let b = 0; b * 12 < wa.length; b++) {
        for (let w = 0; w < 12; w++) {
          const expect = w >= 4 && w < 7 ? wa[b * 12 + w]! + off[w - 4]! : wa[b * 12 + w]!;
          if (wb[b * 12 + w] !== expect) differing++;
        }
      }
      const qa = rec.rot;
      const qb = rb!.records[k]!.rot;
      for (let j = 0; j < qa.length; j++) if (qa[j] !== qb[j]) differing++;
    });
    return one(a, differing === 0, { differing_words: differing, records: ra!.records.length });
  },

  // G44: two spheres with the same centre (only reachable by tunnelling; bypasses E_INITIAL_OVERLAP):
  // finite, reproducible, and pushed apart symmetrically along the fallback normal +z.
  coincident_centres: async (ctx, a) => {
    const base = loadSceneText(readFileSync(join(ctx.dir, a["scene"]), "utf8")).scene;
    const scene = structuredClone(base);
    for (const id of a["bodies"] as string[]) (scene.objects[id] as { center_m: Vec3 }).center_m = [...(a["centre_m"] as Vec3)];
    const sim = () => simulate(ctx.gpu, scene, DEFAULT_PLAN);
    const r1 = await sim();
    const r2 = await sim();
    const last = r1.records.at(-1)!;
    const same = r1.records.every((rec, k) => rec.raw.every((b, j) => b === r2.records[k]!.raw[j]));
    const s = decodeBodies(last.raw);
    const [i, j] = (a["bodies"] as string[]).map((b) => r1.ids.indexOf(b)) as [number, number];
    const finite = s.every((b) => [...b.x_m, ...b.v_m_s].every(Number.isFinite));
    const mid = scale(add(s[i]!.x_m, s[j]!.x_m), 0.5);
    const along = sub(s[j]!.x_m, s[i]!.x_m);
    const symmetric = norm(sub(mid, a["centre_m"])) <= 4 * Q32 && Math.abs(along[0]) <= 4 * Q32 && Math.abs(along[1]) <= 4 * Q32 && along[2] > 0;
    return one(a, finite && same && symmetric, { finite, reproducible: same, midpoint_m: mid, separation_m: along });
  },

  // G45: a body that touches nothing does not change any byte of the others.
  physics_locality: (ctx, a) => {
    const base = run(ctx, a["base"]).output.physics!;
    const more = run(ctx, a["with_extra"]).output.physics!;
    let differing = 0;
    base.records.forEach((rec, k) => {
      const other = more.records[k]!;
      base.ids.forEach((id, i) => {
        const j = more.ids.indexOf(id);
        for (let b = 0; b < BODY_BYTES; b++) if (rec.raw[i * BODY_BYTES + b] !== other.raw[j * BODY_BYTES + b]) differing++;
        for (let b = 0; b < ROT_BYTES; b++) if (rec.rot[i * ROT_BYTES + b] !== other.rot[j * ROT_BYTES + b]) differing++;
      });
    });
    return one(a, differing === 0, { differing_bytes: differing, bodies: base.ids.length, records: base.records.length });
  },
};
