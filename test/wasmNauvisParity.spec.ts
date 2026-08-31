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

import { encodeRenderRequest, type WasmRenderRequest } from "../src/noise/wasm/request";

/**
 * Tier 2 of the Rust port's gate for the Nauvis expression core (#226): strict
 * bit equality between the two ports over a swept grid, folded
 * order-sensitively, one named field at a time.
 *
 * **It detects divergence; it does not establish correctness.** Both ports can
 * agree and both be wrong, and here they demonstrably are - `elevation_nauvis`
 * reaches the game at 8 of 26 captured positions on both sides. That is what
 * tier 1 grading each against the game separately is for.
 *
 * ## It has a SHELF LIFE, and #227 is the deadline
 *
 * This compares Rust against TypeScript, and #227 deletes the TypeScript. It
 * can only ever be written while both exist, which is why it lands with the
 * expression core rather than at the end of phase 6.
 *
 * ## The sweep deliberately leaves the f32 grid, and that is LOAD-BEARING
 *
 * The steps are not binary fractions, so 2,365 of the 2,420 sampled positions
 * have at least one coordinate off the f32 grid. That is the whole point: #309
 * was a narrowing difference every tier-3 window missed, because all four of
 * those use binary origins and steps and so agree by construction.
 *
 * Measured, not argued. Planting a pure coordinate narrowing in
 * `nauvis_shared::hills_offset_raw_x` - `f64::from(x as f32) * scale` in place
 * of `x * scale`, which is a no-op wherever `x` is already f32-exact:
 *
 * ```text
 * tier 1 (oracle-cliff-offset-raw, every coordinate f32-exact)   GREEN
 * tier 2 (this spec)                                             RED at hillsOffsetRawX
 * ```
 *
 * So this spec is not a second opinion on what tier 1 already covers. It is the
 * only thing in the gate that can see that class of change on Nauvis.
 *
 * ## No trig crosses this boundary
 *
 * Fulgora's and Vulcanus's parity specs compute their bearings' sine and cosine
 * in V8 and hand them to the module, because #270 measured the wasm libm
 * disagreeing with V8 and `starting_spot_at_angle` is un-narrowed f64. Nauvis
 * reaches no transcendental at all, so there is nothing to lift. If a future
 * Nauvis field reaches one, it needs the same treatment.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  nauvis_field_count: () => number;
  /**
   * **A REQUEST now, not twenty-nine arguments.**
   *
   * The old signature spelled every lever out, which meant the module built a
   * second `NauvisCtx` beside the renderer's. A lever wired to the wrong layer
   * in both would have folded to the same checksum on both sides of this
   * comparison and stayed invisible - the private-copy trap #330 found in the
   * enemy accessor. The module reads the request already in its scratch buffer
   * and builds the stack through `render::nauvis_ctx`, the renderer's own
   * helper, so a mis-wiring is inside the comparison.
   */
  checksum_nauvis: (requestLen: number, field: number) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/** A WASM `u64` arrives in JavaScript as a SIGNED BigInt. See wasmEngine.spec.ts. */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

const SEED0 = 123456;

/**
 * How many of the swept positions have at least one coordinate off the f32
 * grid. Frozen, because it is the whole reason this spec can see what tier 3
 * cannot - every tier-3 window uses a binary origin and step, so all of its
 * coordinates are f32-exact and a narrowing difference is invisible there by
 * construction.
 */
const OFF_GRID_POSITIONS = 2841;

interface Case {
  readonly label: string;
  /**
   * The map's starting points. Omitted means the origin, which is what every
   * case did before the Nauvis block carried a spawn list (#227).
   *
   * It has to be threaded on BOTH sides or the case grades nothing: the Rust
   * arm reads it out of the request through `render::nauvis_ctx`, so a case
   * that set it here and not in `tsFields` would diverge for a reason that is
   * the spec's fault rather than the port's.
   */
  readonly startingPositions?: readonly { readonly x: number; readonly y: number }[];
  readonly waterLevel: number;
  readonly segmentationMultiplier: number;
  readonly moistureFrequency: number;
  readonly moistureBias: number;
  readonly auxFrequency: number;
  readonly auxBias: number;
  readonly temperatureFrequency: number;
  readonly temperatureBias: number;
  readonly startingAreaMoistureSize: number;
  readonly startingAreaMoistureFrequency: number;
  readonly resourceFrequency: number;
  readonly resourceSize: number;
  readonly resourceRichness: number;
  readonly treesFrequency: number;
  readonly treesSize: number;
  readonly cliffFrequency: number;
  readonly cliffContinuity: number;
  readonly cliffElevationInterval: number;
  readonly cliffRichness: number;
  readonly rocksFrequency: number;
  readonly rocksSize: number;
  readonly enemyFrequency: number;
  readonly enemySize: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly n: number;
}

