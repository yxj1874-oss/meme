// Portable Float Map, colour ("PF"), little-endian (negative scale), scanlines bottom to top as the
// format specifies. Holds the linear image so numerical oracles never read through the 8-bit PNG.

export function encodePfm(width: number, height: number, rgb: Float32Array): Uint8Array {
  if (rgb.length !== width * height * 3) throw new RangeError("rgb length does not match width * height * 3");
  const header = new TextEncoder().encode(`PF\n${width} ${height}\n-1.0\n`);
  const out = new Uint8Array(header.length + rgb.length * 4);
  out.set(header, 0);
  const dv = new DataView(out.buffer, header.length);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let i = 0; i < width * 3; i++) dv.setFloat32((row * width * 3 + i) * 4, rgb[y * width * 3 + i]!, true);
  }
  return out;
}

export function decodePfm(bytes: Uint8Array): { width: number; height: number; rgb: Float32Array } {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  const m = /^PF\n(\d+) (\d+)\n(-?[0-9.]+)\n/.exec(text);
  if (m === null) throw new Error("not a colour PFM");
  const width = Number(m[1]);
  const height = Number(m[2]);
  const little = Number(m[3]) < 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + m[0].length);
  const rgb = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let i = 0; i < width * 3; i++) rgb[y * width * 3 + i] = dv.getFloat32((row * width * 3 + i) * 4, little);
  }
  return { width, height, rgb };
}
