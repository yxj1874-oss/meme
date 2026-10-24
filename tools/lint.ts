// Determinism lint (design §3.3 N1, N4, N13) plus the "no TODO" rule. Uses the TypeScript AST,
// not regexes, for the TS rules so comments and strings do not trigger them.
// Usage: node tools/lint.ts   (exit 1 on any violation)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;

/** Wall clock, entropy and completion-order sources. Allowed only under src/perf/. */
const BANNED_MEMBERS = new Set([
  "Math.random", "Date.now", "performance.now", "process.hrtime", "process.uptime",
  "crypto.getRandomValues", "crypto.randomUUID", "Promise.race", "Promise.any",
]);
const BANNED_IDENTIFIERS = new Set(["Date", "performance", "setTimeout", "setInterval", "setImmediate", "randomBytes", "randomUUID", "randomInt", "randomFillSync"]);

interface Violation { file: string; line: number; rule: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function lintTs(file: string, text: string, out: Violation[]): void {
  const rel = relative(ROOT, file);
  if (rel.startsWith("src/perf/")) return;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true);
  const report = (node: ts.Node, rule: string) =>
    out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule });
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const text = `${node.expression.getText(sf)}.${node.name.text}`;
      if (BANNED_MEMBERS.has(text)) report(node, `${text} is a nondeterminism source (only src/perf may read clocks)`);
    } else if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent);
      if (!isMemberName) report(node, `${node.text} is a nondeterminism source`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function lintWgsl(file: string, text: string, out: Violation[]): void {
  text.split("\n").forEach((line, i) => {
    if (/atomicCompareExchangeWeak/.test(line) && !/\/\/ det-ok:/.test(line)) {
      out.push({ file: relative(ROOT, file), line: i + 1, rule: "CAS loops can emulate unordered float adds; justify with // det-ok:" });
    }
  });
}

const violations: Violation[] = [];
for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tools")), ...walk(join(ROOT, "ci"))]) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".ts") && relative(ROOT, file).startsWith("src/")) lintTs(file, text, violations);
  if (file.endsWith(".wgsl")) lintWgsl(file, text, violations);
  if (file !== new URL(import.meta.url).pathname) {
    text.split("\n").forEach((line, i) => {
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) violations.push({ file: relative(ROOT, file), line: i + 1, rule: "no TODO/FIXME/XXX in shipped code" });
    });
  }
}

for (const v of violations) console.log(`${v.file}:${v.line}  ${v.rule}`);
console.log(`lint: ${violations.length} violation(s)`);
process.exit(violations.length === 0 ? 0 : 1);
