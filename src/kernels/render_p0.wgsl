// P0 path tracer (prefixed with rng.wgsl and bsdf_lambert.wgsl). Spheres and infinite planes, two-sided Lambert sampled
// with a cosine-weighted hemisphere, two-sided Lambertian emission, constant or split environment.
// All coordinates are camera-relative (design §3.6), so the camera sits at the origin.
//
// Determinism rules this kernel follows (design §3.3):
//  - one invocation owns one pixel and adds samples to the running f32 sums in sample-index order,
//    starting from the stored sums, so splitting spp over passes cannot change a single bit (N4, G03);
//  - workgroup size is a constant and dispatch shape depends only on the scene and plan (N7);
//  - every division and square root is guarded instead of relying on NaN propagation, because
//    under WGSL's Finite Math Assumption a 0/0 is an indeterminate value, not a NaN (§15.7.2, N9).

// Fault injection for validator negative controls (golden G15). Defaults are inert.
override FAULT_KIND: u32 = 0u; // 0 none, 1 NaN bits at (FAULT_X, FAULT_Y, FAULT_C), 2 +Inf bits there
override FAULT_X: u32 = 0u;
override FAULT_Y: u32 = 0u;
override FAULT_C: u32 = 0u;
override BSDF_GAIN: f32 = 1.0;

const NONE: u32 = 0xffffffffu;
// |dot(dir, normal)| below this counts as parallel to a plane (scene.schema.json Object plane).
const PARALLEL_EPS: f32 = 0x1p-20f;

struct Params {
  img: vec4<u32>,       // width, height, max_bounces, seed
  pass_info: vec4<u32>, // first sample, sample count, tile list offset, sphere count
  counts: vec4<u32>,    // plane count, environment type (0 constant, 1 split), write id AOV, unused
  cam_fwd: vec4<f32>,   // forward, 1/width
  cam_right: vec4<f32>, // right * tan(vfov/2) * aspect, 1/height
  cam_up: vec4<f32>,    // up * tan(vfov/2), unused
  env_up: vec4<f32>,
  env_a: vec4<f32>,     // constant radiance, or the upper half for split
  env_b: vec4<f32>,     // lower half for split
}

struct Sphere {
  cr: vec4<f32>,   // center, radius
  info: vec4<u32>, // material index, object rank, unused, unused
}

struct Plane {
  nd: vec4<f32>,   // unit normal n, d with dot(n, x) = d
  info: vec4<u32>, // material index, object rank, unused, unused
}

struct Material {
  albedo: vec4<f32>,
  emission: vec4<f32>, // radiance RGB
}

struct Hit {
  t: f32,
  n: vec3<f32>,
  mat: u32,
  id: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> spheres: array<Sphere>;
@group(0) @binding(2) var<storage, read> planes: array<Plane>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(4) var<storage, read> tiles: array<vec2<u32>>;
// Per pixel: sum r,g,b then sum of squares r,g,b, stored as f32 bits so faults can write raw bits.
@group(0) @binding(5) var<storage, read_write> accum: array<u32>;
@group(0) @binding(6) var<storage, read_write> ids: array<u32>;
// Per pixel: ray segments traced so far (deterministic work counter).
@group(0) @binding(7) var<storage, read_write> work: array<u32>;

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
  var best = Hit(0.0, vec3<f32>(0.0), NONE, NONE);
  for (var i = 0u; i < P.pass_info.w; i++) {
    let s = spheres[i];
    let t = hit_sphere(o, d, s);
    if (t > 0.0 && (best.mat == NONE || t < best.t)) {
      best = Hit(t, (o + t * d - s.cr.xyz) / s.cr.w, s.info.x, s.info.y);
    }
  }
  for (var i = 0u; i < P.counts.x; i++) {
    let p = planes[i];
    let denom = dot(p.nd.xyz, d);
    if (abs(denom) < PARALLEL_EPS) {
      continue;
    }
    let t = (p.nd.w - dot(p.nd.xyz, o)) / denom;
    if (t > 0.0 && (best.mat == NONE || t < best.t)) {
      best = Hit(t, p.nd.xyz, p.info.x, p.info.y);
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

struct Sample {
  radiance: vec3<f32>,
  segments: u32,
}

fn trace(px: u32, py: u32, s: u32) -> Sample {
  let seed = P.img.w;
  let jitter = rng4(seed, STREAM_SAMPLING, vec4<u32>(px, py, s, 0u));
  var o = vec3<f32>(0.0);
  var d = camera_dir(px, py, to_unit_float(jitter.x), to_unit_float(jitter.y));
  var radiance = vec3<f32>(0.0);
  var throughput = vec3<f32>(1.0);
  var segments = 0u;
  // Emission is collected at surface interactions 1..max_bounces+1; an escaping ray collects the
  // environment (scene.schema.json Render.max_bounces).
  for (var depth = 0u; depth <= P.img.z; depth++) {
    segments++;
    let h = intersect(o, d);
    if (h.mat == NONE) {
      radiance += throughput * environment(d);
      break;
    }
    let m = materials[h.mat];
    radiance += throughput * m.emission.xyz;
    if (depth == P.img.z) {
      break;
    }
    let p = o + h.t * d;
    let ns = select(-h.n, h.n, dot(h.n, d) < 0.0); // two-sided: face the incoming ray
    let u = rng4(seed, STREAM_SAMPLING, vec4<u32>(px, py, s, 1u + depth));
    d = lambert_sample(ns, to_unit_float(u.x), to_unit_float(u.y));
    throughput = throughput * lambert_weight(m.albedo.xyz) * BSDF_GAIN;
    o = offset_ray(p, ns);
  }
  return Sample(radiance, segments);
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
  var segments = work[pix];
  let first = P.pass_info.x;
  for (var s = first; s < first + P.pass_info.y; s++) {
    let smp = trace(px, py, s);
    sum = sum + smp.radiance;
    sq = sq + smp.radiance * smp.radiance;
    segments += smp.segments;
  }
  accum[base] = bitcast<u32>(sum.x);
  accum[base + 1u] = bitcast<u32>(sum.y);
  accum[base + 2u] = bitcast<u32>(sum.z);
  accum[base + 3u] = bitcast<u32>(sq.x);
  accum[base + 4u] = bitcast<u32>(sq.y);
  accum[base + 5u] = bitcast<u32>(sq.z);
  work[pix] = segments;
  if (FAULT_KIND != 0u && px == FAULT_X && py == FAULT_Y) {
    accum[base + FAULT_C] = select(0x7f800000u, 0x7fc00000u, FAULT_KIND == 1u);
  }
}
