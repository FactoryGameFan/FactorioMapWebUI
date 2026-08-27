import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { compileEngine, instantiateEngine, renderThroughWasm } from "../src/noise/wasm/engine";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { TREE_MAP_COLOR } from "../src/noise/preview/renderTrees";
import { planTiles } from "../src/noise/preview/tiling";

/**
 * Tier 3 for Nauvis (#226): the Rust engine's terrain render against the
 * TypeScript one, and both against the game's own preview PNG.
 *
 * Same two arms as the Fulgora and Vulcanus specs, answering different
 * questions:
 *
 * - **WASM against TypeScript** must be BYTE-IDENTICAL. That is what makes the
 *   engine a speed choice rather than a behaviour switch, and it is why
 *   `runRenderRequest` can dispatch to whichever path is available with no
 *   window in which the answer is wrong.
 * - **WASM against the game's PNG** says how far both ports sit from the game.
 *   Because the first arm holds, that count is asserted EXACTLY rather than
 *   under a bound.
 *
 * **Nauvis's `seed0` IS the map seed**, unlike Fulgora's and Vulcanus's. Those
 * two derive a surface seed as `mapSeed + crc32(name)` and getting it wrong is
 * the failure that looks like a broken port; here there is nothing to derive,
 * which is one hazard this planet does not have.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");
const SIZE = 1024;
const SEED = 123456;

/**
 * The game draws enemy bases in its capture and our terrain view does not.
 *
 * `enemy-base` is the ONE control the game reports as `can_be_disabled: false`
 * (`autoplace-can-be-disabled.dump.json`), so those pixels are in the reference
 * whatever we ask for. They are excluded rather than tolerated, and counted, so
 * the exclusion cannot quietly grow.
 */
const ENEMY_RGB = [255, 25, 25] as const;

/**
 * Measured on the TypeScript path: 1,189 enemy pixels, and 8 of the remaining
 * 1,047,387 differ - 99.9992%.
 *
 * **`previewAgreement.spec.ts` says 10 in a comment, and that has drifted.** It
 * asserts `toBeLessThan(200)`, so the number in its prose was never checked by
 * anything and the port has moved since it was written - the same way four rows
 * of `test/captureGrid.ts`'s table had. This spec freezes it exactly instead.
 *
 * **These are the TypeScript renderer's own numbers and they have to be**,
 * because the first describe block asserts the two renders are byte-identical.
 * `previewAgreement.spec.ts` reaches the same figures through a separate run.
 * Asserted EXACTLY here for the reason #162 records: a bound reported a real
 * improvement as a regression once, and an exact count cannot.
 */
const ENEMY_PX = 1189;
const DIFFERING_PX = 8;

