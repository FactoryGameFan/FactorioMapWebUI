import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { makeCliffinessBasic } from "../src/noise/cliffs/vulcanusCliffFields";
import { distanceFromNearestPoint } from "../src/noise/distanceFromNearestPoint";
import { type EvalCtxInput, withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusTemperature } from "../src/noise/expressions/vulcanusElevation";
import { sulfuricAcidGeyserProbability } from "../src/noise/resources/vulcanusResourceCatalog";
import {
  makeVulcanusDecorativeKnockout,
  makeVulcanusRockFields,
} from "../src/noise/rocks/vulcanusRockField";
import {
  makeMountainLavaSpots,
  makeVulcanusRockNoise,
  makeVulcanusStack,
  makeVulcanusTileCatalog,
  resolveVulcanusTile,
  type VulcanusTileFields,
} from "../src/noise/tiles/vulcanusCatalog";
import { encodeRenderRequest, type VulcanusRenderRequest } from "../src/noise/wasm/request";

/**
 * Tier 2 of the Rust port's gate for Vulcanus (#225): strict bit equality
 * between the two ports over a swept grid, folded order-sensitively, one named
 * field at a time.
 *
 * The Fulgora counterpart is `wasmFulgoraParity.spec.ts` and this follows its
 * shape deliberately. **It detects divergence; it does not establish
 * correctness** - both ports can agree and both be wrong, which is exactly what
 * tier 1 grades separately, field by field, against the game.
 *
 * ## Why tier 3 does not cover this
 *
 * `wasmVulcanusRenderParity.spec.ts` already compares PIXELS and finds them
 * byte-identical. Pixels cannot see this class of divergence, for two reasons
 * that are both measured rather than argued:
 *
 * - **The tile argmax is a discrete choice.** A field can differ in its low bits
 *   at every position and still paint the same tile everywhere - the same
 *   property that made `poison::index_result` necessary, and that left phase 3's
 *   end-to-end tile test green under a live numeric poison hook.
 * - **Several fields never reach a pixel at all.** `temperature` is graded in
 *   tier 1 and read by no renderer; so are the four resource favorabilities and
 *   the pre-volcano `mountainsRawVolcano` stage. Nothing downstream of a render
 *   can notice them moving.
 *
 * Fulgora's `tileRuinPaving` is the standing proof that the gap is real and not
 * theoretical: it folded to a different checksum than the TypeScript because
 * both of its `max` arms were zero with DIFFERENT SIGNS, and phase 3 had shipped
 * 27 such sites whose parity passed only because the sampled windows never hit
 * the case. Vulcanus is dense in `min2`/`max2`.
 *
 * ## The parameters cross the boundary as a REQUEST
 *
 * Fulgora's checksum takes its seven parameters as arguments. Vulcanus needs 31
 * more `f64` - three sliders, four resource control pairs and ten bearings - so
 * this passes the SHIPPED ABI request instead, written by the shipped
 * `encodeRenderRequest`. That is not only shorter: the module then builds its
 * stack through the same `vulcanus_stack_from_params` the renderer uses, so a
 * bearing wired to the wrong layer is inside this comparison rather than beside
 * it.
 *
 * The sweep is the request's OWN pixel grid - origin, `tilesPerPixel`, width and
 * height - swept rows-outer exactly as `render_vulcanus` sweeps it. So there is
 * one geometry convention here, not two.
 *
 * ## The trig crosses the boundary as a value
 *
 * `startingSpotAtAngle` is plain f64 arithmetic with no narrowing, so a one-ULP
 * `sin` difference between V8 and the libm `wasm32-unknown-unknown` links would
 * land straight in the result - and #270 measured those two libms really do
 * disagree, in a place `cargo test` on the host could not see. Every bearing is
 * a per-render constant, so `vulcanusBearingTrig` computes all ten in V8 and the
 * request carries them as values. **If a future change computes a bearing inside
 * the module, this spec is what should go red.**
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  vulcanus_field_count: () => number;
  checksum_vulcanus: (requestLen: number, field: number) => bigint;
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

function foldAll(values: readonly number[]): bigint {
  let acc = 0n;
  for (const v of values) acc = foldF64(acc, v);
  return acc;
}

/** `surfaceSeedForPlanet("vulcanus", 123456)` - the seed tier 3 renders at. */
const SEED0 = 1249936247;

