// XPBD rigid spheres (design P2-01): Müller, Macklin, Chentanez, Jeschke, Kim, "Detailed Rigid Body
// Simulation with Extended Position Based Dynamics", SCA 2020, with substeps of one iteration each
// (Macklin et al., "Small Steps in Physics Simulation", SCA 2019), solved in parallel as Jacobi with
// mass splitting (Tonge, Benevolenski, Voroshilov, SIGGRAPH 2012; decision H1 in docs/P2-02: plain
// Jacobi diverges on bodies carrying several joints, contest candidates/p2/c_solver).
//
// Positions are Q31.32 fixed point (design D15-A): differences between bodies are exact integer
// subtractions, rounded to f32 once. Velocities follow the delta form of P0,
//   dx = h*v + g*h^2;   x += dx + dx_corr;   v = (dx + dx_corr) * (1/h),
// never a difference of two large positions. Without contacts and joints dx_corr is never added
// and the arithmetic is the P0 kernel's, operation for operation (design P2D5, golden G46).
//
// Determinism (design §3.4): each pass reads only what the previous pass wrote; every body gathers
// its own corrections in canonical order and writes only its own record; a pair is always evaluated
// with the lower body index as "a", so both bodies compute bit-identical multipliers. No atomics.
//
// Entry points:
//   translate_main bodies without contacts, joints or rotation: k substeps in one dispatch (the P0 loop)
//   free_main      the same with orientation
//   predict_main   x~ = x + dx, q~ = q advanced by omega
//   count_main     active constraints per body at x~ (mass splitting and averaging only)
//   solve_main     positional constraints -> x, q, v, omega
//   velocity_main  restitution and dynamic friction at velocity level -> v_out, w_out
//   commit_main    v = v_out, omega = w_out

// Fault injection for validator negative controls (goldens G15, G44). Defaults are inert.
override FAULT_KIND: u32 = 0u; // 0 none; 3 NaN bits into v[FAULT_C] of body FAULT_BODY after step FAULT_STEP (free_main);
                               // 5 NaN bits into q[FAULT_C] of body FAULT_BODY in the substep flagged by the host (commit/solve)
override FAULT_BODY: u32 = 0u;
override FAULT_STEP: u32 = 0u;
override FAULT_C: u32 = 0u;
override RESTITUTION_GAIN: f32 = 1.0; // negative control for V-Energy: > 1 creates energy at every bounce
// Candidates (design §3.5); the defaults are the runtime's choice.
override SOLVER: u32 = 0u;      // 0 Jacobi with mass splitting (decision H1), 1 plain Jacobi, 2 Jacobi averaged by constraint count
override FRICTION: u32 = 0u;    // 0 positional static + velocity dynamic (Müller 2020), 1 velocity-level Coulomb
override RESTITUTION_THRESHOLD: u32 = 0u; // 0 e = 0 when |v_n| <= 2|g|h (Müller 2020), 1 no threshold
override QUAT: u32 = 1u;        // 0 q + h/2 [w,0] q, normalized; 1 exact exponential map (decision H2)

const NONE: u32 = 0xffffffffu;
const TWO_POW_32: f32 = 4294967296.0;
const TWO_POW_M32: f32 = 2.3283064365386963e-10;
const JOINT_DISTANCE: u32 = 0u;
const JOINT_BALL: u32 = 1u;
const JOINT_HINGE: u32 = 2u;
const JOINT_FIXED: u32 = 3u;
const STATIC_SPHERE: u32 = 0u;
const STATIC_PLANE: u32 = 1u;
// Below this length a direction is undefined; contact normals fall back to +z (design §3.4).
const DEGENERATE: f32 = 0x1p-20f;

struct Body {
  xq_lo: vec3<u32>, // position, low 32 bits of Q31.32 metres
  flags: u32,
  xq_hi: vec3<i32>, // position, high 32 bits (signed whole metres)
  inv_mass: f32,
  v: vec3<f32>,
  pad: u32,
}

struct BodyRot {
  q: vec4<f32>, // [x, y, z, w], body frame -> world frame
  w: vec3<f32>, // angular velocity, world frame
  pad: u32,
}

