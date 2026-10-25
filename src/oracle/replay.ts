// f64 replay of the GPU's camera rays (design P1 ②, "回放"). For each pixel and sample it rebuilds the
// exact jitter the kernel used (Philox, stream 0, counter (px, py, s, 0)), traces the camera ray in
// double precision and evaluates a closed form for what that sample must return. For deterministic
// paths (delta lobes, a single point light, max_bounces = 1) the expected pixel equals the GPU
// estimate up to f32 error; for stochastic ones it is the exact expectation the estimate converges to.
// Samples too close to a silhouette, a horizon or a tie between objects, where an f32 ray could take
// the other branch, are reported as fragile and excluded by the assertions.

import { canonicalEntries } from "../core/jcs.ts";
import { rng4, toUnitFloat } from "../core/rng.ts";
import type { Material, Scene, Vec3 } from "../core/scene_types.ts";
import { add, cross, dot, norm, normalize, scale, sub } from "../core/vec.ts";
import { KIND, materialKind, radianceRgb } from "../runtime/render.ts";
import { frDielectric, frSchlick } from "./ref_bsdf.ts";

const FRAGILE = 1e-6;

export interface ReplayHit {
  t: number;
  p: Vec3;
  /** Geometric normal facing the incoming ray. */
  n: Vec3;
  id: string;
  material: Material;
  shape: "sphere" | "plane";
}

export interface ReplayContext {
  scene: Scene;
  /** Closest hit of a ray in f64, or null; "fragile" when an f32 ray could disagree. */
  trace(o: Vec3, d: Vec3): ReplayHit | null | "fragile";
  environment(d: Vec3): Vec3 | "fragile";
}

/** Value of one camera sample, or "fragile" to drop the pixel from the comparison. */
export type SampleValue = (ctx: ReplayContext, d: Vec3, hit: ReplayHit | null) => Vec3 | "fragile";

export interface ReplayImage {
  width: number;
  height: number;
  /** Per-pixel expected mean, RGB interleaved. */
  expected: Float64Array;
  /**
   * Per-pixel variance (N - 1 normalized) of the expected values across the pixel's own samples:
   * the anti-aliasing part of the GPU's per-sample variance. Var(sample) = this + the light
   * transport noise, so subtracting it isolates the noise the expectation is conditioned against.
   */
  jitterVar: Float64Array;
  fragile: Uint8Array;
}

export function replayContext(scene: Scene): ReplayContext {
  const objects = canonicalEntries(scene.objects);
  const env = scene.environment!;
  return {
    scene,
    trace(o, d) {
      let best: ReplayHit | null = null;
      let second = Infinity;
      for (const [id, obj] of objects) {
        let t = -1;
        let n: Vec3 = [0, 0, 0];
        if (obj.shape === "sphere") {
          const f = sub(o, obj.center_m);
          const b = -dot(f, d);
          const l = add(f, scale(d, b));
          const disc = obj.radius_m * obj.radius_m - dot(l, l);
          if (Math.abs(disc) < FRAGILE * obj.radius_m * obj.radius_m) return "fragile";
          if (disc < 0) continue;
          const q = b + Math.sign(b || 1) * Math.sqrt(disc);
          const t0 = (dot(f, f) - obj.radius_m * obj.radius_m) / q;
          const ts = [Math.min(t0, q), Math.max(t0, q)].filter((x) => x > 1e-9 * Math.max(1, norm(o)));
          if (ts.length === 0) continue;
          t = ts[0]!;
          n = normalize(sub(add(o, scale(d, t)), obj.center_m));
        } else {
          const nn = normalize(obj.normal);
          const denom = dot(nn, d);
          if (Math.abs(denom) < FRAGILE) return "fragile";
          t = dot(nn, sub(obj.point_m, o)) / denom;
          if (!(t > 1e-9 * Math.max(1, norm(o)))) continue;
          n = nn;
        }
        if (best === null || t < best.t) {
          second = best?.t ?? second;
          best = { t, p: add(o, scale(d, t)), n: dot(n, d) < 0 ? n : scale(n, -1), id, material: scene.materials[obj.material]!, shape: obj.shape };
        } else {
          second = Math.min(second, t);
        }
      }
      if (best !== null && Math.abs(second - best.t) < FRAGILE * best.t) return "fragile";
      return best;
    },
    environment(d) {
      if (env.type === "constant") return radianceRgb(env.luminance_cdm2, env.color);
      const c = dot(d, normalize(env.up));
      if (Math.abs(c) < FRAGILE) return "fragile";
      return radianceRgb(c > 0 ? env.upper_cdm2 : env.lower_cdm2, env.color);
    },
  };
}

/** Camera basis exactly as src/runtime/render.ts builds it, in f64. */
function camera(scene: Scene) {
  const cam = scene.camera!;
  const r = scene.render!;
  const fwd = normalize(sub(cam.look_at_m, cam.position_m));
  const right = normalize(cross(fwd, normalize(cam.up)));
  const up = cross(right, fwd);
  const tanHalf = Math.tan(cam.vfov_rad / 2);
  return { origin: cam.position_m, fwd, right: scale(right, tanHalf * (r.width_px / r.height_px)), up: scale(up, tanHalf) };
}

