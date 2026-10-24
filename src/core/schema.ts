// Schema validation for scenes and patch envelopes, with ajv errors mapped to the contract's
// error codes (scene.schema.json x-error-codes). oneOf failures are reported against the branch
// selected by the discriminator property, so a typo inside a sphere is reported as that typo and
// not as "matches none of sphere/plane".

import { readFileSync } from "node:fs";

import AjvModule from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import { type ContractError, sortErrors } from "./errors.ts";

const Ajv2020 = AjvModule.default;

export const SCHEMA_URL = new URL("../../schema/scene.schema.json", import.meta.url);
export const sceneSchema = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as Record<string, unknown>;
const SCHEMA_ID = sceneSchema["$id"] as string;

const DISCRIMINATORS = ["shape", "type", "op"] as const;

// ajv reports schemaPath relative to the $ref target ("#/oneOf"), which loses the $defs entry,
// so oneOf arrays are found by identity instead.
const oneOfLocations = new Map<unknown, string>();
indexOneOfs(sceneSchema, "");

const KEYWORD_CODES: Record<string, string> = {
  type: "E_TYPE",
  minimum: "E_RANGE",
  maximum: "E_RANGE",
  exclusiveMinimum: "E_RANGE",
  exclusiveMaximum: "E_RANGE",
  additionalProperties: "E_UNKNOWN_PROPERTY",
  required: "E_REQUIRED",
  pattern: "E_PATTERN",
  maxLength: "E_PATTERN",
  minLength: "E_PATTERN",
  propertyNames: "E_PATTERN",
  const: "E_ENUM",
  enum: "E_ENUM",
  dependentRequired: "E_RENDER_REQUIRES",
  minItems: "E_ARITY",
  maxItems: "E_ARITY",
  minProperties: "E_TOO_MANY",
  maxProperties: "E_TOO_MANY",
  oneOf: "E_VARIANT",
};

const ajv = new Ajv2020({
  strict: true,
  // The root anyOf branches are bare {required:[...]} over properties declared at the root.
  strictRequired: false,
  allErrors: true,
  allowUnionTypes: false,
  // verbose puts the keyword's schema value on each error; oneOf errors are located through it.
  verbose: true,
});
for (const keyword of collectAnnotationKeywords(sceneSchema)) ajv.addKeyword({ keyword });
ajv.addSchema(sceneSchema);

const validateSceneFn = ajv.getSchema(SCHEMA_ID) as ValidateFunction;
const validateEnvelopeFn = ajv.getSchema(`${SCHEMA_ID}#/$defs/PatchEnvelope`) as ValidateFunction;

export function validateSceneSchema(instance: unknown): ContractError[] {
  return runValidator(validateSceneFn, instance, "#");
}

export function validatePatchEnvelope(instance: unknown): ContractError[] {
  return runValidator(validateEnvelopeFn, instance, "#/$defs/PatchEnvelope");
}

function runValidator(fn: ValidateFunction, instance: unknown, rootSchemaPath: string): ContractError[] {
  if (fn(instance)) return [];
  return sortErrors(dedupe(mapErrors(fn.errors ?? [], instance, rootSchemaPath)));
}

