// Cross-field rules from scene.schema.json x-semantic-checks. Runs only on schema-valid scenes,
// before any GPU work, in f64.

import { type ContractError, pointerJoin, sortErrors } from "./errors.ts";
import { idhash32 } from "./hash.ts";
import { canonicalEntries } from "./jcs.ts";
import { type Scene, WORLD } from "./scene_types.ts";
import { cross, dot, luminanceY, norm, normalize, sub } from "./vec.ts";

const MIN_VECTOR_NORM = 1e-3;
const MIN_COLOR_Y = 1e-3;
/** f32 keeps 24 mantissa bits; requiring r >= 2^-12 (|c| + r) leaves >= 12 bits for the hit point. */
const PRECISION_RATIO = 2 ** -12;
/** Velocity increment per step must be >= 2^-16 V, i.e. >= 128 ulp(V) since ulp(V) <= 2^-23 V. */
const PRECISION_DT_RATIO = 2 ** -16;
const RENDER_BUDGET = 2 ** 36;
const PHYSICS_BUDGET = 2 ** 32;
const CONTACT_BUDGET = 2 ** 36;
/** Initial penetration allowed by E_INITIAL_OVERLAP, relative to the radius (sum of radii for pairs). */
const OVERLAP_TOLERANCE = 2 ** -20;
/** Largest mass ratio among interacting bodies (design P2D10). */
const MAX_MASS_RATIO = 100;
/** Largest rotation per substep, |omega| h, in radians (E_SPIN). */
const MAX_SPIN_STEP = 0.5;
const NORM_TOLERANCE = 1e-6;

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
    if (obj.physics_material !== undefined && !(obj.physics_material in (scene.physics_materials ?? {}))) {
      push("E_REF_MISSING", `${at}/physics_material`, `physics material ${JSON.stringify(obj.physics_material)} is not defined`);
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

  const lights = canonicalEntries(scene.lights ?? {});
  for (const [id, l] of lights) {
    const at = pointerJoin("/lights", id);
    if (l.intensity_cd > 0 && luminanceY(l.color) < MIN_COLOR_Y) push("E_COLOR_LUMINANCE", at, `Y(color) < ${MIN_COLOR_Y}`);
    for (const [oid, o] of objects) {
      if (o.shape === "sphere" && norm(sub(l.position_m, o.center_m)) <= o.radius_m) {
        push("E_LIGHT_INSIDE", at, `point light is inside or on sphere ${JSON.stringify(oid)}`);
      }
    }
  }

  const bodies = objects.filter(([, o]) => o.shape === "sphere" && o.body !== undefined);
  const joints = canonicalEntries(scene.joints ?? {});
  const physicsMaterials = canonicalEntries(scene.physics_materials ?? {});
  for (const [id, pm] of physicsMaterials) {
    if ((pm.dynamic_friction ?? 0) > (pm.static_friction ?? 0)) {
      push("E_FRICTION_ORDER", pointerJoin("/physics_materials", id), `dynamic_friction ${pm.dynamic_friction} > static_friction ${pm.static_friction ?? 0}`);
    }
  }
  for (const [id, o] of bodies) {
    if (o.shape !== "sphere" || o.body === undefined) continue;
    const q = o.body.orientation ?? [0, 0, 0, 1];
    const qn = Math.hypot(...q);
    if (Math.abs(qn - 1) > NORM_TOLERANCE) push("E_NORM", `${pointerJoin("/objects", id)}/body/orientation`, `|q| = ${qn}, not a unit quaternion`);
  }
  if (scene.physics !== undefined) {
    const p = scene.physics;
    const h = p.dt_s / p.substeps;
    const g = norm(p.gravity_m_s2);
    const contacts = p.contacts === "all_pairs";
    const interacting = contacts || joints.length > 0;
    for (const [id, o] of bodies) {
      if (o.shape !== "sphere" || o.body === undefined) continue;
      const at = `${pointerJoin("/objects", id)}/body`;
      if (g > 0 && !interacting) {
        const speedBound = norm(o.body.velocity_m_s) + g * p.dt_s * p.steps;
        if (g * h < PRECISION_DT_RATIO * speedBound) {
          push("E_PRECISION_DT", at, `|g|*h = ${g * h} < 2^-16 * V = ${PRECISION_DT_RATIO * speedBound}; gravity would round away in f32`);
        }
      }
      const spin = norm(o.body.angular_velocity_rad_s ?? [0, 0, 0]) * h;
      if (spin > MAX_SPIN_STEP) push("E_SPIN", `${at}/angular_velocity_rad_s`, `|omega| * h = ${spin} rad > ${MAX_SPIN_STEP}`);
    }
    if (interacting && bodies.length > 0) {
      const masses = bodies.map(([, o]) => (o.shape === "sphere" && o.body ? o.body.mass_kg : 1));
      const ratio = Math.max(...masses) / Math.min(...masses);
      if (ratio > MAX_MASS_RATIO) push("E_MASS_RATIO", "/objects", `max/min mass of interacting bodies = ${ratio} > ${MAX_MASS_RATIO}`);
    }
    if (contacts) {
      const spheres = objects.filter(([, o]) => o.shape === "sphere");
      const planes = objects.filter(([, o]) => o.shape === "plane");
      for (const [id, o] of bodies) {
        if (o.shape !== "sphere") continue;
        const at = pointerJoin("/objects", id);
        for (const [oid, other] of spheres) {
          if (oid === id || other.shape !== "sphere" || (other.body !== undefined && oid < id)) continue;
          const sum = o.radius_m + other.radius_m;
          if (norm(sub(o.center_m, other.center_m)) < sum * (1 - OVERLAP_TOLERANCE)) push("E_INITIAL_OVERLAP", at, `overlaps sphere ${JSON.stringify(oid)} at step 0`);
        }
        for (const [pid, pl] of planes) {
          if (pl.shape !== "plane") continue;
          const d = dot(normalize(pl.normal), sub(o.center_m, pl.point_m));
          if (d < o.radius_m * (1 - OVERLAP_TOLERANCE)) push("E_INITIAL_OVERLAP", at, `penetrates plane ${JSON.stringify(pid)} at step 0 (signed distance ${d} < radius ${o.radius_m})`);
        }
      }
    }
    const staticSpheres = objects.filter(([, o]) => o.shape === "sphere" && o.body === undefined).length;
    const planeCount = objects.filter(([, o]) => o.shape === "plane").length;
    if (!interacting && bodies.length * p.steps * p.substeps > PHYSICS_BUDGET) push("E_BUDGET", "/physics", `|bodies| * steps * substeps > 2^32`);
    if (interacting && bodies.length * (bodies.length + staticSpheres + planeCount + joints.length) * p.steps * p.substeps > CONTACT_BUDGET) {
      push("E_BUDGET", "/physics", `|bodies| * (|bodies| + |static spheres| + |planes| + |joints|) * steps * substeps > 2^36`);
    }
  }
  const dynamicIds = new Set(bodies.map(([id]) => id));
  for (const [id, j] of joints) {
    const at = pointerJoin("/joints", id);
    if (scene.physics === undefined) push("E_JOINT_REF", at, "joints require physics");
    for (const end of ["a", "b"] as const) {
      const ref = j[end];
      if (ref !== WORLD && !dynamicIds.has(ref)) push("E_JOINT_REF", `${at}/${end}`, `${JSON.stringify(ref)} is neither "world" nor a dynamic sphere`);
    }
    if (j.a === j.b) push("E_JOINT_SELF", at, `a and b are both ${JSON.stringify(j.a)}`);
    if (j.type === "hinge") {
      if (norm(j.axis_a) < MIN_VECTOR_NORM) push("E_ZERO_VECTOR", `${at}/axis_a`, `|axis_a| < ${MIN_VECTOR_NORM}`);
      if (norm(j.axis_b) < MIN_VECTOR_NORM) push("E_ZERO_VECTOR", `${at}/axis_b`, `|axis_b| < ${MIN_VECTOR_NORM}`);
    }
  }

  if (scene.render !== undefined) {
    const r = scene.render;
    const rays = (r.strategy ?? "mis") === "bsdf" ? 1 : 2; // light sampling adds a shadow ray per bounce
    const work = r.width_px * r.height_px * r.spp * (r.max_bounces + 1) * Math.max(1, objects.length) * rays;
    if (work > RENDER_BUDGET) push("E_BUDGET", "/render", `width*height*spp*(max_bounces+1)*objects*rays = ${work} > 2^36`);
  }

  for (const [ns, entries] of [["/materials", materials], ["/objects", objects], ["/lights", lights], ["/physics_materials", physicsMaterials], ["/joints", joints]] as const) {
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
