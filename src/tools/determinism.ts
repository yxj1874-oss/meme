// --determinism-check (design §3.7): two fresh processes (P0 has no result cache to bypass), one also
// repeating the run in-process; every deterministic output and manifest.deterministic must match
// byte for byte. On a mismatch the first differing byte is mapped back to a pixel, body or
// JSON offset and a difference heatmap is written.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { jcs } from "../core/jcs.ts";
import { decodePfm } from "../io/pfm.ts";
import { encodePngRgb8 } from "../io/png.ts";
import { BODY_BYTES } from "../runtime/physics.ts";
import { readManifest, readRunFiles } from "./io.ts";

export interface Divergence {
  file: string;
  offset: number;
  where: string;
}

export function compareRuns(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): Divergence[] {
  const out: Divergence[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name);
    const y = b.get(name);
    if (x === undefined || y === undefined) {
      out.push({ file: name, offset: -1, where: x === undefined ? "missing in first run" : "missing in second run" });
      continue;
    }
    const n = Math.min(x.length, y.length);
    let i = 0;
    while (i < n && x[i] === y[i]) i++;
    if (i === n && x.length === y.length) continue;
    out.push({ file: name, offset: i, where: locate(name, x, i) });
  }
  return out;
}

function locate(name: string, bytes: Uint8Array, offset: number): string {
  if (name.endsWith(".pfm")) {
    const header = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
    const m = /^PF\n(\d+) (\d+)\n-?[0-9.]+\n/.exec(header);
    if (m !== null && offset >= m[0].length) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const word = Math.floor((offset - m[0].length) / 4);
      const row = Math.floor(word / (w * 3));
      return `pixel x=${Math.floor((word % (w * 3)) / 3)} y=${h - 1 - row} channel=${word % 3}`;
    }
  }
  if (name.startsWith("state/") && name.endsWith(".bin")) {
    const field = ["x.lo", "x.lo", "x.lo", "flags", "x.hi", "x.hi", "x.hi", "inv_mass", "v", "v", "v", "pad"][Math.floor((offset % BODY_BYTES) / 4)];
    return `body rank ${Math.floor(offset / BODY_BYTES)} field ${field}`;
  }
  if (name === "aov.id.u32") return `id pixel index ${Math.floor(offset / 4)}`;
  return `byte ${offset}`;
}

export function heatmap(a: Uint8Array, b: Uint8Array): Uint8Array | undefined {
  const x = decodePfm(a);
  const y = decodePfm(b);
  if (x.width !== y.width || x.height !== y.height) return undefined;
  const rgb = new Uint8Array(x.width * x.height * 3);
  for (let p = 0; p < x.width * x.height; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(x.rgb[p * 3 + c]! - y.rgb[p * 3 + c]!));
    // log scale: 1e-9 -> dark, 1 -> white; exact equality stays black
    const v = d === 0 ? 0 : Math.min(255, Math.max(16, Math.round(((Math.log10(d) + 9) / 9) * 255)));
    rgb.set([v, d === 0 ? 0 : v >> 2, 0], p * 3);
  }
  return encodePngRgb8(x.width, x.height, rgb);
}

export interface DeterminismReport {
  pass: boolean;
  divergences: Divergence[];
  manifest_equal: boolean;
}

export function determinismCheck(cli: string, scenePath: string, workDir: string, extraArgs: string[] = []): DeterminismReport {
  mkdirSync(workDir, { recursive: true });
  const dirs = [join(workDir, "a"), join(workDir, "b")];
  dirs.forEach((dir, i) => {
    const args = [cli, "run", scenePath, "--out", dir, ...(i === 0 ? ["--repeat-in-process"] : []), ...extraArgs];
    const r = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`run ${i + 1} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  });
  const [fa, fb] = dirs.map((d) => readRunFiles(d)) as [Map<string, Uint8Array>, Map<string, Uint8Array>];
  const divergences = compareRuns(fa, fb);
  const manifestEqual = jcs(readManifest(dirs[0]!).deterministic) === jcs(readManifest(dirs[1]!).deterministic);
  const report: DeterminismReport = { pass: divergences.length === 0 && manifestEqual, divergences, manifest_equal: manifestEqual };
  writeFileSync(join(workDir, "nondet_report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const pa = fa.get("image.linear.pfm");
  const pb = fb.get("image.linear.pfm");
  if (!report.pass && pa !== undefined && pb !== undefined) {
    const png = heatmap(pa, pb);
    if (png !== undefined) writeFileSync(join(workDir, "diff_heatmap.png"), png);
  }
  return report;
}
