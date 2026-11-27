import { describe, it, expect, vi } from "vite-plus/test";
import {
  createElevationRenderer,
  defaultPoolSize,
  type WorkerLike,
} from "../src/components/useElevationPreview";
import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { planTiles } from "../src/noise/preview/tiling";

function fakeWorker(): WorkerLike & { posted: ElevationRenderRequest[] } {
  return {
    posted: [],
    postMessage(m: unknown) {
      this.posted.push(m as ElevationRenderRequest);
    },
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  };
}

const REQ = {
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

/** Answer every request a worker has been posted, in order. */
function drain(w: WorkerLike & { posted: ElevationRenderRequest[] }) {
  for (const req of w.posted.splice(0)) {
    w.onmessage!({
      data: {
        id: req.id,
        buffer: new ArrayBuffer(req.width * req.height * 4),
        width: req.width,
        height: req.height,
      },
    } as MessageEvent);
  }
}

/** A renderer whose workers are all fakes, plus the list of workers made. */
function setup(size: number, tileSize: number) {
  const workers: (WorkerLike & { posted: ElevationRenderRequest[] })[] = [];
  const renderer = createElevationRenderer(
    () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    },
    size,
    (full) => planTiles(full, tileSize),
  );
  return { workers, renderer };
}

describe("createElevationRenderer", () => {
  it("spreads tiles across one worker per slot and paints each one", async () => {
    const { workers, renderer } = setup(2, 2); // 4 tiles for a 4x4 image
    const painted: { dx: number; dy: number }[] = [];
    const done = renderer.render(REQ, (t) => painted.push({ dx: t.dx, dy: t.dy }));

    // Two slots start immediately, so exactly two workers exist.
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    for (let i = 0; i < 4; i++) {
      workers.forEach(drain);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await done).toBe(true);
    expect(painted).toHaveLength(4);
    expect(workers).toHaveLength(2); // reused, not recreated per tile
  });

  it("reuses its workers across successive renders", async () => {
    const { workers, renderer } = setup(1, 4); // one tile
    for (let n = 0; n < 3; n++) {
      const done = renderer.render(REQ, () => {});
      await Promise.resolve();
      workers.forEach(drain);
      expect(await done).toBe(true);
    }
    expect(workers).toHaveLength(1);
  });

  // Regression test for a hang found in review: with one pending entry per slot,
  // a second render overwrote the first render's resolver, so the first render's
  // promise never settled and the panel would stick on "Rendering..." forever.
  it("settles a superseded render instead of stranding it", async () => {
    const { workers, renderer } = setup(1, 4); // one tile per render
    const first = renderer.render(REQ, () => {});
    await Promise.resolve();
    const firstPosted = workers[0].posted.splice(0);
    expect(firstPosted).toHaveLength(1);

    // Supersede before the first tile comes back.
    const second = renderer.render(REQ, () => {});
    await Promise.resolve();

    // Now answer both, oldest first, exactly as a real worker would.
    for (const req of [...firstPosted, ...workers[0].posted.splice(0)]) {
      workers[0].onmessage!({
        data: {
          id: req.id,
          buffer: new ArrayBuffer(req.width * req.height * 4),
          width: req.width,
          height: req.height,
        },
      } as MessageEvent);
    }

    expect(await first).toBe(false); // superseded, painted nothing
    expect(await second).toBe(true);
  });

  it("rejects the render when a worker errors", async () => {
    const { workers, renderer } = setup(1, 4);
    const done = renderer.render(REQ, () => {});
    await Promise.resolve();
    workers[0].onerror!(new Error("boom"));
    await expect(done).rejects.toThrow(/worker/i);
  });

  it("replaces a crashed worker on the next render", async () => {
    const { workers, renderer } = setup(1, 4);
    const first = renderer.render(REQ, () => {});
    await Promise.resolve();
    workers[0].onerror!(new Error("boom"));
    await expect(first).rejects.toThrow();
    expect(workers[0].terminate).toHaveBeenCalled();

    const second = renderer.render(REQ, () => {});
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    drain(workers[1]);
    expect(await second).toBe(true);
  });

  it("terminates every worker on dispose and rejects the in-flight render", async () => {
    const { workers, renderer } = setup(2, 2);
    const done = renderer.render(REQ, () => {});
    await Promise.resolve();
    renderer.dispose();
    // A terminated worker will never answer, so the in-flight tile's promise
    // must be rejected or the render would hang forever.
    await expect(done).rejects.toThrow(/disposed/);
    for (const w of workers) expect(w.terminate).toHaveBeenCalled();
  });
});

describe("defaultPoolSize", () => {
  it("leaves one core for the main thread", () => {
    expect(defaultPoolSize(12)).toBe(11);
    expect(defaultPoolSize(1)).toBe(1);
    // Unknown core count falls back to 4 cores, so 3 workers.
    expect(defaultPoolSize(undefined)).toBe(3);
  });
});
