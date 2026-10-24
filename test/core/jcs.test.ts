import assert from "node:assert/strict";
import { test } from "node:test";

import { idhash32 } from "../../src/core/hash.ts";
import { jcs } from "../../src/core/jcs.ts";
import { parseStrict } from "../../src/core/json_strict.ts";

function f64(hex: string): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
}

// RFC 8785 Appendix B.
const NUMBER_SAMPLES: [string, string][] = [
  ["0000000000000000", "0"],
  ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"],
  ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"],
  ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"],
  ["c340000000000000", "-9007199254740992"],
  ["4430000000000000", "295147905179352830000"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"],
  ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000"],
  ["444b1ae4d6e2ef4f", "999999999999999900000"],
  ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"],
  ["41b3de4355555554", "333333333.33333325"],
  ["41b3de4355555555", "333333333.3333333"],
  ["41b3de4355555556", "333333333.3333334"],
  ["41b3de4355555557", "333333333.33333343"],
  ["becbf647612f3696", "-0.0000033333333333333333"],
  ["43143ff3c1cb0959", "1424953923781206.2"],
];

test("RFC 8785 Appendix B number serialization", () => {
  for (const [hex, expected] of NUMBER_SAMPLES) assert.equal(jcs(f64(hex)), expected, hex);
});

test("RFC 8785 Appendix B: NaN and Infinity are errors", () => {
  assert.throws(() => jcs(f64("7fffffffffffffff")));
  assert.throws(() => jcs(f64("7ff0000000000000")));
});

test("RFC 8785 §3.2.3 sorting example", () => {
  // Escapes are assembled at runtime so the test source itself contains no literal unicode escapes.
  const U = (hex: string) => "\\" + "u" + hex;
  const EURO = String.fromCharCode(0x20ac);
  const input = `{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "${U("20ac")}$${U("000F")}${U("000a")}A'${U("0042")}${U("0022")}${U("005c")}\\\\\\"\\/", "literals": [null, true, false]}`;
  const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${EURO}$${U("000f")}\\nA'B\\"\\\\\\\\\\"/"}`;
  assert.equal(jcs(parseStrict(input)), expected);
});

test("key order and number spelling do not change the canonical form", () => {
  assert.equal(jcs(parseStrict('{"b":1,"a":[0.5,1e0]}')), jcs(parseStrict('{"a":[5e-1,1.0],"b":1.0}')));
});

test("idhash32 is FNV-1a 32 (reference values from the FNV specification)", () => {
  // draft-eastlake-fnv test vectors: FNV1a32("") = 0x811c9dc5, ("a") = 0xe40c292c, ("foobar") = 0xbf9cf968.
  assert.equal(idhash32(""), 0x811c9dc5);
  assert.equal(idhash32("a"), 0xe40c292c);
  assert.equal(idhash32("foobar"), 0xbf9cf968);
});
