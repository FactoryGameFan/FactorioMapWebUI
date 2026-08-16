// Manual render-cost benchmark - NOT a pass/fail gate (timing is machine-
// dependent). Skipped by default so `vp test` stays fast; run it with:
//
//     pnpm perf                                   # everything, min of 7 (~19 min)
//     FMW_PERF_BLOCK=vulcanus pnpm perf           # one block only  (~3.7 min)
//     FMW_PERF_N=3 FMW_PERF_BLOCK=vulcanus pnpm perf   # a quick look (~1.6 min)
//
// which sets FMW_PERF=1, runs this file, and prints the table it writes to
// perf-result.txt (gitignored).
//
// ## How this measures, and why (issue #19)
//
// It used to report a MEDIAN OF 3 taken with every iteration of one view run
// back-to-back before the next view started. That could not resolve the size of
// change it was being used to gate, which is worse than having no benchmark: it
// produced confident numbers that were noise. Measured 2026-07-27: 22.7% spread
// inside a single 5-iteration run, ~10% movement between processes on views the
// change under test could not touch, and one lattice change reported as a
// regression that was actually a small improvement.
//
// Four things fix that, and all four matter:
//
//  1. **Minimum of N, not median.** Timing noise is additive and positive - a
//     sample is the true cost plus whatever else the machine was doing - so the
//     minimum is the least-biased estimator of the underlying cost. The median
//     sits in the middle of the noise distribution and moves with machine load.
//  2. **Interleaved.** Every arm is timed once per round, round-robin, so a
//     drift in machine load hits every arm alike instead of landing entirely on
//     whichever view happened to be running. Arm-at-a-time is what let unrelated
//     views move 10%.
//  3. **Spread printed** (max/min) beside every figure, so a reader can see when
//     a measurement is too noisy to support the conclusion drawn from it.
//  4. **Within-process comparisons, not absolutes.** Absolute ms from different
//     processes should not be diffed, and the old output invited exactly that -
//     so the derived figures are printed explicitly and the file says so in a
//     header.
//
// ## Which derived figure to trust (measured 2026-07-28, two back-to-back runs)
//
// Issue #19 proposed `all / terrain` as the stable statistic. Measuring it says
// that is only half right, so read this before quoting a ratio:
//
// | figure             | run 1 | run 2 | drift |
// | ------------------ | ----- | ----- | ----- |
// | terrain (absolute) |  3402 |  3566 | +4.8% |
// | all (absolute)     |  8163 |  8225 | +0.8% |
// | ratio all/terrain  | 2.399 | 2.307 | -3.8% |
// | resources marginal |  1753 |  1710 | -2.5% |
// | rocks marginal     |  1079 |  1079 |  0.0% |
// | cliffs marginal    |  1894 |  1854 | -2.1% |
//
// **The MARGINALS are the most repeatable figure here, not the ratio.** The
// ratio divides two absolutes that drift independently - terrain moved +4.8%
// while `all` moved +0.8% - so it amplifies their disagreement rather than
// cancelling it. It is still worth printing, because it is the form the
// "under 2x terrain" gate is written in, but a ~4% move in it across runs is
// noise and not a regression. The marginals hold to ~2.5%.
//
// Corollary for anyone comparing against a figure recorded in the notes: the
// per-run baseline moves several percent, so a few percent of difference in an
// ABSOLUTE is not evidence of anything. A double-digit move in a MARGINAL is.
//
// ## What the cliff tile-collision rejection cost (measured 2026-07-30, #18)
//
// The rejection resolves tiles under each PLACED cell's collision box, so it is
// the first thing to make the cliff overlay depend on the tile resolver. Two
// arms of `FMW_PERF_BLOCK=vulcanus FMW_PERF_N=5`, same machine, back to back,
// with and without `tileCollides`:
//
// | figure                    | without | with  | delta  |
// | ------------------------- | ------- | ----- | ------ |
// | terrain (the control arm) |    3948 |  3947 |  -0.0% |
// | cliffs marginal           |    1500 |  1917 | **+28%** |
// | ratio all/terrain, whole  |   1.944 | 2.040 |  +4.9% |
// | ratio all/terrain, TILED  |   2.455 | 2.569 |  +4.6% |
//
// **Terrain being identical to 1 ms across the two arms is what makes this
// readable at all** - per the table above a 4.8% baseline drift would otherwise
// swamp a change this size. Read the marginal (+28%), not the ratio.
//
// **It puts the whole-image "under 2x terrain" gate back over the line: 1.944
// -> 2.040.** Recorded, not buried, as the same gate was when the Vulcanus V3
// overlays crossed it. The tiled figure - the geometry the app actually renders
// - was already over at 2.455 and is now 2.569.
//
// Whether that is worth paying is a correctness-vs-cost call, not a perf bug:
// the rejection is what the game does, and without it region `[1500,1500]`
// over-places by 20%. If it ever needs to come back down, the cheap lever is a
// "could lava possibly win here" pre-gate gating the full 19-tile argmax, which
// was scoped and deliberately not taken for this change.
import { appendFileSync, writeFileSync } from "node:fs";
import { it } from "vite-plus/test";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { renderTerrain } from "../src/noise/preview/renderTerrain";
import { renderResources } from "../src/noise/preview/renderResources";
import { renderEnemies } from "../src/noise/preview/renderEnemies";
import { renderCliffs } from "../src/noise/preview/renderCliffs";
import { renderTrees } from "../src/noise/preview/renderTrees";
import { surveyIslands, surveyStep } from "../src/noise/islands/cellSurvey";
import { COARSE_TILES_PER_PIXEL } from "../src/noise/islands/findIslands";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";

