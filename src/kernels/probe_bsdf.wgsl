// BSDF probes for goldens G12 (Lambert) and G24 (P1 material), prefixed with rng.wgsl,
// bsdf_lambert.wgsl and bsdf_p1.wgsl. Random numbers use the
// harness stream 4 with counter (test, index, sample, 0): this is test tooling, not the runtime.
// Per-invocation partial sums cover SAMPLES_PER_BLOCK samples; the host adds blocks in f64.

const STREAM_HARNESS: u32 = 4u;
const TEST_ALBEDO: u32 = 1u;
const TEST_SAMPLE: u32 = 2u;
const TEST_RECIP: u32 = 3u;
const TEST_HIST: u32 = 4u;
const HIST_MU: u32 = 32u;
const HIST_PHI: u32 = 64u;

struct ProbeParams {
  info: vec4<u32>,   // seed, direction count, blocks per direction, samples per block
  albedo: vec4<f32>, // base_color, metallic
  spec: vec4<f32>,   // alpha, ior, ebar_delta, unused
  flags: vec4<u32>,  // material kind, unused...
}

@group(0) @binding(0) var<uniform> R: ProbeParams;
@group(0) @binding(1) var<storage, read> dirs: array<vec4<f32>>;    // wo (xyz) per direction
@group(0) @binding(2) var<storage, read> normals: array<vec4<f32>>; // n (xyz) per direction
@group(0) @binding(3) var<storage, read_write> out: array<f32>;

fn uni(test: u32, index: u32, s: u32) -> vec4<f32> {
  let r = rng4(R.info.x, STREAM_HARNESS, vec4<u32>(test, index, s, 0u));
  return vec4<f32>(to_unit_float(r.x), to_unit_float(r.y), to_unit_float(r.z), to_unit_float(r.w));
}

// Uniform direction on the hemisphere around +z: an estimator independent of lambert_sample.
fn uniform_hemisphere(u1: f32, u2: f32) -> vec3<f32> {
  let z = u1;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = 2.0 * PI * u2 - PI;
  return vec3<f32>(r * cos(phi), r * sin(phi), z);
}

// Directional albedo and pdf normalization by uniform sampling, normal +z, wo = dirs[d].
// out[8k..8k+7] = sum f*cos/p_u (rgb), sum pdf/p_u, sum (f*cos/p_u)^2 (rgb), sum (pdf/p_u)^2
@compute @workgroup_size(64)
fn albedo_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y * R.info.z) {
    return;
  }
  let d = k / R.info.z;
  let block = k % R.info.z;
  let n = vec3<f32>(0.0, 0.0, 1.0);
  let wo = dirs[d].xyz;
  var sf = vec3<f32>(0.0);
  var qf = vec3<f32>(0.0);
  var sp = 0.0;
  var qp = 0.0;
  for (var j = 0u; j < R.info.w; j++) {
    let u = uni(TEST_ALBEDO, d, block * R.info.w + j);
    let wi = uniform_hemisphere(u.x, u.y);
    let fc = lambert_eval(R.albedo.xyz, n, wo, wi) * dot(n, wi) * (2.0 * PI);
    let pr = lambert_pdf(n, wo, wi) * (2.0 * PI);
    sf = sf + fc;
    qf = qf + fc * fc;
    sp = sp + pr;
    qp = qp + pr * pr;
  }
  let o = k * 8u;
  out[o] = sf.x;
  out[o + 1u] = sf.y;
  out[o + 2u] = sf.z;
  out[o + 3u] = sp;
  out[o + 4u] = qf.x;
  out[o + 5u] = qf.y;
  out[o + 6u] = qf.z;
  out[o + 7u] = qp;
}

// Sampler consistency with arbitrary normals. out[12k..12k+11] =
//   sum w (rgb), max relative |w - f*cos/pdf|, sum w^2 (rgb), samples outside the wo hemisphere,
//   max ||wi| - 1|, samples with pdf <= 0, unused, unused
@compute @workgroup_size(64)
fn sample_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y * R.info.z) {
    return;
  }
  let d = k / R.info.z;
  let block = k % R.info.z;
  let n = normals[d].xyz;
  let wo = dirs[d].xyz;
  let ns = select(-n, n, dot(n, wo) > 0.0);
  var sw = vec3<f32>(0.0);
  var qw = vec3<f32>(0.0);
  var rel = 0.0;
  var outside = 0.0;
  var len_err = 0.0;
  var zero_pdf = 0.0;
  for (var j = 0u; j < R.info.w; j++) {
    let u = uni(TEST_SAMPLE, d, block * R.info.w + j);
    let wi = lambert_sample(ns, u.x, u.y);
    let w = lambert_weight(R.albedo.xyz);
    let pdf = lambert_pdf(n, wo, wi);
    if (!(dot(ns, wi) > 0.0)) {
      outside += 1.0;
    }
    len_err = max(len_err, abs(length(wi) - 1.0));
    if (pdf > 0.0) {
      let recomputed = lambert_eval(R.albedo.xyz, n, wo, wi) * abs(dot(n, wi)) / pdf;
      rel = max(rel, max(max(abs(w.x - recomputed.x) / w.x, abs(w.y - recomputed.y) / w.y), abs(w.z - recomputed.z) / w.z));
    } else {
      zero_pdf += 1.0;
    }
    sw = sw + w;
    qw = qw + w * w;
  }
  let o = k * 12u;
  out[o] = sw.x;
  out[o + 1u] = sw.y;
  out[o + 2u] = sw.z;
  out[o + 3u] = rel;
  out[o + 4u] = qw.x;
  out[o + 5u] = qw.y;
  out[o + 6u] = qw.z;
  out[o + 7u] = outside;
  out[o + 8u] = len_err;
  out[o + 9u] = zero_pdf;
  out[o + 10u] = 0.0;
  out[o + 11u] = 0.0;
}

