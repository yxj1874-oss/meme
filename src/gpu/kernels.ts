// WGSL sources. WGSL has no includes, so shared modules are concatenated in front of a kernel.

import { readFileSync } from "node:fs";

const DIR = new URL("../kernels/", import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, DIR), "utf8");
}

const PRELUDE: Record<string, string[]> = {
  render_p1: ["rng.wgsl", "bsdf_lambert.wgsl", "bsdf_p1.wgsl"],
  probe_bsdf: ["rng.wgsl", "bsdf_lambert.wgsl", "bsdf_p1.wgsl"],
  rng_check: ["rng.wgsl"],
  physics_p0: [],
  probe_fbh: [],
};

export function kernelSource(name: "render_p1" | "physics_p0" | "rng_check" | "probe_bsdf" | "probe_fbh"): string {
  return [...PRELUDE[name]!, `${name}.wgsl`].map(read).join("\n");
}
