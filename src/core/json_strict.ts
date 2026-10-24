// Strict RFC 8259 parser. JSON.parse is not enough for the scene contract:
//  - it silently keeps the last of duplicate keys (RFC 8259 §4 only says names SHOULD be unique),
//  - it turns 1e999 into Infinity,
//  - it lets "__proto__" rewrite the prototype of the produced object.
// Here duplicates and non-finite numbers are reported with their JSON Pointer; syntax errors abort.

import { type ContractError, ContractViolation, pointerJoin } from "./errors.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_DEPTH = 64;

export function parseStrict(text: string): Json {
  const p = new Parser(text);
  const value = p.parseDocument();
  if (p.errors.length > 0) throw new ContractViolation(p.errors);
  return value;
}

class Parser {
  readonly errors: ContractError[] = [];
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): Json {
    this.skipWs();
    const value = this.parseValue("", 0);
    this.skipWs();
    if (this.pos !== this.text.length) this.fail("trailing characters after the JSON value");
    return value;
  }

  private parseValue(path: string, depth: number): Json {
    if (depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH}`);
    const c = this.text[this.pos];
    if (c === "{") return this.parseObject(path, depth);
    if (c === "[") return this.parseArray(path, depth);
    if (c === '"') return this.parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber(path);
    if (this.text.startsWith("true", this.pos)) return this.literal(4, true);
    if (this.text.startsWith("false", this.pos)) return this.literal(5, false);
    if (this.text.startsWith("null", this.pos)) return this.literal(4, null);
    this.fail(c === undefined ? "unexpected end of input" : `unexpected character ${JSON.stringify(c)}`);
  }

  private literal(length: number, value: boolean | null): boolean | null {
    this.pos += length;
    return value;
  }

  private parseObject(path: string, depth: number): { [key: string]: Json } {
    const obj: { [key: string]: Json } = {};
    const seen = new Set<string>();
    this.pos++; // {
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.fail("expected a string key");
      const key = this.parseString();
      const childPath = pointerJoin(path, key);
      this.skipWs();
      this.expect(":");
      this.skipWs();
      const value = this.parseValue(childPath, depth + 1);
      if (seen.has(key)) {
        this.errors.push({ code: "E_DUPLICATE_KEY", path: childPath, detail: `key ${JSON.stringify(key)} appears more than once` });
      } else {
        seen.add(key);
        // defineProperty keeps "__proto__" an ordinary own property instead of a prototype assignment.
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      }
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return obj;
      }
      this.fail("expected ',' or '}' in object");
    }
  }

  private parseArray(path: string, depth: number): Json[] {
    const arr: Json[] = [];
    this.pos++; // [
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return arr;
    }
    for (;;) {
      this.skipWs();
      arr.push(this.parseValue(pointerJoin(path, arr.length), depth + 1));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return arr;
      }
      this.fail("expected ',' or ']' in array");
    }
  }

  private parseString(): string {
    this.pos++; // opening quote
    let out = "";
    let runStart = this.pos;
    for (;;) {
      const code = this.text.charCodeAt(this.pos);
      if (Number.isNaN(code)) this.fail("unterminated string");
      if (code === 0x22) {
        out += this.text.slice(runStart, this.pos);
        this.pos++;
        return out;
      }
      if (code < 0x20) this.fail("unescaped control character in string");
      if (code === 0x5c) {
        out += this.text.slice(runStart, this.pos);
        out += this.parseEscape();
        runStart = this.pos;
        continue;
      }
      this.pos++;
    }
  }

  private parseEscape(): string {
    const c = this.text[this.pos + 1];
    this.pos += 2;
    switch (c) {
      case '"': return '"';
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid \\u escape");
        this.pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        this.fail(`invalid escape \\${c ?? ""}`);
    }
  }

  private parseNumber(path: string): number {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos, this.pos + 400));
    if (m === null) this.fail("invalid number");
    this.pos += m[0].length;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) {
      this.errors.push({ code: "E_NONFINITE", path, detail: `${m[0]} is not a finite binary64 value` });
      return 0;
    }
    return value;
  }

  private skipWs(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) this.fail(`expected '${ch}'`);
    this.pos++;
  }

  private fail(detail: string): never {
    throw new ContractViolation([{ code: "E_JSON_SYNTAX", path: "", detail: `${detail} at offset ${this.pos}` }]);
  }
}
