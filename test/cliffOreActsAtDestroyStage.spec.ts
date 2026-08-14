import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
import {
  CLIFF_ORIENTATION_ENDS,
  applyCliffConnections,
  connectedSides,
  onChunkBorder,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **The ore suppression is a DESTRUCTION at `applyCliffs`, not a failure to
 * queue - and it is provably NOT the engine's entity-collision test** (#84).
 *
 * `vulcanusOreRejection.ts` states that the mechanism of the ore -> cliff rule is
 * open, and that the obvious candidate - a collision test seeing the resource
 * entity - is refuted by ordering. Two things are added here. The refutation is
 * now verified rather than asserted, by three independent routes; and the stage
 * the rule acts at is measured rather than assumed.
 *
 * **What the binary says** (2.1.12, arm64 slice; addresses in
 * `docs/noise/cliffs-NOTES.md`):
 *
 * - `EntityMapGenerationTask::computeInternal` calls `generateCliffs` FIRST, at
 *   `+0x2c`, before it even builds the `NoiseCache` the entity passes use, then
 *   `generateEntities` three times and `generateDecoratives`. `apply` calls
 *   `applyCliffs` (`+0x7c`), `applyDecoratives`, then `applyEntities`. So within
 *   a chunk no resource exists at any point where a cliff is decided.
 * - `generateCliffs` calls exactly three things - `crossingsForChunk`,
 *   `MaybeCliffOrientation::value` and `tryToAddCliff`. There is no resource
 *   input to the queue at all.
 * - `applyEntities` tests each queued entity with
 *   `Surface::mapGeneratorWouldCollide` and, on a hit, **skips that entity**
 *   (`tbnz w0, #0x0` to the loop tail). It never destroys a cliff. So the only
 *   entity-versus-cliff test in map generation runs in the direction the lever
 *   already measured as inert (#99: forcing cliffs through the tungsten field
 *   moves the ore not one tile).
 *
 * **What the game data says.** `calcite`, `tungsten-ore` and
 * `sulfuric-acid-geyser` are all `type = "resource"` and none carries an
 * explicit `collision_mask`, so all three take the type default from
 * `core/lualib/collision-mask-defaults.lua`: `{layers={resource=true}}`. The
 * cliff default is `{item, meltable, object, player, water_tile,
 * is_lower_object, is_object, cliff}`. **Disjoint.** A resource therefore cannot
 * collide with a cliff under any ordering, in any chunk, at any box size - which
 * closes the cross-chunk variant of the idea too (chunk N's entities are on the
 * surface before chunk N+1's cliffs are applied, and it still cannot matter).
 *
 * **The consequence that matters for #84.** The box-overlap model in
 * `vulcanusOreRejection.ts` does not correspond to the engine's collision test.
 * Widening its box until the remaining cells fall out would not be modelling a
 * known code path; it would be fitting a shape to an effect whose geometry is
 * still unknown, which is exactly what #88 records as having shipped a wrong
 * model that scored perfectly. The recall gap is real and worth closing - but
 * not that way.
 *
 * **Update 2026-08-14: the effect now has a name, and it predicts this
 * result.** `ResourceEntityPrototype::cliff_removal_probability` (default 1.0)
 * is the mechanism - see `cliffRemovalProbability.spec.ts`. A field that
 * *removes* cliffs can only act on cliffs that already exist, so "destroyed
 * rather than never queued" is what it predicts, and this spec's thin n=1
 * result stops standing on its own. It does not name the geometry, so the
 * warning above about widening the box is unchanged.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation?: string;
}
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const cases = entities.cases as unknown as { region: Region; cliffs: Ent[] }[];
const R = cases[1].region;
const inR = (p: { x: number; y: number }): boolean =>
  p.x >= R.x0 && p.x < R.x1 && p.y >= R.y0 && p.y < R.y1;

const GAME = new Map<string, number>();
for (const e of cases[1].cliffs)
  if (e.name === "cliff-vulcanus" && inR(e)) {
    const id = nameToId.get(e.orientation ?? "");
    if (id !== undefined) GAME.set(K(e.x, e.y), id);
  }

const RAW = makeCliffPlacementFromFields(fields, BANDS).placedCells(
  R.x0 - 64,
  R.y0 - 64,
  R.x1 + 64,
  R.y1 + 64,
);
const RAWMAP = new Map<string, number>();
for (const p of RAW) {
  const o = CLIFF_CODE_TO_ORIENTATION[p.code];
  if (o !== undefined) RAWMAP.set(K(p.x, p.y), o);
}

const oreCases = ore.cases as unknown as { label: string; region: Region; cliffs: Ent[] }[];
const arm = (label: string): Set<string> => {
  const c = oreCases.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  const s = new Set<string>();
  for (const e of c.cliffs)
    if (
      e.name === "cliff-vulcanus" &&
      e.x >= c.region.x0 &&
      e.x < c.region.x1 &&
      e.y >= c.region.y0 &&
      e.y < c.region.y1
    )
      s.add(K(e.x, e.y));
  return s;
};
const ON = arm("entity region, resources ON");
const ALL_OFF = arm("entity region, ALL resources OFF");
const GEYSER_OFF = arm("entity region, geyser OFF");
const SUPPRESSED = [...ALL_OFF].filter((k) => !ON.has(k)).sort((a, b) => a.localeCompare(b));

const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -4],
  [4, 0],
  [0, 4],
  [-4, 0],
];
const hasEnd = (o: number, side: number): boolean => {
  const e = CLIFF_ORIENTATION_ENDS[o];
  return e !== undefined && (e[0] === side || e[1] === side);
};

