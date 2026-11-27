import { describe, it, expect } from "vite-plus/test";
import { createRenderPool, type TilePaint } from "../src/components/renderPool";
import { planTiles } from "../src/noise/preview/tiling";
import type {
  ElevationRenderRequest,
  ElevationRenderResult,
} from "../src/noise/preview/elevationRenderRequest";

const REQ: Omit<ElevationRenderRequest, "id"> = {
  seed0: 1,
  width: 4,
  height: 4,
  originX: 0,
  originY: 0,
  tilesPerPixel: 1,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
};

/** An execute that resolves immediately with a correctly sized buffer. */
const instant = async (r: ElevationRenderRequest): Promise<ElevationRenderResult> => ({
  id: r.id,
  buffer: new ArrayBuffer(r.width * r.height * 4),
  width: r.width,
  height: r.height,
});

/** An execute whose promises are resolved by hand, one per call. */
function controlled() {
  const calls: {
    req: ElevationRenderRequest;
    slot: number;
    resolve: (r: ElevationRenderResult) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const execute = (req: ElevationRenderRequest, slot: number) =>
    new Promise<ElevationRenderResult>((resolve, reject) => {
      calls.push({ req, slot, resolve, reject });
    });
  const settle = (i: number) =>
    calls[i].resolve({
      id: calls[i].req.id,
      buffer: new ArrayBuffer(calls[i].req.width * calls[i].req.height * 4),
      width: calls[i].req.width,
      height: calls[i].req.height,
    });
  return { calls, execute, settle };
}

describe("createRenderPool", () => {
  it("executes one request per tile, carrying the tile box and the full image", async () => {
    const seen: ElevationRenderRequest[] = [];
    const pool = createRenderPool({
      size: 2,
      plan: (f) => planTiles(f, 2),
      execute: (r) => {
        seen.push(r);
        return instant(r);
      },
    });
    const painted: TilePaint[] = [];
    const ok = await pool.render(REQ, (t) => painted.push(t));

    expect(ok).toBe(true);
    expect(seen).toHaveLength(4); // 4x4 image in 2x2 tiles
    expect(painted).toHaveLength(4);
    for (const r of seen) {
      expect(r.width).toBe(2);
      expect(r.height).toBe(2);
      expect(r.fullImage).toEqual({ originX: 0, originY: 0, width: 4, height: 4 });
    }
    expect(seen.map((r) => [r.originX, r.originY])).toEqual([
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2],
    ]);
    expect(painted.map((t) => [t.dx, t.dy])).toEqual([
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2],
    ]);
  });

  it("gives every request a distinct id", async () => {
    const seen: number[] = [];
    const pool = createRenderPool({
      size: 4,
      plan: (f) => planTiles(f, 2),
      execute: (r) => {
        seen.push(r.id);
        return instant(r);
      },
    });
    await pool.render(REQ, () => {});
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("never runs more than `size` executes at once", async () => {
    const { calls, execute, settle } = controlled();
    const pool = createRenderPool({ size: 2, plan: (f) => planTiles(f, 2), execute });
    const done = pool.render(REQ, () => {});

    await Promise.resolve();
    expect(calls).toHaveLength(2); // 4 tiles, only 2 slots
    settle(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    settle(1);
    settle(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(4);
    settle(3);
    expect(await done).toBe(true);
  });

  it("dispatches each tile to the slot index it was given", async () => {
    const { calls, execute, settle } = controlled();
    const pool = createRenderPool({ size: 2, plan: (f) => planTiles(f, 2), execute });
    const done = pool.render(REQ, () => {});
    await Promise.resolve();
    expect(calls.map((c) => c.slot).sort((a, b) => a - b)).toEqual([0, 1]);
    for (let i = 0; i < 4; i++) {
      settle(i);
      await Promise.resolve();
      await Promise.resolve();
    }
    await done;
  });

  it("resolves false and stops painting when a newer render supersedes it", async () => {
    const { calls, execute, settle } = controlled();
    const pool = createRenderPool({ size: 1, plan: (f) => planTiles(f, 2), execute });
    const painted: TilePaint[] = [];
    const first = pool.render(REQ, (t) => painted.push(t));
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    // A newer render supersedes the first one before its tile lands.
    void pool.render(REQ, () => {});
    settle(0);

    expect(await first).toBe(false);
    expect(painted).toHaveLength(0);
  });

  it("rejects the whole render when a tile fails, and stops dispatching", async () => {
    const { calls, execute } = controlled();
    const pool = createRenderPool({ size: 1, plan: (f) => planTiles(f, 2), execute });
    const done = pool.render(REQ, () => {});
    await Promise.resolve();
    calls[0].reject(new Error("worker died"));
    await expect(done).rejects.toThrow("worker died");
    expect(calls).toHaveLength(1);
  });

  it("stops an in-flight render when disposed", async () => {
    const { calls, execute, settle } = controlled();
    const pool = createRenderPool({ size: 1, plan: (f) => planTiles(f, 2), execute });
    const painted: TilePaint[] = [];
    const done = pool.render(REQ, (t) => painted.push(t));
    await Promise.resolve();
    pool.dispose();
    settle(0);
    expect(await done).toBe(false);
    expect(painted).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("does not spawn more slots than there are tiles", async () => {
    const slots = new Set<number>();
    const pool = createRenderPool({
      size: 16,
      plan: (f) => planTiles(f, 4), // one tile for a 4x4 image
      execute: (r, slot) => {
        slots.add(slot);
        return instant(r);
      },
    });
    await pool.render(REQ, () => {});
    expect(slots).toEqual(new Set([0]));
  });

  it("rejects a non-positive pool size", () => {
    expect(() =>
      createRenderPool({ size: 0, plan: (f) => planTiles(f, 2), execute: instant }),
    ).toThrow(/size/);
  });
});
