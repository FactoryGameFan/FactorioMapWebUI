import { describe, expect, it } from "vite-plus/test";

import bands from "./fixtures/oracle-vulcanus-cliff-bands.seed123456.json";
import cornerFields from "./fixtures/oracle-vulcanus-cliff-corner-fields-entity-regions.seed123456.json";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusStack, makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **The grid-4 cliff-elevation channel, checked corner by corner** (issue #84).
 *
 * This was the one input to cliff placement with no per-corner oracle, and every
 * "the fields are exonerated" claim in the residual work rested on the TILE
 * channel instead - `calculate_tile_properties` runs the 1-tile noise program,
 * and `multisample`'s offsets are in the calling program's grid units, so
 * against the field the cliff generator actually reads it differs by 96.09.
 *
 * `oracle-vulcanus-cliff-bands` closes that by using the cliff generator itself
 * as the readout. With `cliff_smoothing = 0`, `cliff_elevation_interval = 1e6`
 * and the cliffiness gate held open, `crossesCliff` collapses to
 * `min(a,b) < cliff_elevation_0 <= max(a,b)`, so the game places a cliff on an
 * edge exactly when its two corners straddle the level - a 1-bit comparator on
 * all 4,225 corners of a region at once. The levels are the REAL bands
 * (`70 + 120k`), which is the entire placement-relevant content of the channel:
 * `crossesCliff` never compares the field against anything else.
 *
 * What it says, and it is not what the previous three sessions assumed:
 *
 * - **`[0,0]` and `[-1200,800]` are EXACT at every band, under both gate arms.**
 *   Not "close" - identical cell sets and identical orientations.
 * - **`[1500,1500]` disagrees**, concentrated at the HIGH bands, and is exact at
 *   310 / 430 / 550. The disagreement survives every explanation that was
 *   available before this fixture existed (see the eliminations below).
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const base = makeVulcanusCliffFields(ctx);
/** `cliffiness_basic` with the richness lever the `richness4` arm sets. */
const cliffiness4 = makeCliffinessBasic(123456, 4);
const stack = makeVulcanusStack(INPUT);
const tileElev = (x: number, y: number): number => stack.elevation.elevation(x, y);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const edgesOf = (code: number): number[] => [
  (code >> 6) & 3,
  (code >> 4) & 3,
  (code >> 2) & 3,
  code & 3,
];
const G = CLIFF_GRID_SIZE;

/**
 * Per edge (L, R, T, B): the two CORNER lattice-index offsets from the cell's
 * own index, matching `placedCells`' edge registers exactly - `L` is
 * `cross(corner(cx, cy), corner(cx, cy+1))`, and so on.
 *
 * The corners are the BARE lattice `(i*4, j*4)`. The emitted centre carries the
 * prototype's `grid_offset` of (2, **2.5**), so it is NOT the corner midpoint:
 * sampling `centre +/- G/2` is off by half a tile in y and quietly reads a
 * different field value.
 */
const CORNERS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 1],
  [1, 0, 1, 1],
  [0, 0, 1, 0],
  [0, 1, 1, 1],
];

type Case = (typeof bands.cases)[number];

const cellIndex = (k: string): { ci: number; cj: number } => {
  const [xs, ys] = k.split(",");
  return {
    ci: (Number(xs) - CLIFF_CELL_CENTER_X) / G,
    cj: (Number(ys) - CLIFF_CELL_CENTER_Y) / G,
  };
};

/**
 * The port under the same collapsed rule the arm was captured with.
 *
 * `constant1` routes the cliffiness PROPERTY at the literal `1`, so the gate is
 * open by construction and the port must model it as exactly that - no
 * expression of ours stands between the field and the crossing test.
 */
const place = (
  c: Case,
  opts: { repair?: boolean; field?: (x: number, y: number) => number } = {},
): { x: number; y: number; code: number }[] =>
  makeCliffPlacementFromFields(
    {
      cliffElevation: opts.field ?? base.cliffElevation,
      cliffiness: c.gate === "constant1" ? (): number => 1 : cliffiness4,
    },
    {
      elevation0: c.level,
      interval: 1000000,
      smoothing: 0,
      fixImpossibleCells: opts.repair ?? true,
      tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
      cellRejects: oreRejects,
    },
  ).placedCells(c.region.x0, c.region.y0, c.region.x1, c.region.y1);

