// The three P0 validators (design §3.8): V-NaN, V-Energy, V-Furnace.

import { canonicalEntries } from "../core/jcs.ts";
import type { Scene, Vec3 } from "../core/scene_types.ts";
import { radianceRgb } from "../runtime/render.ts";

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
 * Per-channel upper bound on any single path sample for the P0 integrator. With cosine sampling
 * every bounce multiplies throughput by the albedo exactly, so a path that collects emission at
 * interactions 1..D+1 and the environment once is bounded by
 *   B_c = L_env,max,c + Le_max,c * sum_{k=0..D} rho_max,c^k.
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
    for (let c = 0; c < 3; c++) {
      leMax[c] = Math.max(leMax[c]!, le[c]!);
      rhoMax[c] = Math.max(rhoMax[c]!, m.base_color[c]!);
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
