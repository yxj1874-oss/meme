// Unconstrained XPBD step (Macklin, Müller, Chentanez, "XPBD: Position-Based Simulation of Compliant
// Constrained Dynamics", MIG 2016, Alg. 1, with zero constraints), in delta form:
//   dx = dt*v + dt^2*g;   x += dx;   v = dx * (1/dt)
// Alg. 1 derives v = (x_new - x_old) / dt; with f32 positions that subtraction loses ulp(x)/dt of
// velocity (98 m/s at |x| = 1e4 m, dt = 1e-5 s). Positions here are Q31.32 fixed point (design D15-A),
// so the update is an exact integer add and dx never meets a large number in floating point.
// Mass does not enter: gravity is an acceleration (golden G16 A5).

override FAULT_KIND: u32 = 0u; // 0 none, 3 NaN bits into v[FAULT_C] of body FAULT_BODY after step FAULT_STEP
override FAULT_BODY: u32 = 0u;
override FAULT_STEP: u32 = 0u;
override FAULT_C: u32 = 0u;

struct Body {
  xq_lo: vec3<u32>, // position, low 32 bits of Q31.32 metres
  flags: u32,
  xq_hi: vec3<i32>, // position, high 32 bits (signed whole metres)
  inv_mass: f32,
  v: vec3<f32>,
  pad: u32,
}

struct StepParams {
  g_dt2: vec4<f32>, // g * dt^2, dt
  inv_dt: vec4<f32>,
  counts: vec4<u32>, // body count, steps in this dispatch, index of the first step, NaN bits for faults
}

@group(0) @binding(0) var<uniform> Q: StepParams;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;

const TWO_POW_32: f32 = 4294967296.0;

// x + dx in Q31.32. dx splits into trunc(dx) and dx - trunc(dx); both are exact in f32 and the
// fraction keeps the sign of dx, so small negative steps lose nothing (floor() would turn -1e-6 into
// -1 + (1 - 1e-6) and round the fraction at ulp(1)). |fraction| * 2^32 is an exact power-of-two
// scaling truncated toward zero (WGSL §15.7.6), at most one quantum q = 2^-32 m per step. The add or
// subtract then carries or borrows exactly in integers.
fn add_fixed(lo: vec3<u32>, hi: vec3<i32>, dx: vec3<f32>, out_lo: ptr<function, vec3<u32>>, out_hi: ptr<function, vec3<i32>>) {
  let whole = trunc(dx);
  let frac = dx - whole;
  let mag = vec3<u32>(abs(frac) * TWO_POW_32);
  let neg = frac < vec3<f32>(0.0);
  let sum = lo + mag;
  let diff = lo - mag;
  let carry = select(vec3<i32>(0), vec3<i32>(1), sum < lo);
  let borrow = select(vec3<i32>(0), vec3<i32>(1), lo < mag);
  *out_lo = select(sum, diff, neg);
  *out_hi = hi + vec3<i32>(whole) + select(carry, -borrow, neg);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  var b = bodies[i];
  for (var k = 0u; k < Q.counts.y; k++) {
    let dx = Q.g_dt2.w * b.v + Q.g_dt2.xyz;
    var lo: vec3<u32>;
    var hi: vec3<i32>;
    add_fixed(b.xq_lo, b.xq_hi, dx, &lo, &hi);
    b.xq_lo = lo;
    b.xq_hi = hi;
    b.v = dx * Q.inv_dt.x;
    if (FAULT_KIND == 3u && i == FAULT_BODY && Q.counts.z + k + 1u == FAULT_STEP) {
      // The NaN comes from the uniform: a NaN const-expression is a shader-creation error (§15.7.2).
      b.v[FAULT_C] = bitcast<f32>(Q.counts.w);
    }
  }
  bodies[i] = b;
}
