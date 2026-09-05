import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  expectRecordedRows,
  flushRecording,
  frozen,
  frozenCount,
  RECORDING,
  record,
} from "./tier2Frozen";

/**
 * Tier 2 of the Rust port's gate for Fulgora's landmask chain (#223): strict
 * bit equality between the two ports over a swept grid, folded
 * order-sensitively, one named field at a time.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong - and here they demonstrably ARE both wrong in
 * the same places, which is the point of tier 1 grading each against the game
 * separately. #273 records the largest of those gaps.
 *
 * ## The trig crosses the boundary as a value
 *
 * `startingSpotAtAngle` is plain f64 arithmetic with no narrowing anywhere, so
 * a one-ULP `sin` difference between V8 and the libm `wasm32-unknown-unknown`
 * links would land straight in the result. #270 measured that those two libms
 * really do disagree - on 1 of 600 slider positions, in a place `cargo test` on
 * the host could not see.
 *
 * Every call site's angle is a per-render constant, so this spec computes both
 * bearings' sine and cosine in V8 and hands them to the module. That makes the
 * question moot rather than bounded. **If a future change computes the trig
 * inside the module instead, this spec is what should go red.**
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  fulgora_field_count: () => number;
  checksum_fulgora: (
    seed0: number,
    islandsFrequency: number,
    islandsSize: number,
    sinStart: number,
    cosStart: number,
    sinVault: number,
    cosVault: number,
    field: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/** A WASM `u64` arrives in JavaScript as a SIGNED BigInt. See wasmEngine.spec.ts. */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

/**
 * The field order the Rust `checksum_fulgora` selector uses, as accessor names.
 *
 * The module exports `fulgora_field_count()` and this list is asserted against
 * it, so a field added to the chain on the Rust side cannot silently go
 * untested - the count moves and the assertion names the gap. That is the same
 * trick the ABI uses for the control catalog.
 */
const SEED0 = 2967702466; // surfaceSeedForPlanet("fulgora", 123456)

// Off any lattice, and a step that is not a binary fraction, so the sweep
// crosses many Voronoi cells and few samples land on a cell centre.
const X0 = -613.5;
const Y0 = 428.25;
const STEP = 7.3;
const N = 26;

interface Case {
  readonly label: string;
  readonly islandsFrequency: number;
  readonly islandsSize: number;
}

// The default preset, plus one that moves BOTH sliders - which is what makes
// `grid` fractional and `sliderRescale` something other than exactly 1. At the
// defaults those two are 175 and 1, so a case list of one would not exercise
// either.
const CASES: readonly Case[] = [
  { label: "default sliders", islandsFrequency: 1, islandsSize: 1 },
  { label: "frequency 2, size 3", islandsFrequency: 2, islandsSize: 3 },
];

/** The two bearings, computed in V8 and handed to the module. */
function trig(): [number, number, number, number] {
  const angle = SEED0 / 360;
  const a = (angle / 180) * Math.PI;
  const b = ((angle + 180) / 180) * Math.PI;
  return [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b)];
}

const FIELD_NAMES = [
  "wobbleInfluence",
  "wobbleMask",
  "wobbleX",
  "wobbleY",
  "ox",
  "oy",
  "wx",
  "wy",
  "startingCone",
  "startingVaultCone",
  "startingMask",
  "startingVaultMask",
  "cells",
  "pyramids",
  "spots",
  "spotsInv",
  "blanks",
  "mesa",
  "sprawl",
  "vaults",
  "vaultsAndStartingVault",
  "basis",
  "basisOil",
  "rock",
  "dunes",
  "scrapMedium",
  "natural",
  "sprawlPyramids",
  "vaultPyramids",
  "vaultPyramidsAndStart",
  "moats",
  "mixPyramids",
  "mixNatural",
  "mixMoats",
  "vaultSpots",
  "mixSpots",
  "oilMask",
  "mixOil",
  "sandBasins",
  "preElevation",
  "elevation",
  "oceanTile",
  "naturalMask",
  "naturalAndMesaMask",
  "artificialMask",
  "roadCells",
  "roadPyramids",
  "pyramidsBanding",
  "spotsPrebanding",
  "spotsBanding",
  "structureCells",
  "structureSubnoise",
  "structureFacets",
  "roadPavingThin",
  "roadPaving2",
  "roadPaving2b",
  "roadPaving2c",
  "roadDust",
  "ruinsWalls",
  "ruinsPaving",
  "tileRuinPaving",
  "tileRuinWalls",
  "tileRuinConduit",
  "tileRuinMachinery",
  "scrapProbability",
  "scrapStructTerm",
  "scrapVaultTerm",
  "landDust",
  "landDunes",
  "landSand",
  "landRock",
  "landPaving",
  "landWalls",
  "landConduit",
  "landMachinery",
  "resolvedTile",
];

