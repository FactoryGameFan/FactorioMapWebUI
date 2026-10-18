/**
 * The game's chunk-grid `multioctave_noise`, read out of the running game (#451).
 *
 *   node --experimental-strip-types scripts/probes/multioctave-grid/capture.ts \
 *     <install> [<cross-check install> ...]
 *
 * for example, on tealc:
 *
 *   node --experimental-strip-types scripts/probes/multioctave-grid/capture.ts \
 *     ~/Projects/factorio-oracle/installs/factorio-headless-2.1.20 \
 *     ~/factorio-headless-2.0.77
 *
 * Same machinery as `scripts/probes/basis-grid/` (read its header first): a gdb
 * breakpoint on the chunk-grid `basis_noise` kernel during a `--create`, in a
 * Linux headless build. What differs is the caller. `MultioctaveNoise::run`'s
 * grid branch (2.1.20 at 0x2525320) calls the kernel ONCE PER OCTAVE, all with
 * the same input scale, each with that octave's amplitude as the output scale
 * and its own step and origin, adding into one shared buffer. So:
 *
 * - `probe.py` runs in its "octaves" mode: a call is matched to a case by its
 *   input scale alone, and kept when its y origin over its step lands on one
 *   of the kept chunk rows.
 * - The octaves of one chunk are CHAINED here by content, not by a model of
 *   the arithmetic: octave 0 starts from a zeroed buffer, and each later octave
 *   starts from exactly the buffer the previous one returned. Only the chunk's
 *   label uses the arithmetic - `x0 / step - offset_x` of octave 0, rounded -
 *   and a wrong label fails loudly as a missing chunk.
 *
 * The fixture records, per chunk, every octave's kernel arguments as the game
 * passed them AND the finished buffer. That lets the port be graded on the
 * argument formation and on the values separately.
 *
 * The fourth case is a plain `basis_noise` with `offset_x` and `offset_y`.
 * Those parameters are applied inside the op, unlike `x + 20000`, which takes
 * an expression off the grid entirely (see the basis-grid header). It sits here
 * because this is the capture that records origins.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Call, replayUnderGdb } from "../basis-grid/gdbReplay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const OUT = join(REPO, "test", "fixtures", "oracle-multioctave-grid.seed123456.json");

const SEED0 = 123456;
/** World chunk origins kept: a 3x3 block around the origin. */
const KEPT = [-32, 0, 32];

interface Case {
  readonly property: "elevation" | "moisture" | "aux" | "temperature";
  readonly op: "multioctave_noise" | "basis_noise";
  readonly seed1: number;
  readonly inputScale: number;
  readonly outputScale: number;
  readonly octaves?: number;
  readonly persistence?: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

const CASES: readonly Case[] = [
  // Integral octaves, no offset.
  {
    property: "elevation",
    op: "multioctave_noise",
    seed1: 91,
    inputScale: 0.0731,
    outputScale: 1.375,
    octaves: 4,
    persistence: 0.6,
    offsetX: 0,
    offsetY: 0,
  },
  // Both offsets, one of them not an integer, so the f32 add into the origin shows.
  {
    property: "moisture",
    op: "multioctave_noise",
    seed1: 300,
    inputScale: 0.0173,
    outputScale: 0.75,
    octaves: 3,
    persistence: 0.5,
    offsetX: 20000,
    offsetY: 777.25,
  },
  // A fractional octave count: the step starts at clamp(fastPow2(0.5), 1, 1.99999), not 1.
  {
    property: "aux",
    op: "multioctave_noise",
    seed1: 7,
    inputScale: 0.00311,
    outputScale: 2.5,
    octaves: 3.5,
    persistence: 0.7,
    offsetX: 0,
    offsetY: 0,
  },
  {
    property: "temperature",
    op: "basis_noise",
    seed1: 5,
    inputScale: 1 / 7,
    outputScale: 0.8125,
    offsetX: 1000.5,
    offsetY: -20000,
  },
];

function expressionOf(c: Case): string {
  const octave =
    c.op === "multioctave_noise"
      ? `octaves = ${String(c.octaves)}, persistence = ${String(c.persistence)}, `
      : "";
  const scale = c.inputScale === 1 / 7 ? "1/7" : String(c.inputScale);
  return (
    `${c.op}{x = x, y = y, seed0 = ${String(SEED0)}, seed1 = ${String(c.seed1)}, ${octave}` +
    `input_scale = ${scale}, output_scale = ${String(c.outputScale)}, ` +
    `offset_x = ${String(c.offsetX)}, offset_y = ${String(c.offsetY)}}`
  );
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
      `  { type = "noise-expression", name = "probe_mo_${c.property}", expression = "${expressionOf(c)}" },`,
  );
  return `data:extend({\n${rows.join("\n")}\n})\n`;
}

