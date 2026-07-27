import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-enemy-base.seed123456.json";
import { makeEnemyBaseField } from "../src/noise/enemies/enemyBaseField";
import { ENEMY_PLACEMENT_CAP } from "../src/noise/enemies/enemyCatalog";

const ABS_TOL = 1.0;
const REL_TOL = 1e-2;
const relErr = (p: number, g: number) => Math.abs(p - g) / Math.max(1, Math.abs(g));
/**
 * A decision-boundary agreement probe, NOT a render threshold. This was
 * `ENEMY_FOOTPRINT_THRESHOLD`, deleted when the overlay moved from thresholding
 * the probability field to rolling against it. The assertion it powers is still
 * worth keeping - `worstAbs`/`worstRel` are aggregate, and this one says port and
 * game never fall on opposite sides of a cut through the live part of the range -
 * so the value moves here as a test-local constant rather than surviving as dead
 * production code.
 */
const PROBE_CUT = 0.05;
const inFootprint = (v: number) => Math.min(v, ENEMY_PLACEMENT_CAP) >= PROBE_CUT;

describe("makeEnemyBaseField vs oracle", () => {
  for (const c of fixture.cases) {
    it(`matches enemy_base_probability seed=${c.seed}`, () => {
      const f = makeEnemyBaseField({ seed0: c.seed, controls: { frequency: 1, size: 1 } });
      let worstAbs = 0,
        worstRel = 0,
        footprintDisagreements = 0;
      const mism: { x: number; y: number; game: number; port: number; abs: number }[] = [];
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const game = c.values[i];
        const port = f.field(p.x, p.y);
        const abs = Math.abs(port - game);
        if (abs > worstAbs) worstAbs = abs;
        if (relErr(port, game) > worstRel) worstRel = relErr(port, game);
        if (inFootprint(port) !== inFootprint(game)) footprintDisagreements++;
        mism.push({ x: p.x, y: p.y, game, port, abs });
      }
      if (worstAbs >= ABS_TOL && worstRel >= REL_TOL) {
        const top = [...mism]
          .sort((a, b) => b.abs - a.abs)
          .slice(0, 12)
          .map(
            (m) =>
              `  (${m.x},${m.y}) game=${m.game.toFixed(3)} port=${m.port.toFixed(3)} abs=${m.abs.toFixed(3)}`,
          )
          .join("\n");
        throw new Error(
          `seed=${c.seed}: worstAbs=${worstAbs.toFixed(3)} worstRel=${worstRel.toExponential(2)}\n${top}`,
        );
      }
      expect(worstAbs < ABS_TOL || worstRel < REL_TOL).toBe(true);
      expect(footprintDisagreements).toBe(0);
    });
  }
});
