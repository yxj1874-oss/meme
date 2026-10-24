// TypeScript view of schema/scene.schema.json v1. Only produced by validateScene(), so every
// value here is already range-checked; field names carry their units like the schema does.

export type Vec3 = [number, number, number];

export interface Scene {
  v: 1;
  seed: number;
  meta?: { name?: string; note?: string };
  camera?: Camera;
  environment?: Environment;
  render?: Render;
  physics?: Physics;
  materials: { [id: string]: Material };
  objects: { [id: string]: SceneObject };
}

export interface Camera {
  model: "pinhole";
  position_m: Vec3;
  look_at_m: Vec3;
  up: Vec3;
  vfov_rad: number;
}

export type Environment =
  | { type: "constant"; luminance_cdm2: number; color: Vec3 }
  | { type: "split"; up: Vec3; upper_cdm2: number; lower_cdm2: number; color: Vec3 };

export interface Render {
  width_px: number;
  height_px: number;
  spp: number;
  max_bounces: number;
  sampler: "independent";
  integrator: "pt_bsdf_p0";
  display_white_cdm2: number;
}

export interface Physics {
  integrator: "xpbd_unconstrained_p0";
  gravity_m_s2: Vec3;
  dt_s: number;
  steps: number;
  record_every_steps: number;
}

export interface Material {
  base_color: Vec3;
  emissive_cdm2?: number;
  emissive_color?: Vec3;
}

export interface Body {
  mass_kg: number;
  velocity_m_s: Vec3;
}

export type SceneObject =
  | { shape: "sphere"; center_m: Vec3; radius_m: number; material: string; body?: Body }
  | { shape: "plane"; point_m: Vec3; normal: Vec3; material: string };

export type Sphere = Extract<SceneObject, { shape: "sphere" }>;
export type Plane = Extract<SceneObject, { shape: "plane" }>;