/** The 19 tiles in the data file's registration order, which is `TILE_ORDER`. */
const TILE_NAMES = [
  "volcanic-jagged-ground",
  "lava",
  "lava-hot",
  "volcanic-cracks-hot",
  "volcanic-cracks-warm",
  "volcanic-cracks",
  "volcanic-folds-flat",
  "volcanic-ash-light",
  "volcanic-ash-dark",
  "volcanic-ash-flats",
  "volcanic-pumice-stones",
  "volcanic-smooth-stone",
  "volcanic-smooth-stone-warm",
  "volcanic-ash-cracks",
  "volcanic-folds",
  "volcanic-folds-warm",
  "volcanic-soil-dark",
  "volcanic-soil-light",
  "volcanic-ash-soil",
];

/**
 * The field order the Rust `checksum_vulcanus` selector uses.
 *
 * The module exports `vulcanus_field_count()` and this list is asserted against
 * it, so a field added to the chain on the Rust side cannot silently go
 * untested - the count moves and the assertion names the gap.
 */
const FIELD_NAMES = [
  "wobbleX",
  "wobbleY",
  "wobbleLargeX",
  "wobbleLargeY",
  "wobbleHugeX",
  "wobbleHugeY",
  "ashlandsStart",
  "basaltsStart",
  "mountainsStart",
  "startingArea",
  "startingCircle",
  "hairlineCracks",
  "floodCracksA",
  "floodCracksB",
  "floodPaths",
  "floodBasaltsFunc",
  "aux",
  "moisture",
  "mountainVolcanoSpots",
  "mountainsRawVolcano",
  "mountainsBiomeFull",
  "ashlandsBiomeFull",
  "basaltsBiomeFull",
  "mountainsBiome",
  "ashlandsBiome",
  "basaltsBiome",
  "elev",
  "elevation",
  "cliffElevation",
  "temperature",
  "basaltsFavorability",
  "mountainsFavorability",
  "mountainsSulfurFavorability",
  "ashlandsFavorability",
  "startingTungsten",
  "startingCoal",
  "startingCalcite",
  "startingSulfur",
  "tungstenRegion",
  "coalRegion",
  "calciteRegion",
  "sulfuricAcidRegion",
  "sulfuricAcidPatches",
  "sulfuricAcidRegionPatchy",
  "metalTile",
  "geyserProbability",
  "mountainLavaSpots",
  "rockNoise",
  "distance",
  "cliffinessBasic",
  "decorativeKnockout",
  "rockHuge",
  "rockBig",
  "rockDensity",
  ...TILE_NAMES.map((n) => `tile:${n}`),
  "resolvedTile",
];

/** The index of a named field, so an assertion never hard-codes a position. */
function fieldIndex(name: string): number {
  const at = FIELD_NAMES.indexOf(name);
  if (at < 0) throw new Error(`no such field: ${name}`);
  return at;
}

interface Sliders {
  readonly label: string;
  readonly ctx: Omit<EvalCtxInput, "seed0">;
}

/**
 * Two slider settings. The second moves EVERY lever, and gives the four
 * resource controls DISTINCT pairs on purpose: with all four at the same
 * `(frequency, size)` a control wired to the wrong ore would fold identically.
 */
const SLIDERS: readonly Sliders[] = [
  { label: "default sliders", ctx: {} },
  {
    label: "every lever moved",
    ctx: {
      vulcanusVolcanismFrequency: 2,
      vulcanusVolcanismSize: 3,
      temperatureBias: 0.35,
      vulcanusResourceControls: {
        tungstenOre: { frequency: 2, size: 3 },
        vulcanusCoal: { frequency: 0.5, size: 1.5 },
        calcite: { frequency: 4, size: 0.25 },
        sulfuricAcidGeyser: { frequency: 1.5, size: 6 },
      },
    },
  },
];

interface Window {
  readonly label: string;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
  readonly size: number;
}

