import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { describe, expect, it } from "vite-plus/test";

import App from "../src/App.vue";

import {
  BUILD_INFO_DEFINE,
  buildStampDefine,
  buildStampJson,
  buildStampPlugin,
  computeBuildInfo,
  formatStamp,
  readGitState,
  UNKNOWN_COMMIT,
  VERSION_JSON_FILE,
  type BuildInfo,
} from "../scripts/buildStamp";
import { compareBuild } from "../scripts/verify-deploy";
import { BUILD_INFO } from "../src/model/buildStamp";

const repoRoot = join(import.meta.dirname, "..");
const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const CLEAN: BuildInfo = {
  commit: "abc1234",
  fullCommit: "abc1234000000000000000000000000000000000",
  dirty: false,
  builtAt: "2026-07-29T00:00:00.000Z",
  stamp: "abc1234",
};

/**
 * Pins the build stamp the same way `factorioTarget.spec.ts` pins the advertised
 * Factorio version: by asserting the displayed value is DERIVED from ground
 * truth rather than trusting anyone to keep a constant current.
 *
 * The failure mode being guarded against is specific. A build id that is wrong -
 * stale, hardcoded, or computed twice from two places that drifted - is worse
 * than having none, because the whole point of it is to be believed when it says
 * "this commit is live".
 */
