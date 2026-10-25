# GGX microfacet sampling (P1D8)

Override `GGX_SAMPLER`, runtime default spherical caps. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 renders with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| VNDF (Heitz 2018) | 2.4058 (5.0000) | 0.0204 (± 1.15e-4) | 30.5 (± 25.9) | 0.000 | 19 | no | Heitz, Sampling the GGX Distribution of Visible Normals, JCGT 7(4), 2018 |
| spherical caps | 2.8661 (5.0000) | 0.0204 (± 1.15e-4) | 30.1 (± 13.9) | 0.000 | 16 | yes | Dupuy & Benyoub, Sampling Visible GGX Normals with Spherical Caps, CGF 2023 |
| D(m) cos | 2.5504 (5.0000) | 0.2072 (± 0.0012) | 28.0 (± 20.3) | 0.000 | 10 | yes | Walter et al. 2007, full NDF sampling |

Measures:
- Error: largest z = |E[w] - E_ref| / max(se_robust, 4e-5) of the sampler's albedo against the f64 reference, 64 directions x 3 channels x 3 metals (the G24 A1 rule); floor 5
- Variance: mean per-sample variance of the sampler weight (metals, roughness 0.1 / 0.3 / 0.7)
- ms: render of G23 r03 (GGX metal furnace)
- Robustness: share of 12 random materials failing energy <= 1 + 5 se, albedo z <= 5, reciprocity or support

Notes:
- VNDF (Heitz 2018): invalid (below-horizon) sample share at roughness 0.1 / 0.3 / 0.7: 0.0014 / 0.0167 / 0.1363; albedo checks failing the G24 rule: 0
- spherical caps: invalid (below-horizon) sample share at roughness 0.1 / 0.3 / 0.7: 0.0014 / 0.0167 / 0.1361; albedo checks failing the G24 rule: 0
- D(m) cos: invalid (below-horizon) sample share at roughness 0.1 / 0.3 / 0.7: 0.0061 / 0.0837 / 0.3295; albedo checks failing the G24 rule: 0

Dropped (not on the Pareto front):
- VNDF (Heitz 2018): dominated by spherical caps (better on loc, no worse elsewhere)

