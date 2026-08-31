import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  RECORDING,
  consultedCount,
  expectFrozen,
  expectRecordedRows,
  flushRecording,
  foldPixels,
  frozenCount,
} from "./tier3Frozen";

import { compileEngine, instantiateEngine, renderThroughWasm } from "../src/noise/wasm/engine";
import {
  runRenderRequest,
  STARTING_LAKE_POSITIONS_UNSUPPORTED,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { LAND_RGBA, WATER_RGBA } from "../src/noise/preview/palette";

/**
 * Tier 3 for the ELEVATION view (#227): the Rust engine's elevation render
 * against the TypeScript one.
 *
 * One arm rather than the two the terrain specs carry, because there is no game
 * PNG to compare against. The elevation view is not a picture the game draws -
 * it is a sign test on the elevation tree, painted in two colours this repo
 * chose - so "how far is the port from the game" is asked by the tier-1 and
 * tier-2 specs on the trees themselves. What is left for this file is the
 * question the port creates: **are the two renderers the same renderer.**
 *
 * **Why this view was the last one ported.** It is the request's DEFAULT view
 * and the one `ElevationPreviewPanel` forces on every Lakes or Island preset
 * outside dev mode, so `renderElevation.ts` was the sole renderer for what most
 * users actually see. #227 could not delete the TypeScript branch while that
 * was true.
 *
 * **Three map types, three view codes.** The ABI's common prefix has no
 * `mapType` field and `view` is already a `u32`, so three codes cost nothing
 * and a field would have been a layout change. Each is exercised here, because
 * `island` is `lakes` with a different bias and a quartered segmentation - a
 * divide that happens inside `to_island` - and a path that applied it twice, or
 * not at all, would still render something plausible.
 */
const SEED = 123456;

interface Window {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

/**
 * Four windows, all four MEASURED to carry both colours on all three trees
 * rather than chosen by eye. Water fraction, lakes / nauvis / island:
 *
 * | window | lakes | nauvis | island |
 * | --- | ---: | ---: | ---: |
 * | spawn 128 @1 | 4.3% | 5.3% | 4.3% |
 * | spawn 128 @8 | 13.7% | 5.3% | 1.7% |
 * | spawn 128 @32 | 18.7% | 22.7% | 87.8% |
 * | lake 64 @1 | 30.1% | 34.9% | 30.1% |
 *
 * **Two obvious-looking far-field windows were dropped after measuring**, and
 * they are why this table is here. `96x96 @1` at `(-6000, 3000)` is 0% water on
 * lakes and nauvis and 100% on island; `96x96 @4` at `(4096, -2048)` is 100% on
 * island. Each is a single flat colour, which a byte-identical assertion passes
 * without grading anything - the exact vacuity the anti-vacuity test below
 * exists to catch.
 *
 * Near spawn is not decoration either. The starting lakes are derived from
 * `(seed0, startingPositions)` and only bite within 1024 tiles, so a port that
 * dropped them would still match on far-field windows alone.
 */
const WINDOWS: readonly Window[] = [
  { label: "spawn 128 @1", width: 128, height: 128, originX: -64, originY: -64, tilesPerPixel: 1 },
  {
    label: "spawn 128 @8",
    width: 128,
    height: 128,
    originX: -512,
    originY: -512,
    tilesPerPixel: 8,
  },
  {
    label: "spawn 128 @32",
    width: 128,
    height: 128,
    originX: -2048,
    originY: -2048,
    tilesPerPixel: 32,
  },
  { label: "lake 64 @1", width: 64, height: 64, originX: 20, originY: -80, tilesPerPixel: 1 },
];

const MAP_TYPES = ["lakes", "nauvis", "island"] as const;

/**
 * The tier-3 freeze section for this spec. See `tier3Frozen.ts`.
 *
 * The last of the three render specs to be frozen. Its TypeScript arm is
 * `pixels(req)` with the engine left off; #227 deletes what that reaches, after
 * which it would be the same code as the wasm arm and every comparison here
 * would pass while grading nothing.
 */
const SECTION = "elevation:render";

/**
 * Rows this spec must record, as a literal.
 *
 * 12 byte-identity (3 map types x 4 windows) + 3 direct-module SERVES + 3
 * lever and spawn cases.
 *
 * The `startingLakePositions` block is NOT counted, and deliberately: see the
 * note on it below.
 */
const ROWS = 18;

expectRecordedRows(SECTION, ROWS);
afterAll(flushRecording);

/**
 * Freeze one render, and compare the two arms while both exist.
 *
 * **The map type has to be in the label.** The byte-identity block is a
 * `describe.each` over `MAP_TYPES`, so the same four window labels come round
 * three times; keyed on the window alone, the three trees would overwrite each
 * other and the section would hold 4 rows where 12 ran.
 */
function freeze(label: string, name: string, wasm: ArrayLike<number>, ts: ArrayLike<number>): void {
  expectFrozen(SECTION, label, name, foldPixels(wasm), foldPixels(ts));
}

function request(
  w: Window,
  mapType: (typeof MAP_TYPES)[number],
  extra: Partial<ElevationRenderRequest> = {},
): ElevationRenderRequest {
  return {
    id: 1,
    view: "elevation",
    mapType,
    seed0: SEED,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    ...extra,
  };
}

let compiled: WebAssembly.Module | undefined;
async function engine() {
  compiled ??= await compileEngine(
    readFileSync(join(import.meta.dirname, "../src/noise/wasm/engine.wasm")),
  );
  return instantiateEngine(compiled);
}

function pixels(req: ElevationRenderRequest, e?: Awaited<ReturnType<typeof engine>>) {
  return new Uint8ClampedArray(runRenderRequest(req, e).buffer);
}

/** The set of distinct `r,g,b` triples in a render. */
function palette(px: Uint8ClampedArray): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < px.length; i += 4) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  return seen;
}