const DEFAULT_CONTROLS = {
  waterLevel: 0,
  segmentationMultiplier: 1,
  moistureFrequency: 1,
  moistureBias: 0,
  auxFrequency: 1,
  auxBias: 0,
  temperatureFrequency: 1,
  temperatureBias: 0,
  startingAreaMoistureSize: 1,
  startingAreaMoistureFrequency: 1,
  resourceFrequency: 1,
  resourceSize: 1,
  resourceRichness: 1,
  treesFrequency: 1,
  treesSize: 1,
  cliffFrequency: 1,
  cliffContinuity: 1,
  cliffElevationInterval: 40,
  cliffRichness: 1,
  rocksFrequency: 1,
  rocksSize: 1,
  enemyFrequency: 1,
  enemySize: 1,
} as const;

// Two windows, and neither is on the f32 grid - see the header. The near one
// straddles spawn so the starting-lake, starting-island and starting-area
// moisture terms are all live; the far one is past every one of their reaches,
// where different branches of the same expressions decide the result.
const CASES: readonly Case[] = [
  {
    label: "default controls, near spawn",
    ...DEFAULT_CONTROLS,
    x0: -213.3,
    y0: -147.7,
    step: 7.3,
    n: 22,
  },
  {
    label: "default controls, far field",
    ...DEFAULT_CONTROLS,
    x0: 4801.3,
    y0: -3902.7,
    step: 11.9,
    n: 22,
  },
  {
    label: "every control moved, near spawn",
    waterLevel: 5,
    segmentationMultiplier: 2,
    moistureFrequency: 3,
    moistureBias: 0.2,
    auxFrequency: 0.5,
    auxBias: -0.15,
    temperatureFrequency: 4,
    temperatureBias: 7,
    startingAreaMoistureSize: 4,
    startingAreaMoistureFrequency: 3,
    // Every resource lever off its default too. `resourceSize` must stay
    // ABOVE 0: at or below it the Rust resolver drops the resource and the
    // resource fields fold zeros on one side only.
    resourceFrequency: 1.5,
    resourceSize: 2,
    resourceRichness: 3,
    // Both tree levers are dead at the default, so this case is the only one
    // that grades the per-species `input_scale` scaling or the flat
    // `0.2 * size` term through tier 2.
    treesFrequency: 3,
    treesSize: 2,
    // **The cliff frequency has to go to the slider's MINIMUM to grade
    // anything.** Its only path is `low_freq_lever`, and two nested `min`s mask
    // it everywhere else: measured over 1600 positions, the count of moved
    // field values is 0 at 1.0, 0.8, 0.6, 0.5, 0.45, 0.42, 0.4, 0.35, 0.3 and
    // 0.25, and 21 of 9600 at 1/6. A milder setting here would look like it
    // graded the lever and would not.
    //
    // The elevation interval reaches the same place as `40 / interval`, so it
    // is left at its default: moving both would test one path twice. The
    // continuity and richness levers reach `cliff_cutoff` instead, which is a
    // separate path and is exercised here.
    cliffFrequency: 1 / 6,
    cliffContinuity: 2,
    cliffElevationInterval: 40,
    cliffRichness: 2,
    rocksFrequency: 2,
    rocksSize: 3,
    // Both enemy levers are dead at the default, so this case is the only one
    // that grades `sqrt(size)` or the plain frequency multiplier through tier 2.
    enemyFrequency: 3,
    enemySize: 2,
    x0: -213.3,
    y0: -147.7,
    step: 7.3,
    n: 22,
  },
  // Two WIDE windows, and they exist for the resource block alone.
  //
  // Ore is sparse against a 22 x 22 sweep: the two windows above contain a
  // patch of iron and one of coal between them and nothing else, so four of the
  // six `probability` fields folded 484 zeros in both and graded nothing. That
  // is the tile layer's argmax lesson in another costume - a fold can be
  // perfectly bit-identical and still be comparing nothing.
  //
  // No single window fixes it. Measured over six candidates, the best hit five
  // of six resources; patches run about 40 tiles across and any step wide
  // enough to cover ground steps over them. These two together reach all six -
  // `every resource is actually drawn somewhere in the sweep` is the assertion
  // that keeps them doing so.
  {
    label: "default controls, wide north-west",
    ...DEFAULT_CONTROLS,
    x0: -1798.7,
    y0: 2201.3,
    step: 63.7,
    n: 22,
  },
  {
    label: "default controls, wide south",
    ...DEFAULT_CONTROLS,
    x0: 301.3,
    y0: -2498.7,
    step: 91.3,
    n: 22,
  },
  {
    // The ONLY case that moves the spawn (#227). Two points rather than one,
    // because a single moved point is the case a hard-coded origin can still
    // get wrong in the same direction everywhere - two make the distance term
    // a real minimum over a set. Near spawn on purpose: `elevation_nauvis`'s
    // distance term, `moisture`'s starting-area blend and the starting patches
    // are all spawn-relative and saturate in the far field, so a far window
    // would fold a constant through them and grade nothing.
    label: "default controls, moved spawn",
    ...DEFAULT_CONTROLS,
    startingPositions: [
      { x: 512, y: -256 },
      { x: -300.5, y: 96.25 },
    ],
    x0: 301.7,
    y0: -173.3,
    step: 6.7,
    n: 22,
  },
];

