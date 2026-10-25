// WebGPU device access through dawn.node, plus the byte-counting allocator behind the
// gpu_bytes_peak metric (design D12-A: WebGPU has no VRAM query, so we count what we allocate).

import { create, globals } from "webgpu";

let globalsInstalled = false;

export interface AdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export class Gpu {
  readonly device: GPUDevice;
  readonly adapter: AdapterIdentity;
  // dawn.node tears down the instance when the GPU object is collected, which crashes any device
  // created from it, so the instance is kept alive for as long as the device.
  private readonly instance: GPU;
  private live = 0;
  private peak = 0;
  private readonly sizes = new Map<GPUBuffer, number>();
  private readonly uncaptured: string[] = [];
  // Compiled pipelines by (entry point, constants, source). Compilation is deterministic, so reusing
  // one changes no output; it removes the per-render compile (11 ms of a P0 render on lavapipe).
  private readonly pipelines = new Map<string, Promise<GPUComputePipeline>>();

  constructor(instance: GPU, device: GPUDevice, adapter: AdapterIdentity) {
    this.instance = instance;
    this.device = device;
    this.adapter = adapter;
    device.addEventListener("uncapturederror", (ev) => {
      this.uncaptured.push((ev as GPUUncapturedErrorEvent).error.message);
    });
  }

  get bytesPeak(): number {
    return this.peak;
  }

  /** Start a new peak window (one per run) without forgetting buffers that are still live. */
  resetPeak(): void {
    this.peak = this.live;
  }

  buffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    // Storage bindings must be non-empty; round up to the 16-byte binding granularity.
    const bytes = Math.max(16, Math.ceil(size / 16) * 16);
    const buf = this.device.createBuffer({ size: bytes, usage, label });
    this.sizes.set(buf, bytes);
    this.live += bytes;
    this.peak = Math.max(this.peak, this.live);
    return buf;
  }

  bufferWith(data: ArrayBufferView, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const buf = this.buffer(data.byteLength, usage | GPUBufferUsage.COPY_DST, label);
    if (data.byteLength > 0) this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
  }

  release(buf: GPUBuffer): void {
    const bytes = this.sizes.get(buf);
    if (bytes === undefined) return;
    this.sizes.delete(buf);
    this.live -= bytes;
    buf.destroy();
  }

  pipeline(code: string, label: string, constants: Record<string, number> = {}, entryPoint = "main"): Promise<GPUComputePipeline> {
    const key = `${entryPoint}\u0000${JSON.stringify(Object.entries(constants).sort())}\u0000${code}`;
    let p = this.pipelines.get(key);
    if (p === undefined) {
      p = this.compile(code, label, constants, entryPoint);
      this.pipelines.set(key, p);
    }
    return p;
  }

  private async compile(code: string, label: string, constants: Record<string, number>, entryPoint: string): Promise<GPUComputePipeline> {
    this.device.pushErrorScope("validation");
    const module = this.device.createShaderModule({ code, label });
    const pipeline = this.device.createComputePipeline({ layout: "auto", label, compute: { module, entryPoint, constants } });
    const err = await this.device.popErrorScope();
    if (err !== null) {
      const info = await module.getCompilationInfo();
      const msgs = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`).join("\n");
      throw new Error(`pipeline ${label}: ${err.message}\n${msgs}`);
    }
    return pipeline;
  }

  async read(buf: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const staging = this.buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "readback");
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, staging, 0, Math.ceil(size / 4) * 4);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange(0, Math.ceil(size / 4) * 4).slice(0, size);
    staging.unmap();
    this.release(staging);
    this.throwIfErrors();
    return copy;
  }

  throwIfErrors(): void {
    if (this.uncaptured.length > 0) throw new Error(`WebGPU errors: ${this.uncaptured.join("; ")}`);
  }

  destroy(): void {
    this.device.destroy();
  }
}

export async function openGpu(): Promise<Gpu> {
  if (!globalsInstalled) {
    Object.assign(globalThis, globals);
    globalsInstalled = true;
  }
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error("no WebGPU adapter (on Linux, is a Vulkan ICD such as lavapipe installed?)");
  const info = adapter.info;
  const identity = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  const device = await adapter.requestDevice();
  return new Gpu(gpu, device, identity);
}

/** Bindings 0..n-1 in order. */
export function bindGroup(gpu: Gpu, pipeline: GPUComputePipeline, buffers: GPUBuffer[]): GPUBindGroup {
  return gpu.device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
}

/** Explicit binding numbers; with layout "auto" a pipeline only declares the bindings its entry point uses. */
export function bindGroupAt(gpu: Gpu, pipeline: GPUComputePipeline, entries: [number, GPUBuffer][]): GPUBindGroup {
  return gpu.device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
  });
}

export function dispatch(gpu: Gpu, pipeline: GPUComputePipeline, bg: GPUBindGroup, workgroups: number): void {
  const enc = gpu.device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(pipeline);
  cp.setBindGroup(0, bg);
  cp.dispatchWorkgroups(workgroups);
  cp.end();
  gpu.device.queue.submit([enc.finish()]);
}
