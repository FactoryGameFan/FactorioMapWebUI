import { describe, expect, it } from "vite-plus/test";
import {
  PLACEMENT_SALT,
  makePlacementRoll,
  placementRollWord,
} from "../src/noise/placement/placementRoll";
import { seededState, taus88Next } from "../src/noise/taus88";

describe("placementRollWord", () => {
  // docs/noise/placement-roll-NOTES.md: generateEntities +52..+104 seeds
  // word = max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY), u32, no map_seed.
  it("reproduces the reverse-engineered chunk seed word at salt 0", () => {
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [37, -94],
    ] as const) {
      const expected = Math.max(341, (0x3fbe2c + Math.imul(7919, cx) + Math.imul(7907, cy)) >>> 0);
      expect(placementRollWord(cx, cy, 0)).toBe(expected);
    }
  });

  it("clamps to 341 rather than returning a tiny word", () => {
    // Choose a salt that drives the sum to 5 before the clamp.
    const salt = (5 - 0x3fbe2c) >>> 0;
    expect(placementRollWord(0, 0, salt)).toBe(341);
  });

  it("gives different words for different salts", () => {
    expect(placementRollWord(3, 4, PLACEMENT_SALT.nauvisRocks)).not.toBe(
      placementRollWord(3, 4, PLACEMENT_SALT.vulcanusRocks),
    );
  });
});

describe("makePlacementRoll", () => {
  it("assigns draws in DECREASING tile index - the first draw is the last tile", () => {
    const roll = makePlacementRoll(0);
    const st = seededState(placementRollWord(0, 0, 0));
    const first = taus88Next(st) / 4294967296;
    // tile index 1023 = (y & 31) * 32 + (x & 31) with x = 31, y = 31
    expect(roll(31, 31)).toBe(first);
  });

  it("returns U in [0, 1)", () => {
    const roll = makePlacementRoll(PLACEMENT_SALT.enemyBases);
    for (let y = -40; y < 40; y += 7) {
      for (let x = -40; x < 40; x += 7) {
        const u = roll(x, y);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
    }
  });

  it("is a pure function of world position - independent of visit order", () => {
    const a = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const b = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const pts: [number, number][] = [
      [0, 0],
      [1000, -1000],
      [-33, 64],
      [31, 31],
      [-1, -1],
    ];
    const forward = pts.map(([x, y]) => a(x, y));
    const backward = [...pts].reverse().map(([x, y]) => b(x, y));
    expect(backward.reverse()).toEqual(forward);
  });

  it("handles negative world coordinates without collapsing chunks", () => {
    const roll = makePlacementRoll(0);
    // (-1, -1) is tile index 1023 of chunk (-1, -1); (31, 31) is tile 1023 of chunk (0, 0).
    expect(roll(-1, -1)).not.toBe(roll(31, 31));
  });

  it("decorrelates salts: two overlays' placements intersect at ~the product of their rates", () => {
    const a = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const b = makePlacementRoll(PLACEMENT_SALT.enemyBases);
    const p = 0.2;
    let na = 0;
    let nb = 0;
    let both = 0;
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const ha = a(x, y) < p;
        const hb = b(x, y) < p;
        if (ha) na++;
        if (hb) nb++;
        if (ha && hb) both++;
      }
    }
    const n = 200 * 200;
    // Independent => both/n ~= (na/n)*(nb/n) ~= 0.04. Correlated (shared stream)
    // would give both ~= min(na, nb) ~= 0.2*n. 0.06 is comfortably between.
    expect(both / n).toBeLessThan(0.06);
    expect(both / n).toBeGreaterThan(0.02);
  });
});
