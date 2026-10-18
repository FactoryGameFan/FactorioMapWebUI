/**
 * The game's CHUNK-GRID `basis_noise`, read out of the running game (#451).
 *
 *   node --experimental-strip-types scripts/probes/basis-grid/capture.ts \
 *     <install> [<cross-check install> ...]
 *
 * for example, on tealc:
 *
 *   node --experimental-strip-types scripts/probes/basis-grid/capture.ts \
 *     ~/Projects/factorio-oracle/installs/factorio-headless-2.1.20 \
 *     ~/factorio-headless-2.0.77
 *
 * The first install is the one the fixture is captured from. Every other one
 * is a cross-check: its values must be bit-identical to the first's, or the
 * capture refuses to write anything.
 *
 * ## Why this is not a `calculate_tile_properties` capture
 *
 * The game has two `basis_noise` kernels, and every point fixture this repo
 * had before this one reaches only the first:
 *
 * - `Noise::noise(unsigned long, float const*, float const*, ...)` takes a
 *   LIST of points. `calculate_tile_properties` and the cliff generator's
 *   `crossingsForChunk` use it, and it is what `crates/fmw-noise/src/basis_noise.rs`
 *   ports.
 * - `Noise::noise(float, float, unsigned int, unsigned int, ...)` takes a
 *   chunk's ORIGIN, a step and a width and height, and is what map generation
 *   uses for nearly everything: one `--create` made 69,384 calls to it and 821
 *   to the point kernel, all 821 from cliffs.
 *
 * No Lua API reaches the second one, so this capture is a gdb breakpoint on it
 * (`probe.py`, beside this file) during a `--create` run. That needs a
 * **Linux headless build**: it is a free download with no login, and it ships
 * its symbol table and DWARF, so the breakpoint is set by name and the same
 * script works on every version. The register layout is in `probe.py`, read
 * off the disassembly - the demangled signature puts the output in the wrong
 * register.
 *
 * ## How it works
 *
 * A probe mod registers four `basis_noise` expressions and routes them, one
 * each, to the four properties Nauvis tile generation reads (elevation,
 * moisture, aux, temperature). Each case has its own input and output scale,
 * which is how a kernel call is matched back to its case. The world is built
 * once through `factorio-oracle` (config, mod, map-gen settings, provenance,
 * timeout) and then the identical `--create` is replayed under gdb.
 *
 * All four read the raw `x` and `y`, and that is a requirement, not a choice.
 * An expression that changes a coordinate leaves the grid: `basis_noise{x =
 * x + 20000, ...}` was measured going to the POINT kernel as a 1,024-point
 * list per chunk (400 calls, 0 to the grid kernel). The first version of this
 * probe had two such cases and captured 0 of 9 chunks for each.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");
const OUT = join(REPO, "test", "fixtures", "oracle-basis-grid.seed123456.json");

const SEED0 = 123456;
/** World chunk origins kept, a 3x3 block around the origin so floor() sees both signs. */
const CHUNKS = [-32, 0, 32].flatMap((x) => [-32, 0, 32].map((y) => [x, y] as const));

interface Case {
  readonly property: "elevation" | "moisture" | "aux" | "temperature";
  readonly seed1: number;
  /** As written in the expression. */
  readonly inputScale: string;
  /** Dyadic on purpose, so it is exact in f32 and in the JSON. */
  readonly outputScale: number;
}

const CASES: readonly Case[] = [
  // The scales are not round on purpose: an input scale that is a power of two
  // makes every corner offset dyadic, every product exact, and the two kernels
  // agree by construction. 0.0731, 1/60, 0.003 and 1/7 all round.
  { property: "elevation", seed1: 77, inputScale: "0.0731", outputScale: 1.375 },
  { property: "moisture", seed1: 300, inputScale: "1/60", outputScale: 0.75 },
  { property: "aux", seed1: 1, inputScale: "0.003", outputScale: 2.5 },
  { property: "temperature", seed1: 5, inputScale: "1/7", outputScale: 0.8125 },
];

function expressionOf(c: Case): string {
  return (
    `basis_noise{x = x, y = y, seed0 = ${String(SEED0)}, seed1 = ${String(c.seed1)}, ` +
    `input_scale = ${c.inputScale}, output_scale = ${String(c.outputScale)}}`
  );
}

/** `eval`-free: the two forms the cases use. */
function scaleValue(s: string): number {
  const m = /^1\/(\d+)$/.exec(s);
  return m ? 1 / Number(m[1]) : Number(s);
}

