/**
 * Stage 2a: turn a rendered Fulgora terrain image into ONE island's land mask.
 *
 * Membership is decided by a flood fill from the candidate's centroid, not by
 * re-evaluating which Voronoi cell each pixel belongs to. Two reasons, and the
 * second is the important one:
 *
 * 1. Cost. Re-evaluating `cells` per pixel would add about 2.33 us to every
 *    pixel of every candidate, on the main thread.
 * 2. Correctness. An island is a connected land region, which is what a player
 *    can actually walk and build across. If two neighbouring cells' land
 *    touches, that IS one island, and a per-cell test would wrongly split it.
 */
import { FULGORA_OCEAN_RGB } from "../preview/renderFulgoraTerrain";

/** 1 where the pixel is any land tile, 0 where it is either ocean colour. */
export function landMaskFromImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const r = rgba[o] as number;
    const g = rgba[o + 1] as number;
    const b = rgba[o + 2] as number;
    let ocean = false;
    for (const c of FULGORA_OCEAN_RGB) {
      if (r === c[0] && g === c[1] && b === c[2]) {
        ocean = true;
        break;
      }
    }
    mask[i] = ocean ? 0 : 1;
  }
  return mask;
}

/**
 * The 4-connected land component containing `(seedX, seedY)`, as a new mask.
 *
 * 4-connected rather than 8: a diagonal touch is not walkable, and treating it
 * as connected would merge two islands that nothing can actually bridge.
 */
export function floodFillFrom(
  mask: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return out;
  const start = seedY * width + seedX;
  if (!mask[start]) return out;

  // An explicit stack, not recursion: a large island would blow the call stack.
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = start;
  out[start] = 1;

  while (top > 0) {
    const i = stack[--top] as number;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0 && mask[i - 1] && !out[i - 1]) {
      out[i - 1] = 1;
      stack[top++] = i - 1;
    }
    if (x < width - 1 && mask[i + 1] && !out[i + 1]) {
      out[i + 1] = 1;
      stack[top++] = i + 1;
    }
    if (y > 0 && mask[i - width] && !out[i - width]) {
      out[i - width] = 1;
      stack[top++] = i - width;
    }
    if (y < height - 1 && mask[i + width] && !out[i + width]) {
      out[i + width] = 1;
      stack[top++] = i + width;
    }
  }
  return out;
}
