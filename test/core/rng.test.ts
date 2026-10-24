import assert from "node:assert/strict";
import { test } from "node:test";

import { HarnessRng, mulhi32, philox4x32R, toUnitFloat } from "../../src/core/rng.ts";
import { PHILOX_KAT } from "../../src/oracle/kat.ts";

test("Philox4x32 matches Random123 known-answer vectors", () => {
  for (const { rounds, ctr, key, out } of PHILOX_KAT) {
    const got = philox4x32R(rounds, ...ctr, ...key);
    assert.equal(got.map((x) => x.toString(16).padStart(8, "0")).join(" "), out, `R=${rounds}`);
  }
});

test("mulhi32 equals the BigInt high word", () => {
  const h = new HarnessRng(1, 0);
  for (let i = 0; i < 20000; i++) {
    const a = h.u32();
    const b = h.u32();
    assert.equal(mulhi32(a, b), Number((BigInt(a) * BigInt(b)) >> 32n));
  }
  assert.equal(mulhi32(0xffffffff, 0xffffffff), 0xfffffffe);
});

test("toUnitFloat is exact in f32 and lies in [0, 1)", () => {
  for (const u of [0, 1, 255, 256, 0x7fffffff, 0xffffffff]) {
    const x = toUnitFloat(u);
    assert.equal(Math.fround(x), x);
    assert.ok(x >= 0 && x < 1);
  }
  assert.equal(toUnitFloat(0xffffffff), 1 - 2 ** -24);
});

test("HarnessRng.shuffle is a permutation and reproducible", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const a = new HarnessRng(7, 3).shuffle(items);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
  assert.deepEqual(new HarnessRng(7, 3).shuffle(items), a);
  assert.notDeepEqual(a, items);
});
