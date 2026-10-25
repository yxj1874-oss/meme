// One run: canonical scene + plan -> output files + manifest (design §3.5). Files are produced in
// memory; writing them is the caller's choice. manifest.deterministic is what --determinism-check
// compares; manifest.perf holds anything measured with a clock and is never compared.

import { jcs } from "../core/jcs.ts";
import { jcsHash, sha256Tag } from "../core/hash.ts";
import type { LoadedScene } from "../core/scene.ts";
import { dot, norm } from "../core/vec.ts";
import type { Gpu } from "../gpu/device.ts";
import { type Substrate, substrateId } from "../gpu/substrate.ts";
import { encodePfm } from "../io/pfm.ts";
import { encodePngRgb8, toDisplayRgb8 } from "../io/png.ts";
import { checkEnergy, checkEnergyStatistical, energyBound, energyMode, roundingFactor, scanNonFinite } from "../oracle/validators.ts";
import { codeHash } from "./identity.ts";
import { decodeBodies, decodeDiag, decodeRot, type PhysicsCandidates, type PhysicsFaults, physicsLayout, type PhysicsResult, simulate } from "./physics.ts";
import { physicsSnapshot } from "./physics_metrics.ts";
import { DEFAULT_PLAN, type ExecutionPlan, planHash } from "./plan.ts";
import { type RenderCandidates, type RenderFaults, type RenderResult, renderScene } from "./render.ts";

export interface RunOptions {
  plan?: ExecutionPlan;
  renderFaults?: RenderFaults;
  physicsFaults?: PhysicsFaults;
  /** Candidate kernels for the P1 contests (test tooling). */
  candidates?: RenderCandidates;
  /** Candidate kernels for the P2 contests (test tooling). */
  physicsCandidates?: PhysicsCandidates;
}

export interface ValidatorReport {
  name: string;
  pass: boolean;
  detail: unknown;
}

export interface Manifest {
  v: 1;
  key: { code_hash: string; scene_hash: string; plan_hash: string; substrate_id: string };
  deterministic: {
    outputs: Record<string, string>;
    metrics: Record<string, unknown>;
    work: { rays: number; shadow_rays: number; isect_tests: number; physics_steps: number; physics_substeps: number; pair_tests: number; constraint_solves: number; gpu_bytes_peak: number };
    validators: ValidatorReport[];
  };
  perf: { wall_ms: number };
  substrate: Substrate;
}

export interface RunOutput {
  files: Map<string, Uint8Array>;
  manifest: Manifest;
  render?: RenderResult;
  physics?: PhysicsResult;
}

