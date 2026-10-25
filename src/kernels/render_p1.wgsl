// P1 path tracer (prefixed with rng.wgsl, bsdf_lambert.wgsl and bsdf_p1.wgsl). Spheres and infinite
// planes; materials from bsdf_p1.wgsl; point lights, emissive spheres and the environment as lights;
// three estimators selected per scene (render.strategy, design P1D12):
//   bsdf: BSDF sampling only, exactly the P0 estimator
//   nee:  light sampling at every non-delta vertex; BSDF hits on samplable lights count 0
//   mis:  both, weighted by the balance heuristic (Veach 1997 §9.2.2; MIS_HEURISTIC = 0 for power)
// All coordinates are camera-relative (design §3.6), so the camera sits at the origin.
//
// Determinism rules (design §3.3): one invocation owns one pixel and adds samples to the running
// f32 sums in sample-index order (N4, G03); constant workgroup size (N7); guards instead of NaN
// propagation (N9, WGSL §15.7.2). With all materials Lambert and strategy bsdf the arithmetic is
// the P0 kernel's, operation for operation, so migrated v1 scenes keep their bytes (P1D11, G32).
// Random dimensions (x-rng-streams): 1+b BSDF sample of bounce b, 0x80000000+b light sample.

// Fault injection for validator negative controls (golden G15). Defaults are inert.
override FAULT_KIND: u32 = 0u; // 0 none, 1 NaN bits at (FAULT_X, FAULT_Y, FAULT_C), 2 +Inf bits there
override FAULT_X: u32 = 0u;
override FAULT_Y: u32 = 0u;
override FAULT_C: u32 = 0u;
override BSDF_GAIN: f32 = 1.0;
// Candidates (design §3.4); the defaults are the runtime's choice (contests in candidates/p1,
// decisions F3 and F4 in docs/P1-02).
override MIS_HEURISTIC: u32 = 1u; // 0 power (beta = 2), 1 balance
override SPHERE_SAMPLER: u32 = 0u; // 0 uniform cone (PBRT-v4 ch. 6), 1 uniform area
// Per-scene specialization, set by the host from the scene so code a scene cannot reach is
// removed at pipeline creation (a P0 scene compiles to the P0 kernel's work; MT3).
override STRATEGY: u32 = 2u;    // 0 bsdf, 1 nee, 2 mis (render.strategy)
override MATERIALS: u32 = 7u;   // bit per material kind present: 1 Lambert, 2 microfacet, 4 delta
override WORK_STRIDE: u32 = 4u; // 1: ray segments only; 4: plus shadow rays, specular choices, NEE luminance

const NONE: u32 = 0xffffffffu;
// |dot(dir, normal)| below this counts as parallel to a plane (scene.schema.json Object plane).
const PARALLEL_EPS: f32 = 0x1p-20f;
const STRATEGY_BSDF: u32 = 0u;
const STRATEGY_NEE: u32 = 1u;
const LIGHT_POINT: u32 = 0u;
const LIGHT_SPHERE: u32 = 1u;
const LIGHT_ENV: u32 = 2u;
const NEE_BLOCK: u32 = 0x80000000u;
// Squared distance floor for point lights: a light touching a surface stays finite (design ④).
const R2_MIN: f32 = 1e-12;

struct Params {
  img: vec4<u32>,        // width, height, max_bounces, seed
  pass_info: vec4<u32>,  // first sample, sample count, tile list offset, sphere count
  counts: vec4<u32>,     // plane count, environment type (0 constant, 1 split), write id AOV, unused
  cam_fwd: vec4<f32>,    // forward, 1/width
  cam_right: vec4<f32>,  // right * tan(vfov/2) * aspect, 1/height
  cam_up: vec4<f32>,     // up * tan(vfov/2), unused
  env_up: vec4<f32>,
  env_a: vec4<f32>,      // constant radiance, or the upper half for split
  env_b: vec4<f32>,      // lower half for split
  light_info: vec4<u32>, // light count, strategy (as STRATEGY), environment light index or NONE, unused
}