const CONTROL_LUA = `-- Generate a block of chunks, then stop. The values are read by gdb, not here;
-- the dump only proves the run reached this point.
script.on_init(function()
  local s = game.surfaces[1]
  s.request_to_generate_chunks({0, 0}, 1)
  s.force_generate_chunk_requests()
  helpers.write_file("oracle-dump.json", helpers.table_to_json({ ok = true }))
  error("DUMPED-OK")
end)
`;

function dataLua(): string {
  const rows = CASES.map(
    (c) =>
      `  { type = "noise-expression", name = "probe_grid_${c.property}", expression = "${expressionOf(c)}" },`,
  );
  return `data:extend({\n${rows.join("\n")}\n})\n`;
}

/** One kernel call as `probe.py` writes it. */
interface Call {
  readonly inputScale: number;
  readonly outputScale: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly w: number;
  readonly h: number;
  readonly before: readonly number[];
  readonly after?: readonly number[];
}

interface Capture {
  readonly buildLine: string;
  readonly version: string;
  /** case index -> "x,y" -> after-bits */
  readonly values: Map<number, Map<string, readonly number[]>>;
  /** case index -> how many bit-identical repeat calls were seen */
  readonly repeats: Map<number, number>;
  readonly steps: Set<number>;
}

const f32 = (v: number): number => Math.fround(v);

