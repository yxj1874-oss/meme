import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_PHYSICS_CANDIDATES } from "../../src/runtime/physics.ts";
import { DEFAULT_CANDIDATES } from "../../src/runtime/render.ts";

function declared(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const text = readFileSync(new URL(`../../src/kernels/${f}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/^override (\w+): u32 = (\d+)u;/gm)) out[m[1]!] = Number(m[2]);
  }
  return out;
}

test("DEFAULT_CANDIDATES equals the override defaults the render kernels declare", () => {
  const d = declared(["bsdf_p1.wgsl", "render_p1.wgsl"]);
  for (const [name, value] of Object.entries(DEFAULT_CANDIDATES)) assert.equal(d[name], value, name);
});

test("DEFAULT_PHYSICS_CANDIDATES equals the override defaults the physics kernel declares", () => {
  const d = declared(["physics_p2.wgsl"]);
  for (const [name, value] of Object.entries(DEFAULT_PHYSICS_CANDIDATES)) assert.equal(d[name], value, name);
});