struct Pred {
  xq_lo: vec3<u32>, // predicted position x~
  n: u32,           // active constraints at x~ (mass splitting)
  xq_hi: vec3<i32>,
  pad0: u32,
  dx: vec3<f32>,    // free-flight displacement of this substep, h*v + g*h^2
  pad1: f32,
  q: vec4<f32>,     // predicted orientation q~
  q_prev: vec4<f32>,
  w_pre: vec3<f32>, // angular velocity before the position solve
  pad2: f32,
  v_out: vec3<f32>,
  pad3: f32,
  w_out: vec3<f32>,
  pad4: f32,
}

// Constant per body. The inverse mass is repeated here (it is also in Body for the state output)
// because passes that write bodies[] must not read other bodies' records.
struct Props {
  radius: f32,
  inv_mass: f32,
  inv_inertia: f32, // solid sphere: 5 / (2 m r^2)
  restitution: f32,
  mu_s: f32,
  mu_d: f32,
  n_joint: u32,     // joint constraints on this body (hinge and fixed count 2)
  j_start: u32,     // range of this body's joints in jlist
  j_count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

struct Static {
  pq_lo: vec3<u32>, // sphere center or plane point
  kind: u32,
  pq_hi: vec3<i32>,
  radius: f32,
  n: vec3<f32>,     // plane normal (unit, into free space)
  restitution: f32,
  mu_s: f32,
  mu_d: f32,
  pad0: u32,
  pad1: u32,
}

struct Joint {
  kind: u32,
  a: u32,           // body index or NONE (world)
  b: u32,
  pad0: u32,
  anchor_a: vec3<f32>, // body frame of a (unused for the world)
  rest: f32,
  anchor_b: vec3<f32>,
  compliance: f32,
  w_lo: vec3<u32>,  // world anchor of the end that is the world
  pad1: u32,
  w_hi: vec3<i32>,
  pad2: u32,
  axis_a: vec3<f32>,
  pad3: f32,
  axis_b: vec3<f32>,
  pad4: f32,
  q_rest: vec4<f32>, // fixed: conj(q_a0) * q_b0
}

struct Diag {
  max_disp_ratio: f32, // largest |displacement in a substep| / radius
  max_pen: f32,        // largest penetration seen at x~ (m)
  e_proj: f32,         // energy the position corrections may have injected (J), design P2D13
  e_bounce: f32,       // allowance for restitution measured on pre-solve velocities (J)
  contacts: u32,       // active contacts in the last substep
  max_speed: f32,      // largest |v| after a substep (m/s), for the f32 velocity precision check
  pad1: u32,
  pad2: u32,
}

struct StepParams {
  g_h2: vec4<f32>,   // g * h^2, h
  inv_h: vec4<f32>,  // 1/h, |g|, 2|g|h, unused
  counts: vec4<u32>, // body count, substeps in this dispatch (free_main), index of the first substep, NaN bits
  info: vec4<u32>,   // static count, contacts (0/1), substeps per step, fault flag for this substep
  g_h: vec4<f32>,    // g * h, unused
}

@group(0) @binding(0) var<uniform> Q: StepParams;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(2) var<storage, read_write> rot: array<BodyRot>;
@group(0) @binding(3) var<storage, read_write> pred: array<Pred>;
@group(0) @binding(4) var<storage, read> props: array<Props>;
@group(0) @binding(5) var<storage, read> statics: array<Static>;
@group(0) @binding(6) var<storage, read> joints: array<Joint>;
@group(0) @binding(7) var<storage, read> jlist: array<u32>;
@group(0) @binding(8) var<storage, read_write> diag: array<Diag>;

// --- Fixed point -----------------------------------------------------------------------------------

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

// (b - a) in metres: an exact 64-bit integer difference, rounded to f32 at the end.
fn fixed_diff(alo: vec3<u32>, ahi: vec3<i32>, blo: vec3<u32>, bhi: vec3<i32>) -> vec3<f32> {
  let lo = blo - alo;
  let borrow = select(vec3<i32>(0), vec3<i32>(1), blo < alo);
  let hi = bhi - ahi - borrow;
  return vec3<f32>(hi) + vec3<f32>(lo) * TWO_POW_M32;
}

// --- Quaternions [x, y, z, w] ------------------------------------------------------------------------

fn qmul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn qconj(q: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(-q.xyz, q.w);
}

fn qrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// q advanced by the rotation vector theta (world frame).
fn qadvance(q: vec4<f32>, theta: vec3<f32>) -> vec4<f32> {
  if (!any(theta != vec3<f32>(0.0))) {
    return q;
  }
  if (QUAT == 1u) {
    let angle = length(theta);
    let half = 0.5 * angle;
    let e = vec4<f32>(theta * (sin(half) / angle), cos(half));
    return normalize(qmul(e, q));
  }
  return normalize(q + 0.5 * qmul(vec4<f32>(theta, 0.0), q));
}

// --- Free flight (no contacts, no joints): the P0 loop ---------------------------------------------

// Bodies that neither rotate nor interact: the P0 kernel, without the orientation buffer.
@compute @workgroup_size(64)
fn translate_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  var b = bodies[i];
  for (var k = 0u; k < Q.counts.y; k++) {
    let dx = Q.g_h2.w * b.v + Q.g_h2.xyz;
    var lo: vec3<u32>;
    var hi: vec3<i32>;
    add_fixed(b.xq_lo, b.xq_hi, dx, &lo, &hi);
    b.xq_lo = lo;
    b.xq_hi = hi;
    b.v = dx * Q.inv_h.x;
    if (FAULT_KIND == 3u && i == FAULT_BODY && Q.counts.z + k + 1u == FAULT_STEP * Q.info.z) {
      // The NaN comes from the uniform: a NaN const-expression is a shader-creation error (§15.7.2).
      b.v[FAULT_C] = bitcast<f32>(Q.counts.w);
    }
  }
  bodies[i] = b;
}

