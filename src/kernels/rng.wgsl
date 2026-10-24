// Philox4x32-10 (Salmon et al., SC'11, §3.3). Mirrors src/core/rng.ts bit for bit: WGSL integer
// arithmetic wraps modulo 2^32 exactly (WGSL §6.2.3), so this is the one part of the runtime that is
// identical on every conforming implementation (golden G04 A4).

const PHILOX_M0: u32 = 0xD2511F53u;
const PHILOX_M1: u32 = 0xCD9E8D57u;
const PHILOX_W0: u32 = 0x9E3779B9u;
const PHILOX_W1: u32 = 0xBB67AE85u;

const STREAM_SAMPLING: u32 = 0u;

fn mulhi32(a: u32, b: u32) -> u32 {
  let al = a & 0xffffu;
  let ah = a >> 16u;
  let bl = b & 0xffffu;
  let bh = b >> 16u;
  let ll = al * bl;
  let lh = al * bh;
  let hl = ah * bl;
  let hh = ah * bh;
  let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
  return hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
}

fn philox4x32_10(ctr: vec4<u32>, key: vec2<u32>) -> vec4<u32> {
  var c = ctr;
  var k = key;
  for (var r = 0u; r < 10u; r++) {
    if (r > 0u) {
      k = k + vec2<u32>(PHILOX_W0, PHILOX_W1);
    }
    let hi0 = mulhi32(PHILOX_M0, c.x);
    let lo0 = PHILOX_M0 * c.x;
    let hi1 = mulhi32(PHILOX_M1, c.z);
    let lo1 = PHILOX_M1 * c.z;
    c = vec4<u32>(hi1 ^ c.y ^ k.x, lo1, hi0 ^ c.w ^ k.y, lo0);
  }
  return c;
}

// rng(stream, counter) with key = (seed, stream); scene.schema.json x-rng-streams.
fn rng4(seed: u32, stream: u32, ctr: vec4<u32>) -> vec4<u32> {
  return philox4x32_10(ctr, vec2<u32>(seed, stream));
}

// 24 random bits scaled by 2^-24: both steps are exact in f32, so the result is the same everywhere.
fn to_unit_float(u: u32) -> f32 {
  return f32(u >> 8u) * 0x1p-24f;
}
