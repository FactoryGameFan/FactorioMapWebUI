import { parsePreviewRequest } from "./schema";
import { cacheKey } from "./cacheKey";
export { PreviewContainer } from "./container";
export { RenderBudget } from "./budget";

// Binding types come from `wrangler types` (worker-configuration.d.ts).
type Env = Cloudflare.Env;

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

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return new Response("bad json", { status: 400, headers: corsHeaders(env) });
    }
    const parsed = parsePreviewRequest(json);
    if (!parsed.ok) return new Response(parsed.error, { status: 400, headers: corsHeaders(env) });
    const req = parsed.value;

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
      console.error(`container render failed (${renderRes.status}): ${detail.slice(0, 200)}`);
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
  },
};
