# Friction model (P2D3)

Override `FRICTION`, runtime default positional static + velocity dynamic. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest_p2.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 runs with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| positional static + velocity dynamic | 0.0032 (0.00e+0) | 3.42e-8 (± 0.00e+0) | 111.2 (± 6.4) | 0.000 | 0 | yes | Müller et al., Detailed Rigid Body Simulation with XPBD, SCA 2020 §3.5-3.6 (dynamic bound as an impulse, P2-02) |
| velocity-level Coulomb | 0.0079 (0.00e+0) | 4.64e-8 (± 0.00e+0) | 113.1 (± 2.6) | 0.000 | 0 | no | stick inside the static cone, else slide with mu_d, both at velocity level |

Measures:
- Error: largest relative error of the downhill distance against s = a t (t + h) / 2 over G40's rolling and sliding runs
- Variance: contact-point slip speed at the end of G40's rolling run (0 when it rolls)
- ms: run of G40 (rolling)
- Robustness: share of 12 random inclines (5-40 deg, mu_s 0.05-1, mu_d = 0.7 mu_s; 1.5 deg around the critical angle excluded) whose roll/slide regime disagrees with tan(theta) <= 3.5 mu_s, or failing a validator

Notes:
- positional static + velocity dynamic: distance error 3.18e-3
- velocity-level Coulomb: distance error 7.91e-3

Dropped (not on the Pareto front):
- velocity-level Coulomb: dominated by positional static + velocity dynamic (better on error, variance, no worse elsewhere)

