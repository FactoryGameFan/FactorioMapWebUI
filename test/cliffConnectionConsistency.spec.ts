import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import oreDirection from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import oreRegions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import { CLIFF_ORIENTATION_NAMES } from "../src/noise/cliffs/cliffCatalog";
import {
  connectedSides,
  isCliffConnected,
  onChunkBorder,
} from "../src/noise/cliffs/cliffConnections";

/**
 * **The chunk-border gate cannot be scored from ANY committed fixture, and this
 * is why** (#84).
 *
 * #122 turned `applyCliffs`' fifth-argument test - `updateConnections` runs on
 * the chunk's outer ring and nowhere else - from an inert reading into the thing
 * its whole destroyed-versus-never-queued verdict depends on, and said scoring
 * it was "now worth doing on its own account". This is that attempt, and it
 * comes back negative in a way worth writing down so the route is not retried.
 *
 * **The test that ought to work.** A cliff end pointing at a cell that is not
 * there is a *dangling end*. If `updateConnections` ran on every cell there
 * could be no dangling end anywhere, because the pass exists precisely to trim
 * them. If it runs only on the outer ring, a dangling end could survive on a
 * NON-border cell. So the game's own output should separate the two readings.
 *
 * **It does not, because there are no dangling ends at all.** Over thirteen arms
 * from all three fixtures - every Vulcanus cliff capture on disk, at real settings
 * and at the collapsed rule, with the resources on and off - **zero** cells have
 * one, on the border or off it.
 *
 * That is not a null result about the gate; it identifies the reason the gate is
 * unobservable. Every mechanism that can remove a cliff during map generation
 * **preserves connection consistency**:
 *
 * - a destruction runs `Cliff::onDestroy`, which trims the facing end of every
 *   connected neighbour, so it cannot leave one dangling;
 * - `updateConnections` trims dangling ends by definition;
 * - and the crossing field never emits one to begin with - `cliffConnections.spec.ts`
 *   measures the port's own queue as already connection-consistent.
 *
 * So both readings of the gate predict exactly what the game shows, and no
 * capture of map-generation OUTPUT can tell them apart. The gate's only
 * observable consequence is in a counterfactual - remove a cell that the game
 * has, and ask what its neighbour keeps - which is what #122 measures and why
 * that result is conditional. **The conditional cannot be discharged with what
 * is on disk, and it is not a matter of capturing more of the same.**
 *
 * What would settle it is a world where a cliff run is truncated without the
 * cascade running, which map generation never produces. Anyone revisiting this
 * needs a different kind of evidence - the disassembly itself, or a runtime
 * probe - not another region.
 *
 * The zero is also worth having on its own: it pins **connection consistency of
 * the game's cliff output** as a property, across every capture, which nothing
 * asserted before.
 */

const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -4],
  [4, 0],
  [0, 4],
  [-4, 0],
];

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
interface Arm {
  label: string;
  region: Region;
  cliffs: Ent[];
}

/** Every Vulcanus cliff capture on disk, as one list of arms. */
const ARMS: Arm[] = [
  ...(entities.cases as unknown as { region: Region; cliffs: Ent[] }[]).map((c, i) => ({
    label: `entities region ${String(i)}`,
    region: c.region,
    cliffs: c.cliffs,
  })),
  ...(oreDirection.cases as unknown as Arm[]).map((c) => ({
    label: `ore-direction: ${c.label}`,
    region: c.region,
    cliffs: c.cliffs,
  })),
  ...(oreRegions.cases as unknown as Arm[]).map((c) => ({
    label: `ore-regions: ${c.label}`,
    region: c.region,
    cliffs: c.cliffs,
  })),
];

interface Tally {
  label: string;
  border: number;
  interior: number;
  danglingOnBorder: number;
  danglingOnInterior: number;
}