export function replay(scene: Scene, value: SampleValue): ReplayImage {
  const r = scene.render!;
  const W = r.width_px;
  const H = r.height_px;
  const cam = camera(scene);
  const ctx = replayContext(scene);
  const expected = new Float64Array(W * H * 3);
  const jitterVar = new Float64Array(W * H * 3);
  const fragile = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const pix = py * W + px;
      const acc: Vec3 = [0, 0, 0];
      const acc2: Vec3 = [0, 0, 0];
      for (let s = 0; s < r.spp && !fragile[pix]; s++) {
        const j = rng4(scene.seed, 0, px, py, s, 0);
        const u = (2 * (px + toUnitFloat(j[0])) - W) / W;
        const v = (H - 2 * (py + toUnitFloat(j[1]))) / H;
        const d = normalize(add(add(cam.fwd, scale(cam.right, u)), scale(cam.up, v)));
        const hit = ctx.trace(cam.origin, d);
        const val = hit === "fragile" ? "fragile" : value(ctx, d, hit);
        if (val === "fragile") {
          fragile[pix] = 1;
          break;
        }
        for (let c = 0; c < 3; c++) {
          acc[c]! += val[c]!;
          acc2[c]! += val[c]! * val[c]!;
        }
      }
      for (let c = 0; c < 3; c++) {
        const mean = acc[c]! / r.spp;
        expected[pix * 3 + c] = mean;
        jitterVar[pix * 3 + c] = r.spp > 1 ? Math.max(0, acc2[c]! / r.spp - mean * mean) * (r.spp / (r.spp - 1)) : 0;
      }
    }
  }
  return { width: W, height: H, expected, jitterVar, fragile };
}

// --- Closed forms for the P1 goldens ---------------------------------------------------------------

const emission = (m: Material): Vec3 => radianceRgb(m.emissive_cdm2 ?? 0, m.emissive_color ?? [1, 1, 1]);
const fresnelMix = (m: Material, c: number): Vec3 =>
  m.base_color.map((a) => (m.metallic ?? 0) * frSchlick(a, c) + (1 - (m.metallic ?? 0)) * frDielectric(c, m.ior ?? 1)) as Vec3;

/**
 * A delta material whose specular lobe is chosen with probability 1 (metallic 1, or a black base):
 * the sample returns F(mu) times whatever the mirrored ray sees (max_bounces >= 1).
 */
export const deltaReflection: SampleValue = (ctx, d, hit) => {
  if (hit === null) return ctx.environment(d);
  const m = hit.material;
  if (materialKind(m) !== KIND.DELTA || ((m.metallic ?? 0) < 1 && m.base_color.some((c) => c > 0))) throw new Error("deltaReflection: material is not a pure delta reflector");
  const mu = -dot(d, hit.n);
  const r = sub(d, scale(hit.n, 2 * dot(d, hit.n)));
  const next = ctx.trace(add(hit.p, scale(hit.n, 1e-9 * Math.max(1, norm(hit.p)))), r);
  if (next === "fragile") return "fragile";
  const seen = next === null ? ctx.environment(r) : emission(next.material);
  if (seen === "fragile") return "fragile";
  const f = fresnelMix(m, mu);
  const e = emission(m);
  return [e[0] + f[0] * seen[0], e[1] + f[1] * seen[1], e[2] + f[2] * seen[2]];
};

/** Lambert surface lit by the scene's single point light, strategy nee, max_bounces 1, no other emitters. */
export const pointLightDirect: SampleValue = (ctx, d, hit) => {
  if (hit === null) return ctx.environment(d);
  const lights = Object.values(ctx.scene.lights ?? {});
  if (lights.length !== 1 || materialKind(hit.material) !== KIND.LAMBERT) throw new Error("pointLightDirect: needs one point light and a Lambert surface");
  const l = lights[0]!;
  const toL = sub(l.position_m, hit.p);
  const r2 = dot(toL, toL);
  const wi = scale(toL, 1 / Math.sqrt(r2));
  const cos = dot(hit.n, wi);
  if (Math.abs(cos) < FRAGILE) return "fragile";
  const e = emission(hit.material);
  if (cos < 0) return e;
  const block = ctx.trace(add(hit.p, scale(hit.n, 1e-9 * Math.max(1, norm(hit.p)))), wi);
  if (block === "fragile") return "fragile";
  if (block !== null && block.t * block.t < r2) return e;
  const I = radianceRgb(l.intensity_cd, l.color);
  return [0, 1, 2].map((c) => e[c]! + (hit.material.base_color[c]! / Math.PI) * I[c]! * cos / r2) as Vec3;
};

/**
 * Lambert plane under one emissive sphere entirely above its horizon: E = pi L (R/d)^2 cos(theta)
 * (view factor of a sphere seen from a tilted differential area), so L_o = rho L (R/d)^2 cos(theta).
 * Samples that hit the sphere itself return its emission.
 */
export const sphereLightPlane: SampleValue = (ctx, d, hit) => {
  if (hit === null) return ctx.environment(d);
  if (hit.shape === "sphere") return emission(hit.material);
  const emitters = canonicalEntries(ctx.scene.objects).filter(([, o]) => o.shape === "sphere" && (ctx.scene.materials[o.material]!.emissive_cdm2 ?? 0) > 0);
  if (emitters.length !== 1) throw new Error("sphereLightPlane: needs exactly one emissive sphere");
  const s = emitters[0]![1] as Extract<Scene["objects"][string], { shape: "sphere" }>;
  const toC = sub(s.center_m, hit.p);
  const dist = norm(toC);
  const cos = dot(hit.n, scale(toC, 1 / dist));
  const sinA = s.radius_m / dist;
  if (cos < sinA - FRAGILE) throw new Error("sphereLightPlane: sphere dips below the horizon of a visible plane point");
  const L = emission(ctx.scene.materials[s.material]!);
  return [0, 1, 2].map((c) => hit.material.base_color[c]! * L[c]! * sinA * sinA * cos) as Vec3;
};
