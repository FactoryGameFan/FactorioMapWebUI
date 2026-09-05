import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { findIslands } from "../src/noise/islands/findIslands";
import {
  ENGINE_REQUIRED,
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import {
  consultedCount,
  expectFrozen,
  expectRecordedRows,
  flushRecording,
  foldJson,
  frozenCount,
  RECORDING,
} from "./islandsFrozen";

/**
 * **The integration check #223 asked for: the island finder, run against the
 * Rust engine, agrees with the TypeScript one exactly.**
 *
 * `test/wasmFulgoraRenderParity.spec.ts` proves the renderers produce
 * byte-identical RGBA over four windows. This is a different question and a
 * stronger one, because the finder is not a unit test: it renders candidate
 * windows, re-renders any whose island mask touches the border at a doubled
 * pad, flood-fills, chains components, and ranks the result. Every one of those
 * steps reads pixels, and a single wrong pixel at a border can change whether a
 * window is re-rendered - which changes the ranking, not just a number.
 *
 * **The TypeScript arm is gone as of #371**, so the comparison is against the
 * frozen fold in `test/fixtures/island-finder-checksums.json`, captured while
 * both arms existed and agreed (#376). The engine's ranked output is folded
 * through its JSON and compared to that value; a row that moves is a finding,
 * not a value to adjust.
 *
 * `refineCount` is small on purpose. The finder's own spec cuts four of its
 * tests the same way for identical coverage; the question here is whether the
 * whole pipeline reproduces its frozen output, and that does not need the
 * expensive refinement pass exercised at its production depth.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
const SEED0 = surfaceSeedForPlanet("fulgora", 123456);
const RADIUS = 600;
const REFINE = 1;

/**
 * The freeze section for this spec. See `islandsFrozen.ts`.
 *
 * The row was recorded from the TypeScript-backed finder while it still
 * existed, and asserted against both arms at once. Now it grades the engine.
 */
const SECTION = "fulgora:finder";

/** One ranked list. */
const ROWS = 1;

expectRecordedRows(SECTION, ROWS);
afterAll(flushRecording);

function request(id: number, view: ElevationRenderRequest["view"]): ElevationRenderRequest {
  return {
    id,
    seed0: SEED0,
    width: 16,
    height: 16,
    originX: -64,
    originY: -64,
    tilesPerPixel: 4,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    planet: "fulgora",
    view,
  };
}

describe("the island finder reproduces its frozen output through the engine", () => {
  it("returns the frozen ranked list, and really does render", async () => {
    const engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));

    let renders = 0;
    const viaWasm = (req: ElevationRenderRequest): Promise<ReturnType<typeof runRenderRequest>> => {
      renders++;
      return Promise.resolve(runRenderRequest(req, engine));
    };

    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: RADIUS,
      concurrency: 4,
      refineCount: REFINE,
      engine,
      execute: viaWasm,
    });

    // Non-vacuity. A finder that rendered nothing would return an empty list,
    // and an empty list folds to a perfectly stable checksum.
    expect(renders).toBeGreaterThan(0);
    expect(found.length).toBeGreaterThan(0);

    expectFrozen(
      SECTION,
      `radius ${String(RADIUS)}, refine ${String(REFINE)}`,
      "ranked islands",
      foldJson(found),
    );
  }, 300000);

  it("refuses to search without the engine rather than surveying nothing", async () => {
    // The survey has no other path since #371. A finder that quietly returned
    // an empty list here would read as "no islands", which is a legitimate
    // answer for a real map and so cannot be told from a failure.
    await expect(
      findIslands({
        ctx: { seed0: SEED0 },
        radius: RADIUS,
        concurrency: 1,
        refineCount: REFINE,
        execute: (req) => Promise.resolve(runRenderRequest(req)),
      }),
    ).rejects.toThrow(ENGINE_REQUIRED);
  });

  it("every Fulgora view needs the engine, and the land mask fills the module's buffer", async () => {
    // This used to assert that a non-landmask view "still takes the TypeScript
    // path". #371 makes it the sharper statement it was standing in for: with
    // no TypeScript left, a view the module serves is exactly a view that
    // REFUSES to render without it. A view that quietly returned pixels here
    // would be one the dispatcher still serves off some other path.
    const engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
    for (const view of ["landmask", "terrain", "resources", "all"] as const) {
      expect(() => runRenderRequest(request(2, view)), `${view}: must need the engine`).toThrow(
        ENGINE_REQUIRED,
      );
    }

    // And the engine path really is the module: the render buffer changes.
    const before = new Uint8Array(engine.memory.buffer, engine.render_ptr(), 64).slice();
    runRenderRequest(request(1, "landmask"), engine);
    const after = new Uint8Array(engine.memory.buffer, engine.render_ptr(), 64).slice();
    expect(Array.from(after)).not.toEqual(Array.from(before));
  }, 120000);
});

describe("the freeze covers this spec rather than merely existing", () => {
  // `expectRecordedRows` guards only a RECORD run. On a normal run nothing
  // above checks that the rows are actually consulted: a deleted `expectFrozen`
  // call site would leave its row in the table un-consulted and every gate
  // green while coverage shrank. This table is the only thing grading the
  // finder's output now. Both numbers, because they fail on opposite mistakes -
  // see `wasmNauvisRenderParity.spec.ts`.
  it.skipIf(RECORDING)("consults every frozen row exactly once", () => {
    expect(frozenCount(SECTION), "rows in the committed table").toBe(ROWS);
    expect(consultedCount(SECTION), "distinct rows this run looked up").toBe(ROWS);
  });
});
