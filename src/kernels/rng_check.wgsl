// G04: evaluates rng4 and to_unit_float for a list of (seed, stream, counter) inputs so the host
// can compare them bit for bit with src/core/rng.ts.

struct Input {
  ctr: vec4<u32>,
  key: vec4<u32>, // seed, stream, unused, unused
}

@group(0) @binding(0) var<storage, read> inputs: array<Input>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> unit_bits: array<vec4<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  let r = rng4(inputs[i].key.x, inputs[i].key.y, inputs[i].ctr);
  outputs[i] = r;
  unit_bits[i] = vec4<u32>(
    bitcast<u32>(to_unit_float(r.x)),
    bitcast<u32>(to_unit_float(r.y)),
    bitcast<u32>(to_unit_float(r.z)),
    bitcast<u32>(to_unit_float(r.w)));
}
