// P1 material (prefixed with rng.wgsl and bsdf_lambert.wgsl; mirrored in f64 by src/oracle/ref_bsdf.ts).
//   f = metallic * f_conductor + (1 - metallic) * (f_coat + f_base)
//   f_conductor, f_coat: GGX D (Walter et al. 2007) * height-correlated Smith G2 (Heitz 2014)
//                        * Fresnel / (4 mu_o mu_i); Schlick with F0 = base_color for the conductor,
//                        exact dielectric Fresnel at ior for the coat (design P1D6)
//   f_base: Lambert under the coat, coupled so energy and reciprocity hold (P1D2, COUPLING)
//   alpha = roughness^2 (P1D4); alpha < ALPHA_MIN is a delta lobe (P1D5).
// Everything is evaluated in the shading frame whose normal ns faces wo, so the material is
// two-sided like the P0 Lambert. Divisions and square roots are guarded (design N9).

override COUPLING: u32 = 0u;    // 0 Kelemen & Szirmay-Kalos 2001, 1 Ashikhmin & Shirley 2000, 2 naive F-weighting (not reciprocal; negative control)
// GGX_SAMPLER: 0 visible normals (Heitz 2018), 1 spherical caps (Dupuy & Benyoub 2023), 2 D(m)cos.
// Spherical caps is the runtime's choice (contest candidates/p1/c_ggx_sampler, decision F2 in
// docs/P1-02): the same distribution as Heitz 2018 in fewer operations.
override GGX_SAMPLER: u32 = 1u;

const KIND_LAMBERT: u32 = 0u;
const KIND_MICROFACET: u32 = 1u;
const KIND_DELTA: u32 = 2u;
const ALPHA_MIN: f32 = 1e-3;
const COS_EPS: f32 = 0x1p-20f;
const KEL_NM: u32 = 32u;
const KEL_NA: u32 = 32u;
const KEL_NI: u32 = 16u;

// Kelemen coupling table (src/runtime/kelemen_es.f32, built by tools/gen_tables.ts).
@group(0) @binding(15) var<storage, read> kelemen: array<f32>;

struct Mat {
  albedo: vec3<f32>,
  metallic: f32,
  alpha: f32,
  ior: f32,
  ebar_delta: f32, // 2 int F_diel(mu) mu dmu, precomputed for delta materials
  kind: u32,
}

struct BsdfSample {
  wi: vec3<f32>,
  weight: vec3<f32>, // f * |cos| / pdf (delta lobes: the lobe's reflectance / selection probability)
  pdf: f32,          // solid-angle pdf of the non-delta part; 0 for a delta choice
  delta: bool,
  specular: bool,
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn pow5(x: f32) -> f32 {
  let x2 = x * x;
  return x2 * x2 * x;
}

fn fr_dielectric(cos_in: f32, eta: f32) -> f32 {
  if (eta == 1.0) {
    return 0.0;
  }
  let c = clamp(cos_in, 0.0, 1.0);
  let sin2_t = (1.0 - c * c) / (eta * eta);
  if (sin2_t >= 1.0) {
    return 1.0;
  }
  let cos_t = sqrt(1.0 - sin2_t);
  let r_parl = (eta * c - cos_t) / (eta * c + cos_t);
  let r_perp = (c - eta * cos_t) / (c + eta * cos_t);
  return 0.5 * (r_parl * r_parl + r_perp * r_perp);
}

fn fr_schlick(f0: vec3<f32>, cos_in: f32) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow5(1.0 - clamp(cos_in, 0.0, 1.0));
}

// Reflectance of the specular part for a microfacet (or the macro normal) at cos(wo, h).
fn fresnel_mix(m: Mat, cos_oh: f32) -> vec3<f32> {
  return m.metallic * fr_schlick(m.albedo, cos_oh) + (1.0 - m.metallic) * vec3<f32>(fr_dielectric(cos_oh, m.ior));
}

// D(h) = alpha^2 / (pi t^2), t = sin^2 + alpha^2 cos^2 (Walter et al. 2007 eq. 33). The textbook
// t = cos^2 (alpha^2 - 1) + 1 cancels near the normal: its rounding error is ~u / t, ~u / alpha^2.
// Taking sin^2 from the tangent components of the unit h keeps t to a few ulp at any roughness.
fn ggx_d(h: vec3<f32>, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let t = (h.x * h.x + h.y * h.y) + h.z * h.z * a2;
  return a2 / (PI * t * t);
}

fn ggx_lambda(mu: f32, alpha: f32) -> f32 {
  let mu2 = mu * mu;
  let tan2 = max(0.0, 1.0 - mu2) / mu2;
  return 0.5 * (sqrt(1.0 + alpha * alpha * tan2) - 1.0);
}

// --- Kelemen table lookups (linear in mu, alpha and ior) -----------------------------------------

fn kel_index(x: f32, lo: f32, hi: f32, n: u32) -> vec2<f32> {
  let t = clamp((x - lo) / (hi - lo), 0.0, 1.0) * f32(n - 1u);
  let i = min(floor(t), f32(n - 2u));
  return vec2<f32>(i, t - i);
}