function mapErrors(raw: ErrorObject[], instance: unknown, rootSchemaPath: string): ContractError[] {
  let errors = raw;
  const out: ContractError[] = [];

  // Root anyOf (render | physics): one contract error instead of two "required" branch errors.
  if (errors.some((e) => e.keyword === "anyOf" && e.instancePath === "")) {
    errors = errors.filter((e) => !(e.instancePath === "" && (e.keyword === "anyOf" || e.schemaPath.startsWith(`${rootSchemaPath}/anyOf/`))));
    out.push({ code: "E_EMPTY_RUN", path: "", detail: "scene needs render or physics" });
  }

  // oneOf: replace everything reported under the oneOf location with the errors of the branch
  // the discriminator selects. Outermost locations first so nested replacements stay consistent.
  const oneOfs = errors.filter((e) => e.keyword === "oneOf").sort((a, b) => a.instancePath.length - b.instancePath.length);
  const handled: string[] = [];
  for (const e of oneOfs) {
    const at = e.instancePath;
    if (handled.some((h) => at === h || at.startsWith(`${h}/`))) continue;
    handled.push(at);
    errors = errors.filter((x) => !(x.instancePath === at || x.instancePath.startsWith(`${at}/`)));
    out.push(...branchErrors(e, at, getPointer(instance, at)));
  }

  for (const e of errors) {
    // propertyNames produces a nested "pattern" error carrying propertyName; the propertyNames error covers it.
    if ((e as { propertyName?: string }).propertyName !== undefined && e.keyword !== "propertyNames") continue;
    out.push(mapOne(e));
  }
  return out;
}

function branchErrors(e: ErrorObject, at: string, node: unknown): ContractError[] {
  const fragment = oneOfLocations.get(e.schema);
  if (fragment === undefined) throw new Error(`oneOf at ${e.schemaPath} not found in the scene schema`);
  const branches = e.schema as Array<{ properties?: Record<string, { const?: unknown }> }>;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return [{ code: "E_TYPE", path: at, detail: "must be object" }];
  }
  const obj = node as Record<string, unknown>;
  for (const disc of DISCRIMINATORS) {
    if (!branches.some((b) => b.properties?.[disc]?.const !== undefined)) continue;
    if (!(disc in obj)) return [{ code: "E_REQUIRED", path: at, detail: `missing discriminator "${disc}"` }];
    const k = branches.findIndex((b) => b.properties?.[disc]?.const === obj[disc]);
    if (k < 0) {
      const allowed = branches.map((b) => JSON.stringify(b.properties?.[disc]?.const)).join(", ");
      return [{ code: "E_VARIANT", path: `${at}/${disc}`, detail: `${JSON.stringify(obj[disc])} is not one of ${allowed}` }];
    }
    const fn = ajv.getSchema(`${SCHEMA_ID}#${fragment}/${k}`) as ValidateFunction;
    if (fn(node)) return [];
    return (fn.errors ?? [])
      .filter((x) => (x as { propertyName?: string }).propertyName === undefined || x.keyword === "propertyNames")
      .map((x) => mapOne({ ...x, instancePath: at + x.instancePath }));
  }
  return [{ code: "E_VARIANT", path: at, detail: e.message ?? "matches no variant" }];
}

function mapOne(e: ErrorObject): ContractError {
  const code = KEYWORD_CODES[e.keyword] ?? "E_SCHEMA";
  const params = e.params as Record<string, unknown>;
  let detail = e.message ?? e.keyword;
  if (e.keyword === "additionalProperties") detail = `unknown property ${JSON.stringify(params["additionalProperty"])}`;
  else if (e.keyword === "required") detail = `missing property ${JSON.stringify(params["missingProperty"])}`;
  else if (e.keyword === "propertyNames") detail = `invalid id ${JSON.stringify(params["propertyName"])}`;
  else if (e.keyword === "dependentRequired") detail = `render requires ${JSON.stringify(params["missingProperty"])}`;
  return { code, path: e.instancePath, detail };
}

function dedupe(errors: ContractError[]): ContractError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.code}\u0000${e.path}\u0000${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let node = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

function indexOneOfs(node: unknown, pointer: string): void {
  if (Array.isArray(node)) {
    node.forEach((c, i) => indexOneOfs(c, `${pointer}/${i}`));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("x-")) continue;
      if (k === "oneOf") oneOfLocations.set(v, `${pointer}/oneOf`);
      indexOneOfs(v, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
    }
  }
}

function collectAnnotationKeywords(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const c of node) collectAnnotationKeywords(c, acc);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("x-")) acc.add(k);
      else collectAnnotationKeywords(v, acc);
    }
  }
  return acc;
}