/**
 * The game's cells whose CENTRE is in the window.
 *
 * `find_entities_filtered` selects on the entity's BOUNDING BOX, `placedCells`
 * emits on the centre, so the raw dump carries cliffs centred just outside the
 * captured box. Scoring those as "missing" is the artefact that made recall read
 * 0.972 instead of 0.9961 (#101); filtering here is the same correction.
 */
const gameCells = (c: Case): Map<string, string> => {
  const m = new Map<string, string>();
  for (const e of c.cliffs) {
    if (e.name !== "cliff-vulcanus") continue;
    if (e.x < c.region.x0 || e.x >= c.region.x1) continue;
    if (e.y < c.region.y0 || e.y >= c.region.y1) continue;
    m.set(key(e.x, e.y), e.orientation);
  }
  return m;
};

interface Scored {
  game: number;
  ours: number;
  matched: number;
  wrong: number;
  surplus: number;
  missing: number;
}

const score = (c: Case, field?: (x: number, y: number) => number): Scored => {
  const ours = new Map(place(c, { field }).map((p) => [key(p.x, p.y), p.code] as const));
  const game = gameCells(c);
  let matched = 0;
  let wrong = 0;
  for (const [k, ourCode] of ours) {
    const want = game.get(k);
    if (want === undefined) continue;
    matched++;
    const id = nameToId.get(want);
    if (id === undefined || codeForOrientation.get(id) !== ourCode) wrong++;
  }
  return {
    game: game.size,
    ours: ours.size,
    matched,
    wrong,
    surplus: ours.size - matched,
    missing: game.size - matched,
  };
};

/** Every disputed EDGE: a matched cell whose orientation differs, per differing edge. */
const disputedEdges = (
  gate: string,
): { c: Case; k: string; edge: number; a: number; b: number }[] => {
  const out: { c: Case; k: string; edge: number; a: number; b: number }[] = [];
  for (const c of bands.cases) {
    if (c.gate !== gate) continue;
    const ours = new Map(place(c).map((p) => [key(p.x, p.y), p.code] as const));
    const game = gameCells(c);
    for (const [k, ourCode] of ours) {
      const want = game.get(k);
      if (want === undefined) continue;
      const id = nameToId.get(want);
      const gameCode = id === undefined ? undefined : codeForOrientation.get(id);
      if (gameCode === undefined || gameCode === ourCode) continue;
      const mine = edgesOf(ourCode);
      const theirs = edgesOf(gameCode);
      const { ci, cj } = cellIndex(k);
      for (let edge = 0; edge < 4; edge++) {
        if (mine[edge] === theirs[edge]) continue;
        const [ax, ay, bx, by] = CORNERS[edge];
        out.push({
          c,
          k,
          edge,
          a: base.cliffElevation((ci + ax) * G, (cj + ay) * G),
          b: base.cliffElevation((ci + bx) * G, (cj + by) * G),
        });
      }
    }
  }
  return out;
};

