# Restitution threshold (P2D3)

Override `RESTITUTION_THRESHOLD`, runtime default e = 0 below 2|g|h. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest_p2.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 runs with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| e = 0 below 2|g|h | 0.0010 (0.00e+0) | 0.00e+0 (± 0.00e+0) | 701.6 (± 22.0) | 0.000 | 0 | yes | Müller et al. 2020 §3.6 |
| no threshold | 0.0010 (0.00e+0) | 0.0016 (± 0.00e+0) | 673.8 (± 24.9) | 0.000 | 0 | no | restitution at every approach speed |

Measures:
- Error: largest |H - H_pred| / H_pred over G38's four bounces at e = 0.7 (H_pred: the scheme's discrete apex)
- Variance: mean speed over the last second of a ball dropped with e = 0.5 (rest jitter; 0 at rest)
- ms: run of G38 (e = 0.7)
- Robustness: share of 12 random drops (e 0.1-0.85, height 0.2-2 m) not at rest (|v| > 4 g h) 1 s after the Zeno time t0 (1 + 2e / (1 - e)) of the bounce sequence, or failing a validator

Notes:
- e = 0 below 2|g|h: bounce error 1.04e-3; rest jitter 0.00e+0 m/s
- no threshold: bounce error 1.04e-3; rest jitter 1.63e-3 m/s

Dropped (not on the Pareto front):
- no threshold: dominated by e = 0 below 2|g|h (better on variance, no worse elsewhere)

