import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { planForPool, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import type { EngineExports } from "../src/noise/wasm/engine";

// Shared by `tiledEqualityAppGeometry.spec.ts` and its Vulcanus twin: do the
// seams of the app's own tile plans (`planForPool`) stitch byte for byte?
//
// **A window of the preview, not the whole of it, and that is a cost decision
// that gives nothing up.** A worker tile's pixels depend only on its own box
// and on the full image its halos are clamped to (`fullImage`). So a window
// rendered whole, against the plan's tiles clipped to the window and rendered
// with the window as their full image, grades every seam inside the window
// exactly as the 1024 render would: the same cut positions, the same
// correction margins and sweep halos across them. Only the outer border
// differs, and that is the same box in both renders. The window below holds
// 3 of the 4 column cuts and both row cuts of a 15-worker plan, and both row
// cuts and all three column cuts of a 7-worker plan, at about a quarter of the
// 1024 render's cost (Vulcanus's whole `all` render is about 37 s on one
// thread).

/** The 1024 x 1024 preview at one tile per pixel, centred on the spawn. */
export const APP_PREVIEW: ImageBox = {
  originX: -512,
  originY: -512,
  width: 1024,
  height: 1024,
  tilesPerPixel: 1,
};

/**
 * The window graded, in preview pixels. x 160..704 holds a 15-worker plan's
 * cuts at 192, 416 and 608 and a 7-worker plan's at 352, 512 and 672; y
 * 256..704 holds the first's at 352 and 672 and the second's at 288 and 576.
 */
export const PLAN_WINDOW = { dx: 160, dy: 256, width: 544, height: 448 } as const;

/**
 * The pool sizes graded: the two irregular layouts. 15 is 5 x 3 tiles, 6 or 7
 * chunks wide and 10 or 11 tall; 7's rows do not hold the same number of
 * tiles, so its columns are cut in different places from row to row. Neither
 * cuts where a 128- or 256-pixel grid does, apart from 7's cut at 512 in its
 * top rows. Between them they hold every cut the common pools make: 16, 8 and
 * 4 workers cut on the 256-pixel grid (16 IS that grid), 12 at the 256-pixel
 * columns and 15's rows, and 6 at 7's bottom columns and y = 512.
 */
export const POOLS = [15, 7] as const;

/** A request for the whole app preview; the caller sets planet, seed and view. */
export function appPreviewReq(
  planet: NonNullable<ElevationRenderRequest["planet"]>,
  seed0: number,
): ElevationRenderRequest {
  return {
    id: 0,
    planet,
    seed0,
    width: APP_PREVIEW.width,
    height: APP_PREVIEW.height,
    originX: APP_PREVIEW.originX,
    originY: APP_PREVIEW.originY,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    mapType: "nauvis",
    view: "all",
  };
}

/** The result of grading one plan in the window. */
export interface PlanSeams {
  /** How many of the plan's tiles reach into the window. */
  readonly tiles: number;
  /** Interior cut positions inside the window, columns then rows, in preview pixels. */
  readonly cuts: { readonly x: number[]; readonly y: number[] };
  /** Pixels where the stitched tiles differ from the whole window, as `(x, y)` in preview pixels. */
  readonly differing: string[];
}

/**
 * Render `whole` (the window rendered as one request) against the app's plan
 * for `pool` workers, clipped to the window.
 */
export function gradePlanInWindow(
  engine: EngineExports,
  req: ElevationRenderRequest,
  whole: Uint8ClampedArray,
  pool: number,
): PlanSeams {
  const w = PLAN_WINDOW;
  const fullImage = {
    originX: req.originX + w.dx,
    originY: req.originY + w.dy,
    width: w.width,
    height: w.height,
  };
  const clipped = planForPool(APP_PREVIEW, pool).flatMap((t) => {
    const x0 = Math.max(t.dx, w.dx);
    const y0 = Math.max(t.dy, w.dy);
    const x1 = Math.min(t.dx + t.width, w.dx + w.width);
    const y1 = Math.min(t.dy + t.height, w.dy + w.height);
    return x1 > x0 && y1 > y0 ? [{ x0, y0, x1, y1 }] : [];
  });
  const tiled = stitchTiles(
    w,
    clipped.map((c) => ({
      dx: c.x0 - w.dx,
      dy: c.y0 - w.dy,
      width: c.x1 - c.x0,
      height: c.y1 - c.y0,
      data: new Uint8ClampedArray(
        runRenderRequest(
          {
            ...req,
            originX: req.originX + c.x0,
            originY: req.originY + c.y0,
            width: c.x1 - c.x0,
            height: c.y1 - c.y0,
            fullImage,
          },
          engine,
        ).buffer,
      ),
    })),
  );
  const differing: string[] = [];
  for (let i = 0; i < whole.length; i += 4) {
    if (
      whole[i] !== tiled[i] ||
      whole[i + 1] !== tiled[i + 1] ||
      whole[i + 2] !== tiled[i + 2] ||
      whole[i + 3] !== tiled[i + 3]
    ) {
      const p = i / 4;
      differing.push(`(${w.dx + (p % w.width)}, ${w.dy + Math.floor(p / w.width)})`);
    }
  }
  const interior = (v: number, lo: number, len: number) => v > lo && v < lo + len;
  return {
    tiles: clipped.length,
    cuts: {
      x: [...new Set(clipped.map((c) => c.x0))]
        .filter((x) => interior(x, w.dx, w.width))
        .sort((a, b) => a - b),
      y: [...new Set(clipped.map((c) => c.y0))]
        .filter((y) => interior(y, w.dy, w.height))
        .sort((a, b) => a - b),
    },
    differing,
  };
}

/** The window rendered as one request: the reference the clipped tiles must match. */
export function renderWindowWhole(
  engine: EngineExports,
  req: ElevationRenderRequest,
): Uint8ClampedArray {
  const w = PLAN_WINDOW;
  return new Uint8ClampedArray(
    runRenderRequest(
      {
        ...req,
        originX: req.originX + w.dx,
        originY: req.originY + w.dy,
        width: w.width,
        height: w.height,
      },
      engine,
    ).buffer,
  );
}