// Free flight with orientation: some body starts spinning or rotated.

@compute @workgroup_size(64)
fn free_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  var b = bodies[i];
  var r = rot[i];
  let spinning = any(r.w != vec3<f32>(0.0));
  for (var k = 0u; k < Q.counts.y; k++) {
    let dx = Q.g_h2.w * b.v + Q.g_h2.xyz;
    var lo: vec3<u32>;
    var hi: vec3<i32>;
    add_fixed(b.xq_lo, b.xq_hi, dx, &lo, &hi);
    b.xq_lo = lo;
    b.xq_hi = hi;
    b.v = dx * Q.inv_h.x;
    if (spinning) {
      r.q = qadvance(r.q, Q.g_h2.w * r.w);
    }
    if (FAULT_KIND == 3u && i == FAULT_BODY && Q.counts.z + k + 1u == FAULT_STEP * Q.info.z) {
      // The NaN comes from the uniform: a NaN const-expression is a shader-creation error (§15.7.2).
      b.v[FAULT_C] = bitcast<f32>(Q.counts.w);
    }
  }
  bodies[i] = b;
  rot[i] = r;
}

// --- Contacts ------------------------------------------------------------------------------------------

struct Contact {
  hit: bool,
  n: vec3<f32>,  // unit normal from a to b
  pen: f32,      // penetration depth (> 0 when hit)
  ra: vec3<f32>, // contact point relative to a's center (world)
  rb: vec3<f32>, // relative to b's center (zero for planes)
}

// Sphere a against dynamic sphere b at the predicted positions; a < b by body index.
fn contact_dyn(a: u32, b: u32) -> Contact {
  let pa = pred[a];
  let pb = pred[b];
  let d = fixed_diff(pa.xq_lo, pa.xq_hi, pb.xq_lo, pb.xq_hi);
  let rsum = props[a].radius + props[b].radius;
  let dist = length(d);
  var c: Contact;
  c.hit = dist < rsum;
  c.pen = rsum - dist;
  c.n = select(d / max(dist, 1e-30), vec3<f32>(0.0, 0.0, 1.0), dist < DEGENERATE * rsum);
  c.ra = props[a].radius * c.n;
  c.rb = -props[b].radius * c.n;
  return c;
}

// Dynamic sphere a against static collider s (b is the static object).
fn contact_static(a: u32, s: u32) -> Contact {
  let pa = pred[a];
  let st = statics[s];
  let ra = props[a].radius;
  var c: Contact;
  if (st.kind == STATIC_PLANE) {
    let sd = dot(st.n, fixed_diff(st.pq_lo, st.pq_hi, pa.xq_lo, pa.xq_hi));
    c.hit = sd < ra;
    c.pen = ra - sd;
    c.n = -st.n;
    c.ra = ra * c.n;
    c.rb = vec3<f32>(0.0);
    return c;
  }
  let d = fixed_diff(pa.xq_lo, pa.xq_hi, st.pq_lo, st.pq_hi);
  let rsum = ra + st.radius;
  let dist = length(d);
  c.hit = dist < rsum;
  c.pen = rsum - dist;
  c.n = select(d / max(dist, 1e-30), vec3<f32>(0.0, 0.0, 1.0), dist < DEGENERATE * rsum);
  c.ra = ra * c.n;
  c.rb = -st.radius * c.n;
  return c;
}

