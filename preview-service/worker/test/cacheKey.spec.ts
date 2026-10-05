import { describe, it, expect } from "vitest";
import { canonicalJson, cacheKey, previewObjectKey } from "../src/cacheKey";

describe("canonicalJson", () => {
  it("sorts object keys recursively so order does not affect output", () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 3 } });
    const b = canonicalJson({ a: { x: 3, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":3,"y":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("cacheKey", () => {
  it("is stable across key order and differs on value change", async () => {
    const k1 = await cacheKey({ planet: "nauvis", seed: 1 });
    const k2 = await cacheKey({ seed: 1, planet: "nauvis" });
    const k3 = await cacheKey({ planet: "nauvis", seed: 2 });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("previewObjectKey", () => {
  it("changes with the Factorio version and is an R2 path", async () => {
    const req = { planet: "nauvis", seed: 1 };
    const a = await previewObjectKey(req, "2.1.17");
    const b = await previewObjectKey(req, "2.1.18");
    expect(a).toMatch(/^previews\/[0-9a-f]{64}\.png$/);
    expect(a).not.toBe(b);
  });
});