fn kel_e(mu: f32, alpha: f32, ior: f32) -> f32 {
  let im = kel_index(mu, 0.0, 1.0, KEL_NM);
  let ia = kel_index(alpha, ALPHA_MIN, 1.0, KEL_NA);
  let ii = kel_index(ior, 1.0, 3.0, KEL_NI);
  var acc = 0.0;
  for (var di = 0u; di < 2u; di++) {
    for (var da = 0u; da < 2u; da++) {
      let wi = select(1.0 - ii.y, ii.y, di == 1u);
      let wa = select(1.0 - ia.y, ia.y, da == 1u);
      let base = ((u32(ii.x) + di) * KEL_NA + u32(ia.x) + da) * KEL_NM + u32(im.x);
      acc += wi * wa * mix(kelemen[base], kelemen[base + 1u], im.y);
    }
  }
  return acc;
}

fn kel_ebar(alpha: f32, ior: f32) -> f32 {
  let ia = kel_index(alpha, ALPHA_MIN, 1.0, KEL_NA);
  let ii = kel_index(ior, 1.0, 3.0, KEL_NI);
  let off = KEL_NM * KEL_NA * KEL_NI;
  let i0 = off + u32(ii.x) * KEL_NA + u32(ia.x);
  let i1 = i0 + KEL_NA;
  return mix(mix(kelemen[i0], kelemen[i0 + 1u], ia.y), mix(kelemen[i1], kelemen[i1 + 1u], ia.y), ii.y);
}

// Factor multiplying (1 - metallic) * albedo / pi in the coupled base lobe.
fn coupling(m: Mat, mu_o: f32, mu_i: f32) -> f32 {
  if (COUPLING == 0u) {
    var eo: f32;
    var ei: f32;
    var ebar: f32;
    if (m.kind == KIND_DELTA) {
      // A smooth coat reflects exactly F_diel(mu); its average is precomputed on the CPU.
      eo = fr_dielectric(mu_o, m.ior);
      ei = fr_dielectric(mu_i, m.ior);
      ebar = m.ebar_delta;
    } else {
      eo = kel_e(mu_o, m.alpha, m.ior);
      ei = kel_e(mu_i, m.alpha, m.ior);
      ebar = kel_ebar(m.alpha, m.ior);
    }
    return (1.0 - eo) * (1.0 - ei) / max(1.0 - ebar, 1e-6);
  }
  if (COUPLING == 1u) {
    let r0 = (m.ior - 1.0) * (m.ior - 1.0) / ((m.ior + 1.0) * (m.ior + 1.0));
    return (28.0 / 23.0) * (1.0 - r0) * (1.0 - pow5(1.0 - 0.5 * mu_i)) * (1.0 - pow5(1.0 - 0.5 * mu_o));
  }
  return 1.0 - fr_dielectric(mu_o, m.ior);
}

// Probability of sampling the specular part, from approximate lobe albedos at the macro normal.
fn spec_probability(m: Mat, mu_o: f32) -> f32 {
  let fs = luminance(fresnel_mix(m, mu_o));
  let fd = (1.0 - m.metallic) * luminance(m.albedo) * (1.0 - fr_dielectric(mu_o, m.ior));
  if (fd <= 0.0) {
    return 1.0;
  }
  if (fs <= 0.0) {
    return 0.0;
  }
  return clamp(fs / (fs + fd), 0.05, 0.95);
}

// Orthonormal basis around ns (Duff et al. 2017), returned as columns t, b.
fn frame_t(n: vec3<f32>) -> vec3<f32> {
  let sgn = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sgn + n.z);
  return vec3<f32>(1.0 + sgn * n.x * n.x * a, sgn * n.x * n.y * a, -sgn * n.x);
}

fn frame_b(n: vec3<f32>) -> vec3<f32> {
  let sgn = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sgn + n.z);
  return vec3<f32>(n.x * n.y * a, sgn + n.y * n.y * a, -n.y);
}

fn to_local(v: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(v, frame_t(n)), dot(v, frame_b(n)), dot(v, n));
}

fn to_world(v: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  return v.x * frame_t(n) + v.y * frame_b(n) + v.z * n;
}

