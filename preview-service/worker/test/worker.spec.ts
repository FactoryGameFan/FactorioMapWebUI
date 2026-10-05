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

const PNG = [0x89, 0x50, 0x4e, 0x47];

function pngResponse(version: string | null): Response {
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (version !== null) headers["x-factorio-version"] = version;
  return new Response(new Uint8Array(PNG), { headers });
}

async function objectKeyFor(req: typeof body): Promise<string> {
  const { previewObjectKey } = await import("../src/cacheKey");
  return previewObjectKey(req, env.FACTORIO_VERSION);
}

// A Durable Object infrastructure error: an Error with the flags
// durable-objects/best-practices/error-handling describes.
function doError(message: string, flags: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error(message), flags);
}

// The real env with PREVIEW_CONTAINER swapped for a fake namespace of the same
// shape the drain test uses, idFromName then get. Counts container calls and
// stubs handed out, so tests can see retries and that each attempt asked for a
// fresh stub.
function withContainer(fetch: () => Promise<Response>) {
  let calls = 0;
  let stubs = 0;
  const fakeEnv = {
    ...env,
    PREVIEW_CONTAINER: {
      idFromName: () => "pool-0",
      get: () => {
        stubs++;
        return {
          fetch: () => {
            calls++;
            return fetch();
          },
        };
      },
    },
  } as unknown as typeof env;
  return { fakeEnv, calls: () => calls, stubs: () => stubs };
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
    await env.PREVIEW_CACHE.put(await objectKeyFor(body), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

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

  it("never serves a render cached under the key from before the version guard", async () => {
    // That key had no cache generation in it, and a render stored under it may
    // have come from the previous image during a rollout. Seed one, holding
    // bytes the container would never send, and check a request renders afresh.
    const { cacheKey } = await import("../src/cacheKey");
    const req = { ...body, seed: 31337 };
    const preGuardKey = `previews/${await cacheKey({ ...req, factorioVersion: env.FACTORIO_VERSION })}.png`;
    expect(preGuardKey).not.toBe(await objectKeyFor(req));
    await env.PREVIEW_CACHE.put(preGuardKey, new Uint8Array([0x00, 0x0d, 0x0e, 0x0a]));
    const { fakeEnv, calls } = withContainer(async () => pngResponse(env.FACTORIO_VERSION));

    const ctx = createExecutionContext();
    const res = await worker.fetch(post(req), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG);
    expect(await env.PREVIEW_CACHE.head(await objectKeyFor(req))).not.toBeNull();
  });

  it("caches a render whose Factorio version matches, typed as a PNG", async () => {
    const { fakeEnv, calls } = withContainer(async () => pngResponse(env.FACTORIO_VERSION));
    const req = { ...body, seed: 24680 };

    const ctx = createExecutionContext();
    const res = await worker.fetch(post(req), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG);
    expect(calls()).toBe(1);
    const stored = await env.PREVIEW_CACHE.get(await objectKeyFor(req));
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
  });

  it.each([
    ["a different version", "0.0.1"],
    ["no version header", null],
  ])("returns but does not cache a render with %s", async (_label, version) => {
    // During a container rollout the new Worker can reach an old-image
    // instance. Its render is a real preview, so the user gets it, but filing
    // it under this Worker's FACTORIO_VERSION would keep the old game's
    // picture in the cache for a year. A missing header is treated the same:
    // nothing vouches for which game drew it.
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fakeEnv } = withContainer(async () => pngResponse(version));
    const req = { ...body, seed: version === null ? 11111 : 22222 };

    const ctx = createExecutionContext();
    const res = await worker.fetch(post(req), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG);
    expect(await env.PREVIEW_CACHE.head(await objectKeyFor(req))).toBeNull();
    expect(warns).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warns.mock.calls[0]?.[0]))).toEqual({
      message: "render not cached: factorio version mismatch",
      expected: env.FACTORIO_VERSION,
      actual: version,
    });
  });

  it("still returns the render when the cache write fails", async () => {
    // R2 allows one write per second to a key and answers 429 above it. The
    // render already happened and already cost a budget slot, so a failed
    // write must cost the user nothing but the cache entry.
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fakeEnv } = withContainer(async () => pngResponse(env.FACTORIO_VERSION));
    const failingEnv = {
      ...fakeEnv,
      PREVIEW_CACHE: {
        get: async () => null,
        put: async () => {
          throw new Error("429 rate limited");
        },
      },
    } as unknown as typeof env;

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 33333 }), failingEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG);
    expect(warns).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warns.mock.calls[0]?.[0]))).toMatchObject({
      message: "render not cached: R2 put failed",
      error: "429 rate limited",
    });
  });

  it("retries a container call that failed with a retryable error", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const { fakeEnv, calls, stubs } = withContainer(async () => {
      if (n++ === 0) throw doError("transient", { retryable: true });
      return pngResponse(env.FACTORIO_VERSION);
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 44444 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(PNG);
    expect(calls()).toBe(2);
    // A stub can be left broken by the error it threw, so each try gets a new one.
    expect(stubs()).toBe(2);
    expect(warns).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warns.mock.calls[0]?.[0]))).toMatchObject({
      message: "container call failed, retrying",
      attempt: 1,
      error: "transient",
      retryable: true,
    });
  });

  it("gives up after two retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fakeEnv, calls } = withContainer(async () => {
      throw doError("still down", { retryable: true });
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 55555 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    expect(calls()).toBe(3);
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      message: "preview request failed",
      error: "still down",
      retryable: true,
    });
  });

  it("never retries an overloaded Durable Object, even one marked retryable", async () => {
    // error-handling.mdx: retrying an overloaded object "will worsen the
    // overload". Both flags are set here so the test fails if the overloaded
    // check is dropped or ordered after the retryable one.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fakeEnv, calls } = withContainer(async () => {
      throw doError("overloaded", { retryable: true, overloaded: true });
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 66666 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(calls()).toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      message: "preview request failed",
      error: "overloaded",
      retryable: true,
      overloaded: true,
    });
  });

  it("does not retry an error that is not marked retryable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fakeEnv, calls } = withContainer(async () => {
      throw new Error("bad request object");
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(post({ ...body, seed: 77777 }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    expect(calls()).toBe(1);
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