const WATER_KEY = `${WATER_RGBA[0]},${WATER_RGBA[1]},${WATER_RGBA[2]}`;
const LAND_KEY = `${LAND_RGBA[0]},${LAND_RGBA[1]},${LAND_RGBA[2]}`;

describe.each(MAP_TYPES)(
  "the WASM engine renders the %s elevation view exactly as the TypeScript does",
  (mapType) => {
    it("is byte-identical across four windows", async () => {
      const e = await engine();
      for (const w of WINDOWS) {
        const req = request(w, mapType);
        const wasm = pixels(req, e);
        const ts = pixels(req);
        expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
        expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
        freeze(`${mapType} ${w.label}`, "elevation", wasm, ts);
      }
    }, 300000);

    it("each of those windows carries BOTH water and land", async () => {
      // Anti-vacuity for the comparison above. "Identical" is satisfied by two
      // renderers that both painted a flat field, and this view has only two
      // colours, so the terrain specs' "more than two distinct colours" check
      // cannot be reused - the correct form here is that both of the two show
      // up. Checked PER window, because one mixed window would otherwise cover
      // for three flat ones.
      const e = await engine();
      for (const w of WINDOWS) {
        const seen = palette(pixels(request(w, mapType), e));
        expect([...seen].sort(), `${w.label}: palette`).toEqual([LAND_KEY, WATER_KEY].sort());
      }
    }, 300000);
  },
);

describe("the module SERVES the elevation views rather than the gate falling back", () => {
  /**
   * **Every byte-identical assertion above is vacuous without this one.** A
   * `runRenderRequest(req, engine)` that quietly declined the engine and ran the
   * TypeScript satisfies `wasm === ts` perfectly, and that is precisely the
   * failure this port could have: a `view` code the module does not name comes
   * back `unsupported planet or view`, and the gate falls through.
   *
   * So this reaches `renderThroughWasm` DIRECTLY, with no fallback in front of
   * it, and requires the module's own pixels to match the TypeScript's. If the
   * module refused the code, this throws rather than passing quietly.
   *
   * Read `#227`'s lesson literally: gate-reading missed two unported render
   * paths in both directions. Plant the call, do not read the match arm.
   */
  const w = WINDOWS[1];
  const CODES = [
    ["lakes", "elevationLakes"],
    ["nauvis", "elevationNauvis"],
    ["island", "elevationIsland"],
  ] as const;

  it.each(CODES)(
    "serves %s as view code %s",
    async (mapType, view) => {
      const e = await engine();
      const direct = new Uint8ClampedArray(
        renderThroughWasm(e, {
          planet: "nauvis",
          view,
          seed0: SEED,
          width: w.width,
          height: w.height,
          originX: w.originX,
          originY: w.originY,
          tilesPerPixel: w.tilesPerPixel,
          waterLevel: 0,
          segmentationMultiplier: 1,
          moistureFrequency: 1,
          moistureBias: 0,
          auxFrequency: 1,
          auxBias: 0,
          startingAreaMoistureSize: 1,
          startingAreaMoistureFrequency: 1,
          temperatureFrequency: 1,
          temperatureBias: 0,
          treesFrequency: 1,
          treesSize: 1,
          rocksFrequency: 1,
          rocksSize: 1,
          enemyFrequency: 1,
          enemySize: 1,
          cliffFrequency: 1,
          cliffContinuity: 1,
          cliffElevation0: 10,
          cliffElevationInterval: 40,
          cliffRichness: 1,
          resourceLevers: Array.from({ length: 6 }, () => [1, 1, 1] as const),
          cellQueryBox: [w.originX, w.originY, w.originX + w.width, w.originY + w.height],
          placementSweepBox: [w.originX, w.originY, w.originX + w.width, w.originY + w.height],
          startingPositions: [{ x: 0, y: 0 }],
        } as never),
      );
      const ts = pixels(request(w, mapType));
      expect(direct.length, "module returned no pixels").toBe(w.width * w.height * 4);
      expect(Array.from(direct), `${mapType}: module vs TypeScript`).toEqual(Array.from(ts));
      // Frozen on the DIRECT module render rather than the gated one, which is
      // what makes this row worth keeping after the deletion: it pins the
      // module's own answer for the view code, with no fallback in front of it.
      freeze(`serves ${mapType}`, "elevation", direct, ts);
    },
    300000,
  );
});