async function capture(install: string): Promise<Capture> {
  const work = await mkdtemp(join(tmpdir(), "basis-grid-work-"));
  const probeDir = await mkdtemp(join(tmpdir(), "basis-grid-probe-"));
  try {
    const probePath = join(probeDir, "probe.json");
    const mapGen: Record<string, string> = {};
    for (const c of CASES) mapGen[c.property] = `probe_grid_${c.property}`;
    await writeFile(
      probePath,
      JSON.stringify(
        {
          mode: "create",
          mod: {
            name: "basis_grid_probe",
            version: "0.0.1",
            dependencies: ["base"],
            control_lua: CONTROL_LUA,
            data_lua: dataLua(),
          },
          seed: SEED0,
          map_gen_settings: { property_expression_names: mapGen },
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
        ["run", "--probe", probePath, "--work-dir", work, "--factorio", install],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      report = JSON.parse(stdout) as typeof report;
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout ?? "";
      report = JSON.parse(stdout) as typeof report;
    }
    if (!report.ok) throw new Error(`factorio-oracle run failed for ${install}`);

    const tracePath = join(probeDir, "trace.jsonl");
    const env = {
      ...process.env,
      PROBE_OUT: tracePath,
      PROBE_CASES: JSON.stringify(CASES.map((c) => [f32(scaleValue(c.inputScale)), c.outputScale])),
      PROBE_CHUNKS: JSON.stringify(CHUNKS),
    };
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
      String(SEED0),
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
    const values = new Map<number, Map<string, readonly number[]>>();
    const repeats = new Map<number, number>();
    const steps = new Set<number>();
    for (const line of lines) {
      const call = JSON.parse(line) as Call;
      const k = CASES.findIndex(
        (c) =>
          f32(scaleValue(c.inputScale)) === call.inputScale && c.outputScale === call.outputScale,
      );
      if (k < 0) throw new Error(`call matches no case: ${line.slice(0, 200)}`);
      if (!call.after) throw new Error("a call never returned normally");
      if (call.w !== 32 || call.h !== 32)
        throw new Error(`unexpected grid ${String(call.w)}x${String(call.h)}`);
      // A lone basis_noise gets a fresh buffer. If this ever fails, the
      // fixture would be recording a sum, not the kernel.
      if (call.before.some((b) => b !== 0))
        throw new Error("output buffer was not zero before the call");
      steps.add(call.step);
      const key = `${String(call.x0)},${String(call.y0)}`;
      const perCase = values.get(k) ?? new Map<string, readonly number[]>();
      // A property can be computed more than once per chunk - moisture was,
      // once per map-generation pass that reads it. A repeat is accepted only
      // when it is bit-identical, and counted so the fixture can say so.
      const seen = perCase.get(key);
      if (seen) {
        if (seen.some((v, i) => v !== call.after?.[i])) {
          throw new Error(`case ${String(k)} chunk ${key} captured twice with different values`);
        }
        repeats.set(k, (repeats.get(k) ?? 0) + 1);
      }
      perCase.set(key, call.after);
      values.set(k, perCase);
    }
    for (let k = 0; k < CASES.length; k++) {
      const got = values.get(k)?.size ?? 0;
      if (got !== CHUNKS.length) {
        throw new Error(
          `case ${CASES[k].property}: ${String(got)} of ${String(CHUNKS.length)} chunks`,
        );
      }
    }
    return {
      buildLine: report.provenance.buildLine,
      version: report.provenance.factorioVersion,
      values,
      repeats,
      steps,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(probeDir, { recursive: true, force: true });
  }
}

const bitsToNumber = (b: number): number => new Float32Array(new Uint32Array([b]).buffer)[0];

async function main(): Promise<void> {
  const installs = process.argv.slice(2).map((p) => resolve(p));
  if (installs.length === 0) {
    throw new Error("name at least one Linux headless install; see the header");
  }
  const captures: Capture[] = [];
  for (const install of installs) {
    const started = Date.now();
    const c = await capture(install);
    const reps = CASES.map((cs, k) => `${cs.property} ${String(c.repeats.get(k) ?? 0)}`).join(", ");
    console.log(
      `  ${c.buildLine}: ${String(Math.round((Date.now() - started) / 1000))}s; identical repeats: ${reps}`,
    );
    captures.push(c);
  }
  const [primary, ...others] = captures;
  if (primary.steps.size !== 1 || !primary.steps.has(1)) {
    throw new Error(`expected step 1 for every call, saw ${[...primary.steps].join(",")}`);
  }
  for (const other of others) {
    for (const [k, perCase] of primary.values) {
      for (const [key, bits] of perCase) {
        const theirs = other.values.get(k)?.get(key);
        if (!theirs || theirs.some((b, i) => b !== bits[i])) {
          throw new Error(
            `${other.version} differs from ${primary.version} at case ${String(k)} chunk ${key}`,
          );
        }
      }
    }
  }

  const comment =
    `Ground truth from Factorio ${primary.buildLine.replace(/^Version: /, "")}, read out of the running game ` +
    "with gdb rather than through Lua: the output of the CHUNK-GRID basis_noise kernel, Noise::noise(float, float, " +
    "unsigned int, unsigned int, float, float, float, NoiseScratch&, float*), for four basis_noise expressions routed " +
    "to Nauvis's elevation, moisture, aux and temperature during a --create. Per case: the expression, its seed1, the " +
    "input and output scale exactly as the game passed them (f32). " +
    "Per chunk: its world origin (x, y) and 1,024 values, row-major, row r and column i being world tile " +
    "(x + i, y + r); the noise coordinate is f32((i*step + x) * inputScale) with step 1, and " +
    "each value is what the kernel added to a zeroed buffer, i.e. sum * outputScale. " +
    (others.length > 0
      ? `Cross-checked: ${others.map((o) => o.buildLine.replace(/^Version: /, "")).join("; ")} returned bit-identical values. `
      : "") +
    "Captured by scripts/probes/basis-grid (#451). Graded by crates/fmw-noise/src/fixtures.rs.";

  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(comment)},`,
    `  "_factorioVersion": ${JSON.stringify(primary.version)},`,
    `  "_crossChecked": ${JSON.stringify(others.map((o) => o.version))},`,
    `  "seed0": ${String(SEED0)},`,
    '  "cases": [',
  ];
  CASES.forEach((c, k) => {
    const perCase = primary.values.get(k);
    if (!perCase) throw new Error("unreachable");
    lines.push("    {");
    lines.push(`      "property": ${JSON.stringify(c.property)},`);
    lines.push(`      "expression": ${JSON.stringify(expressionOf(c))},`);
    lines.push(`      "seed1": ${String(c.seed1)},`);
    lines.push(`      "inputScale": ${String(f32(scaleValue(c.inputScale)))},`);
    lines.push(`      "outputScale": ${String(c.outputScale)},`);
    lines.push(`      "identicalRepeatCalls": ${String(primary.repeats.get(k) ?? 0)},`);
    lines.push('      "chunks": [');
    CHUNKS.forEach(([x, y], j) => {
      const bits = perCase.get(`${String(x)},${String(y)}`);
      if (!bits) throw new Error("unreachable");
      const vals = bits.map((b) => String(bitsToNumber(b))).join(",");
      const sep = j === CHUNKS.length - 1 ? "" : ",";
      lines.push(`        { "x": ${String(x)}, "y": ${String(y)}, "values": [${vals}] }${sep}`);
    });
    lines.push("      ]");
    lines.push(k === CASES.length - 1 ? "    }" : "    },");
  });
  lines.push("  ]", "}", "");
  await writeFile(OUT, lines.join("\n"));
  console.log(`wrote ${OUT}`);
}

await main();
