import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const body = {
  mapGenSettings: { width: 0, height: 0, seed: 123456 },
  planet: "nauvis",
  seed: 123456,
  size: 1024,
};

function post(b: unknown, origin = "https://app.example") {
  return new Request("https://svc.example/preview", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(b),
  });
}

describe("worker /preview", () => {
  it("rejects invalid bodies with 400", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, planet: "mars" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("returns a cached PNG without invoking the container", async () => {
    // Seed the cache directly so no container is needed in the test env.
    const { cacheKey } = await import("../src/cacheKey");
    const key = await cacheKey({ ...body, factorioVersion: env.FACTORIO_VERSION });
    await env.PREVIEW_CACHE.put(`previews/${key}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const ctx = createExecutionContext();
    const res = await worker.fetch(post(body), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
  });

  it("drains the container response body when a render fails", async () => {
    // Regression guard for a cost bug, not a correctness one: the response is
    // discarded either way. @cloudflare/containers only decrements its
    // inflight-request counter when the proxied body finishes streaming, and a
    // container with a nonzero counter never reaches `sleepAfter`. Dropping one
    // error body left a 4 GiB instance provisioned 24/7 on ~7 requests/day,
    // which is where the bill went. Assert the body is consumed.
    const failing = new Response("boom", { status: 500 });
    const fakeEnv = {
      ...env,
      PREVIEW_CONTAINER: {
        idFromName: () => "pool-0",
        get: () => ({ fetch: async () => failing }),
      },
    } as unknown as typeof env;

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 987654 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    expect(failing.bodyUsed).toBe(true);
  });

  it("rejects disallowed origins", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post(body, "https://evil.example"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });
});
