// Scene intake: strict parse -> schema of the declared version -> migration to the latest version
// -> semantic checks -> canonical form + scene_hash (scene.schema.json x-canonical, x-migrations).
// Anything that passes here is safe to hand to the GPU.

import { ContractViolation } from "./errors.ts";
import { jcsHash } from "./hash.ts";
import { deepClone } from "./jcs.ts";
import { type Json, parseStrict } from "./json_strict.ts";
import type { Material, Scene } from "./scene_types.ts";
import { migrateToLatest } from "./migrate.ts";
import { declaredVersion, LATEST_VERSION, validateSceneSchema } from "./schema.ts";
import { semanticErrors } from "./semantic.ts";

export interface LoadedScene {
  /** Canonical form of the latest version: migrated, defaults expanded, /meta removed. */
  scene: Scene;
  scene_hash: string;
  /** Versions the scene went through, starting with the one it declared, e.g. [1, 2]. */
  migrated_from: number[];
}

export const MATERIAL_DEFAULTS: Required<Pick<Material, "emissive_cdm2" | "emissive_color" | "metallic" | "roughness" | "ior">> = {
  emissive_cdm2: 0,
  emissive_color: [1, 1, 1],
  metallic: 0,
  roughness: 1,
  ior: 1,
};

export const RENDER_DEFAULTS = { strategy: "mis" } as const;

export function loadSceneText(text: string): LoadedScene {
  return loadSceneValue(parseStrict(text));
}

export function loadSceneValue(value: Json): LoadedScene {
  const version = declaredVersion(value);
  const schemaErrors = validateSceneSchema(value, version);
  if (schemaErrors.length > 0) throw new ContractViolation(schemaErrors);
  const { scene: latest, chain } = migrateToLatest(value, version);
  if (version !== LATEST_VERSION) {
    const after = validateSceneSchema(latest, LATEST_VERSION);
    if (after.length > 0) throw new Error(`migration from v${version} produced an invalid scene: ${JSON.stringify(after)}`);
  }
  const raw = latest as unknown as Scene;
  const sem = semanticErrors(raw);
  if (sem.length > 0) throw new ContractViolation(sem);
  const scene = canonicalize(raw);
  return { scene, scene_hash: jcsHash(scene), migrated_from: chain };
}

export function canonicalize(scene: Scene): Scene {
  const out = deepClone(scene as unknown as Json) as unknown as Scene;
  delete out.meta;
  for (const m of Object.values(out.materials)) {
    m.emissive_cdm2 ??= MATERIAL_DEFAULTS.emissive_cdm2;
    m.emissive_color ??= [...MATERIAL_DEFAULTS.emissive_color];
    m.metallic ??= MATERIAL_DEFAULTS.metallic;
    m.roughness ??= MATERIAL_DEFAULTS.roughness;
    m.ior ??= MATERIAL_DEFAULTS.ior;
  }
  if (out.render !== undefined) out.render.strategy ??= RENDER_DEFAULTS.strategy;
  out.lights ??= {};
  return out;
}
