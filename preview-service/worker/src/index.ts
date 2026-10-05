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
      logError("preview request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
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

  // Cache miss: enforce budget.
  const budgetId = env.RENDER_BUDGET.idFromName("global");
  const budget = env.RENDER_BUDGET.get(budgetId) as unknown as {
    consume(cap: number): Promise<{ allowed: boolean }>;
  };
  const decision = await budget.consume(Number(env.MONTHLY_RENDER_BUDGET));
  if (!decision.allowed) {
    return new Response("render budget exhausted", { status: 503, headers: corsHeaders(env) });
  }

  // Render via the container.
  const container = env.PREVIEW_CONTAINER.get(
    env.PREVIEW_CONTAINER.idFromName("pool-0"),
  ) as unknown as {
    fetch(req: Request): Promise<Response>;
  };
  const renderRes = await container.fetch(
    new Request("https://container/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    }),
  );
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
  await env.PREVIEW_CACHE.put(objectKey, png);
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000",
      ...corsHeaders(env),
    },
  });
}
