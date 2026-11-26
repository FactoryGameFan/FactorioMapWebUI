import { describe, it, expect } from "vite-plus/test";
import { parsePreviewRequest } from "../src/schema";

const valid = {
  mapGenSettings: { width: 0, height: 0 },
  planet: "vulcanus",
  seed: 123456,
  size: 1024,
};

describe("parsePreviewRequest", () => {
  it("accepts a well-formed request", () => {
    const r = parsePreviewRequest(valid);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown planet", () => {
    const r = parsePreviewRequest({ ...valid, planet: "mars" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("planet") });
  });

  it("rejects a non-integer or out-of-range seed", () => {
    expect(parsePreviewRequest({ ...valid, seed: -1 }).ok).toBe(false);
    expect(parsePreviewRequest({ ...valid, seed: 1.5 }).ok).toBe(false);
  });

  it("rejects a wrong size", () => {
    expect(parsePreviewRequest({ ...valid, size: 4096 }).ok).toBe(false);
  });

  it("rejects a non-object mapGenSettings", () => {
    expect(parsePreviewRequest({ ...valid, mapGenSettings: "x" }).ok).toBe(false);
  });
});
