// MT1: structural rules every node of the scene schema must satisfy so that constrained decoding
// can reject illegal values while they are being generated (design §②, MT1).

export interface LintViolation {
  path: string;
  rule: string;
}

export function lintSchema(schema: Record<string, unknown>): LintViolation[] {
  const vocabulary = new Set(Object.keys((schema["x-unit-vocabulary"] as { units: object }).units));
  const out: LintViolation[] = [];

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => visit(c, `${path}/${i}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const has = (...keys: string[]) => keys.some((k) => k in n);
    switch (n["type"]) {
      case "number":
        if (!vocabulary.has(n["x-unit"] as string)) out.push({ path, rule: "number needs x-unit from x-unit-vocabulary" });
        if (!has("minimum", "exclusiveMinimum") || !has("maximum", "exclusiveMaximum")) out.push({ path, rule: "number needs both bounds" });
        break;
      case "integer":
        if (!has("minimum") || !has("maximum")) out.push({ path, rule: "integer needs both bounds" });
        break;
      case "object":
        if (!has("additionalProperties")) out.push({ path, rule: "object must be closed or typed (additionalProperties)" });
        break;
      case "string":
        if (!has("const", "enum", "pattern", "maxLength")) out.push({ path, rule: "string needs const, enum, pattern or maxLength" });
        break;
      case "array":
        if (!has("maxItems")) out.push({ path, rule: "array needs maxItems" });
        break;
    }
    for (const [k, v] of Object.entries(n)) {
      if (!k.startsWith("x-")) visit(v, `${path}/${k}`);
    }
  };

  for (const [k, v] of Object.entries(schema)) {
    if (!k.startsWith("x-")) visit(v, `#/${k}`);
  }
  if (schema["type"] !== "object" || !("additionalProperties" in schema)) out.push({ path: "#", rule: "root must be a closed object" });
  return out;
}