const FIELD_NAMES = [
  "hills",
  "cliffLevel",
  "plateaus",
  "bridgeBillows",
  "forestPathBillows",
  "hillsOffsetRawX",
  "hillsOffsetRawY",
  "hillsOffset",
  "cliffRingbreak",
  "elevationNauvis",
  "elevationNauvisNoCliff",
  "elevationLakes",
  "elevationIsland",
  "aux",
  "moisture",
  "temperature",
  // The 21 tiles, spelled out rather than derived from the catalog. Derived,
  // a reordering would silently relabel every failure instead of failing;
  // `the tile field names match the catalog's own order` is the check.
  "tile:deepwater",
  "tile:water",
  "tile:grass-1",
  "tile:grass-2",
  "tile:grass-3",
  "tile:grass-4",
  "tile:dry-dirt",
  "tile:dirt-1",
  "tile:dirt-2",
  "tile:dirt-3",
  "tile:dirt-4",
  "tile:dirt-5",
  "tile:dirt-6",
  "tile:dirt-7",
  "tile:sand-1",
  "tile:sand-2",
  "tile:sand-3",
  "tile:red-desert-0",
  "tile:red-desert-1",
  "tile:red-desert-2",
  "tile:red-desert-3",
  "resolvedTileIndex",
  // The resource block, in catalog order within each wrapper. Spelled out for
  // the same reason the tiles are: derived, a reordering would relabel every
  // failure instead of failing.
  "resource:iron-ore:field",
  "resource:copper-ore:field",
  "resource:coal:field",
  "resource:stone:field",
  "resource:crude-oil:field",
  "resource:uranium-ore:field",
  "resource:iron-ore:probability",
  "resource:copper-ore:probability",
  "resource:coal:probability",
  "resource:stone:probability",
  "resource:crude-oil:probability",
  "resource:uranium-ore:probability",
  "resource:iron-ore:richness",
  "resource:copper-ore:richness",
  "resource:coal:richness",
  "resource:stone:richness",
  "resource:crude-oil:richness",
  "resource:uranium-ore:richness",
  "resolvedResourceIndex",
  // The tree block. The 15 species are spelled out for the same reason the
  // tiles are: derived, a reordering would relabel every failure rather than
  // failing.
  "tree:small_noise",
  "tree:forest_path_cutout",
  "tree:forest_path_cutout_faded",
  "tree:tree_01",
  "tree:tree_04",
  "tree:tree_05",
  "tree:tree_02",
  "tree:tree_03",
  "tree:tree_07",
  "tree:tree_02_red",
  "tree:tree_08",
  "tree:tree_09",
  "tree:tree_06",
  "tree:tree_08_brown",
  "tree:tree_09_brown",
  "tree:tree_06_brown",
  "tree:tree_08_red",
  "tree:tree_09_red",
  "treeDensity",
  // The cliff and rock block.
  "cliffElevation",
  "cliffiness",
  "rock:huge",
  "rock:big",
  "rock:sand",
  "rockDensity",
  // The enemy-base block.
  "enemyBaseField",
  "enemyProbability",
] as const;

/**
 * The case as a Nauvis render request.
 *
 * The sweep geometry rides in the request too: `n` becomes the width and
 * height, `x0`/`y0` the origin, and `step` the tiles-per-pixel. **A request
 * expresses an off-grid sweep perfectly well** - those are plain `f64` on the
 * wire - so the non-binary values the header insists on are unaffected by
 * carrying them this way.
 *
 * Two fields have no case counterpart. `cliffElevation0` is sent at the game's
 * default because neither cliff field reads it, which
 * `the_cliff_and_rock_levers_reach_their_block` asserts stays true. And the six
 * resource triples are six copies of the case's one, because a case moves every
 * resource together on purpose - the three levers reach three different
 * formulas, so moving them uniformly exercises every path.
 */
