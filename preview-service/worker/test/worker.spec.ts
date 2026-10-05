import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { MAX_BODY_BYTES } from "../src/index";

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

  it("rejects a body whose declared length is over the cap with 413", async () => {
    const req = new Request("https://svc.example/preview", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
  });

  it("counts bytes when no Content-Length is sent", async () => {
    // A streamed body carries no Content-Length, so only the running count
    // can stop it.
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) controller.close();
        else {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const req = new Request("https://svc.example/preview", { method: "POST", body: stream });
    expect(req.headers.get("content-length")).toBeNull();

    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
  });

  it("answers a body stream that errors mid-read with 500 and CORS headers", async () => {
    // A client that disconnects mid-upload makes the read reject. That has to
    // reach the same boundary as a render failure, not escape without CORS.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"planet":'));
        else controller.error(new Error("client went away"));
      },
    });
    const req = new Request("https://svc.example/preview", { method: "POST", body: stream });

    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({
      message: "preview request failed",
    });
  });

  it("answers an unexpected failure with 500 and CORS headers, and logs it", async () => {
    // Without the catch this throw becomes Cloudflare's error page, which has
    // no CORS headers, so the app reports a CORS failure instead of a status.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeEnv = {
      ...env,
      PREVIEW_CACHE: {
        get: async () => {
          throw new Error("R2 unavailable");
        },
      },
    } as unknown as typeof env;

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 13579 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      message: "preview request failed",
      error: "R2 unavailable",
    });
  });

  it("rejects disallowed origins", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(post(body, "https://evil.example"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });
});
