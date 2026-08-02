import { describe, expect, it } from "vite-plus/test";

import fx from "./fixtures/oracle-vulcanus-cliff-collapsed.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import {
  makeCliffPlacement,
  makeCliffPlacementFromFields,
} from "../src/noise/cliffs/cliffPlacement";
import {
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly code: number;
}

const tally = (
  cells: readonly Cell[],
  game: Map<string, string>,
): { game: number; ours: number; matched: number; wrong: number } => {
  let matched = 0;
  let wrong = 0;
  for (const p of cells) {
    const want = game.get(key(p));
    if (want === undefined) continue;
    matched++;
    if (CLIFF_ORIENTATION_NAMES[cliffOrientationForCode(p.code) as number] !== want) wrong++;
  }
  return { game: game.size, ours: cells.length, matched, wrong };
};

const vulcanusArm = (index: number) => {
  const c = fx.cases[index];
  const eff = c.effective;
  const ctx = withCtxDefaults({ seed0: fx.seed, startingPositions: [{ x: 0, y: 0 }] });
  const base = makeVulcanusCliffFields(ctx);
  const game = new Map<string, string>();
  for (const p of c.cliffs.filter((q) => q.name === "cliff-vulcanus"))
    game.set(key(p), p.orientation);
  const cells = makeCliffPlacementFromFields(
    {
      cliffElevation: base.cliffElevation,
      cliffiness: makeCliffinessBasic(fx.seed, eff?.richness ?? 1),
    },
    {
      elevation0: eff?.cliff_elevation_0 ?? 70,
      interval: eff?.cliff_elevation_interval ?? 120,
      smoothing: eff?.cliff_smoothing ?? 0,
    },
  ).placedCells(fx.region.x0, fx.region.y0, fx.region.x1, fx.region.y1);
  return tally(cells, game);
};

const nauvisArm = (index: number) => {
  const c = fx.nauvisCases[index];
  const eff = c.effective;
  const nr = fx.nauvisRegion;
  const game = new Map<string, string>();
  for (const p of c.cliffs) game.set(key(p), p.orientation);
  const cells = makeCliffPlacement({
    seed0: fx.seed,
    controls: { frequency: 1, continuity: 1 },
    settings: {
      cliffElevation0: eff?.cliff_elevation_0 ?? 10,
      cliffElevationInterval: eff?.cliff_elevation_interval ?? 40,
      richness: eff?.richness ?? 1,
    },
  }).placedCells(nr.x0, nr.y0, nr.x1, nr.y1);
  return tally(cells, game);
};

/**
 * **The cliff rule collapsed a term at a time, which localises #18 to the
 * ELEVATION FIELD rather than the placement.**
 *
 * `cliff_settings` holds every constant the rule uses and all of them are
 * settable on the surface, so a term can be switched off in the GAME instead of
 * modelled. Setting `cliff_smoothing = 0` leaves the raw elevation;
 * `cliff_elevation_interval = 1e6` leaves a single contour at
 * `cliff_elevation_0` with no band arithmetic; `richness = 4` makes
 * `cliffiness_basic`'s `0.5*log2(4) = 1` so it saturates at 1.5 and its `> 0.5`
 * gate is open essentially everywhere. Together the rule reduces to
 * **"an edge crosses iff elevation crosses 70"** - the game's cliffs become a
 * direct readout of `sign(elevation - 70)` at the generator's own sample points.
 *
 * Vulcanus is wrong in every arm, and *most* wrong in the simplest one:
 *
 * | arm | game | ours | matched | wrong |
 * | --- | --- | --- | --- | --- |
 * | smoothing off only | 352 | 432 | 289 | 83 = 28.7% |
 * | + single contour | 271 | 349 | 208 | 79 = 38.0% |
 * | + gate held open | 335 | **463** | 265 | 99 = 37.4% |
 * | bands, gate open | 431 | 559 | 360 | 105 = 29.2% |
 *
 * **Nauvis, run through the same code with the same lattice, is EXACT - including
 * under a changed setting**, which is the control that makes the above mean
 * something. `cliff_elevation_interval = 80` had never been captured before; the
 * port reproduces it 281/281 in both directions, so our rule tracks the game's
 * when a cliff setting moves. It also agrees on the degenerate arm, where a
 * single contour at 50 yields zero cliffs from both (Nauvis's `cliffiness_nauvis`
 * cutoff depends on the interval, unlike `cliffiness_basic`).
 *
 * So the rule, the lattice, the code packing, the repair sweep and the settings
 * plumbing are all confirmed against the game. What is left is the field: with
 * everything else switched off, **we place 463 cliffs where the game places 335**
 * - our 70-contour is 38% longer, i.e. our elevation is rougher at the 4-tile
 * scale than the one the generator reads.
 *
 * That matters because our elevation is *not* wrong against the channel it was
 * checked in: it reproduces `oracle-vulcanus-cliff-corner-fields-entity-regions`
 * to a max of 4.8e-2, and that fixture came from
 * `LuaSurface.calculate_tile_properties`. The open question is therefore whether
 * the map GENERATOR reads the same values that channel reports. The prime
 * suspect is `multisample`, which sits in `vulcanus_elevation`'s chain via
 * `vulcanus_basalt_lakes_multisample` and whose own documentation describes it
 * as evaluating "in a separate noise program with a larger grid" whose
 * "sub-grids are copied to the main program" - explicitly grid-dependent, where
 * the cliff generator's grid is the 4-tile corner lattice and
 * `calculate_tile_properties`' is not. `docs/noise/vulcanus-multisample-NOTES.md`
 * established `multisample(e, dx, dy) == e(x+dx, y+dy)`, but measured it through
 * `calculate_tile_properties` only - the same channel as the fixture.
 */