const OUT = "perf-result.txt";
const SEED = 123456;

/** Iterations per arm for the two render blocks. Minimum of this many. */
const ITERS = Number(process.env.FMW_PERF_N ?? 7);
/**
 * Iterations for the tile-overhead block, which defaults to 1 because each of
 * its passes is already 64 renders. Its meaningful output is the whole/tiled
 * RATIO, measured back-to-back in one process, which is exactly the kind of
 * within-process comparison that survives run-to-run drift.
 */
const TILE_ITERS = Number(process.env.FMW_PERF_TILE_N ?? 1);
/** Which blocks to run. Default: all of them. */
const BLOCKS = (process.env.FMW_PERF_BLOCK ?? "nauvis,vulcanus,tiles,islands")
  .split(",")
  .map((s) => s.trim());

// In the default suite FMW_PERF is unset -> every block becomes it.skip (instant).
const blockIt = (name: string): typeof it | typeof it.skip =>
  process.env.FMW_PERF && BLOCKS.includes(name) ? it : it.skip;

const N = 1024;
const HALF = N / 2;
const base = {
  id: 0,
  seed0: SEED,
  width: N,
  height: N,
  originX: -HALF,
  originY: -HALF,
  tilesPerPixel: 1,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
  mapType: "nauvis" as const,
};

interface Arm {
  label: string;
  fn: () => void;
  samples: number[];
}

/**
 * Register arms, then run them INTERLEAVED. Registration is separate from
 * execution precisely so that no arm can be run to completion before another
 * starts - that ordering is the whole point (see note 2 above).
 */
function bench(): {
  add: (label: string, fn: () => void) => Arm;
  run: (iters: number) => void;
} {
  const arms: Arm[] = [];
  return {
    add(label, fn) {
      const a: Arm = { label, fn, samples: [] };
      arms.push(a);
      return a;
    },
    run(iters) {
      for (const a of arms) a.fn(); // warm-up every arm once (JIT), untimed
      for (let i = 0; i < iters; i++)
        for (const a of arms) {
          const t0 = performance.now();
          a.fn();
          a.samples.push(performance.now() - t0);
        }
    },
  };
}

const minOf = (a: Arm): number => Math.min(...a.samples);
/** max/min - 1.00x is a perfectly stable measurement, 1.23x is the old noise. */
const spreadOf = (a: Arm): number => Math.max(...a.samples) / Math.min(...a.samples);
const row = (a: Arm): string =>
  `${a.label.padEnd(42)} ${minOf(a).toFixed(0).padStart(6)} ms  (spread ${spreadOf(a).toFixed(2)}x)`;

