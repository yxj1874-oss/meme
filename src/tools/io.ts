// Writing and reading run directories.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { Manifest, RunOutput } from "../runtime/run.ts";

export function writeRun(dir: string, out: RunOutput): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, bytes] of out.files) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(out.manifest, null, 2)}\n`);
}

export function readRunFiles(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name !== "manifest.json") out.set(relative(dir, p), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}
