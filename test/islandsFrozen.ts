import { join } from "node:path";

import { foldPixels } from "./tier3Frozen";
import { makeFrozenTable } from "./frozenTable";

/**
 * Frozen island-finder checksums, so #371 does not take the finder's parity
 * specs out of the gate with it.
 *
 * Two specs compare the engine-backed island survey against the TypeScript
 * one: `surveyThroughWasm.spec.ts` at the level of raw `(id, cellX, cellY)`
 * triples and the candidate list built from them, and
 * `wasmIslandFinderParity.spec.ts` at the level of the finder's whole ranked
 * output. #371 deletes the TypeScript arm of both - `makeFulgoraStack` and the
 * Fulgora expression chain under it - and the argument `tier3Frozen.ts` makes
 * applies unchanged: once that arm is gone, a comparison against it grades
 * nothing. So each comparison ALSO folds the engine's answer against a value
 * captured while the two arms demonstrably agreed, and the fold is what
 * survives.
 *
 * ## Why a third table rather than rows in tier 3's
 *
 * The same reason tier 3 is not rows in tier 2's: a row means something
 * different. A tier-3 row is one rendered image. These rows are a list of
 * survey positions, a list of island candidates, or the finder's ranked
 * result - structures, not pixels. They are folded through the same FNV-1a as
 * the render rows, over the UTF-8 bytes of a canonical JSON serialisation,
 * because the plumbing in `frozenTable.ts` already carries every guard this
 * needs and a second fold would be a second place for one to rot.
 *
 * ## Sections are per FILE, deliberately
 *
 * `flushRecording` REPLACES a section with the rows the recording process
 * saw. Vitest isolates each spec file in its own module instance, so two files
 * recording into one section would each overwrite the other's rows. The two
 * specs therefore own one section each - `fulgora:survey` and
 * `fulgora:finder` - and each declares its own row total.
 *
 * ## Recording
 *
 * ```bash
 * FMW_FREEZE_ISLANDS=1 pnpm vp test test/surveyThroughWasm.spec.ts test/wasmIslandFinderParity.spec.ts
 * ```
 *
 * Run the specs normally afterwards - a record run compares nothing.
 * **Read a moved number, do not adjust it.**
 */
const TABLE = makeFrozenTable({
  tablePath: join(import.meta.dirname, "fixtures", "island-finder-checksums.json"),
  envVar: "FMW_FREEZE_ISLANDS",
});

/** Set to record rather than assert. See the module comment. */
export const RECORDING = TABLE.RECORDING;

/** Number of entries the table holds for one section. */
export const frozenCount = TABLE.frozenCount;

/** Distinct rows this run actually looked up, for each spec's coverage guard. */
export const consultedCount = TABLE.consultedCount;

/** Assert one structure against its frozen checksum, and against the TypeScript arm while it exists. */
export const expectFrozen = TABLE.expectFrozen;

/** Declare how many rows a section must record before the table is rewritten. */
export const expectRecordedRows = TABLE.expectRecordedRows;

/** Merge this run's recordings into the committed table and write it out. */
export const flushRecording = TABLE.flushRecording;

/**
 * FNV-1a over the UTF-8 bytes of `JSON.stringify(value)`.
 *
 * `JSON.stringify` writes object keys in insertion order, and every structure
 * folded here is built by one code path in one order, so the serialisation is
 * canonical for the purpose. A number serialises to its shortest round-trip
 * form, which is exact for a double, so two values that differ in the last bit
 * fold differently. The byte length is folded in first by `foldPixels`, so a
 * truncated list cannot collide with a shorter one that shares a prefix.
 */
export function foldJson(value: unknown): bigint {
  return foldPixels(new TextEncoder().encode(JSON.stringify(value)));
}
