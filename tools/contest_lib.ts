// Candidate contests (design mechanism ①): shared by tools/contest.ts (P1 rendering sets) and
// tools/contest_p2.ts (P2 physics sets). Each candidate is scored on error, variance, ms,
// robustness (failure rate on randomly perturbed inputs) and lines of code. A candidate with a
// non-zero failure rate is disqualified; the others not dominated on all five form the Pareto front.
// Differences the measurement cannot resolve (an error below its statistical floor, variance or ms
// within their noise) count as ties, so the front is not decided by noise.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Gpu } from "../src/gpu/device.ts";
import type { Substrate } from "../src/gpu/substrate.ts";
import { nowMs } from "../src/perf/clock.ts";

export const ROOT = new URL("../", import.meta.url).pathname;

export interface Score {
  candidate: string;
  value: number;
  error: number;
  variance: number;
  ms: number;
  failure_rate: number;
  loc: number;
  /** Smallest error the benchmark resolves (5 sigma); errors below it are compared as equal. */
  errorFloor: number;
  /** Half-widths below which variance and ms differences are noise. */
  noise: { variance: number; ms: number };
  notes: string[];
}

export interface ContestSet {
  id: string;
  title: string;
  /** Override constant that selects the candidate, and the kernels that switch on it. */
  override: string;
  files: string[];
  defaultValue: number;
  candidates: { value: number; name: string; source: string }[];
  measures: { error: string; variance: string; ms: string; robustness: string };
  run: (gpu: Gpu, substrate: Substrate, value: number) => Promise<Omit<Score, "candidate" | "value" | "loc">>;
}

// --- Lines of code per candidate (brace matching over the WGSL) --------------------------------

function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Lines a candidate executes in every function that switches on `name`: its own `if (name == v)` block, or the fall-through code when it has none. */
export function locOf(files: string[], name: string, value: number): number {
  let total = 0;
  for (const f of files) {
    const lines = readFileSync(join(ROOT, "src", "kernels", f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^fn /.test(lines[i]!)) continue;
      const end = blockEnd(lines, i);
      const body = lines.slice(i, end + 1);
      const ifs = body.map((l, j) => [l, j] as const).filter(([l]) => new RegExp(`if \\(${name} == (\\d+)u\\)`).test(l));
      if (ifs.length === 0) continue;
      // The chain is inside the innermost block that holds the first `if`.
      let open = ifs[0]![1] - 1;
      let depth = 0;
      for (; open > 0; open--) {
        for (const ch of [...body[open]!].reverse()) {
          if (ch === "}") depth++;
          if (ch === "{") depth--;
        }
        if (depth < 0) break;
      }
      const scopeEnd = blockEnd(body, open);
      let own = 0;
      let chain = 0;
      for (const [l, j] of ifs) {
        const n = blockEnd(body, j) - j + 1;
        chain += n;
        if (Number(new RegExp(`${name} == (\\d+)u`).exec(l)![1]) === value) own += n;
      }
      total += own > 0 ? own : scopeEnd - open - 1 - chain;
    }
  }
  return total;
}

// --- Measurement helpers -----------------------------------------------------------------------

export const REPEATS = 5;

/** Median of REPEATS timed calls after a warm-up, and their spread (max - min) as the noise. */
export async function timeIt<T>(f: () => Promise<T>): Promise<{ ms: number; spread: number; out: T }> {
  const out = await f();
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = nowMs();
    await f();
    times.push(nowMs() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: times[REPEATS >> 1]!, spread: times.at(-1)! - times[0]!, out };
}

/** 5 standard errors of a sample variance from n draws (Gaussian approximation, 2 / (n - 1) relative). */
export const varianceNoise = (v: number, n: number) => 5 * v * Math.sqrt(2 / (n - 1));

// --- Scoring and reports -----------------------------------------------------------------------

/**
 * Per measure, b against a: -1 better, 0 tie, 1 worse. Errors are compared after raising each to its
 * floor; variance and ms differences within the summed noise are ties; robustness and LOC are exact.
 */
function compare(b: Score, a: Score, key: "error" | "variance" | "ms" | "failure_rate" | "loc"): number {
  if (key === "error") return Math.sign(Math.max(b.error, b.errorFloor) - Math.max(a.error, a.errorFloor));
  if (key === "variance" || key === "ms") {
    const d = b[key] - a[key];
    return Math.abs(d) <= b.noise[key] + a.noise[key] || !Number.isFinite(d) && b[key] === a[key] ? 0 : Math.sign(d);
  }
  return Math.sign(b[key] - a[key]);
}