// Effective inverse mass of a body in one constraint (design §3.3): mass splitting scales it by the
// body's active constraint count, plain and averaged Jacobi do not.
fn split(w: f32, n: u32) -> f32 {
  if (SOLVER == 0u) {
    return w * f32(max(n, 1u));
  }
  return w;
}

// Generalized inverse mass for a direction dir applied at offset r (solid sphere, isotropic inertia).
fn gen_w(inv_mass: f32, inv_inertia: f32, r: vec3<f32>, dir: vec3<f32>) -> f32 {
  let rn = cross(r, dir);
  return inv_mass + inv_inertia * dot(rn, rn);
}

struct Corr {
  dx: vec3<f32>,
  dth: vec3<f32>,
  lambda_n: f32, // normal multiplier (contacts), for the velocity pass and its friction bound
}

// Position-level response of one contact, seen from body `self` (`is_a`: self is the contact's a).
// The contact is evaluated identically by both bodies, so both get the same multipliers.
fn solve_contact(c: Contact, wa_inv: f32, ia_inv: f32, na: u32, wb_inv: f32, ib_inv: f32, nb: u32,
                 dxa: vec3<f32>, dxb: vec3<f32>, qa: vec4<f32>, qa_prev: vec4<f32>, qb: vec4<f32>, qb_prev: vec4<f32>,
                 mu_s: f32, is_a: bool) -> Corr {
  var out: Corr;
  out.dx = vec3<f32>(0.0);
  out.dth = vec3<f32>(0.0);
  let wa = split(gen_w(wa_inv, ia_inv, c.ra, c.n), na);
  let wb = split(gen_w(wb_inv, ib_inv, c.rb, c.n), nb);
  let dl = c.pen / (wa + wb);
  out.lambda_n = dl;
  // Normal: push a along -n, b along +n.
  if (is_a) {
    out.dx = -wa_inv * dl * c.n;
  } else {
    out.dx = wb_inv * dl * c.n;
  }
  if (FRICTION == 0u && mu_s > 0.0) {
    // Static friction (Müller et al. 2020 §3.5): undo the relative tangential motion of the contact
    // points over this substep if the needed multiplier stays inside the friction cone.
    let mpa = dxa + c.ra - qrot(qmul(qa_prev, qconj(qa)), c.ra);
    let mpb = dxb + c.rb - qrot(qmul(qb_prev, qconj(qb)), c.rb);
    let dp = mpa - mpb;
    let dpt = dp - dot(dp, c.n) * c.n;
    let len = length(dpt);
    if (len > 0.0) {
      let t = dpt / len;
      let wta = split(gen_w(wa_inv, ia_inv, c.ra, t), na);
      let wtb = split(gen_w(wb_inv, ib_inv, c.rb, t), nb);
      let lt = len / (wta + wtb);
      if (lt < mu_s * dl) {
        if (is_a) {
          out.dx += -wa_inv * lt * t;
          out.dth += ia_inv * cross(c.ra, -lt * t);
        } else {
          out.dx += wb_inv * lt * t;
          out.dth += ib_inv * cross(c.rb, lt * t);
        }
      }
    }
  }
  return out;
}

// --- Joints --------------------------------------------------------------------------------------------

struct End {
  lo: vec3<u32>,
  hi: vec3<i32>,
  r: vec3<f32>,  // anchor relative to the center (world frame); zero for the world
  q: vec4<f32>,
  inv_mass: f32,
  inv_inertia: f32,
  n: u32,
}

