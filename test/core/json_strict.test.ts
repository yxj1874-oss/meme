import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractViolation } from "../../src/core/errors.ts";
import { parseStrict } from "../../src/core/json_strict.ts";

function codes(text: string): string[] {
  try {
    parseStrict(text);
    return [];
  } catch (err) {
    assert.ok(err instanceof ContractViolation);
    return err.errors.map((e) => `${e.code}@${e.path}`);
  }
}

test("parses the same values as JSON.parse on well-formed input", () => {
  const text = '{"a":[1,-0.5,2e3,true,false,null],"b":{"c":"x\\u00e9\\n\\"y"},"d":[]}';
  assert.deepEqual(parseStrict(text), JSON.parse(text));
});

test("duplicate keys are reported with their pointer instead of last-one-wins", () => {
  assert.deepEqual(codes('{"objects":{"a":{"radius_m":1,"radius_m":2}}}'), ["E_DUPLICATE_KEY@/objects/a/radius_m"]);
});

test("numbers outside binary64 are E_NONFINITE, not Infinity", () => {
  assert.deepEqual(codes('{"r":1e999,"c":[0,-1e999]}'), ["E_NONFINITE@/r", "E_NONFINITE@/c/1"]);
});

test("NaN, Infinity, trailing commas, comments and BOM are syntax errors", () => {
  for (const bad of ['{"a":NaN}', '{"a":Infinity}', "[1,]", '{"a":1,}', "[1] // c", "﻿{}", "{'a':1}", "[01]", "[1.]", '"\u0001"']) {
    assert.deepEqual(codes(bad).map((c) => c.split("@")[0]), ["E_JSON_SYNTAX"], bad);
  }
});

test("__proto__ stays an ordinary own property", () => {
  const v = parseStrict('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.deepEqual(Object.keys(v), ["__proto__"]);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("nesting deeper than the limit is rejected rather than overflowing the stack", () => {
  assert.deepEqual(codes("[".repeat(100) + "]".repeat(100)).map((c) => c.split("@")[0]), ["E_JSON_SYNTAX"]);
});