/**
 * #122's rule: destruction runs `onDestroy` on the neighbour unconditionally,
 * while a cell that was never queued only costs a neighbour its end if that
 * neighbour is on a chunk border.
 */
interface Decision {
  cell: string;
  neighbour: string;
  cause: "geyser" | "calcite";
  game: string;
  endGone: boolean;
}
const DECIDABLE: Decision[] = (() => {
  const out: Decision[] = [];
  for (const cell of SUPPRESSED) {
    const o = RAWMAP.get(cell);
    if (o === undefined) continue;
    const [xs, ys] = cell.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const s of connectedSides(o)) {
      const [dx, dy] = SIDE_STEP[s];
      const nk = K(x + dx, y + dy);
      const facing = oppositeSide(s);
      const queued = RAWMAP.get(nk);
      const game = GAME.get(nk);
      if (queued === undefined || !hasEnd(queued, facing)) continue;
      if (game === undefined || onChunkBorder(x + dx, y + dy)) continue;
      out.push({
        cell,
        neighbour: nk,
        cause: GEYSER_OFF.has(cell) ? "geyser" : "calcite",
        game: CLIFF_ORIENTATION_NAMES[game],
        endGone: !hasEnd(game, facing),
      });
    }
  }
  return out;
})();

const scoreWith = (
  cells: readonly { x: number; y: number; code: number }[],
  killed: Set<string>,
): { wrong: number; at: string[] } => {
  const out = applyCliffConnections(cells, {
    collides: (_o, x, y) => inR({ x, y }) && killed.has(K(x, y)),
  });
  const port = new Map(out.filter(inR).map((p) => [K(p.x, p.y), p.orientation] as const));
  let wrong = 0;
  const at: string[] = [];
  for (const [k, id] of port) {
    const t = GAME.get(k);
    if (t !== undefined && t !== id) {
      wrong++;
      at.push(k);
    }
  }
  return { wrong, at };
};
const GAME_KILL = new Set([...RAWMAP.keys()].filter((k) => inR(keyPos(k)) && !GAME.has(k)));
function keyPos(k: string): { x: number; y: number } {
  const [xs, ys] = k.split(",");
  return { x: Number(xs), y: Number(ys) };
}

describe("the ore suppression acts at the DESTROY stage", () => {
  /**
   * **The oracle is thin here and that is the first thing to report.** Of the 31
   * cells the lever attributes to the ore, only **one** has a neighbour that can
   * distinguish destruction from non-generation - the rest have neighbours the
   * game also lacks, neighbours on a chunk border, or no facing end. The
   * conclusion below is an n=1 stage localisation, not a survey.
   */
  it("finds exactly one of the 31 decidable", () => {
    expect(SUPPRESSED.length).toBe(31);
    expect(DECIDABLE.length).toBe(1);
    expect(DECIDABLE[0]).toEqual({
      cell: "1546,1550.5",
      neighbour: "1546,1546.5",
      cause: "geyser",
      game: "north-to-none",
      endGone: true,
    });
  }, 300000);

  /**
   * **DESTROYED, not never-queued.** The neighbour's south end is gone in the
   * game's own data, and only `Cliff::onDestroy` removes it - a cell that
   * `crossingsForChunk` never emitted would have left that non-border neighbour
   * with its end intact.
   *
   * So the ore's effect enters at `applyCliffs`, where `Surface::wouldCollide`
   * decides, and NOT at the crossing stage. Given the entity half of that
   * function cannot see a resource (disjoint masks, and no resource exists yet),
   * whatever the ore does reaches `wouldCollide` by some other route - which is
   * a sharper open question than "the mechanism is unknown".
   */
  it("contradicts the game if that cell is treated as never queued", () => {
    // Baseline: the game's own destruction set reproduces the region exactly.
    expect(scoreWith(RAW, GAME_KILL).wrong).toBe(0);

    const cell = "1546,1550.5";
    const without = RAW.filter((p) => K(p.x, p.y) !== cell);
    const killed = new Set([...GAME_KILL].filter((k) => k !== cell));
    const s = scoreWith(without, killed);
    expect(s.wrong).toBe(1);
    expect(s.at).toEqual(["1546,1546.5"]);
  }, 300000);

  /**
   * The contrast arm: every OTHER ore-suppressed cell can be removed from the
   * queue with no observable consequence, which is what "only one is decidable"
   * means in practice and stops the arm above reading as a general property.
   */
  it("costs nothing when any of the other 30 is treated as never queued", () => {
    let changed = 0;
    for (const cell of SUPPRESSED) {
      if (cell === "1546,1550.5") continue;
      const without = RAW.filter((p) => K(p.x, p.y) !== cell);
      const killed = new Set([...GAME_KILL].filter((k) => k !== cell));
      if (scoreWith(without, killed).wrong > 0) changed++;
    }
    expect(changed).toBe(0);
  }, 300000);
});
