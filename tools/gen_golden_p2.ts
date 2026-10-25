// Generates golden/p2/*: the P2 goldens G35-G47 (docs/P2-01-design.md ②), bound to schema v3.
// golden/p2/g46_migration_v2_v3/p1_snapshot.json is not generated here: it freezes the p0 and p1
// image, AOV and state hashes as recorded at the end of P1 and must never be regenerated.
// Usage: node tools/gen_golden_p2.ts [--check]

import { HarnessRng, STREAM } from "../src/core/rng.ts";
import { emitSet, type GoldenDef, json, tol } from "./golden_lib.ts";

const ROOT = new URL("../golden/p2/", import.meta.url).pathname;
const check = process.argv.includes("--check");

type Vec3 = [number, number, number];
const U = "u = 2^-23 (WGSL rounding direction unspecified, §15.7.4: faithful rounding)";
const G = 9.81;

const mat = { m: { base_color: [0.6, 0.6, 0.6] } };
const ball = (center: Vec3, r: number, mass: number, o: { v?: Vec3; w?: Vec3; q?: [number, number, number, number]; pm?: string } = {}) => ({
  shape: "sphere", center_m: center, radius_m: r, material: "m",
  ...(o.pm ? { physics_material: o.pm } : {}),
  body: { mass_kg: mass, velocity_m_s: o.v ?? [0, 0, 0], ...(o.w ? { angular_velocity_rad_s: o.w } : {}), ...(o.q ? { orientation: o.q } : {}) },
});
const plane = (point: Vec3, normal: Vec3, pm?: string) => ({ shape: "plane", point_m: point, normal, material: "m", ...(pm ? { physics_material: pm } : {}) });
const physics = (dt: number, substeps: number, steps: number, every: number, contacts: "none" | "all_pairs", g: Vec3 = [0, 0, -G]) =>
  ({ integrator: "xpbd_p2", gravity_m_s2: g, dt_s: dt, substeps, steps, record_every_steps: every, contacts });
const scene = (seed: number, parts: Record<string, unknown>) => ({ v: 3, seed, materials: mat, ...parts });
const ellipticK = (k: number) => {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 40; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
};
const out: GoldenDef[] = [];

// G35 ---------------------------------------------------------------------------------------------
const anchor35: Vec3 = [0, 0, 1];
const pendulum = (theta0: number, substeps: number) => {
  const T = 4 * Math.sqrt(1 / G) * ellipticK(Math.sin(theta0 / 2));
  return scene(3500, {
    objects: { bob: ball([Math.sin(theta0), 0, 1 - Math.cos(theta0)], 0.05, 1) },
    joints: { rod: { type: "distance", a: "world", b: "bob", anchor_a_m: anchor35, anchor_b_m: [0, 0, 0], rest_length_m: 1 } },
    physics: physics(0.002, substeps, Math.ceil((1.35 * T + 0.1) / 0.002), 5, "none"),
  });
};
const thetas35 = [0.3, 1.0];
out.push({
  id: "g35_pendulum_period",
  title: "Point pendulum on a distance joint: period against the XPBD modified equation, first-order convergence to the exact elliptic period",
  covers: ["joints.distance", "convergence", "analytic.pendulum"],
  kills: ["alpha-not-over-h2", "joint-gradient-sign", "mass-splitting-count"],
  files: Object.fromEntries(thetas35.flatMap((th) => [2, 4].map((s) => [`scene_t${th * 10}_s${s}.json`, json(pendulum(th, s))]))),
  runs: thetas35.flatMap((th) => [2, 4].map((s) => ({ name: `t${th * 10}_s${s}`, scene: `scene_t${th * 10}_s${s}.json` }))),
  asserts: [
    ...thetas35.flatMap((th) => [2, 4].map((s) => ({
      id: `A1.t${th * 10}_s${s}`, kind: "pendulum_period", run: `t${th * 10}_s${s}`, body: "bob", anchor_m: anchor35, length_m: 1, theta0: th,
      tol: tol(null, "|T - T_mod| / T_exact <= 5/24 (w0 h)^2 + rounding, T_mod from the modified equation theta'' = -(g/L) sin - h (theta'^3 + (g/L) cos theta'); 5/24 is the scheme's second-order period remainder of the linearized equation (f64 analysis in docs/P2-02); rounding: per substep 2 quanta of fixed point and 2u of the f32 step, as time at the zero crossing, plus the energy random walk of velocity rounding (5 x 4u sqrt(substeps), Higham 2002 §3.4) times d ln T / d ln E; residual 8u L (the 1 m offset to the anchor is rounded once per substep)", "Hairer, Lubich, Wanner, Geometric Numerical Integration, ch. IX (modified equations); exact period 4 sqrt(L/g) K(sin(theta0/2))"),
    }))),
    ...thetas35.map((th) => ({
      id: `A2.t${th * 10}`, kind: "pendulum_order", runs: [`t${th * 10}_s2`, `t${th * 10}_s4`], body: "bob", anchor_m: anchor35, length_m: 1, theta0: th, ratio: [1.8, 2.2],
      tol: tol(0.2, "the modified equation's damping makes the period error first order in h (ratio 2 for h -> h/2); second-order terms move it by <= 0.05 (f64 analysis: 1.95-1.98) and rounding by <= 2 rounding / error", "modified equation (this design); f64 analysis of the scheme"),
    })),
  ],
});

