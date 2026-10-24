// Two-sided Lambert BSDF (PBRT-v4 §9.2 DiffuseBxDF, made two-sided). Shared by render_p0.wgsl and
// probe_bsdf.wgsl, so golden G12 tests exactly the code the integrator runs.
//   f = albedo / pi when wi and wo are on the same side of n, else 0
//   pdf(wi) = |cos(n, wi)| / pi on the side of wo
//   sample: cosine-weighted hemisphere around the side of wo; weight f*cos/pdf = albedo

const PI: f32 = 3.14159265358979323846;
const INV_PI: f32 = 0.318309886183790671538;

fn same_side(n: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> bool {
  return dot(n, a) * dot(n, b) > 0.0;
}

fn lambert_eval(albedo: vec3<f32>, n: vec3<f32>, wo: vec3<f32>, wi: vec3<f32>) -> vec3<f32> {
  if (!same_side(n, wo, wi)) {
    return vec3<f32>(0.0);
  }
  return albedo * INV_PI;
}

fn lambert_pdf(n: vec3<f32>, wo: vec3<f32>, wi: vec3<f32>) -> f32 {
  if (!same_side(n, wo, wi)) {
    return 0.0;
  }
  return abs(dot(n, wi)) * INV_PI;
}

// Cosine-weighted direction around unit ns (Malley's method) with the orthonormal basis of
// Duff et al., "Building an Orthonormal Basis, Revisited", JCGT 6(1), 2017, listing 3. phi is taken
// in [-pi, pi) because WGSL only bounds sin/cos error there (§15.7.4.1: absolute 2^-11 on [-pi, pi]).
fn lambert_sample(ns: vec3<f32>, u1: f32, u2: f32) -> vec3<f32> {
  let sgn = select(-1.0, 1.0, ns.z >= 0.0);
  let a = -1.0 / (sgn + ns.z);
  let bxy = ns.x * ns.y * a;
  let t = vec3<f32>(1.0 + sgn * ns.x * ns.x * a, sgn * bxy, -sgn * ns.x);
  let bt = vec3<f32>(bxy, sgn + ns.y * ns.y * a, -ns.y);
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2 - PI;
  let z = sqrt(max(0.0, 1.0 - u1));
  return normalize(r * cos(phi) * t + r * sin(phi) * bt + z * ns);
}

// f * cos / pdf for a direction from lambert_sample: (albedo / pi) * cos / (cos / pi).
fn lambert_weight(albedo: vec3<f32>) -> vec3<f32> {
  return albedo;
}
