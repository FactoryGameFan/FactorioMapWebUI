import { describe, expect, it } from "vite-plus/test";

import chain from "./fixtures/oracle-bearing-chain.seeds606.json";
import { seedNormalized, seedSmall } from "../src/noise/expressions/vulcanusSeed";
import { vulcanusBearingTrig } from "../src/noise/wasm/request";

/**
 * The seed-derived bearing chain against the game itself (#531).
 *
 * `oracle-bearing-chain.seeds606.json` holds the game's own f32 values on 606
 * map seeds: `map_seed_normalized`, the Vulcanus direction and bearing angles,
 * and the sine and cosine of two of them. Every comparison here is exact. The
 * old formulas are asserted to FAIL on the same rows, so each fix is held up by
 * a control that could have failed while the claim stood.
 */

const f32 = Math.fround;
const rows = chain.rows;

function count(match: (r: (typeof rows)[number]) => boolean): number {
  let n = 0;
  for (const r of rows) if (match(r)) n++;
  return n;
}

describe("the bearing-chain fixture", () => {
  it("has 606 rows, one per probed seed", () => {
    expect(rows.length).toBe(606);
    expect(new Set(rows.map((r) => r.seed)).size).toBe(606);
  });
});

describe("map_seed_normalized is f32(seed / (2^32 - 1))", () => {
  it("matches the game on all 606 seeds", () => {
    expect(count((r) => seedNormalized(r.seed) === r.msn)).toBe(606);
  });

  it("CONTROL: the old divisor, 2^32, matches only 601", () => {
    // The five seeds that differ include 3,526,822,528 (game 0.82115239, old
    // 0.82115233) and 16,777,217. The twelve seeds in oracle-seed-vars.multi.json
    // could not tell the two divisors apart.
    expect(count((r) => f32(r.seed / 4294967296) === r.msn)).toBe(601);
  });
});

describe("the Vulcanus angle chain", () => {
  it("direction, ashlands, mountains and basalts match the game on all 606", () => {
    for (const r of rows) {
      const direction = -1 + 2 * (seedSmall(r.seed) & 1);
      const ashlands = f32(seedNormalized(r.seed) * 3600);
      expect(direction, `dir seed=${r.seed}`).toBe(r.dir);
      expect(ashlands, `ash seed=${r.seed}`).toBe(r.ash);
      expect(f32(ashlands + f32(120 * direction)), `mtn seed=${r.seed}`).toBe(r.mtn);
      expect(f32(ashlands + f32(240 * direction)), `bas seed=${r.seed}`).toBe(r.bas);
    }
  });

  it("the basalts sine and cosine match the game on all 606 (index 2 of the ten bearings)", () => {
    for (const r of rows) {
      const basalts = vulcanusBearingTrig(r.seed)[2]!;
      expect(basalts.sin, `bas_sin seed=${r.seed}`).toBe(r.bas_sin);
      expect(basalts.cos, `bas_cos seed=${r.seed}`).toBe(r.bas_cos);
    }
  });
});
