// P2 candidate contests (design mechanism ①, docs/P2-01-design.md §3.5): the physics solver sets.
// Physics runs are deterministic, so errors have no statistical floor and "variance" carries a
// second deterministic measure named in each set's measures; ms keeps its run-to-run spread.
// Run on the reference substrate:  ci/run-in-ref.sh node tools/contest_p2.ts [set ...]
// Writes candidates/p2/<set>/REPORT.md and results.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessRng } from "../src/core/rng.ts";
import { type LoadedScene, loadSceneText, loadSceneValue } from "../src/core/scene.ts";
import type { Json } from "../src/core/json_strict.ts";
import type { Vec3 } from "../src/core/scene_types.ts";
import { add, cross, dot, norm, normalize, scale, sub } from "../src/core/vec.ts";
import { type Gpu, openGpu } from "../src/gpu/device.ts";
import { fingerprint, type Substrate } from "../src/gpu/substrate.ts";
import { DEFAULT_PLAN } from "../src/runtime/plan.ts";
import { decodeBodies, decodeRot, DEFAULT_PHYSICS_CANDIDATES, type PhysicsCandidates } from "../src/runtime/physics.ts";
import { type RunOutput, runScene } from "../src/runtime/run.ts";
import { type ContestSet, ROOT, runContests, timeIt } from "./contest_lib.ts";

const KERNEL = ["physics_p2.wgsl"];
const G = 9.81;
const load = (p: string) => loadSceneText(readFileSync(join(ROOT, p), "utf8"));
const runOnce = (gpu: Gpu, substrate: Substrate, loaded: LoadedScene, c: PhysicsCandidates) => runScene(gpu, loaded, substrate, { plan: DEFAULT_PLAN, physicsCandidates: c });
const timed = (gpu: Gpu, substrate: Substrate, loaded: LoadedScene, c: PhysicsCandidates) => timeIt(() => runOnce(gpu, substrate, loaded, c));
const records = (out: RunOutput) => (out.manifest.deterministic.metrics as any).physics.records as Record<string, any>[];
const validatorsPass = (out: RunOutput) => out.manifest.deterministic.validators.every((v) => v.pass);
const scene = (parts: Record<string, unknown>) => loadSceneValue({ v: 3, seed: 1, materials: { m: { base_color: [0.6, 0.6, 0.6] } }, ...parts } as unknown as Json);
const ball = (c: Vec3, r: number, m: number, o: { v?: Vec3; w?: Vec3; pm?: string } = {}) =>
  ({ shape: "sphere", center_m: c, radius_m: r, material: "m", ...(o.pm ? { physics_material: o.pm } : {}), body: { mass_kg: m, velocity_m_s: o.v ?? [0, 0, 0], ...(o.w ? { angular_velocity_rad_s: o.w } : {}) } });

/** Downhill distance of a ball on G40's ramp against the scheme's s = a t (t + h) / 2, relative. */
function inclineError(loaded: LoadedScene, out: RunOutput, acc: number): number {
  const s = loaded.scene;
  const n = normalize((s.objects["ramp"] as { normal: Vec3 }).normal);
  const gv = s.physics!.gravity_m_s2;
  const down = normalize(sub(gv, scale(n, dot(gv, n))));
  const h = s.physics!.dt_s / s.physics!.substeps;
  const recs = out.physics!.records;
  const x0 = decodeBodies(recs[0]!.raw)[0]!.x_m;
  let worst = 0;
  for (const r of recs.slice(1)) {
    const t = r.step * s.physics!.dt_s;
    const want = 0.5 * acc * t * (t + h);
    worst = Math.max(worst, Math.abs(dot(sub(decodeBodies(r.raw)[0]!.x_m, x0), down) - want) / want);
  }
  return worst;
}

