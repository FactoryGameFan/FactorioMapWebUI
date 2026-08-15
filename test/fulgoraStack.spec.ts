import { describe, expect, it } from "vite-plus/test";

import {
  makeFulgoraStack,
  makeFulgoraTileResolver,
  makeFulgoraTileResolverFrom,
} from "../src/noise/tiles/fulgoraCatalog";

/**
 * The shared stack must be a pure refactor. `memoXY` is a SINGLE-ENTRY cache, so
 * a second private copy of the DAG shares nothing and pays for the whole tree
 * again - which is the only reason this exists. If it ever changes a resolved
 * tile, it is a bug, not an optimisation.
 */
describe("the shared Fulgora stack resolves deterministically", () => {
  it("agrees on every tile of a 256x256-tile block (stride 4) spanning the coastline", () => {
    const ctx = { seed0: 123456 };
    const priv = makeFulgoraTileResolver(ctx);
    const shared = makeFulgoraTileResolverFrom(makeFulgoraStack(ctx));
    let checked = 0;
    for (let y = 1000 - 128; y < 1000 + 128; y += 4) {
      for (let x = -1500 - 128; x < -1500 + 128; x += 4) {
        expect(shared(x, y)).toBe(priv(x, y));
        checked++;
      }
    }
    // Non-vacuity: the block must contain BOTH land and ocean, or agreeing on
    // it proves nothing about the land argmax.
    const names = new Set<string>();
    for (let y = 1000 - 128; y < 1000 + 128; y += 4)
      for (let x = -1500 - 128; x < -1500 + 128; x += 4) names.add(shared(x, y));
    expect(checked).toBe(64 * 64);
    expect(names.has("shallow") || names.has("deep")).toBe(true);
    expect([...names].some((n) => n.startsWith("fulgoran-"))).toBe(true);
  });
});
