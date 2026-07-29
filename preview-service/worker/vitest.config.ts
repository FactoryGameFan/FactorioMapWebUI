import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers 0.18+ (vitest v4) exposes a Vite plugin `cloudflareTest`
// instead of the old `defineWorkersConfig` from the `/config` subpath.
//
// Bindings are declared inline here rather than via `wrangler: { configPath }`
// so the test runtime never touches the wrangler `containers` block (which would
// try to build the Factorio Docker image). The container path is not exercised
// in unit tests; PREVIEW_CONTAINER is bound as a plain DO and never invoked.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          RENDER_BUDGET: { className: "RenderBudget" },
          PREVIEW_CONTAINER: { className: "PreviewContainer" },
        },
        r2Buckets: ["PREVIEW_CACHE"],
        bindings: {
          FACTORIO_VERSION: "2.1.12",
          MONTHLY_RENDER_BUDGET: "5000",
          ALLOWED_ORIGIN: "https://app.example",
        },
      },
    }),
  ],
});