let started = false;
const emit = (text: string): void => {
  if (started) appendFileSync(OUT, text);
  else {
    writeFileSync(
      OUT,
      "Figures are MINIMA over N interleaved iterations, with (spread) = max/min.\n" +
        "Do NOT diff absolute ms across runs - the per-run baseline moves several\n" +
        "percent (terrain moved 4.8% between two runs on 2026-07-28). Compare the\n" +
        "MARGINALS, which held to ~2.5%; the ratio divides two independently\n" +
        "drifting absolutes and moved 3.8% over the same pair, so a few percent in\n" +
        "it is noise. See the header comment in test/render-cost.perf.spec.ts and\n" +
        "issue #19. Knobs: FMW_PERF_N, FMW_PERF_TILE_N,\n" +
        "FMW_PERF_BLOCK=nauvis,vulcanus,tiles,islands\n" +
        text,
    );
    started = true;
  }
};

blockIt("nauvis")(
  "render cost by layer @ 1024x1024 / 1 tile-per-pixel",
  () => {
    const b = bench();
    const elev = b.add("elevation only", () => runRenderRequest({ ...base, view: "elevation" }));
    const terrain = b.add("terrain (elev+climate+tiles)", () =>
      runRenderRequest({ ...base, view: "terrain" }),
    );
    const resources = b.add("terrain + resources", () =>
      runRenderRequest({ ...base, view: "resources" }),
    );
    const enemies = b.add("terrain + enemies", () =>
      runRenderRequest({ ...base, view: "enemies" }),
    );
    const cliffs = b.add("terrain + cliffs", () => runRenderRequest({ ...base, view: "cliffs" }));
    const trees = b.add("terrain + trees", () => runRenderRequest({ ...base, view: "trees" }));
    // Vulcanus terrain-only, V2 gate (docs/noise/vulcanus-resources-NOTES.md): V2
    // restored three resource-coupling terms into the tile catalog
    // (vulcanusCatalog.ts), so terrain now evaluates the ore region fields even
    // when the resource overlay itself is off. Compared against the V1 baseline
    // (~12 us/px, recorded in client-preview-ROADMAP.md) to catch a regression.
    // Stays at 1024x1024 because that is the size the recorded baseline used.
    const vulcanusTerrain = b.add("vulcanus terrain (V1 tiles + V2 coupling)", () =>
      runRenderRequest({ ...base, planet: "vulcanus", view: "terrain" }),
    );
    // Vulcanus resources, V2 gate: the view non-dev users actually get for
    // Vulcanus (ElevationPreviewPanel.vue's `effectiveView` defaults Vulcanus to
    // "resources"), and `renderVulcanusResources` builds a SECOND, independent
    // Vulcanus field stack on top of the terrain render's own - so this is
    // slower than "vulcanus terrain" above, not a bug.
    const vulcanusResources = b.add("vulcanus resources (default Vulcanus view)", () =>
      runRenderRequest({ ...base, planet: "vulcanus", view: "resources" }),
    );
    // Fulgora (#27). Terrain is the ONLY view it has - no overlay has a
    // Fulgora port - so this single row is the whole planet's cost, unlike
    // Vulcanus where the default view is the pricier `resources`. Every pixel
    // runs the full elevation chain (~31 basis_noise octaves) and the ocean
    // argmax; there IS an ocean early-out (`bestOcean > 0`), so a LAND pixel
    // pays a lot more than an ocean one - it goes on to run the road/structure
    // layer's two more Voronoi tilings (four total, on top of the two the
    // ocean-side cells layer already runs for every pixel) and three more
    // multioctave fields (`fulgoraRoads.ts`'s `structureSubnoise`,
    // `fulgoraRuins.ts`'s `ruinsWalls`/`ruinsPaving`) that an ocean pixel never
    // reaches. The cost model is strongly bimodal, not uniform: see the
    // land-only figure in `docs/noise/fulgora-elevation-NOTES.md`'s Task 12.
    const fulgoraTerrain = b.add("fulgora terrain (the only Fulgora view)", () =>
      runRenderRequest({ ...base, planet: "fulgora", view: "terrain" }),
    );

    const terrainCtx = {
      seed0: SEED,
      width: N,
      height: N,
      originX: base.originX,
      originY: base.originY,
      tilesPerPixel: 1,
      ctx: { segmentationMultiplier: 1, startingPositions: base.startingPositions },
    };
    const oc = {
      seed0: SEED,
      originX: base.originX,
      originY: base.originY,
      tilesPerPixel: 1,
      segmentationMultiplier: 1,
      waterLevel: 0,
      startingPositions: base.startingPositions,
    };
    // Hand-assembled rather than `view: "all"` so the per-overlay ctx is explicit.
    // It must therefore mirror runRenderRequest's composite ORDER and membership -
    // trees first, then resources/enemies/cliffs. Omitting an overlay here makes
    // the headline row silently measure a composite the app no longer renders.
    const all = b.add("ALL (terrain + 4 overlays)", () => {
      const img = renderTerrain(terrainCtx);
      renderTrees(img, { ...oc, treesFrequency: 1, treesSize: 1 });
      renderResources(img, { ...oc, controls: {} });
      renderEnemies(img, {
        seed0: SEED,
        originX: base.originX,
        originY: base.originY,
        tilesPerPixel: 1,
        controls: { frequency: 1, size: 1 },
        startingPositions: base.startingPositions,
      });
      renderCliffs(img, {
        ...oc,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      });
    });

    b.run(ITERS);

    const header = `nauvis @ ${N}x${N}, tpp 1, seed ${SEED}, origin (${base.originX},${base.originY}), min of ${ITERS}`;
    const pxCount = N * N;
    const usPx = (a: Arm): string => ((minOf(a) * 1000) / pxCount).toFixed(2);
    emit(
      [
        "",
        header,
        "-".repeat(header.length),
        ...[
          elev,
          terrain,
          resources,
          enemies,
          cliffs,
          trees,
          vulcanusTerrain,
          vulcanusResources,
          fulgoraTerrain,
          all,
        ].map(row),
        "",
        `ratio ALL/terrain                        ${(minOf(all) / minOf(terrain)).toFixed(3).padStart(6)}   (see header: marginals are steadier than this)`,
        `climate+tiles portion of terrain: ~${(minOf(terrain) - minOf(elev)).toFixed(0)} ms (the tiling target)`,
        `all 4 overlays add over terrain:  ~${(minOf(all) - minOf(terrain)).toFixed(0)} ms`,
        `nauvis terrain:     ~${usPx(terrain)} us/px`,
        `vulcanus terrain:   ~${usPx(vulcanusTerrain)} us/px (terrain-only, NOT the default Vulcanus view)`,
        `vulcanus resources: ~${usPx(vulcanusResources)} us/px (the default Vulcanus view - double field-stack cost)`,
        `fulgora terrain:    ~${usPx(fulgoraTerrain)} us/px (the only Fulgora view)`,
        "",
      ].join("\n"),
    );
  },
  3_600_000,
);

