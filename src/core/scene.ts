// Scene intake: strict parse -> schema -> semantic checks -> canonical form + scene_hash
// (scene.schema.json x-canonical). Anything that passes here is safe to hand to the GPU.

import { ContractViolation } from "./errors.ts";
import { jcsHash } from "./hash.ts";
import { deepClone } from "./jcs.ts";
import { type Json, parseStrict } from "./json_strict.ts";
import type { Material, Scene } from "./scene_types.ts";
import { validateSceneSchema } from "./schema.ts";
import { semanticErrors } from "./semantic.ts";

export interface LoadedScene {
  /** Canonical form: defaults expanded, /meta removed. */
  scene: Scene;
  scene_hash: string;
}

export const MATERIAL_DEFAULTS: Required<Pick<Material, "emissive_cdm2" | "emissive_color">> = {
  emissive_cdm2: 0,
  emissive_color: [1, 1, 1],
};

export function loadSceneText(text: string): LoadedScene {
  return loadSceneValue(parseStrict(text));
}

export function loadSceneValue(value: Json): LoadedScene {
  const schemaErrors = validateSceneSchema(value);
  if (schemaErrors.length > 0) throw new ContractViolation(schemaErrors);
  const raw = value as unknown as Scene;
  const sem = semanticErrors(raw);
  if (sem.length > 0) throw new ContractViolation(sem);
  const scene = canonicalize(raw);
  return { scene, scene_hash: jcsHash(scene) };
}

export function canonicalize(scene: Scene): Scene {
  const out = deepClone(scene as unknown as Json) as unknown as Scene;
  delete out.meta;
  for (const m of Object.values(out.materials)) {
    m.emissive_cdm2 ??= MATERIAL_DEFAULTS.emissive_cdm2;
    m.emissive_color ??= [...MATERIAL_DEFAULTS.emissive_color];
  }
  return out;
}
