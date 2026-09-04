import { describe, expect, it } from "vite-plus/test";
import {
  CLIFF_MAP_COLOR,
  VULCANUS_CLIFF_BLOCKING_TILES,
  getModifiedElevationInterval,
  getModifiedRichness,
  isCliffPlaced,
  sliderToLinear,
} from "../src/noise/cliffs/cliffCatalog";

describe("cliff catalog math", () => {
  // slider_to_linear(1) = midpoint; (6) = hi; (1/6) = lo (log2(6)/log2(6)=1, log2(1/6)/log2(6)=-1)
  it("sliderToLinear anchors", () => {
    expect(sliderToLinear(1, -1, 1)).toBeCloseTo(0, 12);
    expect(sliderToLinear(6, -1, 1)).toBeCloseTo(1, 12);
    expect(sliderToLinear(1 / 6, -1, 1)).toBeCloseTo(-1, 12);
    expect(sliderToLinear(1, -1.7, 1.7)).toBeCloseTo(0, 12);
  });
  // interval = base/frequency; richness = base*continuity; both identity at slider 1
  it("lever modifiers", () => {
    expect(getModifiedElevationInterval(40, 1)).toBeCloseTo(40, 12);
    expect(getModifiedElevationInterval(40, 2)).toBeCloseTo(20, 12); // higher freq -> tighter bands
    expect(getModifiedRichness(1, 1)).toBeCloseTo(1, 12);
    expect(getModifiedRichness(1, 0)).toBe(0); // continuity 0 -> cliff_richness 0 (cliffs disabled)
  });
  it("map color drift guard", () => expect([...CLIFF_MAP_COLOR]).toEqual([144, 119, 87]));
});

describe("cliff orientation predicate", () => {
  it("empty cell places nothing", () => expect(isCliffPlaced(0)).toBe(false));
  it("table covers all 256 codes", () => {
    for (let c = 0; c < 256; c++) expect(typeof isCliffPlaced(c)).toBe("boolean");
    // out-of-range guards to false rather than throwing
    expect(isCliffPlaced(256)).toBe(false);
    expect(isCliffPlaced(-1)).toBe(false);
  });
  // A clean straight wall: Top and Bottom both cross the SAME sign (a wall spanning
  // the cell top-to-bottom). code 5 = (enc(+1)<<2)|enc(+1) = (1<<2)|1 -> confirmed
  // placing in the disassembled toMaybeCliffOrientation table (0x1016067a0).
  it("a straight-wall code places", () => expect(isCliffPlaced(5)).toBe(true));
  // Exactly 20 of the 256 codes map to a real orientation (ground truth from the binary).
  it("has the extracted 20 placing codes", () => {
    const placing = [];
    for (let c = 0; c < 256; c++) if (isCliffPlaced(c)) placing.push(c);
    expect(placing).toEqual([
      1, 3, 4, 5, 12, 15, 16, 17, 28, 48, 51, 52, 64, 67, 68, 80, 192, 193, 204, 240,
    ]);
  });
});

// #360 deleted the block in cliffOreDirection.spec.ts that pinned this literal.
// The set survives and two specs still read it, so the value is re-pinned here.
// The Rust holds the same pair inlined twice, at
// `crates/fmw-noise/src/cliffs/vulcanus_fields.rs:218` and `fixtures.rs`.
describe("VULCANUS_CLIFF_BLOCKING_TILES", () => {
  it("is exactly the two lava tiles", () => {
    expect([...VULCANUS_CLIFF_BLOCKING_TILES].sort()).toEqual(["lava", "lava-hot"]);
  });
});