// The block that actually gates Vulcanus decisions. Deliberately 512x512 at
// origin (0,0) rather than the 1024x1024 origin-centred window above, because
// that is the geometry the recorded hand-measured figures use
// (vulcanus-cliffs-NOTES.md, "Re-measured after the placement roll"): terrain
// 3394 / resources 5406 / rocks 4756 / cliffs 5526 / all 8458, ratio 2.492.
// Those were min-of-7 interleaved runs done BY HAND precisely because
// `pnpm perf` could not settle them - so reproducing them here is what retires
// the hand-rolled loop.
const V = 512;
const vBase = { ...base, width: V, height: V, originX: 0, originY: 0, planet: "vulcanus" as const };

blockIt("vulcanus")(
  "vulcanus render cost by overlay @ 512x512 / 1 tile-per-pixel",
  () => {
    const b = bench();
    const terrain = b.add("terrain", () => runRenderRequest({ ...vBase, view: "terrain" }));
    const resources = b.add("resources", () => runRenderRequest({ ...vBase, view: "resources" }));
    const rocks = b.add("rocks", () => runRenderRequest({ ...vBase, view: "rocks" }));
    const cliffs = b.add("cliffs", () => runRenderRequest({ ...vBase, view: "cliffs" }));
    const all = b.add("all", () => runRenderRequest({ ...vBase, view: "all" }));

    // The SAME area as 16 x 128x128 tiles, which is the geometry the app
    // actually renders (a 64-worker pool at 128x128, `render-tiling-shipped`).
    // The gate has always been quoted on the whole-image arm, and for a long
    // time those two disagreed badly - the tiled `all` ran 17% dearer, which
    // traced to the cliff cell bounds rounding out to a spare chunk per axis
    // per call (vulcanus-cliffs-NOTES.md, "ROOT CAUSE of the tiling penalty").
    // With that fixed they agree to ~1%, but the tiled arm stays because it is
    // the one the user experiences and nothing else would have caught this.
    const VT = 128;
    const vFull = { originX: 0, originY: 0, width: V, height: V };
    const tiled = (view: "terrain" | "all"): (() => void) => {
      return () => {
        for (let dy = 0; dy < V; dy += VT)
          for (let dx = 0; dx < V; dx += VT)
            runRenderRequest({
              ...vBase,
              view,
              width: VT,
              height: VT,
              originX: dx,
              originY: dy,
              fullImage: vFull,
            });
      };
    };
    const terrainTiled = b.add(`terrain tiled (16 x ${VT})`, tiled("terrain"));
    const allTiled = b.add(`all tiled (16 x ${VT})`, tiled("all"));

    b.run(ITERS);

    const header = `vulcanus @ ${V}x${V}, tpp 1, seed ${SEED}, origin (0,0), min of ${ITERS}`;
    // Marginal cost of one overlay over terrain. These do NOT sum to the `all`
    // marginal: measured one at a time they each pay for their own field-cache
    // warm-up, while on the `all` path they share one - so the whole is cheaper
    // than the sum of its parts. Read them as proportions, not a decomposition.
    const marginal = (a: Arm): string =>
      `${(minOf(a) - minOf(terrain)).toFixed(0).padStart(6)} ms over terrain`;
    emit(
      [
        "",
        header,
        "-".repeat(header.length),
        ...[terrain, resources, rocks, cliffs, all, terrainTiled, allTiled].map(row),
        "",
        `resources marginal                  ${marginal(resources)}`,
        `rocks     marginal                  ${marginal(rocks)}`,
        `cliffs    marginal                  ${marginal(cliffs)}`,
        `ratio all/terrain, whole                 ${(minOf(all) / minOf(terrain)).toFixed(3).padStart(6)}   <- the "under 2x terrain" gate`,
        `ratio all/terrain, TILED                 ${(minOf(allTiled) / minOf(terrainTiled)).toFixed(3).padStart(6)}   <- the same gate at the geometry the app renders`,
        `tiling penalty on all                    ${(minOf(allTiled) / minOf(all)).toFixed(3).padStart(6)}   <- was 1.17 before the cliff-bounds fix`,
        "",
      ].join("\n"),
    );
  },
  3_600_000,
);

