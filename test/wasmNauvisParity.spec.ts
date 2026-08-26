import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import { makeAux } from "../src/noise/expressions/aux";
import { makeElevationIsland } from "../src/noise/expressions/elevationIsland";
import { makeElevationLakes } from "../src/noise/expressions/elevationLakes";
import { makeElevationNauvis } from "../src/noise/expressions/elevationNauvis";
import { makeMoisture } from "../src/noise/expressions/moisture";
import {
  makeNauvisShared,
  NAUVIS_OFFSET_X_SEED1,
  NAUVIS_OFFSET_Y_SEED1,
} from "../src/noise/expressions/nauvisShared";
import { makeTemperature } from "../src/noise/expressions/temperature";
import { makeTileCatalog } from "../src/noise/tiles/catalog";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";
import { makeResourcePatches } from "../src/noise/resources/resourcePatches";
import { makeResourceResolver } from "../src/noise/resources/resolveResource";
import { TREE_SPECIES } from "../src/noise/trees/treeCatalog";
import { makeTreeShared } from "../src/noise/trees/treeShared";
import { makeTreeDensity, makeTreeSpeciesFields } from "../src/noise/trees/treeField";
import { makeCliffElevation, makeCliffiness } from "../src/noise/cliffs/cliffFields";
import { makeRockFields } from "../src/noise/rocks/rockField";
import { makeEnemyBaseField } from "../src/noise/enemies/enemyBaseField";
import { ENEMY_BASEMENT, ENEMY_PLACEMENT_CAP } from "../src/noise/enemies/enemyCatalog";

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
  nauvis_field_count: () => number;
  checksum_nauvis: (
    seed0: number,
    waterLevel: number,
    segmentationMultiplier: number,
    moistureFrequency: number,
    moistureBias: number,
    auxFrequency: number,
    auxBias: number,
    temperatureFrequency: number,
    temperatureBias: number,
    startingAreaMoistureSize: number,
    startingAreaMoistureFrequency: number,
    resourceFrequency: number,
    resourceSize: number,
    resourceRichness: number,
    treesFrequency: number,
    treesSize: number,
    cliffFrequency: number,
    cliffContinuity: number,
    cliffElevationInterval: number,
    cliffRichness: number,
    rocksFrequency: number,
    rocksSize: number,
    enemyFrequency: number,
    enemySize: number,
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

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const scratch = new DataView(new ArrayBuffer(8));
function foldF64(acc: bigint, value: number): bigint {
  let hash = acc === 0n ? FNV_OFFSET_BASIS : acc;
  scratch.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) {
    hash ^= BigInt(scratch.getUint8(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/** Rows outer, exactly as `checksum_nauvis` sweeps. */
function foldGrid(f: (x: number, y: number) => number, c: Case): bigint {
  let acc = 0n;
  for (let j = 0; j < c.n; j++) {
    const y = c.y0 + j * c.step;
    for (let i = 0; i < c.n; i++) {
      acc = foldF64(acc, f(c.x0 + i * c.step, y));
    }
  }
  return acc;
}

const SEED0 = 123456;

/**
 * How many of the swept positions have at least one coordinate off the f32
 * grid. Frozen, because it is the whole reason this spec can see what tier 3
 * cannot - every tier-3 window uses a binary origin and step, so all of its
 * coordinates are f32-exact and a narrowing difference is invisible there by
 * construction.
 */
const OFF_GRID_POSITIONS = 2365;

/** How many swept positions have a non-zero tree density. Frozen; see the test. */
const TREE_DENSITY_HITS = 602;

/** Swept positions whose coordinates ARE both f32-exact. Frozen with its complement. */
const ON_GRID_POSITIONS = 55;

/** How many swept positions the cliff gate answers 10 at. Frozen; see the test. */
const CLIFF_GATE_HITS = 327;

/** How many swept positions have a non-zero rock density. Frozen; see the test. */
const ROCK_DENSITY_HITS = 67;

/** Per case, how many swept positions a cone reaches. Frozen; see the test. */
const ENEMY_LIVE_PER_CASE = [331, 412, 484, 401, 393];

/** How many swept positions have a positive enemy probability. Frozen. */
const ENEMY_POSITIVE_POSITIONS = 160;

interface Case {
  readonly label: string;
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
];

/**
 * The TypeScript accessors, in the order `NauvisStack::field` selects them.
 *
 * Fields 5 and 6 are reconstructed here rather than read off `makeNauvisShared`,
 * which does not expose the two raw warp fields. That is the same
 * reconstruction `test/nauvisShared.spec.ts` uses, and it is the one pair in
 * this list whose TypeScript side is spec-local rather than shipped code - so
 * read their agreement as covering the Rust accessor and the seeds, not the
 * shipped call site. Fields 7 and 8 consume them through shipped code.
 */
function tsFields(c: Case): ((x: number, y: number) => number)[] {
  const shared = makeNauvisShared({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
  });
  const offsetInputScale = shared.nauvisSeg / 500;
  const rawXTables = basisNoiseTablesFromSeed(SEED0, NAUVIS_OFFSET_X_SEED1);
  const rawYTables = basisNoiseTablesFromSeed(SEED0, NAUVIS_OFFSET_Y_SEED1);

  const elevationCommon = {
    seed0: SEED0,
    waterLevel: c.waterLevel,
    segmentationMultiplier: c.segmentationMultiplier,
  };

  // Hoisted, because the tile layer reads all three and rebuilding them per
  // tile would be 21 copies of the same chain.
  const elevationNauvis = makeElevationNauvis(elevationCommon);
  const auxAt = makeAux({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
    frequency: c.auxFrequency,
    bias: c.auxBias,
  });
  const moistureAt = makeMoisture({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
    moistureFrequency: c.moistureFrequency,
    moistureBias: c.moistureBias,
    startingAreaMoistureSize: c.startingAreaMoistureSize,
    startingAreaMoistureFrequency: c.startingAreaMoistureFrequency,
  });

  // `makeTileResolver` is deliberately NOT used to build this env, and the
  // reason is a live bug rather than a style choice: `TileResolverParams` has
  // no `waterLevel` field, so the resolver builds its elevation tree at
  // water level 0 whatever the caller asked for. That is issue #320 - it costs
  // 322 of 2,401 resolved tiles at `waterLevel = 5`. Tier 2 grades the tile
  // FORMULAS, so it reads the shipped `probability` closures over an env built
  // from the shipped expression trees, and leaves the plumbing gap to its own
  // change.
  const catalog = makeTileCatalog(SEED0);
  const envAt = (x: number, y: number) => ({
    x,
    y,
    elevation: elevationNauvis(x, y),
    aux: auxAt(x, y),
    moisture: moistureAt(x, y),
  });

  return [
    shared.hills,
    shared.cliffLevel,
    shared.plateaus,
    shared.bridgeBillows,
    shared.forestPathBillows,
    (x, y) => basisNoise(x * offsetInputScale, y * offsetInputScale, rawXTables),
    (x, y) => basisNoise(x * offsetInputScale, y * offsetInputScale, rawYTables),
    shared.hillsOffset,
    shared.cliffRingbreak,
    elevationNauvis,
    makeElevationNauvis({ ...elevationCommon, withCliffElevation: false }),
    makeElevationLakes(elevationCommon),
    makeElevationIsland(elevationCommon),
    auxAt,
    moistureAt,
    makeTemperature({
      seed0: SEED0,
      frequency: c.temperatureFrequency,
      bias: c.temperatureBias,
    }),
    // The 21 tile probabilities, in catalog order, then the argmax over them.
    ...catalog.map((t) => (x: number, y: number) => t.probability(envAt(x, y))),
    (x: number, y: number) => {
      const env = envAt(x, y);
      let winner = 0;
      let best = catalog[0].probability(env);
      for (let i = 1; i < catalog.length; i++) {
        const p = catalog[i].probability(env);
        if (p > best) {
          best = p;
          winner = i;
        }
      }
      return winner;
    },
    // The resource layer: six `field`s, six `probability`s, six `richness`es,
    // then the resolver's winner.
    ...resourceFields(c),
    // The tree layer: the three shared fields, the 15 species, the density.
    ...treeFields(c),
    // The cliff and rock layer.
    ...cliffRockFields(c),
    // The enemy-base layer.
    ...enemyFields(c),
  ];
}

/**
 * The enemy-base block's accessors, in the order the Rust selector expects.
 *
 * **Two fields, not three - the spot field is deliberately NOT folded on its
 * own.** The first draft did fold it, on the argument that a `max` hides its
 * operands the way the tile argmax and the rock max do. That argument is
 * backwards here, and checking the magnitudes is what showed it: the spot field
 * runs from -1000 to about +1, while the blob term is roughly +/-0.15 and the
 * starting-area term is 0 beyond 150 tiles. So the composed field is DOMINATED
 * by the spot field rather than hiding it, and a spot that survived the trim on
 * one port and not the other moves `enemyBaseField` by hundreds.
 *
 * Folding it separately would also have cost something real: `makeEnemyBaseField`
 * does not expose it, so this side would have had to reimplement the region
 * scan - about 40 lines reproducing `selectSpots` wiring that the shipped
 * TypeScript would then never be compared against. That is the private-copy
 * trap `checksum_vulcanus` records, and paying it for coverage the composed
 * field already gives would be the worst of both.
 *
 * `probability` folds even though it is 0 almost everywhere, because the cap
 * and the clamp are its own wiring and nothing else covers them.
 *
 * ## What this block can and cannot see, measured by planting
 *
 * | planted break | this spec |
 * | --- | --- |
 * | `- 0.3` becomes `- 0.30001` | RED, names `enemyBaseField` |
 * | `15 + 4*intensity` becomes `4.00001` | RED, names `enemyBaseField` |
 * | `quantity * (1 + 1e-7)` | RED |
 * | `quantity * (1 + 1e-9)`, `(1 + 1e-12)` | not seen |
 * | `radius ** 3` becomes `radius * radius * radius` | **not seen** |
 *
 * The last two rows are one result. The cone's `peak` is `f32(f32(3q) / ...)`,
 * and an f32 carries about 1.2e-7 of relative precision, so a relative change in
 * `quantity` below that rounds away before it reaches any folded value. One f64
 * ULP is 2.2e-16 - two orders of magnitude under the floor - which is why
 * swapping `Math.pow` for a plain product is invisible here even though the two
 * genuinely disagree at 25.4% of the radii in play.
 *
 * That is worth knowing rather than worrying about: it also means a one-ULP
 * wasm-libm difference in `powf` cannot reach these fields either.
 */
function enemyFields(c: Case): ((x: number, y: number) => number)[] {
  const f = makeEnemyBaseField({
    seed0: SEED0,
    controls: { frequency: c.enemyFrequency, size: c.enemySize },
  });
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return [
    (x, y) => f.field(x, y),
    (x, y) => clamp(Math.min(f.field(x, y), ENEMY_PLACEMENT_CAP), 0, 1),
  ];
}

/**
 * The cliff and rock block's accessors, in the order the Rust selector expects.
 *
 * The three rock probabilities are folded separately from the density above
 * them, and that is not symmetry with the tile block - it is stronger here.
 * `density` CLAMPS to `[0, 1]` on top of taking a max, and Nauvis rocks are
 * sparse: measured at seed 123456, only 76 to 166 positions of a 64x64 window
 * have a non-zero density. So a fold of the density alone is mostly a fold of
 * zeros, and `huge` and `big` differ only by a constant factor and a constant
 * offset, so the max picks the same one of them nearly everywhere.
 *
 * **`cliffiness` crosses as its 0/10 GATE and nothing finer.** `makeCliffiness`
 * returns only the gate, so recovering `main_cliffiness` here would mean
 * rebuilding its six sub-terms in this spec from the same parts the Rust reads
 * - the private-copy trap `checksum_vulcanus` records, where both sides
 * reproduce the same wiring and the comparison sees nothing.
 *
 * **How blind that leaves it was measured by planting**, not estimated. Shifting
 * `base_cliffiness` by changing its `- 0.01` term, over the 2,420 swept
 * positions:
 *
 * | shift in `main_cliffiness` | this spec |
 * | --- | --- |
 * | 6e-6, 3e-5, 6e-5, 6e-4 | GREEN - not seen |
 * | 6e-3 and larger | RED, naming `cliffiness` |
 *
 * So the fold catches a wrong term at the 1e-2 scale and nothing finer. Two
 * controls ran beside it and both went RED naming the right field: a 1e-7
 * relative change to `cliff_elevation`'s `30 *`, and a 1.4e-5 relative change
 * to `rock:huge`'s `0.07 *`. The blindness is the gate's, not the sweep's.
 *
 * `cliff_elevation` is what grades that region at all - it is continuous and
 * shares four of the six sub-terms' `makeNauvisShared`.
 */
function cliffRockFields(c: Case): ((x: number, y: number) => number)[] {
  const cliffCtx = {
    seed0: SEED0,
    controls: { frequency: c.cliffFrequency, continuity: c.cliffContinuity },
    settings: {
      cliffElevation0: 10,
      cliffElevationInterval: c.cliffElevationInterval,
      richness: c.cliffRichness,
    },
    segmentationMultiplier: c.segmentationMultiplier,
    waterLevel: c.waterLevel,
  };
  const rocks = makeRockFields({
    seed0: SEED0,
    rocksFrequency: c.rocksFrequency,
    rocksSize: c.rocksSize,
    segmentationMultiplier: c.segmentationMultiplier,
    moistureFrequency: c.moistureFrequency,
    moistureBias: c.moistureBias,
    auxFrequency: c.auxFrequency,
    auxBias: c.auxBias,
    startingAreaMoistureSize: c.startingAreaMoistureSize,
    startingAreaMoistureFrequency: c.startingAreaMoistureFrequency,
  });
  return [
    makeCliffElevation(cliffCtx),
    makeCliffiness(cliffCtx),
    (x, y) => rocks.at(x, y).huge,
    (x, y) => rocks.at(x, y).big,
    (x, y) => rocks.at(x, y).sand,
    rocks.density,
  ];
}

/**
 * The tree block's accessors, in the order the Rust selector expects.
 *
 * All 15 species are folded individually rather than only the density over
 * them, for the reason the tile layer measured: a `max` absorbs almost
 * anything. The density is one number per pixel that moves only when the
 * WINNING species changes value, so folding it alone would grade fifteen
 * climate boxes with a number that cannot see fourteen of them.
 *
 * Both forest-path cutouts are folded, not only the faded one the species read,
 * because `makeTreeDensity` reaches the RAW cutout directly - it inlines
 * `cutout * 0.3 + smallTerm` to avoid a second `tree_small_noise` call. A fold
 * of the faded one alone would not cover that call site.
 */
function treeFields(c: Case): ((x: number, y: number) => number)[] {
  const params = {
    seed0: SEED0,
    treesFrequency: c.treesFrequency,
    treesSize: c.treesSize,
    segmentationMultiplier: c.segmentationMultiplier,
    moistureFrequency: c.moistureFrequency,
    moistureBias: c.moistureBias,
    temperatureFrequency: c.temperatureFrequency,
    temperatureBias: c.temperatureBias,
    startingAreaMoistureSize: c.startingAreaMoistureSize,
    startingAreaMoistureFrequency: c.startingAreaMoistureFrequency,
  };
  const shared = makeTreeShared({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
  });
  const species = makeTreeSpeciesFields(params);
  const density = makeTreeDensity(params);
  return [
    shared.smallNoise,
    shared.forestPathCutout,
    shared.forestPathCutoutFaded,
    ...species.map((f) => f.evalAt),
    density,
  ];
}

/**
 * The resource block's accessors, in the order the Rust selector expects.
 *
 * **These six are built HERE from the documented skip constants, while the Rust
 * side reads five of them off the shipped `ResourceResolver`.** That asymmetry
 * is deliberate and it is what makes the comparison worth something. The
 * TypeScript resolver returns a bare closure and exposes none of its per-resource
 * fields, so there is no way to reach them through it - and building the same
 * private copy on both sides would have reproduced any mis-wiring identically
 * and stayed invisible, which is the trap `checksum_vulcanus` records. Reaching
 * the same numbers by two different routes is evidence that the resolver really
 * does partition the two candidate streams the way its own documentation says.
 *
 * Crude oil is the one resource the resolver deliberately does not hold - it is
 * the `placement: "roll"` entry - so the Rust side builds it separately with
 * these same skip parameters. Its FIELD is still folded here: the renderer's
 * oil pass will need it, and leaving it out would carry it into #227 ungraded.
 *
 * All three wrappers are folded for all six, not just the resolver's winner.
 * The winner is one integer per position that moves only when a probability
 * crosses 0.5, so folding it alone would grade eighteen formulas with a number
 * that cannot see any of them - the tile layer measured exactly that, where a
 * one-digit slip in a climate box moved one probability and left the argmax
 * still. `richness` never reaches the winner at all.
 */
function resourceFields(c: Case): ((x: number, y: number) => number)[] {
  const levers = {
    frequency: c.resourceFrequency,
    size: c.resourceSize,
    richness: c.resourceRichness,
  };
  const common = {
    seed0: SEED0,
    controls: levers,
    segmentationMultiplier: c.segmentationMultiplier,
    waterLevel: c.waterLevel,
  };
  // `skip_span` 6 for the regular set and 4 for the starting set, offset by
  // `patchSetIndex` - the constants `makeResourceResolver` uses. Restated here
  // rather than imported, because they are private to that module and because
  // the Rust half reaches them through the resolver instead; see above.
  const patches = RESOURCE_CATALOG.map((params) =>
    makeResourcePatches(params, {
      ...common,
      regularSkipSpan: 6,
      regularSkipOffset: params.patchSetIndex,
      startingSkipSpan: 4,
      startingSkipOffset: params.patchSetIndex,
    }),
  );
  const resolver = makeResourceResolver({
    seed0: SEED0,
    controls: Object.fromEntries(RESOURCE_CATALOG.map((r) => [r.controlName, levers])),
    segmentationMultiplier: c.segmentationMultiplier,
    waterLevel: c.waterLevel,
  });
  return [
    ...patches.map((p) => (x: number, y: number) => p.field(x, y)),
    ...patches.map((p) => (x: number, y: number) => p.probability(x, y)),
    ...patches.map((p) => (x: number, y: number) => p.richness(x, y)),
    // The winner as its CATALOG index, or 6 for "nothing is drawn here" -
    // catalog index rather than position in the resolver's own list, so a
    // resource dropped by a `size` lever cannot silently renumber the others.
    (x: number, y: number) => resolver(x, y)?.patchSetIndex ?? RESOURCE_CATALOG.length,
  ];
}

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

const wasmChecksum = (engine: EngineExports, c: Case, field: number): bigint =>
  u64(
    engine.checksum_nauvis(
      SEED0,
      c.waterLevel,
      c.segmentationMultiplier,
      c.moistureFrequency,
      c.moistureBias,
      c.auxFrequency,
      c.auxBias,
      c.temperatureFrequency,
      c.temperatureBias,
      c.startingAreaMoistureSize,
      c.startingAreaMoistureFrequency,
      c.resourceFrequency,
      c.resourceSize,
      c.resourceRichness,
      c.treesFrequency,
      c.treesSize,
      c.cliffFrequency,
      c.cliffContinuity,
      c.cliffElevationInterval,
      c.cliffRichness,
      c.rocksFrequency,
      c.rocksSize,
      c.enemyFrequency,
      c.enemySize,
      field,
      c.x0,
      c.y0,
      c.step,
      c.n,
    ),
  );

describe("Rust and TypeScript agree bit for bit across the Nauvis expression core", () => {
  it("covers every field the module exposes", async () => {
    // The module owns the count, so a field added to the Rust chain cannot
    // silently go untested - this assertion names the gap instead.
    const engine = await instantiate();
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  });

  it("folds every field to the identical checksum, over every case", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fields = tsFields(c);
      expect(fields.length, "accessor list length").toBe(FIELD_NAMES.length);
      for (let f = 0; f < fields.length; f++) {
        expect(wasmChecksum(engine, c, f), `${c.label}: ${FIELD_NAMES[f]}`).toBe(
          foldGrid(fields[f], c),
        );
      }
    }
  }, 120000);

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
    expect(total).toBe(5 * 22 * 22);
    expect(CASES.reduce((n, c) => n + offGrid(c), 0)).toBe(OFF_GRID_POSITIONS);

    // The control, and the whole point: a tier-3-shaped window - binary origin,
    // binary step - is entirely ON the grid, so a sweep over it could not fail
    // for a narrowing reason no matter how many fields it folded.
    expect(offGrid({ x0: 512.5, y0: -1024.25, step: 0.5, n: 22 })).toBe(0);
    expect(offGrid({ x0: 3000.75, y0: 3000.75, step: 8, n: 22 })).toBe(0);
  });

  it("the tile field names match the catalog's own order", () => {
    // FIELD_NAMES spells the 21 tiles out rather than deriving them, so that a
    // reordering fails here instead of silently relabelling every downstream
    // failure. This is the check that keeps the two in step.
    const fromCatalog = makeTileCatalog(SEED0).map((t) => `tile:${t.name}`);
    const fromNames = FIELD_NAMES.filter((n) => n.startsWith("tile:"));
    expect(fromNames).toEqual(fromCatalog);
    expect(fromCatalog).toHaveLength(21);
    // And the tile block sits immediately after the 16 expression fields, so
    // `FIELD_NAMES[16 + i]` really is `TILE_ORDER[i]`'s probability.
    expect(FIELD_NAMES[16]).toBe("tile:deepwater");
    expect(FIELD_NAMES[36]).toBe("tile:red-desert-3");
    expect(FIELD_NAMES[37]).toBe("resolvedTileIndex");
  });

  it("the tree field names match the catalog's own order", () => {
    // Same guard as the tiles': FIELD_NAMES spells the 15 species out rather
    // than deriving them, so a catalog reordering fails here instead of
    // silently relabelling every downstream failure.
    const fromCatalog = TREE_SPECIES.map((t) => `tree:${t.name}`);
    const fromNames = FIELD_NAMES.filter(
      (n) => n.startsWith("tree:") && !n.startsWith("tree:small") && !n.startsWith("tree:forest"),
    );
    expect(fromNames).toEqual(fromCatalog);
    expect(fromCatalog).toHaveLength(15);
    // And the block sits where the selector says: three shared fields, then the
    // species, then the density.
    const base = FIELD_NAMES.indexOf("tree:small_noise");
    expect(base).toBe(57);
    expect(FIELD_NAMES[base + 1]).toBe("tree:forest_path_cutout");
    expect(FIELD_NAMES[base + 2]).toBe("tree:forest_path_cutout_faded");
    expect(FIELD_NAMES[base + 3]).toBe("tree:tree_01");
    // Indexed from the block's own BASE, not from the end of FIELD_NAMES. The
    // end used to be the tree density; the cliff and rock block moved it, and
    // an assertion written as `length - 1` fails on a change that has nothing
    // to do with trees.
    expect(FIELD_NAMES[base + 18]).toBe("treeDensity");
    expect(FIELD_NAMES[base + 19]).toBe("cliffElevation");
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

  it("the enemy sweep reaches spots rather than folding the basement", async () => {
    // The enemy field is a `max` against a basement of -1000. A window no cone
    // reaches folds that same constant on both sides at every position -
    // perfectly bit-identical, and comparing nothing. The existing windows were
    // chosen for ore and for trees, so whether any of them carries an enemy base
    // is a question rather than an assumption.
    //
    // `oracle-enemy-base` is 96% basement, which is the scale of the risk.
    const engine = await instantiate();
    let live = 0;
    let positive = 0;
    let positions = 0;
    const perCase: number[] = [];
    for (const c of CASES) {
      const [field, probability] = enemyFields(c);
      let here = 0;
      for (let j = 0; j < c.n; j++) {
        for (let i = 0; i < c.n; i++) {
          const x = c.x0 + i * c.step;
          const y = c.y0 + j * c.step;
          positions++;
          // "Well above the basement" rather than "not exactly -1000": the blob
          // and starting-area terms move a basement position by a fraction, so
          // an exact comparison would call every position live.
          if (field(x, y) > ENEMY_BASEMENT + 100) {
            live++;
            here++;
          }
          if (probability(x, y) > 0) positive++;
        }
      }
      perCase.push(here);
    }
    expect(positions).toBe(OFF_GRID_POSITIONS + ON_GRID_POSITIONS);
    // Frozen, so a window drifting off every enemy base is a failure rather
    // than a silent loss of coverage - the resource block's lesson.
    expect(perCase).toEqual(ENEMY_LIVE_PER_CASE);
    expect(live).toBeGreaterThan(0);
    expect(positive).toBe(ENEMY_POSITIVE_POSITIONS);
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  }, 120000);

  it("the cliff gate answers both ways and the rock density is not vacuous", async () => {
    // Two anti-vacuity checks, one per field that can degenerate.
    //
    // `cliffiness` is 0 or 10 and nothing else, so a window where every
    // position gives the same answer folds a constant on both sides and grades
    // nothing - the same objection the resource `probability` fields raised.
    // `rockDensity` clamps to 0 wherever no rock wins, and Nauvis rocks are
    // sparse enough that a window can genuinely miss them all.
    const engine = await instantiate();
    let cliffy = 0;
    let bare = 0;
    let rocks = 0;
    let positions = 0;
    for (const c of CASES) {
      const [, cliffiness, , , , rockDensity] = cliffRockFields(c);
      for (let j = 0; j < c.n; j++) {
        for (let i = 0; i < c.n; i++) {
          const x = c.x0 + i * c.step;
          const y = c.y0 + j * c.step;
          positions++;
          if (cliffiness(x, y) === 10) cliffy++;
          else bare++;
          if (rockDensity(x, y) > 0) rocks++;
        }
      }
    }
    expect(positions).toBe(OFF_GRID_POSITIONS + ON_GRID_POSITIONS);
    // Frozen, so a window drifting off every cliff or every rock is a failure
    // rather than a silent loss of coverage.
    expect(cliffy).toBe(CLIFF_GATE_HITS);
    expect(bare).toBe(positions - CLIFF_GATE_HITS);
    expect(rocks).toBe(ROCK_DENSITY_HITS);
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  }, 120000);

  it("the tree density is not vacuous over the swept windows", async () => {
    // A `probability` field folds zeros where its resource is absent, and a
    // tree density does the same where no species wins. Bit-identical zeros on
    // both sides is agreement about nothing, so at least one window has to
    // contain a forest.
    const engine = await instantiate();
    // The tree block's density is its LAST field, found from the block's own
    // base rather than from the end of FIELD_NAMES - see the name test above.
    let drawn = 0;
    for (const c of CASES) {
      const treeBlock = treeFields(c);
      const density = treeBlock[treeBlock.length - 1];
      for (let j = 0; j < c.n; j++) {
        for (let i = 0; i < c.n; i++) {
          if (density(c.x0 + i * c.step, c.y0 + j * c.step) > 0) drawn++;
        }
      }
    }
    expect(drawn).toBeGreaterThan(0);
    // Frozen, so a window drifting off every forest is a failure rather than a
    // silent loss of coverage.
    expect(drawn).toBe(TREE_DENSITY_HITS);
    // And the module agrees the block exists at all.
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  }, 120000);

  it("the resolved tile index really is an index into the catalog", async () => {
    // `resolvedTileIndex` crosses the ABI as an f64, so a wrong widening or an
    // off-by-one would still fold to *some* number on both sides. This pins
    // that the values are integral and inside 0..21 - which the checksum
    // cannot say, because it folds raw bits.
    const c = CASES[0];
    const fields = tsFields(c);
    const resolved = fields[37];
    const seen = new Set<number>();
    for (let j = 0; j < c.n; j++) {
      for (let i = 0; i < c.n; i++) {
        const v = resolved(c.x0 + i * c.step, c.y0 + j * c.step);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(21);
        seen.add(v);
      }
    }
    // Anti-vacuity: a window that resolved to one constant tile would satisfy
    // everything above and grade nothing.
    expect(seen.size).toBeGreaterThan(1);
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

  it("every resource is actually drawn somewhere in the sweep", () => {
    // Anti-vacuity for the resource block, and the reason the two wide windows
    // exist. A `probability` field folds 484 zeros wherever its resource is
    // absent, so a sweep that contained no ore would be bit-identical on both
    // sides while comparing nothing at all. This asserts each of the six is
    // present in at least one case, and counts them so a window drifting off
    // its patches is a failure rather than a silent loss of coverage.
    const drawn = RESOURCE_CATALOG.map(() => 0);
    for (const c of CASES) {
      const fields = resourceFields(c);
      for (let r = 0; r < RESOURCE_CATALOG.length; r++) {
        const probability = fields[6 + r];
        for (let j = 0; j < c.n; j++) {
          for (let i = 0; i < c.n; i++) {
            if (probability(c.x0 + i * c.step, c.y0 + j * c.step) > 0) drawn[r]++;
          }
        }
      }
    }
    for (let r = 0; r < RESOURCE_CATALOG.length; r++) {
      expect(drawn[r], `${RESOURCE_CATALOG[r].name} is absent from every window`).toBeGreaterThan(
        0,
      );
    }
    // Frozen, so a window that drifts off its patches is caught rather than
    // absorbed. Measured on the TypeScript side across all five cases.
    expect(drawn).toEqual([7, 3, 5, 4, 4, 1]);
  }, 120000);
});
