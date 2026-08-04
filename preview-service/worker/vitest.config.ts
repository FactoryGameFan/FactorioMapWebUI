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
  // The same two leak guards the app config carries (#144). **Inert here today,
  // and that is measured, not assumed: this suite contains zero `vi.` calls of
  // any kind** - no mocks, no spies, no stubbed globals - so neither flag can
  // change a result, and no test would notice if they were deleted.
  //
  // They are set anyway because the cost is two lines and the failure they
  // prevent is silent: the first worker test to reach for `vi.spyOn` or
  // `vi.stubGlobal` would otherwise leak into the tests after it, in a suite
  // whose specs already share a Miniflare instance. Do NOT read them as guards
  // that are doing work - the app-side pair in `test/mockLeakGuards.spec.ts` is
  // what actually pins the behaviour, and there is deliberately no equivalent
  // here, because a guard asserting a mock is cleaned up would be this suite's
  // only use of mocks.
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
