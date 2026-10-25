// f64 reference of the P1 BSDF building blocks, used to build the Kelemen coupling table
// (tools/gen_tables.ts) and by the P1 oracles (directional albedo E_ss, Fresnel replay, chi-square
// expectations). It mirrors src/kernels/bsdf_p1.wgsl formula by formula, in double precision.

export const ALPHA_MIN = 1e-3;

/** Exact unpolarized dielectric Fresnel reflectance, light arriving from air (PBRT-v4 ch. 9, FrDielectric). */
export function frDielectric(cosI: number, eta: number): number {
  const c = Math.min(Math.max(cosI, 0), 1);
  if (eta === 1) return 0;
  const sin2T = (1 - c * c) / (eta * eta);
  if (sin2T >= 1) return 1;
  const cosT = Math.sqrt(1 - sin2T);
  const rParl = (eta * c - cosT) / (eta * c + cosT);
  const rPerp = (c - eta * cosT) / (c + eta * cosT);
  return 0.5 * (rParl * rParl + rPerp * rPerp);
}

/** Schlick 1994. */
export function frSchlick(f0: number, cos: number): number {
  const m = 1 - Math.min(Math.max(cos, 0), 1);
  return f0 + (1 - f0) * m * m * m * m * m;
}

/** GGX normal distribution (Walter et al. 2007). */
export function ggxD(cosH: number, alpha: number): number {
  const a2 = alpha * alpha;
  const t = cosH * cosH * (a2 - 1) + 1;
  return a2 / (Math.PI * t * t);
}

/** Smith Lambda for GGX (Heitz 2014, JCGT 3(2), eq. 72). */
export function ggxLambda(mu: number, alpha: number): number {
  const mu2 = mu * mu;
  const tan2 = Math.max(0, 1 - mu2) / mu2;
  return 0.5 * (Math.sqrt(1 + alpha * alpha * tan2) - 1);
}

type V3 = [number, number, number];

/**
 * Visible-normal sample (Heitz 2018, JCGT 7(4), listing 1) for wo in the local frame (z = normal).
 * u1, u2 in [0, 1); phi uses [-pi, pi) like the WGSL code.
 */
export function sampleVndf(wo: V3, alpha: number, u1: number, u2: number): V3 {
  const vh = normalize([alpha * wo[0], alpha * wo[1], wo[2]]);
  const lensq = vh[0] * vh[0] + vh[1] * vh[1];
  const t1: V3 = lensq > 0 ? [-vh[1] / Math.sqrt(lensq), vh[0] / Math.sqrt(lensq), 0] : [1, 0, 0];
  const t2 = cross(vh, t1);
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2 - Math.PI;
  const p1 = r * Math.cos(phi);
  let p2 = r * Math.sin(phi);
  const s = 0.5 * (1 + vh[2]);
  p2 = (1 - s) * Math.sqrt(1 - p1 * p1) + s * p2;
  const pz = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
  const nh: V3 = [p1 * t1[0] + p2 * t2[0] + pz * vh[0], p1 * t1[1] + p2 * t2[1] + pz * vh[1], p1 * t1[2] + p2 * t2[2] + pz * vh[2]];
  return normalize([alpha * nh[0], alpha * nh[1], Math.max(0, nh[2])]);
}

export function reflect(wo: V3, h: V3): V3 {
  const d = 2 * (wo[0] * h[0] + wo[1] * h[1] + wo[2] * h[2]);
  return [d * h[0] - wo[0], d * h[1] - wo[1], d * h[2] - wo[2]];
}

