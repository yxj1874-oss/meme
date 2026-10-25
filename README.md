# meme

AI-native deterministic rendering/physics runtime. Input: a declarative scene (`schema/scene.schema.json`) and RFC 6902 patches. Output: images (linear PFM + sRGB PNG), physics state trajectories and a metrics manifest. TypeScript + WGSL on WebGPU (dawn.node).

- Design: [docs/P0-01-design.md](docs/P0-01-design.md), [docs/P1-01-design.md](docs/P1-01-design.md)
- Delivery reports: [docs/P0-02-implementation.md](docs/P0-02-implementation.md), [docs/P1-02-implementation.md](docs/P1-02-implementation.md)
- Golden corpus: [golden/p0/MANIFEST.md](golden/p0/MANIFEST.md) (schema v1), [golden/p1/MANIFEST.md](golden/p1/MANIFEST.md) (schema v2)
- Candidate contests (mechanism ①): `candidates/p1/<set>/REPORT.md`

## Scene format (schema v2)

The current schema is `v: 2` ([schema/scene.schema.json](schema/scene.schema.json)); v1 scenes ([frozen copy](schema/scene.schema.v1.json)) are migrated on load and the manifest records the chain. Relative to v1:

- materials: `metallic` [0, 1] (default 0), `roughness` [0, 1] (default 1, alpha = roughness^2, below alpha 1e-3 an exact mirror), `ior` [1, 3] (default 1: no specular layer, exactly Lambert);
- `lights`: id -> `{ "type": "point", "position_m", "intensity_cd", "color" }`; emissive spheres are sampled as area lights automatically;
- `render.integrator: "pt_p1"` with `render.strategy`: `"bsdf"`, `"nee"` or `"mis"` (default).

Rolling a scene back to v1 (`rollbackTo` in [src/core/migrate.ts](src/core/migrate.ts)) is refused with `E_ROLLBACK_LOSSY` and the offending paths when it uses anything v1 cannot express.

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

Re-recording goldens (`golden rebase`) is only meaningful inside the reference container and refuses while any oracle fails. Changing a tolerance needs an ADR under `docs/adr/` naming the golden (`node tools/thresholds.ts --check`).