// Phase-A gate for the region-tiling plan: how much does rebuilding every
// resolver per tile cost? Renders the same 1024x1024 area as 64 128x128 tiles
// and compares against the single whole-image render. A ratio near 1.0 means
// per-tile setup is noise; a high ratio means the resolver stack has to be
// hoisted out of the per-tile path. "elevation" is included because it is the
// view every non-Nauvis preset uses, and its per-render setup (compiled octave
// closures, starting-lake computation) is the most likely to dominate a small
// total.
//
// The tiled arm passes `fullImage`, because `renderPool.ts` always does. Without
// it `haloQueryBox` returns the bare tile box and every seam halo silently
// vanishes, so the arm measures a tiling the app never performs. This was
// missing until 2026-07-28 and every tiled figure recorded before that date was
// taken without it. It turned out not to move the Vulcanus conclusion - the
// cliff halo costs exactly zero extra field evaluations, see
// vulcanus-cliffs-NOTES.md - but "the tiled number is the real one" is the whole
// reason this block exists, so it should actually be the real one.
blockIt("tiles")(
  "tile overhead: 64 x 128x128 vs one 1024x1024",
  () => {
    const TILE = 128;
    const b = bench();
    const fullImage = { originX: base.originX, originY: base.originY, width: N, height: N };
    const pairs = (["elevation", "terrain", "all"] as const).map((view) => ({
      view,
      whole: b.add(`whole ${view}`, () => runRenderRequest({ ...base, view })),
      tiled: b.add(`tiled ${view} (64 x ${TILE})`, () => {
        for (let dy = 0; dy < N; dy += TILE)
          for (let dx = 0; dx < N; dx += TILE)
            runRenderRequest({
              ...base,
              view,
              width: TILE,
              height: TILE,
              originX: -HALF + dx,
              originY: -HALF + dy,
              fullImage,
            });
      }),
    }));

    b.run(TILE_ITERS);

    const header = `tile overhead (64 x ${TILE} tiles vs one whole render), min of ${TILE_ITERS}`;
    emit(
      [
        "",
        header,
        "-".repeat(header.length),
        ...pairs.flatMap(({ view, whole, tiled }) => [
          row(whole),
          row(tiled),
          `${`ratio ${view}`.padEnd(42)} ${(minOf(tiled) / minOf(whole)).toFixed(3).padStart(6)}`,
        ]),
        "",
      ].join("\n"),
    );
  },
  3_600_000,
);

