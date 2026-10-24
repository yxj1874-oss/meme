// Random123 tests/kat_vectors (DEShawResearch/random123), rows "philox4x32 R ctr[4] key[2] out[4]".
// External oracle for src/core/rng.ts (unit test) and golden G04 A1.

export const PHILOX_KAT: { rounds: number; ctr: [number, number, number, number]; key: [number, number]; out: string }[] = [
  { rounds: 7, ctr: [0, 0, 0, 0], key: [0, 0], out: "5f6fb709 0d893f64 4f121f81 4f730a48" },
  { rounds: 7, ctr: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], key: [0xffffffff, 0xffffffff], out: "5207ddc2 45165e59 4d8ee751 8c52f662" },
  { rounds: 7, ctr: [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], key: [0xa4093822, 0x299f31d0], out: "4dfccaba 190a87f0 c47362ba b6b5242a" },
  { rounds: 10, ctr: [0, 0, 0, 0], key: [0, 0], out: "6627e8d5 e169c58d bc57ac4c 9b00dbd8" },
  { rounds: 10, ctr: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], key: [0xffffffff, 0xffffffff], out: "408f276d 41c83b0e a20bc7c6 6d5451fd" },
  { rounds: 10, ctr: [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], key: [0xa4093822, 0x299f31d0], out: "d16cfe09 94fdcceb 5001e420 24126ea1" },
];
