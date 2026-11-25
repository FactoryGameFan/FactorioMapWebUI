import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-seed-vars.multi.json";
import { seedNormalized, seedSmall } from "../src/noise/expressions/vulcanusSeed";

describe("seedNormalized reproduces the game's map_seed_normalized", () => {
  it("matches every fixture row exactly (f32 relation, tolerance 0)", () => {
    for (const row of fixture.seeds) {
      expect(seedNormalized(row.seed0), `seed0=${row.seed0}`).toBe(row.mapSeedNormalized);
    }
  });

  it("is Math.fround(seed0 / (2^32 - 1)), and a seed that can tell the divisors apart agrees with the game", () => {
    // The old test used seed0 = 0xFFFFFFFF, where 2^32 and 2^32 - 1 both give
    // exactly 1, so it could not fail (#531). 3,526,822,528 is a seed the game
    // was read on (test/bearingChain.spec.ts has all 606): the game says
    // 0.82115238904953, and dividing by 2^32 gives 0.8211523294448853.
    expect(seedNormalized(3526822528)).toBe(0.82115238904953);
    expect(Math.fround(3526822528 / 2 ** 32)).not.toBe(0.82115238904953);
    // The closed top of the range.
    expect(seedNormalized(0xffffffff)).toBe(1);
  });
});

describe("seedSmall reproduces the game's map_seed_small", () => {
  it("matches every fixture row exactly (integer op, tolerance 0)", () => {
    for (const row of fixture.seeds) {
      expect(seedSmall(row.seed0), `seed0=${row.seed0}`).toBe(row.mapSeedSmall);
    }
  });

  it("only the parity matters downstream (vulcanus_starting_direction = -1 + 2*(seedSmall & 1))", () => {
    for (const row of fixture.seeds) {
      expect(seedSmall(row.seed0) & 1).toBe(row.mapSeedSmall & 1);
    }
  });

  it("is the 16 least significant bits (0 <= seedSmall < 65536)", () => {
    for (const row of fixture.seeds) {
      const v = seedSmall(row.seed0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(65536);
    }
  });
});