describe("the grid-4 cliff-elevation channel, corner by corner", () => {
  it("covers both gate arms at every band each region's field crosses", () => {
    expect(bands.cases.length).toBe(30);
    expect(new Set(bands.cases.map((c) => c.gate))).toEqual(new Set(["richness4", "constant1"]));
    // Every override reached the surface - read BACK off map_gen_settings, not
    // echoed, so a silently-ignored setting cannot pass as one that did nothing.
    for (const c of bands.cases) {
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.cliff_elevation_interval).toBe(1000000);
      expect(c.effective?.cliff_elevation_0).toBe(c.level);
      expect(c.effective?.richness).toBe(c.gate === "richness4" ? 4 : 1);
    }
  });

  /**
   * **`richness = 4` does NOT hold the gate open everywhere**, which the option's
   * own documentation claimed and no arm had ever checked.
   *
   * `cliffiness_basic` is `clamp(0.5*log2(richness) + qmn, 0, 1) + 0.5`, so at
   * richness 4 the clamp is `clamp(1 + qmn, 0, 1)` - which is still 0, and the
   * gate still SHUT, wherever `qmn <= -1`. Routing the property at the literal
   * `1` is the only arm where "the gate is open" is a construction rather than a
   * model, and the difference is not cosmetic: it is worth 135 cliffs at one
   * level. Anything concluded from a richness-4 arm alone inherits this.
   */
  it("the constant-1 route opens the gate strictly wider than richness = 4", () => {
    const byKey = new Map(
      bands.cases.map((c) => [`${c.gate}|${String(c.region.x0)}|${String(c.level)}`, c]),
    );
    let strictlyMore = 0;
    for (const c of bands.cases) {
      if (c.gate !== "constant1") continue;
      const r4 = byKey.get(`richness4|${String(c.region.x0)}|${String(c.level)}`);
      expect(r4).toBeDefined();
      expect(c.cliffs.length).toBeGreaterThanOrEqual(r4?.cliffs.length ?? 0);
      if (c.cliffs.length > (r4?.cliffs.length ?? 0)) strictlyMore++;
    }
    // Non-vacuity: if the route had silently failed, every arm would tie.
    expect(strictlyMore).toBeGreaterThanOrEqual(10);
  });

  /**
   * **The headline.** Two of the three regions reproduce the game's cliffs
   * EXACTLY at every band, under both arms - same cells, same orientations, and
   * nothing spare. With smoothing off and the gate open there is nothing between
   * the field and the placement, so this is the field itself being right.
   */
  it("is EXACT at [0,0] and [-1200,800], every band, both arms", () => {
    for (const c of bands.cases) {
      if (c.region.x0 === 1500) continue;
      const s = score(c);
      expect(
        `${c.gate} [${String(c.region.x0)}] L=${String(c.level)} ` +
          `w=${String(s.wrong)} s=${String(s.surplus)} m=${String(s.missing)}`,
      ).toBe(`${c.gate} [${String(c.region.x0)}] L=${String(c.level)} w=0 s=0 m=0`);
      // Not vacuous: these arms place hundreds of cells, not a handful.
      expect(s.matched).toBe(s.game);
    }
  });

  /**
   * `[1500,1500]` is exact at 310 / 430 / 550 and wrong at the high bands. The
   * counts are pinned so a change in either direction is visible; the point of
   * the row is the SHAPE (exact in the middle, wrong high), not the exact value.
   */
  it("disagrees at [1500,1500], concentrated at the HIGH bands", () => {
    const rows = bands.cases
      .filter((c) => c.region.x0 === 1500 && c.gate === "constant1")
      .map((c) => {
        const s = score(c);
        return `L${String(c.level)} w${String(s.wrong)} s${String(s.surplus)}`;
      });
    expect(rows).toEqual([
      "L70 w1 s3",
      "L190 w2 s2",
      "L310 w0 s0",
      "L430 w0 s0",
      "L550 w0 s0",
      "L670 w8 s5",
      "L790 w36 s42",
      "L910 w22 s41",
      "L1030 w2 s2",
      "L1150 w2 s2",
    ]);
  });

  /**
   * **The repair is not the route.** `fixImpossibleCells` can clear an edge, so
   * a wrong orientation could in principle come from the repair rather than from
   * the crossing test - and the repair's input is the whole chunk, so it would
   * not even have to be a field difference AT that edge.
   *
   * It is not: not one disputed cell has a code our repair changed, so all of
   * them are raw `crossesCliff` disagreements and the per-edge reading below is
   * about the field at that edge.
   */
  it("no disputed cell's code is one the repair touched", () => {
    let disputed = 0;
    let touched = 0;
    for (const c of bands.cases) {
      if (c.gate !== "constant1") continue;
      const on = new Map(place(c).map((p) => [key(p.x, p.y), p.code] as const));
      const off = new Map(place(c, { repair: false }).map((p) => [key(p.x, p.y), p.code] as const));
      const game = gameCells(c);
      for (const [k, ourCode] of on) {
        const want = game.get(k);
        if (want === undefined) continue;
        const id = nameToId.get(want);
        const gameCode = id === undefined ? undefined : codeForOrientation.get(id);
        if (gameCode === undefined || gameCode === ourCode) continue;
        disputed++;
        if (off.get(k) !== ourCode) touched++;
      }
    }
    expect(disputed).toBe(73);
    expect(touched).toBe(0);
  });

  /**
   * **The disagreement is nowhere near a band boundary**, so it is not float
   * noise in the crossing test - the same result `cliffOrientationMargin.spec.ts`
   * reached on the shipping path, now with smoothing and the gate removed.
   */
  it("the disputed edges sit tens of units from the level", () => {
    const edges = disputedEdges("constant1");
    expect(edges.length).toBe(73);
    const lb = edges
      .map((e) => Math.min(Math.abs(e.a - e.c.level), Math.abs(e.b - e.c.level)))
      .sort((p, q) => q - p);
    expect(lb[0]).toBeGreaterThan(65);
    expect(lb[Math.floor(lb.length / 2)]).toBeGreaterThan(10);
    // Every one of them is far outside float noise at this scale.
    expect(lb[lb.length - 1]).toBeGreaterThan(0.1);
  });

  /**
   * **The paradox this fixture uncovered, and the handoff.**
   *
   * At 72 of the 73 disputed edges the GAME'S OWN TILE CHANNEL straddles the
   * level - and agrees with our cliff-channel value at those corners. So the
   * game's cliff generator is reading a field that differs from the game's own
   * `calculate_tile_properties` elevation there, while the port has the two
   * equal.
   *
   * `multisample` cannot be the difference: at these corners our grid-4 and
   * grid-1 variants return the SAME value (the bake-off below scores them
   * identically at L790 and L910), because the basalt-lakes term is lerped away
   * at high elevation. Whatever separates the game's two channels at
   * `[1500,1500]` is therefore something the port does not model at all - and
   * that, not the smoothing and not the gate, is what is left of #84.
   */
  it("the game's own TILE channel straddles the level at the disputed edges", () => {
    const idx = new Map<string, number>();
    cornerFields.corners.forEach((k, i) => idx.set(k, i));
    const tile = (i: number, j: number): number | undefined => {
      const at = idx.get(`${String(i)},${String(j)}`);
      return at === undefined ? undefined : cornerFields.elevation[at];
    };
    let straddles = 0;
    let uncovered = 0;
    for (const e of disputedEdges("constant1")) {
      const { ci, cj } = cellIndex(e.k);
      const [ax, ay, bx, by] = CORNERS[e.edge];
      const ga = tile(ci + ax, cj + ay);
      const gb = tile(ci + bx, cj + by);
      if (ga === undefined || gb === undefined) {
        uncovered++;
        continue;
      }
      if (Math.min(ga, gb) < e.c.level && e.c.level <= Math.max(ga, gb)) straddles++;
    }
    expect(uncovered).toBe(0);
    expect(straddles).toBe(72);
  });

  /**
   * **The obvious repairs are all worse**, scored rather than argued - the
   * lesson of #88/#90, where the best-scoring model was the wrong one and hid a
   * second defect.
   *
   * A widened min-filter is the natural guess once the cliff channel is known to
   * differ from the tile channel, and both spellings of it are catastrophic. The
   * tile channel scores identically to the shipping model at the high bands,
   * which is the measurement behind "multisample cannot explain these".
   */
  it("no wider min-filter beats the shipping field", () => {
    const shipping = (x: number, y: number): number => base.cliffElevation(x, y);
    const models: { name: string; f: (x: number, y: number) => number }[] = [
      {
        name: "min 2x2 of the whole elevation at +4",
        f: (x, y) =>
          Math.min(tileElev(x, y), tileElev(x + 4, y), tileElev(x, y + 4), tileElev(x + 4, y + 4)),
      },
      {
        name: "min 2x2 of the cliff channel at +4",
        f: (x, y) =>
          Math.min(shipping(x, y), shipping(x + 4, y), shipping(x, y + 4), shipping(x + 4, y + 4)),
      },
      { name: "the tile channel", f: tileElev },
    ];
    const total = (f?: (x: number, y: number) => number): { wrong: number; surplus: number } => {
      let wrong = 0;
      let surplus = 0;
      for (const c of bands.cases) {
        if (c.gate !== "constant1") continue;
        const s = score(c, f);
        wrong += s.wrong;
        surplus += s.surplus;
      }
      return { wrong, surplus };
    };
    const ship = total();
    expect(ship.wrong).toBe(73);
    for (const m of models) {
      const got = total(m.f);
      expect(
        `${m.name}: ${String(got.wrong + got.surplus)} > ${String(ship.wrong + ship.surplus)}`,
      ).toBe(
        `${m.name}: ${String(got.wrong + got.surplus)} > ${String(ship.wrong + ship.surplus)}`,
      );
      expect(got.wrong + got.surplus).toBeGreaterThan(ship.wrong + ship.surplus);
    }
  }, 120000);
});
