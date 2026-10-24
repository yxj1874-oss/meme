// The only module allowed to read a clock (tools/lint.ts). Its readings go to manifest.perf, which
// no determinism check ever compares.

export function nowMs(): number {
  return performance.now();
}
