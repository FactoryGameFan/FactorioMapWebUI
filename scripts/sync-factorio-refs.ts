/**
 * Report which Factorio reference material is readable at the installed
 * binary's version, and where it lives.
 *
 * ## This used to PIN things, and deliberately no longer does
 *
 * The 254-line shell version this replaces made local state match a version:
 * it ran `git checkout <tag>` inside `~/GitHub/factorio-data` and it downloaded
 * and extracted ~290 MB of API docs into `factorioLuaAPI/`. Both are gone,
 * because `factorio-oracle` reads the same material at a version WITHOUT
 * mutating anything, and the mutation was the risk rather than the feature:
 *
 *  - **The clone is shared by four repos.** Pinning its HEAD to whatever THIS
 *    repo's binary reports is a race with every other consumer, and the symptom
 *    is a correct-looking answer read out of the wrong version. CLAUDE.md calls
 *    version skew "a real, silent hazard, not a formality", and a shared
 *    checkout is how it gets in. `refs grep` and `refs show` move no HEAD.
 *  - **`factorioLuaAPI/` was a duplicate of the installed game.** Measured: the
 *    game ships `factorio.app/Contents/doc-html`, 330 MB, containing every entry
 *    point CLAUDE.md names - `auxiliary/noise-expressions.html`,
 *    `types/MapGenSettings.html`, `runtime-api.json` and the rest, including
 *    `control:temperature:frequency`, which is in the HTML and nowhere in the
 *    JSON. So the download re-fetched over the network what was already on disk.
 *  - **The old script could not answer the version-skew question at all.**
 *    `factorio-oracle refs grep --tag 2.0.77 --tag 2.1.14 <pattern>` prints both
 *    versions side by side, tagged, in one call. Pinning can only ever show you
 *    one version at a time, which is precisely the wrong shape for the question
 *    this repo keeps having to ask.
 *
 * It also drops two things the shell version needed and TypeScript does not: a
 * regex over `base/info.json` standing in for a JSON parser, and 32 lines of
 * Python in a heredoc doing the fixture report. CLAUDE.md names both shapes as
 * the point where a shell script should have become a program.
 *
 * ## Usage
 *
 *   pnpm refs:sync              report against the installed binary's version
 *   pnpm refs:sync 2.1.11       report against an explicit version instead
 *   pnpm refs:sync --check      same, but exit 1 if the version is unreadable
 *   pnpm refs:sync --fixtures   which fixtures predate the installed binary
 *
 * The binary stays the authority for which version is meant. It is the one
 * piece Steam updates without asking, so it decides and everything else is read
 * to match - asking for "latest" instead would race that updater.
 *
 * Exit 0 = reported (the default and `--fixtures` always exit 0, because
 * deciding whether a version gap matters needs a human); 1 = `--check` and the
 * version cannot be read; 2 = the environment cannot answer at all, which is
 * not a pass.
 *
 * Overrides: `FACTORIO_BIN`, `FACTORIO_DATA_DIR`, `FACTORIO_ORACLE_BIN`.
 *
 * Node runs this `.ts` directly (type stripping); there is deliberately no
 * compile step - see CLAUDE.md.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `~/.cargo/bin` is on no PATH in this environment, which is why CLAUDE.md
 * always spells the oracle out in full. Checked in order; the env override wins
 * so a contributor with a different cargo home is not stuck.
 */
export function oracleCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.FACTORIO_ORACLE_BIN;
  const cargoHome = env.CARGO_HOME ?? join(homedir(), ".cargo");
  return [
    ...(explicit ? [explicit] : []),
    join(cargoHome, "bin", "factorio-oracle"),
    "factorio-oracle",
  ];
}

/**
 * The first candidate that answers `--version`. Probing by RUNNING it rather
 * than with `existsSync` alone, for the reason the repo already learned about
 * `cargo-deny`: a path test can disagree with whether the thing actually runs,
 * and the failure mode is a script that reports success having done nothing.
 */
export function findOracle(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of oracleCandidates(env)) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export interface Install {
  readonly version: string;
  readonly binary: string;
  readonly docDir?: string;
}

