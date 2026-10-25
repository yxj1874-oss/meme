import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_CANDIDATES } from "../../src/runtime/render.ts";

test("DEFAULT_CANDIDATES equals the override defaults the kernels declare", () => {
  const declared: Record<string, number> = {};
  for (const f of ["bsdf_p1.wgsl", "render_p1.wgsl"]) {
    const text = readFileSync(new URL(`../../src/kernels/${f}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/^override (\w+): u32 = (\d+)u;/gm)) declared[m[1]!] = Number(m[2]);
  }
  for (const [name, value] of Object.entries(DEFAULT_CANDIDATES)) assert.equal(declared[name], value, name);
});
