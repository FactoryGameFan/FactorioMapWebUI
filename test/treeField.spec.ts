import { describe, expect, it } from "vite-plus/test";
import { asymmetricRamps } from "../src/noise/trees/asymmetricRamps";
import { f32 } from "../src/noise/eval/f32";
import { makeMoisture } from "../src/noise/expressions/moisture";
import { makeMultioctaveNoise } from "../src/noise/multioctaveNoise";
import { makeTemperature } from "../src/noise/expressions/temperature";
import { makeTreeShared } from "../src/noise/trees/treeShared";
import { makeTreeDensity, makeTreeSpeciesFields } from "../src/noise/trees/treeField";
import { TREE_SPECIES } from "../src/noise/trees/treeCatalog";

const GRID: Array<[number, number]> = [
  [0.5, 0.25],
  [220.5, -180.25],
  [-1600.5, 1200.25],
  [900.5, 900.25],
  [12345.75, 6789.125],
];

describe("makeTreeSpeciesFields", () => {
  it("builds one field per catalog species, in catalog order", () => {
    const fields = makeTreeSpeciesFields({ seed0: 123456 });
    expect(fields.map((f) => f.species.name)).toEqual(TREE_SPECIES.map((s) => s.name));
  });

  it("reproduces the trees.lua expression term for term", () => {
    // An independent re-implementation of tree_01, built straight from the Lua,
    // so a refactor of treeField cannot quietly change the formula.
    const seed0 = 123456;
    const temperature = makeTemperature({ seed0 });
    const moisture = makeMoisture({ seed0 });
    const { smallNoise, forestPathCutoutFaded } = makeTreeShared({ seed0 });
    const row = TREE_SPECIES.find((s) => s.name === "tree_01")!;
    const noise = makeMultioctaveNoise({
      seed0,
      seed1: row.seed1,
      octaves: 3,
      persistence: 0.65,
      inputScale: 1 / row.inputScaleDiv,
      outputScale: row.outputScale,
    });

    const expected = (x: number, y: number): number => {
      // `distance_from_nearest_point` against the origin spawn, in the f32 the
      // game's op computes and stores. Written out rather than calling the op,
      // so this stays an independent re-implementation - but with the same
      // arithmetic, because `Math.hypot` in f64 is a different number
      // (see src/noise/distanceFromNearestPoint.ts, corrected 2026-08-18).
      const distance = f32(Math.sqrt(f32(f32(f32(x) * f32(x)) + f32(f32(y) * f32(y)))));
      const climate = Math.min(
        0,
        asymmetricRamps(temperature(x, y), ...row.tempRamp),
        asymmetricRamps(moisture(x, y), ...row.moistRamp),
      );
      const sum =
        climate +
        Math.min(0, distance / 20 - 3) -
        0.5 +
        0.2 * 1 +
        smallNoise(x, y) * 0.1 +
        noise(x, y);
      return Math.min(row.cap, forestPathCutoutFaded(x, y), sum);
    };

    const actual = makeTreeSpeciesFields({ seed0 }).find((f) => f.species.name === "tree_01")!;
    for (const [x, y] of GRID) expect(actual.evalAt(x, y)).toBeCloseTo(expected(x, y), 12);
  });

  it("scales the species input_scale by control:trees:frequency", () => {
    const base = makeTreeSpeciesFields({ seed0: 123456 })[0];
    const fast = makeTreeSpeciesFields({ seed0: 123456, treesFrequency: 3 })[0];
    const differs = GRID.some(([x, y]) => base.evalAt(x, y) !== fast.evalAt(x, y));
    expect(differs).toBe(true);
  });

  it("shifts every species by 0.2 per unit of control:trees:size, until capped", () => {
    const base = makeTreeSpeciesFields({ seed0: 123456 });
    const big = makeTreeSpeciesFields({ seed0: 123456, treesSize: 2 });
    for (let i = 0; i < base.length; i++) {
      const cap = base[i].species.cap;
      for (const [x, y] of GRID) {
        // The +0.2 lands inside the shared sum, so it shifts the result unless the
        // cap or the cutout is the binding term.
        expect(big[i].evalAt(x, y)).toBeLessThanOrEqual(cap + 1e-12);
        expect(big[i].evalAt(x, y)).toBeGreaterThanOrEqual(base[i].evalAt(x, y) - 1e-12);
      }
    }
    // Verify that the treesSize parameter is actually live by proving big differs from base somewhere.
    const differs = base.some((_, i) =>
      GRID.some(([x, y]) => big[i].evalAt(x, y) !== base[i].evalAt(x, y)),
    );
    expect(differs).toBe(true);
  });

  // Trees are the ONLY consumer of `temperature` (tile selection is aux +
  // moisture), so if these levers are not threaded through, an imported exchange
  // string carrying a temperature override renders the wrong forests silently.
  // There is no UI for them, so this test is the only thing holding the wiring.
  it("threads control:temperature:frequency through to the species climate ramp", () => {
    const base = makeTreeDensity({ seed0: 123456 });
    const warped = makeTreeDensity({ seed0: 123456, temperatureFrequency: 4 });
    expect(GRID.some(([x, y]) => base(x, y) !== warped(x, y))).toBe(true);
  });

  it("threads control:temperature:bias through to the species climate ramp", () => {
    const base = makeTreeDensity({ seed0: 123456 });
    // Large enough to push temperature out of every species' tempRamp window,
    // which drives the climate term - and so the density - to 0 everywhere.
    const frozen = makeTreeDensity({ seed0: 123456, temperatureBias: -1000 });
    expect(GRID.some(([x, y]) => base(x, y) > 0)).toBe(true);
    expect(GRID.every(([x, y]) => frozen(x, y) === 0)).toBe(true);
  });
});

describe("makeTreeDensity", () => {
  it("is the clamped max over every species", () => {
    const fields = makeTreeSpeciesFields({ seed0: 123456 });
    const density = makeTreeDensity({ seed0: 123456 });
    for (const [x, y] of GRID) {
      const expected = Math.min(1, Math.max(0, ...fields.map((f) => f.evalAt(x, y))));
      expect(density(x, y)).toBeCloseTo(expected, 12);
    }
  });

  it("never leaves [0, 1]", () => {
    const density = makeTreeDensity({ seed0: 123456 });
    for (let x = -2000; x <= 2000; x += 137) {
      for (let y = -2000; y <= 2000; y += 149) {
        const d = density(x + 0.5, y + 0.25);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
  });

  it("stays a probability far from spawn, never saturating to a mask", () => {
    // min(0, distance/20 - 3) saturates at 0 past distance 60, so distance does
    // NOT suppress far-field trees - but the caps are all <= 0.45, so density can
    // never reach 1. This pins that the field stays a probability, not a mask.
    const density = makeTreeDensity({ seed0: 123456 });
    let maxSeen = 0;
    for (let x = -3000; x <= 3000; x += 211) {
      for (let y = -3000; y <= 3000; y += 223) {
        maxSeen = Math.max(maxSeen, density(x + 0.5, y + 0.25));
      }
    }
    expect(maxSeen).toBeGreaterThan(0);
    expect(maxSeen).toBeLessThanOrEqual(0.45);
  });
});
