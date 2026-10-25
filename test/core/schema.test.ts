import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_DEFAULTS, JOINT_DEFAULTS, MATERIAL_DEFAULTS, PHYSICS_MATERIAL_DEFAULTS } from "../../src/core/scene.ts";
import { sceneSchema, validateSceneSchema } from "../../src/core/schema.ts";
import { lintSchema } from "../../src/oracle/schema_lint.ts";

test("MT1: every float has a unit and both bounds; every object is closed", () => {
  assert.deepEqual(lintSchema(sceneSchema), []);
});

test("MT1 lint catches what it claims to catch", () => {
  const broken = structuredClone(sceneSchema) as Record<string, any>;
  delete broken["$defs"].Radius_m["x-unit"];
  delete broken["$defs"].Mass_kg.maximum;
  delete broken["$defs"].Body.additionalProperties;
  const rules = lintSchema(broken).map((v) => `${v.path} ${v.rule}`);
  assert.equal(rules.length, 3, rules.join("\n"));
});

test("canonical defaults match the defaults declared in the schema", () => {
  const props = (sceneSchema["$defs"] as any).Material.properties;
  assert.deepEqual(props.emissive_cdm2.default, MATERIAL_DEFAULTS.emissive_cdm2);
  assert.deepEqual(props.emissive_color.default, MATERIAL_DEFAULTS.emissive_color);
  const defs = sceneSchema["$defs"] as any;
  for (const [k, v] of Object.entries(PHYSICS_MATERIAL_DEFAULTS)) assert.deepEqual(defs.PhysicsMaterial.properties[k].default, v, k);
  for (const [k, v] of Object.entries(BODY_DEFAULTS)) assert.deepEqual(defs.Body.properties[k].default, v, k);
  const distance = defs.Joint.oneOf.find((b: any) => b.properties.type.const === "distance");
  assert.deepEqual(distance.properties.compliance_m_N.default, JOINT_DEFAULTS.compliance_m_N);
});

test("errors inside a oneOf are reported against the branch named by the discriminator", () => {
  const scene = {
    v: 1, seed: 0, materials: { m: { base_color: [1, 1, 1] } },
    objects: { a: { shape: "sphere", center_m: [0, 0, 0], radius_m: 1, material: "m", radius: 2 }, p: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m", body: {} } },
    physics: { integrator: "xpbd_unconstrained_p0", gravity_m_s2: [0, 0, -9.81], dt_s: 0.01, steps: 1, record_every_steps: 1 },
  };
  assert.deepEqual(validateSceneSchema(scene).map((e) => `${e.code}@${e.path}`), ["E_UNKNOWN_PROPERTY@/objects/a", "E_UNKNOWN_PROPERTY@/objects/p"]);
});
