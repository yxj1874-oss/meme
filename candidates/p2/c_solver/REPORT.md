# Parallel constraint solver (P2D2)

Override `SOLVER`, runtime default Jacobi + mass splitting. Measured on llvmpipe: Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7) 0.0.1 by `tools/contest_p2.ts`; numbers are reproducible (seeded inputs) except ms, the median of 5 runs with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.

| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |
|---|---|---|---|---|---|---|---|
| Jacobi + mass splitting | 6.79e-4 (0.00e+0) | 1.93e-8 (± 9.54e-4) | 773.6 (± 14.9) | 0.000 | 3 | yes | Tonge, Benevolenski, Voroshilov, Mass Splitting for Jitter-Free Parallel Rigid Body Simulation, SIGGRAPH 2012 |
| plain Jacobi | 3.40e-4 (0.00e+0) | 1.72e-8 (± 9.54e-4) | 598.6 (± 12.1) | 0.375 | 1 | no | corrections of all constraints summed |
| Jacobi averaged | 3.46e-4 (0.00e+0) | 0.0067 (± 9.54e-4) | 774.4 (± 13.0) | 0.000 | 1 | yes | Macklin et al., Unified Particle Physics for Real-Time Applications, SIGGRAPH 2014, §4.2 |

Measures:
- Error: largest penetration / r of G41's column with the heavy body on top (mass ratio 100)
- Variance: linear momentum change / (sum m|v|) at the end of G42 (64 colliding spheres); noise: the rounding bound 2u per substep
- ms: run of G42 (64 spheres, 4000 substeps)
- Robustness: share of 40 random scenes failing: 12 piles of 6 spheres (masses 1-100, friction, e <= 0.3) with a validator failing or penetration > 1e-3 r after 1 s, 12 zero-g clusters losing momentum beyond 2u per substep, and 16 chains of 5 spheres hung from the world with random joint types (distance, ball, hinge, fixed; every inner body carries two joints) with a validator failing within 2 s

Notes:
- Jacobi + mass splitting: G41 heavy-top penetration 6.79e-4 r; G42 momentum change 1.93e-8 of the scale
- plain Jacobi: G41 heavy-top penetration 3.40e-4 r; G42 momentum change 1.72e-8 of the scale
- Jacobi averaged: G41 heavy-top penetration 3.46e-4 r; G42 momentum change 6.75e-3 of the scale

Dropped (not on the Pareto front):
- plain Jacobi: disqualified, breaks an invariant on 37.5% of perturbed inputs (G41 heavy-top penetration 3.40e-4 r; G42 momentum change 1.72e-8 of the scale)