describe("build stamp", () => {
  it("reflects the real git HEAD", () => {
    const info = computeBuildInfo();
    expect(info.fullCommit).toBe(git(["rev-parse", "HEAD"]));
    expect(info.commit).toBe(git(["rev-parse", "--short", "HEAD"]));
    expect(info.fullCommit.startsWith(info.commit)).toBe(true);
    expect(info.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("reports dirty exactly when the tree has uncommitted changes", () => {
    const porcelain = git(["status", "--porcelain"]);
    expect(readGitState().dirty).toBe(porcelain.length > 0);
  });

  it("marks a dirty build explicitly and a clean one not at all", () => {
    // A deploy from a dirty tree is precisely when the SHA alone misleads, so
    // the marker is load-bearing, not cosmetic.
    expect(formatStamp("abc1234", true)).toBe("abc1234-dirty");
    expect(formatStamp("abc1234", false)).toBe("abc1234");
    expect(computeBuildInfo({ commit: "abc1234", fullCommit: "abc", dirty: true }).stamp).toBe(
      "abc1234-dirty",
    );
  });

  it("degrades to a named unknown rather than inventing a commit", () => {
    const info = computeBuildInfo({
      commit: UNKNOWN_COMMIT,
      fullCommit: UNKNOWN_COMMIT,
      dirty: false,
    });
    expect(info.stamp).toBe(UNKNOWN_COMMIT);
  });

  it("emits /version.json and the footer define from ONE object", () => {
    // The core invariant. Two independently computed stamps that can disagree
    // would be worse than no stamp: you would not know which to believe. So the
    // define the UI reads and the JSON the deploy check fetches are asserted to
    // parse to the identical object.
    const plugin = buildStampPlugin(CLEAN);

    const configHook = plugin.config as unknown as () => { define: Record<string, string> };
    const define = configHook().define;
    expect(Object.keys(define)).toEqual([BUILD_INFO_DEFINE]);

    interface Emitted {
      type: string;
      fileName: string;
      source: string;
    }
    const emitted: Emitted[] = [];
    const generateBundle = plugin.generateBundle as unknown as (this: {
      emitFile: (a: Emitted) => void;
    }) => void;
    generateBundle.call({ emitFile: (a) => emitted.push(a) });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe(VERSION_JSON_FILE);

    // `define` values are pasted as source, hence the outer JSON layer.
    const fromDefine: unknown = JSON.parse(JSON.parse(define[BUILD_INFO_DEFINE]) as string);
    const fromJson: unknown = JSON.parse(emitted[0].source);
    expect(fromDefine).toEqual(fromJson);
    expect(fromDefine).toEqual(CLEAN);
  });

  it("hands the app the same stamp the build computed", () => {
    // `src/model/buildStamp.ts` is a reader over the injected define. If the
    // plugin ever stops being wired into vite.config.ts, this drops to
    // "unknown" and fails here rather than shipping a blank footer.
    expect(BUILD_INFO.commit).toBe(git(["rev-parse", "--short", "HEAD"]));
    expect(BUILD_INFO.stamp).toBe(formatStamp(BUILD_INFO.commit, BUILD_INFO.dirty));
  });

  it("shows the stamp in the titlebar beside the Factorio target", () => {
    // The titlebar renders on every tab (App v-ifs only the tab bodies), so this
    // is not one-tab scoped.
    const w = mount(App, { global: { plugins: [createPinia()] } });
    const el = w.find('[data-test="build-stamp"]');
    expect(el.exists()).toBe(true);
    expect(el.text()).toBe(`build ${BUILD_INFO.stamp}`);
    expect(el.attributes("title")).toContain(BUILD_INFO.stamp);
  });

  it("round-trips the JSON body", () => {
    expect(JSON.parse(buildStampJson(CLEAN))).toEqual(CLEAN);
    expect(buildStampJson(CLEAN).endsWith("\n")).toBe(true);
    expect(buildStampDefine(CLEAN)[BUILD_INFO_DEFINE]).toContain("abc1234");
  });
});

/**
 * The half of the feature that can be proven without a deploy: that the
 * comparison DISCRIMINATES. A check that has never been observed to fail is not
 * known to be a check at all.
 */
describe("verify:deploy comparison", () => {
  const local: BuildInfo = { ...CLEAN, commit: "1111111", fullCommit: "1111111aaaa" };

  it("passes when the live commit is local HEAD", () => {
    const v = compareBuild({ ...local }, local);
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toContain("1111111");
  });

  it("FAILS when the live commit is a different commit", () => {
    const v = compareBuild({ commit: "2222222", stamp: "2222222", dirty: false }, local);
    expect(v.ok).toBe(false);
    // The message must name both sides. "mismatch" alone leaves you no wiser
    // about whether the deploy is old, or shipped from the wrong branch.
    const text = v.lines.join("\n");
    expect(text).toContain("2222222");
    expect(text).toContain("1111111");
  });

  it("FAILS loudly when the live JSON has no commit at all", () => {
    const v = compareBuild({}, local);
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toContain("(missing)");
  });

  it("passes but warns when the live build came from a dirty tree", () => {
    const v = compareBuild({ ...local, dirty: true, stamp: "1111111-dirty" }, local);
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toContain("DIRTY");
  });

  it("does not fail merely because the LOCAL tree is dirty", () => {
    // Editing a file after deploying is normal; it must not read as "the
    // deploy did not land".
    const v = compareBuild({ ...local }, { ...local, dirty: true, stamp: "1111111-dirty" });
    expect(v.ok).toBe(true);
  });
});

describe("version.json cache headers", () => {
  const headers = readFileSync(join(repoRoot, "public", "_headers"), "utf8");

  it("is served no-store, because a cached copy answers about the previous deploy", () => {
    const rule = headers.split(/^\/version\.json$/m)[1];
    expect(rule, "public/_headers has no /version.json rule").toBeDefined();
    expect(rule).toMatch(/Cache-Control:\s*no-store/);
  });

  /**
   * The `script-src` directive, as a list of whole tokens.
   *
   * Whole tokens, not a substring search, and that distinction is the reason
   * this helper exists. `'wasm-unsafe-eval'` CONTAINS the string
   * `unsafe-eval`, so the guard this replaced - `expect(policy).not.toContain(
   * "unsafe-eval")` - could not tell the dangerous token from the narrow one.
   * It would have failed the moment #222 landed, for the wrong reason.
   *
   * Read off the POLICY line only. The surrounding comments discuss both tokens
   * at length, so a search over the whole file would be a test of the prose.
   */
  const scriptSrcTokens = (): string[] => {
    const policy = headers
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .find((l) => l.includes("Content-Security-Policy:"));
    expect(policy, "public/_headers has no Content-Security-Policy line").toBeDefined();
    const directive = policy
      ?.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(directive, "the policy has no script-src directive").toBeDefined();
    return (directive ?? "").split(/\s+/).slice(1);
  };

  it("still has no 'unsafe-eval' in script-src", () => {
    // Guard, not decoration: unsafe-eval was deliberately removed (3770a32) and
    // must not come back through an unrelated edit to this file. Nothing the app
    // bundles uses `eval` at all.
    expect(scriptSrcTokens()).not.toContain("'unsafe-eval'");
  });

  it("DOES have 'wasm-unsafe-eval', which the noise engine needs to start", () => {
    // The other half of the same guard, and it is not symmetry for its own sake
    // (#222). Dropping this token does not loosen the policy, it BREAKS the app:
    // `WebAssembly.compile` throws a CSP error and `src/noise/wasm/engine.wasm`
    // never runs. That failure would arrive as "the preview is broken in
    // production", which is not how anyone would search for a CSP problem.
    expect(scriptSrcTokens()).toContain("'wasm-unsafe-eval'");
  });

  it("distinguishes the two tokens by whole-token comparison, not by substring", () => {
    // The assertion that makes the two above non-vacuous, because they can BOTH
    // be satisfied by a broken reading. `'wasm-unsafe-eval'` contains the string
    // `unsafe-eval`, so a substring guard would report the current, correct
    // policy as having unsafe-eval. This pins that the tokeniser sees them apart.
    const tokens = scriptSrcTokens();
    expect(tokens).toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-eval'");
    // And the substring reading, spelled out, so the difference is executable
    // rather than asserted in a comment.
    expect(tokens.join(" ")).toContain("unsafe-eval");
  });
});
