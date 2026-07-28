import { describe, expect, it } from "vite-plus/test";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";

/**
 * The Vulcanus composite renders through ONE shared, cached field stack
 * (`makeVulcanusStack(..., { cacheShared: true })`) instead of each overlay
 * building its own. That must be a pure performance change: the shared path has
 * to produce the SAME BYTES as per-renderer stacks, which is what
 * `unsharedStacks: true` renders for comparison.
 *
 * Two things could break it, and both are silent:
 *
 * - **A stale or aliased cache value.** `memoRegion` keys on the integer tile,
 *   and bypasses rather than aliases for non-integer or out-of-range
 *   coordinates - the cliff lattice samples at y + 0.5, and rounding those onto
 *   integer keys would return a different point's value.
 * - **A lost `this` binding.** The cached fields are wrapped in arrows, not
 *   passed as method references, so they keep their receiver whatever the
 *   underlying implementation does.
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

describe("Vulcanus shared cached stack is byte-identical to per-renderer stacks", () => {
  for (const view of ["resources", "rocks", "all"] as const) {
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
        const unshared = new Uint8Array(runRenderRequest({ ...base, unsharedStacks: true }).buffer);
        const shared = new Uint8Array(runRenderRequest({ ...base }).buffer);

        expect(shared.length).toBe(unshared.length);
        let firstDiff = -1;
        let diffs = 0;
        for (let i = 0; i < unshared.length; i++)
          if (unshared[i] !== shared[i]) {
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
