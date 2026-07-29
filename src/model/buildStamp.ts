/**
 * The build stamp, as the app sees it.
 *
 * This is a READER, not a source. The value is computed once at build time by
 * `scripts/buildStamp.ts` and pasted in as the `__BUILD_INFO__` define; the very
 * same object is written to `/version.json`. Do not compute anything here - the
 * footer and the machine-readable artifact agreeing is the whole point, and two
 * places that both "know" the commit is two places that can disagree.
 *
 * See `scripts/buildStamp.ts` for why the stamp exists at all.
 */

// Type-only import: erased at compile time, so `src/` gains no runtime
// dependency on the build scripts. Sharing the interface is deliberate - it is
// the same object, so it should be the same type.
import type { BuildInfo } from "../../scripts/buildStamp.ts";

export type { BuildInfo };

/**
 * Replaced wholesale by the `fmw:build-stamp` plugin. The `typeof` guard covers
 * the one case where it is not - a consumer that loads these modules without the
 * plugin's config hook - so the UI degrades to "unknown" rather than throwing.
 */
declare const __BUILD_INFO__: string;

const UNKNOWN: BuildInfo = {
  commit: "unknown",
  fullCommit: "unknown",
  dirty: false,
  builtAt: "",
  stamp: "unknown",
};

function read(): BuildInfo {
  if (typeof __BUILD_INFO__ !== "string") return UNKNOWN;
  try {
    return JSON.parse(__BUILD_INFO__) as BuildInfo;
  } catch {
    return UNKNOWN;
  }
}

export const BUILD_INFO: BuildInfo = read();

/** `<short sha>` or `<short sha>-dirty` - what the titlebar shows. */
export const BUILD_STAMP: string = BUILD_INFO.stamp;
