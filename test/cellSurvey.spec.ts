import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { surveyIslands, surveyStep } from "../src/noise/islands/cellSurvey";
import { surveyCellsThroughWasm } from "../src/noise/islands/surveyThroughWasm";
import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";

const SEED0 = 2967702466; // Fulgora's surface seed for map seed 123456
const BOX = { x0: -2000, y0: -2000, x1: 2000, y1: 2000 };
const CTX = { seed0: SEED0 };

/** The engine, compiled once for the file. The survey has no other path since #371. */
let engine: EngineExports;
beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

/**
 * The `cells` value at one world position, read through the same export the
 * survey sweeps with - a one-position box. This replaces the
 * `makeFulgoraStack(...).cells` read the test below used to make.
 */
function cellIdAt(x: number, y: number): number {
  let id = Number.NaN;
  surveyCellsThroughWasm(engine, CTX, { x0: x, y0: y, x1: x, y1: y }, 1, (_x, _y, v) => {
    id = v;
  });
  return id;
}

describe("surveyStep", () => {
  it("is grid/8, so a cell gets many samples across even at the smallest grid", () => {
    expect(surveyStep(175)).toBeCloseTo(21.875, 6);
    expect(surveyStep(125)).toBeCloseTo(15.625, 6);
  });
});

describe("surveyIslands", () => {
  it("reports only non-ocean cells, and each candidate's id really is >= 0.33", () => {
    const found = surveyIslands(CTX, BOX, engine);
    expect(found.length).toBeGreaterThan(10);
    for (const c of found) {
      expect(c.id).toBeGreaterThanOrEqual(0.33);
      // The centroid is inside the box and reads the same id the survey recorded.
      expect(cellIdAt(c.centroidX, c.centroidY)).toBeCloseTo(c.id, 6);
    }
  }, 120000);

  it("gives every candidate a distinct integer cell index", () => {
    const found = surveyIslands(CTX, BOX, engine);
    const keys = new Set(found.map((c) => `${c.cellX},${c.cellY}`));
    expect(keys.size).toBe(found.length);
  }, 120000);

  it("classifies by id exactly as the Lua thresholds do", () => {
    for (const c of surveyIslands(CTX, BOX, engine)) {
      if (c.id > 0.75) expect(c.klass).toBe("mesa");
      else if (c.id > 0.5) expect(c.klass).toBe("sprawl");
      else expect(c.klass).toBe("vault");
    }
  }, 120000);

  it("bounding boxes contain their centroids", () => {
    for (const c of surveyIslands(CTX, BOX, engine)) {
      expect(c.centroidX).toBeGreaterThanOrEqual(c.minX);
      expect(c.centroidX).toBeLessThanOrEqual(c.maxX);
      expect(c.centroidY).toBeGreaterThanOrEqual(c.minY);
      expect(c.centroidY).toBeLessThanOrEqual(c.maxY);
    }
  }, 120000);

  it("A COARSER STEP MISSES ISLANDS THE SPECIFIED STEP FINDS", () => {
    // This is the test that makes `surveyStep` load-bearing rather than
    // decorative. If a future change to the step derivation makes this pass
    // trivially - both sides finding the same set - the guard is dead.
    const proper = surveyIslands(CTX, BOX, engine);
    const coarse = surveyIslands(CTX, BOX, engine, 175);
    const properKeys = new Set(proper.map((c) => `${c.cellX},${c.cellY}`));
    const coarseKeys = new Set(coarse.map((c) => `${c.cellX},${c.cellY}`));
    const missed = [...properKeys].filter((k) => !coarseKeys.has(k));
    expect(missed.length).toBeGreaterThan(0);
  }, 120000);
});