// The Fulgora island finder (#27), which pins the two costs
// `docs/superpowers/specs/2026-08-15-fulgora-island-finder-design.md` staked
// its whole design on: the survey pass is supposed to be free, and each
// candidate's coarse measurement is supposed to be the real cost. Two arms:
//
//  - `surveyIslands` (Stage 1, cellSurvey.ts) scanning a 4,000-tile box at the
//    derived `grid / 8` step, evaluating only the `cells` field.
//  - One Stage-2-shaped coarse render (findIslands.ts's `measure`): a
//    256x256-tile window at `COARSE_TILES_PER_PIXEL` (8) tiles/px, so 32x32
//    pixels, `view: "terrain"` - NEVER "all". This module's header explains
//    why: "all" adds the scrap overlay, whose placement roll iterates TILES
//    rather than pixels, measured at 112x for a coarse window in a real
//    browser Worker (spec section 2b). Origin (0,0) at this seed is a
//    100%-land window (the same one the design spec's own Node benchmark
//    used in section 2), so this times real terrain work rather than an
//    ocean early-out.
//
// The design spec measured one `cells` evaluation at 2.33 us in a throwaway
// benchmark; the survey arm here reproduces that as a per-sample figure from
// a real, gated test rather than a one-off script.
const ISLAND_SEED = 2967702466; // Fulgora's surface seed for map seed 123456 - the seed cellSurvey.spec.ts, findIslands.spec.ts and the design spec's own benchmark all use.
const ISLAND_CTX = { seed0: ISLAND_SEED };
const ISLAND_BOX = { x0: -2000, y0: -2000, x1: 2000, y1: 2000 }; // a 4,000-tile box
const islandGrid = makeFulgoraStack(ISLAND_CTX).shared.grid;
const islandStep = surveyStep(islandGrid);
/**
 * The number of (x, y) grid points `surveyIslands` visits over `box` at
 * `step`. Mirrors that function's own nested loop bounds exactly - cellSurvey.ts
 * has no separate sample-count export - so this is the true denominator for
 * "us per sample", not an estimate of it.
 */
function sampleCountOf(box: typeof ISLAND_BOX, step: number): number {
  let nx = 0;
  for (let x = box.x0; x <= box.x1; x += step) nx++;
  let ny = 0;
  for (let y = box.y0; y <= box.y1; y += step) ny++;
  return nx * ny;
}
const ISLAND_SAMPLE_COUNT = sampleCountOf(ISLAND_BOX, islandStep);
const islandCoarseBase = {
  id: 0,
  seed0: ISLAND_SEED,
  planet: "fulgora" as const,
  view: "terrain" as const,
  width: 32,
  height: 32,
  originX: 0,
  originY: 0,
  tilesPerPixel: COARSE_TILES_PER_PIXEL,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
};

blockIt("islands")(
  "fulgora island finder: survey cost + one coarse measure render",
  () => {
    const b = bench();
    let candidateCount = 0;
    const survey = b.add(`surveyIslands (4,000-tile box, step ~${islandStep.toFixed(2)})`, () => {
      candidateCount = surveyIslands(ISLAND_CTX, ISLAND_BOX).length;
    });
    const coarse = b.add(
      `coarse measure render (256x256 tiles @ ${COARSE_TILES_PER_PIXEL} tpp, terrain)`,
      () => runRenderRequest(islandCoarseBase),
    );

    b.run(ITERS);

    const header = `fulgora island finder, seed ${ISLAND_SEED}, min of ${ITERS}`;
    const usPerSample = (minOf(survey) * 1000) / ISLAND_SAMPLE_COUNT;
    emit(
      [
        "",
        header,
        "-".repeat(header.length),
        row(survey),
        row(coarse),
        "",
        `survey cost:    ~${usPerSample.toFixed(2)} us/sample (${ISLAND_SAMPLE_COUNT} samples scanned, ${candidateCount} candidates found)`,
        `coarse measure: ~${minOf(coarse).toFixed(1)} ms/candidate (one Stage-2 render, terrain view)`,
        "",
      ].join("\n"),
    );
  },
  3_600_000,
);
