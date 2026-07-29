import { deflate as pakoDeflate } from "pako";
import { describe, expect, it } from "vite-plus/test";
import { base64ToBytes } from "../src/codec/base64";
import { deflateLevel9, inflate } from "../src/codec/deflate";
import fixtures from "./fixtures/builtin-presets.json";

const presets = fixtures.presets as Record<string, string>;
const NAMES = Object.keys(presets);

function compressedBytesOf(exchangeString: string): Uint8Array {
  const compact = exchangeString.replaceAll(/\s+/g, "");
  return base64ToBytes(compact.slice(3, -3));
}

describe("deflate", () => {
  it("round-trips bytes through deflateLevel9 + inflate with a 78 da header", () => {
    const payload = new TextEncoder().encode("factorio ".repeat(50));
    const compressed = deflateLevel9(payload);
    expect(compressed[0]).toBe(0x78);
    expect(compressed[1]).toBe(0xda);
    expect(inflate(compressed)).toEqual(payload);
  });

  it.each(NAMES)("inflates the %s fixture to the recorded size", (name) => {
    const status = (fixtures._decodeStatus as Record<string, string>)[name] as string;
    const expectedSize = Number(/\((\d+) bytes/.exec(status)?.[1]);
    expect(inflate(compressedBytesOf(presets[name] as string)).length).toBe(expectedSize);
  });

  // COMPRESSOR-FIDELITY GATE (spec Sections 6 and 10): deflateLevel9 must
  // reproduce the game's zlib@9 stream byte-for-byte, or byte-identical STRING
  // export is off the table. If this regresses, the compressor changed - do not
  // weaken it, fix the compressor. The most likely cause is the `legacyHash`
  // option below going missing; the test after this one says so directly.
  it.each(NAMES)("level 9 reproduces the compressed bytes of %s", (name) => {
    const compressed = compressedBytesOf(presets[name] as string);
    expect(deflateLevel9(inflate(compressed))).toEqual(compressed);
  });
});

/**
 * `legacyHash: true` is the single option the whole byte-exactness invariant
 * hangs on, and it is a pako EXTENSION rather than anything in the zlib API -
 * so it is exactly the kind of thing a dependency bump can quietly rename,
 * remove, or re-default. pako has already done that once: 2.2.0 introduced the
 * flag defaulting to `true`, and 3.0.0 flipped the default to `false`.
 *
 * If you are reading this because a test below failed:
 *   `src/codec/deflate.ts` must call
 *     pako.deflate(bytes, { level: 9, legacyHash: true })
 *   Without `legacyHash: true`, pako uses its faster non-canonical hash and
 *   emits valid-but-different deflate streams, so re-encoding an exchange
 *   string no longer reproduces the game's bytes. Do NOT edit a fixture or an
 *   expected value - restore the option, or find another madler-zlib-compatible
 *   compressor.
 */
describe("deflate: the legacyHash option is load-bearing", () => {
  const SAMPLE = compressedBytesOf(presets[NAMES[0] as string] as string);
  const RAW = inflate(SAMPLE);

  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  it("pako still accepts a `legacyHash` option (not renamed or removed)", () => {
    // A pako that no longer knows the option would silently ignore it and
    // produce its default (non-canonical) stream - so assert on the BYTES,
    // which is the only thing that actually distinguishes the two hashes.
    const withOption = pakoDeflate(RAW, { level: 9, legacyHash: true });
    expect(
      sameBytes(withOption, SAMPLE),
      "pako.deflate({ level: 9, legacyHash: true }) no longer reproduces Factorio's " +
        "zlib@9 stream. The `legacyHash` extension was likely renamed, removed, or " +
        "changed meaning in a pako upgrade. See the block comment above this test.",
    ).toBe(true);
  });

  it("omitting `legacyHash` produces DIFFERENT bytes (the guard discriminates)", () => {
    // If this ever starts matching, pako made the canonical hash the default
    // again and the guard above has stopped proving anything. Revisit before
    // relaxing src/codec/deflate.ts.
    const atDefaults = pakoDeflate(RAW, { level: 9 });
    expect(
      sameBytes(atDefaults, SAMPLE),
      "pako at its DEFAULTS now matches the game's stream, so the `legacyHash` " +
        "guard no longer discriminates. Re-check what pako's default hash is before " +
        "trusting the fidelity gate.",
    ).toBe(false);
  });

  it("deflateLevel9 emits the legacyHash stream, not pako's default", () => {
    expect(
      sameBytes(deflateLevel9(RAW), SAMPLE),
      "src/codec/deflate.ts is no longer passing { level: 9, legacyHash: true }.",
    ).toBe(true);
  });
});