const KEYS = ["error", "variance", "ms", "failure_rate", "loc"] as const;
const dominates = (b: Score, a: Score) => KEYS.every((k) => compare(b, a, k) <= 0) && KEYS.some((k) => compare(b, a, k) < 0);

/**
 * A candidate that breaks an invariant on any perturbed input (non-zero failure rate: reciprocity,
 * energy, non-finite output) is disqualified; the Pareto front is taken over the rest.
 */
function pareto(scores: Score[]): Set<number> {
  const valid = scores.map((s) => s.failure_rate === 0);
  const front = new Set<number>();
  scores.forEach((a, i) => {
    if (valid[i] && !scores.some((b, j) => j !== i && valid[j] && dominates(b, a))) front.add(i);
  });
  return front;
}

export const fmt = (x: number) => (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e4 ? x.toFixed(4) : x.toExponential(2));

/** Runs every set (or the ones named on the command line) and writes <outDir>/<set>/REPORT.md and results.json. */
export async function runContests(sets: ContestSet[], outDir: string, gpu: Gpu, substrate: Substrate, tool: string): Promise<void> {
  const only = process.argv.slice(2);
  for (const set of sets.filter((s) => only.length === 0 || only.includes(s.id))) {
    const scores: Score[] = [];
    for (const c of set.candidates) {
      const s = await set.run(gpu, substrate, c.value);
      for (const k of ["error", "variance", "ms"] as const) {
        if (!Number.isFinite(s[k])) {
          s.notes.push(`${k} is not finite (non-finite pixels or estimates): scored as infinity`);
          s[k] = Infinity;
          if (k !== "error") s.noise[k] = Infinity;
        }
      }
      scores.push({ ...s, candidate: c.name, value: c.value, loc: locOf(set.files, set.override, c.value) });
      console.log(`${set.id} ${c.name}: error ${fmt(s.error)} variance ${fmt(s.variance)} ms ${s.ms.toFixed(1)} failures ${s.failure_rate.toFixed(3)}`);
    }
    const front = pareto(scores);
    const dir = join(outDir, set.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), `${JSON.stringify({ set: set.id, substrate: substrate.adapter.description, measures: set.measures, scores, pareto: [...front].map((i) => scores[i]!.candidate) }, null, 2)}\n`);
    const lines = [
      `# ${set.title}`,
      "",
      `Override \`${set.override}\`, runtime default ${set.candidates.find((c) => c.value === set.defaultValue)!.name}. Measured on ${substrate.adapter.description} by \`${tool}\`; numbers are reproducible (seeded inputs) except ms, the median of ${REPEATS} runs with their spread. An error below its floor, or a variance or ms difference within the summed noise, counts as a tie.`,
      "",
      "| Candidate | Error (floor) | Variance (± noise) | ms (± spread) | Failure rate | LOC | Pareto | Source |",
      "|---|---|---|---|---|---|---|---|",
      ...scores.map((s, i) => `| ${s.candidate} | ${fmt(s.error)} (${fmt(s.errorFloor)}) | ${fmt(s.variance)} (± ${fmt(s.noise.variance)}) | ${s.ms.toFixed(1)} (± ${s.noise.ms.toFixed(1)}) | ${s.failure_rate.toFixed(3)} | ${s.loc} | ${front.has(i) ? "yes" : "no"} | ${set.candidates[i]!.source} |`),
      "",
      "Measures:",
      `- Error: ${set.measures.error}`,
      `- Variance: ${set.measures.variance}`,
      `- ms: ${set.measures.ms}`,
      `- Robustness: ${set.measures.robustness}`,
      "",
      "Notes:",
      ...scores.map((s) => `- ${s.candidate}: ${s.notes.join("; ")}`),
      "",
      "Dropped (not on the Pareto front):",
      ...scores.filter((_, i) => !front.has(i)).map((s) => {
        if (s.failure_rate > 0) return `- ${s.candidate}: disqualified, breaks an invariant on ${(s.failure_rate * 100).toFixed(1)}% of perturbed inputs (${s.notes.join("; ")})`;
        const better = scores.find((b, j) => front.has(j) && dominates(b, s))!;
        return `- ${s.candidate}: dominated by ${better.candidate} (better on ${KEYS.filter((k) => compare(better, s, k) < 0).join(", ")}, no worse elsewhere)`;
      }),
      ...(scores.every((_, i) => front.has(i)) ? ["- none"] : []),
      "",
    ];
    writeFileSync(join(dir, "REPORT.md"), `${lines.join("\n")}\n`);
  }
}
