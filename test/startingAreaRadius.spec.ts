import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-enemy-base-starting-area.seed123456.json";
import { BUILTIN_NAMES, getBuiltinPreset } from "../src/model/builtins";
import { elevationCtxFromPreset, startingAreaRadiusFor } from "../src/model/elevationPreviewCtx";
import { DEFAULT_STARTING_AREA_RADIUS } from "../src/noise/enemies/enemyCatalog";

/**
 * The game's `starting_area_radius` is `f32(150 * f32(starting_area))`, or 0 for
 * a starting area of 0 (`createContext`, Factorio 2.1.23). The enemy-base field
 * divides by it, so a preset with a starting area other than 1 draws a different
 * enemy field than a default world.
 *
 * Ground truth is `oracle-enemy-base-starting-area.seed123456.json`: the game's
 * own `starting_area_radius` read at 241 positions for six starting areas. The
 * Rust test `the_enemy_field_follows_the_games_starting_area_radius` grades the
 * FIELD built from this radius; this spec grades the radius itself, which is
 * computed on the TypeScript side and sent in the request.
 */
describe("the starting-area radius sent with a Nauvis request", () => {
  it("equals the game's starting_area_radius for every starting area it captured", () => {
    expect(fixture.cases.length).toBe(6);
    for (const c of fixture.cases) {
      const want = c.startingAreaRadius;
      expect(want.length).toBe(241);
      // The game returns the same radius at every position.
      expect(new Set(want).size, `starting_area ${c.startingArea}`).toBe(1);
      expect(startingAreaRadiusFor(c.startingArea), `starting_area ${c.startingArea}`).toBe(
        want[0],
      );
    }
  });

  it("is MISSED by the old constant at every starting area but 1 (the control)", () => {
    const missed = fixture.cases.filter(
      (c) => DEFAULT_STARTING_AREA_RADIUS !== c.startingAreaRadius[0],
    );
    // 0.5, 0.75, 2, 3 and 6 - everything but the arm where 150 was right.
    expect(missed.map((c) => c.startingArea)).toEqual([0.5, 0.75, 2, 3, 6]);
  });

  it("is 0 for a starting area of 0, and -0 does not leak through", () => {
    expect(startingAreaRadiusFor(0)).toBe(0);
    expect(Object.is(startingAreaRadiusFor(-0), 0)).toBe(true);
  });

  it("rounds through f32 twice, as the game does", () => {
    // The slider's "small" notch: f32(0.70710678) is not exactly 1/sqrt(2).
    const small = Math.fround(Math.SQRT1_2);
    expect(startingAreaRadiusFor(small)).toBe(Math.fround(150 * small));
    // 106.066: the value the 2.1.23 review measured for "small".
    expect(startingAreaRadiusFor(small)).toBeCloseTo(106.066, 3);

    // `small` is already an f32, so the lines above pass without the INNER
    // rounding. This input is not: it sits under half an f32 step above 1, so
    // the inner rounding takes it to 1 and the radius to exactly 150. Skip
    // that step and 150 * x lands over half a step above 150, which the outer
    // rounding takes UP to 150 + 2^-16.
    const unrounded = 1 + 2 ** -24 - 2 ** -28;
    expect(Math.fround(unrounded)).toBe(1);
    expect(startingAreaRadiusFor(unrounded)).toBe(150);
    expect(Math.fround(150 * unrounded)).toBe(150 + 2 ** -16);
  });

  it("reaches the ctx from the three built-ins whose starting area is not 1", () => {
    const radii = Object.fromEntries(
      BUILTIN_NAMES.map((name) => [
        name,
        elevationCtxFromPreset(getBuiltinPreset(name)).ctx.startingAreaRadius,
      ]),
    );
    const notDefault = Object.entries(radii).filter(([, r]) => r !== 150);
    // Both Death worlds carry 0.75 and Ribbon world carries 3 in the strings
    // captured from the game's own GUI.
    expect(notDefault.map(([n]) => n).sort()).toEqual(
      BUILTIN_NAMES.filter((n) => /death|ribbon/i.test(n)).sort(),
    );
    for (const [name, r] of notDefault) {
      expect(r, name).toBe(/ribbon/i.test(name) ? 450 : 112.5);
    }
    expect(notDefault.length).toBe(3);
  });
});
