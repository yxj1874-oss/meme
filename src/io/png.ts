import { crc32 as zlibCrc32, inflateSync } from "node:zlib";

// Minimal deterministic PNG writer (design D13-A): 8-bit RGB, filter 0 on every row, zlib stream of
// stored (uncompressed) deflate blocks, no ancillary chunks (no tIME/tEXt). DEFLATE (RFC 1951) does
// not define a unique encoding, so a compressor's bytes depend on its implementation and version;
// stored blocks make the file a pure function of the pixels.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  const dv = new DataView(out.buffer);
  out[0] = 0x78; // CM = 8 (deflate), CINFO = 7
  out[1] = 0x01; // FLEVEL 0, FCHECK so that (0x78 << 8 | 0x01) % 31 == 0
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, raw.length - start);
    out[o] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE = 00
    dv.setUint16(o + 1, len, true);
    dv.setUint16(o + 3, len ^ 0xffff, true);
    out.set(raw.subarray(start, start + len), o + 5);
    o += 5 + len;
  }
  dv.setUint32(o, adler32(raw), false);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false);
  return out;
}

/** rgb: width * height * 3 bytes, rows top to bottom. */
export function encodePngRgb8(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) throw new RangeError("rgb length does not match width * height * 3");
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter type None
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** IEC 61966-2-1 sRGB encoding of linear [0, 1]. */
export function srgbOetf(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Linear RGB (cd/m2) -> 8-bit sRGB: q = floor(255 * OETF(clamp(L / white, 0, 1)) + 0.5). */
export function toDisplayRgb8(linear: Float32Array, displayWhite: number): Uint8Array {
  const out = new Uint8Array(linear.length);
  for (let i = 0; i < linear.length; i++) {
    const v = linear[i]! / displayWhite;
    const c = v > 0 ? (v < 1 ? v : 1) : 0; // NaN maps to 0; V-NaN reports it separately
    out[i] = Math.floor(255 * srgbOetf(c) + 0.5);
  }
  return out;
}

/**
 * Decodes the files encodePngRgb8 writes (RGB8, filter 0). Checks CRCs and inflates with node:zlib,
 * an implementation independent of the encoder above, so a broken encoder cannot vouch for itself.
 */
export function decodePngStored(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => png[i] === b)) throw new Error("not a PNG");
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (;;) {
    const len = dv.getUint32(o, false);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (zlibCrc32(png.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len, false)) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      width = dv.getUint32(o + 8, false);
      height = dv.getUint32(o + 12, false);
      if (png[o + 16] !== 8 || png[o + 17] !== 2) throw new Error("only 8-bit RGB is supported");
    } else if (type === "IDAT") {
      idat.push(png.subarray(o + 8, o + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  if (raw.length !== height * (1 + width * 3)) throw new Error("IDAT size does not match IHDR");
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    if (raw[y * (1 + width * 3)] !== 0) throw new Error("unexpected filter type");
    rgb.set(raw.subarray(y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3)), y * width * 3);
  }
  return { width, height, rgb };
}
