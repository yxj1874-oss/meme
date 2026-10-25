// Shared by the assertion libraries (assertions.ts, physics_assertions.ts): the evaluation context,
// result shape and the small helpers every assertion kind uses.

import type { LoadedScene } from "../core/scene.ts";
import type { Gpu } from "../gpu/device.ts";
import type { RunOutput } from "../runtime/run.ts";

export interface Result {
  id: string;
  pass: boolean;
  measured?: unknown;
  expected?: unknown;
  detail?: unknown;
}

export interface Run {
  loaded: LoadedScene;
  output: RunOutput;
}

export interface Context {
  root: string;
  dir: string;
  gpu: Gpu;
  cli: string;
  runs: Map<string, Run>;
}

export type Params = Record<string, any>;

export type Kind = (ctx: Context, a: Params) => Promise<Result[]> | Result[];

/** A named bound from the assertion's `bounds` (locked by MT5 like `tol`). */
export function bound(a: Params, name: string): number {
  const b = a["bounds"]?.[name] as { value: number } | undefined;
  if (b === undefined || typeof b.value !== "number") throw new Error(`assertion ${a["id"]}: missing bound ${name}`);
  return b.value;
}

export const one = (a: Params, pass: boolean, measured?: unknown, expected?: unknown, detail?: unknown): Result[] => [{ id: a["id"], pass, measured, expected, detail }];

export function run(ctx: Context, name: string): Run {
  const r = ctx.runs.get(name);
  if (r === undefined) throw new Error(`oracle refers to unknown run ${name}`);
  return r;
}
