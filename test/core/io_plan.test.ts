import assert from "node:assert/strict";
import { test } from "node:test";

import { HarnessRng } from "../../src/core/rng.ts";
import { decodePfm, encodePfm } from "../../src/io/pfm.ts";
import { decodePngStored, encodePngRgb8, srgbOetf } from "../../src/io/png.ts";
import { batches, blockList, DEFAULT_PLAN, planProblem } from "../../src/runtime/plan.ts";

test("PNG: node:zlib decodes what the stored-deflate encoder writes, including multi-block IDAT", () => {
  const h = new HarnessRng(9, 9);
  const w = 200;
  const height = 120; // 120 rows * 601 bytes > 65535: several stored blocks
  const rgb = Uint8Array.from({ length: w * height * 3 }, () => h.below(256));
  const png = encodePngRgb8(w, height, rgb);
  const back = decodePngStored(png);
  assert.equal(back.width, w);
  assert.equal(back.height, height);
  assert.deepEqual(back.rgb, rgb);
  assert.deepEqual(encodePngRgb8(w, height, rgb), png); // byte-stable
});

test("PFM round trip keeps every float bit and stores rows bottom to top", () => {
  const rgb = Float32Array.from([1, 2, 3, 4, 5, 6, -0.5, 1e-30, 3.4e38, 0, 7, 8]);
  const pfm = encodePfm(2, 2, rgb);
  assert.deepEqual(decodePfm(pfm).rgb, rgb);
  const header = new TextDecoder().decode(pfm.subarray(0, 12));
  assert.equal(header, "PF\n2 2\n-1.0\n");
  // first stored scanline is the bottom row (pixels 2 and 3)
  assert.equal(new DataView(pfm.buffer, 12).getFloat32(0, true), -0.5);
});

test("sRGB OETF matches IEC 61966-2-1 at its breakpoints", () => {
  assert.equal(srgbOetf(0), 0);
  assert.ok(Math.abs(srgbOetf(1) - 1) < 1e-15);
  assert.ok(Math.abs(srgbOetf(0.0031308) - 0.0031308 * 12.92) < 1e-12);
});

test("blockList covers every 8x8 block exactly once for any tile size and order", () => {
  for (const tile of [8, 16, 64]) {
    const base = blockList(100, 37, { ...DEFAULT_PLAN, tile_px: tile });
    const seen = new Set<string>();
    for (let i = 0; i < base.length; i += 2) seen.add(`${base[i]},${base[i + 1]}`);
    assert.equal(seen.size, Math.ceil(100 / 8) * Math.ceil(37 / 8));
    assert.equal(seen.size * 2, base.length);
  }
  const n = Math.ceil(100 / 16) * Math.ceil(37 / 16);
  const order = new HarnessRng(1, 1, 5).shuffle(Array.from({ length: n }, (_, i) => i));
  assert.equal(blockList(100, 37, { ...DEFAULT_PLAN, tile_px: 16, tile_order: order }).length, Math.ceil(100 / 8) * Math.ceil(37 / 8) * 2);
  assert.match(planProblem(100, 37, { ...DEFAULT_PLAN, tile_px: 16, tile_order: order.slice(1) }) ?? "", /permutation/);
});

test("batches split a pass without gaps and respect the workgroup limit", () => {
  const b = batches(200000, { ...DEFAULT_PLAN, submit_batches: 3 });
  let next = 0;
  for (const [off, count] of b) {
    assert.equal(off, next);
    assert.ok(count <= 65535);
    next += count;
  }
  assert.equal(next, 200000);
});
