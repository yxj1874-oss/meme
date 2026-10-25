// Scene version migrations (scene.schema.json x-migrations). A migration takes a schema-valid scene
// of version N to version N+1; a rollback goes back and is either lossless or refuses with
// E_ROLLBACK_LOSSY naming every path whose information would be dropped.

import { type ContractError, ContractViolation, pointerJoin, sortErrors } from "./errors.ts";
import { deepClone } from "./jcs.ts";
import type { Json } from "./json_strict.ts";

type Obj = { [key: string]: any };

interface Step {
  from: number;
  to: number;
  migrate: (scene: Obj) => Obj;
  rollback: (scene: Obj) => Obj;
}

const STEPS: Step[] = [
  {
    from: 1,
    to: 2,
    migrate(s) {
      const out = deepClone(s as Json) as Obj;
      out["v"] = 2;
      for (const m of Object.values(out["materials"] as Obj)) {
        m["metallic"] ??= 0;
        m["roughness"] ??= 1;
        m["ior"] ??= 1;
      }
      if (out["render"] !== undefined) {
        out["render"]["integrator"] = "pt_p1";
        out["render"]["strategy"] = "bsdf";
      }
      return out;
    },
    rollback(s) {
      const lossy: ContractError[] = [];
      for (const [id, m] of Object.entries(s["materials"] as Obj).sort(([a], [b]) => (a < b ? -1 : 1))) {
        const at = pointerJoin("/materials", id);
        if ((m["metallic"] ?? 0) !== 0) lossy.push({ code: "E_ROLLBACK_LOSSY", path: `${at}/metallic`, detail: "v1 has no metallic materials" });
        if ((m["ior"] ?? 1) !== 1) lossy.push({ code: "E_ROLLBACK_LOSSY", path: `${at}/ior`, detail: "v1 has no specular coat" });
      }
      for (const id of Object.keys(s["lights"] ?? {}).sort()) {
        lossy.push({ code: "E_ROLLBACK_LOSSY", path: pointerJoin("/lights", id), detail: "v1 has no point lights" });
      }
      if (s["render"] !== undefined && (s["render"]["strategy"] ?? "mis") !== "bsdf") {
        lossy.push({ code: "E_ROLLBACK_LOSSY", path: "/render/strategy", detail: "v1 renders with BSDF sampling only" });
      }
      if (lossy.length > 0) throw new ContractViolation(sortErrors(lossy));
      const out = deepClone(s as Json) as Obj;
      out["v"] = 1;
      delete out["lights"];
      for (const m of Object.values(out["materials"] as Obj)) {
        delete m["metallic"];
        delete m["roughness"];
        delete m["ior"];
      }
      if (out["render"] !== undefined) {
        out["render"]["integrator"] = "pt_bsdf_p0";
        delete out["render"]["strategy"];
      }
      return out;
    },
  },
  {
    from: 2,
    to: 3,
    migrate(s) {
      const out = deepClone(s as Json) as Obj;
      out["v"] = 3;
      if (out["physics"] !== undefined) {
        out["physics"]["integrator"] = "xpbd_p2";
        out["physics"]["substeps"] = 1;
        out["physics"]["contacts"] = "none";
      }
      return out;
    },
    rollback(s) {
      const lossy: ContractError[] = [];
      const p = s["physics"] as Obj | undefined;
      if (p !== undefined) {
        if (p["substeps"] !== 1) lossy.push({ code: "E_ROLLBACK_LOSSY", path: "/physics/substeps", detail: "v2 integrates one step at a time" });
        if (p["contacts"] !== "none") lossy.push({ code: "E_ROLLBACK_LOSSY", path: "/physics/contacts", detail: "v2 has no contacts" });
      }
      for (const id of Object.keys(s["joints"] ?? {}).sort()) lossy.push({ code: "E_ROLLBACK_LOSSY", path: pointerJoin("/joints", id), detail: "v2 has no joints" });
      for (const id of Object.keys(s["physics_materials"] ?? {}).sort()) lossy.push({ code: "E_ROLLBACK_LOSSY", path: pointerJoin("/physics_materials", id), detail: "v2 has no physics materials" });
      const zero = (v: unknown) => v === undefined || (v as number[]).every((x) => x === 0);
      const identity = (q: unknown) => q === undefined || ((q as number[])[0] === 0 && (q as number[])[1] === 0 && (q as number[])[2] === 0 && (q as number[])[3] === 1);
      for (const [id, o] of Object.entries(s["objects"] as Obj).sort(([a], [b]) => (a < b ? -1 : 1))) {
        const at = pointerJoin("/objects", id);
        if (o["physics_material"] !== undefined) lossy.push({ code: "E_ROLLBACK_LOSSY", path: `${at}/physics_material`, detail: "v2 has no physics materials" });
        const b = o["body"] as Obj | undefined;
        if (b === undefined) continue;
        if (!zero(b["angular_velocity_rad_s"])) lossy.push({ code: "E_ROLLBACK_LOSSY", path: `${at}/body/angular_velocity_rad_s`, detail: "v2 bodies do not rotate" });
        if (!identity(b["orientation"])) lossy.push({ code: "E_ROLLBACK_LOSSY", path: `${at}/body/orientation`, detail: "v2 bodies do not rotate" });
      }
      if (lossy.length > 0) throw new ContractViolation(sortErrors(lossy));
      const out = deepClone(s as Json) as Obj;
      out["v"] = 2;
      delete out["joints"];
      delete out["physics_materials"];
      for (const o of Object.values(out["objects"] as Obj)) {
        delete o["physics_material"];
        if (o["body"] !== undefined) {
          delete o["body"]["angular_velocity_rad_s"];
          delete o["body"]["orientation"];
        }
      }
      if (out["physics"] !== undefined) {
        out["physics"]["integrator"] = "xpbd_unconstrained_p0";
        delete out["physics"]["substeps"];
        delete out["physics"]["contacts"];
      }
      return out;
    },
  },
];

export const LATEST = STEPS[STEPS.length - 1]!.to;

/** Migrates a schema-valid scene of version `from` to the latest version; returns the chain applied. */
export function migrateToLatest(scene: Json, from: number): { scene: Json; chain: number[] } {
  let s = scene as Obj;
  const chain = [from];
  for (let v = from; v < LATEST; v++) {
    const step = STEPS.find((x) => x.from === v);
    if (step === undefined) throw new Error(`no migration from v${v}`);
    s = step.migrate(s);
    chain.push(step.to);
  }
  return { scene: s as Json, chain };
}

/** Rolls a latest-version scene back to `to`; throws ContractViolation(E_ROLLBACK_LOSSY) if lossy. */
export function rollbackTo(scene: Json, to: number): Json {
  let s = scene as Obj;
  for (let v = LATEST; v > to; v--) {
    const step = STEPS.find((x) => x.to === v);
    if (step === undefined) throw new Error(`no rollback to v${v - 1}`);
    s = step.rollback(s);
  }
  return s as Json;
}
