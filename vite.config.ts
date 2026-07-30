import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite-plus";

import { buildStampPlugin } from "./scripts/buildStamp.ts";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // `vue()` is cast to vite-plus's own `Plugin` type deliberately. Under vp
  // 0.2.6's tsgolint-7 type-check engine, `@vitejs/plugin-vue`'s return type
  // (which references its own bundled Vite's `Plugin`) makes the whole config
  // object exceed TypeScript's comparison-depth limit against `UserConfig`,
  // producing a spurious `TS2321: Excessive stack depth`. Casting the plugin
  // to the `Plugin` type vite-plus already expects collapses that comparison
  // without suppressing type-checking of the rest of the config. See
  // https://github.com/voidzero-dev/vite-plus/issues/2010 (comment thread).
  // `buildStampPlugin` computes the git-derived build stamp ONCE and feeds both
  // consumers from it: the `__BUILD_INFO__` define the titlebar reads, and the
  // emitted `/version.json` that `pnpm run verify:deploy` fetches. Keep it a
  // single plugin instance for exactly that reason - see scripts/buildStamp.ts.
  plugins: [vue() as Plugin, buildStampPlugin()],
  // NOTE: there are deliberately NO build log suppressions here, and a clean
  // `vp build` is the baseline - anything it prints is new and worth reading.
  // Two used to live in `build.rollupOptions.onLog`, both for `zlib-asm`: an
  // `[EVAL]` filter (dropped when `patches/zlib-asm.patch` removed the three
  // Emscripten `eval` sites) and an `fs`/`path` browser-externalization filter
  // for its Node fallback imports. `zlib-asm` was replaced by `pako`, which is
  // plain ESM with no `eval` and no Node builtins, so neither warning can fire
  // any more. Verified by removing the filter: the build still prints nothing.
  // A direct `eval` or an externalized builtin appearing anywhere must surface;
  // do not add a suppression back.
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // `expect(mock.terminate).toHaveBeenCalled()` reads a method without
        // calling it, which is exactly the shape `unbound-method` flags - but
        // passing the reference to `expect` is the point, not a `this` bug.
        files: ["test/**/*.spec.ts"],
        rules: {
          "typescript/unbound-method": "off",
        },
      },
    ],
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    // App tests live in `test/`. Exclude `preview-service/**`, which has its own
    // Worker (pool-workers) and container (node:test) runners.
    include: ["test/**/*.spec.ts"],
    // Vitest's 5s default is too tight for THIS suite, and that is not a new
    // observation - 24 individual tests across 10 files already carry an
    // explicit `}, 120000)` argument, which is the same statement made 24 times
    // by hand. The tests that need it are the ones that render whole preview
    // windows pixel-by-pixel and compare them against captured game output;
    // being slow is what they are for, and there is nothing to optimise away.
    //
    // Raising the DEFAULT rather than adding a 25th annotation, because the
    // annotation approach fails in a specific way: it depends on the author of
    // the next heavy test remembering, and the symptom of forgetting is a
    // timeout that reads like a hang. `test/elevationRenderRequest.spec.ts` has
    // 27 tests and zero annotations; on a 4-core GitHub runner (~3x slower than
    // a dev machine: 230s vs 71s for the same suite) its `view 'all' composites
    // all five overlays` case needs 9.8s and failed the very first CI run.
    // https://github.com/wormeyman/FactorioMapWebUI/actions/runs/30512820959
    //
    // 30s is ~3x the slowest measured case, so it absorbs runner variance while
    // still failing a genuine hang in well under the job's 15-minute cap. It is
    // a floor, not a ceiling: the existing 120000 annotations still win where
    // they are set. Retries were deliberately NOT used - a retry would hide a
    // real flake, and nothing here is actually flaky, just slow.
    testTimeout: 30_000,
  },
  // Never reformat the byte-verified spec docs or the read-only fixture
  // ground truth - `vp check --fix` would otherwise rewrite them on every run.
  fmt: {
    ignorePatterns: ["docs/**", "test/fixtures/**"],
  },
});
