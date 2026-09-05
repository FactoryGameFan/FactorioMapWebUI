import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";
import { surveyCellsThroughWasm } from "../src/noise/islands/surveyThroughWasm";
import { surveyIslands, surveyStep } from "../src/noise/islands/cellSurvey";
import { sliderToLinear } from "../src/noise/eval/math";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { bearingTrig } from "../src/noise/wasm/request";
import {
  consultedCount,
  expectFrozen,
  expectRecordedRows,
  flushRecording,
  foldJson,
  frozenCount,
  RECORDING,
} from "./islandsFrozen";

/**
 * The engine-backed cell survey against its frozen output, position for
 * position.
 *
 * This is the tier-2 of `islands/`. It was written while the TypeScript survey
 * still existed and compared the two directly; #376 froze that comparison
 * into `test/fixtures/island-finder-checksums.json` and #371 deleted the
 * TypeScript arm, so the engine's output is now graded against the value
 * captured while the two demonstrably agreed. Unlike the render parity specs
 * there is no image to compare - the survey's output is three numbers per
 * position, and all three have to match exactly or the finder groups its
 * samples into different cells.
 *
 * **`cellIndex` is the one worth watching.** The module reads it at the
 * WARPED position rather than the raw sample, and reading it at the raw one
 * gives a plausible neighbouring cell - so a wrong answer here looks like a
 * slightly different island list rather than like a crash.
 */
const SEED0 = surfaceSeedForPlanet("fulgora", 123456);
const CTX = { seed0: SEED0 };

/**
 * The freeze section for this spec. See `islandsFrozen.ts`.
 *
 * Every comparison below folds the engine's answer against a frozen value,
 * captured while the TypeScript arm still existed and the two agreed.
 */
const SECTION = "fulgora:survey";

/** Two raw sweeps and one candidate list. A literal, for the reason every other section gives. */
const ROWS = 3;

expectRecordedRows(SECTION, ROWS);
afterAll(flushRecording);

/** Assert one structure against its frozen checksum. */
function freeze(label: string, name: string, wasm: unknown): void {
  expectFrozen(SECTION, label, name, foldJson(wasm));
}

async function engine(): Promise<EngineExports> {
  const bytes = readFileSync(
    join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm"),
  );
  return instantiateEngine(await compileEngine(bytes));
}

function wasmSweep(
  e: EngineExports,
  box: { x0: number; y0: number; x1: number; y1: number },
  step: number,
) {
  const out: { x: number; y: number; id: number; cellX: number; cellY: number }[] = [];
  surveyCellsThroughWasm(e, CTX, box, step, (x, y, id, cellX, cellY) => {
    out.push({ x, y, id, cellX, cellY });
  });
  return out;
}

