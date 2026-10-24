// Philox4x32-10, Salmon, Moraes, Dror, Shaw, "Parallel Random Numbers: As Easy as 1, 2, 3", SC'11,
// §3.3 (S-box: 32x32->64 multiplies, Weyl key schedule). Counter-based: rng(stream, counter) is a
// pure function of (seed, stream, counter), so there is no generator state to order or share.
// The 32x32 high word is computed from 16-bit limbs exactly as src/kernels/rng.wgsl does it; WGSL
// has no 64-bit integers, and keeping both sides identical makes G04 a bit-for-bit comparison.

export const PHILOX_M0 = 0xd2511f53;
export const PHILOX_M1 = 0xcd9e8d57;
export const PHILOX_W0 = 0x9e3779b9;
export const PHILOX_W1 = 0xbb67ae85;

/** scene.schema.json x-rng-streams. Ids are never reused. Streams 4-5 belong to the test harness, 6 to the substrate probe. */
export const STREAM = {
  SAMPLING: 0,
  PROCEDURAL_NOISE: 1,
  FLUID_PERTURBATION: 2,
  PHYSICS_PERTURBATION: 3,
  HARNESS_FUZZ: 4,
  HARNESS_SCHEDULE: 5,
  SUBSTRATE_PROBE: 6,
} as const;

export function mulhi32(a: number, b: number): number {
  const al = a & 0xffff;
  const ah = a >>> 16;
  const bl = b & 0xffff;
  const bh = b >>> 16;
  const ll = al * bl;
  const lh = al * bh;
  const hl = ah * bl;
  const hh = ah * bh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/** Philox4x32 with a configurable round count (10 in the runtime; other counts only for KAT tests). */
export function philox4x32R(rounds: number, c0: number, c1: number, c2: number, c3: number, k0: number, k1: number): [number, number, number, number] {
  for (let r = 0; r < rounds; r++) {
    if (r > 0) {
      k0 = (k0 + PHILOX_W0) >>> 0;
      k1 = (k1 + PHILOX_W1) >>> 0;
    }
    const hi0 = mulhi32(PHILOX_M0, c0);
    const lo0 = Math.imul(PHILOX_M0, c0) >>> 0;
    const hi1 = mulhi32(PHILOX_M1, c2);
    const lo1 = Math.imul(PHILOX_M1, c2) >>> 0;
    c0 = (hi1 ^ c1 ^ k0) >>> 0;
    c1 = lo1;
    c2 = (hi0 ^ c3 ^ k1) >>> 0;
    c3 = lo0;
  }
  return [c0, c1, c2, c3];
}

/** rng(stream, counter) with key = (seed, stream). */
export function rng4(seed: number, stream: number, c0: number, c1: number, c2: number, c3: number): [number, number, number, number] {
  return philox4x32R(10, c0 >>> 0, c1 >>> 0, c2 >>> 0, c3 >>> 0, seed >>> 0, stream >>> 0);
}

/** u32 -> [0, 1) with 24 bits; exact in f32 (u >> 8 < 2^24, times a power of two). */
export function toUnitFloat(u: number): number {
  return (u >>> 8) * 2 ** -24;
}

/**
 * Deterministic draws for test tooling: stream 4 (fuzz, counter (case, field, trial, 0)) or
 * stream 5 (schedule permutations). Never used by the runtime: it exists so harness-generated
 * scenes and plans are reproducible from a seed.
 */
export class HarnessRng {
  private readonly seed: number;
  private readonly caseId: number;
  private readonly stream: number;
  private trial = 0;

  constructor(seed: number, caseId: number, stream: number = STREAM.HARNESS_FUZZ) {
    if (stream !== STREAM.HARNESS_FUZZ && stream !== STREAM.HARNESS_SCHEDULE) throw new RangeError("HarnessRng only draws from the harness streams 4 and 5");
    this.seed = seed >>> 0;
    this.caseId = caseId >>> 0;
    this.stream = stream;
  }

  u32(field = 0): number {
    return rng4(this.seed, this.stream, this.caseId, field, this.trial++, 0)[0];
  }

  uniform(field = 0): number {
    return toUnitFloat(this.u32(field));
  }

  /** Integer in [0, n) by rejection, so every value is equally likely. */
  below(n: number, field = 0): number {
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const u = this.u32(field);
      if (u < limit) return u % n;
    }
  }

  shuffle<T>(items: readonly T[], field = 0): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.below(i + 1, field);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}
