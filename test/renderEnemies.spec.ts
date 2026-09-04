import { describe, expect, it } from "vite-plus/test";
import { ENEMY_MAP_COLOR } from "../src/noise/enemies/enemyCatalog";

/** An `w`x`h` ImageData pre-filled with `color`. */

describe("renderEnemies", () => {
  it("map color drift guard", () => expect([...ENEMY_MAP_COLOR]).toEqual([255, 26, 26]));
});