describe("the WASM cell survey reproduces its frozen sweeps", () => {
  const STEP = surveyStep(175);

  it("matches id, cellX and cellY at every position of a real box", async () => {
    const e = await engine();
    const box = { x0: -1200, y0: -900, x1: 1200, y1: 900 };
    const wasm = wasmSweep(e, box, STEP);
    freeze("box -1200..1200 x -900..900", "sweep", wasm);

    // Anti-vacuity: a sweep that agreed on nothing but zeros would fold to a
    // perfectly stable checksum. Freeze that the box carries many distinct
    // cells and a real spread of ids, so a box drifting off the interesting
    // region fails rather than silently comparing ocean.
    const cells = new Set(wasm.map((p) => `${String(p.cellX)},${String(p.cellY)}`));
    expect(cells.size).toBeGreaterThan(50);
    expect(wasm.filter((p) => p.id >= 0.33).length).toBeGreaterThan(100);
  }, 300000);

  it("bands without dropping, duplicating or reordering a position", async () => {
    // The band size comes from the module's own buffer, which is far larger
    // than any box a test would sweep - so a single-call sweep would never
    // exercise the loop. This shrinks the effective band by asking the engine
    // for its limit and comparing against a hand-banded reference instead.
    const e = await engine();
    const box = { x0: -400, y0: -300, x1: 400, y1: 300 };
    const whole = wasmSweep(e, box, STEP);
    freeze("box -400..400 x -300..300", "sweep", whole);

    // Sweeping the same box as two stacked halves must reproduce the whole,
    // which is what a band boundary is. Rows are the unit, so the split is on a
    // row boundary the same way the real banding splits.
    const rows = Math.floor((box.y1 - box.y0) / STEP) + 1;
    const cut = Math.floor(rows / 2);
    const top = { ...box, y1: box.y0 + (cut - 1) * STEP };
    const bottom = { ...box, y0: box.y0 + cut * STEP };
    expect([...wasmSweep(e, top, STEP), ...wasmSweep(e, bottom, STEP)]).toEqual(whole);
  }, 300000);

  it("produces its frozen island list", async () => {
    // The assertion that actually matters to a user. The sweeps above are raw
    // triples; this is what the finder builds out of them - the grouping, the
    // bounding boxes and the centroids. The centroid is a SAMPLED position
    // chosen in visit order, so a sweep that produced identical values in a
    // different order would fold the same triples and still move this row.
    const e = await engine();
    const box = { x0: -1500, y0: -1500, x1: 1500, y1: 1500 };
    const wasm = surveyIslands(CTX, box, e);
    freeze("box -1500..1500", "island list", wasm);

    // Anti-vacuity: an empty list folds to a stable checksum too. Freeze that
    // this box really finds islands, so a box drifting into open ocean fails
    // rather than silently comparing nothing.
    expect(wasm.length).toBeGreaterThan(30);
    expect(wasm.reduce((n, c) => n + c.sampleCount, 0)).toBeGreaterThan(500);
  }, 300000);

  it("derives the step from the grid the same way the TypeScript formula does", async () => {
    // The engine path cannot call `surveyStep(stack.shared.grid)` without
    // building a stack that no longer exists, so it asks the module. The
    // module's answer is checked against the formula written out here -
    // `grid = f32(175 - sliderToLinear(frequency, -50, 50))`, from
    // `fulgoraShared.ts` before #371 and `expressions/fulgora_shared.rs`
    // now - so the two derivations stay independent rather than the test
    // reading the module's number back to it.
    const e = await engine();
    const trig = bearingTrig(CTX.seed0);
    const stepAt = (frequency: number): number =>
      e.fulgora_survey_step(
        CTX.seed0,
        frequency,
        1,
        trig.sinStart,
        trig.cosStart,
        trig.sinVault,
        trig.cosVault,
      );
    const gridAt = (frequency: number): number =>
      Math.fround(175 - sliderToLinear(frequency, -50, 50));

    expect(stepAt(1)).toBe(surveyStep(175));
    expect(stepAt(1)).toBe(surveyStep(gridAt(1)));

    // And it MOVES with the frequency lever, so a constant cannot pass.
    expect(stepAt(3)).not.toBe(stepAt(1));
    expect(stepAt(3)).toBe(surveyStep(gridAt(3)));
  }, 300000);

  it("reports the module's own band limit rather than a guess", async () => {
    const e = await engine();
    // 4 MB of output at 24 bytes a position. Asserted against the module so a
    // buffer change cannot leave the caller banding to a stale number.
    expect(e.survey_max_positions()).toBe(Math.floor((1024 * 1024 * 4) / 24));
  });

  it("refuses a box it cannot survey rather than returning a short sweep", async () => {
    const e = await engine();
    // One row past the buffer. A silent short sweep would read as "no islands
    // out there", which is a legitimate answer for a real box.
    const wide = e.survey_max_positions() + 1;
    expect(() => wasmSweep(e, { x0: 0, y0: 0, x1: (wide - 1) * STEP, y1: 0 }, STEP)).toThrow(
      /exceeds the engine's buffer/,
    );
  });
});

describe("the freeze covers this spec rather than merely existing", () => {
  // `expectRecordedRows` guards only a RECORD run. On a normal run nothing
  // above checks that the rows are actually consulted: a deleted `freeze`
  // call site would leave its row in the table un-consulted and every gate
  // green while coverage shrank. This table is the only thing grading these
  // sweeps now. Both numbers, because they fail on opposite mistakes - see
  // `wasmNauvisRenderParity.spec.ts`.
  it.skipIf(RECORDING)("consults every frozen row exactly once", () => {
    expect(frozenCount(SECTION), "rows in the committed table").toBe(ROWS);
    expect(consultedCount(SECTION), "distinct rows this run looked up").toBe(ROWS);
  });
});