const f32 = (v: number): number => Math.fround(v);
const sameBits = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

interface Octave {
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly outputScale: number;
}

interface ChunkResult {
  readonly octaves: readonly Octave[];
  readonly values: readonly number[];
}

interface Capture {
  readonly buildLine: string;
  readonly version: string;
  /** case index -> "x,y" -> the chunk's octave chain and final buffer */
  readonly chunks: Map<number, Map<string, ChunkResult>>;
  readonly repeats: Map<number, number>;
}

/** Follow one chunk's octaves from a zero-buffer call, by buffer content. */
function chain(first: Call, pool: Call[]): Call[] {
  const out = [first];
  for (;;) {
    const last = out[out.length - 1];
    const next = pool.findIndex(
      (c) => c.out === last.out && c.step < last.step && sameBits(c.before, last.after),
    );
    if (next < 0) return out;
    out.push(pool[next]);
    pool.splice(next, 1);
  }
}

async function capture(install: string): Promise<Capture> {
  const mapGen: Record<string, string> = {};
  for (const c of CASES) mapGen[c.property] = `probe_mo_${c.property}`;
  const replay = await replayUnderGdb({
    install,
    seed: SEED0,
    modName: "multioctave_grid_probe",
    dataLua: dataLua(),
    controlLua: CONTROL_LUA,
    propertyExpressionNames: mapGen,
    probeEnv: {
      PROBE_MATCH: "octaves",
      PROBE_CASES: JSON.stringify(CASES.map((c) => f32(c.inputScale))),
      // A row arrives as y0 / step = y + offset_y, so each case's offset is
      // folded into the rows it keeps.
      PROBE_CHUNKS: JSON.stringify([
        ...new Set(CASES.flatMap((c) => KEPT.map((y) => y + c.offsetY))),
      ]),
    },
  });

  const chunks = new Map<number, Map<string, ChunkResult>>();
  const repeats = new Map<number, number>();
  CASES.forEach((c, k) => {
    const pool = replay.calls.filter((call) => call.inputScale === f32(c.inputScale));
    const firsts = pool.filter((call) => call.before.every((b) => b === 0));
    const rest = pool.filter((call) => !call.before.every((b) => b === 0));
    const perCase = new Map<string, ChunkResult>();
    const wantOctaves = c.op === "multioctave_noise" ? Math.ceil(c.octaves ?? 0) : 1;
    for (const first of firsts) {
      const calls = chain(first, rest);
      if (calls.length !== wantOctaves) {
        throw new Error(
          `${c.property}: a chain of ${String(calls.length)}, wanted ${String(wantOctaves)}`,
        );
      }
      const x = Math.round(first.x0 / first.step - c.offsetX);
      const y = Math.round(first.y0 / first.step - c.offsetY);
      if (!KEPT.includes(y)) throw new Error(`${c.property}: kept a call from row ${String(y)}`);
      if (x % 32 !== 0 || y % 32 !== 0) {
        throw new Error(`${c.property}: label (${String(x)}, ${String(y)}) is not a chunk origin`);
      }
      if (!KEPT.includes(x)) continue;
      const result: ChunkResult = {
        octaves: calls.map((o) => ({
          x0: o.x0,
          y0: o.y0,
          step: o.step,
          outputScale: o.outputScale,
        })),
        values: calls[calls.length - 1].after,
      };
      const key = `${String(x)},${String(y)}`;
      const seen = perCase.get(key);
      if (seen) {
        if (!sameBits(seen.values, result.values)) {
          throw new Error(`${c.property} chunk ${key} captured twice with different values`);
        }
        repeats.set(k, (repeats.get(k) ?? 0) + 1);
      }
      perCase.set(key, result);
    }
    if (perCase.size !== KEPT.length * KEPT.length) {
      throw new Error(`${c.property}: ${String(perCase.size)} of 9 chunks`);
    }
    chunks.set(k, perCase);
  });
  return { buildLine: replay.buildLine, version: replay.version, chunks, repeats };
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
  for (const other of others) {
    for (const [k, perCase] of primary.chunks) {
      for (const [key, chunk] of perCase) {
        const theirs = other.chunks.get(k)?.get(key);
        if (!theirs || !sameBits(theirs.values, chunk.values)) {
          throw new Error(
            `${other.version} differs from ${primary.version} at case ${String(k)} chunk ${key}`,
          );
        }
      }
    }
  }

  const comment =
    `Ground truth from Factorio ${primary.buildLine.replace(/^Version: /, "")}, read out of the running game ` +
    "with gdb rather than through Lua: every call the CHUNK-GRID multioctave path made to the grid basis_noise kernel " +
    "Noise::noise(float, float, unsigned int, unsigned int, float, float, float, NoiseScratch&, float*), for three " +
    "multioctave_noise expressions and one offset basis_noise routed to Nauvis's elevation, moisture, aux and " +
    "temperature during a --create. Per chunk (world origin x, y): `octaves`, each octave's kernel arguments as the " +
    "game passed them (origin x0, y0, step, and outputScale = that octave's amplitude; the input scale is the case's), " +
    "and `values`, the shared buffer after the last octave, 1,024 floats, row-major, row r and column i being world " +
    "tile (x + i, y + r). Octaves were chained by buffer content, not by a model. " +
    (others.length > 0
      ? `Cross-checked: ${others.map((o) => o.buildLine.replace(/^Version: /, "")).join("; ")} returned bit-identical values. `
      : "") +
    "Captured by scripts/probes/multioctave-grid (#451). Graded by crates/fmw-noise/src/fixtures.rs.";

  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(comment)},`,
    `  "_factorioVersion": ${JSON.stringify(primary.version)},`,
    `  "_crossChecked": ${JSON.stringify(others.map((o) => o.version))},`,
    `  "seed0": ${String(SEED0)},`,
    '  "cases": [',
  ];
  CASES.forEach((c, k) => {
    const perCase = primary.chunks.get(k);
    if (!perCase) throw new Error("unreachable");
    lines.push("    {");
    lines.push(`      "property": ${JSON.stringify(c.property)},`);
    lines.push(`      "op": ${JSON.stringify(c.op)},`);
    lines.push(`      "expression": ${JSON.stringify(expressionOf(c))},`);
    lines.push(`      "seed1": ${String(c.seed1)},`);
    if (c.op === "multioctave_noise") {
      lines.push(`      "octaves": ${String(c.octaves)},`);
      lines.push(`      "persistence": ${String(c.persistence)},`);
    }
    lines.push(`      "inputScale": ${String(f32(c.inputScale))},`);
    lines.push(`      "outputScale": ${String(c.outputScale)},`);
    lines.push(`      "offsetX": ${String(c.offsetX)},`);
    lines.push(`      "offsetY": ${String(c.offsetY)},`);
    lines.push(`      "identicalRepeatChunks": ${String(primary.repeats.get(k) ?? 0)},`);
    lines.push('      "chunks": [');
    const keys = KEPT.flatMap((x) => KEPT.map((y) => [x, y] as const));
    keys.forEach(([x, y], j) => {
      const chunk = perCase.get(`${String(x)},${String(y)}`);
      if (!chunk) throw new Error("unreachable");
      const octs = chunk.octaves
        .map(
          (o) =>
            `{ "x0": ${String(o.x0)}, "y0": ${String(o.y0)}, "step": ${String(o.step)}, "outputScale": ${String(o.outputScale)} }`,
        )
        .join(", ");
      const vals = chunk.values.map((b) => String(bitsToNumber(b))).join(",");
      const sep = j === keys.length - 1 ? "" : ",";
      lines.push(
        `        { "x": ${String(x)}, "y": ${String(y)}, "octaves": [${octs}], "values": [${vals}] }${sep}`,
      );
    });
    lines.push("      ]");
    lines.push(k === CASES.length - 1 ? "    }" : "    },");
  });
  lines.push("  ]", "}", "");
  await writeFile(OUT, lines.join("\n"));
  console.log(`wrote ${OUT}`);
}

await main();