/** Parse `factorio-oracle installs list` output. Real JSON, not a regex. */
export function parseInstalls(stdout: string): Install[] {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || !("installs" in parsed)) {
    throw new Error("installs list did not return an { installs: [...] } object");
  }
  const list = (parsed as { installs: unknown }).installs;
  if (!Array.isArray(list)) throw new Error("installs list did not return an array");
  return list as Install[];
}

/**
 * Which install to believe when several are present. `FACTORIO_BIN` names one
 * explicitly; otherwise the first discovered wins, which matches the old
 * script's behaviour and the oracle's own ordering.
 *
 * Returning null rather than throwing: "no Factorio here" is a normal state for
 * this repo - `verify` must pass on a machine with none - so the caller decides
 * whether it is fatal.
 */
export function pickInstall(
  installs: readonly Install[],
  env: NodeJS.ProcessEnv = process.env,
): Install | null {
  if (installs.length === 0) return null;
  const wanted = env.FACTORIO_BIN;
  if (wanted !== undefined && wanted !== "") {
    const match = installs.find(
      (i) => i.binary === wanted || resolve(i.binary) === resolve(wanted),
    );
    return match ?? null;
  }
  return installs[0];
}

export interface Args {
  readonly mode: "report" | "check" | "fixtures" | "help";
  readonly version: string | null;
}

/** Kept compatible with the shell version's flags, which are in muscle memory. */
export function parseArgs(argv: readonly string[]): Args {
  let mode: Args["mode"] = "report";
  let version: string | null = null;
  for (const arg of argv) {
    if (arg === "--check") mode = "check";
    else if (arg === "--fixtures") mode = "fixtures";
    else if (arg === "-h" || arg === "--help") return { mode: "help", version: null };
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else version = arg;
  }
  return { mode, version };
}

export const USAGE = `Report which Factorio reference material is readable.

  pnpm refs:sync              report against the installed binary's version
  pnpm refs:sync 2.1.11       report against an explicit version instead
  pnpm refs:sync --check      exit 1 if that version cannot be read
  pnpm refs:sync --fixtures   which fixtures predate the installed binary

Nothing is pinned, checked out or downloaded - factorio-oracle reads the
material in place. To read it yourself:

  factorio-oracle refs grep --tag <ver> <pattern>     game data Lua
  factorio-oracle refs show <ver> <path>              one .lua file
  factorio-oracle refs docs <ver> <path>              a Lua API docs file
  factorio-oracle refs grep --tag A --tag B <pat>     compare two versions

Overrides: FACTORIO_BIN, FACTORIO_DATA_DIR, FACTORIO_ORACLE_BIN.`;

/** Run the oracle, streaming its output straight through. */
function run(oracle: string, args: string[]): number {
  const result = spawnSync(oracle, args, { stdio: "inherit" });
  return result.status ?? 2;
}

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE);
    return 2;
  }
  if (args.mode === "help") {
    console.log(USAGE);
    return 0;
  }

  const oracle = findOracle();
  if (oracle === null) {
    console.error("factorio-oracle not found. It owns discovery and reference reading now.");
    console.error("  cd ~/GitHub/factorio-oracle && cargo install --path .");
    console.error("Or point FACTORIO_ORACLE_BIN at it.");
    return 2;
  }

  // `--fixtures` needs no version at all: the report compares each fixture's
  // recorded version against whatever install it finds.
  if (args.mode === "fixtures") {
    return run(oracle, ["provenance", "report", "test/fixtures"]);
  }

  let version = args.version;
  if (version === null) {
    const listed = spawnSync(oracle, ["installs", "list"], { encoding: "utf8" });
    if (listed.status !== 0) {
      console.error("factorio-oracle installs list failed:");
      console.error(listed.stderr || listed.stdout);
      return 2;
    }
    let install: Install | null;
    try {
      install = pickInstall(parseInstalls(listed.stdout));
    } catch (error) {
      console.error(`could not read installs list: ${String(error)}`);
      return 2;
    }
    if (install === null) {
      console.error("No Factorio install found, so there is no version to read against.");
      console.error("Name one with FACTORIO_BIN, or pass a version: pnpm refs:sync 2.1.14");
      return 2;
    }
    version = install.version;
  }

  const forwarded = ["refs", "sync", version, ...(args.mode === "check" ? ["--check"] : [])];
  return run(oracle, forwarded);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
