import assert from "node:assert/strict";
import { test } from "node:test";

import { chiSquareP, gammaQ, olsSlope } from "../../src/oracle/stats.ts";

test("chi-square p-values match tabulated critical values", () => {
  // Critical values from standard chi-square tables (upper tail).
  assert.ok(Math.abs(chiSquareP(3.841, 1) - 0.05) < 1e-4);
  assert.ok(Math.abs(chiSquareP(18.307, 10) - 0.05) < 1e-4);
  assert.ok(Math.abs(chiSquareP(23.209, 10) - 0.01) < 1e-4);
  assert.ok(Math.abs(chiSquareP(124.342, 100) - 0.05) < 1e-4);
});

test("gammaQ(1, x) = exp(-x)", () => {
  for (const x of [0.1, 1, 3, 10]) assert.ok(Math.abs(gammaQ(1, x) - Math.exp(-x)) < 1e-12);
});

test("olsSlope recovers a line", () => {
  const r = olsSlope([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(r.slope - 2) < 1e-12 && Math.abs(r.intercept - 1) < 1e-12);
});