fn joint_end(j: Joint, body: u32, local: vec3<f32>) -> End {
  var e: End;
  if (body == NONE) {
    e.lo = j.w_lo;
    e.hi = j.w_hi;
    e.r = vec3<f32>(0.0);
    e.q = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    e.inv_mass = 0.0;
    e.inv_inertia = 0.0;
    e.n = 1u;
    return e;
  }
  let p = pred[body];
  e.lo = p.xq_lo;
  e.hi = p.xq_hi;
  e.q = p.q;
  e.r = qrot(p.q, local);
  e.inv_mass = props[body].inv_mass;
  e.inv_inertia = props[body].inv_inertia;
  e.n = p.n;
  return e;
}

// Positional part: anchors at distance rest (0 for ball, hinge, fixed). Returns the correction of
// the end `which` (0 = a, 1 = b).
fn joint_position(j: Joint, ea: End, eb: End, which: u32, out: ptr<function, Corr>) {
  let d = fixed_diff(ea.lo, ea.hi, eb.lo, eb.hi) + eb.r - ea.r;
  let dist = length(d);
  let c = dist - j.rest;
  if (dist < DEGENERATE * max(j.rest, 1.0)) {
    return; // anchors coincide: a ball joint is satisfied; a distance joint has no direction
  }
  let n = d / dist;
  let wa = split(gen_w(ea.inv_mass, ea.inv_inertia, ea.r, n), ea.n);
  let wb = split(gen_w(eb.inv_mass, eb.inv_inertia, eb.r, n), eb.n);
  let alpha = j.compliance * Q.inv_h.x * Q.inv_h.x; // XPBD: alpha~ = alpha / h^2 (Macklin et al. 2016)
  let dl = -c / (wa + wb + alpha);
  if (which == 0u) {
    (*out).dx += -ea.inv_mass * dl * n;
    (*out).dth += ea.inv_inertia * cross(ea.r, -dl * n);
  } else {
    (*out).dx += eb.inv_mass * dl * n;
    (*out).dth += eb.inv_inertia * cross(eb.r, dl * n);
  }
}

// Angular part of hinge (axes parallel) and fixed (relative orientation q_rest) joints.
fn joint_angle(j: Joint, ea: End, eb: End, which: u32, out: ptr<function, Corr>) {
  var theta: vec3<f32>;
  if (j.kind == JOINT_HINGE) {
    let aa = qrot(ea.q, j.axis_a);
    let ab = qrot(eb.q, j.axis_b);
    let s = cross(aa, ab);
    let sl = length(s);
    if (sl < DEGENERATE) {
      return;
    }
    theta = s * (atan2(sl, dot(aa, ab)) / sl); // rotation taking a's axis onto b's
  } else {
    var e = qmul(eb.q, qconj(qmul(ea.q, j.q_rest)));
    if (e.w < 0.0) {
      e = -e;
    }
    let sl = length(e.xyz);
    if (sl < DEGENERATE) {
      return;
    }
    theta = e.xyz * (2.0 * atan2(sl, e.w) / sl); // rotation taking b's target onto b
  }
  let angle = length(theta);
  let n = theta / angle;
  let wa = split(ea.inv_inertia, ea.n);
  let wb = split(eb.inv_inertia, eb.n);
  if (wa + wb <= 0.0) {
    return;
  }
  let dl = angle / (wa + wb);
  if (which == 0u) {
    (*out).dth += ea.inv_inertia * dl * n;
  } else {
    (*out).dth += -eb.inv_inertia * dl * n;
  }
}

// --- Passes ----------------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn predict_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  let b = bodies[i];
  let r = rot[i];
  var p: Pred;
  p.dx = Q.g_h2.w * b.v + Q.g_h2.xyz;
  var lo: vec3<u32>;
  var hi: vec3<i32>;
  add_fixed(b.xq_lo, b.xq_hi, p.dx, &lo, &hi);
  p.xq_lo = lo;
  p.xq_hi = hi;
  p.q_prev = r.q;
  p.q = qadvance(r.q, Q.g_h2.w * r.w);
  p.w_pre = r.w;
  p.n = props[i].n_joint; // count_main adds the contacts when contacts are on
  pred[i] = p;
}

fn count_contacts(i: u32) -> u32 {
  var n = 0u;
  for (var j = 0u; j < Q.counts.x; j++) {
    if (j == i) {
      continue;
    }
    let c = contact_dyn(min(i, j), max(i, j));
    n += select(0u, 1u, c.hit);
  }
  for (var s = 0u; s < Q.info.x; s++) {
    n += select(0u, 1u, contact_static(i, s).hit);
  }
  return n;
}

