// RFC 6902 JSON Patch over RFC 6901 pointers, plus the scene-level envelope rules
// (scene.schema.json $defs/PatchEnvelope, x-patch-rules). A scene patch is atomic: it is applied
// to a copy, the copy is fully re-validated, and only then does it replace the current scene.

import { type ContractError, ContractViolation } from "./errors.ts";
import { deepClone } from "./jcs.ts";
import type { Json } from "./json_strict.ts";
import { type LoadedScene, loadSceneValue } from "./scene.ts";
import { validatePatchEnvelope } from "./schema.ts";

export type PatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: Json }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export interface PatchEnvelope {
  v: 1;
  base_scene_hash: string;
  ops: PatchOp[];
}

type Container = Json[] | { [key: string]: Json };

/** Applies ops to a copy of doc. Throws ContractViolation with op_index on the first failing op. */
export function applyJsonPatch(doc: Json, ops: PatchOp[]): Json {
  let root = deepClone(doc);
  ops.forEach((op, i) => {
    try {
      root = applyOp(root, op);
    } catch (err) {
      if (err instanceof PatchFailure) throw new ContractViolation([{ code: err.code, path: err.path, detail: err.message, op_index: i }]);
      throw err;
    }
  });
  return root;
}

export function applyScenePatch(current: LoadedScene, envelopeValue: Json): LoadedScene {
  const envErrors = validatePatchEnvelope(envelopeValue);
  if (envErrors.length > 0) throw new ContractViolation(envErrors);
  const env = envelopeValue as unknown as PatchEnvelope;
  if (env.base_scene_hash !== current.scene_hash) {
    throw new ContractViolation([{ code: "E_PATCH_BASE_MISMATCH", path: "/base_scene_hash", detail: `patch targets ${env.base_scene_hash}, current scene is ${current.scene_hash}` }]);
  }
  env.ops.forEach((op, i) => {
    for (const p of "from" in op ? [op.from, op.path] : [op.path]) {
      if (p === "" || p === "/v" || p.startsWith("/v/")) {
        throw new ContractViolation([{ code: "E_PATCH_FORBIDDEN_PATH", path: p, detail: p === "" ? "whole-scene replacement is not a patch" : "/v changes only through migrations", op_index: i }]);
      }
    }
  });
  const patched = applyJsonPatch(current.scene as unknown as Json, env.ops);
  try {
    return loadSceneValue(patched);
  } catch (err) {
    if (!(err instanceof ContractViolation)) throw err;
    const cause: ContractError[] = err.errors;
    throw new ContractViolation([{ code: "E_PATCH_INVALID_RESULT", path: cause[0]?.path ?? "", detail: "patched scene fails validation", cause }]);
  }
}

class PatchFailure extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, detail: string) {
    super(detail);
    this.code = code;
    this.path = path;
  }
}

function applyOp(root: Json, op: PatchOp): Json {
  checkShape(op);
  switch (op.op) {
    case "add":
      return add(root, op.path, deepClone(op.value));
    case "remove":
      return remove(root, op.path);
    case "replace":
      get(root, op.path); // must exist
      return op.path === "" ? deepClone(op.value) : add(remove(root, op.path), op.path, deepClone(op.value));
    case "move": {
      if (op.path === op.from) {
        get(root, op.from);
        return root;
      }
      if (op.path.startsWith(`${op.from}/`)) throw new PatchFailure("E_PATCH_INVALID_OP", op.path, "cannot move a value into one of its children");
      const value = get(root, op.from);
      return add(remove(root, op.from), op.path, value);
    }
    case "copy":
      return add(root, op.path, deepClone(get(root, op.from)));
    case "test":
      if (!jsonEqual(get(root, op.path), op.value)) throw new PatchFailure("E_PATCH_TEST_FAILED", op.path, "value differs");
      return root;
  }
}

// The scene envelope is schema-checked before this point; the generic applier still guards op
// shapes so it can be run against the json-patch-tests corpus on its own.
function checkShape(op: PatchOp): void {
  const o = op as unknown as Record<string, unknown>;
  const path = typeof o["path"] === "string" ? (o["path"] as string) : "";
  if (typeof o["path"] !== "string") throw new PatchFailure("E_PATCH_INVALID_OP", "", "op.path must be a string");
  const needsValue = o["op"] === "add" || o["op"] === "replace" || o["op"] === "test";
  const needsFrom = o["op"] === "move" || o["op"] === "copy";
  if (!needsValue && !needsFrom && o["op"] !== "remove") throw new PatchFailure("E_PATCH_INVALID_OP", path, `unknown op ${JSON.stringify(o["op"])}`);
  if (needsValue && !("value" in o)) throw new PatchFailure("E_PATCH_INVALID_OP", path, `${String(o["op"])} needs value`);
  if (needsFrom && typeof o["from"] !== "string") throw new PatchFailure("E_PATCH_INVALID_OP", path, `${String(o["op"])} needs from`);
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchFailure("E_PATCH_INVALID_OP", pointer, "JSON Pointer must start with '/'");
  return pointer.slice(1).split("/").map((t) => {
    if (/~[^01]|~$/.test(t)) throw new PatchFailure("E_PATCH_INVALID_OP", pointer, "invalid '~' escape");
    return t.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function isContainer(v: Json | undefined): v is Container {
  return typeof v === "object" && v !== null;
}

function arrayIndex(arr: Json[], token: string, pointer: string, forInsert: boolean): number {
  if (forInsert && token === "-") return arr.length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, `bad array index ${JSON.stringify(token)}`);
  const i = Number(token);
  if (forInsert ? i > arr.length : i >= arr.length) throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, `index ${i} out of range`);
  return i;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function get(root: Json, pointer: string): Json {
  let node: Json = root;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(node)) node = node[arrayIndex(node, token, pointer, false)] as Json;
    else if (isContainer(node) && hasOwn(node, token)) node = node[token] as Json;
    else throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, "no value at path");
  }
  return node;
}

function parentOf(root: Json, pointer: string): { parent: Container; token: string } {
  const tokens = parsePointer(pointer);
  const token = tokens.pop() as string;
  let node: Json = root;
  for (const t of tokens) {
    if (Array.isArray(node)) node = node[arrayIndex(node, t, pointer, false)] as Json;
    else if (isContainer(node) && hasOwn(node, t)) node = node[t] as Json;
    else throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, "parent does not exist");
  }
  if (!isContainer(node)) throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, "parent is not an object or array");
  return { parent: node, token };
}

function add(root: Json, pointer: string, value: Json): Json {
  if (pointer === "") return value;
  const { parent, token } = parentOf(root, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, token, pointer, true), 0, value);
  else Object.defineProperty(parent, token, { value, enumerable: true, writable: true, configurable: true });
  return root;
}

function remove(root: Json, pointer: string): Json {
  if (pointer === "") throw new PatchFailure("E_PATCH_INVALID_OP", pointer, "cannot remove the document root");
  const { parent, token } = parentOf(root, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, token, pointer, false), 1);
  else if (hasOwn(parent, token)) delete parent[token];
  else throw new PatchFailure("E_PATCH_PATH_NOT_FOUND", pointer, "no value at path");
  return root;
}

export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isContainer(a) && isContainer(b) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && jsonEqual((a as Record<string, Json>)[k], b[k]));
  }
  return false;
}
