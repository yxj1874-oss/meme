# MIS weighting heuristic (P1D7)

Override `MIS_HEURISTIC`, runtime default balance. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 renders with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| power (beta = 2) | 1.3124 (5.0000) | 3.74e+4 (± 207.1818) | 112.7 (± 34.0) | 0.000 | 4 | no | Veach 1997 §9.2.4 |
| balance | 1.0282 (5.0000) | 3.67e+4 (± 202.9361) | 117.3 (± 29.5) | 0.000 | 3 | yes | Veach 1997 §9.2.2, Theorem 9.2 |

Measures:
- Error: |z| of G26 against the view-factor closed form; floor 5
- Variance: summed per-pixel variance on G26 + G27 floors
- ms: render of G26 + G27 (mis)
- Robustness: share of 12 random sphere-light scenes (a third touching the floor) failing validators or |z| <= 5

Notes:
- power (beta = 2): G26 z = 1.31; G26 variance 7.699e-1, G27 variance 3.744e+4
- balance: G26 z = 1.03; G26 variance 4.496e+0, G27 variance 3.667e+4

Dropped (not on the Pareto front):
- power (beta = 2): dominated by balance (better on variance, loc, no worse elsewhere)