describe("Vulcanus cliffs with the rule collapsed term by term", () => {
  it("applied every override - each arm reports the settings the surface read back", () => {
    // Non-vacuity. Without this, "the term made no difference" and "the override
    // never applied" are the same observation, and the first is the conclusion.
    const eff = fx.cases.map((c) => c.effective);
    expect(eff[0]?.cliff_smoothing).toBe(0);
    expect(eff[1]?.cliff_elevation_interval).toBe(1000000);
    expect(eff[2]?.cliff_elevation_interval).toBe(1000000);
    expect(eff[2]?.richness).toBe(4);
    expect(fx.nauvisCases[1].effective?.cliff_elevation_interval).toBe(80);
    // The game placed a different number of cliffs in every Vulcanus arm.
    expect(new Set(fx.cases.map((c) => c.cliffs.length)).size).toBe(4);
  });

  it("NAUVIS stays exact, including at a cliff_elevation_interval never captured before", () => {
    // The control. Same rule, same lattice, same settings plumbing - so if this
    // passed only at the default settings it would say much less.
    const baseline = nauvisArm(0);
    expect(baseline).toEqual({ game: 282, ours: 282, matched: 282, wrong: 0 });
    const interval80 = nauvisArm(1);
    expect(interval80).toEqual({ game: 281, ours: 281, matched: 281, wrong: 0 });
  });

  it("agrees with Nauvis even where the answer is nothing at all", () => {
    // A single contour at 50 yields zero cliffs, because cliffiness_nauvis's
    // cutoff is derived from the interval and a 1e6 interval suppresses the
    // gate entirely. Our port reproduces that, which is a real check on the
    // interval dependence and not a vacuous 0 == 0: the arm above proves the
    // same code produces 281 cliffs when the settings allow any.
    const degenerate = nauvisArm(2);
    expect(degenerate.game).toBe(0);
    expect(degenerate.ours).toBe(0);
  });

  it("VULCANUS is wrong even with the rule collapsed to sign(elevation - 70)", () => {
    const collapsed = vulcanusArm(2);
    // Measured game=335 ours=463 matched=265 wrong=99. Bounds, not equalities,
    // so a genuine fix does not require editing this line - but tight enough
    // that a regression fails. The over-placement is the informative half: our
    // 70-contour is ~38% longer than the game's, i.e. our field is rougher.
    expect(collapsed.game).toBe(335);
    expect(collapsed.ours).toBeGreaterThan(collapsed.game);
    expect(collapsed.ours).toBeLessThanOrEqual(463);
    expect(collapsed.wrong).toBeGreaterThan(50);
    expect(collapsed.wrong).toBeLessThanOrEqual(99);
  });

  it("is wrong in every arm - no combination of the levers makes it exact", () => {
    for (let i = 0; i < fx.cases.length; i++) {
      const r = vulcanusArm(i);
      expect(r.matched).toBeGreaterThan(150);
      // The claim is that nothing here is close to exact, in either direction.
      expect(r.wrong / r.matched).toBeGreaterThan(0.2);
      expect(r.ours).toBeGreaterThan(r.game);
    }
  });
});
