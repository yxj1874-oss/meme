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
import { checkEnergy, energyBound, roundingFactor, scanNonFinite } from "../oracle/validators.ts";
import { codeHash } from "./identity.ts";
import { decodeBodies, type PhysicsFaults, type PhysicsResult, simulate } from "./physics.ts";
import { DEFAULT_PLAN, type ExecutionPlan, planHash } from "./plan.ts";
import { type RenderFaults, type RenderResult, renderScene } from "./render.ts";

export interface RunOptions {
  plan?: ExecutionPlan;
  renderFaults?: RenderFaults;
  physicsFaults?: PhysicsFaults;
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
    work: { rays: number; isect_tests: number; physics_steps: number; gpu_bytes_peak: number };
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
    physics = await simulate(gpu, scene, plan, options.physicsFaults);
    physicsSteps = physics.ids.length * scene.physics.steps;
    const g = scene.physics.gravity_m_s2;
    const series: Record<string, unknown>[] = [];
    const nonfinite: { step: number; body: string; field: string }[] = [];
    let nonfiniteCount = 0;
    for (const rec of physics.records) {
      const tag = String(rec.step).padStart(6, "0");
      files.set(`state/step_${tag}.bin`, rec.raw);
      const states = decodeBodies(rec.raw);
      const bodies: Record<string, unknown> = {};
      let ke = 0;
      let pe = 0;
      let vmax = 0;
      // Only the f32 words of each body (inv_mass, v); position words are fixed-point integers.
      const floats = floatWords(rec.raw);
      const scan = scanNonFinite(floats);
      nonfiniteCount += scan.count;
      for (const hit of scan.first) {
        const word = hit.index % 4;
        if (word > 0 && nonfinite.length < 64) nonfinite.push({ step: rec.step, body: physics.ids[Math.floor(hit.index / 4)]!, field: `v.${"xyz"[word - 1]}` });
      }
      states.forEach((s, i) => {
        const m = physics!.masses[i]!;
        ke += 0.5 * m * dot(s.v_m_s, s.v_m_s);
        pe -= m * dot(g, s.x_m);
        vmax = Math.max(vmax, norm(s.v_m_s));
        bodies[physics!.ids[i]!] = { x_m: s.x_m.map(finiteOr), v_m_s: s.v_m_s.map(finiteOr) };
      });
      files.set(`state/step_${tag}.json`, new TextEncoder().encode(jcs({ step: rec.step, t_s: rec.step * scene.physics.dt_s, bodies })));
      series.push({ step: rec.step, ke_j: finiteOr(ke), pe_j: finiteOr(pe), e_j: finiteOr(ke + pe), v_max_m_s: finiteOr(vmax) });
    }
    metrics["physics"] = { bodies: physics.ids.length, records: series };
    validators.push({ name: "nan.physics", pass: nonfiniteCount === 0, detail: { count: nonfiniteCount, first: nonfinite } });
  }

  if (scene.render !== undefined) {
    render = await renderScene(gpu, scene, plan, options.renderFaults);
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
    const bound = energyBound(scene);
    const over = checkEnergy(render.mean, bound, roundingFactor(render.spp, scene.render.max_bounces));
    validators.push({ name: "energy.image", pass: over.length === 0, detail: { bound, violations: over.map((o) => ({ ...o, value: finiteOr(o.value) })) } });

    const mean = [0, 0, 0];
    const max = [0, 0, 0];
    for (let i = 0; i < render.mean.length; i++) {
      const v = render.mean[i]!;
      if (!Number.isFinite(v)) continue;
      mean[i % 3]! += v;
      max[i % 3] = Math.max(max[i % 3]!, v);
    }
    metrics["image"] = { width: W, height: H, spp: render.spp, mean: mean.map((s) => s / (W * H)), max, nonfinite: scan.count };
  }

  const outputs: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) outputs[name] = sha256Tag(files.get(name)!);
  const deterministic: Manifest["deterministic"] = {
    outputs,
    metrics,
    work: { rays: render?.segments ?? 0, isect_tests: render?.isectTests ?? 0, physics_steps: physicsSteps, gpu_bytes_peak: gpu.bytesPeak },
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

/** CLI exit code implied by a run's validators (src/cli.ts EXIT): 4 non-finite, 5 energy, else 0. */
export function exitCodeFor(m: Manifest): number {
  const failed = m.deterministic.validators.filter((v) => !v.pass);
  if (failed.some((v) => v.name.startsWith("nan."))) return 4;
  if (failed.some((v) => v.name.startsWith("energy."))) return 5;
  return 0;
}

export function deterministicHash(m: Manifest): string {
  return jcsHash(m.deterministic);
}
