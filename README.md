# meme

AI-native deterministic rendering/physics runtime. Input: a declarative scene (`schema/scene.schema.json`) and RFC 6902 patches. Output: images (linear PFM + sRGB PNG), physics state trajectories and a metrics manifest. TypeScript + WGSL on WebGPU (dawn.node).

- Design: [docs/P0-01-design.md](docs/P0-01-design.md)
- P0 delivery report: [docs/P0-02-implementation.md](docs/P0-02-implementation.md)
- Golden corpus: [golden/p0/MANIFEST.md](golden/p0/MANIFEST.md)

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

Re-recording goldens (`golden rebase`) is only meaningful inside the reference container and refuses while any oracle fails. Changing a tolerance needs an ADR under `docs/adr/` naming the golden (`node tools/thresholds.ts --check`).
