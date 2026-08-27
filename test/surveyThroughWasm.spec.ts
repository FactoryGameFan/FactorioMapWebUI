import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";
import { surveyCellsThroughWasm } from "../src/noise/islands/surveyThroughWasm";
import { surveyIslands, surveyStep } from "../src/noise/islands/cellSurvey";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { bearingTrig } from "../src/noise/wasm/request";

/**
 * The engine-backed cell survey against the TypeScript one, position for
 * position.
 *
 * This is the tier-2 of `islands/`: it exists because #227 deletes the
 * TypeScript arm, and it has to be written while both still run. Unlike the
 * render parity specs there is no image to compare - the survey's output is
 * three numbers per position, and all three have to match exactly or the finder
 * groups its samples into different cells.
 *
 * **`cellIndex` is the one worth watching.** `cellSurvey.ts` reads it at the
 * WARPED position rather than the raw sample, and reading it at the raw one
 * gives a plausible neighbouring cell - so a wrong answer here looks like a
 * slightly different island list rather than like a crash.
 */
const SEED0 = surfaceSeedForPlanet("fulgora", 123456);
const CTX = { seed0: SEED0 };

async function engine(): Promise<EngineExports> {
  const bytes = readFileSync(
    join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm"),
  );
  return instantiateEngine(await compileEngine(bytes));
}

/** The TypeScript survey's three values, in the order the sweep visits them. */
function tsSweep(box: { x0: number; y0: number; x1: number; y1: number }, step: number) {
  const stack = makeFulgoraStack(CTX);
  const cellsAt = stack.cells.cells;
  const cellIndex = stack.cells.voronoiCells.cellIndex;
  const wx = stack.shared.wx;
  const wy = stack.shared.wy;
  const out: { x: number; y: number; id: number; cellX: number; cellY: number }[] = [];
  for (let y = box.y0; y <= box.y1; y += step) {
    for (let x = box.x0; x <= box.x1; x += step) {
      const { cellX, cellY } = cellIndex(wx(x, y), wy(x, y));
      out.push({ x, y, id: cellsAt(x, y), cellX, cellY });
    }
  }
  return out;
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

describe("the WASM cell survey agrees with the TypeScript one", () => {
  const STEP = surveyStep(175);

  it("matches id, cellX and cellY at every position of a real box", async () => {
    const e = await engine();
    const box = { x0: -1200, y0: -900, x1: 1200, y1: 900 };
    const ts = tsSweep(box, STEP);
    const wasm = wasmSweep(e, box, STEP);

    expect(wasm).toHaveLength(ts.length);
    for (let i = 0; i < ts.length; i++) {
      expect(wasm[i], `position ${String(i)}`).toEqual(ts[i]);
    }

    // Anti-vacuity: a sweep that agreed on nothing but zeros would pass every
    // assertion above. Freeze that the box carries many distinct cells and a
    // real spread of ids, so a box drifting off the interesting region fails
    // rather than silently comparing ocean.
    const cells = new Set(ts.map((p) => `${String(p.cellX)},${String(p.cellY)}`));
    expect(cells.size).toBeGreaterThan(50);
    expect(ts.filter((p) => p.id >= 0.33).length).toBeGreaterThan(100);
  }, 300000);

  it("bands without dropping, duplicating or reordering a position", async () => {
    // The band size comes from the module's own buffer, which is far larger
    // than any box a test would sweep - so a single-call sweep would never
    // exercise the loop. This shrinks the effective band by asking the engine
    // for its limit and comparing against a hand-banded reference instead.
    const e = await engine();
    const box = { x0: -400, y0: -300, x1: 400, y1: 300 };
    const whole = wasmSweep(e, box, STEP);
    const ts = tsSweep(box, STEP);
    expect(whole).toEqual(ts);

    // Sweeping the same box as two stacked halves must reproduce the whole,
    // which is what a band boundary is. Rows are the unit, so the split is on a
    // row boundary the same way the real banding splits.
    const rows = Math.floor((box.y1 - box.y0) / STEP) + 1;
    const cut = Math.floor(rows / 2);
    const top = { ...box, y1: box.y0 + (cut - 1) * STEP };
    const bottom = { ...box, y0: box.y0 + cut * STEP };
    expect([...wasmSweep(e, top, STEP), ...wasmSweep(e, bottom, STEP)]).toEqual(whole);
  }, 300000);

  it("produces an IDENTICAL island list through either path", async () => {
    // The assertion that actually matters to a user. The parity test above
    // compares raw triples; this compares what the finder builds out of them -
    // the grouping, the bounding boxes, the centroids and the point lists.
    //
    // `points` is included on purpose. It carries positions in VISIT order, so
    // a sweep that produced identical values in a different order would pass
    // every numeric check here and still change which sample becomes the
    // centroid.
    const e = await engine();
    const box = { x0: -1500, y0: -1500, x1: 1500, y1: 1500 };
    const ts = surveyIslands(CTX, box);
    const wasm = surveyIslands(CTX, box, undefined, e);

    expect(wasm).toEqual(ts);
    // Anti-vacuity: two empty lists are equal. Freeze that this box really
    // finds islands, so a box drifting into open ocean fails rather than
    // silently comparing nothing.
    expect(ts.length).toBeGreaterThan(30);
    expect(ts.reduce((n, c) => n + c.sampleCount, 0)).toBeGreaterThan(500);
  }, 300000);

  it("derives the same step from the module as from the TypeScript stack", async () => {
    // The engine path cannot call `surveyStep(stack.shared.grid)` without
    // building the stack it exists to avoid, so it asks the module. If the two
    // disagreed the sweeps would visit different points and every comparison
    // above would be grading two different questions.
    const e = await engine();
    const trig = bearingTrig(CTX.seed0);
    const fromModule = e.fulgora_survey_step(
      CTX.seed0,
      1,
      1,
      trig.sinStart,
      trig.cosStart,
      trig.sinVault,
      trig.cosVault,
    );
    const fromStack = surveyStep(makeFulgoraStack(CTX).shared.grid);
    expect(fromModule).toBe(fromStack);

    // And it MOVES with the frequency lever, so a constant cannot pass.
    const moved = e.fulgora_survey_step(
      CTX.seed0,
      3,
      1,
      trig.sinStart,
      trig.cosStart,
      trig.sinVault,
      trig.cosVault,
    );
    expect(moved).not.toBe(fromModule);
    expect(moved).toBe(surveyStep(makeFulgoraStack({ ...CTX, islandsFrequency: 3 }).shared.grid));
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
