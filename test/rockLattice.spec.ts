import { describe, expect, it } from "vite-plus/test";

import { ROCK_FIELD_LATTICE, latticeSnapped } from "../src/noise/rocks/rockCatalog";

/**
 * Coarse rock field sampling: evaluate the probability field on a lattice while
 * still rolling every tile, so the approximation degrades *where* rocks land and
 * never *how many*.
 *
 * **It ships disabled (`ROCK_FIELD_LATTICE = 1`), and that is a measured
 * decision, not an unfinished one.** The mechanism is kept and tested so a future
 * perf attempt is a one-constant experiment; the numbers below are why the
 * constant is 1 today. Full write-up in `docs/noise/placement-roll-NOTES.md`.
 */
describe("rock field lattice", () => {
  it("is a true no-op at stride 1 - the shipped path pays nothing", () => {
    const f = (x: number, y: number): number => x * 1000 + y;
    // Identity, not merely equivalent: at stride <= 1 the field is returned
    // itself, so the shipped configuration adds no call and no arithmetic.
    expect(latticeSnapped(f, 1)).toBe(f);
    expect(latticeSnapped(f, 0)).toBe(f);
  });

  it("snaps with floor, so the lattice is uniform across the origin", () => {
    const f = (x: number, y: number): number => x * 1000 + y;
    const g = latticeSnapped(f, 4);
    expect(g(0, 0)).toBe(f(0, 0));
    expect(g(3, 3)).toBe(f(0, 0));
    expect(g(4, 4)).toBe(f(4, 4));
    // The case truncation would get wrong: -1 belongs to the cell at -4, not 0.
    // Truncation would make the cell straddling each axis half-width, and the
    // placed density would stop being translation-invariant.
    expect(g(-1, -1)).toBe(f(-4, -4));
    expect(g(-4, -4)).toBe(f(-4, -4));
    expect(g(-5, -5)).toBe(f(-8, -8));
  });

  /**
   * The property that makes the whole idea safe: the lattice must not move the
   * placed COUNT, because that is what `test/entityDensity.spec.ts` validates
   * against the game. Measured over [-256, 256)^2 with the ungated roll (the
   * gates are orthogonal to field sampling):
   *
   * | planet | L=1 | L=2 | L=4 | clumping L=1 / L=2 / L=4 |
   * | --- | --- | --- | --- | --- |
   * | vulcanus | 2448 | 2426 (-0.90%) | 2419 (-1.18%) | 0.349 / 0.372 / 0.390 |
   * | nauvis | 313 | 310 (-0.96%) | 316 (+0.96%) | 0.259 / 0.229 / 0.199 |
   *
   * Density holds to ~1% at both strides. **Clumping is the cost**, and only
   * Vulcanus shows it cleanly: +6.7% at L=2 and +11.8% at L=4, which is the
   * smearing the brief predicted from `vulcanus_decorative_knockout` running at
   * `input_scale = 1/3` (~5-tile wavelength). Nauvis's clumping moves the other
   * way, but with only ~313 placements in the window that proxy is noise, not a
   * counter-example.
   */

  it("ships disabled, because the saving cannot pay for the clumping", () => {
    // Guards the CONSTANT, so enabling the lattice is a deliberate act that has
    // to come with a re-measurement. The perf case for enabling it does not hold
    // today: min-of-7 interleaved renders at 512x512 measure the rock overlay's
    // marginal cost at 1412 ms of an 8261 ms Vulcanus `all`, and stride 4 cuts
    // that to 877 ms - 7.9% off the whole render. Even a FREE rock overlay would
    // leave `all` at ~2.09x terrain, so the plan's "under 2x" gate is not
    // reachable by sampling this field at all: the cost is in cliffs and
    // resources, which are 42% and 40% of the overlay budget against rocks' 27%.
    expect(ROCK_FIELD_LATTICE).toBe(1);
  });
});