export function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Gauss-Legendre nodes and weights on [0, 1] (Newton iteration on P_n; Numerical Recipes §4.6). */
export function gaussLegendre01(n: number): { x: number[]; w: number[] } {
  const x: number[] = new Array(n);
  const w: number[] = new Array(n);
  const m = Math.floor((n + 1) / 2);
  for (let i = 1; i <= m; i++) {
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let pp = 0;
    for (let iter = 0; iter < 100; iter++) {
      let p1 = 1;
      let p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      pp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x[i - 1] = 0.5 * (1 - z);
    x[n - i] = 0.5 * (1 + z);
    w[i - 1] = w[n - i] = 1 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}

const GL = gaussLegendre01(48);

/**
 * Adaptive Simpson (Lyness 1969) over [a, b] split into `panels` pieces first: the forced split
 * keeps the coarse first estimate from missing narrow features, which plain adaptive Simpson does.
 */
export function integrate(f: (x: number) => number, a: number, b: number, eps: number, panels = 16, depth = 24): number {
  const rec = (lo: number, hi: number, flo: number, fhi: number, fmid: number, whole: number, tol: number, d: number): number => {
    const mid = (lo + hi) / 2;
    const fl = f((lo + mid) / 2);
    const fr = f((mid + hi) / 2);
    const left = ((mid - lo) / 6) * (flo + 4 * fl + fmid);
    const right = ((hi - mid) / 6) * (fmid + 4 * fr + fhi);
    if (d <= 0 || Math.abs(left + right - whole) <= 15 * tol) return left + right + (left + right - whole) / 15;
    return rec(lo, mid, flo, fmid, fl, left, tol / 2, d - 1) + rec(mid, hi, fmid, fhi, fr, right, tol / 2, d - 1);
  };
  let sum = 0;
  for (let i = 0; i < panels; i++) {
    const lo = a + ((b - a) * i) / panels;
    const hi = a + ((b - a) * (i + 1)) / panels;
    const flo = f(lo);
    const fhi = f(hi);
    const fmid = f((lo + hi) / 2);
    sum += rec(lo, hi, flo, fhi, fmid, ((hi - lo) / 6) * (flo + 4 * fmid + fhi), eps / panels, depth);
  }
  return sum;
}

/**
 * Directional albedo of the single-scattering GGX specular lobe for a view cosine mu, with Fresnel
 * fresnel(cos(wo, h)): E = int G2/G1(wo) F dVNDF over the VNDF's own (u1, u2) domain, where the
 * measure is uniform. The integrand has a kink where the reflected direction crosses the horizon,
 * so fixed-node quadrature converges slowly there (48-point Gauss-Legendre is off by 1.3e-3 at
 * alpha = 0.09); nested adaptive Simpson with u1 = v^2 (removing the sqrt at r = 0) agrees with a
 * brute-force hemisphere sum to 3e-7 on the checked points.
 */
export function specularAlbedo(mu: number, alpha: number, fresnel: (cosOH: number) => number, eps = 1e-7): number {
  const m = Math.max(mu, 1e-6);
  const wo: V3 = [Math.sqrt(Math.max(0, 1 - m * m)), 0, m];
  const lo = ggxLambda(m, alpha);
  const g1 = 1 / (1 + lo);
  const g = (v: number, u2: number) => {
    const h = sampleVndf(wo, alpha, v * v, u2);
    const wi = reflect(wo, h);
    if (wi[2] <= 0) return 0;
    const g2 = 1 / (1 + lo + ggxLambda(wi[2], alpha));
    const coh = wo[0] * h[0] + wo[1] * h[1] + wo[2] * h[2];
    return 2 * v * (g2 / g1) * fresnel(coh);
  };
  return integrate((v) => integrate((u2) => g(v, u2), 0, 1, eps), 0, 1, eps);
}

/** E_avg = 2 int_0^1 E(mu) mu dmu. */
export function averageAlbedo(e: (mu: number) => number): number {
  let s = 0;
  for (let i = 0; i < GL.x.length; i++) s += GL.w[i]! * e(GL.x[i]!) * GL.x[i]!;
  return 2 * s;
}

/** Grid of the Kelemen table shared with bsdf_p1.wgsl. */
export const KELEMEN = { NM: 32, NA: 32, NI: 16, IOR_MIN: 1, IOR_MAX: 3 } as const;

export function kelemenGrid(i: number, n: number, lo: number, hi: number): number {
  return lo + ((hi - lo) * i) / (n - 1);
}

export interface RefMaterial {
  albedo: [number, number, number];
  metallic: number;
  alpha: number;
  ior: number;
}

const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** bsdf_p1.wgsl spec_probability, in f64. */
export function specProbability(m: RefMaterial, muO: number): number {
  const fd0 = frDielectric(muO, m.ior);
  const fsRgb = m.albedo.map((a) => m.metallic * frSchlick(a, muO) + (1 - m.metallic) * fd0) as [number, number, number];
  const fs = lum(fsRgb);
  const fd = (1 - m.metallic) * lum(m.albedo) * (1 - fd0);
  if (fd <= 0) return 1;
  if (fs <= 0) return 0;
  return Math.min(Math.max(fs / (fs + fd), 0.05), 0.95);
}

/** bsdf_p1.wgsl bsdf_pdf_local (microfacet kind), for GGX_SAMPLER 0/1 (visible normals) or 2 (D cos). */
export function bsdfPdfLocal(m: RefMaterial, wo: V3, wi: V3, sampler = 0): number {
  if (wo[2] <= 2 ** -20 || wi[2] <= 2 ** -20) return 0;
  const ps = specProbability(m, wo[2]);
  let pdf = ((1 - ps) * wi[2]) / Math.PI;
  const h = normalize([wo[0] + wi[0], wo[1] + wi[1], wo[2] + wi[2]]);
  const coh = wo[0] * h[0] + wo[1] * h[1] + wo[2] * h[2];
  if (coh > 0) {
    const d = ggxD(h[2], m.alpha);
    pdf += ps * (sampler === 2 ? (d * h[2]) / (4 * coh) : d / ((1 + ggxLambda(wo[2], m.alpha)) * 4 * wo[2]));
  }
  return pdf;
}

/** bsdf_p1.wgsl kel_e: linear interpolation of the f32 Kelemen table in mu, alpha and ior. */
export function kelemenLookup(table: Float32Array, mu: number, alpha: number, ior: number): number {
  const { NM, NA, NI } = KELEMEN;
  const idx = (x: number, lo: number, hi: number, n: number): [number, number] => {
    const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1) * (n - 1);
    const i = Math.min(Math.floor(t), n - 2);
    return [i, t - i];
  };
  const [im, fm] = idx(mu, 0, 1, NM);
  const [ia, fa] = idx(alpha, ALPHA_MIN, 1, NA);
  const [ii, fi] = idx(ior, 1, 3, NI);
  let acc = 0;
  for (let di = 0; di < 2; di++) {
    for (let da = 0; da < 2; da++) {
      const w = (di ? fi : 1 - fi) * (da ? fa : 1 - fa);
      const base = ((ii + di) * NA + ia + da) * NM + im;
      acc += w * (table[base]! + (table[base + 1]! - table[base]!) * fm);
    }
  }
  return acc;
}

/**
 * Directional albedo of the whole P1 material (microfacet kind) for a view cosine mu: the GGX
 * specular part by VNDF-domain quadrature with the exact Fresnel mix, plus the coupled base. For
 * Kelemen coupling the base reflects exactly (1 - metallic) * albedo * (1 - E_s(mu)) with E_s taken
 * from the same table the GPU interpolates (tools/gen_tables.ts makes that identity exact).
 */
export function materialAlbedo(m: RefMaterial, mu: number, coupling: number, table: Float32Array): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const spec = specularAlbedo(mu, m.alpha, (coh) => m.metallic * frSchlick(m.albedo[c]!, coh) + (1 - m.metallic) * frDielectric(coh, m.ior));
    let base: number;
    if (coupling === 0) {
      base = 1 - kelemenLookup(table, mu, m.alpha, m.ior);
    } else if (coupling === 1) {
      const r0 = ((m.ior - 1) / (m.ior + 1)) ** 2;
      // (1 / pi) int C(mu, mu_i) mu_i dw_i = 2 int C mu_i dmu_i
      base = averageAlbedo((mi) => (28 / 23) * (1 - r0) * (1 - (1 - 0.5 * mi) ** 5) * (1 - (1 - 0.5 * mu) ** 5));
    } else {
      base = 1 - frDielectric(mu, m.ior);
    }
    out[c] = spec + (1 - m.metallic) * m.albedo[c]! * base;
  }
  return out;
}

/** Expected share of samples per (cos theta, phi) histogram bin for local wo, from bsdfPdfLocal (n x n Gauss-Legendre per bin). */
export function histogramExpectation(m: RefMaterial, wo: V3, binsMu: number, binsPhi: number, sampler = 0, n = 12): Float64Array {
  const gl = gaussLegendre01(n);
  const out = new Float64Array(binsMu * binsPhi);
  let total = 0;
  for (let bm = 0; bm < binsMu; bm++) {
    for (let bp = 0; bp < binsPhi; bp++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const mu = (bm + gl.x[i]!) / binsMu;
        const st = Math.sqrt(Math.max(0, 1 - mu * mu));
        for (let j = 0; j < n; j++) {
          const phi = -Math.PI + (2 * Math.PI * (bp + gl.x[j]!)) / binsPhi;
          s += gl.w[i]! * gl.w[j]! * bsdfPdfLocal(m, wo, [st * Math.cos(phi), st * Math.sin(phi), mu], sampler);
        }
      }
      const mass = (s * (2 * Math.PI)) / (binsMu * binsPhi);
      out[bm * binsPhi + bp] = mass;
      total += mass;
    }
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}