function nauvisRequest(c: Case, view: "terrain" = "terrain") {
  const triple = [c.resourceFrequency, c.resourceSize, c.resourceRichness] as const;
  return {
    planet: "nauvis",
    view,
    seed0: SEED0,
    width: c.n,
    height: c.n,
    originX: c.x0,
    originY: c.y0,
    tilesPerPixel: c.step,
    waterLevel: c.waterLevel,
    segmentationMultiplier: c.segmentationMultiplier,
    moistureFrequency: c.moistureFrequency,
    moistureBias: c.moistureBias,
    auxFrequency: c.auxFrequency,
    auxBias: c.auxBias,
    startingAreaMoistureSize: c.startingAreaMoistureSize,
    startingAreaMoistureFrequency: c.startingAreaMoistureFrequency,
    temperatureFrequency: c.temperatureFrequency,
    temperatureBias: c.temperatureBias,
    treesFrequency: c.treesFrequency,
    treesSize: c.treesSize,
    rocksFrequency: c.rocksFrequency,
    rocksSize: c.rocksSize,
    enemyFrequency: c.enemyFrequency,
    enemySize: c.enemySize,
    cliffFrequency: c.cliffFrequency,
    cliffContinuity: c.cliffContinuity,
    cliffElevation0: 10,
    cliffElevationInterval: c.cliffElevationInterval,
    cliffRichness: c.cliffRichness,
    resourceLevers: [triple, triple, triple, triple, triple, triple],
    startingPositions: c.startingPositions,
  } as const;
}

const wasmChecksum = (engine: EngineExports, c: Case, field: number): bigint => {
  const scratch = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
  const written = encodeRenderRequest(scratch, nauvisRequest(c) as unknown as WasmRenderRequest);
  return u64(engine.checksum_nauvis(written, field));
};

const PLANET = "nauvis";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once at module scope so a partial
 * record run cannot pass its own count check. See `expectRecordedRows` in
 * `tier2Frozen.ts`.
 */
expectRecordedRows(PLANET, FIELD_NAMES.length * CASES.length);

/**
 * #227 deleted the TypeScript arm of every field in this spec, so the folds are
 * graded against the frozen table alone. `tier2Frozen.ts` explains why that is
 * still worth running: this is the only place the port's Nauvis arithmetic
 * executes inside `wasm32-unknown-unknown` rather than against the host libm.
 *
 * **Seven anti-vacuity guards went with that arm** - the two field-name order
 * checks, the enemy sweep, the cliff gate and rock density, the tree density,
 * the resolved-tile-index range check, and "every resource is actually drawn".
 * Each counted per-point hits, and `checksum_nauvis` returns a fold, which
 * cannot be decomposed back into counts. Restoring them needs an engine export
 * that answers a predicate over the sweep rather than a checksum of it. The
 * numbers they froze are recorded in the issue so they can be re-measured
 * rather than re-derived.
 */