/** wallMs comes from the caller (src/perf), keeping clocks out of the deterministic path. */
export async function runScene(gpu: Gpu, loaded: LoadedScene, substrate: Substrate, options: RunOptions = {}, wallMs = 0): Promise<RunOutput> {
  const scene = loaded.scene;
  const plan = options.plan ?? DEFAULT_PLAN;
  gpu.resetPeak();
  const files = new Map<string, Uint8Array>();
  const metrics: Record<string, unknown> = {};
  const validators: ValidatorReport[] = [];
  let physics: PhysicsResult | undefined;
  let render: RenderResult | undefined;
  let physicsSteps = 0;

  if (scene.physics !== undefined) {
    physics = await simulate(gpu, scene, plan, options.physicsFaults, options.physicsCandidates);
    physicsSteps = physics.ids.length * scene.physics.steps;
    const series: Record<string, unknown>[] = [];
    const nonfinite: { step: number; body: string; field: string }[] = [];
    let nonfiniteCount = 0;
    const initialRots = decodeRot(physics.records[0]!.rot);
    const layout = physicsLayout(scene);
    const h = scene.physics.dt_s / scene.physics.substeps;
    let e0 = 0;
    let scaleKe = 0;
    let scalePe = 0;
    let energyViolation: Record<string, unknown> | undefined;
    let dispMax = 0;
    let speedMax = 0;
    for (const rec of physics.records) {
      const tag = String(rec.step).padStart(6, "0");
      files.set(`state/step_${tag}.bin`, rec.raw);
      if (physics.rotational) files.set(`state/step_${tag}.rot.bin`, rec.rot);
      const states = decodeBodies(rec.raw);
      const rots = decodeRot(rec.rot);
      const diag = decodeDiag(rec.diag);
      const bodies: Record<string, unknown> = {};
      let vmax = 0;
      // Only the f32 words of each body (inv_mass, v); position words are fixed-point integers.
      const scan = scanNonFinite(floatWords(rec.raw));
      nonfiniteCount += scan.count;
      for (const hit of scan.first) {
        const word = hit.index % 4;
        if (word > 0 && nonfinite.length < 64) nonfinite.push({ step: rec.step, body: physics.ids[Math.floor(hit.index / 4)]!, field: `v.${"xyz"[word - 1]}` });
      }
      if (physics.rotational) {
        const rotScan = scanNonFinite(new Float32Array(rec.rot.buffer.slice(rec.rot.byteOffset, rec.rot.byteOffset + rec.rot.byteLength)));
        nonfiniteCount += rotScan.count;
        for (const hit of rotScan.first) {
          const word = hit.index % 8;
          if (word < 7 && nonfinite.length < 64) nonfinite.push({ step: rec.step, body: physics.ids[Math.floor(hit.index / 8)]!, field: word < 4 ? `q.${"xyzw"[word]}` : `omega.${"xyz"[word - 4]}` });
        }
      }
      states.forEach((s, i) => {
        vmax = Math.max(vmax, norm(s.v_m_s));
        bodies[physics!.ids[i]!] = physics!.rotational
          ? { x_m: s.x_m.map(finiteOr), v_m_s: s.v_m_s.map(finiteOr), q: rots[i]!.q.map(finiteOr), omega_rad_s: rots[i]!.omega_rad_s.map(finiteOr) }
          : { x_m: s.x_m.map(finiteOr), v_m_s: s.v_m_s.map(finiteOr) };
      });
      files.set(`state/step_${tag}.json`, new TextEncoder().encode(jcs({ step: rec.step, t_s: rec.step * scene.physics.dt_s, bodies })));
      const snap = physicsSnapshot(scene, layout, states, rots, initialRots, physics.rotational);
      const eProj = diag.reduce((a, d) => a + d.e_proj_j, 0);
      const eBounce = diag.reduce((a, d) => a + d.e_bounce_j, 0);
      const disp = diag.reduce((a, d) => Math.max(a, d.max_disp_ratio), 0);
      dispMax = Math.max(dispMax, disp);
      speedMax = Math.max(speedMax, diag.reduce((a, d) => Math.max(a, d.max_speed_m_s), 0));
      const entry: Record<string, unknown> = { step: rec.step, ke_j: finiteOr(snap.ke_j), pe_j: finiteOr(snap.pe_j), e_j: finiteOr(snap.e_j), v_max_m_s: finiteOr(vmax) };
      if (physics.rotational) {
        Object.assign(entry, {
          ke_rot_j: finiteOr(snap.ke_rot_j), pe_spring_j: finiteOr(snap.pe_spring_j),
          momentum_kg_m_s: snap.momentum_kg_m_s.map(finiteOr), angular_momentum_kg_m2_s: snap.angular_momentum_kg_m2_s.map(finiteOr),
          max_penetration_m: finiteOr(snap.max_penetration_m), joint_residual_m: finiteOr(snap.joint_residual_m), joint_residual_rad: finiteOr(snap.joint_residual_rad),
          contacts: diag.reduce((a, d) => a + d.contacts, 0), e_projection_j: finiteOr(eProj), e_bounce_j: finiteOr(eBounce), disp_ratio_max: finiteOr(disp),
        });
      }
      series.push(entry);
      // V-Energy(c) (design P2D13): with contacts or joints the mechanical energy may only grow by what
      // the position corrections and the restitution allowance account for, plus rounding:
      // 16 u per substep on the energy scale seen so far.
      if (physics.interacting) {
        if (rec.step === 0) e0 = snap.e_j;
        scaleKe = Math.max(scaleKe, snap.ke_j + snap.ke_rot_j + snap.pe_spring_j);
        scalePe = Math.max(scalePe, Math.abs(snap.pe_j - (series[0]!["pe_j"] as number)));
        const rounding = 16 * 2 ** -23 * rec.step * scene.physics.substeps * (scaleKe + scalePe);
        const allowed = e0 + eProj + eBounce + rounding;
        if (energyViolation === undefined && !(snap.e_j <= allowed)) energyViolation = { step: rec.step, e_j: finiteOr(snap.e_j), allowed_j: finiteOr(allowed), e0_j: e0, projection_j: eProj, bounce_j: eBounce, rounding_j: rounding };
      }
    }
    metrics["physics"] = { bodies: physics.ids.length, substep_s: h, records: series };
    validators.push({ name: "nan.physics", pass: nonfiniteCount === 0, detail: { count: nonfiniteCount, first: nonfinite } });
    if (physics.interacting) {
      validators.push({ name: "energy.physics", pass: energyViolation === undefined, detail: energyViolation ?? { checked: physics.records.length } });
      // E_PRECISION_DT at run time (x-semantic-checks): with contacts or joints there is no a-priori
      // speed bound, so the speeds actually reached must keep |g| h >= 2^-16 |v|.
      const g = norm(scene.physics.gravity_m_s2);
      validators.push({ name: "precision.physics", pass: g === 0 || g * h >= 2 ** -16 * speedMax, detail: { max_speed_m_s: finiteOr(speedMax), g_h_m_s: g * h } });
    }
    if (scene.physics.contacts === "all_pairs") {
      // design P2D7: a body that moves more than half its radius in one substep may tunnel.
      validators.push({ name: "tunnel.physics", pass: dispMax <= 0.5, detail: { max_disp_ratio: finiteOr(dispMax), limit: 0.5 } });
    }
  }

  if (scene.render !== undefined) {
    render = await renderScene(gpu, scene, plan, options.renderFaults, options.candidates);
    const { width: W, height: H } = render;
    files.set("image.linear.pfm", encodePfm(W, H, render.mean));
    files.set("aov.m2.pfm", encodePfm(W, H, render.m2));
    files.set("aov.id.u32", new Uint8Array(render.ids.buffer.slice(0)));
    files.set("image.png", encodePngRgb8(W, H, toDisplayRgb8(render.mean, scene.render.display_white_cdm2)));

    const scan = scanNonFinite(render.mean);
    const scanM2 = scanNonFinite(render.m2);
    validators.push({
      name: "nan.image",
      pass: scan.count === 0 && scanM2.count === 0,
      detail: { count: scan.count + scanM2.count, first: scan.first.map((h) => ({ x: Math.floor(h.index / 3) % W, y: Math.floor(h.index / 3 / W), c: h.index % 3, kind: h.kind })) },
    });
    const mode = energyMode(scene);
    if (mode === "not_applicable") {
      validators.push({ name: "energy.image", pass: true, detail: { mode, reason: "point lights: radiance next to a point light has no finite bound" } });
    } else {
      const bound = energyBound(scene);
      const factor = roundingFactor(render.spp, scene.render.max_bounces);
      const over = mode === "per_sample" ? checkEnergy(render.mean, bound, factor) : checkEnergyStatistical(render.mean, render.m2, render.spp, bound, factor);
      validators.push({ name: "energy.image", pass: over.length === 0, detail: { mode, bound, violations: over.map((o) => ({ ...o, value: finiteOr(o.value), bound: finiteOr(o.bound) })) } });
    }

    const mean = [0, 0, 0];
    const max = [0, 0, 0];
    for (let i = 0; i < render.mean.length; i++) {
      const v = render.mean[i]!;
      if (!Number.isFinite(v)) continue;
      mean[i % 3]! += v;
      max[i % 3] = Math.max(max[i % 3]!, v);
    }
    metrics["image"] = { width: W, height: H, spp: render.spp, mean: mean.map((s) => s / (W * H)), max, nonfinite: scan.count };
    metrics["lighting"] = { strategy: scene.render.strategy ?? "mis", lights: render.lightCount, specular_lobe_choices: render.specularChoices, nee_share: render.neeShare };
  }

  const outputs: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) outputs[name] = sha256Tag(files.get(name)!);
  const deterministic: Manifest["deterministic"] = {
    outputs,
    metrics,
    work: {
      rays: render?.segments ?? 0, shadow_rays: render?.shadowRays ?? 0, isect_tests: render?.isectTests ?? 0, physics_steps: physicsSteps,
      physics_substeps: physics?.work.physics_substeps ?? 0, pair_tests: physics?.work.pair_tests ?? 0, constraint_solves: physics?.work.constraint_solves ?? 0,
      gpu_bytes_peak: gpu.bytesPeak,
    },
    validators,
  };
  files.set("metrics.json", new TextEncoder().encode(jcs(deterministic)));
  const manifest: Manifest = {
    v: 1,
    key: { code_hash: codeHash(), scene_hash: loaded.scene_hash, plan_hash: planHash(plan), substrate_id: substrateId(substrate) },
    deterministic,
    perf: { wall_ms: wallMs },
    substrate,
  };
  return { files, manifest, ...(render ? { render } : {}), ...(physics ? { physics } : {}) };
}

/** inv_mass and v (words 7..10 of each 48-byte body), packed 4 floats per body. */
function floatWords(raw: Uint8Array): Float32Array {
  const words = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const n = words.length / 12;
  const out = new Uint32Array(n * 4);
  for (let i = 0; i < n; i++) out.set(words.subarray(i * 12 + 7, i * 12 + 11), i * 4);
  return new Float32Array(out.buffer);
}

/** JSON cannot carry NaN/Inf; metrics record them as null and V-NaN reports where they came from. */
function finiteOr(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** CLI exit code implied by a run's validators (src/cli.ts EXIT): 4 non-finite, 5 energy, 7 tunnelling or f32 precision, else 0. */
export function exitCodeFor(m: Manifest): number {
  const failed = m.deterministic.validators.filter((v) => !v.pass);
  if (failed.some((v) => v.name.startsWith("nan."))) return 4;
  if (failed.some((v) => v.name.startsWith("energy."))) return 5;
  if (failed.some((v) => v.name.startsWith("tunnel.") || v.name.startsWith("precision."))) return 7;
  return 0;
}

export function deterministicHash(m: Manifest): string {
  return jcsHash(m.deterministic);
}
