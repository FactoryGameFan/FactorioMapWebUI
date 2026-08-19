/**
 * The TypeScript half of the WASM render boundary: writing a request.
 *
 * The Rust half is `crates/fmw-wasm/src/abi.rs`, and its module docs carry the
 * layout table and the reasoning. Keep the two in step; three things make that
 * enforceable rather than a promise:
 *
 * - the module exports `request_bytes()` and `abi_version()`, and
 *   {@link encodeRenderRequest} refuses to write against a module that
 *   disagrees with the constants here;
 * - a committed round-trip fixture (`test/fixtures/wasm-request.v1.json`) pins
 *   the exact bytes of a known request, so neither side can move a field
 *   without the other going red;
 * - every rejection has its own status code, so a mismatch says which kind.
 *
 * Little-endian throughout, which is the byte order WebAssembly specifies for
 * its own loads - so nothing swaps on any host.
 */

import { f32 } from "../eval/f32";

/** `'FMWR'` little-endian. Must equal `fmw_wasm::abi::MAGIC`. */
export const MAGIC = 0x52574d46;

/** Must equal `fmw_wasm::abi::ABI_VERSION`. Bump both together, never one. */
export const ABI_VERSION = 1;

/** Must equal `fmw_wasm::abi::REQUEST_BYTES`. */
export const REQUEST_BYTES = 104;

/** The `planet` codes the module understands. */
export const PLANET = { fulgora: 0 } as const;

/** The `view` codes the module understands. */
export const VIEW = { landmask: 0, terrain: 1, scrapFootprint: 2 } as const;

/**
 * The status codes `render_request` returns. Mirrors `fmw_wasm::abi::Status`.
 *
 * Named rather than numbered at the call site, because "3" and "4" are exactly
 * the kind of thing that gets mis-read in a log a year later.
 */
export const STATUS: Record<number, string> = {
  0: "ok",
  1: "short buffer",
  2: "bad magic",
  3: "bad ABI version",
  4: "unsupported planet or view",
  5: "output too large",
  6: "reserved word not zero",
};

export interface WasmRenderRequest {
  /** Which render. Defaults to the land mask, the view #223 shipped first. */
  readonly view?: keyof typeof VIEW;
  /** The SURFACE seed, not the map seed. */
  readonly seed0: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
  readonly islandsFrequency: number;
  readonly islandsSize: number;
}

/**
 * The two bearings' sine and cosine, computed HERE and sent as values.
 *
 * A one-ULP `sin` difference lands straight in `startingSpotAtAngle`, and #270
 * measured that V8 and the libm `wasm32-unknown-unknown` links really do
 * disagree, in a place `cargo test` on the host cannot see. Every call site's
 * angle is a per-render constant, so lifting the trig out costs nothing and
 * closes the question instead of bounding it.
 *
 * **Every step is narrowed to f32, and this must stay token-for-token identical
 * to `fulgoraShared.ts` and `vulcanusShared.ts`** (#279). The Rust side reads
 * `spot.trig.sin` straight into the arithmetic without re-narrowing, so an
 * un-narrowed value sent from here would make the WASM render differ from the
 * TypeScript one - which is precisely what tier 3's byte-identical RGBA
 * comparison exists to catch, and it would be a real divergence rather than a
 * test problem.
 *
 * The bearing is `f32(seed0 / 360)` degrees and the vault sits at
 * `f32(angle + 180)`, and `(a / 180) * PI32` is in that order on purpose -
 * `a * (PI32 / 180)` is a different number.
 */
export function bearingTrig(seed0: number): {
  sinStart: number;
  cosStart: number;
  sinVault: number;
  cosVault: number;
} {
  const angle = f32(seed0 / 360);
  const radians = (a: number): number => f32(f32(a / 180) * f32(Math.PI));
  const start = radians(angle);
  const vault = radians(f32(angle + 180));
  return {
    sinStart: f32(Math.sin(start)),
    cosStart: f32(Math.cos(start)),
    sinVault: f32(Math.sin(vault)),
    cosVault: f32(Math.cos(vault)),
  };
}

/** Write a landmask request into `target`, returning the bytes written. */
export function encodeRenderRequest(target: Uint8Array, req: WasmRenderRequest): number {
  if (target.byteLength < REQUEST_BYTES) {
    throw new RangeError(
      `WASM request needs ${String(REQUEST_BYTES)} bytes, target has ${String(target.byteLength)}`,
    );
  }
  const view = new DataView(target.buffer, target.byteOffset, REQUEST_BYTES);
  const trig = bearingTrig(req.seed0);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, ABI_VERSION, true);
  view.setUint32(8, PLANET.fulgora, true);
  view.setUint32(12, VIEW[req.view ?? "landmask"], true);
  // `setUint32` takes the number modulo 2^32, so a surface seed above 2^31 -
  // which is the normal case - writes its true bit pattern rather than
  // saturating. Fulgora's own seed for map seed 123456 is 2,967,702,466.
  view.setUint32(16, req.seed0, true);
  view.setUint32(20, req.width, true);
  view.setUint32(24, req.height, true);
  view.setUint32(28, 0, true); // reserved; the module asserts this is zero
  view.setFloat64(32, req.originX, true);
  view.setFloat64(40, req.originY, true);
  view.setFloat64(48, req.tilesPerPixel, true);
  view.setFloat64(56, req.islandsFrequency, true);
  view.setFloat64(64, req.islandsSize, true);
  view.setFloat64(72, trig.sinStart, true);
  view.setFloat64(80, trig.cosStart, true);
  view.setFloat64(88, trig.sinVault, true);
  view.setFloat64(96, trig.cosVault, true);

  return REQUEST_BYTES;
}