/**
 * Two windows, because one cannot exercise both regimes.
 *
 * Measured rather than guessed (see the anti-vacuity tests below): at the far
 * window `startingArea` is uniformly 0 and every spawn-relative field is
 * saturated, so a far-only sweep would fold a constant through the four
 * `starting_*` ore fields and grade nothing. The spawn window carries
 * `startingArea` across its full 0..1 range and puts all four starting patches
 * above zero, where they can win the tile argmax.
 *
 * Both are off any spot-region lattice, so few samples land on a region centre.
 *
 * **Every coordinate they generate is exactly representable in f32, and that is
 * a deliberate restriction rather than a happy accident.** Off that grid the
 * two ports genuinely disagree - `basisNoiseExpr` narrows the coordinate
 * product once where the Rust narrows `x` first - which is issue
 * {@link OFF_GRID_ISSUE}. `the_two_ports_diverge_off_the_f32_grid` below pins
 * that divergence rather than leaving it to a comment, and it is what should go
 * red when the issue is fixed. At that point these two steps can go back to
 * being arbitrary.
 *
 * The steps are quarters (`29.75`, `61.25`) rather than integers so the sweep
 * still crosses tiles at a non-integer offset.
 */
const WINDOWS: readonly Window[] = [
  { label: "spawn window", originX: -397.5, originY: -361.25, tilesPerPixel: 29.75, size: 26 },
  { label: "far window", originX: -2413.5, originY: 1728.25, tilesPerPixel: 61.25, size: 26 },
];

/**
 * A window whose coordinates are NOT f32-exact, used only by the pinning test.
 *
 * `29.7` has no exact binary form, so `originX + i * 29.7` leaves the f32 grid
 * almost everywhere - which is the regime the game never evaluates in and the
 * shipped app never asks for (`preview/tiling.ts` records that it uses integer
 * origins and `tilesPerPixel` 1).
 */
const OFF_GRID: Window = {
  label: "off the f32 grid",
  originX: -397.5,
  originY: -361.25,
  tilesPerPixel: 29.7,
  size: 26,
};

/** The issue tracking the off-grid divergence the pinning test freezes. */
const OFF_GRID_ISSUE = 309;

function ctxInput(s: Sliders): EvalCtxInput {
  return { seed0: SEED0, ...s.ctx };
}

