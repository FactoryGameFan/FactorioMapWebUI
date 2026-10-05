import { getContainer } from "@cloudflare/containers";
import { parsePreviewRequest, type PreviewRequest } from "./schema";
import { cacheKey } from "./cacheKey";
export { PreviewContainer } from "./container";
export { RenderBudget } from "./budget";

// Binding types come from `wrangler types` (worker-configuration.d.ts).
type Env = Cloudflare.Env;

// A real request is about 2 KB: measured 1,902 to 2,094 bytes over the nine
// built-in presets. 64 KiB is room for any preset the app can build, and stops
// a client from making the Worker buffer a body it would only reject.
export const MAX_BODY_BYTES = 64 * 1024;

// One JSON object per line, so Workers Logs can filter on its fields.
function logError(message: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ message, ...detail }));
}

// The same shape at warn level, for a request that still succeeded but did
// something less than it should have (a render that was not cached).
function logWarn(message: string, detail: Record<string, unknown>): void {
  console.warn(JSON.stringify({ message, ...detail }));
}

// The fields of a thrown value worth a log line. Durable Object errors carry
// `retryable` and `overloaded` flags (durable-objects/best-practices/
// error-handling), which say whether the platform judged a failure transient
// or the object overloaded, so they go in when present. Only when present: an
// ordinary Error logs as exactly `{ error }`, which the 500-path test pins.
function errorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
  };
  if (error !== null && typeof error === "object") {
    const flags = error as { retryable?: unknown; overloaded?: unknown };
    if (typeof flags.retryable === "boolean") fields.retryable = flags.retryable;
    if (typeof flags.overloaded === "boolean") fields.overloaded = flags.overloaded;
  }
  return fields;
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

// Content-Length is checked first where the client sends one, but it is
// optional, so the byte count while reading is what enforces the cap.
async function readJsonBody(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "body too large" };
  }
  if (request.body === null) return { ok: false, status: 400, error: "bad json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, error: "body too large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "bad json" };
  }
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return new Response("forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/preview") {
      return new Response("not found", { status: 404 });
    }

    // An exception thrown past here would become Cloudflare's own error page,
    // which carries no CORS headers, so the app would see a CORS failure
    // instead of a status it can report. Answer 500 with the headers instead.
    // Reading the body is inside on purpose: a client that disconnects mid-
    // upload makes the stream read reject, and that must land here too.
    try {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return new Response(body.error, { status: body.status, headers: corsHeaders(env) });
      }
      const parsed = parsePreviewRequest(body.value);
      if (!parsed.ok) {
        return new Response(parsed.error, { status: 400, headers: corsHeaders(env) });
      }
      return await renderPreview(parsed.value, env);
    } catch (error) {
      logError("preview request failed", errorFields(error));
      return new Response("internal error", { status: 500, headers: corsHeaders(env) });
    }
  },
};