/** Speed of the contact point of the ball on the ramp at the end (0 when rolling). */
function slip(loaded: LoadedScene, out: RunOutput): number {
  const n = normalize((loaded.scene.objects["ramp"] as { normal: Vec3 }).normal);
  const r = (loaded.scene.objects["ball"] as { radius_m: number }).radius_m;
  const last = out.physics!.records.at(-1)!;
  return norm(add(decodeBodies(last.raw)[0]!.v_m_s, cross(decodeRot(last.rot)[0]!.omega_rad_s, scale(n, -r))));
}

const SETS: ContestSet[] = [
  {
    id: "c_solver",
    title: "Parallel constraint solver (P2D2)",
    override: "SOLVER",
    files: KERNEL,
    defaultValue: DEFAULT_PHYSICS_CANDIDATES.SOLVER,
    candidates: [
      { value: 0, name: "Jacobi + mass splitting", source: "Tonge, Benevolenski, Voroshilov, Mass Splitting for Jitter-Free Parallel Rigid Body Simulation, SIGGRAPH 2012" },
      { value: 1, name: "plain Jacobi", source: "corrections of all constraints summed" },
      { value: 2, name: "Jacobi averaged", source: "Macklin et al., Unified Particle Physics for Real-Time Applications, SIGGRAPH 2014, §4.2" },
    ],
    measures: {
      error: "largest penetration / r of G41's column with the heavy body on top (mass ratio 100)",
      variance: "linear momentum change / (sum m|v|) at the end of G42 (64 colliding spheres); noise: the rounding bound 2u per substep",
      ms: "run of G42 (64 spheres, 4000 substeps)",
      robustness: "share of 40 random scenes failing: 12 piles of 6 spheres (masses 1-100, friction, e <= 0.3) with a validator failing or penetration > 1e-3 r after 1 s, 12 zero-g clusters losing momentum beyond 2u per substep, and 16 chains of 5 spheres hung from the world with random joint types (distance, ball, hinge, fixed; every inner body carries two joints) with a validator failing within 2 s",
    },
    async run(gpu, substrate, value) {
      const c = { SOLVER: value };
      const stack = await runOnce(gpu, substrate, load("golden/p2/g41_resting_and_stack/scene_heavy_top.json"), c);
      const pen = Math.max(...records(stack).map((r) => r["max_penetration_m"] as number)) / 0.1;
      const cl = load("golden/p2/g42_momentum_cluster/scene.json");
      const t = await timed(gpu, substrate, cl, c);
      const mom = records(t.out).map((r) => r["momentum_kg_m_s"] as Vec3);
      const clMasses = t.out.physics!.masses;
      const pScale = decodeBodies(t.out.physics!.records[0]!.raw).reduce((acc, b, i) => acc + clMasses[i]! * norm(b.v_m_s), 0);
      const momErr = norm(sub(mom.at(-1)!, mom[0]!)) / pScale;
      const h = new HarnessRng(0xd1, value);
      let failures = 0;
      for (let k = 0; k < 12; k++) {
        const objects: Record<string, unknown> = { floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m", physics_material: "p" } };
        let rMin = 1;
        for (let i = 0; i < 6; i++) {
          const r = 0.08 + 0.07 * h.uniform();
          rMin = Math.min(rMin, r);
          objects[`s${i}`] = ball([0.25 * (h.uniform() - 0.5), 0.25 * (h.uniform() - 0.5), 0.2 + 0.32 * i], r, 1 + 99 * h.uniform(), { pm: "p" });
        }
        const sc = scene({ physics_materials: { p: { restitution: 0.3 * h.uniform(), static_friction: 0.8 * h.uniform(), dynamic_friction: 0 } }, objects, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 1 / 240, substeps: 16, steps: 720, record_every_steps: 60, contacts: "all_pairs" } });
        const out = await runOnce(gpu, substrate, sc, c);
        const late = records(out).filter((r) => (r["step"] as number) >= 240);
        if (!validatorsPass(out) || Math.max(...late.map((r) => r["max_penetration_m"] as number)) > 1e-3 * rMin) failures++;
      }
      for (let k = 0; k < 12; k++) {
        const objects: Record<string, unknown> = {};
        for (let i = 0; i < 8; i++) objects[`b${i}`] = ball([0.25 * (i % 2) + 0.03 * h.uniform(), 0.25 * ((i >> 1) % 2) + 0.03 * h.uniform(), 0.25 * (i >> 2) + 0.03 * h.uniform()], 0.1, 1 + 99 * h.uniform(), { v: [h.uniform() - 0.5, h.uniform() - 0.5, h.uniform() - 0.5], pm: "e" });
        const sc = scene({ physics_materials: { e: { restitution: h.uniform() } }, objects, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, 0], dt_s: 0.002, substeps: 8, steps: 250, record_every_steps: 250, contacts: "all_pairs" } });
        const out = await runOnce(gpu, substrate, sc, c);
        const rs = records(out);
        const masses = Object.values(sc.scene.objects).map((o) => (o as { body: { mass_kg: number } }).body.mass_kg);
        const vs = decodeBodies(out.physics!.records[0]!.raw);
        const scaleP = vs.reduce((a, b, i) => a + masses[i]! * norm(b.v_m_s), 0);
        const dp = norm(sub(rs.at(-1)!["momentum_kg_m_s"], rs[0]!["momentum_kg_m_s"]));
        if (!validatorsPass(out) || dp > 2 * 2 ** -23 * 250 * 8 * scaleP * 4) failures++;
      }
      // Joint chains: a body between two joints has up to four constraints acting on the same degrees of freedom.
      const TYPES = ["distance", "ball", "hinge", "fixed"] as const;
      for (let k = 0; k < 16; k++) {
        const objects: Record<string, unknown> = { floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m", physics_material: "p" } };
        const joints: Record<string, unknown> = {};
        for (let i = 0; i < 5; i++) {
          objects[`s${i}`] = ball([0.5 * (i + 1), 0, 1.5], 0.1 + 0.05 * h.uniform(), 0.5 + 4.5 * h.uniform(), { v: [0, h.uniform() - 0.5, 0], pm: "p" });
          const type = TYPES[Math.min(3, Math.floor(4 * h.uniform()))]!;
          const a = i === 0 ? "world" : `s${i - 1}`;
          // World anchors are world points, body anchors are body-local; distance joints link the centres.
          const anchorA = (x: number): Vec3 => (i === 0 ? [x, 0, 1.5] : [x, 0, 0]);
          joints[`j${i}`] = type === "distance"
            ? { type, a, b: `s${i}`, anchor_a_m: anchorA(0), anchor_b_m: [0, 0, 0], rest_length_m: 0.5 }
            : { type, a, b: `s${i}`, anchor_a_m: anchorA(0.25), anchor_b_m: [-0.25, 0, 0], ...(type === "hinge" ? { axis_a: [0, 1, 0], axis_b: [0, 1, 0] } : {}) };
        }
        const sc = scene({ physics_materials: { p: { restitution: 0.2, static_friction: 0.5, dynamic_friction: 0.3 } }, objects, joints, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 1 / 240, substeps: 8, steps: 480, record_every_steps: 48, contacts: "all_pairs" } });
        if (!validatorsPass(await runOnce(gpu, substrate, sc, c))) failures++;
      }
      return {
        // Momentum is exact up to rounding: 2u per substep (G42 A1), so differences below that are ties.
        error: pen, errorFloor: 0, variance: momErr, noise: { variance: 2 * 2 ** -23 * 4000, ms: t.spread }, ms: t.ms, failure_rate: failures / 40,
        notes: [`G41 heavy-top penetration ${pen.toExponential(2)} r`, `G42 momentum change ${momErr.toExponential(2)} of the scale`],
      };
    },
  },
  {
    id: "c_friction",
    title: "Friction model (P2D3)",
    override: "FRICTION",
    files: KERNEL,
    defaultValue: DEFAULT_PHYSICS_CANDIDATES.FRICTION,
    candidates: [
      { value: 0, name: "positional static + velocity dynamic", source: "Müller et al., Detailed Rigid Body Simulation with XPBD, SCA 2020 §3.5-3.6 (dynamic bound as an impulse, P2-02)" },
      { value: 1, name: "velocity-level Coulomb", source: "stick inside the static cone, else slide with mu_d, both at velocity level" },
    ],
    measures: {
      error: "largest relative error of the downhill distance against s = a t (t + h) / 2 over G40's rolling and sliding runs",
      variance: "contact-point slip speed at the end of G40's rolling run (0 when it rolls)",
      ms: "run of G40 (rolling)",
      robustness: "share of 12 random inclines (5-40 deg, mu_s 0.05-1, mu_d = 0.7 mu_s; 1.5 deg around the critical angle excluded) whose roll/slide regime disagrees with tan(theta) <= 3.5 mu_s, or failing a validator",
    },
    async run(gpu, substrate, value) {
      const c = { FRICTION: value };
      const rollScene = load("golden/p2/g40_rolling_incline/scene_roll.json");
      const t = await timed(gpu, substrate, rollScene, c);
      const slideScene = load("golden/p2/g40_rolling_incline/scene_slide.json");
      const slide = await runOnce(gpu, substrate, slideScene, c);
      const th = (deg: number) => (deg * Math.PI) / 180;
      const err = Math.max(inclineError(rollScene, t.out, (5 / 7) * G * Math.sin(th(20))), inclineError(slideScene, slide, G * (Math.sin(th(30)) - 0.08 * Math.cos(th(30)))));
      const h = new HarnessRng(0xd2, value);
      let failures = 0;
      let tried = 0;
      while (tried < 12) {
        const deg = 5 + 35 * h.uniform();
        const mus = 0.05 + 0.95 * h.uniform();
        const crit = (Math.atan(3.5 * mus) * 180) / Math.PI;
        if (Math.abs(deg - crit) < 1.5) continue;
        tried++;
        const n: Vec3 = [Math.sin(th(deg)), 0, Math.cos(th(deg))];
        const sc = scene({ physics_materials: { f: { static_friction: mus, dynamic_friction: 0.7 * mus } }, objects: { ball: ball(scale(n, 0.1), 0.1, 1, { pm: "f" }), ramp: { shape: "plane", point_m: [0, 0, 0], normal: n, material: "m", physics_material: "f" } }, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 0.002, substeps: 4, steps: 250, record_every_steps: 250, contacts: "all_pairs" } });
        const out = await runOnce(gpu, substrate, sc, c);
        const rolls = slip(sc, out) <= 2 * G * 0.0005;
        if (!validatorsPass(out) || rolls !== deg < crit) failures++;
      }
      return { error: err, errorFloor: 0, variance: slip(rollScene, t.out), noise: { variance: 0, ms: t.spread }, ms: t.ms, failure_rate: failures / 12, notes: [`distance error ${err.toExponential(2)}`] };
    },
  },
  {
    id: "c_restitution",
    title: "Restitution threshold (P2D3)",
    override: "RESTITUTION_THRESHOLD",
    files: KERNEL,
    defaultValue: DEFAULT_PHYSICS_CANDIDATES.RESTITUTION_THRESHOLD,
    candidates: [
      { value: 0, name: "e = 0 below 2|g|h", source: "Müller et al. 2020 §3.6" },
      { value: 1, name: "no threshold", source: "restitution at every approach speed" },
    ],
    measures: {
      error: "largest |H - H_pred| / H_pred over G38's four bounces at e = 0.7 (H_pred: the scheme's discrete apex)",
      variance: "mean speed over the last second of a ball dropped with e = 0.5 (rest jitter; 0 at rest)",
      ms: "run of G38 (e = 0.7)",
      robustness: "share of 12 random drops (e 0.1-0.85, height 0.2-2 m) not at rest (|v| > 4 g h) 1 s after the Zeno time t0 (1 + 2e / (1 - e)) of the bounce sequence, or failing a validator",
    },
    async run(gpu, substrate, value) {
      const c = { RESTITUTION_THRESHOLD: value };
      const dropScene = load("golden/p2/g38_restitution_drop/scene_e7.json");
      const t = await timed(gpu, substrate, dropScene, c);
      const hh = 0.002 / 4;
      const z = t.out.physics!.records.map((r) => decodeBodies(r.raw)[0]!.x_m[2] - 0.1);
      const apex: number[] = [];
      for (let k = 1; k + 1 < z.length; k++) {
        if (z[k]! > z[k - 1]! && z[k]! >= z[k + 1]! && z[k]! > 1e-3) {
          const d = z[k - 1]! - 2 * z[k]! + z[k + 1]!;
          apex.push(d < 0 ? z[k]! - (z[k + 1]! - z[k - 1]!) ** 2 / (8 * d) : z[k]!);
        }
      }
      const heights = [z[0]!, ...apex];
      let err = 0;
      for (let k = 0; k < Math.min(4, heights.length - 1); k++) {
        const v = Math.sqrt(2 * G * heights[k]!);
        const want = (0.7 * v) ** 2 / (2 * G) - (0.7 * v * hh) / 2;
        err = Math.max(err, Math.abs(heights[k + 1]! - want) / want);
      }
      const rest = scene({ physics_materials: { p: { restitution: 0.5 } }, objects: { ball: ball([0, 0, 0.6], 0.1, 1, { pm: "p" }), floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m", physics_material: "p" } }, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 0.002, substeps: 4, steps: 2000, record_every_steps: 25, contacts: "all_pairs" } });
      const restOut = await runOnce(gpu, substrate, rest, c);
      const lateSpeeds = restOut.physics!.records.filter((r) => r.step >= 1500).map((r) => norm(decodeBodies(r.raw)[0]!.v_m_s));
      const jitter = lateSpeeds.reduce((a, b) => a + b, 0) / lateSpeeds.length;
      const h = new HarnessRng(0xd3, value);
      let failures = 0;
      for (let k = 0; k < 12; k++) {
        const e = 0.1 + 0.75 * h.uniform();
        const height = 0.2 + 1.8 * h.uniform();
        // Bounces of a sequence with restitution e end at t0 (1 + 2e / (1 - e)), t0 the first fall.
        const zeno = Math.sqrt((2 * height) / G) * (1 + (2 * e) / (1 - e));
        const steps = Math.ceil((zeno + 1) / 0.002);
        const sc = scene({ physics_materials: { p: { restitution: e } }, objects: { ball: ball([0, 0, 0.1 + height], 0.1, 1, { pm: "p" }), floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m", physics_material: "p" } }, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 0.002, substeps: 4, steps, record_every_steps: steps, contacts: "all_pairs" } });
        const out = await runOnce(gpu, substrate, sc, c);
        const v = norm(decodeBodies(out.physics!.records.at(-1)!.raw)[0]!.v_m_s);
        if (!validatorsPass(out) || v > 4 * G * hh) failures++;
      }
      return { error: err, errorFloor: 0, variance: jitter, noise: { variance: 0, ms: t.spread }, ms: t.ms, failure_rate: failures / 12, notes: [`bounce error ${err.toExponential(2)}`, `rest jitter ${jitter.toExponential(2)} m/s`] };
    },
  },
  {
    id: "c_quat",
    title: "Orientation update (P2-01 §3.5)",
    override: "QUAT",
    files: KERNEL,
    defaultValue: DEFAULT_PHYSICS_CANDIDATES.QUAT,
    candidates: [
      { value: 0, name: "first order + normalize", source: "Müller et al. 2020 Alg. 2: q + h/2 [w, 0] q, normalized" },
      { value: 1, name: "exponential map", source: "exact rotation exp(h w / 2) q" },
    ],
    measures: {
      error: "relative error of the orientation angle of a free sphere spinning at |w| h = 0.4 for 1 s (exact: |w| t)",
      variance: "relative error of G36's physical-pendulum period against 4 sqrt(I_p / m g d) K",
      ms: "run of G36",
      robustness: "share of 12 random ball-joint pendulums (spin up to 0.1 / h in a random direction) failing a validator",
    },
    async run(gpu, substrate, value) {
      const c = { QUAT: value };
      const pend = load("golden/p2/g36_physical_pendulum_ball_joint/scene.json");
      const t = await timed(gpu, substrate, pend, c);
      const dt = pend.scene.physics!.dt_s;
      const th = t.out.physics!.records.map((r) => {
        const x = decodeBodies(r.raw)[0]!.x_m;
        return Math.atan2(x[0], 1 - x[2]);
      });
      const cr: number[] = [];
      for (let k = 1; k < th.length; k++) if (th[k - 1]! > 0 && th[k]! <= 0) cr.push(t.out.physics!.records[k]!.step * dt - (5 * dt * th[k]!) / (th[k]! - th[k - 1]!));
      let a = 1;
      let b = Math.sqrt(1 - Math.sin(0.025) ** 2);
      for (let i = 0; i < 40; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
      const exact = 4 * Math.sqrt((0.4 * 0.04 + 0.04) / (G * 0.2)) * (Math.PI / (2 * a));
      const periodErr = Math.abs(cr[1]! - cr[0]! - exact) / exact;
      // Free spin about z at |w| h = 0.4: the orientation should have turned by |w| t (mod 2 pi).
      const hs = 0.002 / 4;
      const wz = 0.4 / hs;
      const spin = await runOnce(gpu, substrate, scene({ objects: { s: ball([0, 0, 0], 0.1, 1, { w: [0, 0, wz] }) }, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, 0], dt_s: 0.002, substeps: 4, steps: 500, record_every_steps: 500, contacts: "none" } }), c);
      const q = decodeRot(spin.physics!.records.at(-1)!.rot)[0]!.q;
      const turned = 2 * Math.atan2(q[2], q[3]);
      const want = Math.atan2(Math.sin(wz * 1), Math.cos(wz * 1));
      const phaseErr = Math.abs(Math.atan2(Math.sin(turned - want), Math.cos(turned - want))) / (wz * 1);
      const h = new HarnessRng(0xd4, value);
      let failures = 0;
      for (let k = 0; k < 12; k++) {
        const r = 0.05 + 0.2 * h.uniform();
        const hh = 0.002 / 4;
        const dir = normalize([h.uniform() - 0.5, h.uniform() - 0.5, h.uniform() - 0.5]);
        const w = scale(dir, (0.1 * h.uniform()) / hh);
        const sc = scene({ objects: { s: ball([0, 0, 1 - r], r, 1 + h.uniform(), { w }) }, joints: { pin: { type: "ball", a: "world", b: "s", anchor_a_m: [0, 0, 1], anchor_b_m: [0, 0, r] } }, physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -G], dt_s: 0.002, substeps: 4, steps: 500, record_every_steps: 50, contacts: "none" } });
        const out = await runOnce(gpu, substrate, sc, c);
        if (!validatorsPass(out)) failures++;
      }
      return { error: phaseErr, errorFloor: 0, variance: periodErr, noise: { variance: 0, ms: t.spread }, ms: t.ms, failure_rate: failures / 12, notes: [`free-spin phase error ${phaseErr.toExponential(2)} (first order: (h w)^2 / 12 = ${((0.4 ** 2) / 12).toExponential(2)})`, `G36 period error ${periodErr.toExponential(2)}`] };
    },
  },
];

const gpu = await openGpu();
const substrate = await fingerprint(gpu);
await runContests(SETS, join(ROOT, "candidates", "p2"), gpu, substrate, "tools/contest_p2.ts");
gpu.destroy();
