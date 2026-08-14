import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-fulgora-scrap-entities.seed123456.json";
import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import {
  SCRAP_COLLISION_BOX,
  makeFulgoraScrapPlacement,
} from "../src/noise/resources/fulgoraResourceCatalog";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";

interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  resources: { x: number; y: number; name: string }[];
  protos: Record<
    string,
    { box: { lx: number; ly: number; rx: number; ry: number }; map_grid?: boolean }
  >;
}

const cases = entities.cases as unknown as Case[];
const stack = makeFulgoraStack({ seed0: entities.seed0 });

/**
 * The game places ZERO scrap in this 32x32 chunk - world tiles x in [0, 32),
 * y in [128, 160) - for a reason that sits OUTSIDE the probability expression
 * ported in `src/noise/expressions/fulgoraScrap.ts`.
 *
 * This is not a gap in the port. Confirmed by two independent headless
 * captures with different region bounds (this fixture's region 0,0-256,256,
 * and a separate capture with different bounds), both finding 0 entities
 * here, plus a 60-position oracle comparison of the game's own evaluation of
 * `fulgora_scrap_probability` against this port at the 50 highest-probability
 * positions in the chunk: zero difference at double precision, both sides
 * reading the capped 0.5, every sub-term agreeing. A control chunk elsewhere
 * shows the normal healthy pattern (roll count tracking expectation). So the
 * probability expression is right and something else - unidentified,
 * unported, explicitly out of scope for this task - zeroes real placement
 * here. The chunk sits roughly 128-160 tiles from the Fulgora spawn point, in
 * what capture notes call starting-vault territory, which is a plausible
 * *site* for a spawn-safety exclusion but is not itself evidence of a
 * mechanism; nobody has identified the actual code path.
 *
 * Do NOT read this constant as a fudge to make a ratio test pass. It exists
 * so the one chunk with a known, unexplained divergence is named once, is
 * excluded consistently everywhere that divergence would otherwise bias a
 * density measurement, and is separately PINNED by
 * "the suppressed chunk stays suppressed" below - so if someone later ports
 * the real mechanism, that test fails and says so.
 */
const SUPPRESSED_CHUNK = { x0: 0, y0: 128, x1: 32, y1: 160 };

function inSuppressedChunk(x: number, y: number): boolean {
  return (
    x >= SUPPRESSED_CHUNK.x0 &&
    x < SUPPRESSED_CHUNK.x1 &&
    y >= SUPPRESSED_CHUNK.y0 &&
    y < SUPPRESSED_CHUNK.y1
  );
}

describe("Fulgora scrap placement density", () => {
  /**
   * The model's expectation against the game's real entity counts. NOT against
   * the map preview: `map_grid` defaults to true, so the preview draws solid
   * ores in a 2x2-block checkerboard and shows about 0.5 pixels per entity.
   *
   * Tiles inside {@link SUPPRESSED_CHUNK} are skipped on BOTH sides of the
   * ratio (neither summed into `expected` nor counted into `actual`) - see
   * that constant's comment. Measured over the remainder: expected 566.0
   * against actual 562, ratio 1.0071.
   *
   * Asserted as a BAND, not a point. `PLACEMENT_SALT.fulgoraScrap` is arbitrary,
   * so the exact count is one draw; one Poisson sigma at n = 770 is 3.6%.
   */
  it("the expectation lands within 10% of the game's entity count overall", () => {
    const scrap = makeFulgoraScrap(stack);
    let expected = 0;
    let actual = 0;
    for (const c of cases) {
      actual += c.resources.filter((r) => !inSuppressedChunk(r.x, r.y)).length;
      for (let y = c.region.y0; y < c.region.y1; y++)
        for (let x = c.region.x0; x < c.region.x1; x++) {
          if (inSuppressedChunk(x, y)) continue;
          expected += scrap.probability(x, y);
        }
    }
    expect(actual).toBeGreaterThan(400);
    expect(expected / actual).toBeGreaterThan(0.9);
    expect(expected / actual).toBeLessThan(1.1);
  });

  /**
   * Same exclusion, per region rather than pooled: region 0,0's rolled count
   * would otherwise come in about 1.6x the game's, entirely from the one
   * suppressed chunk sitting inside it (140.2 expected, 0 placed there). The
   * other two regions never touch the chunk, so they are unaffected by the
   * filter.
   */
  it("the rolled placement count lands within 20% of the game's, per region", () => {
    const placed = makeFulgoraScrapPlacement(stack);
    for (const c of cases) {
      let n = 0;
      for (let y = c.region.y0; y < c.region.y1; y++)
        for (let x = c.region.x0; x < c.region.x1; x++) {
          if (inSuppressedChunk(x, y)) continue;
          if (placed(x, y)) n++;
        }
      const want = c.resources.filter((r) => !inSuppressedChunk(r.x, r.y)).length;
      const ratio = n / want;
      expect(ratio, `region ${String(c.region.x0)},${String(c.region.y0)}`).toBeGreaterThan(0.8);
      expect(ratio, `region ${String(c.region.x0)},${String(c.region.y0)}`).toBeLessThan(1.2);
    }
  });

  /**
   * The finding as a REGRESSION TEST, not just a comment. The model's own
   * expectation inside {@link SUPPRESSED_CHUNK} is large - real placement
   * mass, not a region the expression already reads as empty - while the
   * fixture (a real `find_entities_filtered{type='resource'}` capture) shows
   * exactly 0 there. Measured: expectation 140.2, actual 0.
   *
   * If a future change ports whatever mechanism causes this and the game
   * starts placing scrap in this chunk again, THIS TEST is the one that will
   * fail - at which point `SUPPRESSED_CHUNK` and the two tests above that
   * skip it need to be updated (or removed) to match the newly-ported rule.
   */
  it("the suppressed chunk stays suppressed: large expectation, zero real placement", () => {
    const scrap = makeFulgoraScrap(stack);
    let expected = 0;
    for (let y = SUPPRESSED_CHUNK.y0; y < SUPPRESSED_CHUNK.y1; y++)
      for (let x = SUPPRESSED_CHUNK.x0; x < SUPPRESSED_CHUNK.x1; x++)
        expected += scrap.probability(x, y);
    expect(expected).toBeGreaterThan(100);

    const region0 = cases[0];
    const actualInChunk = region0.resources.filter((r) => inSuppressedChunk(r.x, r.y)).length;
    expect(actualInChunk).toBe(0);
  });

  /**
   * The collision box is passed and cannot reject anything. Asserting that is
   * better than omitting the box and leaving a reader to wonder whether it was
   * forgotten. The game snaps 0.1 to the 1/256 grid, hence 0.09765625.
   */
  it("the collision box is the game's, and is too small to reject", () => {
    const box = cases[0].protos["scrap"].box;
    expect(box.rx).toBe(0.09765625);
    expect(SCRAP_COLLISION_BOX.w).toBeCloseTo(box.rx - box.lx, 10);
    expect(SCRAP_COLLISION_BOX.w).toBeLessThan(1);
  });

  it("scrap keeps the map_grid default, which is why the preview cannot gate this", () => {
    expect(cases[0].protos["scrap"].map_grid).toBe(true);
  });
});
