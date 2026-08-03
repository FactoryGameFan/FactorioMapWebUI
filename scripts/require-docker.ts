/**
 * Preflight for the two scripts that genuinely need a container runtime:
 * `preview:dev` (wrangler dev builds the Factorio image) and `preview:deploy`
 * (wrangler deploy builds and pushes it). Without this, a stopped daemon
 * surfaces as a wrangler build error several screens deep that does not say
 * "start Docker".
 *
 * Exit 0 = a daemon answered; 1 = the CLI exists but no daemon answered
 * (actionable - start it); 2 = no docker CLI at all (install something).
 *
 * Deliberately NOT wired into `preview:test` or `verify`. Those run on CI
 * runners with no container runtime at all and must keep working there - see
 * CLAUDE.md. Adding a daemon dependency to them would break that property.
 *
 * It reports rather than acts, because the runtime is the developer's choice,
 * not the repo's: OrbStack, Docker Desktop, colima and podman all satisfy the
 * Dockerfile and only the human knows which they installed. Set
 * `FMW_AUTO_START_DOCKER=1` to opt into having it run the start command for
 * you.
 *
 * Node runs this `.ts` directly (type stripping); there is deliberately no
 * compile step and no `tsc` involved - see CLAUDE.md.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long to wait on a probe before calling the daemon unreachable. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long to wait for a daemon to answer after an opt-in auto-start. */
const START_TIMEOUT_MS = 90_000;
/** Inner width of the banner box, in characters. */
const BOX_WIDTH = 70;

export type ProbeResult =
  | { status: "ok"; version: string }
  | { status: "no-daemon"; detail: string }
  | { status: "no-cli"; detail: string };

export interface Runtime {
  /** Display name, e.g. "OrbStack". */
  name: string;
  /** Shell command that starts it. */
  start: string;
  /** True when this one looks installed on the current machine. */
  installed: boolean;
}

// ============================================================================
//  Colour
// ============================================================================

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

export type Style = keyof Omit<typeof CODES, "reset">;

/**
 * Wrap text in ANSI styles when colour is on.
 *
 * Colour is a decoration, never the message: every banner below also carries a
 * glyph and a word, so piping to a file or running under NO_COLOR loses nothing
 * but the paint.
 */
export function paint(text: string, styles: Style[], enabled: boolean): string {
  if (!enabled || styles.length === 0) return text;
  return styles.map((s) => CODES[s]).join("") + text + CODES.reset;
}

/** Honour the NO_COLOR convention, and never emit escapes into a pipe. */
export function colorEnabled(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0")
    return true;
  return isTty;
}

// ============================================================================
//  Banner
// ============================================================================

/**
 * Render a heavy box around `title`.
 *
 * Padding is computed from the PLAIN text and the styling applied afterwards,
 * so the right-hand border stays flush - measuring a string that already has
 * escape codes in it is how boxes come out ragged.
 */
export function buildBox(title: string, styles: Style[], enabled: boolean): string[] {
  const bar = "═".repeat(BOX_WIDTH);
  const padded = ` ${title} `.padEnd(BOX_WIDTH, " ");
  return [
    paint(`╔${bar}╗`, styles, enabled),
    paint(`║${padded}║`, styles, enabled),
    paint(`╚${bar}╝`, styles, enabled),
  ];
}

/** Clip a one-line detail so it cannot wrap the banner into unreadability. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Turn a failed probe into the exact lines a human needs, loudest first.
 *
 * Split out from `main` so `test/requireDocker.spec.ts` can assert the advice
 * without a container runtime anywhere near the test runner.
 */
