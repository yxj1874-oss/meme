import assert from "node:assert/strict";
import { test } from "node:test";

import { ddmin } from "../../src/tools/reduce.ts";

test("ddmin finds the failure-inducing pair among 64 items", async () => {
  const items = Array.from({ length: 64 }, (_, i) => i);
  let calls = 0;
  const out = await ddmin(items, async (s) => {
    calls++;
    return s.includes(13) && s.includes(50);
  });
  assert.deepEqual(out, [13, 50]);
  assert.ok(calls < 200, `took ${calls} tests`);
});

test("ddmin keeps a single culprit and drops everything when the failure needs nothing", async () => {
  assert.deepEqual(await ddmin([1, 2, 3, 4, 5], async (s) => s.includes(4)), [4]);
  assert.deepEqual(await ddmin([1, 2, 3], async () => true), []);
});
