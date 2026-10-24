// Structured contract errors. Every rejection the runtime produces has this shape
// (scene.schema.json x-error-codes.report_shape) so agents can act on it without parsing prose.

export interface ContractError {
  code: string;
  /** RFC 6901 JSON Pointer into the instance; "" is the document root. */
  path: string;
  detail: string;
  op_index?: number;
  cause?: ContractError[];
}

export class ContractViolation extends Error {
  readonly errors: ContractError[];

  constructor(errors: ContractError[]) {
    super(errors.map((e) => `${e.code} at ${e.path === "" ? "<root>" : e.path}: ${e.detail}`).join("; "));
    this.name = "ContractViolation";
    this.errors = errors;
  }
}

/** Deterministic report order: by path, then code, then detail. */
export function sortErrors(errors: ContractError[]): ContractError[] {
  return [...errors].sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code) || cmp(a.detail, b.detail));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pointerEscape(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointerJoin(base: string, token: string | number): string {
  return `${base}/${pointerEscape(String(token))}`;
}
