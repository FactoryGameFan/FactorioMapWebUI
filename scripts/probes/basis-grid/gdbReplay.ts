/**
 * Shared by the two chunk-grid captures (#451): build a world through
 * `factorio-oracle`, then replay the identical `--create` under gdb with
 * `probe.py` and hand back every kernel call it recorded.
 *
 * Used by `scripts/probes/basis-grid/capture.ts` (lone `basis_noise`) and
 * `scripts/probes/multioctave-grid/capture.ts` (one call per octave). The
 * oracle run records provenance and enforces a timeout; gdb gets a ready-made
 * world. Needs a Linux headless install, which ships its symbol table.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");

/** One kernel call as `probe.py` writes it. */
export interface Call {
  readonly inputScale: number;
  readonly outputScale: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly w: number;
  readonly h: number;
  /** The output buffer's address. */
  readonly out: number;
  readonly before: readonly number[];
  readonly after: readonly number[];
}

export interface Replay {
  readonly buildLine: string;
  readonly version: string;
  readonly calls: readonly Call[];
}

export interface ReplayOptions {
  readonly install: string;
  readonly seed: number;
  readonly modName: string;
  readonly dataLua: string;
  readonly controlLua: string;
  readonly propertyExpressionNames: Readonly<Record<string, string>>;
  /** PROBE_MATCH, PROBE_CASES and PROBE_CHUNKS for `probe.py`. */
  readonly probeEnv: Readonly<Record<string, string>>;
}

export async function replayUnderGdb(opts: ReplayOptions): Promise<Replay> {
  const work = await mkdtemp(join(tmpdir(), `${opts.modName}-work-`));
  const probeDir = await mkdtemp(join(tmpdir(), `${opts.modName}-probe-`));
  try {
    const probePath = join(probeDir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify(
        {
          mode: "create",
          mod: {
            name: opts.modName,
            version: "0.0.1",
            dependencies: ["base"],
            control_lua: opts.controlLua,
            data_lua: opts.dataLua,
          },
          seed: opts.seed,
          map_gen_settings: { property_expression_names: opts.propertyExpressionNames },
          timeout_seconds: 600,
        },
        null,
        2,
      ),
    );
    // A successful create exits non-zero (DUMPED-OK); the report says whether it worked.
    let report: {
      ok: boolean;
      provenance: { buildLine: string; factorioVersion: string; binaryPath: string };
    };
    try {
      const { stdout } = await run(
        ORACLE,
        ["run", "--probe", probePath, "--work-dir", work, "--factorio", opts.install],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      report = JSON.parse(stdout) as typeof report;
    } catch (err) {
      // The oracle exits non-zero on a successful create, so a failure here is
      // usually still a report. When it is not - the oracle itself failed -
      // the parse error would hide why, so keep the original as the cause.
      const stdout = (err as { stdout?: string }).stdout ?? "";
      try {
        report = JSON.parse(stdout) as typeof report;
      } catch {
        throw new Error(`factorio-oracle printed no report for ${opts.install}`, { cause: err });
      }
    }
    if (!report.ok) throw new Error(`factorio-oracle run failed for ${opts.install}`);

    const tracePath = join(probeDir, "trace.jsonl");
    const env = { ...process.env, ...opts.probeEnv, PROBE_OUT: tracePath };
    const argv = [
      "-batch",
      "-x",
      join(HERE, "probe.py"),
      "--args",
      report.provenance.binaryPath,
      "--create",
      join(work, "write", "probe.zip"),
      "--map-gen-settings",
      join(work, "map-gen-settings.json"),
      "--map-gen-seed",
      String(opts.seed),
      "--mod-directory",
      join(work, "mods"),
      "--config",
      join(work, "config.ini"),
    ];
    await new Promise<void>((done, fail) => {
      const child = spawn("gdb", argv, { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error("gdb replay timed out after 900s"));
      }, 900_000);
      // A missing gdb emits `error` and never `exit`.
      child.on("error", (err) => {
        clearTimeout(timer);
        fail(new Error(`failed to start gdb: ${err.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (out.includes("probe: wrote")) done();
        else fail(new Error(`gdb wrote no trace (exit ${String(code)}):\n${out.slice(-2000)}`));
      });
    });

    const lines = (await readFile(tracePath, "utf8")).trim().split("\n");
    const summary = JSON.parse(lines.pop() ?? "{}") as {
      summary?: { kept: number; returned: number };
    };
    if (!summary.summary || summary.summary.kept !== summary.summary.returned) {
      throw new Error(`trace incomplete: ${JSON.stringify(summary)}`);
    }
    const calls = lines.map((line) => {
      const call = JSON.parse(line) as Partial<Call>;
      if (!call.after) throw new Error("a call never returned normally");
      if (call.w !== 32 || call.h !== 32) {
        throw new Error(`unexpected grid ${String(call.w)}x${String(call.h)}`);
      }
      return call as Call;
    });
    return {
      buildLine: report.provenance.buildLine,
      version: report.provenance.factorioVersion,
      calls,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
}