@compute @workgroup_size(64)
fn count_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  pred[i].n = props[i].n_joint + count_contacts(i);
}

@compute @workgroup_size(64)
fn solve_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  let me = pred[i];
  let pr = props[i];
  let inv_m = pr.inv_mass;
  var acc: Corr;
  acc.dx = vec3<f32>(0.0);
  acc.dth = vec3<f32>(0.0);
  var count = 0u;
  var contacts = 0u;
  var max_pen = 0.0;
  if (Q.info.y == 1u) {
    for (var j = 0u; j < Q.counts.x; j++) {
      if (j == i) {
        continue;
      }
      let a = min(i, j);
      let b = max(i, j);
      let c = contact_dyn(a, b);
      if (!c.hit) {
        continue;
      }
      let pa = pred[a];
      let pb = pred[b];
      let mu_s = sqrt(props[a].mu_s * props[b].mu_s);
      let k = solve_contact(c, props[a].inv_mass, props[a].inv_inertia, pa.n, props[b].inv_mass, props[b].inv_inertia, pb.n,
                            pa.dx, pb.dx, pa.q, pa.q_prev, pb.q, pb.q_prev, mu_s, i == a);
      acc.dx += k.dx;
      acc.dth += k.dth;
      count++;
      contacts++;
      max_pen = max(max_pen, c.pen);
    }
    for (var s = 0u; s < Q.info.x; s++) {
      let c = contact_static(i, s);
      if (!c.hit) {
        continue;
      }
      let st = statics[s];
      let mu_s = sqrt(pr.mu_s * st.mu_s);
      let k = solve_contact(c, inv_m, pr.inv_inertia, me.n, 0.0, 0.0, 1u, me.dx, vec3<f32>(0.0), me.q, me.q_prev,
                            vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(0.0, 0.0, 0.0, 1.0), mu_s, true);
      acc.dx += k.dx;
      acc.dth += k.dth;
      count++;
      contacts++;
      max_pen = max(max_pen, c.pen);
    }
  }
  for (var k = 0u; k < pr.j_count; k++) {
    let j = joints[jlist[pr.j_start + k]];
    let ea = joint_end(j, j.a, j.anchor_a);
    let eb = joint_end(j, j.b, j.anchor_b);
    let which = select(1u, 0u, j.a == i);
    joint_position(j, ea, eb, which, &acc);
    count++;
    if (j.kind == JOINT_HINGE || j.kind == JOINT_FIXED) {
      joint_angle(j, ea, eb, which, &acc);
      count++;
    }
  }
  if (SOLVER == 2u && count > 1u) {
    acc.dx = acc.dx / f32(count);
    acc.dth = acc.dth / f32(count);
  }

  var b = bodies[i];
  var r = rot[i];
  let v_start = b.v;
  var total = me.dx;
  if (count > 0u) {
    total = me.dx + acc.dx;
    var lo: vec3<u32>;
    var hi: vec3<i32>;
    add_fixed(me.xq_lo, me.xq_hi, acc.dx, &lo, &hi);
    b.xq_lo = lo;
    b.xq_hi = hi;
    r.q = qadvance(me.q, acc.dth);
    // Delta form, as for v: the substep rotated by h*w_pre + dth, so w = w_pre + dth/h. Rebuilding w
    // from q * conj(q_prev) (Müller et al. 2020, Alg. 2) subtracts two nearly equal f32 quaternions:
    // with |dq.xyz| = h|w|/2 ~ 1e-5 that loses ~1% of w per substep, more as h shrinks.
    r.w = me.w_pre + acc.dth * Q.inv_h.x;
  } else {
    b.xq_lo = me.xq_lo;
    b.xq_hi = me.xq_hi;
    r.q = me.q;
  }
  // Delta form, v = v + g h + dx_corr / h, never (h v) * (1/h): f32(h) * f32(1/h) differs from 1 by
  // up to ~1e-7 (h = 0.5 ms: +4.75e-8), and that factor compounds every substep (3.6e-4 of the
  // speed after 7500 substeps). The free-flight kernels keep the P0 form for byte identity (P2D5).
  b.v = v_start + Q.g_h.xyz + acc.dx * Q.inv_h.x;

  // Diagnostics (design P2D7, P2D13): displacement per radius, penetration, and the energy the
  // correction may have added: m v~.dx/h + m |dx|^2 / 2h^2 - m g.dx plus the rotational analogue.
  var d = diag[i];
  d.max_disp_ratio = max(d.max_disp_ratio, length(total) / pr.radius);
  d.max_speed = max(d.max_speed, length(b.v));
  d.max_pen = max(d.max_pen, max_pen);
  d.contacts = contacts;
  if (count > 0u && inv_m > 0.0) {
    let m = 1.0 / inv_m;
    let v_pred = me.dx * Q.inv_h.x;
    let g = Q.g_h2.xyz * Q.inv_h.x * Q.inv_h.x;
    let lin = m * (dot(v_pred, acc.dx) * Q.inv_h.x + 0.5 * dot(acc.dx, acc.dx) * Q.inv_h.x * Q.inv_h.x - dot(g, acc.dx));
    var ang = 0.0;
    if (pr.inv_inertia > 0.0) {
      let inertia = 1.0 / pr.inv_inertia;
      ang = inertia * (dot(me.w_pre, acc.dth) * Q.inv_h.x + 0.5 * dot(acc.dth, acc.dth) * Q.inv_h.x * Q.inv_h.x);
    }
    d.e_proj += max(0.0, lin + ang);
  }
  diag[i] = d;
  if (FAULT_KIND == 5u && Q.info.w == 1u && i == FAULT_BODY) {
    r.q[FAULT_C] = bitcast<f32>(Q.counts.w);
  }
  bodies[i] = b;
  rot[i] = r;
}

