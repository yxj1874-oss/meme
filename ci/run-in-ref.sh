#!/usr/bin/env bash
# Runs a command inside the reference substrate (design D2-A) with the repository mounted at /work.
# Local runs and CI both go through this script, so they share the image spec and environment.
#   ci/run-in-ref.sh node src/cli.ts golden verify
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v sha256sum >/dev/null; then spec=$(sha256sum ci/Dockerfile | cut -d' ' -f1); else spec=$(shasum -a 256 ci/Dockerfile | cut -d' ' -f1); fi
tag="meme-ref:${spec:0:16}"
if ! docker image inspect "$tag" >/dev/null 2>&1; then
  docker build --platform linux/arm64 -t "$tag" -f ci/Dockerfile ci
fi
tty=()
if [ -t 1 ]; then tty=(-t); fi
exec docker run --rm ${tty[@]+"${tty[@]}"} --platform linux/arm64 \
  -e MEME_IMAGE_SPEC="sha256:${spec}" \
  -v "$PWD":/work -w /work "$tag" "$@"
