// Execution plans: how work is cut into passes, tiles, dispatches and submits. A plan must never
// change deterministic outputs (design N6, golden G03); it is still part of the determinism key.

import { jcsHash } from "../core/hash.ts";

export interface ExecutionPlan {
  /** Samples per render pass; the last pass takes the remainder. */
  pass_spp: number;
  /** Tile edge in pixels, a multiple of the 8x8 workgroup. */
  tile_px: number;
  /** Order in which tiles are listed (row-major tile indices). Omitted = row-major. */
  tile_order?: number[];
  /** Each pass's tile list is split into this many dispatch/submit batches. */
  submit_batches: number;
  /** Physics steps per dispatch; records still happen at record_every_steps. */
  physics_steps_per_dispatch: number;
}

export const DEFAULT_PLAN: ExecutionPlan = {
  pass_spp: 1 << 30,
  tile_px: 64,
  submit_batches: 1,
  physics_steps_per_dispatch: 1 << 30,
};

export function planHash(plan: ExecutionPlan): string {
  return jcsHash(plan);
}

export const WORKGROUP = 8;
/** WebGPU's guaranteed maxComputeWorkgroupsPerDimension. */
export const MAX_WORKGROUPS = 65535;

export function tileGrid(width: number, height: number, tilePx: number): { tilesX: number; tilesY: number } {
  return { tilesX: Math.ceil(width / tilePx), tilesY: Math.ceil(height / tilePx) };
}

/** Why a plan cannot run on an image of this size, or null if it can. */
export function planProblem(width: number, height: number, plan: ExecutionPlan): string | null {
  if (plan.tile_px % WORKGROUP !== 0 || plan.tile_px <= 0) return "tile_px must be a positive multiple of 8";
  const { tilesX, tilesY } = tileGrid(width, height, plan.tile_px);
  const order = plan.tile_order;
  if (order !== undefined && (order.length !== tilesX * tilesY || new Set(order).size !== order.length || order.some((t) => !(t >= 0 && t < order.length)))) {
    return "tile_order must be a permutation of all tiles";
  }
  return null;
}

/** 8x8 block origins (in blocks) for every tile in plan order, tile by tile. */
export function blockList(width: number, height: number, plan: ExecutionPlan): Uint32Array {
  const problem = planProblem(width, height, plan);
  if (problem !== null) throw new RangeError(problem);
  const { tilesX, tilesY } = tileGrid(width, height, plan.tile_px);
  const order = plan.tile_order ?? Array.from({ length: tilesX * tilesY }, (_, i) => i);
  const per = plan.tile_px / WORKGROUP;
  const bx = Math.ceil(width / WORKGROUP);
  const by = Math.ceil(height / WORKGROUP);
  const blocks: number[] = [];
  for (const t of order) {
    const tx = t % tilesX;
    const ty = Math.floor(t / tilesX);
    for (let j = 0; j < per; j++) {
      for (let i = 0; i < per; i++) {
        const x = tx * per + i;
        const y = ty * per + j;
        if (x < bx && y < by) blocks.push(x, y);
      }
    }
  }
  return Uint32Array.from(blocks);
}

/** [offset, count] ranges in blocks for each dispatch of one pass. */
export function batches(blockCount: number, plan: ExecutionPlan): [number, number][] {
  const per = Math.max(1, Math.ceil(blockCount / Math.max(1, plan.submit_batches)));
  const out: [number, number][] = [];
  for (let off = 0; off < blockCount; off += per) {
    const end = Math.min(blockCount, off + per);
    for (let o = off; o < end; o += MAX_WORKGROUPS) out.push([o, Math.min(MAX_WORKGROUPS, end - o)]);
  }
  return out;
}