// Velocity of the contact point of `body` (post-solve state), offset r from its center.
fn point_velocity(body: u32, r: vec3<f32>) -> vec3<f32> {
  return bodies[body].v + cross(rot[body].w, r);
}

// Pre-solve velocity of the contact point: the predicted v~ = dx/h and the angular velocity before the solve.
fn point_velocity_pre(body: u32, r: vec3<f32>) -> vec3<f32> {
  return pred[body].dx * Q.inv_h.x + cross(pred[body].w_pre, r);
}

struct VCorr {
  dv: vec3<f32>,
  dw: vec3<f32>,
  e_bounce: f32,
}

// Velocity pass of one contact (Müller et al. 2020 §3.6), seen from `self`. vrel = v_a - v_b at the
// contact; its normal component vn > 0 means approaching.
fn velocity_contact(c: Contact, lambda_n: f32, va: vec3<f32>, vb: vec3<f32>, va_pre: vec3<f32>, vb_pre: vec3<f32>,
                    wa_inv: f32, ia_inv: f32, na: u32, wb_inv: f32, ib_inv: f32, nb: u32,
                    e: f32, mu_s: f32, mu_d: f32, self_mass: f32, is_a: bool) -> VCorr {
  var out: VCorr;
  out.dv = vec3<f32>(0.0);
  out.dw = vec3<f32>(0.0);
  out.e_bounce = 0.0;
  let vrel = va - vb;
  let vn = dot(vrel, c.n);
  let vt = vrel - vn * c.n;
  var impulse = vec3<f32>(0.0); // applied to a as -impulse, to b as +impulse (in velocity * mass units)

  // Dynamic friction: an impulse of at most h * mu_d * |f_n| = mu_d * lambda_n / h (f_n = lambda_n / h^2),
  // and no more than the impulse that stops the slip, |v_t| / (w_a + w_b) with generalized inverse
  // masses. Müller et al. 2020 write the bound as a velocity change of the contact point; for a
  // sphere most of that change comes from spin, which would leave only 2/7 of the friction force on
  // the centre of mass (design R-entry in P2-02).
  let vtl = length(vt);
  if (vtl > 0.0) {
    let t = vt / vtl;
    let wta = split(gen_w(wa_inv, ia_inv, c.ra, t), na);
    let wtb = split(gen_w(wb_inv, ib_inv, c.rb, t), nb);
    let stop = vtl / (wta + wtb);
    var jt = min(mu_d * lambda_n * Q.inv_h.x, stop);
    if (FRICTION == 1u && stop <= mu_s * lambda_n * Q.inv_h.x) {
      jt = stop; // velocity-level Coulomb: stick inside the static cone
    }
    impulse += jt * t;
  }

  // Restitution on the pre-solve approach speed; none below the threshold 2|g|h.
  let vn_pre = dot(va_pre - vb_pre, c.n);
  var e_eff = e * RESTITUTION_GAIN;
  if (RESTITUTION_THRESHOLD == 0u && abs(vn_pre) <= Q.inv_h.z) {
    e_eff = 0.0;
  }
  let v_target = -e_eff * max(vn_pre, 0.0); // desired normal velocity after the bounce
  let dvn = vn - v_target;
  let wa = split(gen_w(wa_inv, ia_inv, c.ra, c.n), na);
  let wb = split(gen_w(wb_inv, ib_inv, c.rb, c.n), nb);
  impulse += (dvn / (wa + wb)) * c.n;
  if (e_eff > 0.0) {
    // The pre-solve speed may exceed the true impact speed by |g| h (design P2D13).
    out.e_bounce = self_mass * e_eff * e_eff * (max(vn_pre, 0.0) * Q.inv_h.y * Q.g_h2.w + 0.5 * Q.inv_h.y * Q.inv_h.y * Q.g_h2.w * Q.g_h2.w);
  }
  if (is_a) {
    out.dv = -wa_inv * impulse;
    out.dw = ia_inv * cross(c.ra, -impulse);
  } else {
    out.dv = wb_inv * impulse;
    out.dw = ib_inv * cross(c.rb, impulse);
  }
  return out;
}