describe("the elevation levers move both paths together", () => {
  // The Nauvis param block is read RAW by the module and defaulted on the
  // TypeScript side, so a wrong value in the caller would be a silent
  // divergence rather than an error. Moving a lever and requiring both paths to
  // move together is what catches one.
  // `spawn 128 @8`. The lever arms need a window WIDE enough for the lever to
  // bite: at 1 tile/px the same levers moved nothing measurable, which is what
  // failed the first draft of this file. The window was wrong, not the lever.
  const w = WINDOWS[1];

  it("waterLevel moves the render, and identically on both paths", async () => {
    const e = await engine();
    // The terrain view deliberately IGNORES waterLevel (#326). The elevation
    // view does not - `renderElevation` passes it into the tree - so this also
    // pins that the two views read the same field differently on purpose.
    //
    // Measured on `lakes` at this window: 13.7% water at the default, 42.0% at
    // `waterLevel: 20`, and 2.5% at -20.
    //
    // **On `island` this lever is inert** - 1.7% water at every value from -20
    // to +20 at this window - so `lakes` is the tree that can grade it.
    // `elevation_island`'s -1000 bias swamps the water term. That is a property
    // of the tree rather than of this port: the TypeScript behaves the same way,
    // which is what the byte-identical arms above already say.
    const base = request(w, "lakes");
    const moved = request(w, "lakes", { waterLevel: 20 });
    const movedWasm = pixels(moved, e);
    const movedTs = pixels(moved);
    expect(Array.from(movedWasm), "wasm vs ts at waterLevel 20").toEqual(Array.from(movedTs));
    expect(Array.from(movedWasm), "waterLevel moved nothing").not.toEqual(
      Array.from(pixels(base, e)),
    );
    freeze("waterLevel 20 on lakes", "elevation", movedWasm, movedTs);
  }, 300000);

  it("segmentationMultiplier moves the render, and identically on both paths", async () => {
    const e = await engine();
    // Measured on `island` at this window: 1.7% water at the default and 51.7%
    // at `segmentationMultiplier: 2`. Island is the sharpest of the three here,
    // and it is also the one whose divide could land twice.
    const base = request(w, "island");
    const moved = request(w, "island", { segmentationMultiplier: 2 });
    const movedWasm = pixels(moved, e);
    const movedTs = pixels(moved);
    // Island quarters segmentation inside `to_island`. A path that applied the
    // divide twice, or skipped it, still renders - so the two-path comparison
    // under a MOVED lever is what grades it, not the default render.
    expect(Array.from(movedWasm), "wasm vs ts at segmentation 2").toEqual(Array.from(movedTs));
    expect(Array.from(movedWasm), "segmentation moved nothing").not.toEqual(
      Array.from(pixels(base, e)),
    );
    freeze("segmentationMultiplier 2 on island", "elevation", movedWasm, movedTs);
  }, 300000);

  it("a moved spawn renders THROUGH the engine, byte-identical to the TypeScript", async () => {
    const e = await engine();
    // The spawn reaches the starting lakes, so a module that fixed it at the
    // origin would differ near the moved point rather than everywhere.
    const w2: Window = { ...w, originX: 436, originY: -564 };
    const moved = request(w2, "lakes", { startingPositions: [{ x: 500, y: -500 }] });
    const origin = request(w2, "lakes");
    const movedWasm = pixels(moved, e);
    const movedTs = pixels(moved);
    expect(Array.from(movedWasm), "wasm vs ts at a moved spawn").toEqual(Array.from(movedTs));
    expect(Array.from(movedWasm), "the spawn moved nothing").not.toEqual(
      Array.from(pixels(origin, e)),
    );
    freeze("moved spawn on lakes", "elevation", movedWasm, movedTs);
  }, 300000);
});

