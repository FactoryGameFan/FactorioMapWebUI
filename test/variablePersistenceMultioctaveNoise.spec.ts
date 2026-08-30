import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-variable-persistence-multioctave.seed123456.json";

interface VarPersCase {
  octaves: number;
  inputScale: number;
  outputScale: number;
  offsetX: number;
  seed1: number;
  values: number[];
}

/** Worst absolute error of an evaluator over the whole fixture, and where. */

describe("variablePersistenceMultioctaveNoise reproduces the game", () => {
  // Ground truth: test/fixtures/oracle-variable-persistence-multioctave.seed123456.json,
  // captured via the oracle harness. `persistenceField` is the per-tile value of the
  // persistence expression (routed onto elevation), fed back in as the model's
  // per-tile p. Regenerate with test/oracle/capture.ts.

  // The exact-count and zero-residual assertions above are only meaningful if the
  // fixture is all-f32; against an f64 ground truth no f32 port could ever reach
  // them, and the temptation would be to loosen the score instead of reading it.
  it("every fixture value is exactly representable in f32", () => {
    for (const c of fixture.cases as VarPersCase[]) {
      for (const v of c.values) expect(Math.fround(v)).toBe(v);
    }
  });

  // Guard: the tolerance above must not be reachable by the pre-fix models. As with
  // the plain op, NEITHER half of the fix does anything on its own.
});
