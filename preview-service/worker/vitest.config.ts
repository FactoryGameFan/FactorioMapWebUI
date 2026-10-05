import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// `@cloudflare/vitest-plugin` is `@cloudflare/vitest-pool-workers` renamed at
// its 1.0 release (workers-sdk #15074), with the API unchanged. Since the
// pool-workers 0.18 line (vitest v4) it exposes a Vite plugin `cloudflareTest`
// instead of the old `defineWorkersConfig` from the `/config` subpath.
//
// Bindings are declared inline here rather than via `wrangler: { configPath }`
// so the test runtime never touches the wrangler `containers` block (which would
// try to build the Factorio Docker image). The container path is not exercised
// in unit tests; PREVIEW_CONTAINER is bound as a plain DO and never invoked.
export default defineConfig({
  // The same two leak guards the app config carries (#144). This suite's `vi.`
  // calls are the `console.error` and `console.warn` spies in worker.spec.ts,
  // and `restoreMocks` is what puts console back after each. Without it a spy
  // would silence and record every later test's log lines in the same file,
  // and the tests that count those lines would count the wrong test's.
  //
  // `unstubGlobals` is still inert here: nothing stubs a global. It is set
  // anyway because the cost is one line and the failure it prevents is silent,
  // in a suite whose specs already share a Miniflare instance. The app-side
  // pair in `test/mockLeakGuards.spec.ts` is what actually pins both flags.
  test: {
    unstubGlobals: true,
    restoreMocks: true,
  },
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
