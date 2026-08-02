import { describe, expect, it } from "vite-plus/test";

import vulcanus from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

/** code = (enc(L)<<6)|(enc(R)<<4)|(enc(T)<<2)|enc(B); enc: 0->0, +1->1, -1->3. */
const edgesOf = (code: number): readonly number[] => [
  (code >> 6) & 3,
  (code >> 4) & 3,
  (code >> 2) & 3,
  code & 3,
];

/**
 * **The SHAPE of the Vulcanus orientation residual** (issue #84).
 *
 * `cliffOrientationOracle.spec.ts` counts the residual and bounds it. This file
 * pins what it looks like, because the shape is the lead and a change in shape
 * is a change in cause even if the count holds.
 *
 * Measured 2026-08-02, after #83 (multisample grid), #86 (lava rejection) and
 * #90 (the raw collision box):
 *
 * - **37 of 1531 matched cells, and all 37 differ in EXACTLY ONE edge.** Not one
 *   two-edge difference survives. Before #83 the dominant failure was two edges
 *   (125 of 175), i.e. a whole corner on the wrong side of a band; that mode is
 *   gone.
 * - **Every one is an OVER-detection.** In all 37 the game reports a `-to-none`
 *   orientation and the port reports a crossing on that edge - never the
 *   reverse. Sample transitions: `south-to-north -> none-to-north` (4x),
 *   `north-to-south -> north-to-none` (4x), `west-to-east -> none-to-east` (3x).
 * - Spread evenly over the four edges (L11 / R6 / T7 / B13) and over regions
 *   (7 / 26 / 4), so it is not a directional off-by-one.
 *
 * **Two candidate causes are already eliminated, which is why this is worth
 * pinning rather than re-deriving:**
 *
 * - `crossesCliff` is EXACT. Disassembled at `0x10160c914` under 2.1.12 (the VA
 *   in `cliffs-NOTES.md` had moved); `cliffPlacement.ts` reproduces it line for
 *   line, including the `a < 0 || b < 0` early-out, the `boundary < e0` check
 *   and the strict `> 0.5` gate and strict crossing comparisons. There is no
 *   `>=`-vs-`>` slip to find.
 * - `cliffiness_basic` is EXONERATED. Substituting the game's own corner
 *   cliffiness leaves the count at exactly 37 / 1531.
 *
 * So the residual is in the **grid-4 cliff-elevation field**, the one input in
 * the chain with no direct per-corner oracle. A single-edge, strictly
 * one-directional over-detection is what a small positive field offset looks
 * like.
 */
describe("the shape of the Vulcanus orientation residual", () => {
  const ctx = withCtxDefaults({ seed0: vulcanus.seed, startingPositions: [{ x: 0, y: 0 }] });
  const fields = makeVulcanusCliffFields(ctx);
  const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
  const codeForOrientation = new Map<number, number>();
  for (let c = 0; c < 256; c++) {
    const id = cliffOrientationForCode(c);
    if (id !== undefined && !codeForOrientation.has(id)) codeForOrientation.set(id, c);
  }

  const wrong: { ourCode: number; gameCode: number; ours: string; game: string }[] = [];
  let matched = 0;
  for (const c of vulcanus.cases) {
    const r = c.region;
    const placed = makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
    }).placedCells(r.x0, r.y0, r.x1, r.y1);
    const ours = new Map(placed.map((p) => [key(p), p.code]));
    for (const p of c.cliffs.filter((q) => q.name === "cliff-vulcanus")) {
      const code = ours.get(key(p));
      if (code === undefined) continue;
      matched++;
      const id = cliffOrientationForCode(code);
      const got = id === undefined ? undefined : CLIFF_ORIENTATION_NAMES[id];
      if (got === p.orientation) continue;
      const gid = nameToId.get(p.orientation);
      const gameCode = gid === undefined ? undefined : codeForOrientation.get(gid);
      expect(gameCode).toBeDefined();
      wrong.push({
        ourCode: code,
        gameCode: gameCode as number,
        ours: String(got),
        game: p.orientation,
      });
    }
  }

  it("compares a substantial set - the shape below is not read off a handful", () => {
    expect(matched).toBeGreaterThan(1500);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.length).toBeLessThanOrEqual(37);
  }, 120000);

  it("differs in exactly ONE edge, every time", () => {
    for (const w of wrong) {
      const a = edgesOf(w.ourCode);
      const b = edgesOf(w.gameCode);
      let differing = 0;
      for (let i = 0; i < 4; i++) if (a[i] !== b[i]) differing++;
      expect(differing).toBe(1);
    }
  }, 120000);

  /**
   * The direction is the actual lead. If this ever fails with under-detections
   * appearing, the cause has changed and the "small positive field offset"
   * reading above is dead.
   */
  it("is always an OVER-detection - the game says none, we say a crossing", () => {
    let over = 0;
    for (const w of wrong) {
      const a = edgesOf(w.ourCode);
      const b = edgesOf(w.gameCode);
      for (let i = 0; i < 4; i++) {
        if (a[i] === b[i]) continue;
        // The game's edge carries no crossing (0) and ours does.
        expect(b[i]).toBe(0);
        expect(a[i]).not.toBe(0);
        over++;
      }
    }
    expect(over).toBe(wrong.length);
  }, 120000);

  it("is not concentrated on one edge, which would be an off-by-one", () => {
    const perEdge = [0, 0, 0, 0];
    for (const w of wrong) {
      const a = edgesOf(w.ourCode);
      const b = edgesOf(w.gameCode);
      for (let i = 0; i < 4; i++) if (a[i] !== b[i]) perEdge[i]++;
    }
    // Measured L11 / R6 / T7 / B13. Every edge participates; no edge dominates.
    for (const n of perEdge) expect(n).toBeGreaterThan(0);
    expect(Math.max(...perEdge)).toBeLessThan(wrong.length * 0.6);
  }, 120000);
});
