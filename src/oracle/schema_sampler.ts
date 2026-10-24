// Draws random instances from the scene schema (harness stream 4) for golden G20 A4: every draw
// must pass the schema, and the semantic layer must answer each one with a structured
// ContractViolation or a loaded scene, never a crash. This is also the "failure rate under
// perturbed input" measure for the contract layer.

import type { Json } from "../core/json_strict.ts";
import type { HarnessRng } from "../core/rng.ts";
import { sceneSchema } from "../core/schema.ts";

type Node = Record<string, unknown> | boolean;
const defs = sceneSchema["$defs"] as Record<string, Node>;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";

function resolve(node: Node): Node {
  let n = node;
  while (typeof n === "object" && typeof n["$ref"] === "string") {
    const target = defs[(n["$ref"] as string).split("/").pop()!]!;
    const { $ref: _ref, ...rest } = n;
    n = typeof target === "object" ? { ...target, ...rest } : target;
  }
  return n;
}

function randomId(h: HarnessRng): string {
  let s = String.fromCharCode(97 + h.below(26));
  const len = h.below(6);
  for (let i = 0; i < len; i++) s += ID_CHARS[h.below(ID_CHARS.length)];
  return s;
}

function sampleNumber(n: Record<string, unknown>, h: HarnessRng, integer: boolean): number {
  const lo = (n["minimum"] as number | undefined) ?? -1e6;
  const hi = (n["maximum"] as number | undefined) ?? 1e6;
  const pick = h.below(8);
  if (integer) {
    if (pick === 0) return lo;
    if (pick === 1) return hi;
    // log-uniform over the span, so small counts (the usual case) dominate
    const span = hi - lo + 1;
    return Math.min(hi, lo + Math.floor(Math.exp(h.uniform() * Math.log(span))) - 1);
  }
  if (pick === 0) return lo;
  if (pick === 1) return hi;
  return lo + h.uniform() * (hi - lo);
}

export function sample(node: Node, h: HarnessRng, depth = 0): Json {
  const n = resolve(node);
  if (n === true) return h.below(2) === 0 ? null : h.below(100);
  if (n === false) throw new Error("cannot sample the false schema");
  if ("const" in n) return n["const"] as Json;
  if (Array.isArray(n["enum"])) return (n["enum"] as Json[])[h.below((n["enum"] as Json[]).length)]!;
  if (Array.isArray(n["oneOf"])) {
    const branches = n["oneOf"] as Node[];
    return sample(branches[h.below(branches.length)]!, h, depth + 1);
  }
  switch (n["type"]) {
    case "number":
      return sampleNumber(n, h, false);
    case "integer":
      return sampleNumber(n, h, true);
    case "string": {
      if (n["pattern"] === "^[a-z][a-z0-9_]{0,31}$") return randomId(h);
      const max = Math.min(16, (n["maxLength"] as number | undefined) ?? 16);
      let s = "";
      const len = h.below(max + 1);
      for (let i = 0; i < len; i++) s += String.fromCharCode(0x20 + h.below(0x5f));
      return s;
    }
    case "array": {
      const min = (n["minItems"] as number | undefined) ?? 0;
      const max = Math.min((n["maxItems"] as number | undefined) ?? 4, min + 3);
      const len = min + h.below(max - min + 1);
      return Array.from({ length: len }, () => sample(n["items"] as Node, h, depth + 1));
    }
    case "object": {
      const out: { [k: string]: Json } = {};
      const props = (n["properties"] as Record<string, Node> | undefined) ?? {};
      const required = new Set((n["required"] as string[] | undefined) ?? []);
      for (const key of Object.keys(props).sort()) {
        if (required.has(key) || h.below(2) === 0) out[key] = sample(props[key]!, h, depth + 1);
      }
      const extra = n["additionalProperties"];
      if (typeof extra === "object" && extra !== null && depth < 4) {
        const count = h.below(4);
        for (let i = 0; i < count; i++) out[randomId(h)] = sample(extra as Node, h, depth + 1);
      }
      return out;
    }
    default:
      throw new Error(`cannot sample schema node ${JSON.stringify(n).slice(0, 80)}`);
  }
}

/** A schema-valid random scene; references are pointed at existing materials most of the time. */
export function sampleScene(h: HarnessRng): Json {
  const s = sample(sceneSchema as Node, h) as { [k: string]: any };
  if (!("render" in s) && !("physics" in s)) s["physics"] = sample(defs["Physics"]!, h);
  if ("render" in s) {
    s["camera"] ??= sample(defs["Camera"]!, h);
    s["environment"] ??= sample(defs["Environment"]!, h);
  }
  const mats = Object.keys(s["materials"] as object);
  for (const o of Object.values(s["objects"] as Record<string, { material: string }>)) {
    if (mats.length > 0 && h.below(10) !== 0) o.material = mats[h.below(mats.length)]!;
  }
  return s as Json;
}