// G36 ---------------------------------------------------------------------------------------------
const r36 = 0.2;
const th36 = 0.05;
const anchor36: Vec3 = [0, 0, 1];
const physical = (substeps: number) => scene(3600, {
  objects: { s: ball([r36 * Math.sin(th36), 0, 1 - r36 * Math.cos(th36)], r36, 2, { q: [0, -Math.sin(th36 / 2), 0, Math.cos(th36 / 2)] }) },
  joints: { pin: { type: "ball", a: "world", b: "s", anchor_a_m: anchor36, anchor_b_m: [0, 0, r36] } },
  physics: physics(0.002, substeps, 770, 5, "none"),
});
const h36 = 0.002 / 4;
out.push({
  id: "g36_physical_pendulum_ball_joint",
  title: "Solid sphere hung by a ball joint at its top: period 4 sqrt(I_p / (m g d)) K(sin(theta0/2)) with I_p = 2/5 m r^2 + m r^2",
  covers: ["joints.ball", "rotation", "analytic.pendulum"],
  kills: ["inertia-missing", "angular-correction-sign", "omega-from-quaternion"],
  files: { "scene.json": json(physical(4)) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [{
    id: "A1", kind: "physical_pendulum", run: "a", body: "s", anchor_m: anchor36, pivot_distance_m: r36, theta0: th36,
    tol: tol(1e-4, "requirement: 1e-4 of the period at h = 0.5 ms; a wrong inertia moves it by >= 1e-2 (point mass: 2 pi sqrt(d/g) is 15% shorter)", "parallel-axis theorem; exact pendulum period"),
    bounds: { residual_m: tol(4 * G * h36 * h36, "per substep gravity sags the anchor by g h^2 before the correction; the 1D projection along the error leaves at most the same again across it through the rotation coupling: 2 g h^2, doubled for rounding and the period-2 mode of the coupling", "XPBD positional constraint (Müller et al. 2020 §3.3.1)") },
  }],
});

// G37 ---------------------------------------------------------------------------------------------
out.push({
  id: "g37_compliant_spring",
  title: "Compliant distance joint as a spring: the trajectory is the scheme's closed form x' = (x + h v) / (1 + w^2 h^2)",
  covers: ["joints.compliance"],
  kills: ["alpha-not-over-h2"],
  files: { "scene.json": json(scene(3700, {
    objects: { s: ball([1.1, 0, 0], 0.05, 2) },
    joints: { spring: { type: "distance", a: "world", b: "s", anchor_a_m: [0, 0, 0], anchor_b_m: [0, 0, 0], rest_length_m: 1, compliance_m_N: 1e-3 } },
    physics: physics(0.001, 4, 1000, 10, "none", [0, 0, 0]),
  })) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [{
    id: "A1", kind: "spring_scheme", run: "a", body: "s", anchor_m: [0, 0, 0],
    tol: tol(null, "position rounding over the run (2 quanta + 2u|dx| per substep) plus the f32 rounding of the 1 m anchor offset (u L) amplified by the spring over a substep (w h)", "XPBD compliance alpha~ = alpha / h^2 (Macklin et al. 2016); closed form of the scheme"),
  }],
});

// G38 ---------------------------------------------------------------------------------------------
const drop = (e: number, steps: number) => scene(3800, {
  physics_materials: { p: { restitution: e } },
  objects: { ball: ball([0, 0, 1.1], 0.1, 1, { pm: "p" }), floor: plane([0, 0, 0], [0, 0, 1], "p") },
  physics: physics(0.002, 4, steps, 5, "all_pairs"),
});
const drops: [number, number, number][] = [[0, 1, 400], [0.3, 2, 800], [0.7, 4, 1600], [1, 5, 2600]];
out.push({
  id: "g38_restitution_drop",
  title: "Sphere dropped on a plane: apex heights H_k+1 / H_k = e^2; e = 0 does not bounce",
  covers: ["contacts.restitution"],
  kills: ["restitution-post-solve-velocity", "restitution-threshold-off"],
  files: Object.fromEntries(drops.map(([e, , steps]) => [`scene_e${e * 10}.json`, json(drop(e, steps))])),
  runs: drops.map(([e]) => ({ name: `e${e * 10}`, scene: `scene_e${e * 10}.json` })),
  asserts: drops.map(([e, bounces]) => ({
    id: `A1.e${e * 10}`, kind: "bounce_heights", run: `e${e * 10}`, body: "ball", restitution: e, bounces,
    tol: tol(null, "H_k+1 = (e v)^2 / 2g - e v h / 2 (the scheme's discrete apex after leaving at e v, v = sqrt(2 g H_k)) within 2 e^2 v h + 2 e^2 g h^2 + g h^2 + 8u: the pre-solve approach speed is within [v - g h, v + 2 g h]; apexes are refined by a parabola through three records, exact for the scheme's free flight; e = 0: height after contact <= g h^2, speed <= 2 g h (the restitution threshold)", "Newton's law of restitution; Müller et al. 2020 §3.6"),
  })),
});

// G39 ---------------------------------------------------------------------------------------------
const collide = (m2: number, e: number, offset: number) => scene(3900, {
  physics_materials: { p: { restitution: e } },
  objects: { a: ball([-0.5, 0, 0], 0.1, 1, { v: [2, 0, 0], pm: "p" }), b: ball([0.5, offset, 0], 0.1, m2, { pm: "p" }) },
  physics: physics(0.002, 4, 250, 250, "all_pairs", [0, 0, 0]),
});
const cases39: [string, number, number, number][] = [["m1_e10", 1, 1, 0], ["m3_e10", 3, 1, 0], ["m3_e5", 3, 0.5, 0], ["m100_e10", 100, 1, 0], ["m100_e5", 100, 0.5, 0], ["oblique", 1, 1, 0.1]];
out.push({
  id: "g39_two_sphere_collision",
  title: "Two smooth spheres, no gravity: Newton's law along the impact normal, tangential velocity kept, momentum kept",
  covers: ["contacts.sphere", "contacts.restitution", "conservation.momentum"],
  kills: ["mass-splitting-count", "contact-normal-sign", "lambda-not-symmetric"],
  files: Object.fromEntries(cases39.map(([n, m2, e, off]) => [`scene_${n}.json`, json(collide(m2, e, off))])),
  runs: cases39.map(([n]) => ({ name: n, scene: `scene_${n}.json` })),
  asserts: cases39.map(([n, , e, off]) => ({
    id: `A1.${n}`, kind: "collision", run: n, bodies: ["a", "b"], restitution: e, head_on: off === 0,
    tol: tol(null, "velocities: 32u |v_rel| for one contact's f32 operations, plus 2 |v_rel| times the normal's angle error |v_rel| h / (r_a + r_b) when oblique (the contact is found within one substep of touching); momentum: 8u sum m|v| per substep", "Newton's experimental law; momentum conservation of equal and opposite corrections"),
  })),
});

// G40 ---------------------------------------------------------------------------------------------
const incline = (deg: number, mus: number, mud: number) => {
  const th = (deg * Math.PI) / 180;
  const n: Vec3 = [Math.sin(th), 0, Math.cos(th)];
  return scene(4000, {
    physics_materials: { f: { static_friction: mus, dynamic_friction: mud } },
    objects: { ball: ball([n[0] * 0.1, 0, n[2] * 0.1], 0.1, 1, { pm: "f" }), ramp: plane([0, 0, 0], n, "f") },
    physics: physics(0.002, 4, 250, 25, "all_pairs"),
  });
};
const crit = (Math.atan(3.5 * 0.15) * 180) / Math.PI;
const cases40: [string, number, number, number, string][] = [
  ["roll", 20, 0.6, 0.5, "roll"], ["slide", 30, 0.1, 0.08, "slide"],
  ["below", Math.round((crit - 2) * 100) / 100, 0.15, 0.1, "roll"], ["above", Math.round((crit + 2) * 100) / 100, 0.15, 0.1, "slide"],
];
out.push({
  id: "g40_rolling_incline",
  title: "Sphere on an incline: rolls with a = 5/7 g sin, slides with a = g (sin - mu_d cos) and spin 5 mu_d g cos / 2r; the regime flips at tan(theta_c) = 3.5 mu_s",
  covers: ["contacts.friction", "rotation", "analytic.rigid"],
  kills: ["friction-impulse-as-velocity", "static-friction-off", "friction-mu-mixup"],
  files: Object.fromEntries(cases40.map(([n, deg, s, d]) => [`scene_${n}.json`, json(incline(deg, s, d))])),
  runs: cases40.map(([n]) => ({ name: n, scene: `scene_${n}.json` })),
  asserts: [
    ...cases40.slice(0, 2).map(([n, , , d, regime]) => ({
      id: `A1.${n}`, kind: "incline", run: n, body: "ball", plane: "ramp", regime, mu_d: d,
      tol: tol(null, "distance along the slope against the scheme's s_n = a t_n (t_n + h) / 2 (velocity is the half-step difference): rounding over the run, plus g h^2 for the first substep settling into the plane and a t h for the substep in which the motion starts; spin: 2 alpha h + 32u; rolling: contact point speed <= 2 g h", "rigid-body dynamics of a rolling and of a sliding sphere; Coulomb friction"),
    })),
    ...cases40.slice(2).map(([n, , , , regime]) => ({ id: `A2.${n}`, kind: "incline_regime", run: n, body: "ball", plane: "ramp", expect: regime })),
  ],
});

// G41 ---------------------------------------------------------------------------------------------
const column = (masses: number[]) => scene(4100, {
  objects: { floor: plane([0, 0, 0], [0, 0, 1]), ...Object.fromEntries(masses.map((m, k) => [`s${k}`, ball([0, 0, 0.1 + 0.2 * k], 0.1, m)])) },
  physics: physics(1 / 240, 32, 960, 48, "all_pairs"),
});
const cases41: [string, number[]][] = [["single", [1]], ["equal", [1, 1, 1, 1]], ["heavy_top", [1, 1, 1, 100]]];
out.push({
  id: "g41_resting_and_stack",
  title: "Resting contact and 4-sphere columns (equal masses, and mass ratio 100 with the heavy one on top): penetration <= 1e-3 r, at rest, no energy gain, exact symmetry",
  covers: ["contacts.resting", "contacts.stack", "mass_ratio"],
  kills: ["mass-splitting-count", "plane-normal-flipped", "restitution-threshold-off"],
  files: Object.fromEntries(cases41.map(([n, m]) => [`scene_${n}.json`, json(column(m))])),
  runs: cases41.map(([n]) => ({ name: n, scene: `scene_${n}.json` })),
  asserts: cases41.map(([n]) => ({
    id: `A1.${n}`, kind: "stack", run: n, column: true,
    tol: tol(1e-3, "requirement: penetration <= 1e-3 r for every solver candidate; the mass ratio limit E_MASS_RATIO = 100 is where a 4-high column with the heavy body on top still meets it at dt 1/240 s, 32 substeps (mass splitting on the reference substrate: 6.8e-4 r; ratio 1000 reaches 1.2e-2 r): the limit was tightened, the requirement was not widened (design P2D10). At rest: 2 g h; energy: 16u per substep on the potential energy scale", "design P2-01 G41, P2D10"),
  })),
});

// G42 ---------------------------------------------------------------------------------------------
const cluster = () => {
  const h = new HarnessRng(4200, 0, STREAM.HARNESS_FUZZ);
  const objects: Record<string, unknown> = {};
  let k = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let l = 0; l < 4; l++) {
    const c: Vec3 = [0.3 * (i - 1.5) + 0.06 * (h.uniform() - 0.5), 0.3 * (j - 1.5) + 0.06 * (h.uniform() - 0.5), 0.3 * (l - 1.5) + 0.06 * (h.uniform() - 0.5)];
    const v: Vec3 = [-c[0] * 2 + (h.uniform() - 0.5), -c[1] * 2 + (h.uniform() - 0.5), -c[2] * 2 + (h.uniform() - 0.5)];
    objects[`b${String(k++).padStart(2, "0")}`] = ball(c, 0.1, 1 + h.uniform(), { v, pm: "elastic" });
  }
  return scene(4201, { physics_materials: { elastic: { restitution: 1 } }, objects, physics: physics(0.002, 8, 500, 50, "all_pairs", [0, 0, 0]) });
};
out.push({
  id: "g42_momentum_cluster",
  title: "64 elastic spheres colliding in zero gravity: total linear momentum kept to rounding; validators pass",
  covers: ["conservation.momentum", "contacts.many"],
  kills: ["lambda-not-symmetric", "mass-splitting-count", "averaging-breaks-momentum"],
  files: { "scene.json": json(cluster()) },
  runs: [{ name: "a", scene: "scene.json" }],
  asserts: [
    { id: "A1", kind: "momentum", run: "a", tol: tol(null, "|p(t) - p(0)| <= 2u x substeps x max sum m|v|: each substep rounds every velocity once (v = dx / h in f32); corrections are equal and opposite in exact arithmetic because both bodies evaluate the pair with the same orientation", "Newton's third law; Tonge et al. 2012 mass splitting") },
    { id: "V", kind: "validators_pass", run: "a" },
  ],
});

// G43 ---------------------------------------------------------------------------------------------
// (a) Two spheres welded by a fixed joint, thrown spinning; (b) a sphere on a hinge spun about its
// axis with a small off-axis spin that the hinge must remove.
const w43 = 2;
const comX = (-0.1 * 1 + 0.1 * 2) / 3;
const h43 = 0.002 / 8;
const fixed = scene(4300, {
  objects: {
    // Rigid motion: v = V + w x (x - com) with w = (0, 0, w43), so v_y = w43 (x - com_x).
    a: ball([-0.1, 0, 0], 0.1, 1, { v: [0.5, w43 * (-0.1 - comX), 0], w: [0, 0, w43] }),
    b: ball([0.1, 0, 0], 0.1, 2, { v: [0.5, w43 * (0.1 - comX), 0], w: [0, 0, w43] }),
  },
  joints: { weld: { type: "fixed", a: "a", b: "b", anchor_a_m: [0.1, 0, 0], anchor_b_m: [-0.1, 0, 0] } },
  physics: physics(0.002, 8, 500, 50, "none", [0, 0, 0]),
});
const hinge = scene(4301, {
  objects: { s: ball([0, 0, 1], 0.2, 2, { w: [0.3, 0, 5] }) },
  joints: { axle: { type: "hinge", a: "world", b: "s", anchor_a_m: [0, 0, 1], anchor_b_m: [0, 0, 0], axis_a: [0, 0, 1], axis_b: [0, 0, 1] } },
  physics: physics(0.002, 8, 500, 50, "none", [0, 0, 0]),
});
out.push({
  id: "g43_joints_fixed_hinge",
  title: "Fixed joint keeps two spheres welded while they fly and spin; a hinge keeps spin about its axis and removes spin off it",
  covers: ["joints.fixed", "joints.hinge", "rotation"],
  kills: ["angular-correction-sign", "hinge-axis-frame", "fixed-rest-orientation"],
  files: { "scene_fixed.json": json(fixed), "scene_hinge.json": json(hinge) },
  runs: [{ name: "fixed", scene: "scene_fixed.json" }, { name: "hinge", scene: "scene_hinge.json" }],
  asserts: [
    {
      id: "A1", kind: "joints", run: "fixed",
      bounds: {
        residual_m: tol(1e-5, "requirement: a weld holds to 1e-4 of the radius (0.1 m). The drift it fights is w^2 r h^2 = 3.3e-8 m per substep; one Jacobi iteration of the coupled positional and angular constraints removes only a few percent of it per substep, so the steady residual (9.3e-7 m measured on the reference substrate) is not a fixed fraction of the drift that can be derived here", "requirement (design P2-01 G43)"),
        residual_rad: tol(64 * 2 ** -23, "both bodies spin with the same w, so the relative orientation only changes through rounding of the quaternion updates (<= 4u per substep, removed at least by half each substep: 8u) and of the residual measurement; 64u", U),
      },
    },
    { id: "A2", kind: "momentum", run: "fixed", tol: tol(null, "as G42", "Newton's third law") },
    {
      id: "A3", kind: "joints", run: "hinge", body: "s", axis: [0, 0, 1],
      bounds: {
        residual_m: tol(8 * 2 ** -23, "the anchor is the centre, so only rounding moves it", U),
        residual_rad: tol(16 * 2 ** -23, "the off-axis tilt is at least halved every substep (n = 2: positional and angular constraint); what remains is the quaternion update's rounding, <= 4u per substep, so <= 8u steady, doubled for the residual's own rounding: 16u", "XPBD angular constraint (Müller et al. 2020 §3.3.2)"),
        spin_rel: tol(16 * 2 ** -23, "corrections act along a x b, perpendicular to the axis, so the spin about the axis only sees rounding", U),
        off_axis_rad_s: tol((16 * 2 ** -23) / h43, "the initial 0.3 rad/s off the axis is at least halved per substep (gone after one record, 400 substeps); what remains is the quaternion update rounding the axis by <= 4u per substep while spinning at 5 rad/s, which the hinge correction turns into a rate of tilt / h: 16u / h", "as above"),
      },
    },
  ],
});

// G44 ---------------------------------------------------------------------------------------------
const pile = (offset: number) => scene(4400, {
  physics_materials: { p: { restitution: 0.4, static_friction: 0.5, dynamic_friction: 0.3 } },
  objects: {
    floor: plane([offset, 0, 0], [0, 0, 1], "p"),
    a: ball([offset, 0, 1.2], 1.2, 1, { pm: "p" }),
    b: ball([offset + 1.0, 0.3, 4], 1.2, 1, { pm: "p", w: [0, 2, 0] }),
    c: ball([offset - 0.7, -0.4, 7], 1.2, 2, { pm: "p", v: [0.5, 0, 0] }),
  },
  physics: physics(0.004, 4, 750, 25, "all_pairs"),
});
const touching = scene(4401, { objects: { s: ball([0, 0, 0.1], 0.1, 1), floor: plane([0, 0, 0], [0, 0, 1]) }, physics: physics(0.004, 4, 1000, 50, "all_pairs") });
const tunnel = scene(4402, {
  objects: { bullet: ball([-1, 0, 0], 0.01, 0.01, { v: [50, 0, 0] }), wall: { shape: "sphere", center_m: [0, 0, 0], radius_m: 0.05, material: "m" } },
  physics: physics(0.002, 2, 50, 50, "all_pairs", [0, 0, 0]),
});
const probe = scene(4403, { objects: { a: ball([-0.5, 0, 0], 0.1, 1), b: ball([0.5, 0, 0], 0.1, 1) }, physics: physics(0.002, 4, 10, 10, "all_pairs", [0, 0, 0]) });
out.push({
  id: "g44_physics_extremes",
  title: "Extreme inputs: resting exactly in contact, a pile shifted by 4096 m moves bit for bit the same, coincident centres, tunnelling and energy negative controls, NaN in a quaternion",
  covers: ["extremes", "determinism.translation", "validators.physics"],
  kills: ["restitution-threshold-off", "f32-relative-positions", "fallback-normal", "tunnel-check-off", "energy-check-off"],
  files: { "scene_touching.json": json(touching), "scene_pile.json": json(pile(0)), "scene_pile_far.json": json(pile(4096)), "scene_tunnel.json": json(tunnel), "scene_probe.json": json(probe), "scene_bounce.json": json(drop(0.7, 600)) },
  runs: [
    { name: "touching", scene: "scene_touching.json" },
    { name: "pile", scene: "scene_pile.json" },
    { name: "pile_far", scene: "scene_pile_far.json" },
    { name: "tunnel", scene: "scene_tunnel.json" },
    { name: "gain", scene: "scene_bounce.json", faults: { physicsFaults: { RESTITUTION_GAIN: 1.5 } } },
    { name: "nan_q", scene: "scene_pile.json", faults: { physicsFaults: { FAULT_KIND: 5, FAULT_BODY: 1, FAULT_STEP: 100, FAULT_C: 0 } } },
  ],
  asserts: [
    { id: "A1", kind: "stack", run: "touching", tol: tol(1e-3, "as G41", "design P2-01 G41") },
    { id: "A2", kind: "translation_invariance", runs: ["pile", "pile_far"], offset_m: [4096, 0, 0] },
    { id: "A3", kind: "coincident_centres", scene: "scene_probe.json", bodies: ["a", "b"], centre_m: [0, 0, 0] },
    { id: "A4", kind: "validator_fails", run: "tunnel", name: "tunnel.physics", exit_code: 7 },
    { id: "A5", kind: "validator_fails", run: "gain", name: "energy.physics", exit_code: 5 },
    { id: "A6", kind: "nonfinite_first", run: "nan_q", physics: { step: 100, body: "b", field: "q.x" }, exit_code: 4 },
    { id: "V", kind: "validators_pass", run: "pile" },
  ],
});

// G45 ---------------------------------------------------------------------------------------------
// Every P2 path: contacts with friction and restitution, all four joint kinds, 8 substeps.
const everything = (extra: boolean) => scene(4500, {
  physics_materials: { p: { restitution: 0.3, static_friction: 0.6, dynamic_friction: 0.4 } },
  objects: {
    floor: plane([0, 0, 0], [0, 0, 1], "p"),
    post: { shape: "sphere", center_m: [1.5, 0, 0.3], radius_m: 0.3, material: "m", physics_material: "p" },
    s1: ball([0, 0, 0.5], 0.2, 1, { pm: "p", v: [0.5, 0, 0], w: [0, 1, 0] }),
    s2: ball([0.05, 0.02, 1.2], 0.2, 1.5, { pm: "p" }),
    s3: ball([-0.6, 0, 1.5], 0.15, 1, { pm: "p" }),
    s4: ball([-0.6, 0.5, 1.5], 0.15, 1, { pm: "p" }),
    s5: ball([1, 1, 2], 0.1, 0.5, { pm: "p" }),
    s6: ball([1, 1.5, 2], 0.1, 0.5, { pm: "p" }),
    ...(extra ? { far: ball([60, 0, 10], 0.2, 1, { pm: "p" }) } : {}),
  },
  joints: {
    rope: { type: "distance", a: "world", b: "s3", anchor_a_m: [-0.6, 0, 2.5], anchor_b_m: [0, 0, 0], rest_length_m: 1, compliance_m_N: 1e-4 },
    link: { type: "ball", a: "s3", b: "s4", anchor_a_m: [0, 0.25, 0], anchor_b_m: [0, -0.25, 0] },
    axle: { type: "hinge", a: "world", b: "s5", anchor_a_m: [1, 1, 2], anchor_b_m: [0, 0, 0], axis_a: [0, 1, 0], axis_b: [0, 1, 0] },
    weld: { type: "fixed", a: "s5", b: "s6", anchor_a_m: [0, 0.25, 0], anchor_b_m: [0, -0.25, 0] },
  },
  physics: physics(1 / 240, 8, 120, 12, "all_pairs"),
});
const plans45 = [1, 7, 13, 60, 1000].map((k) => ({ pass_spp: 1 << 30, tile_px: 64, submit_batches: 1, physics_steps_per_dispatch: k }));
out.push({
  id: "g45_det_plan_invariance_p2",
  title: "P2 solver: steps per submit do not change any output byte; a body that touches nothing does not change the others",
  covers: ["determinism", "locality"],
  kills: ["pass-order-dependent", "atomics-in-solver", "pair-orientation"],
  files: { "scene.json": json(everything(false)), "scene_extra.json": json(everything(true)) },
  runs: [...plans45.map((plan, i) => ({ name: `p${i + 1}`, scene: "scene.json", plan })), { name: "extra", scene: "scene_extra.json" }],
  asserts: [
    { id: "A1", kind: "outputs_equal", runs: plans45.map((_, i) => `p${i + 1}`) },
    { id: "A2", kind: "physics_locality", base: "p1", with_extra: "extra" },
    { id: "V", kind: "validators_pass", run: "p1" },
  ],
});

// G46 ---------------------------------------------------------------------------------------------
const lossy = scene(4600, {
  physics_materials: { rubber: { restitution: 0.8, static_friction: 0.9, dynamic_friction: 0.7 } },
  objects: {
    ball: { ...ball([0, 0, 1], 0.1, 1, { w: [0, 0, 1] }), physics_material: "rubber" },
    floor: plane([0, 0, 0], [0, 0, 1]),
  },
  joints: { rope: { type: "distance", a: "world", b: "ball", anchor_a_m: [0, 0, 2], anchor_b_m: [0, 0, 0], rest_length_m: 1 } },
  physics: physics(0.01, 4, 10, 10, "all_pairs"),
});
out.push({
  id: "g46_migration_v2_v3",
  title: "Every p0 and p1 run, migrated to v3 and run by the P2 kernels, reproduces its recorded bytes; migrations round-trip; lossy rollbacks are refused",
  covers: ["contract.migration", "regression"],
  kills: ["p0-loop-changed", "migration-defaults", "rollback-not-lossy"],
  files: { "lossy.json": json(lossy) },
  runs: [],
  asserts: [
    { id: "A1", kind: "p0_byte_identity", snapshot: "p1_snapshot.json", sets: ["p0", "p1"] },
    { id: "A2", kind: "migration_roundtrip", sets: ["p0", "p1", "p2"] },
    { id: "A3", kind: "rollback_lossy", to_version: 2, cases: [{ file: "lossy.json", expect: [
      "E_ROLLBACK_LOSSY@/joints/rope",
      "E_ROLLBACK_LOSSY@/objects/ball/body/angular_velocity_rad_s",
      "E_ROLLBACK_LOSSY@/objects/ball/physics_material",
      "E_ROLLBACK_LOSSY@/physics/contacts",
      "E_ROLLBACK_LOSSY@/physics/substeps",
      "E_ROLLBACK_LOSSY@/physics_materials/rubber",
    ] }] },
  ],
});

// G47 ---------------------------------------------------------------------------------------------
type S = Record<string, any>;
const base47 = (): S => scene(4700, {
  physics_materials: { p: { restitution: 0.5, static_friction: 0.5, dynamic_friction: 0.3 } },
  objects: { ball: ball([0, 0, 0.5], 0.1, 1, { pm: "p" }), ball2: ball([1, 0, 0.5], 0.1, 1), floor: plane([0, 0, 0], [0, 0, 1]) },
  joints: { j: { type: "distance", a: "world", b: "ball", anchor_a_m: [0, 0, 2], anchor_b_m: [0, 0, 0], rest_length_m: 1.5 } },
  physics: physics(0.01, 4, 10, 10, "all_pairs"),
}) as S;
const cases47: [string, (s: S) => void, string, string][] = [
  ["restitution_over_one", (s) => (s.physics_materials.p.restitution = 1.5), "E_RANGE", "/physics_materials/p/restitution"],
  ["friction_negative", (s) => (s.physics_materials.p.static_friction = -0.1), "E_RANGE", "/physics_materials/p/static_friction"],
  ["friction_order", (s) => (s.physics_materials.p.dynamic_friction = 0.8), "E_FRICTION_ORDER", "/physics_materials/p"],
  ["physics_material_missing", (s) => (s.objects.ball.physics_material = "nope"), "E_REF_MISSING", "/objects/ball/physics_material"],
  ["joint_ref_missing", (s) => (s.joints.j.b = "ghost"), "E_JOINT_REF", "/joints/j/b"],
  ["joint_self", (s) => Object.assign(s.joints.j, { a: "ball", b: "ball" }), "E_JOINT_SELF", "/joints/j"],
  ["joint_to_plane", (s) => (s.joints.j.b = "floor"), "E_JOINT_REF", "/joints/j/b"],
  ["joint_type_slider", (s) => (s.joints.j.type = "slider"), "E_VARIANT", "/joints/j/type"],
  ["hinge_zero_axis", (s) => (s.joints.j = { type: "hinge", a: "world", b: "ball", anchor_a_m: [0, 0, 0.5], anchor_b_m: [0, 0, 0], axis_a: [0, 0, 0], axis_b: [0, 0, 1] }), "E_ZERO_VECTOR", "/joints/j/axis_a"],
  ["compliance_negative", (s) => (s.joints.j.compliance_m_N = -1), "E_RANGE", "/joints/j/compliance_m_N"],
  ["joints_without_physics", (s) => { delete s.physics; Object.assign(s, { camera: { model: "pinhole", position_m: [0, -4, 1], look_at_m: [0, 0, 0.5], up: [0, 0, 1], vfov_rad: 0.6 }, environment: { type: "constant", luminance_cdm2: 1, color: [1, 1, 1] }, render: { width_px: 8, height_px: 8, spp: 1, max_bounces: 1, sampler: "independent", integrator: "pt_p1", display_white_cdm2: 1 } }); }, "E_JOINT_REF", "/joints/j"],
  ["mass_ratio", (s) => (s.objects.ball2.body.mass_kg = 1000), "E_MASS_RATIO", "/objects"],
  ["initial_overlap", (s) => (s.objects.ball2.center_m = [0, 0, 0.05]), "E_INITIAL_OVERLAP", "/objects/ball2"],
  ["spin_per_substep", (s) => (s.objects.ball.body.angular_velocity_rad_s = [0, 0, 1000]), "E_SPIN", "/objects/ball/body/angular_velocity_rad_s"],
  ["orientation_not_unit", (s) => (s.objects.ball.body.orientation = [0, 0, 0, 0.9]), "E_NORM", "/objects/ball/body/orientation"],
  ["substeps_zero", (s) => (s.physics.substeps = 0), "E_RANGE", "/physics/substeps"],
  ["contacts_unknown", (s) => (s.physics.contacts = "grid"), "E_ENUM", "/physics/contacts"],
  ["integrator_v2_in_v3", (s) => (s.physics.integrator = "xpbd_unconstrained_p0"), "E_ENUM", "/physics/integrator"],
  ["contact_budget", (s) => { for (let i = 0; i < 300; i++) s.objects[`x${i}`] = ball([0.5 * i, 5, 0.5], 0.1, 1); Object.assign(s.physics, { steps: 1000000, substeps: 256 }); }, "E_BUDGET", "/physics"],
  ["joint_id_collision", (s) => { s.joints = { c2ya8: s.joints.j, czki6: { ...s.joints.j, b: "ball2" } }; }, "E_ID_HASH_COLLISION", "/joints"],
];
const g47Files: Record<string, string> = {};
const g47Cases = cases47.map(([name, mut, code, path]) => {
  const s = base47();
  mut(s);
  g47Files[`invalid/${name}.json`] = json(s);
  return { file: `invalid/${name}.json`, expect: [{ code, path }] };
});
out.push({
  id: "g47_schema_v3_corpus",
  title: `Schema v3: ${cases47.length} invalid scenes rejected with exact code and path`,
  covers: ["contract.schema"],
  kills: ["joint-ref-check", "mass-ratio-check", "overlap-check", "v3-error-mapping"],
  files: g47Files,
  runs: [],
  asserts: [{ id: "A1", kind: "reject_corpus", cases: g47Cases }],
});

if (out.length !== 13) throw new Error(`expected 13 goldens, got ${out.length}`);
const drift = emitSet(ROOT, out, check, (gid, file) => gid === "g46_migration_v2_v3" && file === "p1_snapshot.json");
console.log(check ? `gen_golden_p2 --check: ${drift} file(s) out of date` : `wrote ${out.length} goldens to ${ROOT}`);
process.exit(drift === 0 ? 0 : 1);