// Microfacet normal for local wo (z up). u in [0, 1)^2.
fn sample_h(wo: vec3<f32>, alpha: f32, u1: f32, u2: f32) -> vec3<f32> {
  if (GGX_SAMPLER == 1u) {
    let wi_std = normalize(vec3<f32>(alpha * wo.x, alpha * wo.y, wo.z));
    let phi = 2.0 * PI * u1 - PI;
    let z = (1.0 - u2) * (1.0 + wi_std.z) - wi_std.z;
    let st = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
    let h_std = vec3<f32>(st * cos(phi), st * sin(phi), z) + wi_std;
    return normalize(vec3<f32>(alpha * h_std.x, alpha * h_std.y, h_std.z));
  }
  if (GGX_SAMPLER == 2u) {
    let tan2 = alpha * alpha * u1 / max(1.0 - u1, 1e-7);
    let cos_t = 1.0 / sqrt(1.0 + tan2);
    let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
    let phi = 2.0 * PI * u2 - PI;
    return vec3<f32>(sin_t * cos(phi), sin_t * sin(phi), cos_t);
  }
  let vh = normalize(vec3<f32>(alpha * wo.x, alpha * wo.y, wo.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  let t1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-vh.y, vh.x, 0.0) * inverseSqrt(max(lensq, 1e-30)), lensq > 0.0);
  let t2 = cross(vh, t1);
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2 - PI;
  let p1 = r * cos(phi);
  let s = 0.5 * (1.0 + vh.z);
  let p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * r * sin(phi);
  let nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3<f32>(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}

// Solid-angle pdf of wi produced by sample_h + reflection (local frame, both above the surface).
fn spec_pdf(wo: vec3<f32>, wi: vec3<f32>, alpha: f32) -> f32 {
  let h = normalize(wo + wi);
  let coh = dot(wo, h);
  if (coh <= 0.0) {
    return 0.0;
  }
  let d = ggx_d(h, alpha);
  if (GGX_SAMPLER == 2u) {
    return d * h.z / (4.0 * coh);
  }
  // Visible normals: D_wo(h) = G1(wo) max(0, wo.h) D(h) / wo.z, times the reflection Jacobian 1 / (4 wo.h).
  return d / ((1.0 + ggx_lambda(wo.z, alpha)) * 4.0 * wo.z);
}

// Non-delta part of f, local frame (wo.z > 0 by construction of the shading frame).
fn bsdf_eval_local(m: Mat, wo: vec3<f32>, wi: vec3<f32>) -> vec3<f32> {
  if (wo.z <= COS_EPS || wi.z <= COS_EPS) {
    return vec3<f32>(0.0);
  }
  if (m.kind == KIND_LAMBERT) {
    return m.albedo * INV_PI;
  }
  var f = (1.0 - m.metallic) * m.albedo * INV_PI * coupling(m, wo.z, wi.z);
  if (m.kind == KIND_MICROFACET) {
    let h = normalize(wo + wi);
    let g2 = 1.0 / (1.0 + ggx_lambda(wo.z, m.alpha) + ggx_lambda(wi.z, m.alpha));
    f += ggx_d(h, m.alpha) * g2 * fresnel_mix(m, dot(wo, h)) / (4.0 * wo.z * wi.z);
  }
  return f;
}

fn bsdf_pdf_local(m: Mat, wo: vec3<f32>, wi: vec3<f32>) -> f32 {
  if (wo.z <= COS_EPS || wi.z <= COS_EPS) {
    return 0.0;
  }
  if (m.kind == KIND_LAMBERT) {
    return wi.z * INV_PI;
  }
  let ps = spec_probability(m, wo.z);
  var pdf = (1.0 - ps) * wi.z * INV_PI;
  if (m.kind == KIND_MICROFACET) {
    pdf += ps * spec_pdf(wo, wi, m.alpha);
  }
  return pdf;
}

// World-space wrappers; ns faces wo.
fn bsdf_eval(m: Mat, ns: vec3<f32>, wo: vec3<f32>, wi: vec3<f32>) -> vec3<f32> {
  return bsdf_eval_local(m, to_local(wo, ns), to_local(wi, ns));
}

fn bsdf_pdf(m: Mat, ns: vec3<f32>, wo: vec3<f32>, wi: vec3<f32>) -> f32 {
  return bsdf_pdf_local(m, to_local(wo, ns), to_local(wi, ns));
}

// u.x picks the lobe, (u.y, u.z) the direction.
fn bsdf_sample(m: Mat, ns: vec3<f32>, wo_w: vec3<f32>, u: vec3<f32>) -> BsdfSample {
  let wo = to_local(wo_w, ns);
  let none = BsdfSample(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0), 0.0, false, false);
  if (wo.z <= COS_EPS) {
    return none;
  }
  let ps = spec_probability(m, wo.z);
  if (u.x < ps) {
    if (m.kind == KIND_DELTA) {
      let wi = vec3<f32>(-wo.x, -wo.y, wo.z);
      return BsdfSample(to_world(wi, ns), fresnel_mix(m, wo.z) / ps, 0.0, true, true);
    }
    let h = sample_h(wo, m.alpha, u.y, u.z);
    let wi = 2.0 * dot(wo, h) * h - wo;
    if (wi.z <= COS_EPS) {
      return none;
    }
    let pdf = bsdf_pdf_local(m, wo, wi);
    return BsdfSample(to_world(wi, ns), bsdf_eval_local(m, wo, wi) * wi.z / pdf, pdf, false, true);
  }
  // Base lobe: cosine-weighted.
  let r = sqrt(u.y);
  let phi = 2.0 * PI * u.z - PI;
  let wi = vec3<f32>(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u.y)));
  if (wi.z <= COS_EPS) {
    return none;
  }
  let pdf = bsdf_pdf_local(m, wo, wi);
  return BsdfSample(to_world(wi, ns), bsdf_eval_local(m, wo, wi) * wi.z / pdf, pdf, false, false);
}
