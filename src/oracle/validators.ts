// The three P0 validators (design §3.8): V-NaN, V-Energy, V-Furnace.

import { canonicalEntries } from "../core/jcs.ts";
import type { Scene, Vec3 } from "../core/scene_types.ts";
import { KIND, materialKind, radianceRgb } from "../runtime/render.ts";

export interface NonFinite {
  index: number;
  kind: "nan" | "inf";
}

/**
 * Bit-level scan: exponent bits all ones. Done on the CPU after readback, because under WGSL's
 * Finite Math Assumption (§15.7.2) a shader cannot be trusted to test its own values for NaN.
 */
export function scanNonFinite(values: Float32Array, limit = 64): { count: number; first: NonFinite[] } {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let count = 0;
  const first: NonFinite[] = [];
  for (let i = 0; i < bits.length; i++) {
    const u = bits[i]!;
    if ((u & 0x7f800000) === 0x7f800000) {
      count++;
      if (first.length < limit) first.push({ index: i, kind: (u & 0x007fffff) !== 0 ? "nan" : "inf" });
    }
  }
  return { count, first };
}

/**
 * How V-Energy can judge a scene (design P1D13):
 *  - per_sample: BSDF sampling over Lambert materials only. Every bounce multiplies throughput by
 *    the albedo exactly, so B below bounds every single sample (the P0 rule);
 *  - statistical: light sampling or non-Lambert materials. A single NEE sample can be arbitrarily
 *    large, but the expectation is still bounded by B (energy-conserving BSDFs, rho <= 1), so the
 *    pixel mean must satisfy mean <= B (1 + tau) + 6 sigma_hat / sqrt(N);
 *  - not_applicable: point lights. Radiance next to a point light has no finite bound.
 */
export type EnergyMode = "per_sample" | "statistical" | "not_applicable";

export function energyMode(scene: Scene): EnergyMode {
  if (Object.keys(scene.lights ?? {}).length > 0) return "not_applicable";
  const lambert = Object.values(scene.materials).every((m) => materialKind(m) === KIND.LAMBERT);
  return lambert && (scene.render!.strategy ?? "mis") === "bsdf" ? "per_sample" : "statistical";
}

/**
 * Per-channel bound B_c = L_env,max,c + Le_max,c * sum_{k=0..D} rho_max,c^k on a path's value
 * (per sample for Lambert + BSDF sampling, in expectation otherwise). Non-Lambert materials count
 * with rho = 1: their directional albedo is at most 1.
 */
export function energyBound(scene: Scene): Vec3 {
  const D = scene.render!.max_bounces;
  const env = scene.environment!;
  const envMax: Vec3 =
    env.type === "constant"
      ? radianceRgb(env.luminance_cdm2, env.color)
      : (radianceRgb(Math.max(env.upper_cdm2, env.lower_cdm2), env.color) as Vec3);
  const leMax: Vec3 = [0, 0, 0];
  const rhoMax: Vec3 = [0, 0, 0];
  for (const [, m] of canonicalEntries(scene.materials)) {
    const le = radianceRgb(m.emissive_cdm2 ?? 0, m.emissive_color ?? [1, 1, 1]);
    const lambert = materialKind(m) === KIND.LAMBERT;
    for (let c = 0; c < 3; c++) {
      leMax[c] = Math.max(leMax[c]!, le[c]!);
      rhoMax[c] = Math.max(rhoMax[c]!, lambert ? m.base_color[c]! : 1);
    }
  }
  return [0, 1, 2].map((c) => {
    let series = 0;
    for (let k = 0, p = 1; k <= D; k++, p *= rhoMax[c]!) series += p;
    return envMax[c]! + leMax[c]! * series;
  }) as Vec3;
}

/** Rounding allowance for a mean of spp samples each made of up to D+1 bounces (u = 2^-23). */
export function roundingFactor(spp: number, maxBounces: number): number {
  return 1 + (spp + 5 * (maxBounces + 1)) * 2 ** -23;
}

export interface BoundViolation {
  pixel: number;
  channel: number;
  value: number;
  bound: number;
}

/** Statistical form: mean <= B (1 + tau) + k sigma_hat / sqrt(N), sigma_hat from the per-pixel second moment. */
export function checkEnergyStatistical(mean: Float32Array, m2: Float32Array, spp: number, bound: Vec3, factor: number, k = 6, limit = 16): BoundViolation[] {
  const out: BoundViolation[] = [];
  for (let i = 0; i < mean.length && out.length < limit; i++) {
    const c = i % 3;
    const v = mean[i]!;
    const variance = spp > 1 ? (Math.max(0, m2[i]! - v * v) * spp) / (spp - 1) : m2[i]!;
    const b = bound[c]! * factor + (k * Math.sqrt(variance)) / Math.sqrt(spp);
    if (!(v >= 0 && v <= b)) out.push({ pixel: Math.floor(i / 3), channel: c, value: v, bound: b });
  }
  return out;
}

export function checkEnergy(mean: Float32Array, bound: Vec3, factor: number, limit = 16): BoundViolation[] {
  const out: BoundViolation[] = [];
  for (let i = 0; i < mean.length && out.length < limit; i++) {
    const c = i % 3;
    const v = mean[i]!;
    const b = bound[c]! * factor;
    if (!(v >= 0 && v <= b)) out.push({ pixel: Math.floor(i / 3), channel: c, value: v, bound: b });
  }
  return out;
}
