/**
 * The build stamp: one value, computed once per build, that answers "which
 * commit is this?" for both a human looking at the UI and a script checking the
 * deploy.
 *
 * **Why this exists.** Confirming a deploy landed used to mean curling the site
 * and grepping for the hashed `index-<hash>.js` filename, then eyeballing it
 * against what the build printed. That is fragile in a way that bites: grepping
 * the live bundle for a version string produced a false NEGATIVE once, because
 * the minifier had turned the string into a numeric array, so a shipped fix
 * looked missing.
 *
 * **Why it is derived, never hand-written.** Same reason as
 * `src/model/factorioTarget.ts`: a constant somebody has to remember to update
 * is a constant that rots, and a stale build stamp is worse than none - it
 * would confidently assert the wrong commit is live. Everything here comes from
 * `git` at build time.
 *
 * **Why one module feeds both consumers.** The footer and `/version.json` are
 * emitted from a SINGLE `BuildInfo` object by `buildStampPlugin` below. Two
 * independently computed stamps could disagree, and a disagreement between the
 * thing you look at and the thing you check would be the worst possible
 * outcome - you would trust the wrong one. `test/buildStamp.spec.ts` pins that
 * the injected define and the emitted JSON parse to the same object.
 */

import { execFileSync } from "node:child_process";
import type { Plugin } from "vite-plus";

/** Path (relative to the site root) of the machine-readable stamp. */
export const VERSION_JSON_FILE = "version.json";

/** The compile-time global the app reads the stamp from. */
export const BUILD_INFO_DEFINE = "__BUILD_INFO__";

/** Stand-in commit id when git cannot be consulted (tarball, no git installed). */
export const UNKNOWN_COMMIT = "unknown";

export interface BuildInfo {
  /** Short commit SHA of `HEAD`, or `"unknown"` if git could not be read. */
  commit: string;
  /** Full 40-char commit SHA, or `"unknown"`. */
  fullCommit: string;
  /** True when the tree had uncommitted changes at build time. */
  dirty: boolean;
  /** ISO-8601 UTC instant the build ran. */
  builtAt: string;
  /** Display form: `<commit>` or `<commit>-dirty`. */
  stamp: string;
}

/**
 * `<short sha>` plus an explicit `-dirty` marker.
 *
 * The marker is not decoration. A deploy from a dirty tree is exactly the case
 * where the commit SHA alone LIES about what is running, so the one thing the
 * stamp must never do is quietly present it as a clean build of that commit.
 */
export function formatStamp(commit: string, dirty: boolean): string {
  return dirty ? `${commit}-dirty` : commit;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Reads git for the current commit and whether the tree is dirty. */
export function readGitState(): { commit: string; fullCommit: string; dirty: boolean } {
  const fullCommit = git(["rev-parse", "HEAD"]);
  if (fullCommit === null) {
    return { commit: UNKNOWN_COMMIT, fullCommit: UNKNOWN_COMMIT, dirty: false };
  }
  const short = git(["rev-parse", "--short", "HEAD"]) ?? fullCommit.slice(0, 7);
  // `--porcelain` is empty exactly when nothing is staged, modified or
  // untracked. A null here means the status call failed while rev-parse
  // succeeded, which should not happen; treat it as dirty rather than claim
  // clean, because a false "clean" is the claim that misleads.
  const status = git(["status", "--porcelain"]);
  return { commit: short, fullCommit, dirty: status === null || status.length > 0 };
}

/** Builds the stamp for right now. `state`/`now` are injectable for tests. */
export function computeBuildInfo(state = readGitState(), now: Date = new Date()): BuildInfo {
  return {
    commit: state.commit,
    fullCommit: state.fullCommit,
    dirty: state.dirty,
    builtAt: now.toISOString(),
    stamp: formatStamp(state.commit, state.dirty),
  };
}

/** The `define` map the app's `__BUILD_INFO__` global is replaced with. */
export function buildStampDefine(info: BuildInfo): Record<string, string> {
  // Double-encoded on purpose: `define` values are pasted as SOURCE, so the
  // literal that lands in the bundle has to be a quoted JSON string.
  return { [BUILD_INFO_DEFINE]: JSON.stringify(JSON.stringify(info)) };
}

/** The body of `/version.json`. */
export function buildStampJson(info: BuildInfo): string {
  return JSON.stringify(info, null, 2) + "\n";
}

/**
 * Injects the stamp into the app and emits `/version.json` from the same
 * `BuildInfo`.
 *
 * The dev-server middleware exists so `/version.json` is not a build-only
 * artifact that first gets exercised in production - `pnpm verify:deploy
 * http://localhost:5173` works against `vp dev`.
 */
export function buildStampPlugin(info: BuildInfo = computeBuildInfo()): Plugin {
  return {
    name: "fmw:build-stamp",
    config() {
      return { define: buildStampDefine(info) };
    },
    configureServer(server) {
      server.middlewares.use(`/${VERSION_JSON_FILE}`, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(buildStampJson(info));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: VERSION_JSON_FILE,
        source: buildStampJson(info),
      });
    },
  };
}
