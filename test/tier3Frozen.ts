import { join } from "node:path";

import { makeFrozenTable } from "./frozenTable";

/**
 * Frozen tier-3 render checksums, so the cutover in #227 does not take the
 * render parity specs out of the gate with it.
 *
 * Tier 3 grades a rendered image from the Rust engine against the same image
 * from TypeScript, and it gets the TypeScript arm by calling the same function
 * with the engine argument left off:
 *
 * ```ts
 * const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
 * const ts   = new Uint8ClampedArray(runRenderRequest(req).buffer);
 * ```
 *
 * #227 deletes the TypeScript branches that second line reaches. After that it
 * is not a weaker arm, it is the SAME arm - `runRenderRequest` would have
 * nothing else to be - so the comparison would pass while grading nothing. That
 * is the failure mode this repo cares most about, and the reason the freeze has
 * to land BEFORE the deletion rather than with it.
 *
 * The conversion is the one `tier2Frozen.ts` describes, applied to pixels:
 * `expect(wasm).toEqual(ts)` becomes
 * `expectFrozen(section, label, name, foldPixels(wasm), foldPixels(ts))`.
 * While both renderers exist all three agree, so the table cannot be wrong.
 * When the TypeScript arm goes the call drops its last argument and the wasm
 * arm keeps running against a value captured while the two demonstrably agreed.
 *
 * **Read a moved number, do not adjust it.** A moved render checksum is a
 * finding, exactly like a moved count. Re-freeze deliberately and say why.
 *
 * ## Three reasons this is its own table rather than rows in tier 2's
 *
 * 1. **A row means something different.** Tier 2 folds a field over a grid of
 *    coordinates; tier 3 folds one rendered image. Mixing them puts two units
 *    in one file under one name.
 * 2. **`tier2Coverage.spec.ts` anchors tier 2's rows to the module's own
 *    `checksum_*` exports**, and asserts every such export has a row. Render
 *    rows have no export - see below - so they would have to be special-cased
 *    into a guard whose entire value is that it enumerates rather than lists.
 * 3. **They re-record separately.** Recording tier 2 is cheap; recording tier 3
 *    renders images, and the Nauvis sweep alone runs for minutes.
 *
 * ## The fold runs in JavaScript, and that is deliberate
 *
 * Tier 2's checksums come from `checksum_*` exports, because the Rust side is
 * the only place that can walk a field. Tier 3 has no such need: both arms hand
 * back RGBA bytes to JavaScript already, so folding here keeps the two arms
 * symmetric - the same function over the same bytes - and adds no Rust export.
 *
 * That also means **freezing tier 3 rebuilds no `engine.wasm`**, so this cannot
 * go stale against the committed binary the way a Rust change does.
 *
 * ## Recording
 *
 * ```bash
 * FMW_FREEZE_TIER3=1 pnpm vp test test/wasmNauvisRenderParity.spec.ts
 * ```
 *
 * In record mode every `expectFrozen` call records instead of asserting, and
 * the file is rewritten on exit. Run the spec normally afterwards - a record
 * run proves nothing, because in it nothing is compared.
 */
const TABLE = makeFrozenTable({
  tablePath: join(import.meta.dirname, "fixtures", "tier3-render-checksums.json"),
  envVar: "FMW_FREEZE_TIER3",
});

/** Set to record rather than assert. See the module comment. */
export const RECORDING = TABLE.RECORDING;

/** The frozen value for one (section, case, name), or `undefined` when absent. */
export const frozen = TABLE.frozen;

/** Number of entries the table holds for one section. */
export const frozenCount = TABLE.frozenCount;

/**
 * Distinct rows this run actually looked up, for the coverage guard each
 * tier-3 spec carries. See `frozenTable.ts` for why `frozenCount` alone is not
 * enough.
 */
export const consultedCount = TABLE.consultedCount;

/** Every frozen row name, grouped by section. */
export const frozenNames = TABLE.frozenNames;

/**
 * Assert one rendered image against its frozen checksum, and against the
 * TypeScript arm while that arm still exists. See the module comment.
 */
export const expectFrozen = TABLE.expectFrozen;

/**
 * Declare how many rows this section must record before the table is rewritten.
 * Call it ONCE per section, at module scope.
 *
 * Carries the same guard tier 2 documents at length: without it, a record run
 * that throws part-way rewrites the table with only the rows that ran, and the
 * next normal run then fails on a missing entry that reads like a second,
 * unrelated break. A section that records fewer rows than it declared is
 * dropped rather than written.
 */
export const expectRecordedRows = TABLE.expectRecordedRows;

/** Merge this run's recordings into the committed table and write it out. */
export const flushRecording = TABLE.flushRecording;

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/**
 * FNV-1a over a rendered image's raw RGBA bytes.
 *
 * **The byte length is folded in first**, so a truncated buffer cannot collide
 * with a shorter render that happens to share a prefix. The specs assert the
 * expected length separately, and this is belt as well as braces: a fold whose
 * only input is content would let a render that returned half an image pass on
 * a day someone dropped the length assertion.
 *
 * Deliberately NOT `fold_f64`'s sibling in the Rust checksum module. These are
 * bytes rather than doubles, and nothing on the Rust side ever computes this -
 * see the module comment on why the fold runs here.
 */
export function foldPixels(pixels: ArrayLike<number>): bigint {
  let hash = FNV_OFFSET_BASIS;
  const fold = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  };
  // Length first, little-endian over four bytes. A render is far below 2^32
  // pixels, so four bytes cannot truncate a real one.
  const n = pixels.length;
  fold(n & 0xff);
  fold((n >>> 8) & 0xff);
  fold((n >>> 16) & 0xff);
  fold((n >>> 24) & 0xff);
  for (let i = 0; i < n; i++) fold(pixels[i] as number);
  return hash;
}

/** `foldPixels` over the buffer an `ElevationRenderResult` hands back. */
export function foldBuffer(buffer: ArrayBufferLike): bigint {
  return foldPixels(new Uint8ClampedArray(buffer));
}
