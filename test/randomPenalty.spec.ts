import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-random-penalty.seed123456.json";
import { randomPenaltyBatch, randomPenaltyWord } from "../src/noise/randomPenalty";

// Ground truth captured from Factorio 2.1.11 (RandomPenalty::run, RE'd from the
// non-stripped binary). See docs/noise/random-penalty-NOTES.md. random_penalty is
// a BATCH op: seeded from positions[0], streamed last->first, source<=0 skips a
// draw. Each fixture case is one ordered batch.

/** Reconstruct source[i] from the fixture's sourceKind (kept out of the fixture). */
function sourceValues(kind: string, positions: readonly { x: number; y: number }[]): number[] {
  switch (kind) {
    case "const1":
      return positions.map(() => 1);
    case "x":
      return positions.map((p) => p.x);
    default:
      throw new Error(`unknown sourceKind ${kind}`);
  }
}

describe("randomPenalty", () => {
  it("reproduces the game's own values across seeds, amplitudes and the source<=0 guard", () => {
    // Compared with NO `Math.fround` on `got`. This assertion used to wrap the
    // result in one, which scored 40/40 while the op itself returned f64 - it was
    // the comparison recovering the value, not the op producing it. Raw, that
    // same tree scores 4/40 at worst 1.668e-5. All 40 fixture values are exactly
    // f32-representable, so an exact count is legal and a bound would be blind
    // between "close" and "identical" (#256).
    let exact = 0;
    let total = 0;
    let worst = 0;
    for (const c of fixture.cases) {
      const source = sourceValues(c.sourceKind, fixture.positions);
      const got = randomPenaltyBatch(fixture.positions, source, {
        seed: c.rpSeed,
        amplitude: c.amplitude,
      });
      for (let i = 0; i < got.length; i++) {
        total++;
        if (got[i] === c.values[i]) exact++;
        worst = Math.max(worst, Math.abs(got[i] - c.values[i]));
      }
    }
    expect(total).toBe(40); // anti-vacuity: a fixture regen cannot empty the loop
    expect(exact).toBe(40);
    expect(worst).toBe(0);
  });

  it("returns f32 values, because the op narrows once at the store", () => {
    // `RandomPenalty::run` ends `fcvt s5, d5; str s5` - the value LEAVES the op as
    // f32, and `resources/regularPatches.ts` multiplies what it gets back. This is
    // the planted-break guard for that narrowing: drop the `f32` in
    // randomPenaltyBatch and 36 of these 40 stop being f32. No bound can see it -
    // regularPatches.spec.ts grades at ABS_TOL 1.0 / REL_TOL 1e-2 and the change is
    // worth 1.19e-7 relative - so it has to be asserted directly.
    let checked = 0;
    for (const c of fixture.cases) {
      const source = sourceValues(c.sourceKind, fixture.positions);
      const got = randomPenaltyBatch(fixture.positions, source, {
        seed: c.rpSeed,
        amplitude: c.amplitude,
      });
      for (const [i, v] of got.entries()) {
        checked++;
        expect(Math.fround(v), `case ${c.sourceKind} seed=${c.rpSeed} index ${String(i)}`).toBe(v);
      }
    }
    expect(checked).toBe(40);
  });

  it("passes source<=0 through unchanged (the 'source must be > 0' guard)", () => {
    const positions = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ];
    const out = randomPenaltyBatch(positions, [-2, 3], { seed: 1, amplitude: 1 });
    expect(out[0]).toBe(-2); // untouched, no draw consumed
    expect(out[1]).toBeLessThan(3); // penalized
    expect(out[1]).toBeGreaterThanOrEqual(2); // amplitude 1 => U in [0,1)
  });

  it("skips no draw for a source<=0 tile: the survivor gets the FIRST draw", () => {
    // With the leading tile suppressed (source<=0), the next tile must get draw 0,
    // i.e. the same value a lone [that tile] batch (seeded identically) would get.
    const positions = [
      { x: 2, y: 3 },
      { x: 2, y: 3 },
    ];
    const both = randomPenaltyBatch(positions, [0, 1], { seed: 1, amplitude: 1 });
    const lone = randomPenaltyBatch([positions[1]], [1], { seed: 1, amplitude: 1 });
    // seed is from positions[0] in both (same coords), and the survivor takes draw 0.
    expect(both[1]).toBe(lone[0]);
    expect(both[0]).toBe(0);
  });

  it("computes the seed word as max(341, 0x3FBE2C + 7919*trunc(x0) + 7907*trunc(y0+seed))", () => {
    // (0,0) seed=1 -> 0x3FBE2C + 7907 = 4201743.
    expect(randomPenaltyWord(0, 0, 1)).toBe(0x3fbe2c + 7907);
    // seed folds into y before truncation; fractional coords truncate toward zero.
    expect(randomPenaltyWord(0.9, 0.9, 0)).toBe(0x3fbe2c); // trunc(0.9)=0 both axes
    expect(randomPenaltyWord(-1.5, 0, 0)).toBe((0x3fbe2c + Math.imul(-1, 7919)) >>> 0);
  });

  it("is order/batch dependent: the same tile gets a different U per batch", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 5, y: 7 };
    const forward = randomPenaltyBatch([a, b], [1, 1], { seed: 1, amplitude: 1 });
    const reversed = randomPenaltyBatch([b, a], [1, 1], { seed: 1, amplitude: 1 });
    // a's value differs because the seed comes from positions[0] (a vs b).
    expect(forward[0]).not.toBe(reversed[1]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(randomPenaltyBatch([], [], { seed: 1, amplitude: 1 })).toEqual([]);
  });
});