async function renderPreview(req: PreviewRequest, env: Env): Promise<Response> {
  const key = await cacheKey({ ...req, factorioVersion: env.FACTORIO_VERSION });
  const objectKey = `previews/${key}.png`;

  const cached = await env.PREVIEW_CACHE.get(objectKey);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000",
        ...corsHeaders(env),
      },
    });
  }

  // Cache miss: enforce budget. Called exactly once and never retried: consume()
  // increments the month's count before it answers, so a retry after a lost
  // reply would charge one render twice.
  const budget = env.RENDER_BUDGET.getByName("global");
  const decision = await budget.consume(Number(env.MONTHLY_RENDER_BUDGET));
  if (!decision.allowed) {
    return new Response("render budget exhausted", { status: 503, headers: corsHeaders(env) });
  }

  const renderRes = await fetchRender(req, env);
  if (!renderRes.ok) {
    // Drain the body before dropping this response. @cloudflare/containers
    // proxies the container through a TransformStream and decrements its
    // inflight-request counter only when that stream finishes piping. A
    // container that still looks busy never reaches `sleepAfter` (see
    // isActivityExpired in the package), so it stays provisioned - and billed
    // for its full instance_type memory - around the clock. One un-drained
    // error body pins the instance awake indefinitely.
    const detail = await renderRes.text().catch(() => "<unreadable>");
    logError("container render failed", {
      status: renderRes.status,
      detail: detail.slice(0, 200),
    });
    return new Response("render failed", { status: 502, headers: corsHeaders(env) });
  }
  const png = await renderRes.arrayBuffer();

  // Only cache a render the container says came from the Factorio this Worker
  // keys on. A deploy that moves the image activates the new Worker FIRST and
  // rolls the container out after, and until the rollout finishes "new Worker
  // code can still reach container instances on the previous image"
  // (containers/configuration/rollouts). Without this check an old-image render
  // in that window would be stored under the NEW version's key with a one-year
  // max-age, and nothing ever evicts it - the same mixed-games cache that
  // dockerfile.test.mjs guards against from the config side.
  //
  // A missing header counts as a mismatch: it means a container from before the
  // header existed, or one that could not read its own binary, and either way
  // nothing vouches for which game drew the picture. The PNG still goes back to
  // the user, uncached and marked no-store, because it is a real preview - just
  // not one to file under this key.
  const renderedWith = renderRes.headers.get("x-factorio-version");
  if (renderedWith !== env.FACTORIO_VERSION) {
    logWarn("render not cached: factorio version mismatch", {
      expected: env.FACTORIO_VERSION,
      actual: renderedWith,
    });
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": "no-store", ...corsHeaders(env) },
    });
  }

  // A failed cache write must not cost the user the render they already paid
  // a budget slot for. R2 allows one write per second to the same key and
  // answers 429 above that (r2/platform/limits), which two identical requests
  // racing past the cache miss can reach. The next miss simply renders again.
  try {
    await env.PREVIEW_CACHE.put(objectKey, png, {
      httpMetadata: { contentType: "image/png" },
    });
  } catch (error) {
    logWarn("render not cached: R2 put failed", { objectKey, ...errorFields(error) });
  }
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000",
      ...corsHeaders(env),
    },
  });
}

// At most 2 retries, so at most 3 container calls for one consumed budget slot.
const RENDER_RETRIES = 2;
const RENDER_BACKOFF_BASE_MS = 100;

// The render call, retried only when the platform says it may be. Following
// durable-objects/best-practices/error-handling:
//
// - An error with `.retryable` is a transient infrastructure failure, and a
//   render is safe to repeat - same request, same game, same PNG - so it is
//   retried with exponential backoff and full jitter.
// - An error with `.overloaded` is never retried, even if it is also marked
//   retryable: retrying "will worsen the overload and increase the overall
//   error rate". With max_instances at 1 there is only this one container to
//   overload.
// - Anything else is not ours to second-guess and is thrown on the first try.
//
// A fresh stub per attempt, because the same page warns that many exceptions
// leave a stub "broken", failing every later call with the original error.
//
// This retries a THROWN error only. A container that answers 500 has rendered
// and failed, deterministically, so that response goes back to the caller as
// before and is not repeated.
async function fetchRender(req: PreviewRequest, env: Env): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // "pool-0" is the instance every deploy so far has used. getContainer's own
    // default name is "cf-singleton-container", which would address a new
    // Durable Object and orphan the existing one, so the name stays explicit.
    const container = getContainer(env.PREVIEW_CONTAINER, "pool-0");
    try {
      return await container.fetch(
        new Request("https://container/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    } catch (error) {
      const flags = (error ?? {}) as { retryable?: unknown; overloaded?: unknown };
      if (flags.retryable !== true || flags.overloaded === true || attempt >= RENDER_RETRIES) {
        throw error;
      }
      const delayMs = Math.round(RENDER_BACKOFF_BASE_MS * 2 ** attempt * Math.random());
      logWarn("container call failed, retrying", {
        attempt: attempt + 1,
        delayMs,
        ...errorFields(error),
      });
      await scheduler.wait(delayMs);
    }
  }
}
