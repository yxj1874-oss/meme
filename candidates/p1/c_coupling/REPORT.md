# Diffuse/specular coupling of the dielectric (P1D2)

Override `COUPLING`, runtime default Kelemen. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 renders with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| Kelemen | 1.49e-4 (6.34e-4) | 0.0213 (± 1.04e-4) | 20.5 (± 11.3) | 0.000 | 16 | yes | Kelemen & Szirmay-Kalos 2001, coupled with the tabulated coat albedo |
| Ashikhmin-Shirley | 0.2629 (9.25e-4) | 0.0163 (± 7.98e-5) | 19.1 (± 9.3) | 0.000 | 4 | yes | Ashikhmin & Shirley 2000, analytic Schlick-based coupling |
| naive F-weighting | 3.32e-4 (6.34e-4) | 0.0102 (± 4.97e-5) | 18.1 (± 16.9) | 1.000 | 1 | no | (1 - F(mu_o)) Lambert; negative control, not reciprocal |

Measures:
- Error: continuity at ior -> 1: |mean over 64 directions of the albedo at ior = 1.0001 - rho| (the ior = 1 material is exactly Lambert, albedo rho); floor 5 se of that mean
- Variance: mean per-sample variance of the sampler weight
- ms: render of a rough dielectric sphere (128x128, 64 spp)
- Robustness: share of 12 random dielectric materials failing energy <= 1 + 5 se, reciprocity <= 1e-4 or support

Notes:
- Kelemen: max reciprocity error 4.91e-6; albedo jump at ior 1.0001: 1.49e-4 / 1.12e-4 / 7.37e-5 (se 1.3e-4 / 9.5e-5 / 6.3e-5); max energy (E[w] - 5 se) 0.8441
- Ashikhmin-Shirley: max reciprocity error 1.16e-5; albedo jump at ior 1.0001: 2.63e-1 / 1.97e-1 / 1.31e-1 (se 1.9e-4 / 1.4e-4 / 9.3e-5); max energy (E[w] - 5 se) 0.7891
- naive F-weighting: max reciprocity error 9.87e-1; albedo jump at ior 1.0001: 3.32e-4 / 2.48e-4 / 1.65e-4 (se 1.3e-4 / 9.5e-5 / 6.3e-5); max energy (E[w] - 5 se) 0.8173

Dropped (not on the Pareto front):
- naive F-weighting: disqualified, breaks an invariant on 100.0% of perturbed inputs (max reciprocity error 9.87e-1; albedo jump at ior 1.0001: 3.32e-4 / 2.48e-4 / 1.65e-4 (se 1.3e-4 / 9.5e-5 / 6.3e-5); max energy (E[w] - 5 se) 0.8173)

