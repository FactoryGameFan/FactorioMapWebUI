import { describe, expect, it } from "vite-plus/test";

import { decideDeploy, gitIsAncestor } from "../scripts/deploy-gate";
import type { GateFacts } from "../scripts/deploy-gate";

const BASE = { fullCommit: "a".repeat(40), commit: "aaaaaaa", dirty: false };

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    live: BASE,
    runSha: "b".repeat(40),
    liveOnMain: "yes",
    liveBeforeRun: "yes",
    runBeforeLive: "yes",
    ...over,
  };
}

describe("decideDeploy", () => {
  it("deploys in the normal case", () => {
    expect(decideDeploy(facts()).action).toBe("deploy");
  });

  it("fails when the stamp could not be read", () => {
    const r = decideDeploy(facts({ live: null }));
    expect(r.action).toBe("fail");
    expect(r.lines.join("\n")).toMatch(/could not be read/i);
  });

  it("fails when the stamp has no fullCommit", () => {
    const r = decideDeploy(facts({ live: { commit: "aaaaaaa" } }));
    expect(r.action).toBe("fail");
    expect(r.lines.join("\n")).toMatch(/no commit/i);
  });

  it("fails when fullCommit is unknown", () => {
    expect(decideDeploy(facts({ live: { ...BASE, fullCommit: "unknown" } })).action).toBe("fail");
  });

  it("fails when live was deployed from a dirty tree", () => {
    const r = decideDeploy(facts({ live: { ...BASE, dirty: true } }));
    expect(r.action).toBe("fail");
    expect(r.lines.join("\n")).toMatch(/dirty/i);
    expect(r.lines.join("\n")).toMatch(/redeploy/i);
  });

  it("fails when the live commit is not on main", () => {
    const r = decideDeploy(facts({ liveOnMain: "no" }));
    expect(r.action).toBe("fail");
    expect(r.lines.join("\n")).toMatch(/not on main/i);
    expect(r.lines.join("\n")).toMatch(/dispatch/i);
  });

  it("fails when main ancestry is unknown", () => {
    expect(decideDeploy(facts({ liveOnMain: "unknown" })).action).toBe("fail");
  });

  it("skips when a newer commit is already live", () => {
    const r = decideDeploy(facts({ liveBeforeRun: "no", runBeforeLive: "yes" }));
    expect(r.action).toBe("skip");
    const text = r.lines.join("\n");
    expect(text).toContain("a".repeat(40));
    expect(text).toContain("b".repeat(40));
  });

  it("fails when the two commits cannot be ordered", () => {
    expect(decideDeploy(facts({ liveBeforeRun: "no", runBeforeLive: "no" })).action).toBe("fail");
  });

  it("deploys a redeploy of the live commit", () => {
    const sha = "a".repeat(40);
    expect(decideDeploy(facts({ runSha: sha })).action).toBe("deploy");
  });
});

describe("gitIsAncestor", () => {
  it("is yes for a commit and itself", () => {
    expect(gitIsAncestor("HEAD", "HEAD")).toBe("yes");
  });

  it("is unknown for a commit git does not have", () => {
    expect(gitIsAncestor("HEAD", "0".repeat(40))).toBe("unknown");
  });
});