interface Window {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

/**
 * Four windows, deliberately unlike each other.
 *
 * The near-spawn one is not optional: Nauvis's elevation tree has starting-lake
 * and starting-island terms that only fire inside the starting area, and issue
 * #326 was nearly dismissed on a window that sat entirely inside it. A far-field
 * window alone would leave those branches unrendered by both ports.
 */
const WINDOWS: Window[] = [
  // COARSE at spawn rather than fine. A 64x64 window at 1 tile/px covers only
  // +/-32 tiles and came back with TWO distinct colours - identical between two
  // renderers that both painted a near-flat field, which is what the colour
  // count below exists to refuse. At 4 tiles/px it spans +/-128 and is varied.
  {
    label: "coarse at spawn",
    width: 64,
    height: 64,
    originX: -128,
    originY: -128,
    tilesPerPixel: 4,
  },
  {
    label: "wide, offset",
    width: 96,
    height: 24,
    originX: 512.5,
    originY: -1024.25,
    tilesPerPixel: 1,
  },
  { label: "tall, coarse", width: 24, height: 96, originX: -2048, originY: 768, tilesPerPixel: 8 },
  // Far field, and COARSE for the same reason the spawn window is: at
  // 0.5 tiles/px this spanned 24 tiles and came back a single flat colour.
  {
    label: "coarse, far field",
    width: 48,
    height: 48,
    originX: 4000.25,
    originY: -3000.75,
    tilesPerPixel: 16,
  },
];

function request(w: Window): ElevationRenderRequest {
  return {
    id: 1,
    view: "terrain",
    seed0: SEED,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
  };
}

/**
 * A Nauvis request built for `renderThroughWasm` directly, bypassing
 * `runRenderRequest`.
 *
 * Shared by every overlay block's "serves the view rather than refusing it"
 * test, which is the one test in each block that has to reach the module
 * without the fallback in front of it. Shared rather than written out per
 * block because each ABI growth makes another lever REQUIRED, and three
 * separate copies meant three edits and three chances to miss one - the
 * type-checker caught it every time, but the churn is the point.
 *
 * Every lever is at the game's default, so these tests grade acceptance of the
 * view and nothing else; the levers are graded by their own block's test.
 */
function directRequest(
  w: Window,
  view: "trees" | "rocks" | "enemies" | "cliffs" | "resources" | "all",
) {
  return {
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
    resourceLevers: [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ],
  } as const;
}

let compiled: WebAssembly.Module | undefined;
async function engine() {
  compiled ??= await compileEngine(
    readFileSync(join(import.meta.dirname, "../src/noise/wasm/engine.wasm")),
  );
  return instantiateEngine(compiled);
}

describe("the WASM engine renders Nauvis terrain exactly as the TypeScript does", () => {
  it("is byte-identical across four windows", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const req = request(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("each of those windows carries several distinct colours", async () => {
    // Anti-vacuity for the comparison above: "identical" is satisfied by two
    // renderers that both painted a flat field. Checked PER window, because one
    // rich window would otherwise cover for three flat ones.
    const e = await engine();
    for (const w of WINDOWS) {
      const px = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      const seen = new Set<string>();
      for (let i = 0; i < px.length; i += 4) {
        seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      }
      expect(seen.size, `${w.label}: distinct colours`).toBeGreaterThan(2);
    }
  }, 300000);

  it("moving the climate levers moves the render on both paths together", async () => {
    // The eight-lever block is defaulted on the TypeScript side inside
    // `makeMoisture` / `makeAux` and read raw by the module, so a wrong default
    // in `renderNauvisThroughWasm` would be a silent divergence. Moving each
    // lever and requiring BOTH paths to move together is what catches one.
    const e = await engine();
    // A WIDE window. `auxFrequency` moved nothing at all across a 64x64 window
    // at 1 tile/px: aux decides between dirt and desert families, and a small
    // patch can sit entirely inside one. The lever is not dead - the window was.
    // A window that is both VARIED and inside the starting area. Two earlier
    // attempts each failed for the opposite reason: 64x64 at 1 tile/px spans
    // +/-32 tiles and `auxFrequency` moved nothing, while 96x96 at 32 tiles/px
    // spans +/-1536 and put the starting-area moisture terms - which only fire
    // within ~150 tiles of spawn - inside a handful of pixels, so
    // `startingAreaMoistureFrequency` moved nothing either. At 4 tiles/px over
    // +/-256 both are live.
    const base: ElevationRenderRequest = {
      ...request(WINDOWS[0]),
      width: 128,
      height: 128,
      originX: -256,
      originY: -256,
      tilesPerPixel: 4,
    };
    const flat = (r: ElevationRenderRequest, eng?: typeof e) =>
      Array.from(new Uint8ClampedArray(runRenderRequest(r, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);

    const moved: Partial<ElevationRenderRequest>[] = [
      { segmentationMultiplier: 2 },
      { moistureFrequency: 3 },
      { moistureBias: 0.2 },
      { auxFrequency: 0.5 },
      { auxBias: -0.15 },
      { startingAreaMoistureSize: 4 },
      // The frequency has to move WITH the size. See the assertion below.
      { startingAreaMoistureSize: 4, startingAreaMoistureFrequency: 3 },
    ];
    for (const patch of moved) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const w = flat(req, e);
      const t = flat(req);
      const name = Object.keys(patch)[0];
      expect(w, `${name}: wasm vs ts`).toEqual(t);
      expect(w, `${name}: must actually move the render`).not.toEqual(baseWasm);
    }

    // **`startingAreaMoistureFrequency` alone is INERT, and that is a property
    // of the expression rather than a gap in the sweep.** `starting_bias_change`
    // is `slider_to_linear(size, -0.5, 0.5)`, which is exactly 0 at the default
    // size - so the whole starting-area blend collapses to `base_bias` and the
    // frequency multiplies a zero difference. `nauvis_climate`'s module note
    // records the same thing about the oracle fixture.
    //
    // Asserted rather than worked around, so that a change making the frequency
    // live on its own fails here instead of silently widening what the sweep
    // covers.
    const freqOnly = { ...base, startingAreaMoistureFrequency: 3 } as ElevationRenderRequest;
    expect(flat(freqOnly, e), "frequency alone must stay inert at the default size").toEqual(
      baseWasm,
    );
    expect(flat(freqOnly)).toEqual(baseWasm);
  }, 300000);

  it("a moved spawn stays on the TypeScript path rather than rendering wrong", async () => {
    // The Nauvis ABI block carries no spawn list, so the module fixes it at the
    // origin. `runRenderRequest` therefore has to REFUSE the engine for a
    // request that moved it - `startingPositions` reaches `elevation_nauvis`'s
    // distance term, so taking the engine anyway would be a wrong answer rather
    // than a slow one.
    const e = await engine();
    const req = {
      ...request(WINDOWS[0]),
      startingPositions: [{ x: 512, y: -256 }],
    };
    const withEngine = Array.from(new Uint8ClampedArray(runRenderRequest(req, e).buffer));
    const withoutEngine = Array.from(new Uint8ClampedArray(runRenderRequest(req).buffer));
    expect(withEngine).toEqual(withoutEngine);
    // And the moved spawn must actually change the render, or this proves
    // nothing about which path ran.
    const atOrigin = Array.from(
      new Uint8ClampedArray(runRenderRequest(request(WINDOWS[0]), e).buffer),
    );
    expect(withEngine).not.toEqual(atOrigin);
  }, 300000);
});

/**
 * Pixels the tree overlay changes against bare terrain, per window.
 *
 * **Measured on the TypeScript path before any Rust existed**, so the number
 * comes from the reference rather than from the port being graded. Frozen
 * rather than bounded, for the reason every count in this port is: a bound wide
 * enough to be safe is wide enough to swallow a real change.
 *
 * Coverage runs 34.6% to 76.1% of each window, so unlike ore - which needed
 * Vulcanus's five hand-found windows - trees are dense enough that the four
 * terrain windows already grade every one of them.
 */
const TREE_PIXELS_PER_WINDOW = [1417, 1754, 1353, 1574, 7074];

/**
 * A fifth window, and it is here because a planted break got past the other
 * four.
 *
 * The blend converts alpha to a byte and then fixes it up from a 255-scale to a
 * 256-scale with `a += a >> 7`, which only does anything once `alpha` reaches
 * 128/255 - about 0.502. Deleting that fixup - a plausible simplification -
 * left the four terrain windows BYTE-IDENTICAL, because none of them carries
 * forest dense enough to get there. The break was real; the windows could not
 * see it.
 *
 * This one is wide enough to reach that density at the default controls, so the
 * fixup is graded. It is the same trap as Vulcanus's ore windows in a different
 * costume: a window that contains none of the thing being graded compares
 * nothing, and "the render matched" is exactly what it reports.
 */
const DENSE_WINDOW: Window = {
  label: "wide at spawn",
  width: 128,
  height: 128,
  originX: -128,
  originY: -128,
  tilesPerPixel: 4,
};

const OVERLAY_WINDOWS: readonly Window[] = [...WINDOWS, DENSE_WINDOW];

describe("the WASM engine renders the Nauvis tree overlay exactly as the TypeScript does", () => {
  const treeRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "trees" });

  it("serves the trees view rather than refusing it", async () => {
    // The discriminating test, and the reason it is first. `runRenderRequest`
    // falls back to the TypeScript path for any view the module refuses, so
    // every byte-identity assertion below passes VACUOUSLY until the module
    // actually accepts this view - the two arms would just be two runs of the
    // same TypeScript. This one goes through the module directly, where a
    // refusal is a thrown `unsupported planet or view` rather than a silent
    // fallback.
    const e = await engine();
    const w = WINDOWS[0];
    const pixels = renderThroughWasm(e, directRequest(w, "trees"));
    expect(pixels.length).toBe(w.width * w.height * 4);
  }, 300000);

  it("is byte-identical across five windows", async () => {
    const e = await engine();
    for (const w of OVERLAY_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(treeRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(treeRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("blends toward the tree colour in every window, at the counts measured", async () => {
    // The tree overlay does not paint a flat mark - it alpha-blends, so there
    // is no single colour to count. The property that IS exact: a blended
    // channel must land between the terrain value and the tree colour,
    // inclusive. `((256 - a) * base + a * color) >> 8` is a weighted average of
    // the two, and the truncation can only move it toward `base`, so this holds
    // in both directions and would fail on a blend toward any other colour.
    const e = await engine();
    const counts: number[] = [];
    for (const w of OVERLAY_WINDOWS) {
      const trees = new Uint8ClampedArray(runRenderRequest(treeRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let changed = 0;
      for (let i = 0; i < trees.length; i += 4) {
        let moved = false;
        for (let c = 0; c < 3; c++) {
          if (trees[i + c] === terrain[i + c]) continue;
          moved = true;
          const lo = Math.min(terrain[i + c], TREE_MAP_COLOR[c]);
          const hi = Math.max(terrain[i + c], TREE_MAP_COLOR[c]);
          expect(
            trees[i + c] >= lo && trees[i + c] <= hi,
            `${w.label}: pixel ${i / 4} channel ${c} moved to ${trees[i + c]}, outside [${lo}, ${hi}]`,
          ).toBe(true);
        }
        if (moved) changed++;
      }
      counts.push(changed);
    }
    expect(counts).toEqual(TREE_PIXELS_PER_WINDOW);
  }, 300000);

  it("moving each tree lever moves the render on both paths together", async () => {
    // The four levers this slice adds to the ABI block. A lever written to the
    // wrong offset decodes as a neighbour's value, which the round-trip fixture
    // cannot see - only rendering with it moved can. Each patch was measured on
    // the TypeScript path first and changes 5,840 to 23,775 bytes, so none of
    // these comparisons is vacuous.
    const e = await engine();
    const base: ElevationRenderRequest = {
      ...treeRequest(WINDOWS[0]),
      width: 128,
      height: 128,
    };
    const flat = (req: ElevationRenderRequest, eng?: typeof e): number[] =>
      Array.from(new Uint8ClampedArray(runRenderRequest(req, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);

    const patches: readonly (readonly [string, Partial<ElevationRenderRequest>])[] = [
      ["treeControls.frequency", { treeControls: { frequency: 3, size: 1 } }],
      ["treeControls.size", { treeControls: { frequency: 1, size: 3 } }],
      ["temperatureFrequency", { temperatureFrequency: 4 }],
      ["temperatureBias", { temperatureBias: 7 }],
    ];
    for (const [label, patch] of patches) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const moved = flat(req, e);
      expect(moved, `${label}: the two paths must agree`).toEqual(flat(req));
      expect(moved, `${label}: must actually move the render`).not.toEqual(baseWasm);
    }
  }, 300000);

  it("needs no halo: tiling reproduces one whole render byte for byte", async () => {
    // Trees are the one overlay with no sweep box, and this is the claim that
    // makes that safe. The density buffer reads the FIELD at a one-cell border
    // in world coordinates, never the image, so a tile's border cells are the
    // same numbers whether or not the neighbouring tile was ever rendered.
    // Every other overlay in this port has to widen its query box instead.
    const e = await engine();
    const w = WINDOWS[0];
    const whole = new Uint8ClampedArray(runRenderRequest(treeRequest(w), e).buffer);
    const full = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const stitched = new Uint8ClampedArray(whole.length);
    for (const tile of planTiles(full, 16)) {
      const px = new Uint8ClampedArray(
        runRenderRequest(
          {
            ...treeRequest(w),
            width: tile.width,
            height: tile.height,
            originX: tile.originX,
            originY: tile.originY,
            fullImage: full,
          },
          e,
        ).buffer,
      );
      for (let ty = 0; ty < tile.height; ty++) {
        for (let tx = 0; tx < tile.width; tx++) {
          const src = (ty * tile.width + tx) * 4;
          const dst = ((tile.dy + ty) * w.width + (tile.dx + tx)) * 4;
          stitched.set(px.subarray(src, src + 4), dst);
        }
      }
    }
    expect(Array.from(stitched)).toEqual(Array.from(whole));
  }, 300000);
});

/**
 * Rock pixels per window, measured on the TypeScript path before the port.
 *
 * Far sparser than the tree overlay's counts - a rock is a point placement
 * painting a 3x3 mark, not a blend over every land pixel - but every window
 * carries some, so unlike ore this needs no window set of its own.
 */
const ROCK_PIXELS_PER_WINDOW = [52, 18, 27, 18, 157];

/** `ROCK_MAP_COLOR` in `src/noise/rocks/rockCatalog.ts`. Both planets share it. */
const ROCK_RGB = [129, 105, 78] as const;

describe("the WASM engine renders the Nauvis rock overlay exactly as the TypeScript does", () => {
  const rockRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "rocks" });

  it("serves the rocks view rather than refusing it", async () => {
    // The discriminating test, first for the reason the tree block states:
    // `runRenderRequest` falls back to TypeScript for a view the module
    // refuses, so every byte-identity assertion below would otherwise be two
    // runs of the same code.
    const e = await engine();
    const w = WINDOWS[0];
    const pixels = renderThroughWasm(e, directRequest(w, "rocks"));
    expect(pixels.length).toBe(w.width * w.height * 4);
  }, 300000);

  it("is byte-identical across five windows", async () => {
    const e = await engine();
    for (const w of OVERLAY_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(rockRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(rockRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("paints rock pixels in every window, and only rock-coloured ones", async () => {
    // Two assertions in one sweep, as the Vulcanus rock block does: the count
    // of pixels the overlay CHANGED, and the count that ended up rock-coloured
    // having not been before. They must be equal - a difference would mean the
    // pass moved a pixel to something that is not the rock colour.
    const e = await engine();
    const counts: number[] = [];
    for (const w of OVERLAY_WINDOWS) {
      const rocks = new Uint8ClampedArray(runRenderRequest(rockRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let changed = 0;
      let rockColoured = 0;
      for (let i = 0; i < rocks.length; i += 4) {
        const was =
          terrain[i] === ROCK_RGB[0] &&
          terrain[i + 1] === ROCK_RGB[1] &&
          terrain[i + 2] === ROCK_RGB[2];
        const is =
          rocks[i] === ROCK_RGB[0] && rocks[i + 1] === ROCK_RGB[1] && rocks[i + 2] === ROCK_RGB[2];
        if (
          rocks[i] !== terrain[i] ||
          rocks[i + 1] !== terrain[i + 1] ||
          rocks[i + 2] !== terrain[i + 2]
        ) {
          changed++;
        }
        if (is && !was) rockColoured++;
      }
      expect(rockColoured, `${w.label}: every changed pixel must be rock-coloured`).toBe(changed);
      counts.push(changed);
    }
    expect(counts).toEqual(ROCK_PIXELS_PER_WINDOW);
  }, 300000);

  it("moving each rock lever moves the render on both paths together", async () => {
    // Measured on the TypeScript path first: 930 and 1,248 bytes change, so
    // neither comparison is vacuous.
    const e = await engine();
    const base = rockRequest(DENSE_WINDOW);
    const flat = (req: ElevationRenderRequest, eng?: typeof e): number[] =>
      Array.from(new Uint8ClampedArray(runRenderRequest(req, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);
    for (const [label, patch] of [
      ["rockControls.frequency", { rockControls: { frequency: 3, size: 1 } }],
      ["rockControls.size", { rockControls: { frequency: 1, size: 3 } }],
    ] as const) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const moved = flat(req, e);
      expect(moved, `${label}: the two paths must agree`).toEqual(flat(req));
      expect(moved, `${label}: must actually move the render`).not.toEqual(baseWasm);
    }
  }, 300000);

  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    // Unlike trees, a rock mark IS read off the image: it is a 3x3 centred on
    // the hit's pixel, so a rock centred just outside a tile still owes that
    // tile pixels. The sweep box is what carries them, and the second arm is
    // what proves the box is doing work rather than being decoration.
    const e = await engine();
    const w = DENSE_WINDOW;
    const whole = new Uint8ClampedArray(runRenderRequest(rockRequest(w), e).buffer);
    const full = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const renderTiled = (withHalo: boolean): Uint8ClampedArray => {
      const stitched = new Uint8ClampedArray(whole.length);
      for (const tile of planTiles(full, 32)) {
        const px = new Uint8ClampedArray(
          runRenderRequest(
            {
              ...rockRequest(w),
              width: tile.width,
              height: tile.height,
              originX: tile.originX,
              originY: tile.originY,
              ...(withHalo ? { fullImage: full } : {}),
            },
            e,
          ).buffer,
        );
        for (let ty = 0; ty < tile.height; ty++) {
          for (let tx = 0; tx < tile.width; tx++) {
            const src = (ty * tile.width + tx) * 4;
            const dst = ((tile.dy + ty) * w.width + (tile.dx + tx)) * 4;
            stitched.set(px.subarray(src, src + 4), dst);
          }
        }
      }
      return stitched;
    };
    expect(Array.from(renderTiled(true))).toEqual(Array.from(whole));
    expect(Array.from(renderTiled(false))).not.toEqual(Array.from(whole));
  }, 300000);
});

/**
 * The enemy overlay's OWN windows, and it needs them for the reason Vulcanus's
 * ore block needs its own five.
 *
 * Enemy bases do not spawn inside the starting area, so two of the five windows
 * the tree and rock blocks share carry **zero** enemy pixels - and worse, on
 * the near-spawn window `control:enemy-base:frequency` moves the render by
 * exactly **0 bytes**. A lever test there reports success having graded
 * nothing, which is the failure this whole port keeps re-learning.
 *
 * These five were found by sweeping the far field and then varying width,
 * height, origin and tiles-per-pixel independently across what carried bases,
 * so a swapped width and height or an origin folded into the wrong axis is
 * still visible. Every one carries bases AND moves under both levers.
 */
const ENEMY_WINDOWS: readonly Window[] = [
  {
    label: "far north-east",
    width: 64,
    height: 64,
    originX: 2000.5,
    originY: -2000.25,
    tilesPerPixel: 8,
  },
  { label: "tall", width: 24, height: 96, originX: -2048, originY: 768, tilesPerPixel: 8 },
  {
    label: "wide",
    width: 120,
    height: 40,
    originX: -4000.25,
    originY: -4000.75,
    tilesPerPixel: 12,
  },
  {
    label: "fine, far",
    width: 64,
    height: 64,
    originX: 1500.5,
    originY: 1500.25,
    tilesPerPixel: 2,
  },
  {
    label: "very far, coarse",
    width: 96,
    height: 96,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 16,
  },
];

/** Measured on the TypeScript path before the port. */
const ENEMY_PIXELS_PER_WINDOW = [150, 44, 116, 84, 208];

/**
 * `ENEMY_MAP_COLOR` in `src/noise/enemies/enemyCatalog.ts`.
 *
 * **Not `ENEMY_RGB` above**, which is 25 rather than 26 and is the colour the
 * GAME's own capture paints. The two differ by one in the red-adjacent
 * channels and mean different things: this one is what our overlay writes, that
 * one is what the preview PNG contains and the terrain comparison excludes.
 */
const ENEMY_OVERLAY_RGB = [255, 26, 26] as const;

describe("the WASM engine renders the Nauvis enemy overlay exactly as the TypeScript does", () => {
  const enemyRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "enemies" });

  it("serves the enemies view rather than refusing it", async () => {
    const e = await engine();
    const w = ENEMY_WINDOWS[0];
    const pixels = renderThroughWasm(e, directRequest(w, "enemies"));
    expect(pixels.length).toBe(w.width * w.height * 4);
  }, 300000);

  it("is byte-identical across five windows", async () => {
    const e = await engine();
    for (const w of ENEMY_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(enemyRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(enemyRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("paints enemy pixels in every window, and only enemy-coloured ones", async () => {
    const e = await engine();
    const counts: number[] = [];
    for (const w of ENEMY_WINDOWS) {
      const enemies = new Uint8ClampedArray(runRenderRequest(enemyRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let changed = 0;
      let enemyColoured = 0;
      for (let i = 0; i < enemies.length; i += 4) {
        const was =
          terrain[i] === ENEMY_OVERLAY_RGB[0] &&
          terrain[i + 1] === ENEMY_OVERLAY_RGB[1] &&
          terrain[i + 2] === ENEMY_OVERLAY_RGB[2];
        const is =
          enemies[i] === ENEMY_OVERLAY_RGB[0] &&
          enemies[i + 1] === ENEMY_OVERLAY_RGB[1] &&
          enemies[i + 2] === ENEMY_OVERLAY_RGB[2];
        if (
          enemies[i] !== terrain[i] ||
          enemies[i + 1] !== terrain[i + 1] ||
          enemies[i + 2] !== terrain[i + 2]
        ) {
          changed++;
        }
        if (is && !was) enemyColoured++;
      }
      expect(enemyColoured, `${w.label}: every changed pixel must be enemy-coloured`).toBe(changed);
      counts.push(changed);
    }
    expect(counts).toEqual(ENEMY_PIXELS_PER_WINDOW);
  }, 300000);

  it("moving each enemy lever moves the render on both paths together", async () => {
    // The window is the FAR one, not the near-spawn one every other block uses:
    // `frequency` moves 0 bytes near spawn, so that test would be vacuous. Here
    // the two levers move 328 and 587 bytes, measured on the TypeScript path.
    const e = await engine();
    const base = enemyRequest(ENEMY_WINDOWS[4]);
    const flat = (req: ElevationRenderRequest, eng?: typeof e): number[] =>
      Array.from(new Uint8ClampedArray(runRenderRequest(req, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);
    for (const [label, patch] of [
      ["enemyControls.frequency", { enemyControls: { frequency: 3, size: 1 } }],
      ["enemyControls.size", { enemyControls: { frequency: 1, size: 3 } }],
    ] as const) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const moved = flat(req, e);
      expect(moved, `${label}: the two paths must agree`).toEqual(flat(req));
      expect(moved, `${label}: must actually move the render`).not.toEqual(baseWasm);
    }
  }, 300000);

  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    const e = await engine();
    const w = ENEMY_WINDOWS[4];
    const whole = new Uint8ClampedArray(runRenderRequest(enemyRequest(w), e).buffer);
    const full = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const renderTiled = (withHalo: boolean): Uint8ClampedArray => {
      const stitched = new Uint8ClampedArray(whole.length);
      for (const tile of planTiles(full, 32)) {
        const px = new Uint8ClampedArray(
          runRenderRequest(
            {
              ...enemyRequest(w),
              width: tile.width,
              height: tile.height,
              originX: tile.originX,
              originY: tile.originY,
              ...(withHalo ? { fullImage: full } : {}),
            },
            e,
          ).buffer,
        );
        for (let ty = 0; ty < tile.height; ty++) {
          for (let tx = 0; tx < tile.width; tx++) {
            const src = (ty * tile.width + tx) * 4;
            const dst = ((tile.dy + ty) * w.width + (tile.dx + tx)) * 4;
            stitched.set(px.subarray(src, src + 4), dst);
          }
        }
      }
      return stitched;
    };
    expect(Array.from(renderTiled(true))).toEqual(Array.from(whole));
    expect(Array.from(renderTiled(false))).not.toEqual(Array.from(whole));
  }, 300000);
});

/**
 * The cliff overlay's OWN windows, for the same reason the enemy block has its
 * own - and the lever sweep behind them is worth reading before changing any.
 *
 * Two of the five shared windows carry ZERO cliff pixels. Worse, on the
 * near-spawn window TWO levers move the render by exactly 0 bytes:
 * `cliffElevationInterval` and `waterLevel`. Reasoning from that would conclude
 * the interval is unwired, or that the cliff view ignores water. Both are
 * false - in the far field the interval moves 135 to 555 pixels and the water
 * level moves 30 to 1,796. The near-spawn zero is the masking issue #320
 * records for the terrain view, showing up again in the choice of window.
 *
 * So: sweep the lever, do not reason about it. These five were swept, and every
 * one of them moves under every lever this block grades.
 */
const CLIFF_WINDOWS: readonly Window[] = [
  { label: "tall", width: 24, height: 96, originX: -2048, originY: 768, tilesPerPixel: 8 },
  { label: "fine", width: 96, height: 96, originX: 4000.5, originY: -3000.25, tilesPerPixel: 2 },
  {
    label: "wide",
    width: 120,
    height: 40,
    originX: -4000.25,
    originY: -4000.75,
    tilesPerPixel: 12,
  },
  { label: "far", width: 48, height: 48, originX: 4000.25, originY: -3000.75, tilesPerPixel: 16 },
  {
    label: "very far",
    width: 96,
    height: 96,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 16,
  },
];

/** Measured on the TypeScript path before the port. */
const CLIFF_PIXELS_PER_WINDOW = [425, 152, 1125, 1080, 2584];

/** `CLIFF_MAP_COLOR` in `src/noise/cliffs/cliffCatalog.ts`. Both planets share it. */
const CLIFF_RGB = [144, 119, 87] as const;

describe("the WASM engine renders the Nauvis cliff overlay exactly as the TypeScript does", () => {
  const cliffRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "cliffs" });

  it("serves the cliffs view rather than refusing it", async () => {
    const e = await engine();
    const pixels = renderThroughWasm(e, directRequest(CLIFF_WINDOWS[0], "cliffs"));
    expect(pixels.length).toBe(CLIFF_WINDOWS[0].width * CLIFF_WINDOWS[0].height * 4);
  }, 300000);

  it("is byte-identical across five windows", async () => {
    const e = await engine();
    for (const w of CLIFF_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(cliffRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(cliffRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("paints cliff pixels in every window, and only cliff-coloured ones", async () => {
    const e = await engine();
    const counts: number[] = [];
    for (const w of CLIFF_WINDOWS) {
      const cliffs = new Uint8ClampedArray(runRenderRequest(cliffRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let changed = 0;
      let cliffColoured = 0;
      for (let i = 0; i < cliffs.length; i += 4) {
        const was =
          terrain[i] === CLIFF_RGB[0] &&
          terrain[i + 1] === CLIFF_RGB[1] &&
          terrain[i + 2] === CLIFF_RGB[2];
        const is =
          cliffs[i] === CLIFF_RGB[0] &&
          cliffs[i + 1] === CLIFF_RGB[1] &&
          cliffs[i + 2] === CLIFF_RGB[2];
        if (
          cliffs[i] !== terrain[i] ||
          cliffs[i + 1] !== terrain[i + 1] ||
          cliffs[i + 2] !== terrain[i + 2]
        ) {
          changed++;
        }
        if (is && !was) cliffColoured++;
      }
      expect(cliffColoured, `${w.label}: every changed pixel must be cliff-coloured`).toBe(changed);
      counts.push(changed);
    }
    expect(counts).toEqual(CLIFF_PIXELS_PER_WINDOW);
  }, 300000);

  it("moving each cliff lever moves the render on both paths together", async () => {
    // Six levers, and `waterLevel` is one of them - which is the interesting
    // case. The TERRAIN view ignores it (#326, reproduced deliberately), so
    // this is the first Nauvis pass where the module must actually READ the
    // water level rather than pin it to zero. Both behaviours live in the same
    // request.
    const e = await engine();
    const base = cliffRequest(CLIFF_WINDOWS[4]);
    const flat = (req: ElevationRenderRequest, eng?: typeof e): number[] =>
      Array.from(new Uint8ClampedArray(runRenderRequest(req, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);
    for (const [label, patch] of [
      // Frequency has to reach the slider's MINIMUM to grade much - see the
      // cliff-lever note in CLAUDE.md, measured over 1600 positions.
      ["cliffControls.frequency", { cliffControls: { frequency: 1 / 6, continuity: 1 } }],
      ["cliffControls.continuity", { cliffControls: { frequency: 1, continuity: 3 } }],
      [
        "cliffSettings.cliffElevation0",
        { cliffSettings: { cliffElevation0: 30, cliffElevationInterval: 40, richness: 1 } },
      ],
      [
        "cliffSettings.cliffElevationInterval",
        { cliffSettings: { cliffElevation0: 10, cliffElevationInterval: 20, richness: 1 } },
      ],
      ["waterLevel", { waterLevel: 5 }],
    ] as const) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const moved = flat(req, e);
      expect(moved, `${label}: the two paths must agree`).toEqual(flat(req));
      expect(moved, `${label}: must actually move the render`).not.toEqual(baseWasm);
    }
  }, 300000);

  it("richness 0 disables the overlay entirely on both paths", async () => {
    // A separate case because it is the one lever whose effect is REMOVAL. It
    // must take the render back to bare terrain exactly, not merely change it.
    const e = await engine();
    const w = CLIFF_WINDOWS[4];
    const off = {
      ...cliffRequest(w),
      cliffSettings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 0 },
    } as ElevationRenderRequest;
    const terrain = Array.from(new Uint8ClampedArray(runRenderRequest(request(w), e).buffer));
    expect(Array.from(new Uint8ClampedArray(runRenderRequest(off, e).buffer))).toEqual(terrain);
    expect(Array.from(new Uint8ClampedArray(runRenderRequest(off).buffer))).toEqual(terrain);
  }, 300000);

  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    // The cliff halo is the ASYMMETRIC one: the block spans `px - 2 ..= px + 1`,
    // so a cell reaching backwards has to be caught from AHEAD of the tile.
    // That is why this box is sent separately from the placement sweep box
    // rather than one serving both.
    const e = await engine();
    const w = CLIFF_WINDOWS[4];
    const whole = new Uint8ClampedArray(runRenderRequest(cliffRequest(w), e).buffer);
    const full = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const renderTiled = (withHalo: boolean): Uint8ClampedArray => {
      const stitched = new Uint8ClampedArray(whole.length);
      for (const tile of planTiles(full, 32)) {
        const px = new Uint8ClampedArray(
          runRenderRequest(
            {
              ...cliffRequest(w),
              width: tile.width,
              height: tile.height,
              originX: tile.originX,
              originY: tile.originY,
              ...(withHalo ? { fullImage: full } : {}),
            },
            e,
          ).buffer,
        );
        for (let ty = 0; ty < tile.height; ty++) {
          for (let tx = 0; tx < tile.width; tx++) {
            const src = (ty * tile.width + tx) * 4;
            const dst = ((tile.dy + ty) * w.width + (tile.dx + tx)) * 4;
            stitched.set(px.subarray(src, src + 4), dst);
          }
        }
      }
      return stitched;
    };
    expect(Array.from(renderTiled(true))).toEqual(Array.from(whole));
    expect(Array.from(renderTiled(false))).not.toEqual(Array.from(whole));
  }, 300000);
});

/**
 * The resource overlay's OWN windows, and the search behind them is the point.
 *
 * **Crude oil appeared in exactly ONE of ten windows swept**, at 9 pixels. That
 * matters far more than its size: oil is the only ROLLED Nauvis resource - the
 * other five are pure threshold predicates - so it is the only thing that
 * grades the roll, the 3x3 mark and the sweep box in this layer. Nine of the
 * ten candidates would have graded the threshold path alone while looking
 * complete.
 *
 * Between them the six cover all six catalog entries, and they vary width,
 * height, origin and tiles-per-pixel independently across what carried ore.
 */
const RESOURCE_WINDOWS: readonly Window[] = [
  {
    label: "fine at spawn",
    width: 96,
    height: 96,
    originX: -48.5,
    originY: -48.25,
    tilesPerPixel: 1,
  },
  {
    label: "wide at spawn",
    width: 128,
    height: 128,
    originX: -128,
    originY: -128,
    tilesPerPixel: 4,
  },
  {
    label: "north-east",
    width: 96,
    height: 96,
    originX: 2000.5,
    originY: -2000.25,
    tilesPerPixel: 16,
  },
  {
    label: "wide, far",
    width: 160,
    height: 40,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 32,
  },
  {
    label: "tall, far",
    width: 40,
    height: 160,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 32,
  },
  {
    label: "all six, far",
    width: 96,
    height: 96,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 32,
  },
];

/**
 * Pixels each resource paints per window, in catalog order.
 *
 * Rows in `RESOURCE_WINDOWS` order, columns iron, copper, coal, stone, oil,
 * uranium. Measured on the TypeScript path before the port.
 *
 * **The zeros are the informative part**, as they are in the Vulcanus ore
 * table. Each window carries a different mix, so a resolver wired to one region
 * field for all six would show the same column everywhere. And every column
 * sums above zero, which the test asserts separately - no entry is graded only
 * by its own zeros.
 */
const ORE_PIXELS = [
  [0, 0, 184, 149, 0, 0],
  [42, 51, 41, 21, 0, 18],
  [40, 37, 19, 14, 0, 4],
  [13, 17, 14, 7, 0, 2],
  [17, 17, 14, 9, 0, 1],
  [28, 32, 20, 11, 9, 3],
];

/** `mapColor` for each entry of `RESOURCE_CATALOG`, in its own order. */
const ORE_RGB = [
  [106, 134, 148],
  [205, 99, 55],
  [0, 0, 0],
  [176, 156, 109],
  [199, 51, 196],
  [0, 179, 0],
] as const;

describe("the WASM engine renders the Nauvis resource overlay exactly as the TypeScript does", () => {
  const resourceRequest = (w: Window): ElevationRenderRequest => ({
    ...request(w),
    view: "resources",
  });

  it("serves the resources view rather than refusing it", async () => {
    const e = await engine();
    const w = RESOURCE_WINDOWS[0];
    const pixels = renderThroughWasm(e, directRequest(w, "resources"));
    expect(pixels.length).toBe(w.width * w.height * 4);
  }, 300000);

  it("is byte-identical across six windows", async () => {
    const e = await engine();
    for (const w of RESOURCE_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(resourceRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(resourceRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("paints each entry's own map colour, at the counts measured", async () => {
    const e = await engine();
    const table: number[][] = [];
    for (const w of RESOURCE_WINDOWS) {
      const ore = new Uint8ClampedArray(runRenderRequest(resourceRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      const row = ORE_RGB.map((c) => {
        let n = 0;
        for (let i = 0; i < ore.length; i += 4) {
          const is = ore[i] === c[0] && ore[i + 1] === c[1] && ore[i + 2] === c[2];
          const was = terrain[i] === c[0] && terrain[i + 1] === c[1] && terrain[i + 2] === c[2];
          if (is && !was) n++;
        }
        return n;
      });
      table.push(row);
    }
    expect(table).toEqual(ORE_PIXELS);
    // No entry is graded only by its own zeros.
    const perEntry = ORE_RGB.map((_, c) => table.reduce((sum, row) => sum + row[c], 0));
    expect(perEntry.every((n) => n > 0)).toBe(true);
  }, 300000);

  it("moving one resource's levers moves only that resource", async () => {
    // The check the eighteen-lever block needs and the round-trip fixture
    // cannot give: a triple written to the wrong offset decodes as a
    // NEIGHBOUR's, which is a plausible planet with two ores exchanged. Moving
    // iron alone must move the render, and moving it must not be the same as
    // moving copper alone.
    const e = await engine();
    const w = RESOURCE_WINDOWS[1];
    const base = resourceRequest(w);
    const flat = (req: ElevationRenderRequest, eng?: typeof e): number[] =>
      Array.from(new Uint8ClampedArray(runRenderRequest(req, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);

    const withLevers = (name: string): ElevationRenderRequest => ({
      ...base,
      resourceControls: { [name]: { frequency: 3, size: 2, richness: 1 } },
    });
    const iron = flat(withLevers("iron-ore"), e);
    const copper = flat(withLevers("copper-ore"), e);
    expect(iron, "iron: the two paths must agree").toEqual(flat(withLevers("iron-ore")));
    expect(copper, "copper: the two paths must agree").toEqual(flat(withLevers("copper-ore")));
    expect(iron, "iron levers must move the render").not.toEqual(baseWasm);
    expect(copper, "copper levers must move the render").not.toEqual(baseWasm);
    expect(iron, "iron and copper must not be the same edit").not.toEqual(copper);
  }, 300000);

  it("tiles to the same bytes as one whole render, on the window that carries oil", async () => {
    // The oil window specifically. The five thresholded resources paint one
    // pixel each and sweep the request's own box, so they cannot straddle a
    // seam at all - only oil's 3x3 mark needs the halo, and only this window
    // has any oil to grade it with.
    const e = await engine();
    const w = RESOURCE_WINDOWS[5];
    const whole = new Uint8ClampedArray(runRenderRequest(resourceRequest(w), e).buffer);
    const full = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const stitched = new Uint8ClampedArray(whole.length);
    for (const tile of planTiles(full, 32)) {
      const px = new Uint8ClampedArray(
        runRenderRequest(
          {
            ...resourceRequest(w),
            width: tile.width,
            height: tile.height,
            originX: tile.originX,
            originY: tile.originY,
            fullImage: full,
          },
          e,
        ).buffer,
      );
      for (let ty = 0; ty < tile.height; ty++) {
        for (let tx = 0; tx < tile.width; tx++) {
          const src = (ty * tile.width + tx) * 4;
          const dst = ((tile.dy + ty) * w.width + (tile.dx + tx)) * 4;
          stitched.set(px.subarray(src, src + 4), dst);
        }
      }
    }
    expect(Array.from(stitched)).toEqual(Array.from(whole));
  }, 300000);
});

/**
 * The `all` composite: terrain plus every overlay, in the renderer's own order.
 *
 * Pixels the composite changes against bare terrain, per window. Measured on
 * the TypeScript path before the port.
 */
const ALL_PIXELS_PER_WINDOW = [7724, 7195, 5135, 6405];

const ALL_WINDOWS: readonly Window[] = [
  {
    label: "wide at spawn",
    width: 128,
    height: 128,
    originX: -128,
    originY: -128,
    tilesPerPixel: 4,
  },
  {
    label: "all six, far",
    width: 96,
    height: 96,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 32,
  },
  {
    label: "very far",
    width: 96,
    height: 96,
    originX: -6000.5,
    originY: 6000.25,
    tilesPerPixel: 16,
  },
  {
    label: "north-east",
    width: 96,
    height: 96,
    originX: 2000.5,
    originY: -2000.25,
    tilesPerPixel: 16,
  },
];

describe("the WASM engine renders the Nauvis `all` composite exactly as the TypeScript does", () => {
  const allRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "all" });

  it("serves the all view rather than refusing it", async () => {
    const e = await engine();
    const w = ALL_WINDOWS[0];
    const pixels = renderThroughWasm(e, directRequest(w, "all"));
    expect(pixels.length).toBe(w.width * w.height * 4);
  }, 300000);

  it("is byte-identical across four windows", async () => {
    const e = await engine();
    for (const w of ALL_WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(allRequest(w), e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(allRequest(w)).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("differs from bare terrain, at the counts measured", async () => {
    // Anti-vacuity for the comparison above: two renderers that both painted
    // nothing over terrain would be byte-identical too.
    const e = await engine();
    const counts: number[] = [];
    for (const w of ALL_WINDOWS) {
      const all = new Uint8ClampedArray(runRenderRequest(allRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let changed = 0;
      for (let i = 0; i < all.length; i += 4) {
        if (
          all[i] !== terrain[i] ||
          all[i + 1] !== terrain[i + 1] ||
          all[i + 2] !== terrain[i + 2]
        ) {
          changed++;
        }
      }
      counts.push(changed);
    }
    expect(counts).toEqual(ALL_PIXELS_PER_WINDOW);
  }, 300000);

  it("paints resources under the obstructions, and trees under everything", async () => {
    // The paint ORDER, asserted rather than described.
    //
    // Trees, then resources, then rocks, enemies and cliffs over the top - so
    // an obstruction crossing an ore patch reads as the thing that is in the
    // way, and a forest reads as cleared rather than as an obstacle. Reordering
    // the passes changes only the pixels where two of them land, which is
    // invisible to a whole-image count and is exactly what this counts.
    //
    // **This window is the only one of the four where all THREE obstruction
    // types cover ore.** The near-spawn one has no enemies and no cliffs at
    // all, so its `byEnemy` and `byCliff` would both be 0 and two thirds of the
    // assertion would grade nothing. Painting resources LAST would take all
    // four numbers to zero.
    const e = await engine();
    const w = ALL_WINDOWS[2];
    const all = new Uint8ClampedArray(runRenderRequest(allRequest(w), e).buffer);
    const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
    const res = new Uint8ClampedArray(
      new Uint8ClampedArray(runRenderRequest({ ...request(w), view: "resources" }, e).buffer),
    );
    const at = (px: Uint8ClampedArray, i: number, c: readonly number[]): boolean =>
      px[i] === c[0] && px[i + 1] === c[1] && px[i + 2] === c[2];
    let ore = 0;
    let covered = 0;
    let byRock = 0;
    let byEnemy = 0;
    let byCliff = 0;
    for (let i = 0; i < all.length; i += 4) {
      const wasOre = ORE_RGB.some((c) => at(res, i, c)) && !ORE_RGB.some((c) => at(terrain, i, c));
      if (!wasOre) continue;
      ore++;
      if (ORE_RGB.some((c) => at(all, i, c))) continue;
      covered++;
      if (at(all, i, ROCK_RGB)) byRock++;
      else if (at(all, i, ENEMY_OVERLAY_RGB)) byEnemy++;
      else if (at(all, i, CLIFF_RGB)) byCliff++;
    }
    expect({ ore, covered, byRock, byEnemy, byCliff }).toEqual({
      ore: 69,
      covered: 30,
      byRock: 1,
      byEnemy: 1,
      byCliff: 28,
    });
  }, 300000);

  it("routes every view the planet has through the engine", async () => {
    // The test that used to assert the opposite. Each of the seven views must
    // now agree between the engine and the TypeScript, and `all` must actually
    // differ from bare terrain - otherwise this is comparing two copies of the
    // same picture seven times.
    const e = await engine();
    const w = ALL_WINDOWS[2];
    for (const view of [
      "terrain",
      "trees",
      "rocks",
      "enemies",
      "cliffs",
      "resources",
      "all",
    ] as const) {
      const req = { ...request(w), view } as ElevationRenderRequest;
      expect(
        Array.from(new Uint8ClampedArray(runRenderRequest(req, e).buffer)),
        `${view}: engine and TypeScript must agree`,
      ).toEqual(Array.from(new Uint8ClampedArray(runRenderRequest(req).buffer)));
    }
    const all = Array.from(new Uint8ClampedArray(runRenderRequest(allRequest(w), e).buffer));
    const terrain = Array.from(new Uint8ClampedArray(runRenderRequest(request(w), e).buffer));
    expect(all).not.toEqual(terrain);
  }, 300000);
});

describe("the WASM engine's Nauvis terrain against the game's own preview", () => {
  it("differs from the game at exactly the pixels the TypeScript does", async () => {
    const e = await engine();
    const png = decodePng(
      new Uint8Array(readFileSync(join(FIXTURES, "oracle-preview-nauvis-terrain.seed123456.png"))),
      (b) => new Uint8Array(inflateSync(b)),
    );
    expect([png.width, png.height]).toEqual([SIZE, SIZE]);

    const ours = new Uint8ClampedArray(
      runRenderRequest(
        {
          id: 1,
          view: "terrain",
          seed0: SEED,
          width: SIZE,
          height: SIZE,
          originX: -SIZE / 2,
          originY: -SIZE / 2,
          tilesPerPixel: 1,
          waterLevel: 0,
          segmentationMultiplier: 1,
          startingPositions: [{ x: 0, y: 0 }],
        },
        e,
      ).buffer,
    );

    // ONE definition of the mask, handed to both the counting loop and the
    // artifact writer - written twice the copies drift, and then the artifacts
    // describe a different comparison than the assertion that failed.
    // `decodePng` returns RGB at stride 3, NOT RGBA. Reading it at stride 4
    // silently compares the wrong pixels - it reported 283 enemy pixels against
    // the real 1,189, which looks like a render difference rather than an
    // indexing one.
    const gameAt = (i: number) => [png.rgb[i * 3], png.rgb[i * 3 + 1], png.rgb[i * 3 + 2]];
    const oursAt = (i: number) => [ours[i * 4], ours[i * 4 + 1], ours[i * 4 + 2]];
    const ignore = (i: number): boolean => {
      const g = gameAt(i);
      return g[0] === ENEMY_RGB[0] && g[1] === ENEMY_RGB[1] && g[2] === ENEMY_RGB[2];
    };

    let enemyPx = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (ignore(i)) {
        enemyPx++;
        continue;
      }
      const g = gameAt(i);
      const o = oursAt(i);
      if (g[0] !== o[0] || g[1] !== o[1] || g[2] !== o[2]) differing++;
    }

    withDiffArtifacts(
      {
        spec: "wasmNauvisRenderParity",
        case: "nauvis-terrain",
        game: png,
        ours: { width: SIZE, height: SIZE, rgba: ours },
        ignore,
      },
      () => {
        expect(enemyPx).toBe(ENEMY_PX);
        expect(differing).toBe(DIFFERING_PX);
        expect(SIZE * SIZE - enemyPx).toBe(1047387);
      },
    );
  }, 300000);
});
