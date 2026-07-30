import { describe, expect, it } from "vite-plus/test";

import { fixImpossibleCellsSweep } from "../src/noise/cliffs/cliffPlacement";
import { isCliffPlaced } from "../src/noise/cliffs/cliffCatalog";

const W = 8;
const H = 8;
const vIndex = (cx: number, cy: number): number => cy * (W + 1) + cx;
const hIndex = (cx: number, cy: number): number => cy * W + cx;
const codeOf = (v: Int8Array, h: Int8Array, cx: number, cy: number): number =>
  ((v[vIndex(cx, cy)] & 3) << 6) |
  ((v[vIndex(cx + 1, cy)] & 3) << 4) |
  ((h[hIndex(cx, cy)] & 3) << 2) |
  (h[hIndex(cx, cy + 1)] & 3);

/**
 * `CellEdgeCliffCrossingArray::fixImpossibleCells`' **retry**, which the port did
 * not have until 2026-07-30 (issue #18).
 *
 * The `bool` parameter was read as a caller-supplied mode, and since
 * `crossingsForChunk` passes `false` an earlier note concluded the corner step
 * "never runs in this path". It does - the function sets the flag on **itself**:
 *
 * ```
 * uVar10 = param_2 & 1;  param_2 = 1;
 * if (uVar10 != 0) { log("Unable to remove excess cliff cell edge crossings"); return; }
 * goto <top of function>;
 * ```
 *
 * So on reaching a cell it cannot fix, it restarts the whole pass, this time
 * first zeroing the eight outer edges of the chunk's four corner cells; a second
 * failure abandons the chunk.
 *
 * **This spec exists because the integration fixtures barely exercise it.**
 * Measured over the committed captures, the retry fires **once in 512 chunks**
 * (one chunk of Vulcanus `[1500,1500]`; zero across both Nauvis seeds and the
 * other two Vulcanus regions) and changes no placed cell. That is a real
 * behaviour and worth having right, but it is nowhere near issue #18's residual
 * - do not read this as a fix for it. Without a direct test the branch would be
 * effectively dead code.
 */
describe("fixImpossibleCells retry", () => {
  /**
   * A corner cell whose only crossings are the two chunk-boundary edges it is
   * forbidden to clear. `L = +1`, `T = -1` gives code `0x4C`, which is not a
   * placing code; `R` and `B` are zero, so the L/T/R/B search finds nothing
   * clearable and the first pass is stuck.
   */
  const stuckCorner = (): { v: Int8Array; h: Int8Array } => {
    const v = new Int8Array((W + 1) * H);
    const h = new Int8Array(W * (H + 1));
    v[vIndex(0, 0)] = 1;
    h[hIndex(0, 0)] = -1;
    return { v, h };
  };

  it("the constructed cell really is stuck and illegal, or this spec proves nothing", () => {
    const { v, h } = stuckCorner();
    const code = codeOf(v, h, 0, 0);
    expect(code).toBe(0x4c);
    expect(isCliffPlaced(code)).toBe(false);
    // Both crossings are on the chunk boundary: L at cx 0, T at cy 0. Neither is
    // clearable, and the other two edges are already zero.
    expect(v[vIndex(1, 0)]).toBe(0);
    expect(h[hIndex(0, 1)]).toBe(0);
  });

  it("restarts and zeroes the corner cell's outer edges, making it legal", () => {
    const { v, h } = stuckCorner();
    fixImpossibleCellsSweep(v, h, W, H);
    // The retry's corner step is the only thing that can clear these two.
    expect(v[vIndex(0, 0)]).toBe(0);
    expect(h[hIndex(0, 0)]).toBe(0);
    const code = codeOf(v, h, 0, 0);
    expect(code).toBe(0);
    expect(isCliffPlaced(code) || code === 0).toBe(true);
  });

  it("leaves every cell of the chunk legal", () => {
    const { v, h } = stuckCorner();
    fixImpossibleCellsSweep(v, h, W, H);
    for (let cy = 0; cy < H; cy++)
      for (let cx = 0; cx < W; cx++) {
        const code = codeOf(v, h, cx, cy);
        expect(code === 0 || isCliffPlaced(code)).toBe(true);
      }
  });

  /**
   * The corner step must not fire when nothing is stuck - it clears eight edges
   * unconditionally, so running it on a healthy chunk would delete real cliffs.
   */
  it("does NOT touch the corner edges when the pass completes normally", () => {
    const v = new Int8Array((W + 1) * H);
    const h = new Int8Array(W * (H + 1));
    // `L = +1`, `T = +1` is code 0x44, which IS a placing code, so cell (0,0) is
    // legal as it stands and the sweep has nothing to do anywhere.
    v[vIndex(0, 0)] = 1;
    h[hIndex(0, 0)] = 1;
    expect(isCliffPlaced(codeOf(v, h, 0, 0))).toBe(true);
    fixImpossibleCellsSweep(v, h, W, H);
    expect(v[vIndex(0, 0)]).toBe(1);
    expect(h[hIndex(0, 0)]).toBe(1);
  });

  /**
   * Two stuck corners at once. The restart re-sweeps the arrays **as already
   * mutated** by the abandoned pass rather than starting from the raw crossings,
   * and one retry clears all eight corner edges, so both are fixed in the single
   * permitted restart - the second failure would abandon the chunk.
   */
  it("fixes two stuck corners in one restart", () => {
    const v = new Int8Array((W + 1) * H);
    const h = new Int8Array(W * (H + 1));
    v[vIndex(0, 0)] = 1;
    h[hIndex(0, 0)] = -1;
    v[vIndex(W, H - 1)] = 1;
    h[hIndex(W - 1, H)] = -1;
    expect(isCliffPlaced(codeOf(v, h, W - 1, H - 1))).toBe(false);
    fixImpossibleCellsSweep(v, h, W, H);
    for (let cy = 0; cy < H; cy++)
      for (let cx = 0; cx < W; cx++) {
        const code = codeOf(v, h, cx, cy);
        expect(code === 0 || isCliffPlaced(code)).toBe(true);
      }
  });
});
