/**
 * Answers "did my deploy actually land?" deterministically.
 *
 * Fetches the live `/version.json` with caching bypassed and compares its commit
 * against the local `HEAD`. Exit 0 = the site is running this commit; exit 1 =
 * it is not (and says which commit it IS running); exit 2 = the check could not
 * be made at all, which is NOT a pass.
 *
 * Run it with:
 *
 *   pnpm run verify:deploy                       # against map.factorygamefan.com
 *   pnpm run verify:deploy http://localhost:5173 # against `vp dev`
 *
 * Why not grep the bundle: the previous method was curling the site and grepping
 * for the hashed `index-<hash>.js` name, or for a version string - and a version
 * string that the minifier turned into a numeric array grepped as ABSENT, making
 * a shipped fix look missing. A JSON file with a stamp in it cannot be minified
 * out from under the check.
 *
 * Node runs this `.ts` directly (type stripping); there is deliberately no
 * compile step and no `tsc` involved - see CLAUDE.md.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeBuildInfo, VERSION_JSON_FILE } from "./buildStamp.ts";
import type { BuildInfo } from "./buildStamp.ts";

/** Where the app is deployed. Overridable by argv or `FMW_DEPLOY_URL`. */
export const DEFAULT_SITE = "https://map.factorygamefan.com";

export interface Verdict {
  ok: boolean;
  lines: string[];
}

/**
 * Compares live against local.
 *
 * The verdict turns on the COMMIT, not the whole stamp: a locally dirty tree is
 * normal (you edited something after deploying) and must not fail the check.
 * A live stamp that is dirty is a different matter - the SHA then does not fully
 * describe what is running - so it is reported loudly but still passes, because
 * the deploy did land.
 */
export function compareBuild(live: Partial<BuildInfo>, local: BuildInfo): Verdict {
  const liveCommit = live.commit ?? "(missing)";
  const lines = [
    `  live:  ${live.stamp ?? "(missing)"}${live.builtAt ? `  built ${live.builtAt}` : ""}`,
    `  local: ${local.stamp}  (HEAD ${local.fullCommit})`,
  ];
  if (liveCommit !== local.commit) {
    return {
      ok: false,
      lines: [
        `MISMATCH: the live site is NOT running your local HEAD.`,
        ...lines,
        `  live is at commit ${liveCommit}, local HEAD is ${local.commit}.`,
        `  Either the deploy did not land, or it shipped a different commit.`,
      ],
    };
  }
  const out = [`OK: the live site is running local HEAD (${local.commit}).`, ...lines];
  if (live.dirty) {
    out.push(
      `  WARNING: it was deployed from a DIRTY tree, so commit ${liveCommit}`,
      `  does not fully describe what is live.`,
    );
  }
  if (local.dirty) {
    out.push(`  Note: your local tree is dirty; only HEAD was compared.`);
  }
  return { ok: true, lines: out };
}

/** Fetches `/version.json` with every cache layer told to stay out of the way. */
export async function fetchLiveBuild(site: string): Promise<Partial<BuildInfo>> {
  const url = new URL(VERSION_JSON_FILE, site.endsWith("/") ? site : site + "/");
  // Belt and braces: `cache: no-store` covers the runtime's own cache, the
  // headers cover intermediaries, and the unique query string defeats anything
  // that ignores both (Cloudflare's edge cache keys on the full URL).
  url.searchParams.set("_cachebust", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url.href} -> HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as Partial<BuildInfo>;
  } catch {
    throw new Error(`GET ${url.href} did not return JSON. First 200 bytes:\n${text.slice(0, 200)}`);
  }
}

async function main(): Promise<number> {
  const site = process.argv[2] ?? process.env.FMW_DEPLOY_URL ?? DEFAULT_SITE;
  const local = computeBuildInfo();
  if (local.commit === "unknown") {
    console.error(`Cannot read local git HEAD, so there is nothing to compare against.`);
    return 2;
  }
  console.log(`Checking ${site}/${VERSION_JSON_FILE} against local HEAD ...`);
  let live: Partial<BuildInfo>;
  try {
    live = await fetchLiveBuild(site);
  } catch (err) {
    console.error(`Could not read the live build stamp - this is NOT a pass.`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      `  If the site is up but has no /version.json, it predates the build stamp:`,
      `deploy once more and re-run.`,
    );
    return 2;
  }
  const verdict = compareBuild(live, local);
  for (const line of verdict.lines) (verdict.ok ? console.log : console.error)(line);
  return verdict.ok ? 0 : 1;
}

// Only run when executed directly - `test/buildStamp.spec.ts` imports
// `compareBuild` from here and must not trigger a network call.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
