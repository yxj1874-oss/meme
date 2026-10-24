// Cross-field rules from scene.schema.json x-semantic-checks. Runs only on schema-valid scenes,
// before any GPU work, in f64.

import { type ContractError, pointerJoin, sortErrors } from "./errors.ts";
import { idhash32 } from "./hash.ts";
import { canonicalEntries } from "./jcs.ts";
import type { Scene } from "./scene_types.ts";
import { cross, luminanceY, norm, normalize, sub } from "./vec.ts";

const MIN_VECTOR_NORM = 1e-3;
const MIN_COLOR_Y = 1e-3;
/** f32 keeps 24 mantissa bits; requiring r >= 2^-12 (|c| + r) leaves >= 12 bits for the hit point. */
const PRECISION_RATIO = 2 ** -12;
/** Velocity increment per step must be >= 2^-16 V, i.e. >= 128 ulp(V) since ulp(V) <= 2^-23 V. */
const PRECISION_DT_RATIO = 2 ** -16;
const RENDER_BUDGET = 2 ** 36;
const PHYSICS_BUDGET = 2 ** 32;

export function semanticErrors(scene: Scene): ContractError[] {
  const errors: ContractError[] = [];
  const push = (code: string, path: string, detail: string) => errors.push({ code, path, detail });

  const objects = canonicalEntries(scene.objects);
  const materials = canonicalEntries(scene.materials);

  for (const [id, obj] of objects) {
    const at = pointerJoin("/objects", id);
    if (!(obj.material in scene.materials)) {
      push("E_REF_MISSING", `${at}/material`, `material ${JSON.stringify(obj.material)} is not defined`);
    }
    if (obj.shape === "plane") {
      if (norm(obj.normal) < MIN_VECTOR_NORM) push("E_ZERO_VECTOR", `${at}/normal`, `|normal| < ${MIN_VECTOR_NORM}`);
    } else {
      const bound = PRECISION_RATIO * (norm(obj.center_m) + obj.radius_m);
      if (obj.radius_m < bound) {
        push("E_PRECISION", at, `radius_m ${obj.radius_m} < 2^-12 * (|center_m| + radius_m) = ${bound}`);
      }
    }
  }

  if (scene.camera !== undefined) {
    const c = scene.camera;
    if (norm(c.up) < MIN_VECTOR_NORM) {
      push("E_ZERO_VECTOR", "/camera/up", `|up| < ${MIN_VECTOR_NORM}`);
    } else {
      const view = sub(c.look_at_m, c.position_m);
      if (norm(view) < 1e-3 * Math.max(1, norm(c.position_m))) {
        push("E_CAMERA_DEGENERATE", "/camera", "look_at_m coincides with position_m");
      } else if (norm(cross(normalize(c.up), normalize(view))) < 1e-3) {
        push("E_CAMERA_DEGENERATE", "/camera", "up is parallel to the view direction");
      }
    }
  }

  const env = scene.environment;
  if (env !== undefined) {
    if (env.type === "split" && norm(env.up) < MIN_VECTOR_NORM) push("E_ZERO_VECTOR", "/environment/up", `|up| < ${MIN_VECTOR_NORM}`);
    const lit = env.type === "constant" ? env.luminance_cdm2 > 0 : env.upper_cdm2 > 0 || env.lower_cdm2 > 0;
    if (lit && luminanceY(env.color) < MIN_COLOR_Y) push("E_COLOR_LUMINANCE", "/environment", `Y(color) < ${MIN_COLOR_Y}`);
  }

  for (const [id, m] of materials) {
    if ((m.emissive_cdm2 ?? 0) > 0 && luminanceY(m.emissive_color ?? [1, 1, 1]) < MIN_COLOR_Y) {
      push("E_COLOR_LUMINANCE", pointerJoin("/materials", id), `Y(emissive_color) < ${MIN_COLOR_Y}`);
    }
  }

  const bodies = objects.filter(([, o]) => o.shape === "sphere" && o.body !== undefined);
  if (scene.physics !== undefined) {
    const p = scene.physics;
    const g = norm(p.gravity_m_s2);
    if (g > 0) {
      for (const [id, o] of bodies) {
        if (o.shape !== "sphere" || o.body === undefined) continue;
        const speedBound = norm(o.body.velocity_m_s) + g * p.dt_s * p.steps;
        if (g * p.dt_s < PRECISION_DT_RATIO * speedBound) {
          push("E_PRECISION_DT", `${pointerJoin("/objects", id)}/body`,
            `|g|*dt = ${g * p.dt_s} < 2^-16 * V = ${PRECISION_DT_RATIO * speedBound}; gravity would round away in f32`);
        }
      }
    }
    if (bodies.length * p.steps > PHYSICS_BUDGET) push("E_BUDGET", "/physics", `|bodies| * steps > 2^32`);
  }

  if (scene.render !== undefined) {
    const r = scene.render;
    const work = r.width_px * r.height_px * r.spp * (r.max_bounces + 1) * Math.max(1, objects.length);
    if (work > RENDER_BUDGET) push("E_BUDGET", "/render", `width*height*spp*(max_bounces+1)*objects = ${work} > 2^36`);
  }

  for (const [ns, entries] of [["/materials", materials], ["/objects", objects]] as const) {
    const owners = new Map<number, string>();
    for (const [id] of entries) {
      const h = idhash32(id);
      const prev = owners.get(h);
      if (prev !== undefined) {
        push("E_ID_HASH_COLLISION", ns, `idhash32(${JSON.stringify(id)}) == idhash32(${JSON.stringify(prev)}) == 0x${h.toString(16).padStart(8, "0")}`);
      } else {
        owners.set(h, id);
      }
    }
  }

  return sortErrors(errors);
}
