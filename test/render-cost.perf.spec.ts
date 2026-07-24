// Manual render-cost benchmark - NOT a pass/fail gate (timing is machine-
// dependent). Skipped by default so `vp test` stays fast; run it with:
//
//     pnpm perf
//
// which sets FMW_PERF=1, runs this file, and prints the table it writes to
// perf-result.txt (gitignored). This is the baseline to measure region-tiling
// (or any render optimization) against - see the render-tiling design doc.
import { appendFileSync, writeFileSync } from "node:fs";
import { it } from "vite-plus/test";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { renderTerrain } from "../src/noise/preview/renderTerrain";
import { renderResources } from "../src/noise/preview/renderResources";
import { renderEnemies } from "../src/noise/preview/renderEnemies";
import { renderCliffs } from "../src/noise/preview/renderCliffs";
import { renderTrees } from "../src/noise/preview/renderTrees";

// In the default suite FMW_PERF is unset -> this becomes it.skip (instant).
const perfIt = process.env.FMW_PERF ? it : it.skip;

const N = 1024;
const HALF = N / 2;
const SEED = 123456;
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

const median = (xs: number[]): number =>
  xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows: string[] = [];
const time = (label: string, fn: () => void, iters = 3): number => {
  fn(); // warm-up (JIT)
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  const m = median(ts);
  rows.push(`${label.padEnd(30)} ${m.toFixed(0).padStart(6)} ms`);
  return m;
};

perfIt(
  "render cost by layer @ 1024x1024 / 1 tile-per-pixel",
  () => {
    const elev = time("elevation only", () => runRenderRequest({ ...base, view: "elevation" }));
    const terrain = time("terrain (elev+climate+tiles)", () =>
      runRenderRequest({ ...base, view: "terrain" }),
    );
    time("terrain + resources", () => runRenderRequest({ ...base, view: "resources" }));
    time("terrain + enemies", () => runRenderRequest({ ...base, view: "enemies" }));
    time("terrain + cliffs", () => runRenderRequest({ ...base, view: "cliffs" }));
    time("terrain + trees", () => runRenderRequest({ ...base, view: "trees" }));
    // Vulcanus terrain-only, V2 gate (docs/noise/vulcanus-resources-NOTES.md): V2
    // restored three resource-coupling terms into the tile catalog
    // (vulcanusCatalog.ts), so terrain now evaluates the ore region fields even
    // when the resource overlay itself is off. Compared against the V1 baseline
    // (~12 us/px, recorded in client-preview-ROADMAP.md) to catch a regression.
    const vulcanusTerrain = time("vulcanus terrain (V1 tiles + V2 coupling)", () =>
      runRenderRequest({ ...base, planet: "vulcanus", view: "terrain" }),
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
    const all = time("ALL (terrain + 4 overlays)", () => {
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

    const header = `render cost @ ${N}x${N}, tpp 1, seed ${SEED} (median of 3)`;
    const pxCount = N * N;
    const summary = [
      "",
      `climate+tiles portion of terrain: ~${(terrain - elev).toFixed(0)} ms (the tiling target)`,
      `all 4 overlays add over terrain:  ~${(all - terrain).toFixed(0)} ms`,
      `nauvis terrain:   ~${((terrain * 1000) / pxCount).toFixed(2)} us/px`,
      `vulcanus terrain: ~${((vulcanusTerrain * 1000) / pxCount).toFixed(2)} us/px`,
    ].join("\n");
    writeFileSync(
      "perf-result.txt",
      `${header}\n${"-".repeat(header.length)}\n${rows.join("\n")}\n${summary}\n`,
    );
  },
  600000,
);

// Phase-A gate for the region-tiling plan: how much does rebuilding every
// resolver per tile cost? Renders the same 1024x1024 area as 64 128x128 tiles
// and compares against the single whole-image render. A ratio near 1.0 means
// per-tile setup is noise; a high ratio means the resolver stack has to be
// hoisted out of the per-tile path. iters=1 because each pass is already 64
// renders. "elevation" is included because it is the view every non-Nauvis
// preset uses, and its per-render setup (compiled octave closures, starting-lake
// computation) is the most likely to dominate a small total.
perfIt(
  "tile overhead: 64 x 128x128 vs one 1024x1024",
  () => {
    const TILE = 128;
    const out: string[] = ["", "tile overhead (64 x 128 tiles vs one whole render)"];
    for (const view of ["elevation", "terrain", "all"] as const) {
      const whole = time(`whole ${view}`, () => runRenderRequest({ ...base, view }), 1);
      const tiled = time(
        `tiled ${view} (64 x ${TILE})`,
        () => {
          for (let dy = 0; dy < N; dy += TILE) {
            for (let dx = 0; dx < N; dx += TILE) {
              runRenderRequest({
                ...base,
                view,
                width: TILE,
                height: TILE,
                originX: -HALF + dx,
                originY: -HALF + dy,
              });
            }
          }
        },
        1,
      );
      out.push(`${`whole ${view}`.padEnd(30)} ${whole.toFixed(0).padStart(6)} ms`);
      out.push(`${`tiled ${view}`.padEnd(30)} ${tiled.toFixed(0).padStart(6)} ms`);
      out.push(`${`ratio ${view}`.padEnd(30)} ${(tiled / whole).toFixed(3).padStart(6)}`);
    }
    // Append: the first block already wrote the header and summary, and
    // overwriting here would drop them from the file `pnpm perf` cats.
    appendFileSync("perf-result.txt", out.join("\n") + "\n");
  },
  900000,
);