export function describeFailure(
  probe: Exclude<ProbeResult, { status: "ok" }>,
  runtimes: Runtime[],
  enabled: boolean,
): { code: number; lines: string[] } {
  const installed = runtimes.filter((r) => r.installed);
  const noCli = probe.status === "no-cli";
  const title = noCli ? "✖  NO CONTAINER RUNTIME FOUND" : "✖  DOCKER IS NOT RUNNING";

  const lines = [
    "",
    ...buildBox(title, ["bold", "red"], enabled),
    "",
    noCli
      ? `  This build needs a Docker-compatible CLI and none is on your PATH.`
      : `  A ${paint("docker", ["cyan"], enabled)} CLI is installed, but no daemon answered.`,
    // Truncated: docker's own connect errors run past 150 characters, and a
    // wrapped wall of dim text buries the actionable part below it.
    `  ${paint(truncate(probe.detail, 110), ["dim"], enabled)}`,
    "",
    paint(noCli ? `  ▶  INSTALL ONE OF:` : `  ▶  START IT WITH:`, ["bold", "yellow"], enabled),
    "",
  ];

  const suggestions = installed.length > 0 ? installed : runtimes;
  for (const r of suggestions) {
    const mark = r.installed ? paint("●", ["green"], enabled) : paint("○", ["dim"], enabled);
    const note = r.installed ? "" : paint("  (not detected)", ["dim"], enabled);
    lines.push(
      `     ${mark} ${r.name.padEnd(16)} ${paint(r.start, ["bold", "cyan"], enabled)}${note}`,
    );
  }

  lines.push(
    "",
    paint(
      noCli
        ? `  Then re-run. Any Docker-compatible runtime satisfies the Dockerfile.`
        : `  Then re-run. Or set FMW_AUTO_START_DOCKER=1 to have this start it for you.`,
      ["dim"],
      enabled,
    ),
    "",
  );
  return { code: noCli ? 2 : 1, lines };
}

/** The one-line all-clear. Quiet on purpose - noise on success trains people to ignore it. */
export function describeSuccess(version: string, enabled: boolean): string {
  return `${paint("✔", ["bold", "green"], enabled)} Docker daemon ready ${paint(`(${version})`, ["dim"], enabled)}`;
}

// ============================================================================
//  Probing
// ============================================================================

/** Ask the daemon for its version. Anything other than a clean answer is a failure. */
export function probeDocker(timeoutMs = PROBE_TIMEOUT_MS): ProbeResult {
  const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "no-cli", detail: "`docker` is not on your PATH." };
    return { status: "no-daemon", detail: `docker info failed: ${res.error.message}` };
  }
  if (res.status === 0 && res.stdout.trim()) {
    return { status: "ok", version: res.stdout.trim() };
  }
  const stderr = (res.stderr || "").trim().split("\n")[0] || "docker info returned no version.";
  return { status: "no-daemon", detail: stderr };
}

/**
 * Which runtimes look installed here. Order is the order they get suggested in.
 *
 * PATH is scanned directly rather than shelling out to `command -v`: spawning
 * with `shell: true` AND an args array is deprecated in Node 26 (DEP0190) and
 * prints a warning that would land in the middle of the banner.
 */
export function detectRuntimes(): Runtime[] {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const onPath = (bin: string): boolean => dirs.some((d) => existsSync(join(d, bin)));
  return [
    { name: "OrbStack", start: "orb start", installed: onPath("orb") },
    {
      name: "Docker Desktop",
      start: "open -a Docker",
      installed: existsSync("/Applications/Docker.app"),
    },
    { name: "colima", start: "colima start", installed: onPath("colima") },
    { name: "podman", start: "podman machine start", installed: onPath("podman") },
  ];
}

// ============================================================================
//  Entrypoint
// ============================================================================

async function main(): Promise<number> {
  const enabled = colorEnabled(process.env, process.stdout.isTTY === true);

  let probe = probeDocker();
  if (probe.status === "ok") {
    console.log(describeSuccess(probe.version, enabled));
    return 0;
  }

  const runtimes = detectRuntimes();
  const auto = process.env.FMW_AUTO_START_DOCKER;
  const target = runtimes.find((r) => r.installed);

  if (auto === "1" && target && probe.status !== "no-cli") {
    console.log(
      paint(`⏳ Starting ${target.name} (FMW_AUTO_START_DOCKER=1) ...`, ["yellow"], enabled),
    );
    spawnSync(target.start, { shell: true, stdio: "inherit", timeout: START_TIMEOUT_MS });
    // The start command returning does not mean the daemon is accepting
    // connections yet, so poll rather than trusting its exit code.
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      probe = probeDocker(5_000);
      if (probe.status === "ok") {
        console.log(describeSuccess(probe.version, enabled));
        return 0;
      }
      spawnSync("sleep", ["2"]);
    }
  }

  const { code, lines } = describeFailure(probe, runtimes, enabled);
  for (const line of lines) console.error(line);
  return code;
}

// Only run when executed directly - `test/requireDocker.spec.ts` imports the
// pure helpers from here and must not shell out to docker.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
