import { describe, expect, it } from "vite-plus/test";

import type { CliffFields } from "../src/noise/cliffs/cliffPlacement";
import { makeCliffPlacementFromFields, smoothingKnots } from "../src/noise/cliffs/cliffPlacement";

/**
 * `cliff_smoothing`, tested as a rule rather than through its effect on a
 * fixture. `test/vulcanusCliffEntities.spec.ts` is what proves the rule is the
 * RIGHT one (it moved Vulcanus from 1.5x over-placement to within 8-19% of the
 * game's own cliff count); these tests pin the shape of it, so a later
 * refactor cannot quietly change the knot lattice and still pass by luck.
 *
 * The rule is read from `CliffGenerator::crossingsForChunk` (`0x10160cdec`),
 * which blends each corner's cliff elevation toward a bilinear interpolation of
 * the surrounding knots before any crossing test runs.
 */
describe("cliff_smoothing knot lattice", () => {
  // Knots at in-chunk corner indices 0, 4 and 7. The second span is 3 wide, not
  // 4, because the engine clamps `hi` to CHUNK_CORNERS - 1 (= 7) rather than to
  // the block edge (8). That asymmetry is the whole reason smoothing is
  // "inaccurate" - it is not a transcription slip.
  const cases: [number, number, number, number][] = [
    // index, lo, hi, t
    [0, 0, 4, 0],
    [1, 0, 4, 0.25],
    [2, 0, 4, 0.5],
    [3, 0, 4, 0.75],
    [4, 4, 7, 0],
    [5, 4, 7, 1 / 3],
    [6, 4, 7, 2 / 3],
    [7, 4, 7, 1],
    // Index 8 is the next chunk's index 0: the lattice is chunk-anchored, so it
    // restarts rather than continuing the previous chunk's spans.
    [8, 8, 12, 0],
    [13, 12, 15, 1 / 3],
    // Negative world coordinates must land on the same lattice, not a mirrored
    // one - a plain `%` in JS would give -1 % 8 === -1 and shift every chunk
    // left of the origin.
    [-1, -4, -1, 1],
    [-8, -8, -4, 0],
    [-5, -8, -4, 0.75],
  ];

  for (const [index, lo, hi, t] of cases) {
    it(`corner ${String(index)} interpolates ${String(lo)}..${String(hi)} at t=${t.toFixed(3)}`, () => {
      const k = smoothingKnots(index);
      expect(k.lo).toBe(lo);
      expect(k.hi).toBe(hi);
      expect(k.t).toBeCloseTo(t, 12);
    });
  }

  it("leaves knot corners exactly where they are", () => {
    // Every knot must be a fixed point (t === 0 on itself, or t === 1 on
    // itself), or smoothing would drift the whole field rather than only
    // straightening between knots.
    for (let i = -16; i < 16; i++) {
      const inChunk = ((i % 8) + 8) % 8;
      if (inChunk !== 0 && inChunk !== 4 && inChunk !== 7) continue;
      const k = smoothingKnots(i);
      expect(k.t === 0 ? k.lo : k.hi).toBe(i);
      expect(k.t === 0 || k.t === 1).toBe(true);
    }
  });
});

/** A cliffiness that always passes the `> 0.5` gate, so only elevation matters. */
const alwaysCliffy = (): number => 1;

function cellKey(p: { x: number; y: number }): string {
  return `${String(p.x)},${String(p.y)}`;
}

function placedKeys(fields: CliffFields, smoothing: number): string[] {
  return makeCliffPlacementFromFields(fields, { elevation0: 10, interval: 40, smoothing })
    .placedCells(-128, -128, 128, 128)
    .map(cellKey)
    .sort();
}

describe("cliff_smoothing behaviour", () => {
  const ramp: CliffFields = {
    // A plane. Bilinear interpolation of a plane is the plane itself, whatever
    // the knot spacing - so this is a sharp test that the four weights sum to 1
    // and that lo/hi bracket the corner rather than merely being near it.
    cliffElevation: (x, y) => 0.7 * x + 0.3 * y + 100,
    cliffiness: alwaysCliffy,
  };

  it("is the identity when smoothing is 0", () => {
    const spiky: CliffFields = {
      cliffElevation: (x, y) => 100 + 60 * Math.sin(x / 7) + 40 * Math.cos(y / 5),
      cliffiness: alwaysCliffy,
    };
    expect(placedKeys(spiky, 0)).toEqual(placedKeys(spiky, 1e-300));
    // ...and an omitted `smoothing` must mean 0, not the prototype default of 1.
    // Nauvis relies on this: it sets cliff_smoothing = 0 explicitly and scores a
    // 1.000 count ratio, so a default of 1 here would silently break the planet
    // that currently works.
    const omitted = makeCliffPlacementFromFields(spiky, { elevation0: 10, interval: 40 })
      .placedCells(-128, -128, 128, 128)
      .map(cellKey)
      .sort();
    expect(omitted).toEqual(placedKeys(spiky, 0));
  });

  it("does not move a planar elevation field at full smoothing", () => {
    expect(placedKeys(ramp, 1)).toEqual(placedKeys(ramp, 0));
    expect(placedKeys(ramp, 1).length).toBeGreaterThan(0);
  });

  it("erases detail between knots at full smoothing", () => {
    // The same plane plus a high-frequency wobble that no knot pair can
    // represent. Full smoothing must discard the wobble and reproduce the plane
    // exactly, because the wobble is zero at every knot.
    const wobbly: CliffFields = {
      cliffElevation: (x, y) => ramp.cliffElevation(x, y) + (Math.round(x / 4) % 8 === 2 ? 25 : 0),
      cliffiness: alwaysCliffy,
    };
    expect(placedKeys(wobbly, 0)).not.toEqual(placedKeys(ramp, 0));
    expect(placedKeys(wobbly, 1)).toEqual(placedKeys(ramp, 1));
  });
});
