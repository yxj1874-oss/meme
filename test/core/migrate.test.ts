import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ContractViolation } from "../../src/core/errors.ts";
import { jcsHash } from "../../src/core/hash.ts";
import { parseStrict, type Json } from "../../src/core/json_strict.ts";
import { LATEST, migrateToLatest, rollbackTo } from "../../src/core/migrate.ts";
import { loadSceneText, loadSceneValue } from "../../src/core/scene.ts";
import { LATEST_VERSION } from "../../src/core/schema.ts";

const p0 = (path: string) => readFileSync(new URL(`../../golden/p0/${path}`, import.meta.url), "utf8");

test("migration chain ends at the schema's latest version", () => {
  assert.equal(LATEST, LATEST_VERSION);
});

test("v1 scenes load through migration to canonical v3 with Lambert-equivalent defaults", () => {
  const loaded = loadSceneText(p0("g01_det_double_run/scene.json"));
  assert.deepEqual(loaded.migrated_from, [1, 2, 3]);
  assert.equal(loaded.scene.v, 3);
  assert.equal(loaded.scene.render!.integrator, "pt_p1");
  assert.equal(loaded.scene.render!.strategy, "bsdf");
  for (const m of Object.values(loaded.scene.materials)) assert.deepEqual([m.metallic, m.roughness, m.ior], [0, 1, 1]);
});

test("migrate -> rollback -> migrate keeps scene_hash for every p0 scene", () => {
  const dirs = ["g01_det_double_run/scene.json", "g06_empty_black/scene.json", "g16_physics_extremes/scene_far.json", "g19_patch_semantics/base.json"];
  for (const d of dirs) {
    const v1 = parseStrict(p0(d));
    const up = migrateToLatest(v1, 1).scene;
    const again = migrateToLatest(rollbackTo(up, 1), 1).scene;
    assert.equal(jcsHash(again), jcsHash(up), d);
  }
});

test("lossy rollback names every path that would be dropped", () => {
  const v2 = loadSceneValue({
    v: 2, seed: 1,
    materials: { a: { base_color: [1, 1, 1], metallic: 1 }, b: { base_color: [1, 1, 1], ior: 1.5 } },
    objects: { s: { shape: "sphere", center_m: [0, 0, 0], radius_m: 1, material: "a" } },
    lights: { key: { type: "point", position_m: [0, 0, 3], intensity_cd: 10, color: [1, 1, 1] } },
    camera: { model: "pinhole", position_m: [0, -4, 0], look_at_m: [0, 0, 0], up: [0, 0, 1], vfov_rad: 0.6 },
    environment: { type: "constant", luminance_cdm2: 0, color: [1, 1, 1] },
    render: { width_px: 8, height_px: 8, spp: 1, max_bounces: 1, sampler: "independent", integrator: "pt_p1", display_white_cdm2: 1 },
  } as unknown as Json);
  try {
    rollbackTo(v2.scene as unknown as Json, 1);
    assert.fail("rollback should be lossy");
  } catch (err) {
    assert.ok(err instanceof ContractViolation);
    assert.deepEqual(err.errors.map((e) => `${e.code}@${e.path}`), [
      "E_ROLLBACK_LOSSY@/lights/key",
      "E_ROLLBACK_LOSSY@/materials/a/metallic",
      "E_ROLLBACK_LOSSY@/materials/b/ior",
      "E_ROLLBACK_LOSSY@/render/strategy",
    ]);
  }
});

test("v2 physics migrates to xpbd_p2 with one substep and no contacts, and rolls back losslessly", () => {
  const loaded = loadSceneText(p0("g17_free_fall_analytic/scene_dt.json"));
  assert.deepEqual(loaded.scene.physics!.integrator, "xpbd_p2");
  assert.equal(loaded.scene.physics!.substeps, 1);
  assert.equal(loaded.scene.physics!.contacts, "none");
  for (const o of Object.values(loaded.scene.objects)) {
    if (o.shape === "sphere" && o.body) assert.deepEqual([o.body.angular_velocity_rad_s, o.body.orientation], [[0, 0, 0], [0, 0, 0, 1]]);
  }
  const back = rollbackTo(loaded.scene as unknown as Json, 2) as any;
  assert.equal(back.physics.integrator, "xpbd_unconstrained_p0");
  assert.equal(back.physics.substeps, undefined);
});

test("lossy v3 -> v2 rollback names contacts, substeps, joints, physics materials and rotation", () => {
  const v3 = loadSceneValue({
    v: 3, seed: 1,
    materials: { m: { base_color: [1, 1, 1] } },
    physics_materials: { rubber: { restitution: 0.8, static_friction: 0.9, dynamic_friction: 0.7 } },
    objects: {
      ball: { shape: "sphere", center_m: [0, 0, 1], radius_m: 0.1, material: "m", physics_material: "rubber", body: { mass_kg: 1, velocity_m_s: [0, 0, 0], angular_velocity_rad_s: [0, 0, 1] } },
      floor: { shape: "plane", point_m: [0, 0, 0], normal: [0, 0, 1], material: "m" },
    },
    joints: { rope: { type: "distance", a: "world", b: "ball", anchor_a_m: [0, 0, 2], anchor_b_m: [0, 0, 0], rest_length_m: 1 } },
    physics: { integrator: "xpbd_p2", gravity_m_s2: [0, 0, -9.81], dt_s: 0.01, substeps: 4, steps: 10, record_every_steps: 10, contacts: "all_pairs" },
  } as unknown as Json);
  try {
    rollbackTo(v3.scene as unknown as Json, 2);
    assert.fail("rollback should be lossy");
  } catch (err) {
    assert.ok(err instanceof ContractViolation);
    assert.deepEqual(err.errors.map((e) => `${e.code}@${e.path}`), [
      "E_ROLLBACK_LOSSY@/joints/rope",
      "E_ROLLBACK_LOSSY@/objects/ball/body/angular_velocity_rad_s",
      "E_ROLLBACK_LOSSY@/objects/ball/physics_material",
      "E_ROLLBACK_LOSSY@/physics/contacts",
      "E_ROLLBACK_LOSSY@/physics/substeps",
      "E_ROLLBACK_LOSSY@/physics_materials/rubber",
    ]);
  }
});
