import { describe, expect, it } from "vite-plus/test";
import { floodFillFrom, landMaskFromImage } from "../src/noise/islands/islandMask";
import { FULGORA_OCEAN_RGB } from "../src/noise/preview/palette";

/** Paint an RGBA buffer from an ASCII picture: "#" land, "." shallow, "~" deep. */
function image(rows: string[]): { rgba: Uint8ClampedArray; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const land: readonly [number, number, number] = [112, 65, 50]; // fulgoran-dust
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const c =
        row[x] === "#" ? land : row[x] === "." ? FULGORA_OCEAN_RGB[0]! : FULGORA_OCEAN_RGB[1]!;
      const o = (y * w + x) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  });
  return { rgba, w, h };
}

describe("landMaskFromImage", () => {
  it("marks land 1 and both ocean colours 0", () => {
    const { rgba, w, h } = image(["#.~", "###"]);
    expect([...landMaskFromImage(rgba, w, h)]).toEqual([1, 0, 0, 1, 1, 1]);
  });
});

describe("floodFillFrom", () => {
  it("keeps only the component containing the seed", () => {
    // Two land blobs separated by an ocean column. Seeding in the left one must
    // not pick up the right one - that is the whole point: a candidate's window
    // routinely contains a neighbouring island.
    const { rgba, w, h } = image(["##.##", "##.##", "##.##"]);
    const mask = landMaskFromImage(rgba, w, h);
    const one = floodFillFrom(mask, w, h, 0, 0);
    expect([...one]).toEqual([1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0]);
  });

  it("is 4-connected, so a diagonal touch does not join two blobs", () => {
    // Diagonal adjacency is not walkable in Factorio terms and would merge
    // islands a power pole could not actually bridge.
    const { rgba, w, h } = image(["#.", ".#"]);
    const mask = landMaskFromImage(rgba, w, h);
    expect([...floodFillFrom(mask, w, h, 0, 0)]).toEqual([1, 0, 0, 0]);
  });

  it("returns an empty mask when the seed is on ocean", () => {
    const { rgba, w, h } = image(["..", ".."]);
    const mask = landMaskFromImage(rgba, w, h);
    expect([...floodFillFrom(mask, w, h, 0, 0)]).toEqual([0, 0, 0, 0]);
  });
});