/** Every field, at every point of `w`, in the module's field order. */
function tsFields(s: Sliders, w: Window): number[][] {
  const input = ctxInput(s);
  const ctx = withCtxDefaults(input);
  // ONE stack, so every accessor below reads the same field objects - and
  // therefore the same memo caches - that the tile resolver reads. Building a
  // second set would be correct and would evaluate the whole chain twice.
  const stack = makeVulcanusStack(input);
  const { helpers, spawn, cracks, biomes, climate, elevation, resources } = stack;

  const temperature = makeVulcanusTemperature(ctx, climate, biomes, elevation);
  const geyser = sulfuricAcidGeyserProbability(resources);
  const mountainLavaSpots = makeMountainLavaSpots(helpers, biomes);
  const rockNoise = makeVulcanusRockNoise(ctx.seed0);
  const knockout = makeVulcanusDecorativeKnockout(ctx.seed0);
  const cliffiness = makeCliffinessBasic(ctx.seed0);
  const rocks = makeVulcanusRockFields(ctx, stack);

  const tileFields: VulcanusTileFields = {
    elev: (x, y) => elevation.elev(x, y),
    aux: (x, y) => climate.aux(x, y),
    moisture: (x, y) => climate.moisture(x, y),
    mountainsBiome: (x, y) => biomes.mountainsBiome(x, y),
    ashlandsBiome: (x, y) => biomes.ashlandsBiome(x, y),
    basaltsBiome: (x, y) => biomes.basaltsBiome(x, y),
    mountainVolcanoSpots: (x, y) => biomes.mountainVolcanoSpots(x, y),
    mountainLavaSpots,
    rockNoise,
    distance: (x, y) => distanceFromNearestPoint(x, y, ctx.startingPositions),
    metalTile: (x, y) => resources.metalTile(x, y),
    calciteRegion: (x, y) => resources.calciteRegion(x, y),
    sulfuricAcidRegionPatchy: (x, y) => resources.sulfuricAcidRegionPatchy(x, y),
  };
  const catalog = makeVulcanusTileCatalog(tileFields);

  const accessors: ((x: number, y: number) => number)[] = [
    helpers.wobbleX,
    helpers.wobbleY,
    helpers.wobbleLargeX,
    helpers.wobbleLargeY,
    helpers.wobbleHugeX,
    helpers.wobbleHugeY,
    (x, y) => spawn.ashlandsStart(x, y),
    (x, y) => spawn.basaltsStart(x, y),
    (x, y) => spawn.mountainsStart(x, y),
    (x, y) => spawn.startingArea(x, y),
    (x, y) => spawn.startingCircle(x, y),
    (x, y) => cracks.hairlineCracks(x, y),
    (x, y) => cracks.floodCracksA(x, y),
    (x, y) => cracks.floodCracksB(x, y),
    (x, y) => cracks.floodPaths(x, y),
    (x, y) => cracks.floodBasaltsFunc(x, y),
    (x, y) => climate.aux(x, y),
    (x, y) => climate.moisture(x, y),
    (x, y) => biomes.mountainVolcanoSpots(x, y),
    (x, y) => biomes.mountainsRawVolcano(x, y),
    (x, y) => biomes.mountainsBiomeFull(x, y),
    (x, y) => biomes.ashlandsBiomeFull(x, y),
    (x, y) => biomes.basaltsBiomeFull(x, y),
    (x, y) => biomes.mountainsBiome(x, y),
    (x, y) => biomes.ashlandsBiome(x, y),
    (x, y) => biomes.basaltsBiome(x, y),
    (x, y) => elevation.elev(x, y),
    (x, y) => elevation.elevation(x, y),
    (x, y) => elevation.cliffElevation(x, y),
    temperature,
    (x, y) => resources.basaltsFavorability(x, y),
    (x, y) => resources.mountainsFavorability(x, y),
    (x, y) => resources.mountainsSulfurFavorability(x, y),
    (x, y) => resources.ashlandsFavorability(x, y),
    (x, y) => resources.startingTungsten(x, y),
    (x, y) => resources.startingCoal(x, y),
    (x, y) => resources.startingCalcite(x, y),
    (x, y) => resources.startingSulfur(x, y),
    (x, y) => resources.tungstenRegion(x, y),
    (x, y) => resources.coalRegion(x, y),
    (x, y) => resources.calciteRegion(x, y),
    (x, y) => resources.sulfuricAcidRegion(x, y),
    (x, y) => resources.sulfuricAcidPatches(x, y),
    (x, y) => resources.sulfuricAcidRegionPatchy(x, y),
    (x, y) => resources.metalTile(x, y),
    geyser,
    mountainLavaSpots,
    rockNoise,
    (x, y) => distanceFromNearestPoint(x, y, ctx.startingPositions),
    cliffiness,
    knockout,
    rocks.rockHuge,
    rocks.rockBig,
    rocks.density,
    ...catalog.map((t) => (x: number, y: number) => t.probability(x, y)),
    (x, y) => TILE_NAMES.indexOf(resolveVulcanusTile(x, y, catalog).name),
  ];

  const out: number[][] = accessors.map(() => []);
  for (let j = 0; j < w.size; j++) {
    const y = w.originY + j * w.tilesPerPixel;
    for (let i = 0; i < w.size; i++) {
      const x = w.originX + i * w.tilesPerPixel;
      for (const [f, read] of accessors.entries()) (out[f] as number[]).push(read(x, y));
    }
  }
  return out;
}

/** The request the module reads its parameters and its sweep geometry from. */
function request(s: Sliders, w: Window): VulcanusRenderRequest {
  const ctx = withCtxDefaults(ctxInput(s));
  return {
    planet: "vulcanus",
    view: "terrain",
    seed0: SEED0,
    width: w.size,
    height: w.size,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    volcanismFrequency: ctx.vulcanusVolcanismFrequency,
    volcanismSize: ctx.vulcanusVolcanismSize,
    temperatureBias: ctx.temperatureBias,
    tungstenOre: ctx.vulcanusResourceControls.tungstenOre,
    vulcanusCoal: ctx.vulcanusResourceControls.vulcanusCoal,
    calcite: ctx.vulcanusResourceControls.calcite,
    sulfuricAcidGeyser: ctx.vulcanusResourceControls.sulfuricAcidGeyser,
  };
}

/** Write `req` into the module's scratch buffer and return the bytes written. */
function writeRequest(engine: EngineExports, req: VulcanusRenderRequest): number {
  const buffer = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
  return encodeRenderRequest(buffer, req);
}

