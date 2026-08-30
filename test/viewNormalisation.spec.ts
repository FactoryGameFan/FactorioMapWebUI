import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";

/**
 * The four `(planet, view)` pairs that have no renderer of their own.
 *
 * Vulcanus has no enemy bases, no trees and no ocean; Nauvis has no land mask.
 * Asking for one of those has always produced the planet's plain terrain -
 * the overlay blocks never match, and the land-mask branch is Fulgora's alone -
 * and until this file **nothing asserted that in either direction**. The
 * closest thing, `test/wasmVulcanusRenderParity.spec.ts`'s "routes every view
 * the planet has through the engine", iterates the five ported Vulcanus views
 * and documents the hole in a comment without covering it.
 *
 * That mattered as soon as #227 came to delete the TypeScript terrain
 * renderers those four land on. The Rust engine refuses all four pairings
 * outright, so the fall-through had to become explicit - `servedView` - and the
 * whole risk of doing that is moving pixels that nothing was watching. This
 * file is the watch.
 *
 * Both arms are asserted deliberately. The engine arm is what survives the
 * deletion; the no-engine arm is what proves the normalisation preserved
 * today's answer rather than merely producing a self-consistent new one.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

let compiled: WebAssembly.Module | undefined;
async function engine() {
  compiled ??= await compileEngine(readFileSync(wasmPath));
  return instantiateEngine(compiled);
}

/**
 * Small and off-origin on purpose: big enough that the terrain carries several
 * colours (the anti-vacuity block below pins that), small enough that four
 * pairs times three renders stays quick.
 */
const BASE = {
  id: 1,
  seed0: 123456,
  width: 48,
  height: 48,
  originX: -96,
  originY: -96,
  tilesPerPixel: 4,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
} satisfies Omit<ElevationRenderRequest, "planet" | "view">;

/** Every pair `servedView` normalises, with the label used in failures. */
const FALL_THROUGH = [
  { label: "vulcanus enemies", planet: "vulcanus", view: "enemies" },
  { label: "vulcanus trees", planet: "vulcanus", view: "trees" },
  { label: "vulcanus landmask", planet: "vulcanus", view: "landmask" },
  { label: "nauvis landmask", planet: "nauvis", view: "landmask" },
] as const;

function pixels(
  planet: ElevationRenderRequest["planet"],
  view: ElevationRenderRequest["view"],
  e?: Awaited<ReturnType<typeof engine>>,
): Uint8ClampedArray {
  return new Uint8ClampedArray(runRenderRequest({ ...BASE, planet, view }, e).buffer);
}

/** The set of distinct `r,g,b` triples in a render, packed one per number. */
function colours(px: Uint8ClampedArray): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i += 4) seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
  return seen;
}

describe("the four views with no renderer of their own render that planet's terrain", () => {
  it("is byte-identical to terrain through the engine, for all four", async () => {
    const e = await engine();
    for (const c of FALL_THROUGH) {
      const got = pixels(c.planet, c.view, e);
      const terrain = pixels(c.planet, "terrain", e);
      expect(got.length, `${c.label}: length`).toBe(BASE.width * BASE.height * 4);
      expect(Array.from(got), `${c.label}: pixels`).toEqual(Array.from(terrain));
    }
  }, 120000);

  /**
   * Without this the block above would pass against a blank image, which is
   * exactly the failure a normalisation bug produces: route the request
   * somewhere that paints nothing and every equality still holds.
   */
  it("is not vacuous - each planet's terrain carries several colours", async () => {
    const e = await engine();
    for (const c of FALL_THROUGH) {
      const distinct = colours(pixels(c.planet, c.view, e));
      expect(distinct.size, `${c.label}: distinct colours`).toBeGreaterThan(1);
    }
  }, 120000);

  /**
   * That the pair reaches the MODULE, not merely that it reaches terrain.
   *
   * Planted while writing this file: dropping the Nauvis `landmask` arm from
   * `servedView` altogether left the block above green, because an
   * un-normalised pair falls through to `renderTerrain` and paints the same
   * bytes. Equality against terrain therefore grades the normalisation TARGET
   * and not its PRESENCE - it would go quietly green again the day someone
   * deleted an arm.
   *
   * The module's output buffer settles it. A request the engine serves writes
   * there; a request that fell through to TypeScript cannot have. This is the
   * idiom `test/wasmIslandFinderParity.spec.ts` uses for the same question.
   *
   * A fresh instance per pair, so a previous render cannot be mistaken for
   * this one.
   */
  it("reaches the engine rather than falling through, for all four", async () => {
    for (const c of FALL_THROUGH) {
      const e = await engine();
      const view = () => new Uint8Array(e.memory.buffer, e.render_ptr(), 64).slice();
      const before = view();
      runRenderRequest({ ...BASE, planet: c.planet, view: c.view }, e);
      expect(Array.from(view()), `${c.label}: module buffer written`).not.toEqual(
        Array.from(before),
      );
    }
  }, 120000);

  /**
   * **The arm #227 deletes.**
   *
   * While the TypeScript terrain renderers still exist, each of the four can be
   * rendered with no engine at all, and that render is the one this change had
   * to preserve - it is what these pairs drew before `servedView` existed. Once
   * `renderTerrain` and `renderVulcanusTerrain` are deleted there is no second
   * arm and this block goes with them, which is why the engine-side assertions
   * are kept above rather than folded in here.
   */
  it("renders identically with and without the engine, for all four", async () => {
    const e = await engine();
    for (const c of FALL_THROUGH) {
      const withEngine = pixels(c.planet, c.view, e);
      const withoutEngine = pixels(c.planet, c.view);
      expect(Array.from(withEngine), `${c.label}: engine vs none`).toEqual(
        Array.from(withoutEngine),
      );
    }
  }, 120000);
});
