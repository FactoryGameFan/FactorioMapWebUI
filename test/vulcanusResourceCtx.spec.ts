import { describe, expect, it } from "vite-plus/test";

import { withCtxDefaults } from "../src/noise/eval/ctx";

describe("EvalCtx vulcanusResourceControls", () => {
  it("defaults every Vulcanus resource lever to the neutral 1", () => {
    const ctx = withCtxDefaults({ seed0: 1 });
    expect(ctx.vulcanusResourceControls).toEqual({
      tungstenOre: { frequency: 1, size: 1 },
      vulcanusCoal: { frequency: 1, size: 1 },
      calcite: { frequency: 1, size: 1 },
      sulfuricAcidGeyser: { frequency: 1, size: 1 },
    });
  });

  it("honors an explicit override without mutating the shared default", () => {
    const ctx = withCtxDefaults({
      seed0: 1,
      vulcanusResourceControls: {
        tungstenOre: { frequency: 2, size: 3 },
        vulcanusCoal: { frequency: 1, size: 1 },
        calcite: { frequency: 1, size: 1 },
        sulfuricAcidGeyser: { frequency: 1, size: 1 },
      },
    });
    expect(ctx.vulcanusResourceControls.tungstenOre).toEqual({ frequency: 2, size: 3 });
    expect(withCtxDefaults({ seed0: 1 }).vulcanusResourceControls.tungstenOre).toEqual({
      frequency: 1,
      size: 1,
    });
  });
});
