// Float-behaviour probe (design §3.2 FBH). Evaluates a fixed battery of operations whose results the
// WGSL spec leaves implementation-defined: rounding direction (§15.7.2), fusion and reassociation
// (§15.7.5), builtin accuracy (§15.7.4.1), flush-to-zero. The host hashes the result bits into the
// substrate fingerprint. Inputs come from a buffer so nothing can be constant-folded.

struct Triple {
  a: f32,
  b: f32,
  c: f32,
  pad: f32,
}

@group(0) @binding(0) var<storage, read> inputs: array<Triple>;
@group(0) @binding(1) var<storage, read_write> outputs: array<u32>;

const N_OUT: u32 = 12u;
const PI: f32 = 3.14159265358979323846;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  let a = inputs[i].a;
  let b = inputs[i].b;
  let c = inputs[i].c;
  let base = i * N_OUT;
  outputs[base + 0u] = bitcast<u32>(a * b + c);
  outputs[base + 1u] = bitcast<u32>((a + b) + c);
  outputs[base + 2u] = bitcast<u32>(a / (abs(b) + 1.0));
  outputs[base + 3u] = bitcast<u32>(sqrt(abs(a)));
  outputs[base + 4u] = bitcast<u32>(inverseSqrt(abs(a) + 1.0));
  outputs[base + 5u] = bitcast<u32>(exp2(clamp(a, -20.0, 20.0)));
  outputs[base + 6u] = bitcast<u32>(log2(abs(a) + 1.0));
  outputs[base + 7u] = bitcast<u32>(sin(clamp(a, -PI, PI)));
  outputs[base + 8u] = bitcast<u32>(cos(clamp(a, -PI, PI)));
  outputs[base + 9u] = bitcast<u32>(pow(abs(a) + 1.0, clamp(b, -4.0, 4.0)));
  outputs[base + 10u] = bitcast<u32>(normalize(vec3<f32>(a, b, c) + vec3<f32>(1.0, 0.0, 0.0)).x);
  // a * 2^-140 is subnormal for |a| < 2^14; scaling back up shows whether it was flushed.
  outputs[base + 11u] = bitcast<u32>((a * 0x1p-140f) * 0x1p100f);
}
