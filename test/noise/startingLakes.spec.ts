import { describe, expect, it } from "vite-plus/test";
import fixture from "../fixtures/oracle-elevation-lakes.seed123456.json";

describe("startingLakePositions (RE of MapGenSettings::getStartingLakePositions)", () => {
  it("has only 9 rows that discriminate anything - the other 17 sit at the cap", () => {
    // Worth pinning because it bounds what the test above can prove: a lake
    // placed anywhere far enough away reproduces a saturated row.
    const saturated = fixture.startingLakeDistance.filter((v) => v === 1024).length;
    expect(saturated).toBe(17);
    expect(fixture.startingLakeDistance.length - saturated).toBe(9);
  });
});
