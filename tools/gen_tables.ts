// Builds src/runtime/kelemen_es.f32, the coupling table of the Kelemen & Szirmay-Kalos 2001 diffuse
// term (design P1D2): E_s(mu, alpha, ior), the directional albedo of the GGX dielectric coat, and
// Ebar_s(alpha, ior) = 2 int_0^1 E_s(mu) mu dmu. Ebar is integrated in closed form over the same
// piecewise-linear interpolant of E_s in mu that bsdf_p1.wgsl evaluates, so the coupled diffuse lobe
// conserves energy exactly for the table the GPU actually uses.
// Layout (little-endian f32): E_s[(ior_i * NA + alpha_i) * NM + mu_i], then Ebar[ior_i * NA + alpha_i].
// Usage: node tools/gen_tables.ts [--check]

import { readFileSync, writeFileSync } from "node:fs";

import { ALPHA_MIN, frDielectric, KELEMEN, kelemenGrid, specularAlbedo } from "../src/oracle/ref_bsdf.ts";

const OUT = new URL("../src/runtime/kelemen_es.f32", import.meta.url);
const { NM, NA, NI, IOR_MIN, IOR_MAX } = KELEMEN;

const table = new Float32Array(NM * NA * NI + NA * NI);
for (let ii = 0; ii < NI; ii++) {
  const ior = kelemenGrid(ii, NI, IOR_MIN, IOR_MAX);
  for (let ai = 0; ai < NA; ai++) {
    const alpha = kelemenGrid(ai, NA, ALPHA_MIN, 1);
    const e: number[] = [];
    for (let mi = 0; mi < NM; mi++) {
      const mu = kelemenGrid(mi, NM, 0, 1);
      e.push(ior === 1 ? 0 : specularAlbedo(mu, alpha, (c) => frDielectric(c, ior)));
    }
    // The GPU interpolates linearly in mu; integrate 2 * E(mu) * mu exactly over each segment.
    let ebar = 0;
    const h = 1 / (NM - 1);
    for (let mi = 0; mi + 1 < NM; mi++) {
      const m0 = mi * h;
      const e0 = Math.fround(e[mi]!);
      const e1 = Math.fround(e[mi + 1]!);
      // int_{m0}^{m0+h} (e0 + (e1 - e0)(m - m0)/h) m dm
      ebar += 2 * (e0 * (h * m0 + (h * h) / 2) + (e1 - e0) * ((h * m0) / 2 + (h * h) / 3));
    }
    for (let mi = 0; mi < NM; mi++) table[(ii * NA + ai) * NM + mi] = e[mi]!;
    table[NM * NA * NI + ii * NA + ai] = ebar;
  }
}

const bytes = new Uint8Array(table.buffer);
if (process.argv.includes("--check")) {
  const committed = new Uint8Array(readFileSync(OUT));
  const same = committed.length === bytes.length && committed.every((b, i) => b === bytes[i]);
  console.log(`gen_tables --check: ${same ? "up to date" : "OUT OF DATE"}`);
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, bytes);
console.log(`wrote ${table.length} floats to ${OUT.pathname}`);
