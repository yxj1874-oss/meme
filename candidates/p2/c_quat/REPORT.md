# Orientation update (P2-01 §3.5)

Override `QUAT`, runtime default exponential map. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest_p2.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 runs with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| first order + normalize | 0.0027 (0.00e+0) | 7.36e-6 (± 0.00e+0) | 142.4 (± 22.0) | 0.000 | 4 | yes | Müller et al. 2020 Alg. 2: q + h/2 [w, 0] q, normalized |
| exponential map | 2.57e-8 (0.00e+0) | 7.36e-6 (± 0.00e+0) | 148.7 (± 11.2) | 0.000 | 6 | yes | exact rotation exp(h w / 2) q |

Measures:
- Error: relative error of the orientation angle of a free sphere spinning at |w| h = 0.4 for 1 s (exact: |w| t)
- Variance: relative error of G36's physical-pendulum period against 4 sqrt(I_p / m g d) K
- ms: run of G36
- Robustness: share of 12 random ball-joint pendulums (spin up to 0.1 / h in a random direction) failing a validator

Notes:
- first order + normalize: free-spin phase error 2.69e-3 (first order: (h w)^2 / 12 = 1.33e-2); G36 period error 7.36e-6
- exponential map: free-spin phase error 2.57e-8 (first order: (h w)^2 / 12 = 1.33e-2); G36 period error 7.36e-6

Dropped (not on the Pareto front):
- none

