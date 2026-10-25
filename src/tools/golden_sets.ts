// Golden corpora live in golden/<set>/<gid>/ (p0 bound to schema v1, p1 to v2, ...). Golden ids are
// unique across sets, so a gid (or its gNN prefix) is enough to find one.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const GOLDEN_ROOT = join(ROOT, "golden");

export interface GoldenRef {
  set: string;
  id: string;
  dir: string;
}

export function allGoldens(root = GOLDEN_ROOT): GoldenRef[] {
  const out: GoldenRef[] = [];
  for (const set of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const g of readdirSync(join(root, set), { withFileTypes: true })) {
      if (g.isDirectory() && existsSync(join(root, set, g.name, "oracle.json"))) out.push({ set, id: g.name, dir: join(root, set, g.name) });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function resolveGolden(idOrPrefix: string, root = GOLDEN_ROOT): GoldenRef | undefined {
  return allGoldens(root).find((g) => g.id === idOrPrefix || g.id.startsWith(`${idOrPrefix}_`));
}
