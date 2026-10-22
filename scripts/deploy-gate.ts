/**
 * The gate the CI deploy job runs just before `wrangler deploy`.
 *
 * It compares the commit that is live (from `/version.json`) with the commit
 * this run is about to ship, and answers one of three things:
 *
 *   deploy - the live commit is an ancestor of this run's commit (or the same
 *            commit), so shipping this run moves the site forward.
 *   skip   - this run's commit is an ancestor of the live one. A newer commit
 *            is already live, so an older run must not roll the site back.
 *   fail   - the stamp is unreadable, was built from a dirty tree, is not on
 *            `main`, or the two commits cannot be ordered. Guessing here could
 *            ship the wrong build, so the job stops and a person looks.
 *
 * Why "not on main" fails: this repo squash-merges, so a deploy made from a
 * feature branch leaves a commit live that `main` will never contain (#434's
 * `7711ad8` was one). Ancestry checks against such a commit say nothing useful,
 * so the fix is a human redeploying `main` with the dispatch button.
 *
 * Runs only in CI. `gitIsAncestor` needs the full history and `origin/main`
 * fetched, which a default shallow checkout does not give.
 *
 * Node runs this `.ts` directly (type stripping); there is no compile step.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildInfo } from "./buildStamp.ts";
import { DEFAULT_SITE, fetchLiveBuild } from "./verify-deploy.ts";

export type Ancestry = "yes" | "no" | "unknown";

export interface GateFacts {
  /** The live stamp, or null when it could not be fetched or parsed. */
  live: Partial<BuildInfo> | null;
  /** The commit this run would deploy. */
  runSha: string;
  /** Is the live commit an ancestor of `origin/main`? */
  liveOnMain: Ancestry;
  /** Is the live commit an ancestor of (or equal to) this run's commit? */
  liveBeforeRun: Ancestry;
  /** Is this run's commit an ancestor of (or equal to) the live commit? */
  runBeforeLive: Ancestry;
}

export type GateAction = "deploy" | "skip" | "fail";

/** First matching row wins. See the header for what each action means. */
export function decideDeploy(f: GateFacts): { action: GateAction; lines: string[] } {
  if (f.live === null) {
    return { action: "fail", lines: ["The live build stamp could not be read."] };
  }
  const liveSha = f.live.fullCommit;
  if (!liveSha || liveSha === "unknown") {
    return { action: "fail", lines: ["There is no commit in the live build stamp."] };
  }
  if (f.live.dirty === true) {
    return {
      action: "fail",
      lines: [
        `Live (${liveSha}) was deployed from a dirty tree, so that commit does not describe what is running.`,
        "Redeploy main with the dispatch button.",
      ],
    };
  }
  if (f.liveOnMain !== "yes") {
    return {
      action: "fail",
      lines: [
        `The live commit ${liveSha} is not on main (ancestry: ${f.liveOnMain}).`,
        "Redeploy main with the dispatch button.",
      ],
    };
  }
  if (f.liveBeforeRun === "yes") {
    return { action: "deploy", lines: [`Live ${liveSha} is behind ${f.runSha}; deploying.`] };
  }
  if (f.runBeforeLive === "yes") {
    return {
      action: "skip",
      lines: [`A newer commit is already live: live ${liveSha} is ahead of this run ${f.runSha}.`],
    };
  }
  return {
    action: "fail",
    lines: [`Cannot order live ${liveSha} and this run ${f.runSha}.`],
  };
}

/** Wraps `git merge-base --is-ancestor`: exit 0 is yes, 1 is no, anything else is unknown. */
export function gitIsAncestor(a: string, b: string): Ancestry {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return "yes";
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return status === 1 ? "no" : "unknown";
  }
}

async function main(): Promise<number> {
  const runSha = process.env.GITHUB_SHA;
  if (!runSha) {
    console.error("::error::GITHUB_SHA is not set.");
    return 1;
  }
  const site = process.env.FMW_DEPLOY_URL ?? DEFAULT_SITE;
  let live: Partial<BuildInfo> | null;
  try {
    live = await fetchLiveBuild(site);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    live = null;
  }
  const liveSha = live?.fullCommit;
  const known = typeof liveSha === "string" && liveSha !== "unknown";
  const verdict = decideDeploy({
    live,
    runSha,
    liveOnMain: known ? gitIsAncestor(liveSha, "origin/main") : "unknown",
    liveBeforeRun: known ? gitIsAncestor(liveSha, runSha) : "unknown",
    runBeforeLive: known ? gitIsAncestor(runSha, liveSha) : "unknown",
  });
  const text = verdict.lines.join(" ");
  if (verdict.action === "fail") {
    console.error(`::error::${text}`);
    return 1;
  }
  if (verdict.action === "skip") console.log(`::warning::${text}`);
  else console.log(text);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `action=${verdict.action}\n`);
  }
  return 0;
}

// Only run when executed directly - the spec imports `decideDeploy` from here.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