const tally = (arm: Arm): Tally => {
  const r = arm.region;
  const inR = (p: { x: number; y: number }): boolean =>
    p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
  const game = new Map<string, number>();
  for (const e of arm.cliffs)
    if (e.name === "cliff-vulcanus" && inR(e)) {
      const id = nameToId.get(e.orientation ?? "");
      if (id !== undefined) game.set(K(e.x, e.y), id);
    }

  const out: Tally = {
    label: arm.label,
    border: 0,
    interior: 0,
    danglingOnBorder: 0,
    danglingOnInterior: 0,
  };
  for (const [k, o] of game) {
    const [xs, ys] = k.split(",");
    const x = Number(xs);
    const y = Number(ys);
    // Only judge cells whose four neighbours are all inside the queried box, so
    // "the neighbour is missing" can never mean "nobody asked for it" - the halo
    // artifact `applyCliffConnections` warns about.
    if (!(x - 4 >= r.x0 && x + 4 < r.x1 && y - 4 >= r.y0 && y + 4 < r.y1)) continue;
    const border = onChunkBorder(x, y);
    if (border) out.border++;
    else out.interior++;
    let dangles = false;
    for (const s of connectedSides(o)) {
      const [dx, dy] = SIDE_STEP[s];
      const n = game.get(K(x + dx, y + dy));
      if (n === undefined || !isCliffConnected(s, o, n)) dangles = true;
    }
    if (!dangles) continue;
    if (border) out.danglingOnBorder++;
    else out.danglingOnInterior++;
  }
  return out;
};

const TALLIES = ARMS.map(tally);

describe("the game's cliff output is connection-consistent everywhere", () => {
  /**
   * The sample, stated first so the zeros below are not mistaken for an empty
   * loop: thirteen arms, and both populations are well represented in each - the
   * gate's domain is not some rare corner.
   */
  it("judges 6535 cells across thirteen arms, both populations present", () => {
    expect(TALLIES.length).toBe(13);
    const border = TALLIES.reduce((n, t) => n + t.border, 0);
    const interior = TALLIES.reduce((n, t) => n + t.interior, 0);
    expect(border).toBe(2785);
    expect(interior).toBe(3750);
    // Every arm has some of each, so no arm is vacuous on its own.
    expect(TALLIES.every((t) => t.border > 0 && t.interior > 0)).toBe(true);
  }, 300000);

  /**
   * **Zero dangling ends, on either population, in every arm.** So the two
   * readings of the gate - "outer ring only" and "every cell" - predict the same
   * output, and no capture of map-generation output can separate them.
   */
  it("finds no dangling end anywhere, on the border or off it", () => {
    expect(TALLIES.filter((t) => t.danglingOnBorder > 0).map((t) => t.label)).toEqual([]);
    expect(TALLIES.filter((t) => t.danglingOnInterior > 0).map((t) => t.label)).toEqual([]);
  }, 300000);

  /**
   * **The non-vacuity arm.** A zero is also what a detector that never fires
   * would print, so plant one: take each arm's cell set, delete a cell that has
   * a connected neighbour, and confirm the same code then reports a dangling end
   * at that neighbour. It does, in every arm.
   */
  it("reports a dangling end as soon as one is planted", () => {
    let planted = 0;
    for (const arm of ARMS) {
      const r = arm.region;
      const inR = (p: { x: number; y: number }): boolean =>
        p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
      const game = new Map<string, number>();
      for (const e of arm.cliffs)
        if (e.name === "cliff-vulcanus" && inR(e)) {
          const id = nameToId.get(e.orientation ?? "");
          if (id !== undefined) game.set(K(e.x, e.y), id);
        }
      // Find any connected pair and delete one of them.
      let victim: string | undefined;
      for (const [k, o] of game) {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        for (const s of connectedSides(o)) {
          const [dx, dy] = SIDE_STEP[s];
          const nk = K(x + dx, y + dy);
          const n = game.get(nk);
          if (n !== undefined && isCliffConnected(s, o, n)) victim = nk;
          if (victim !== undefined) break;
        }
        if (victim !== undefined) break;
      }
      expect(victim).toBeDefined();
      if (victim === undefined) continue;
      game.delete(victim);

      let dangling = 0;
      for (const [k, o] of game) {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        for (const s of connectedSides(o)) {
          const [dx, dy] = SIDE_STEP[s];
          const n = game.get(K(x + dx, y + dy));
          if (n === undefined || !isCliffConnected(s, o, n)) dangling++;
        }
      }
      expect(dangling).toBeGreaterThan(0);
      planted++;
    }
    expect(planted).toBe(13);
  }, 300000);
});