describe("The Nauvis expression core folds to its frozen checksums", () => {
  it("covers every field the module exposes", async () => {
    // The module owns the count, so a field added to the Rust chain cannot
    // silently go untested - this assertion names the gap instead.
    const engine = await instantiate();
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  });

  it("folds every field to its frozen checksum, over every case", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      for (let f = 0; f < FIELD_NAMES.length; f++) {
        const name = FIELD_NAMES[f] as string;
        const wasm = wasmChecksum(engine, c, f);

        // There is no second arm left to compare - #227 deleted the whole
        // Nauvis expression core from TypeScript. A record run therefore
        // captures the engine unchecked, which is why re-recording is a
        // deliberate act and not a repair. See `tier2Frozen.ts`.
        if (RECORDING) {
          record(PLANET, c.label, name, wasm);
          continue;
        }

        const want = frozen(PLANET, c.label, name);
        expect(want, `no frozen checksum for ${c.label}: ${name}`).toBeDefined();
        expect(wasm, `wasm ${c.label}: ${name}`).toBe(want);
      }
    }
  }, 120000);

  it.skipIf(RECORDING)("freezes every field at every case, so #227 keeps this coverage", () => {
    // A missing row makes the fold test fail on `toBeDefined` rather than pass
    // quietly, but only for a field the sweep still visits. This is the guard
    // for the other direction: the table must cover the whole grid, so a case
    // or field dropped from the sweep cannot shrink the frozen surface unseen.
    expect(frozenCount(PLANET)).toBe(FIELD_NAMES.length * CASES.length);
  });

  it("sweeps coordinates that are mostly NOT on the f32 grid, unlike tier 3", () => {
    // Anti-vacuity for the header's claim, and the reason this spec can see
    // what tier 3 cannot. Every tier-3 window uses a binary origin and step, so
    // every one of its coordinates is f32-exact and a narrowing difference is
    // invisible there by construction. Asserted rather than described, because
    // the property lives in a few literals that otherwise look arbitrary.
    const offGrid = (w: { x0: number; y0: number; step: number; n: number }): number => {
      let count = 0;
      for (let j = 0; j < w.n; j++) {
        for (let i = 0; i < w.n; i++) {
          const x = w.x0 + i * w.step;
          const y = w.y0 + j * w.step;
          if (!Object.is(Math.fround(x), x) || !Object.is(Math.fround(y), y)) count++;
        }
      }
      return count;
    };

    // Not all of them: an individual x lands back on the grid now and then
    // (`-213.3 + 7.3` is exactly -206), and at some positions both coordinates
    // do at once. Those cannot discriminate a narrowing, which is exactly why
    // the count is frozen rather than asserted as "all".
    const total = CASES.reduce((n, c) => n + c.n * c.n, 0);
    expect(total).toBe(6 * 22 * 22);
    expect(CASES.reduce((n, c) => n + offGrid(c), 0)).toBe(OFF_GRID_POSITIONS);

    // The control, and the whole point: a tier-3-shaped window - binary origin,
    // binary step - is entirely ON the grid, so a sweep over it could not fail
    // for a narrowing reason no matter how many fields it folded.
    expect(offGrid({ x0: 512.5, y0: -1024.25, step: 0.5, n: 22 })).toBe(0);
    expect(offGrid({ x0: 3000.75, y0: 3000.75, step: 8, n: 22 })).toBe(0);
  });

  it("the cliff and rock block sits where the selector says", () => {
    // Same guard as the tile and tree blocks: spelled out rather than derived,
    // so a reordering fails here instead of relabelling every failure below.
    const base = FIELD_NAMES.indexOf("cliffElevation");
    expect(base).toBe(76);
    // A BOUNDED slice, not `slice(base)`. Written open-ended this asserted
    // "these six are the last six", which the enemy block then falsified - a
    // change with nothing to do with cliffs or rocks. Same trap as the two tree
    // assertions that were written as `FIELD_NAMES.length - 1`.
    expect(FIELD_NAMES.slice(base, base + 6)).toEqual([
      "cliffElevation",
      "cliffiness",
      "rock:huge",
      "rock:big",
      "rock:sand",
      "rockDensity",
    ]);
    expect(FIELD_NAMES[base + 6]).toBe("enemyBaseField");
  });

  it("the enemy block sits where the selector says", () => {
    const base = FIELD_NAMES.indexOf("enemyBaseField");
    expect(base).toBe(82);
    expect(FIELD_NAMES.slice(base, base + 2)).toEqual(["enemyBaseField", "enemyProbability"]);
    expect(FIELD_NAMES).toHaveLength(84);
  });

  it("the cases actually differ from each other, field by field", async () => {
    // Cases that folded to the same numbers would be one case run five times.
    //
    // The requirement is "at least two cases disagree", not "the first two
    // disagree", and that weakening is forced by the resource block rather than
    // chosen: a `probability` is 0 wherever its resource is absent, so a field
    // can legitimately fold identically across any pair of windows that both
    // miss its patches. What it may NOT do is fold identically across all five.
    const engine = await instantiate();
    for (let f = 0; f < FIELD_NAMES.length; f++) {
      const folds = CASES.map((c) => wasmChecksum(engine, c, f));
      expect(new Set(folds).size, `${FIELD_NAMES[f]} folds the same in every case`).toBeGreaterThan(
        1,
      );
    }
    // The two default-control geometries still have to move every field that is
    // not a resource probability - that is the sharper form and it still holds
    // for 39 of the 57.
    for (let f = 0; f < FIELD_NAMES.length; f++) {
      if (FIELD_NAMES[f].endsWith(":probability")) continue;
      expect(
        wasmChecksum(engine, CASES[0], f),
        `${FIELD_NAMES[f]} is the same near and far`,
      ).not.toBe(wasmChecksum(engine, CASES[1], f));
    }
    // `temperature` reads none of the geometry-independent controls except its
    // own two, so it is the sharpest check that the control block is wired.
    expect(wasmChecksum(engine, CASES[0], 15)).not.toBe(wasmChecksum(engine, CASES[2], 15));
  });
});
