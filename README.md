# meme

AI-native deterministic rendering/physics runtime. Input: a declarative scene (`schema/scene.schema.json`) and RFC 6902 patches. Output: images (linear PFM + sRGB PNG), physics state trajectories and a metrics manifest. TypeScript + WGSL on WebGPU (dawn.node).

- Design: [docs/P0-01-design.md](docs/P0-01-design.md), [docs/P1-01-design.md](docs/P1-01-design.md), [docs/P2-01-design.md](docs/P2-01-design.md)
- Delivery reports: [docs/P0-02-implementation.md](docs/P0-02-implementation.md), [docs/P1-02-implementation.md](docs/P1-02-implementation.md), [docs/P2-02-implementation.md](docs/P2-02-implementation.md)
- Golden corpus: [golden/p0/MANIFEST.md](golden/p0/MANIFEST.md) (schema v1), [golden/p1/MANIFEST.md](golden/p1/MANIFEST.md) (schema v2), [golden/p2/MANIFEST.md](golden/p2/MANIFEST.md) (schema v3)
- Candidate contests (mechanism ①): `candidates/p1/<set>/REPORT.md`, `candidates/p2/<set>/REPORT.md`

## Scene format (schema v3)

The current schema is `v: 3` ([schema/scene.schema.json](schema/scene.schema.json)); v1 and v2 scenes ([frozen copies](schema/)) are migrated on load and the manifest records the chain. Rendering, as of v2 (relative to v1):

- materials: `metallic` [0, 1] (default 0), `roughness` [0, 1] (default 1, alpha = roughness^2, below alpha 1e-3 an exact mirror), `ior` [1, 3] (default 1: no specular layer, exactly Lambert);
- `lights`: id -> `{ "type": "point", "position_m", "intensity_cd", "color" }`; emissive spheres are sampled as area lights automatically;
- `render.integrator: "pt_p1"` with `render.strategy`: `"bsdf"`, `"nee"` or `"mis"` (default).

Physics, as of v3 (relative to v2):

- `physics.integrator: "xpbd_p2"` with `substeps` (1-256, one solver iteration each) and `contacts`: `"none"` or `"all_pairs"`;
- bodies are solid spheres with `angular_velocity_rad_s` and `orientation`; planes are solid half-spaces for physics;
- `physics_materials`: id -> `{ restitution, static_friction, dynamic_friction }`, referenced by `objects.*.physics_material`;
- `joints`: id -> `distance` (with `rest_length_m`, `compliance_m_N`), `ball`, `hinge` (with `axis_a`, `axis_b`) or `fixed`, between two bodies or a body and `"world"`;
- outputs gain `state/step_k.rot.bin` and `q` / `omega_rad_s` in the JSON state when bodies rotate; validators `energy.physics`, `tunnel.physics` and `precision.physics` (exit code 7).

Rolling a scene back to an earlier version (`rollbackTo` in [src/core/migrate.ts](src/core/migrate.ts)) is refused with `E_ROLLBACK_LOSSY` and the offending paths when it uses anything that version cannot express.

## Setup

Node 24.22.0 (`.nvmrc`), then `npm ci`. Byte-comparable goldens need the reference substrate (linux/arm64 + Mesa lavapipe), run through Docker:

```bash
ci/run-in-ref.sh npm run ci
```

The perf gate compares wall time with the parent commit on the same machine. CI checks the parent out as a worktree; to do the same locally:

```bash
git worktree add --detach out/perf-base HEAD~1
```

## Commands

```bash
node src/cli.ts run golden/p0/g08_furnace_convex/scene.json --out out/g08
```

```bash
node src/cli.ts determinism-check golden/p0/g01_det_double_run/scene.json
```

```bash
ci/run-in-ref.sh node src/cli.ts golden verify --require-hashes
```

```bash
ci/run-in-ref.sh node tools/mutate.ts
```

```bash
node src/cli.ts reduce --all-failing
```

```bash
ci/run-in-ref.sh node tools/contest.ts
```

```bash
ci/run-in-ref.sh node tools/contest_p2.ts
```

Re-recording goldens (`golden rebase`) is only meaningful inside the reference container and refuses while any oracle fails. Changing a tolerance needs an ADR under `docs/adr/` naming the golden (`node tools/thresholds.ts --check`).
