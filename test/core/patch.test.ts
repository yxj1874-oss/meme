import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ContractViolation } from "../../src/core/errors.ts";
import { jcs } from "../../src/core/jcs.ts";
import type { Json } from "../../src/core/json_strict.ts";
import { applyJsonPatch, applyScenePatch, jsonEqual, type PatchOp } from "../../src/core/patch.ts";
import { loadSceneValue } from "../../src/core/scene.ts";

interface Case { comment?: string; doc: Json; patch: PatchOp[]; expected?: Json; error?: string; disabled?: boolean }

for (const file of ["tests.json", "spec_tests.json"]) {
  const cases = JSON.parse(readFileSync(new URL(`../vendor/json-patch-tests/${file}`, import.meta.url), "utf8")) as Case[];
  test(`json-patch-tests ${file}`, () => {
    let ran = 0;
    for (const c of cases) {
      if (c.disabled) continue;
      const label = c.comment ?? c.error ?? JSON.stringify(c.patch);
      if (c.error !== undefined) {
        assert.throws(() => applyJsonPatch(c.doc, c.patch), ContractViolation, label);
      } else {
        const out = applyJsonPatch(c.doc, c.patch);
        if (c.expected !== undefined) assert.ok(jsonEqual(out, c.expected), `${label}: got ${JSON.stringify(out)}`);
      }
      ran++;
    }
    assert.ok(ran > 10);
  });
}

const BASE = {
  v: 1, seed: 1,
  materials: { m1: { base_color: [0.5, 0.5, 0.5] }, m2: { base_color: [0.2, 0.3, 0.4] } },
  objects: {
    ball_a: { shape: "sphere", center_m: [0, 0, 1], radius_m: 0.5, material: "m1", body: { mass_kg: 1, velocity_m_s: [0, 0, 0] } },
    ball_b: { shape: "sphere", center_m: [2, 0, 1], radius_m: 0.5, material: "m2" },
  },
  physics: { integrator: "xpbd_unconstrained_p0", gravity_m_s2: [0, 0, -9.81], dt_s: 0.01, steps: 10, record_every_steps: 5 },
} as const;

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ContractViolation);
    return err.errors.map(({ code, path, op_index, cause }) => ({ code, path, op_index, cause: cause?.map((c) => `${c.code}@${c.path}`) }));
  }
  assert.fail("expected a ContractViolation");
}

test("scene patch: incremental application equals the directly written scene", () => {
  const s0 = loadSceneValue(BASE as unknown as Json);
  const s1 = applyScenePatch(s0, {
    v: 1, base_scene_hash: s0.scene_hash,
    ops: [
      { op: "replace", path: "/objects/ball_a/radius_m", value: 0.25 },
      { op: "add", path: "/objects/ball_new", value: { shape: "sphere", center_m: [4, 0, 1], radius_m: 1, material: "m1" } },
      { op: "remove", path: "/objects/ball_b" },
    ],
  });
  const direct = structuredClone(BASE) as any;
  direct.objects.ball_a.radius_m = 0.25;
  direct.objects.ball_new = { shape: "sphere", center_m: [4, 0, 1], radius_m: 1, material: "m1" };
  delete direct.objects.ball_b;
  const d = loadSceneValue(direct);
  assert.equal(s1.scene_hash, d.scene_hash);
  assert.equal(jcs(s1.scene), jcs(d.scene));
});

test("scene patch: rejected patches report code, op_index and path, and leave the scene unchanged", () => {
  const s0 = loadSceneValue(BASE as unknown as Json);
  const before = jcs(s0.scene);
  const env = (ops: unknown[]) => ({ v: 1, base_scene_hash: s0.scene_hash, ops }) as unknown as Json;

  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "move", from: "/materials/m1", path: "/materials/m9" }]))),
    [{ code: "E_PATCH_INVALID_RESULT", path: "/objects/ball_a/material", op_index: undefined, cause: ["E_REF_MISSING@/objects/ball_a/material"] }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "test", path: "/seed", value: 2 }]))),
    [{ code: "E_PATCH_TEST_FAILED", path: "/seed", op_index: 0, cause: undefined }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "replace", path: "/materials/m1/base_color/0", value: 1.5 }]))),
    [{ code: "E_PATCH_INVALID_RESULT", path: "/materials/m1/base_color/0", op_index: undefined, cause: ["E_RANGE@/materials/m1/base_color/0"] }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "replace", path: "/v", value: 2 }]))),
    [{ code: "E_PATCH_FORBIDDEN_PATH", path: "/v", op_index: 0, cause: undefined }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "replace", path: "", value: {} }]))),
    [{ code: "E_PATCH_FORBIDDEN_PATH", path: "", op_index: 0, cause: undefined }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, { v: 1, base_scene_hash: `sha256:${"0".repeat(64)}`, ops: [{ op: "remove", path: "/seed" }] })),
    [{ code: "E_PATCH_BASE_MISMATCH", path: "/base_scene_hash", op_index: undefined, cause: undefined }]);
  assert.deepEqual(errorOf(() => applyScenePatch(s0, env([{ op: "remove", path: "/objects/nope" }]))),
    [{ code: "E_PATCH_PATH_NOT_FOUND", path: "/objects/nope", op_index: 0, cause: undefined }]);
  // Atomicity: four valid ops and a failing fifth leave nothing behind.
  assert.throws(() => applyScenePatch(s0, env([
    { op: "replace", path: "/seed", value: 9 },
    { op: "remove", path: "/objects/ball_b" },
    { op: "add", path: "/materials/m3", value: { base_color: [1, 1, 1] } },
    { op: "replace", path: "/objects/ball_a/radius_m", value: 0.3 },
    { op: "test", path: "/seed", value: 1 },
  ])));
  assert.equal(jcs(s0.scene), before);
});