// Spheres and planes share one record layout and one buffer (WebGPU guarantees only 8 storage
// buffers per stage): prims[0 .. sphere count) are spheres, the planes follow.
struct Sphere {
  cr: vec4<f32>,   // center, radius
  info: vec4<u32>, // material index, object rank, light index or NONE, unused
}

struct Plane {
  nd: vec4<f32>,   // unit normal n, d with dot(n, x) = d
  info: vec4<u32>, // material index, object rank, NONE, unused
}

struct Material {
  albedo: vec4<f32>,   // base_color, metallic
  emission: vec4<f32>, // radiance RGB, unused
  spec: vec4<f32>,     // alpha, ior, ebar_delta, unused
  flags: vec4<u32>,    // kind (KIND_*), unused, unused, unused
}

struct Light {
  pos: vec4<f32>,  // point position or sphere center (camera-relative), sphere radius
  rad: vec4<f32>,  // RGB intensity (point) or radiance (sphere); selection probability
  info: vec4<u32>, // kind (LIGHT_*), object rank, environment sampling (0 sphere, 1 upper hemisphere), unused
}

struct Hit {
  t: f32,
  n: vec3<f32>,
  mat: u32,
  id: u32,
  light: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> prims: array<Sphere>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(4) var<storage, read> tiles: array<vec2<u32>>;
// Per pixel: sum r,g,b then sum of squares r,g,b, stored as f32 bits so faults can write raw bits.
@group(0) @binding(5) var<storage, read_write> accum: array<u32>;
@group(0) @binding(6) var<storage, read_write> ids: array<u32>;
// Per pixel (WORK_STRIDE words): ray segments, then shadow rays, specular lobe choices, NEE luminance (f32 bits).
@group(0) @binding(7) var<storage, read_write> work: array<u32>;
@group(0) @binding(8) var<storage, read> lights: array<Light>;

// Ray/sphere after Haines et al., "Precision Improvements for Ray/Sphere Intersection",
// Ray Tracing Gems ch. 7 (2019): the discriminant is formed from the closest-approach vector and
// the near root from c/q, avoiding the cancellation of the textbook b^2 - 4ac form. d is unit length.
fn hit_sphere(o: vec3<f32>, d: vec3<f32>, s: Sphere) -> f32 {
  let c = s.cr.xyz;
  let r = s.cr.w;
  let f = o - c;
  let b = -dot(f, d);
  let l = f + b * d;
  let disc = r * r - dot(l, l);
  if (disc < 0.0) {
    return -1.0;
  }
  let q = b + select(-1.0, 1.0, b >= 0.0) * sqrt(disc);
  if (q == 0.0) {
    return -1.0;
  }
  let t0 = (dot(f, f) - r * r) / q;
  let t1 = q;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  if (tn > 0.0) {
    return tn;
  }
  if (tf > 0.0) {
    return tf;
  }
  return -1.0;
}

// Closest hit; ties keep the lower index, and arrays are in canonical id order, so ties resolve
// the same way on every run.
fn intersect(o: vec3<f32>, d: vec3<f32>) -> Hit {
  var best = Hit(0.0, vec3<f32>(0.0), NONE, NONE, NONE);
  for (var i = 0u; i < P.pass_info.w; i++) {
    let s = prims[i];
    let t = hit_sphere(o, d, s);
    if (t > 0.0 && (best.mat == NONE || t < best.t)) {
      best = Hit(t, (o + t * d - s.cr.xyz) / s.cr.w, s.info.x, s.info.y, s.info.z);
    }
  }
  for (var i = 0u; i < P.counts.x; i++) {
    let rec = prims[P.pass_info.w + i];
    let p = Plane(rec.cr, rec.info);
    let denom = dot(p.nd.xyz, d);
    if (abs(denom) < PARALLEL_EPS) {
      continue;
    }
    let t = (p.nd.w - dot(p.nd.xyz, o)) / denom;
    if (t > 0.0 && (best.mat == NONE || t < best.t)) {
      best = Hit(t, p.nd.xyz, p.info.x, p.info.y, NONE);
    }
  }
  return best;
}

// Wächter & Binder, "A Fast and Robust Method for Avoiding Self-Intersection", Ray Tracing Gems
// ch. 6 (2019): move the origin a fixed number of ulps along n (integer arithmetic on the float bits),
// with a small absolute offset near zero where ulps vanish.
fn offset_ray(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let of_i = vec3<i32>(256.0 * n);
  let p_i = bitcast<vec3<f32>>(bitcast<vec3<i32>>(p) + select(of_i, -of_i, p < vec3<f32>(0.0)));
  return select(p_i, p + (1.0 / 65536.0) * n, abs(p) < vec3<f32>(1.0 / 32.0));
}

fn environment(d: vec3<f32>) -> vec3<f32> {
  if (P.counts.y == 1u && !(dot(d, P.env_up.xyz) > 0.0)) {
    return P.env_b.xyz;
  }
  return P.env_a.xyz;
}

// u, v are formed from integer pixel coordinates first so the pixel-center ray of the middle row
// or column of an odd-sized image has an exact 0 component.
fn camera_dir(px: u32, py: u32, jx: f32, jy: f32) -> vec3<f32> {
  let u = (2.0 * (f32(px) + jx) - f32(P.img.x)) * P.cam_fwd.w;
  let v = (f32(P.img.y) - 2.0 * (f32(py) + jy)) * P.cam_right.w;
  return normalize(P.cam_fwd.xyz + u * P.cam_right.xyz + v * P.cam_up.xyz);
}

fn unpack(m: Material) -> Mat {
  return Mat(m.albedo.xyz, m.albedo.w, m.spec.x, m.spec.y, m.spec.z, m.flags.x);
}

fn mis_weight(a: f32, b: f32) -> f32 {
  if (!(a > 0.0)) {
    return 0.0;
  }
  if (MIS_HEURISTIC == 1u) {
    return a / (a + b);
  }
  return (a * a) / (a * a + b * b);
}

// --- Lights ----------------------------------------------------------------------------------------

fn select_light(u: f32) -> u32 {
  let n = P.light_info.x;
  var acc = 0.0;
  for (var i = 0u; i + 1u < n; i++) {
    acc += lights[i].rad.w;
    if (u < acc) {
      return i;
    }
  }
  return n - 1u;
}

// 1 - cos(theta_max) of the cone a sphere subtends from p, formed as sin^2 / (1 + cos) so small
// cones keep their precision; 0 when p is inside or on the sphere (not samplable from there).
fn cone_one_minus_cos(l: Light, p: vec3<f32>) -> f32 {
  let dv = l.pos.xyz - p;
  let d2 = dot(dv, dv);
  let r2 = l.pos.w * l.pos.w;
  if (d2 <= r2 * (1.0 + 1e-6)) {
    return 0.0;
  }
  let sin2 = r2 / d2;
  return sin2 / (1.0 + sqrt(max(0.0, 1.0 - sin2)));
}

// Solid-angle pdf with which light l would have produced direction wi from p; x and nx are the
// point and normal where wi reaches the light (used by area sampling and ignored otherwise).
fn light_pdf(l: Light, p: vec3<f32>, wi: vec3<f32>, x: vec3<f32>, nx: vec3<f32>) -> f32 {
  if (l.info.x == LIGHT_SPHERE) {
    if (SPHERE_SAMPLER == 1u) {
      let dv = x - p;
      let cos_l = abs(dot(nx, wi));
      if (cos_l <= COS_EPS) {
        return 0.0;
      }
      return dot(dv, dv) / (cos_l * 4.0 * PI * l.pos.w * l.pos.w);
    }
    let omc = cone_one_minus_cos(l, p);
    if (omc <= 0.0) {
      return 0.0;
    }
    return 1.0 / (2.0 * PI * omc);
  }
  if (l.info.x == LIGHT_ENV) {
    if (l.info.z == 1u) {
      return select(0.0, 1.0 / (2.0 * PI), dot(wi, P.env_up.xyz) > 0.0);
    }
    return 1.0 / (4.0 * PI);
  }
  return 0.0; // point lights are never hit
}

struct LightSample {
  wi: vec3<f32>,
  dist: f32,      // distance to the sampled point (point lights); unused otherwise
  li: vec3<f32>,  // radiance arriving along wi if unoccluded
  pdf: f32,       // solid-angle pdf; 0 for the delta point light
  valid: bool,
}

fn sample_light(l: Light, p: vec3<f32>, u1: f32, u2: f32) -> LightSample {
  let invalid = LightSample(vec3<f32>(0.0, 0.0, 1.0), 0.0, vec3<f32>(0.0), 0.0, false);
  if (l.info.x == LIGHT_POINT) {
    let dv = l.pos.xyz - p;
    let r2 = max(dot(dv, dv), R2_MIN);
    let dist = sqrt(r2);
    return LightSample(dv / dist, dist, l.rad.xyz / r2, 0.0, true);
  }
  if (l.info.x == LIGHT_SPHERE) {
    if (SPHERE_SAMPLER == 1u) {
      let z = 1.0 - 2.0 * u1;
      let st = sqrt(max(0.0, 1.0 - z * z));
      let phi = 2.0 * PI * u2 - PI;
      let nx = vec3<f32>(st * cos(phi), st * sin(phi), z);
      let x = l.pos.xyz + l.pos.w * nx;
      let dv = x - p;
      let dist = length(dv);
      if (!(dist > 0.0)) {
        return invalid;
      }
      let wi = dv / dist;
      if (dot(nx, wi) >= 0.0) {
        return invalid; // back side, hidden by the front
      }
      return LightSample(wi, dist, l.rad.xyz, light_pdf(l, p, wi, x, nx), true);
    }
    let omc = cone_one_minus_cos(l, p);
    if (omc <= 0.0) {
      return invalid;
    }
    let one_minus = u1 * omc; // 1 - cos(theta), exact for small cones
    let cos_t = 1.0 - one_minus;
    let sin_t = sqrt(max(0.0, one_minus * (2.0 - one_minus)));
    let phi = 2.0 * PI * u2 - PI;
    let axis = normalize(l.pos.xyz - p);
    let wi = to_world(vec3<f32>(sin_t * cos(phi), sin_t * sin(phi), cos_t), axis);
    return LightSample(wi, 0.0, l.rad.xyz, 1.0 / (2.0 * PI * omc), true);
  }
  // Environment.
  var wi: vec3<f32>;
  if (l.info.z == 1u) {
    let st = sqrt(max(0.0, 1.0 - u1 * u1));
    let phi = 2.0 * PI * u2 - PI;
    wi = to_world(vec3<f32>(st * cos(phi), st * sin(phi), u1), P.env_up.xyz);
  } else {
    let z = 1.0 - 2.0 * u1;
    let st = sqrt(max(0.0, 1.0 - z * z));
    let phi = 2.0 * PI * u2 - PI;
    wi = vec3<f32>(st * cos(phi), st * sin(phi), z);
  }
  return LightSample(wi, 0.0, environment(wi), light_pdf(l, p, wi, p, wi), true);
}

struct Sample {
  radiance: vec3<f32>,
  segments: u32,
  shadow_rays: u32,
  specular: u32,
  nee_lum: f32,
}

fn trace(px: u32, py: u32, s: u32) -> Sample {
  let seed = P.img.w;
  let strategy = STRATEGY;
  let jitter = rng4(seed, STREAM_SAMPLING, vec4<u32>(px, py, s, 0u));
  var o = vec3<f32>(0.0);
  var d = camera_dir(px, py, to_unit_float(jitter.x), to_unit_float(jitter.y));
  var radiance = vec3<f32>(0.0);
  var throughput = vec3<f32>(1.0);
  var segments = 0u;
  var shadow_rays = 0u;
  var specular = 0u;
  var nee_lum = 0.0;
  // The vertex the current ray left, the pdf it was sampled with, and whether that was a delta lobe;
  // needed to weight emitters the ray hits (MIS) and meaningless for the camera ray.
  var prev_p = vec3<f32>(0.0);
  var prev_pdf = 0.0;
  var prev_delta = true;
  // Emission is collected at surface interactions 1..max_bounces+1; an escaping ray collects the
  // environment (scene.schema.json Render.max_bounces). Light sampling at bounce b accounts for
  // interaction b+2, so it only happens while b < max_bounces.
  for (var depth = 0u; depth <= P.img.z; depth++) {
    segments++;
    let h = intersect(o, d);
    if (h.mat == NONE) {
      let env = P.light_info.z;
      if (strategy == STRATEGY_BSDF || prev_delta || env == NONE) {
        radiance += throughput * environment(d);
      } else {
        let l = lights[env];
        let pl = l.rad.w * light_pdf(l, prev_p, d, prev_p, d);
        let w = select(mis_weight(prev_pdf, pl), select(1.0, 0.0, pl > 0.0), strategy == STRATEGY_NEE);
        radiance += throughput * environment(d) * w;
      }
      break;
    }
    // Fields are read where they are used: copying the whole 64-byte record per hit costs the
    // P0-shaped scenes measurable time (MT3).
    let emission = materials[h.mat].emission.xyz;
    if (strategy == STRATEGY_BSDF || prev_delta || h.light == NONE) {
      radiance += throughput * emission;
    } else {
      let l = lights[h.light];
      let x = o + h.t * d;
      let pl = l.rad.w * light_pdf(l, prev_p, d, x, h.n);
      let w = select(mis_weight(prev_pdf, pl), select(1.0, 0.0, pl > 0.0), strategy == STRATEGY_NEE);
      radiance += throughput * emission * w;
    }
    if (depth == P.img.z) {
      break;
    }
    let p = o + h.t * d;
    let ns = select(-h.n, h.n, dot(h.n, d) < 0.0); // two-sided: face the incoming ray
    let kind = materials[h.mat].flags.x;

    if (strategy != STRATEGY_BSDF && depth < P.img.z && P.light_info.x > 0u) {
      let mat = unpack(materials[h.mat]);
      let ul = rng4(seed, STREAM_SAMPLING, vec4<u32>(px, py, s, NEE_BLOCK + depth));
      let li = select_light(to_unit_float(ul.x));
      let l = lights[li];
      let ls = sample_light(l, p, to_unit_float(ul.y), to_unit_float(ul.z));
      let cos_i = dot(ns, ls.wi);
      if (ls.valid && cos_i > 0.0) {
        let f = bsdf_eval(mat, ns, -d, ls.wi);
        if (any(f > vec3<f32>(0.0))) {
          shadow_rays++;
          let sh = intersect(offset_ray(p, ns), ls.wi);
          var visible: bool;
          if (l.info.x == LIGHT_POINT) {
            visible = sh.mat == NONE || sh.t >= ls.dist * (1.0 - 0x1p-12f);
          } else if (l.info.x == LIGHT_SPHERE) {
            visible = sh.id == l.info.y;
          } else {
            visible = sh.mat == NONE;
          }
          if (visible) {
            var c: vec3<f32>;
            if (l.info.x == LIGHT_POINT) {
              c = throughput * f * cos_i * ls.li / l.rad.w;
            } else {
              let pl = l.rad.w * ls.pdf;
              let w = select(mis_weight(pl, bsdf_pdf(mat, ns, -d, ls.wi)), 1.0, strategy == STRATEGY_NEE);
              c = throughput * f * cos_i * ls.li * (w / pl);
            }
            radiance += c;
            nee_lum += luminance(c);
          }
        }
      }
    }

    let u = rng4(seed, STREAM_SAMPLING, vec4<u32>(px, py, s, 1u + depth));
    if ((MATERIALS & 6u) == 0u || kind == KIND_LAMBERT) {
      // The P0 path, kept operation for operation (design P1D11).
      d = lambert_sample(ns, to_unit_float(u.x), to_unit_float(u.y));
      throughput = throughput * lambert_weight(materials[h.mat].albedo.xyz) * BSDF_GAIN;
      prev_pdf = dot(ns, d) * INV_PI;
      prev_delta = false;
    } else {
      let bs = bsdf_sample(unpack(materials[h.mat]), ns, -d, vec3<f32>(to_unit_float(u.z), to_unit_float(u.x), to_unit_float(u.y)));
      if (!any(bs.weight > vec3<f32>(0.0))) {
        break;
      }
      d = bs.wi;
      throughput = throughput * bs.weight * BSDF_GAIN;
      prev_pdf = bs.pdf;
      prev_delta = bs.delta;
      specular += select(0u, 1u, bs.specular);
    }
    prev_p = p;
    o = offset_ray(p, ns);
  }
  return Sample(radiance, segments, shadow_rays, specular, nee_lum);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let block = tiles[P.pass_info.z + wg.x];
  let px = block.x * 8u + lid.x;
  let py = block.y * 8u + lid.y;
  if (px >= P.img.x || py >= P.img.y) {
    return;
  }
  let pix = py * P.img.x + px;
  if (P.counts.z == 1u) {
    ids[pix] = intersect(vec3<f32>(0.0), camera_dir(px, py, 0.5, 0.5)).id;
  }
  let base = pix * 6u;
  var sum = vec3<f32>(bitcast<f32>(accum[base]), bitcast<f32>(accum[base + 1u]), bitcast<f32>(accum[base + 2u]));
  var sq = vec3<f32>(bitcast<f32>(accum[base + 3u]), bitcast<f32>(accum[base + 4u]), bitcast<f32>(accum[base + 5u]));
  let wbase = pix * WORK_STRIDE;
  var segments = work[wbase];
  var shadow_rays = 0u;
  var specular = 0u;
  var nee_lum = 0.0;
  if (WORK_STRIDE == 4u) {
    shadow_rays = work[wbase + 1u];
    specular = work[wbase + 2u];
    nee_lum = bitcast<f32>(work[wbase + 3u]);
  }
  let first = P.pass_info.x;
  for (var s = first; s < first + P.pass_info.y; s++) {
    let smp = trace(px, py, s);
    sum = sum + smp.radiance;
    sq = sq + smp.radiance * smp.radiance;
    segments += smp.segments;
    shadow_rays += smp.shadow_rays;
    specular += smp.specular;
    nee_lum += smp.nee_lum;
  }
  accum[base] = bitcast<u32>(sum.x);
  accum[base + 1u] = bitcast<u32>(sum.y);
  accum[base + 2u] = bitcast<u32>(sum.z);
  accum[base + 3u] = bitcast<u32>(sq.x);
  accum[base + 4u] = bitcast<u32>(sq.y);
  accum[base + 5u] = bitcast<u32>(sq.z);
  work[wbase] = segments;
  if (WORK_STRIDE == 4u) {
    work[wbase + 1u] = shadow_rays;
    work[wbase + 2u] = specular;
    work[wbase + 3u] = bitcast<u32>(nee_lum);
  }
  if (FAULT_KIND != 0u && px == FAULT_X && py == FAULT_Y) {
    accum[base + FAULT_C] = select(0x7f800000u, 0x7fc00000u, FAULT_KIND == 1u);
  }
}
