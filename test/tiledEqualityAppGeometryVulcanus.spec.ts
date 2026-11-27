import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";
import {
  appPreviewReq,
  gradePlanInWindow,
  PLAN_WINDOW,
  POOLS,
  renderWindowWhole,
} from "./appPlanSeams";

// Vulcanus's half of the last block of `tiledEqualityAppGeometry.spec.ts`: the
// seams of the app's own tile plans (`planForPool`, one tile per worker, cut
// on chunk boundaries) stitch byte for byte. It has its own file because
// Vulcanus's `all` view costs five times any other planet's, so here it runs
// beside the other planets rather than after them.
//
// `all` is the view the app shows: the corrected terrain and the cliff,
// resource and rock overlays, each with its own seam handling (the correction
// margin, the cliff cell box, the geyser and rock sweep halos).

let engine: EngineExports;

beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

describe("the pool's own tile plans stitch at the app's 1024 geometry, Vulcanus", () => {
  it(`vulcanus all, at the plans of ${POOLS.join(" and ")} workers`, () => {
    const req = appPreviewReq("vulcanus", surfaceSeedForPlanet("vulcanus", 123456));
    const whole = renderWindowWhole(engine, req);
    for (const pool of POOLS) {
      const graded = gradePlanInWindow(engine, req, whole, pool);
      // Not vacuous: the window holds several of this plan's cuts each way.
      expect(graded.cuts.x.length, `pool of ${pool}, column cuts`).toBeGreaterThanOrEqual(3);
      expect(graded.cuts.y.length, `pool of ${pool}, row cuts`).toBe(2);
      expect(graded.differing, `pool of ${pool} in ${JSON.stringify(PLAN_WINDOW)}`).toEqual([]);
    }
  }, 300_000);
});