fn sphere_dir(u1: f32, u2: f32) -> vec3<f32> {
  let z = 2.0 * u1 - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = 2.0 * PI * u2 - PI;
  return vec3<f32>(r * cos(phi), r * sin(phi), z);
}

// Reciprocity and support on random (n, wo, wi) triples. out[4k..4k+3] =
//   max_c |f(wo,wi) - f(wi,wo)|, min_c f, pdf(wo -> wi), 1 if f > 0 but pdf <= 0
@compute @workgroup_size(64)
fn recip_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y) {
    return;
  }
  let u = uni(TEST_RECIP, k, 0u);
  let v = uni(TEST_RECIP, k, 1u);
  let n = sphere_dir(u.x, u.y);
  let wo = sphere_dir(u.z, u.w);
  let wi = sphere_dir(v.x, v.y);
  let f1 = lambert_eval(R.albedo.xyz, n, wo, wi);
  let f2 = lambert_eval(R.albedo.xyz, n, wi, wo);
  let diff = abs(f1 - f2);
  let pdf = lambert_pdf(n, wo, wi);
  let o = k * 4u;
  out[o] = max(max(diff.x, diff.y), diff.z);
  out[o + 1u] = min(min(f1.x, f1.y), f1.z);
  out[o + 2u] = pdf;
  out[o + 3u] = select(0.0, 1.0, max(max(f1.x, f1.y), f1.z) > 0.0 && !(pdf > 0.0));
}

// Histogram of lambert_sample around +z over (cos theta, phi) bins for the chi-square test.
// Integer atomics are order-independent, so the counts are deterministic (design N4).
@group(0) @binding(4) var<storage, read_write> hist: array<atomic<u32>>;

@compute @workgroup_size(64)
fn hist_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y) {
    return;
  }
  let u = uni(TEST_HIST, k, 0u);
  let wi = lambert_sample(vec3<f32>(0.0, 0.0, 1.0), u.x, u.y);
  let mu = clamp(wi.z, 0.0, 1.0);
  let phi = atan2(wi.y, wi.x);
  let bm = min(HIST_MU - 1u, u32(mu * f32(HIST_MU)));
  let bp = min(HIST_PHI - 1u, u32((phi + PI) / (2.0 * PI) * f32(HIST_PHI)));
  atomicAdd(&hist[bm * HIST_PHI + bp], 1u);
}

// --- P1 material (G24) ---------------------------------------------------------------------------
// The same entry points as above, evaluated through bsdf_p1.wgsl for the material in R.

const TEST_P1_ALBEDO: u32 = 11u;
const TEST_P1_SAMPLE: u32 = 12u;
const TEST_P1_RECIP: u32 = 13u;
const TEST_P1_HIST: u32 = 14u;

fn probe_mat() -> Mat {
  return Mat(R.albedo.xyz, R.albedo.w, R.spec.x, R.spec.y, R.spec.z, R.flags.x);
}

// out[8k..] = sum f*cos/p_u (rgb), sum pdf/p_u, sums of squares; uniform hemisphere estimator.
@compute @workgroup_size(64)
fn p1_albedo_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y * R.info.z) {
    return;
  }
  let d = k / R.info.z;
  let block = k % R.info.z;
  let m = probe_mat();
  let wo = dirs[d].xyz;
  var sf = vec3<f32>(0.0);
  var qf = vec3<f32>(0.0);
  var sp = 0.0;
  var qp = 0.0;
  for (var j = 0u; j < R.info.w; j++) {
    let u = uni(TEST_P1_ALBEDO, d, block * R.info.w + j);
    let wi = uniform_hemisphere(u.x, u.y);
    let fc = bsdf_eval_local(m, wo, wi) * wi.z * (2.0 * PI);
    let pr = bsdf_pdf_local(m, wo, wi) * (2.0 * PI);
    sf = sf + fc;
    qf = qf + fc * fc;
    sp = sp + pr;
    qp = qp + pr * pr;
  }
  let o = k * 8u;
  out[o] = sf.x;
  out[o + 1u] = sf.y;
  out[o + 2u] = sf.z;
  out[o + 3u] = sp;
  out[o + 4u] = qf.x;
  out[o + 5u] = qf.y;
  out[o + 6u] = qf.z;
  out[o + 7u] = qp;
}

