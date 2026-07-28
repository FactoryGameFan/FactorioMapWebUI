/**
 * A minimal PNG decoder, just enough to read the game's own
 * `--generate-map-preview` output back as RGB pixels.
 *
 * Deliberately not a dependency: the only PNGs this repo ever decodes are the
 * committed preview fixtures, written by Factorio itself, so the input space is
 * one encoder's output rather than the wild. Supports 8-bit greyscale, RGB,
 * palette and their alpha variants, with all five scanline filters and no
 * interlacing - if a future capture is interlaced this throws rather than
 * silently returning garbage.
 */

/** Decoded image: row-major RGB triples, `width * height * 3` bytes. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGB, 3 bytes per pixel. Alpha is dropped - the previews are opaque. */
  readonly rgb: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG to RGB. Throws on anything the preview fixtures are not. */
export function decodePng(bytes: Uint8Array, inflate: (b: Uint8Array) => Uint8Array): DecodedImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (pos < bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const bitDepth = bytes[pos + 16];
      colorType = bytes[pos + 17];
      const interlace = bytes[pos + 20];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${String(bitDepth)}`);
      if (interlace !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "IDAT") {
      idat.push(data.slice());
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = inflate(joined);

  const ch = CHANNELS[colorType];
  if (ch === undefined) throw new Error(`unsupported colour type ${String(colorType)}`);
  const stride = width * ch;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  let ri = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[ri];
    ri += 1;
    const line = raw.subarray(ri, ri + stride).slice();
    ri += stride;
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 0xff;
        break;
      case 2:
        for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 0xff;
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const a = x >= ch ? line[x - ch] : 0;
          line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const a = x >= ch ? line[x - ch] : 0;
          const c = x >= ch ? prev[x - ch] : 0;
          line[x] = (line[x] + paeth(a, prev[x], c)) & 0xff;
        }
        break;
      default:
        throw new Error(`unknown PNG filter ${String(filter)}`);
    }
    out.set(line, y * stride);
    prev = line;
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    if (colorType === 3) {
      if (palette === null) throw new Error("palette PNG without PLTE");
      const idx = out[i] * 3;
      rgb[p] = palette[idx];
      rgb[p + 1] = palette[idx + 1];
      rgb[p + 2] = palette[idx + 2];
    } else if (colorType === 0 || colorType === 4) {
      const v = out[i * ch];
      rgb[p] = v;
      rgb[p + 1] = v;
      rgb[p + 2] = v;
    } else {
      const s = i * ch;
      rgb[p] = out[s];
      rgb[p + 1] = out[s + 1];
      rgb[p + 2] = out[s + 2];
    }
  }
  return { width, height, rgb };
}
