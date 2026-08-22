/**
 * A minimal PNG encoder - the mirror of `decodePng.ts`, and the only thing it
 * ever writes is a DIAGNOSTIC.
 *
 * Nothing here produces a fixture. `test/diffArtifacts.ts` calls it to dump the
 * two images a failing comparison was looking at, plus two derived views of
 * where they disagree, into a gitignored directory. Fixtures come from the game
 * and are captured by `test/oracle/`; anything this function writes is a
 * snapshot of a failure and must never be committed (#252).
 *
 * Deliberately not a dependency, for the same reason `decodePng.ts` is not: the
 * output space is one shape - 8-bit truecolour RGB, no interlacing, filter type
 * 0 on every scanline - and a PNG writer for exactly that is about forty lines.
 * Filter 0 (None) is chosen over the adaptive heuristic a real encoder uses
 * because it costs nothing to be sure the bytes are right, and these files are
 * read by a person once and then deleted.
 *
 * Round-tripped through `decodePng` by `test/diffArtifacts.spec.ts`, so a
 * mangled chunk length or a wrong CRC is a test failure rather than a corrupt
 * artifact that a viewer refuses to open at the moment somebody needs it.
 *
 * That sentence was false when it was first written: `decodePng` stepped over
 * the CRC bytes entirely, so the round-trip could not see a wrong one, and
 * breaking `chunk()` left all seven smoke tests green. `decodePng` verifies
 * every chunk CRC now, and `diffArtifacts.spec.ts` plants a flipped byte to
 * keep that guard from going vacuous again. Do not restore the claim without
 * the check.
 */

import { crc32 } from "../../src/codec/crc32";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** One PNG chunk: length, four-byte type, payload, CRC32 over type + payload. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode row-major RGB triples as an 8-bit truecolour PNG.
 *
 * `deflate` is injected rather than imported so this file stays free of
 * `node:zlib`, matching `decodePng`'s inflate parameter. Callers in the test
 * suite pass `deflateSync`.
 */
export function encodePng(
  image: { readonly width: number; readonly height: number; readonly rgb: Uint8Array },
  deflate: (bytes: Uint8Array) => Uint8Array,
): Uint8Array {
  const { width, height, rgb } = image;
  if (width <= 0 || height <= 0) throw new Error(`bad size ${String(width)}x${String(height)}`);
  if (rgb.length !== width * height * 3) {
    throw new Error(`expected ${String(width * height * 3)} RGB bytes, got ${String(rgb.length)}`);
  }

  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // The leading byte of each scanline is the filter type. 0 = None.
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression: deflate, the only value PNG defines
  ihdr[11] = 0; // filter method: adaptive, the only value PNG defines
  ihdr[12] = 0; // not interlaced

  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
