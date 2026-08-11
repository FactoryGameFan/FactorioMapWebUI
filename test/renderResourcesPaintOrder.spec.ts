/**
 * Crude oil vs. the thresholded resources: which one owns a shared pixel.
 *
 * `renderResources` paints oil's 3x3 marks in pass 1 and the thresholded
 * resources over the top in pass 2, which is right for the four solids
 * (autoplace order "b" beats oil's "c") and **wrong for uranium**, which is also
 * "c" but sorts after oil (`patchSetIndex` 5 vs 4). Issue #22 item 3 recorded
 * that inversion as latent on the strength of a single measurement - over
 * `[-2048,-2048]-[2048,2048]` at seed 123456 the oil and uranium footprints share
 * 0 tiles - and it was a property of that seed, not of the geometry.
 *
 * The sweep that refuted it (2026-08-10, default controls, `frequency = size = 1`):
 *
 * | arm | result |
 * | --- | --- |
 * | 256 windows of 4096^2 (4.3e9 tiles), 128 seeds at `[-2048, 2048)^2` + 128 at `[65536, 69632)^2` | 5 windows (2.0%) have overlapping footprints; 2 of those are near-spawn, i.e. the same box the original zero came from |
 * | 1024 windows of 4096^2 (1.7e10 tiles), 290,335 oil wells | 7 wells overwritten by uranium, 5 of them on all 9 mark pixels |
 *
 * The three cases below are that sweep's output, one per behaviour the paint
 * order has to get right. They are deliberately at three different control
 * settings, because the two settings differ by three orders of magnitude in how
 * often this happens:
 *
 * - **default controls, a hidden well.** ~1 well in 41,000 - rare, and real.
 * - **600% frequency and size, a hidden well.** Both are notches the game's own
 *   map-gen GUI offers (`PERCENT_STEPS` tops out at 6), and at that setting seed
 *   **123456** - the seed the original zero was measured on - hides two wells
 *   inside `[-1024, 1024)^2` alone. This is not an exotic configuration.
 * - **600% frequency and size, a well under iron.** The arm that fails if the fix
 *   is "paint oil last" rather than "paint oil last where oil outranks the
 *   winner". Without it, a guard that reversed the whole order would pass.
 *
 * Each case was confirmed to discriminate by running this file against the
 * pre-guard renderer: the first two came back solid uranium green on all 9
 * pixels, and the third was unaffected.
 */
import { describe, expect, it } from "vite-plus/test";
import { renderResources } from "../src/noise/preview/renderResources";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";

const colorOf = (name: string): string => {
  const p = RESOURCE_CATALOG.find((r) => r.name === name);
  if (p === undefined) throw new Error(`${name} missing from RESOURCE_CATALOG`);
  return p.mapColor.join(",");
};
const OIL = colorOf("crude-oil");
const URANIUM = colorOf("uranium-ore");
const IRON = colorOf("iron-ore");

/** A base filled with a sentinel colour no resource uses, alpha 255. */
function sentinelBase(w: number, h: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = 7;
    d[i * 4 + 1] = 8;
    d[i * 4 + 2] = 9;
    d[i * 4 + 3] = 255;
  }
  return new ImageData(d, w, h);
}

const levers = (v: number) => ({ frequency: v, size: v, richness: 1 });
const allControls = (v: number): Record<string, ReturnType<typeof levers>> =>
  Object.fromEntries(RESOURCE_CATALOG.map((p) => [p.controlName, levers(v)]));

/** The 3x3 mark centred on world tile (wx, wy), rendered at 1 tile per pixel. */
function markColors(seed0: number, wx: number, wy: number, control: number): string[] {
  const base = sentinelBase(3, 3);
  renderResources(base, {
    seed0,
    originX: wx - 1,
    originY: wy - 1,
    tilesPerPixel: 1,
    controls: allControls(control),
  });
  const out: string[] = [];
  for (let i = 0; i < 9; i++) {
    out.push(`${base.data[i * 4]},${base.data[i * 4 + 1]},${base.data[i * 4 + 2]}`);
  }
  return out;
}

describe("renderResources paint order", () => {
  it("keeps an oil well that a uranium patch covers - default controls", () => {
    // Found by the 1024-window sweep; the well is at the centre of a uranium patch.
    expect(markColors(2980111949, -1584, 513, 1)).toEqual(Array<string>(9).fill(OIL));
  });

  it("keeps an oil well that a uranium patch covers - 600% frequency and size", () => {
    // Seed 123456: the very seed whose "0 shared tiles" made this look unreachable.
    expect(markColors(123456, 600, 895, 6)).toEqual(Array<string>(9).fill(OIL));
  });

  it("still lets iron ore cover an oil well - the solids outrank oil", () => {
    expect(markColors(123456, 675, -508, 6)).toEqual(Array<string>(9).fill(IRON));
  });

  it("leaves uranium alone where no oil well sits under it", () => {
    // One tile off the hidden well above, outside its 3x3 mark: still uranium.
    expect(markColors(2980111949, -1584, 517, 1)).toEqual(Array<string>(9).fill(URANIUM));
  });
});
