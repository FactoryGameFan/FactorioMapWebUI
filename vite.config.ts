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
    // https://github.com/FactoryGameFan/FactorioMapWebUI/actions/runs/30512820959
    //
    // 30s is ~3x the slowest measured case, so it absorbs runner variance while
    // still failing a genuine hang in well under the job's 15-minute cap. It is
    // a floor, not a ceiling: the existing 120000 annotations still win where
    // they are set. Retries were deliberately NOT used - a retry would hide a
    // real flake, and nothing here is actually flaky, just slow.
    testTimeout: 30_000,
    // Both of these are leak guards, adopted in #144 against Vitest's "Writing
    // Tests with AI" guidance. Neither was set before, and `vi.unstubAllGlobals`
    // appeared nowhere in the repo.
    //
    // `unstubGlobals` closes a real leak. `vi.restoreAllMocks()` - which two
    // files already call in an `afterEach` - restores `vi.spyOn` spies and does
    // NOT undo `vi.stubGlobal`, so a stubbed global persisted into every later
    // test in the same file. `test/previewPanel.spec.ts` has two tests that stub
    // only `fetch` and were inheriting the `URL` stub from the test before them.
    //
    // **No test DEPENDED on that, and the flag was proven to work anyway** -
    // both facts measured rather than assumed, because a guard for a leak that
    // cannot be observed is indistinguishable from a no-op:
    //
    // - Turning it on changes nothing in either stubbing file (9/9 still pass),
    //   and both stub-inheriting tests also pass when run ALONE with `-t`. So
    //   the leak was present but not load-bearing.
    // - A planted probe - test A stubs `fetch`, test B asserts the global is
    //   still the stub - PASSES with the flag off and FAILS with it on. That is
    //   what establishes the flag is doing something, given the suite itself
    //   cannot tell the difference.
    //
    // Cross-FILE leakage was never possible, but only because `isolate` is on -
    // and that is load-bearing for an unrelated reason (the field DAG's memo
    // caches are module-level; see CLAUDE.md). So this was masked, not absent.
    unstubGlobals: true,
    // `restoreMocks` is the `vi.spyOn` half. Cleanup here was manual - 5 spies
    // against 5 `vi.restoreAllMocks()` calls, in only 6 `afterEach` blocks
    // across the suite - so it happened to be complete, and this keeps it that
    // way without depending on the next author remembering.
    restoreMocks: true,
  },
  // Never reformat the byte-verified spec docs or the read-only fixture
  // ground truth - `vp check --fix` would otherwise rewrite them on every run.
  fmt: {
    ignorePatterns: ["docs/**", "test/fixtures/**"],
  },
});
