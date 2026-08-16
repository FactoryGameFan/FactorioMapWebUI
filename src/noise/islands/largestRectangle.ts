/**
 * Largest axis-aligned all-land rectangle in a binary mask.
 *
 * Axis-aligned is not an approximation of a better answer - Factorio builds on
 * an axis-aligned grid, so a rotated rectangle would be the wrong shape even if
 * it were larger.
 *
 * Method: treat each row as the base of a histogram whose bar heights are the
 * runs of land ending at that row, then sweep each histogram with a monotonic
 * stack. O(width * height) overall, one pass per row.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function largestRectangle(mask: Uint8Array, width: number, height: number): Rect {
  if (width <= 0 || height <= 0) return EMPTY;

  const heights = new Int32Array(width);
  // `stack` holds column indices whose bar heights are strictly increasing.
  const stack = new Int32Array(width + 1);
  let best = EMPTY;
  let bestArea = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      heights[x] = mask[y * width + x] ? (heights[x] as number) + 1 : 0;
    }

    let top = 0;
    for (let x = 0; x <= width; x++) {
      // A sentinel height of 0 past the right edge flushes the whole stack.
      const hx = x === width ? 0 : (heights[x] as number);
      while (top > 0 && (heights[stack[top - 1] as number] as number) >= hx) {
        const barTop = stack[--top] as number;
        const h = heights[barTop] as number;
        // Left edge: one past the bar still on the stack, or 0 if none.
        const left = top === 0 ? 0 : (stack[top - 1] as number) + 1;
        const w = x - left;
        const area = w * h;
        if (area > bestArea) {
          bestArea = area;
          best = { x: left, y: y - h + 1, width: w, height: h };
        }
      }
      stack[top++] = x;
    }
  }

  return best;
}