describe("Rust and TypeScript agree bit for bit across the Vulcanus field graph", () => {
  it("covers every field the module exposes, so a new one cannot go untested", async () => {
    const engine = await instantiate();
    expect(FIELD_NAMES).toHaveLength(engine.vulcanus_field_count());
  });

  it("folds 676 grid points identically for every field, at two slider settings in two windows", async () => {
    const engine = await instantiate();
    let compared = 0;
    for (const s of SLIDERS) {
      for (const w of WINDOWS) {
        const ts = tsFields(s, w);
        const len = writeRequest(engine, request(s, w));
        for (const [field, name] of FIELD_NAMES.entries()) {
          expect(
            u64(engine.checksum_vulcanus(len, field)),
            `${name} (${s.label}, ${w.label})`,
          ).toBe(foldAll(ts[field] as number[]));
          compared++;
        }
      }
    }
    expect(compared).toBe(FIELD_NAMES.length * SLIDERS.length * WINDOWS.length);
  }, 300000);

  it(`the two ports diverge off the f32 grid, which is #${String(OFF_GRID_ISSUE)}`, async () => {
    // The parity fold above sweeps on the f32-exact grid, and this is why. Off
    // that grid `basisNoiseExpr` and its Rust port disagree: the TypeScript
    // forms the coordinate product in f64 and narrows once, the Rust narrows
    // `x` first and multiplies two f32s.
    //
    // Frozen here rather than described, so it cannot be forgotten and cannot
    // quietly change. **When #309 is fixed this test goes red**, and that is the
    // prompt to widen WINDOWS back off the grid and delete this whole block.
    //
    // It asserts the MECHANISM, not just the symptom - which is what makes it
    // worth more than a count:
    //
    // - `wobbleX` is a multioctave, and both ports narrow the incoming
    //   coordinate there (`multioctaveNoise.ts:203`, `multioctave_noise.rs:137`),
    //   so it AGREES off-grid.
    // - `hairlineCracks` is a bare `basisNoiseExpr`, narrowed on one side only,
    //   so it DISAGREES.
    // - `resolvedTile` AGREES even though 17 of the 19 probabilities behind it
    //   do not, because a discrete argmax almost never changes which side of a
    //   comparison a value falls on. That is why tier 3's byte-identical pixels
    //   could not see any of this, and it is the same property that made
    //   `poison::index_result` necessary.
    const engine = await instantiate();
    const s = SLIDERS[0] as Sliders;
    const ts = tsFields(s, OFF_GRID);
    const len = writeRequest(engine, request(s, OFF_GRID));

    const diverging = FIELD_NAMES.filter(
      (_, field) => u64(engine.checksum_vulcanus(len, field)) !== foldAll(ts[field] as number[]),
    );

    expect(diverging).toHaveLength(32);
    expect(diverging, "the multioctave path narrows on both sides").not.toContain("wobbleX");
    expect(diverging, "basisNoiseExpr narrows on one side only").toContain("hairlineCracks");
    expect(diverging, "the argmax absorbs it - why tier 3 is blind here").not.toContain(
      "resolvedTile",
    );
  }, 300000);

  it("the parity windows really are on the f32 grid, so the sweep above is the on-grid regime", () => {
    // Anti-vacuity for the restriction itself. If a step were edited to
    // something without an exact binary form, the fold above would start
    // comparing the two ports in the regime #309 says they disagree in, and the
    // failure would look like a port bug rather than a window mistake.
    const exact = (v: number): boolean => Math.fround(v) === v;
    for (const w of WINDOWS) {
      for (let i = 0; i < w.size; i++) {
        expect(exact(w.originX + i * w.tilesPerPixel), `${w.label} x[${String(i)}]`).toBe(true);
        expect(exact(w.originY + i * w.tilesPerPixel), `${w.label} y[${String(i)}]`).toBe(true);
      }
    }
    // And the pinning window must NOT be, or it pins nothing.
    const offGridCount = Array.from({ length: OFF_GRID.size }, (_, i) =>
      exact(OFF_GRID.originX + i * OFF_GRID.tilesPerPixel) ? 0 : 1,
    ).reduce<number>((a, b) => a + b, 0);
    // 20 of the 26, frozen rather than bounded: `i * 29.7` is exact for i = 0
    // and for the few i where the product happens to land back on the grid.
    expect(offGridCount, "the pinning window must leave the f32 grid").toBe(20);
  });

  it("a request the module cannot decode folds 0, rather than trapping", async () => {
    // `checksum_vulcanus` returns 0 for a request it rejects, because a trap
    // would poison the instance for every later call in this worker - the same
    // reason `render_request` returns a status code. This is what makes that
    // contract load-bearing rather than a promise in a doc comment.
    //
    // It also protects the fold above: if a bad request folded something
    // plausible instead, every field would compare equal to itself and the
    // whole spec would pass having tested nothing.
    const engine = await instantiate();
    const s = SLIDERS[0] as Sliders;
    const w = WINDOWS[0] as Window;
    const len = writeRequest(engine, request(s, w));

    // A real request first, so the two arms differ by the corruption alone.
    expect(u64(engine.checksum_vulcanus(len, 0))).not.toBe(0n);

    const buffer = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
    const magic = buffer[0] as number;
    buffer[0] = magic ^ 0xff;
    expect(u64(engine.checksum_vulcanus(len, 0)), "bad magic").toBe(0n);
    buffer[0] = magic;

    // And a Fulgora request, which decodes fine but is the wrong planet.
    const fulgoraLen = encodeRenderRequest(buffer, {
      planet: "fulgora",
      view: "landmask",
      seed0: 2967702466,
      width: 4,
      height: 4,
      originX: 0,
      originY: 0,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });
    expect(u64(engine.checksum_vulcanus(fulgoraLen, 0)), "wrong planet").toBe(0n);
  });

  it("the second slider setting really is a different chain, so running both says something", () => {
    // Anti-vacuity. At the default sliders `vulcanus_scale_multiplier` is
    // exactly 1 and every `sliderRescale` returns exactly 1, so a one-setting
    // spec would not exercise a single lever.
    const w = WINDOWS[0] as Window;
    const a = tsFields(SLIDERS[0] as Sliders, w);
    const b = tsFields(SLIDERS[1] as Sliders, w);
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (foldAll(a[i] as number[]) !== foldAll(b[i] as number[])) differing++;
    }
    // Measured at 50 of 74. A floor rather than a freeze: the guard's job is
    // "the second setting is a genuinely different chain", and the exact count
    // is a property of which fields happen to read a slider, not a result.
    expect(differing).toBeGreaterThan(40);
  }, 300000);

  it("the two windows are different regimes, so running both says something", () => {
    // Anti-vacuity for the geometry. The spawn window exists to reach fields the
    // far window saturates; if the two folded alike, one of them is redundant.
    const s = SLIDERS[0] as Sliders;
    const a = tsFields(s, WINDOWS[0] as Window);
    const b = tsFields(s, WINDOWS[1] as Window);
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (foldAll(a[i] as number[]) !== foldAll(b[i] as number[])) differing++;
    }
    // EVERY field, measured - not a floor. The two windows share no fold at all,
    // which is the strongest form this guard can take.
    expect(differing).toBe(FIELD_NAMES.length);
  }, 300000);

  it("the spawn window reaches the starting area, so the spawn fields are not folded constants", () => {
    // The far window has `startingArea` uniformly 0 and all four `starting_*`
    // ore fields deeply negative, which folds a saturated column and grades
    // nothing. This is the assertion that keeps the spawn window honest.
    const ts = tsFields(SLIDERS[0] as Sliders, WINDOWS[0] as Window);
    const area = ts[fieldIndex("startingArea")] as number[];
    expect(Math.min(...area), "startingArea reaches 0").toBe(0);
    expect(Math.max(...area), "startingArea reaches 1").toBe(1);
    for (const name of ["startingTungsten", "startingCoal", "startingCalcite", "startingSulfur"]) {
      const v = ts[fieldIndex(name)] as number[];
      expect(Math.max(...v), `${name} rises above zero somewhere`).toBeGreaterThan(0);
    }
  }, 300000);

  it("the sweep places several different tiles, so the argmax fold is not one constant", () => {
    // Anti-vacuity for the last field, and for the 19 probabilities behind it: a
    // window that resolved to one tile everywhere would agree between the ports
    // while testing only that both ports pick the same constant.
    const placed = WINDOWS.map(
      (w) =>
        new Set(tsFields(SLIDERS[0] as Sliders, w)[fieldIndex("resolvedTile")] as number[]).size,
    );
    // Frozen per window, and both reach ALL 19 - so every one of the 19
    // probability folds is graded over a window where its tile actually wins
    // somewhere, rather than over a region it never reaches.
    expect(placed).toEqual([19, 19]);
  }, 300000);
});
