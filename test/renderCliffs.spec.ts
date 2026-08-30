import { describe, expect, it } from "vite-plus/test";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";

describe("renderCliffs", () => {
  it("map color drift guard", () => expect([...CLIFF_MAP_COLOR]).toEqual([144, 119, 87]));
});