describe("a caller-supplied startingLakePositions is refused", () => {
  /**
   * This block asserted the opposite until #227: that an explicit lake list
   * forced the TypeScript path, which was a CORRECTNESS carve-out rather than a
   * speed one. The module derives the lake list from the seed and the spawn -
   * the game's own rule - so an explicit list was a different answer, not a
   * slower one, and the request is a fixed-size struct with nowhere to put a
   * variable-length array besides.
   *
   * With the TypeScript arm going there is no path left that could honour it,
   * so the choice is between refusing and silently ignoring. Ignoring would
   * render a different map than the caller asked for and say nothing, so it
   * refuses.
   *
   * **Both arms are asserted.** With an engine present the request would
   * otherwise route through WASM ignoring the list, which is precisely the
   * wrong-answer case the carve-out existed to prevent; without one it would
   * have taken the TypeScript path. Neither may quietly succeed.
   */
  const w = WINDOWS[0];
  const explicit = [{ x: 300, y: 300 }];

  it("throws with the engine present and with it absent", async () => {
    const e = await engine();
    const req = request(w, "lakes", { startingLakePositions: explicit });
    expect(() => pixels(req, e), "with an engine").toThrow(STARTING_LAKE_POSITIONS_UNSUPPORTED);
    expect(() => pixels(req), "without an engine").toThrow(STARTING_LAKE_POSITIONS_UNSUPPORTED);
  }, 300000);

  it("refuses an EMPTY list too, which used to mean far-field only", () => {
    // `elevationLakes.ts` documented "Pass `[]` for the old far-field-only
    // behavior", so `[]` is a meaningful value rather than an absent one -
    // rendering the derived lakes for a caller who asked for none is a wrong
    // answer, not a default.
    //
    // Planted: this does NOT discriminate `!== undefined` from a truthiness
    // test, because `[]` is truthy and both forms refuse it. What it catches is
    // a LENGTH test, `!== undefined && length > 0`, which is the plausible
    // mistake - it reads like a tidy-up and silently restores the old
    // behaviour for the one value that used to select it.
    const req = request(w, "lakes", { startingLakePositions: [] });
    expect(() => pixels(req)).toThrow(STARTING_LAKE_POSITIONS_UNSUPPORTED);
  });

  it("refuses on every planet and view, not only the one the old checks reached", async () => {
    // The two checks this guard replaced sat inside leaves of the view/planet
    // dispatch, and between them missed three cases: the Vulcanus branch
    // returns before the Nauvis gate is ever evaluated, the Fulgora branch
    // likewise - and that one is live, since `findIslands` posts
    // `planet: "fulgora", view: "landmask"` - and `"landmask"` on Nauvis is in
    // the outer view test but absent from the Nauvis gate's allowlist.
    //
    // Every other assertion in this describe is Nauvis `lakes`, so a guard put
    // back into a dispatch leaf would satisfy all of them and still let these
    // three through. This is the block that grades the guard's PLACEMENT.
    const e = await engine();
    const holes = [
      { label: "vulcanus terrain", planet: "vulcanus", view: "terrain" },
      { label: "fulgora landmask", planet: "fulgora", view: "landmask" },
      { label: "nauvis landmask", planet: "nauvis", view: "landmask" },
    ] as const;
    for (const h of holes) {
      const req = request(w, "lakes", {
        planet: h.planet,
        view: h.view,
        startingLakePositions: explicit,
      });
      expect(() => pixels(req, e), h.label).toThrow(STARTING_LAKE_POSITIONS_UNSUPPORTED);
    }
  }, 300000);

  it("still renders when the field is simply absent", async () => {
    // The guard runs before everything, so a bug in it would take out every
    // render rather than only the overriding ones.
    const e = await engine();
    expect(pixels(request(w, "lakes"), e).length).toBe(w.width * w.height * 4);
  }, 300000);
});

describe("the tier-3 freeze covers this spec rather than merely existing", () => {
  // Declared last on purpose: tests run in declaration order within a file, so
  // this sees every `freeze` call the run made. Both numbers are asserted
  // because they fail on opposite mistakes - the table count catches a
  // re-record that wrote a different surface, the consulted count catches a
  // call site that stopped asking.
  //
  // On the two specs frozen before this one, deleting a `freeze` call site left
  // every other test in the file GREEN. This is what sees it.
  it.skipIf(RECORDING)("consults every frozen row exactly once", () => {
    expect(frozenCount(SECTION), "rows in the committed table").toBe(ROWS);
    expect(consultedCount(SECTION), "distinct rows this run looked up").toBe(ROWS);
  });
});