@compute @workgroup_size(64)
fn velocity_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  let me = pred[i];
  let pr = props[i];
  let inv_m = pr.inv_mass;
  let mass = select(0.0, 1.0 / inv_m, inv_m > 0.0);
  var dv = vec3<f32>(0.0);
  var dw = vec3<f32>(0.0);
  var eb = 0.0;
  var count = 0u;
  for (var j = 0u; j < Q.counts.x; j++) {
    if (j == i) {
      continue;
    }
    let a = min(i, j);
    let b = max(i, j);
    let c = contact_dyn(a, b);
    if (!c.hit) {
      continue;
    }
    let pa = pred[a];
    let pb = pred[b];
    let wa = split(gen_w(props[a].inv_mass, props[a].inv_inertia, c.ra, c.n), pa.n);
    let wb = split(gen_w(props[b].inv_mass, props[b].inv_inertia, c.rb, c.n), pb.n);
    let lambda_n = c.pen / (wa + wb);
    let k = velocity_contact(c, lambda_n, point_velocity(a, c.ra), point_velocity(b, c.rb), point_velocity_pre(a, c.ra), point_velocity_pre(b, c.rb),
                             props[a].inv_mass, props[a].inv_inertia, pa.n, props[b].inv_mass, props[b].inv_inertia, pb.n,
                             max(props[a].restitution, props[b].restitution), sqrt(props[a].mu_s * props[b].mu_s), sqrt(props[a].mu_d * props[b].mu_d), mass, i == a);
    dv += k.dv;
    dw += k.dw;
    eb += k.e_bounce;
    count++;
  }
  for (var s = 0u; s < Q.info.x; s++) {
    let c = contact_static(i, s);
    if (!c.hit) {
      continue;
    }
    let st = statics[s];
    let wa = split(gen_w(inv_m, pr.inv_inertia, c.ra, c.n), me.n);
    let lambda_n = c.pen / wa;
    let k = velocity_contact(c, lambda_n, point_velocity(i, c.ra), vec3<f32>(0.0), point_velocity_pre(i, c.ra), vec3<f32>(0.0),
                             inv_m, pr.inv_inertia, me.n, 0.0, 0.0, 1u,
                             max(pr.restitution, st.restitution), sqrt(pr.mu_s * st.mu_s), sqrt(pr.mu_d * st.mu_d), mass, true);
    dv += k.dv;
    dw += k.dw;
    eb += k.e_bounce;
    count++;
  }
  if (SOLVER == 2u && count > 1u) {
    dv = dv / f32(count);
    dw = dw / f32(count);
  }
  pred[i].v_out = bodies[i].v + dv;
  pred[i].w_out = rot[i].w + dw;
  diag[i].e_bounce += eb;
}

@compute @workgroup_size(64)
fn commit_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= Q.counts.x) {
    return;
  }
  bodies[i].v = pred[i].v_out;
  rot[i].w = pred[i].w_out;
}