const PLANET = "fulgora";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once at module scope so a partial
 * record run cannot pass its own count check. See `expectRecordedRows` in
 * `tier2Frozen.ts`.
 */
expectRecordedRows(PLANET, FIELD_NAMES.length * CASES.length);

describe("Fulgora's landmask chain folds to its frozen checksums", () => {
  it("covers every field the module exposes, so a new one cannot go untested", async () => {
    const engine = await instantiate();
    expect(FIELD_NAMES).toHaveLength(engine.fulgora_field_count());
  });

  it("folds 676 grid points to the frozen checksum for all 76 fields, at two slider settings", async () => {
    const engine = await instantiate();
    const [sinStart, cosStart, sinVault, cosVault] = trig();
    let compared = 0;
    for (const c of CASES) {
      for (const [field, name] of FIELD_NAMES.entries()) {
        const wasm = u64(
          engine.checksum_fulgora(
            SEED0,
            c.islandsFrequency,
            c.islandsSize,
            sinStart,
            cosStart,
            sinVault,
            cosVault,
            field,
            X0,
            Y0,
            STEP,
            N,
          ),
        );

        // A record run since #371 has only the engine to record. The rows in
        // the committed table were captured while the TypeScript arm existed
        // and agreed, which is why re-recording is a deliberate act rather
        // than a repair - see `tier2Frozen.ts`.
        if (RECORDING) {
          record(PLANET, c.label, name, wasm);
          compared++;
          continue;
        }

        const want = frozen(PLANET, c.label, name);
        expect(want, `no frozen checksum for ${name} (${c.label})`).toBeDefined();
        expect(wasm, `wasm ${name} (${c.label})`).toBe(want);
        compared++;
      }
    }
    expect(compared).toBe(FIELD_NAMES.length * CASES.length);

    if (!RECORDING) expect(frozenCount(PLANET)).toBe(FIELD_NAMES.length * CASES.length);
  });

  it("the second slider case really is a different chain, so running both says something", async () => {
    // Anti-vacuity. At the default sliders `grid` is exactly 175 and
    // `sliderRescale(1, 2)` is exactly 1, so a one-case spec would not exercise
    // either lever at all. Asked of the engine since #371 - the same claim,
    // about the side still running, and the count is unchanged: every field
    // is asserted against its frozen value above.
    const engine = await instantiate();
    const [sinStart, cosStart, sinVault, cosVault] = trig();
    const fold = (c: Case, field: number): bigint =>
      u64(
        engine.checksum_fulgora(
          SEED0,
          c.islandsFrequency,
          c.islandsSize,
          sinStart,
          cosStart,
          sinVault,
          cosVault,
          field,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (fold(CASES[0] as Case, i) !== fold(CASES[1] as Case, i)) differing++;
    }
    expect(differing).toBeGreaterThan(30);
  });

  // A guard used to sit here: "the sweep reaches land, shallow and deep, so
  // the ocean fold is not one constant". It read the `oceanTile` column off
  // the TypeScript arm and asserted all three classes were present.
  // `checksum_fulgora` returns one fold per field, which cannot be decomposed
  // back into classes, so it is recorded on #367 as a lost anti-vacuity
  // control; the predicate-counting export proposed there restores it.
});
