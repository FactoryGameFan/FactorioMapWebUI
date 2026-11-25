import { describe, expect, it } from "vite-plus/test";

import chain from "./fixtures/oracle-bearing-chain.seeds606.json";
import { gameSin } from "../src/noise/gameTrig";
import { seedNormalized, seedSmall } from "../src/noise/expressions/vulcanusSeed";
import { bearingTrig, vulcanusBearingTrig } from "../src/noise/wasm/request";

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

describe("Fulgora's start bearing is f32(f32(seed) / 360)", () => {
  it("the angle and its sine match the game on all 606", () => {
    for (const r of rows) {
      expect(f32(f32(r.seed) / 360), `fg_deg seed=${r.seed}`).toBe(r.fg_deg);
      expect(bearingTrig(r.seed).sinStart, `fg_sin seed=${r.seed}`).toBe(r.fg_sin);
    }
  });

  it("CONTROL: the old f32(seed / 360) matches the angle on only 463", () => {
    // 463 of 606 (measured 2026-11-25). The seeds below 2^24 are exact in f32 and
    // agree either way; above it the seed rounds before the division.
    expect(count((r) => f32(r.seed / 360) === r.fg_deg)).toBe(463);
  });

  it("CONTROL: the old angle gives the wrong sine on some seeds", () => {
    const oldSine = (seed: number): number => {
      // The old bearingTrig: angle = f32(seed / 360), then the same trig.
      const radians = f32(f32(f32(seed / 360) / 180) * f32(Math.PI));
      return gameSin(radians);
    };
    const wrong = count((r) => oldSine(r.seed) !== r.fg_sin);
    expect(wrong).toBeGreaterThan(0);
  });
});

describe("the Vulcanus protector bearing is f32(mountains + 180 * direction)", () => {
  it("the angle and its sine and cosine match the game on all 606 (index 4 of the ten bearings)", () => {
    for (const r of rows) {
      const direction = -1 + 2 * (seedSmall(r.seed) & 1);
      expect(f32(r.mtn + 180 * direction), `prot_deg seed=${r.seed}`).toBe(r.prot_deg);
      const protector = vulcanusBearingTrig(r.seed)[4]!;
      expect(protector.sin, `prot_sin seed=${r.seed}`).toBe(r.prot_sin);
      expect(protector.cos, `prot_cos seed=${r.seed}`).toBe(r.prot_cos);
    }
  });

  it("CONTROL: the old un-narrowed sum matches the game's angle on only 567", () => {
    expect(count((r) => r.mtn + 180 * (-1 + 2 * (seedSmall(r.seed) & 1)) === r.prot_deg)).toBe(567);
  });

  it("seed 71182336: the game's protector sine is 0x3f5e72d7, not the old 0x3f5e72d3", () => {
    const protector = vulcanusBearingTrig(71182336)[4]!;
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, protector.sin);
    expect(view.getUint32(0).toString(16)).toBe("3f5e72d7");
  });
});
