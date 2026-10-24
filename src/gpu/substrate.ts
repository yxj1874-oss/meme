// Substrate fingerprint (design §3.2): everything below our code that can change result bits.
// substrate_id = JCS hash of the fingerprint. Goldens are byte-comparable only within one id.

import { readFileSync } from "node:fs";
import { cpus } from "node:os";

import { jcsHash, sha256Tag } from "../core/hash.ts";
import { rng4, STREAM, toUnitFloat } from "../core/rng.ts";
import { bindGroup, type Gpu } from "./device.ts";
import { kernelSource } from "./kernels.ts";

export interface FbhResult {
  fbh: string;
  /** Share of a*b+c results equal to separately rounded multiply then add (CPU reference). */
  unfused_match: number;
  /** Share equal to a single rounding of the exact a*b+c. */
  fused_match: number;
  ftz_detected: boolean;
}

export interface Substrate {
  adapter: Gpu["adapter"];
  dawn_node: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  /** Diagnostic only, not part of substrate_id: lavapipe output is expected to depend on the ISA
   *  and the JIT, not the CPU model; if it ever does, FBH changes and says so. */
  cpu: string;
  /** sha256 of ci/Dockerfile (ci/run-in-ref.sh), null outside the reference container. */
  image_spec: string | null;
  env: Record<string, string>;
  fbh: FbhResult;
}

const FBH_N = 1 << 16;
const FBH_OUT = 12;

export async function probeFbh(gpu: Gpu): Promise<FbhResult> {
  // Fixed probe inputs (stream 6, fixed key seed): signed values with exponents spread over 2^-20..2^20.
  const inputs = new Float32Array(FBH_N * 4);
  for (let i = 0; i < FBH_N; i++) {
    for (let k = 0; k < 3; k++) {
      const r = rng4(0x46424821, STREAM.SUBSTRATE_PROBE, i, k, 0, 0);
      inputs[i * 4 + k] = (2 * toUnitFloat(r[0]) - 1) * 2 ** ((r[1] % 41) - 20);
    }
  }
  const U = GPUBufferUsage;
  const inBuf = gpu.bufferWith(inputs, U.STORAGE, "fbh inputs");
  const outBuf = gpu.buffer(FBH_N * FBH_OUT * 4, U.STORAGE | U.COPY_SRC, "fbh outputs");
  const pipeline = await gpu.pipeline(kernelSource("probe_fbh"), "probe_fbh");
  const enc = gpu.device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(pipeline);
  cp.setBindGroup(0, bindGroup(gpu, pipeline, [inBuf, outBuf]));
  cp.dispatchWorkgroups(FBH_N / 64);
  cp.end();
  gpu.device.queue.submit([enc.finish()]);
  const out = new Uint32Array(await gpu.read(outBuf, FBH_N * FBH_OUT * 4));
  gpu.release(inBuf);
  gpu.release(outBuf);

  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  let unfused = 0;
  let fused = 0;
  let ftz = false;
  for (let i = 0; i < FBH_N; i++) {
    const a = inputs[i * 4]!;
    const b = inputs[i * 4 + 1]!;
    const c = inputs[i * 4 + 2]!;
    f[0] = Math.fround(Math.fround(a * b) + c);
    if (u[0] === out[i * FBH_OUT]) unfused++;
    f[0] = a * b + c; // f32 x f32 is exact in f64; one rounding of the sum, then one to f32
    if (u[0] === out[i * FBH_OUT]) fused++;
    if (Math.abs(a) < 2 ** 14 && Math.abs(a) > 2 ** -8 && out[i * FBH_OUT + 11] === 0) ftz = true;
  }
  return { fbh: sha256Tag(new Uint8Array(out.buffer)), unfused_match: unfused / FBH_N, fused_match: fused / FBH_N, ftz_detected: ftz };
}

function cpuDescription(): string {
  if (process.platform === "linux") {
    const info = readFileSync("/proc/cpuinfo", "utf8");
    const features = /^(?:Features|flags)\s*:\s*(.*)$/m.exec(info)?.[1] ?? "";
    const part = /^CPU part\s*:\s*(.*)$/m.exec(info)?.[1] ?? cpus()[0]?.model ?? "";
    return `${part.trim()} | ${features.trim().split(/\s+/).sort().join(" ")}`;
  }
  return cpus()[0]?.model ?? "unknown";
}

export async function fingerprint(gpu: Gpu): Promise<Substrate> {
  const dawn = JSON.parse(readFileSync(new URL("../../node_modules/webgpu/package.json", import.meta.url), "utf8")) as { version: string };
  const env: Record<string, string> = {};
  for (const k of Object.keys(process.env).sort()) {
    if (/^(GALLIVM_|MESA_|VK_|LIBGL_|DAWN_)/.test(k) || (k.startsWith("LP_") && k !== "LP_NUM_THREADS")) env[k] = process.env[k]!;
  }
  return {
    adapter: gpu.adapter,
    dawn_node: dawn.version,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpu: cpuDescription(),
    image_spec: process.env["MEME_IMAGE_SPEC"] ?? null,
    env,
    fbh: await probeFbh(gpu),
  };
}

export function substrateId(s: Substrate): string {
  const { cpu: _diagnostic, ...identity } = s;
  return jcsHash(identity);
}
