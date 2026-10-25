# Sphere light sampling (P1D9)

Override `SPHERE_SAMPLER`, runtime default uniform cone. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 renders with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| uniform cone | 1.3124 (5.0000) | 3.73e+4 (± 206.5637) | 109.1 (± 34.8) | 0.000 | 16 | yes | PBRT-v4 ch. 6, sampling the cone subtended by a sphere |
| uniform area | 1.7879 (5.0000) | Infinity (± Infinity) | 114.4 (± 24.2) | 0.083 | 25 | no | uniform point on the whole sphere, back side rejected |

Measures:
- Error: |z| of G26 against the view-factor closed form; floor 5
- Variance: summed per-pixel variance on G26 + G27 floors
- ms: render of G26 + G27 (mis)
- Robustness: share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5

Notes:
- uniform cone: G26 z = 1.31; G26 variance 7.699e-1, G27 variance 3.733e+4
- uniform area: G26 z = 1.79; G26 variance 2.051e+2, G27 variance NaN; variance is not finite (non-finite pixels or estimates): scored as infinity

Dropped (not on the Pareto front):
- uniform area: disqualified, breaks an invariant on 8.3% of perturbed inputs (G26 z = 1.79; G26 variance 2.051e+2, G27 variance NaN; variance is not finite (non-finite pixels or estimates): scored as infinity)

