import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RenderBudget } from "../src/budget";

describe("RenderBudget", () => {
  it("allows up to the cap then denies within the same month", async () => {
    const id = env.RENDER_BUDGET.idFromName("test");
    const stub = env.RENDER_BUDGET.get(id);
    await runInDurableObject(stub, async (instance: RenderBudget) => {
      let last;
      for (let i = 0; i < 3; i++) last = await instance.consume(3);
      expect(last).toEqual({ allowed: true, used: 3 });
      expect(await instance.consume(3)).toEqual({ allowed: false, used: 3 });
    });
  });
});