// Sampler consistency (normal +z). out[12k..] = sum w (rgb), max relative |w - f cos / pdf|,
// sum w^2 (rgb), invalid samples, max ||wi| - 1|, samples with pdf <= 0, specular choices, unused.
@compute @workgroup_size(64)
fn p1_sample_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y * R.info.z) {
    return;
  }
  let d = k / R.info.z;
  let block = k % R.info.z;
  let m = probe_mat();
  let n = vec3<f32>(0.0, 0.0, 1.0);
  let wo = dirs[d].xyz;
  var sw = vec3<f32>(0.0);
  var qw = vec3<f32>(0.0);
  var rel = 0.0;
  var invalid = 0.0;
  var len_err = 0.0;
  var zero_pdf = 0.0;
  var spec = 0.0;
  for (var j = 0u; j < R.info.w; j++) {
    let u = uni(TEST_P1_SAMPLE, d, block * R.info.w + j);
    let bs = bsdf_sample(m, n, wo, u.xyz);
    if (!any(bs.weight > vec3<f32>(0.0))) {
      invalid += 1.0;
      continue;
    }
    spec += select(0.0, 1.0, bs.specular);
    len_err = max(len_err, abs(length(bs.wi) - 1.0));
    if (!bs.delta) {
      let pdf = bsdf_pdf_local(m, wo, bs.wi);
      if (pdf > 0.0) {
        let recomputed = bsdf_eval_local(m, wo, bs.wi) * bs.wi.z / pdf;
        let diff = abs(bs.weight - recomputed) / max(recomputed, vec3<f32>(1e-30));
        rel = max(rel, max(max(diff.x, diff.y), diff.z));
      } else {
        zero_pdf += 1.0;
      }
    }
    sw = sw + bs.weight;
    qw = qw + bs.weight * bs.weight;
  }
  let o = k * 12u;
  out[o] = sw.x;
  out[o + 1u] = sw.y;
  out[o + 2u] = sw.z;
  out[o + 3u] = rel;
  out[o + 4u] = qw.x;
  out[o + 5u] = qw.y;
  out[o + 6u] = qw.z;
  out[o + 7u] = invalid;
  out[o + 8u] = len_err;
  out[o + 9u] = zero_pdf;
  out[o + 10u] = spec;
  out[o + 11u] = 0.0;
}

// Reciprocity on random (n, wo, wi). out[4k..] = max_c relative |f(wo,wi) - f(wi,wo)|, min_c f,
// pdf(wo -> wi), 1 if f > 0 but pdf <= 0 (support).
@compute @workgroup_size(64)
fn p1_recip_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y) {
    return;
  }
  let m = probe_mat();
  let u = uni(TEST_P1_RECIP, k, 0u);
  let v = uni(TEST_P1_RECIP, k, 1u);
  let n = sphere_dir(u.x, u.y);
  let wo = sphere_dir(u.z, u.w);
  let wi = sphere_dir(v.x, v.y);
  let ns = select(-n, n, dot(n, wo) > 0.0);
  var f1 = vec3<f32>(0.0);
  var f2 = vec3<f32>(0.0);
  var pdf = 0.0;
  if (dot(ns, wi) > 0.0) {
    f1 = bsdf_eval(m, ns, wo, wi);
    f2 = bsdf_eval(m, ns, wi, wo);
    pdf = bsdf_pdf(m, ns, wo, wi);
  }
  let diff = abs(f1 - f2) / max(max(f1, f2), vec3<f32>(1e-30));
  let o = k * 4u;
  out[o] = max(max(diff.x, diff.y), diff.z);
  out[o + 1u] = min(min(f1.x, f1.y), f1.z);
  out[o + 2u] = pdf;
  out[o + 3u] = select(0.0, 1.0, max(max(f1.x, f1.y), f1.z) > 0.0 && !(pdf > 0.0));
}

// Histogram of bsdf_sample around +z for wo = dirs[0], over (cos theta, phi) bins.
@compute @workgroup_size(64)
fn p1_hist_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= R.info.y) {
    return;
  }
  let m = probe_mat();
  let u = uni(TEST_P1_HIST, k, 0u);
  let bs = bsdf_sample(m, vec3<f32>(0.0, 0.0, 1.0), dirs[0].xyz, u.xyz);
  if (!any(bs.weight > vec3<f32>(0.0)) || bs.delta) {
    return;
  }
  let mu = clamp(bs.wi.z, 0.0, 1.0);
  let phi = atan2(bs.wi.y, bs.wi.x);
  let bm = min(HIST_MU - 1u, u32(mu * f32(HIST_MU)));
  let bp = min(HIST_PHI - 1u, u32((phi + PI) / (2.0 * PI) * f32(HIST_PHI)));
  atomicAdd(&hist[bm * HIST_PHI + bp], 1u);
}
