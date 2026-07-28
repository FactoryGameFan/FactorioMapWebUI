import { describe, expect, it } from "vite-plus/test";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";

/**
 * The fused Vulcanus prototype (issue #19 follow-up) must be a pure performance
 * change: `fusedPrototype: true` has to produce the SAME BYTES as the shipped
 * sequential path, or the measurement it enables is meaningless.
 *
 * The risk it guards is paint ORDER, which is observable because the geyser
 * paints a 3x3 mark. The shipped order is terrain -> geyser marks -> thresholded
 * ore (over the top) -> rocks -> cliffs. The fused loop DECIDES the ore pass
 * while it is resolving terrain, so it must still DEFER painting it until after
 * the geyser marks - which is what `paintOre` exists for. Painting ore as it is
 * decided passes a naive spot check and corrupts exactly the pixels where a
 * geyser mark overlaps an ore body.
 */
/**
 * 256x256, not 128x128, and these origins specifically. At 128x128 the Vulcanus
 * resource overlay paints NOTHING in five of seven sampled windows - including
 * (0,0) - so a byte-equality test there compares two empty overlays and passes
 * without exercising the fused path at all. Ore pixels repainted per window,
 * measured 2026-07-28: (0,0) 1026, (1500,1500) 4485, (-256,-256) 3412.
 */
const SIZE = 256;
const REGIONS = [
  { originX: 0, originY: 0, label: "origin (0,0) - near spawn", minOre: 500 },
  { originX: 1500, originY: 1500, label: "origin (1500,1500) - far field", minOre: 2000 },
  { originX: -256, originY: -256, label: "origin (-256,-256) - geyser-bearing", minOre: 1500 },
];

describe("Vulcanus fused prototype is byte-identical to the sequential path", () => {
  for (const view of ["resources", "all"] as const) {
    for (const r of REGIONS) {
      it(`view=${view} @ ${r.label}`, () => {
        const base = {
          id: 0,
          seed0: 123456,
          width: SIZE,
          height: SIZE,
          originX: r.originX,
          originY: r.originY,
          tilesPerPixel: 1,
          waterLevel: 0,
          segmentationMultiplier: 1,
          startingPositions: [{ x: 0, y: 0 }],
          mapType: "nauvis" as const,
          planet: "vulcanus" as const,
          view,
        };
        const sequential = new Uint8Array(runRenderRequest({ ...base }).buffer);
        const fused = new Uint8Array(runRenderRequest({ ...base, fusedPrototype: true }).buffer);

        expect(fused.length).toBe(sequential.length);
        let firstDiff = -1;
        let diffs = 0;
        for (let i = 0; i < sequential.length; i++)
          if (sequential[i] !== fused[i]) {
            diffs++;
            if (firstDiff < 0) firstDiff = i;
          }
        if (diffs > 0) {
          const px = Math.floor(firstDiff / 4);
          throw new Error(
            `${String(diffs)} differing bytes; first at pixel (${String(px % SIZE)},${String(Math.floor(px / SIZE))})`,
          );
        }
        expect(diffs).toBe(0);
      }, 120000);
    }
  }

  for (const r of REGIONS) {
    it(`is not vacuous @ ${r.label} - the overlay really paints there`, () => {
      // Without this, byte-equality passes just as happily over a window where
      // the resource overlay painted nothing - which is exactly what a 128x128
      // window at (0,0) does. The fused path only changes the ore pass, so the
      // ore pass has to be non-empty for the comparison to mean anything.
      const base = {
        id: 0,
        seed0: 123456,
        width: SIZE,
        height: SIZE,
        originX: r.originX,
        originY: r.originY,
        tilesPerPixel: 1,
        waterLevel: 0,
        segmentationMultiplier: 1,
        startingPositions: [{ x: 0, y: 0 }],
        mapType: "nauvis" as const,
        planet: "vulcanus" as const,
      };
      const terrain = new Uint8Array(runRenderRequest({ ...base, view: "terrain" }).buffer);
      const resources = new Uint8Array(runRenderRequest({ ...base, view: "resources" }).buffer);
      let changed = 0;
      for (let i = 0; i < terrain.length; i += 4)
        if (
          terrain[i] !== resources[i] ||
          terrain[i + 1] !== resources[i + 1] ||
          terrain[i + 2] !== resources[i + 2]
        )
          changed++;
      expect(changed).toBeGreaterThan(r.minOre);
    }, 120000);
  }
});
