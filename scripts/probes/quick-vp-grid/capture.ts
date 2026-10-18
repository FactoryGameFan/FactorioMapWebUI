/**
 * The game's chunk-grid `quick_multioctave_noise` and
 * `variable_persistence_multioctave_noise`, read out of the running game (#451).
 *
 *   node --experimental-strip-types scripts/probes/quick-vp-grid/capture.ts \
 *     <install> [<cross-check install> ...]
 *
 * for example, on tealc:
 *
 *   node --experimental-strip-types scripts/probes/quick-vp-grid/capture.ts \
 *     ~/Projects/factorio-oracle/installs/factorio-headless-2.1.20 \
 *     ~/factorio-headless-2.0.77
 *
 * Same machinery as `scripts/probes/basis-grid/` and `multioctave-grid/`; read
 * their headers first. The two ops reach the grid kernel differently, so each
 * install is replayed twice:
 *
 * - **quick_multioctave_noise** has no `run` of its own. It is an expression
 *   class that compiles to one `basis_noise` op per octave, each with its own
 *   input and output scale and seed, all adding into one register. So the
 *   KERNEL is the breakpoint, in `probe.py`'s "octaves" mode with no input
 *   scale filter, and each chunk's octaves are chained by buffer content. A
 *   chain is matched to its case by its FIRST call's scales, which are the
 *   expression's own `input_scale` and `output_scale` - no model involved.
 * - **variable_persistence_multioctave_noise** multiplies its buffer by the
 *   tile's persistence between octaves and by its gain at the end, so the
 *   kernel calls do not add up to its value. Its `run` is the breakpoint
 *   instead, in "op-output" mode, which reads the op's output register when
 *   `run` returns. A call is matched to its case by the op's own offsets.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Call, replayUnderGdb } from "../basis-grid/gdbReplay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const OUT = join(REPO, "test", "fixtures", "oracle-quick-vp-grid.seed123456.json");

const SEED0 = 123456;
const f32 = (v: number): number => Math.fround(v);
const KEPT = [-32, 0, 32];
const CHUNK_ORIGINS = KEPT.flatMap((x) => KEPT.map((y) => [x, y] as const));
const VP_RUN = "NoiseOperations::VariablePersistenceMultioctaveNoise::run(NoiseCache&) const";
/** Read off 2.1.20's `VariablePersistenceMultioctaveNoise::run` (0x251b390). */
const VP_FIELDS = {
  octaves: [0xa20, "u32"],
  firstInputScale: [0xa24, "f32"],
  gain: [0xa28, "f32"],
  offsetX: [0xa2c, "f32"],
  offsetY: [0xa30, "f32"],
};

interface QuickCase {
  readonly property: "aux" | "temperature";
  readonly op: "quick_multioctave_noise";
  readonly seed1: number;
  readonly octaves: number;
  readonly inputScale: number;
  readonly outputScale: number;
  readonly octaveInputScaleMultiplier: number;
  readonly octaveOutputScaleMultiplier: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface VpCase {
  readonly property: "elevation" | "moisture";
  readonly op: "variable_persistence_multioctave_noise";
  readonly seed1: number;
  readonly octaves: number;
  readonly inputScale: number;
  readonly outputScale: number;
  /** A noise expression; constant or per tile. */
  readonly persistence: string;
  readonly offsetX: number;
  readonly offsetY: number;
}

type Case = QuickCase | VpCase;

const CASES: readonly Case[] = [
  // A constant persistence with no exact f32 form, so the buffer multiply's
  // width shows: an f32 register against an f64 constant differ here.
  {
    property: "elevation",
    op: "variable_persistence_multioctave_noise",
    seed1: 17,
    octaves: 5,
    inputScale: 0.0731,
    outputScale: 1.375,
    persistence: "0.7",
    offsetX: 333.5,
    offsetY: -71.25,
  },
  // A persistence that varies per tile, the shape Nauvis's elevation uses.
  {
    property: "moisture",
    op: "variable_persistence_multioctave_noise",
    seed1: 23,
    octaves: 4,
    inputScale: 0.0173,
    outputScale: 0.75,
    persistence: "0.4 + x / 4096",
    offsetX: -1000,
    offsetY: 2000,
  },
  {
    property: "aux",
    op: "quick_multioctave_noise",
    seed1: 7,
    octaves: 5,
    inputScale: 0.00311,
    outputScale: 2.5,
    octaveInputScaleMultiplier: 0.55,
    octaveOutputScaleMultiplier: 1.7,
    offsetX: 20000.5,
    offsetY: 777.25,
  },
  {
    property: "temperature",
    op: "quick_multioctave_noise",
    seed1: 5,
    octaves: 3,
    inputScale: 1 / 7,
    outputScale: 0.8125,
    octaveInputScaleMultiplier: 0.5,
    octaveOutputScaleMultiplier: 2,
    offsetX: 0,
    offsetY: 0,
  },
];

/** A quick case's per-octave input scales: `scale *= oism`, each step in f32. */
function quickInputScales(c: Case): number[] {
  if (c.op !== "quick_multioctave_noise") return [];
  const oism = f32(c.octaveInputScaleMultiplier);
  const out: number[] = [];
  let scale = f32(c.inputScale);
  for (let k = 0; k < c.octaves; k++) {
    out.push(scale);
    scale = f32(scale * oism);
  }
  return out;
}

function expressionOf(c: Case): string {
  const scale = c.inputScale === 1 / 7 ? "1/7" : String(c.inputScale);
  const common =
    `x = x, y = y, seed0 = ${String(SEED0)}, seed1 = ${String(c.seed1)}, octaves = ${String(c.octaves)}, ` +
    `input_scale = ${scale}, output_scale = ${String(c.outputScale)}, ` +
    `offset_x = ${String(c.offsetX)}, offset_y = ${String(c.offsetY)}`;
  return c.op === "quick_multioctave_noise"
    ? `${c.op}{${common}, octave_input_scale_multiplier = ${String(c.octaveInputScaleMultiplier)}, ` +
        `octave_output_scale_multiplier = ${String(c.octaveOutputScaleMultiplier)}}`
    : `${c.op}{${common}, persistence = ${c.persistence}}`;
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
      `  { type = "noise-expression", name = "probe_qv_${c.property}", expression = "${expressionOf(c)}" },`,
  );
  return `data:extend({\n${rows.join("\n")}\n})\n`;
}

const sameBits = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

interface OctaveCall {
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly inputScale: number;
  readonly outputScale: number;
}

interface ChunkResult {
  /** Quick only: the kernel calls, in order. */
  readonly octaves?: readonly OctaveCall[];
  /** VP only: the op's constants as `run` read them. */
  readonly fields?: Readonly<Record<string, number>>;
  readonly values: readonly number[];
}

interface Capture {
  readonly buildLine: string;
  readonly version: string;
  readonly chunks: Map<number, Map<string, ChunkResult>>;
  readonly repeats: Map<number, number>;
}

/** Follow one chunk's octaves from a zero-buffer call, by buffer content. */
function chain(first: Call, pool: Call[]): Call[] {
  const out = [first];
  for (;;) {
    const last = out[out.length - 1];
    const next = pool.findIndex((c) => c.out === last.out && sameBits(c.before, last.after));
    if (next < 0) return out;
    out.push(pool[next]);
    pool.splice(next, 1);
  }
}

function record(
  perCase: Map<string, ChunkResult>,
  key: string,
  result: ChunkResult,
  repeats: Map<number, number>,
  k: number,
): void {
  const seen = perCase.get(key);
  if (seen) {
    if (!sameBits(seen.values, result.values)) {
      throw new Error(`${CASES[k].property} chunk ${key} captured twice with different values`);
    }
    repeats.set(k, (repeats.get(k) ?? 0) + 1);
  }
  perCase.set(key, result);
}

async function capture(install: string): Promise<Capture> {
  const mapGen: Record<string, string> = {};
  for (const c of CASES) mapGen[c.property] = `probe_qv_${c.property}`;
  const common = {
    install,
    seed: SEED0,
    modName: "quick_vp_grid_probe",
    dataLua: dataLua(),
    controlLua: CONTROL_LUA,
    propertyExpressionNames: mapGen,
    timeoutSeconds: 2400,
  };
  const quick = await replayUnderGdb({
    ...common,
    probeEnv: {
      PROBE_MATCH: "octaves",
      // Every octave's input scale, by the port's own f32 chain. Only a
      // FILTER: the first version kept every call on the rows and gdb ran
      // past its 900 s limit. A wrong chain here cannot pass quietly - it
      // drops octaves, and a short chain fails below.
      PROBE_CASES: JSON.stringify(CASES.flatMap(quickInputScales)),
      PROBE_CHUNKS: JSON.stringify([
        ...new Set(
          CASES.filter((c) => c.op === "quick_multioctave_noise").flatMap((c) =>
            KEPT.map((y) => y + c.offsetY),
          ),
        ),
      ]),
    },
  });
  const vp = await replayUnderGdb({
    ...common,
    probeEnv: {
      PROBE_MATCH: "op-output",
      PROBE_CHUNKS: JSON.stringify(CHUNK_ORIGINS),
      PROBE_OP_SYMBOL: VP_RUN,
      PROBE_OP_FIELDS: JSON.stringify(VP_FIELDS),
    },
  });

  const chunks = new Map<number, Map<string, ChunkResult>>();
  const repeats = new Map<number, number>();
  const zero = (call: Call): boolean => call.before.every((b) => b === 0);
  const rest = quick.calls.filter((call) => !zero(call));
  const firsts = quick.calls.filter(zero);
  CASES.forEach((c, k) => {
    const perCase = new Map<string, ChunkResult>();
    if (c.op === "quick_multioctave_noise") {
      for (const first of firsts) {
        if (first.inputScale !== f32(c.inputScale) || first.outputScale !== f32(c.outputScale))
          continue;
        const calls = chain(first, rest);
        if (calls.length !== c.octaves) {
          throw new Error(
            `${c.property}: a chain of ${String(calls.length)}, wanted ${String(c.octaves)}`,
          );
        }
        const x = first.x0 - c.offsetX;
        const y = first.y0 - c.offsetY;
        if (!KEPT.includes(y)) throw new Error(`${c.property}: kept a call from row ${String(y)}`);
        if (x % 32 !== 0)
          throw new Error(`${c.property}: x label ${String(x)} is not a chunk origin`);
        if (!KEPT.includes(x)) continue;
        record(
          perCase,
          `${String(x)},${String(y)}`,
          {
            octaves: calls.map((o) => ({
              x0: o.x0,
              y0: o.y0,
              step: o.step,
              inputScale: o.inputScale,
              outputScale: o.outputScale,
            })),
            values: calls[calls.length - 1].after,
          },
          repeats,
          k,
        );
      }
    } else {
      for (const call of vp.calls) {
        const fields = (call as unknown as { fields: Record<string, number> }).fields;
        if (fields.offsetX !== f32(c.offsetX) || fields.offsetY !== f32(c.offsetY)) continue;
        record(
          perCase,
          `${String(call.x0)},${String(call.y0)}`,
          { fields, values: call.after },
          repeats,
          k,
        );
      }
    }
    if (perCase.size !== CHUNK_ORIGINS.length) {
      throw new Error(`${c.property}: ${String(perCase.size)} of 9 chunks`);
    }
    chunks.set(k, perCase);
  });
  return { buildLine: quick.buildLine, version: quick.version, chunks, repeats };
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
    "with gdb rather than through Lua, on the CHUNK GRID: two quick_multioctave_noise and two " +
    "variable_persistence_multioctave_noise expressions routed to Nauvis's aux, temperature, elevation and moisture " +
    "during a --create, nine chunks each. Quick: every grid basis_noise kernel call its octaves made (origin x0, y0, " +
    "step, input and output scale as the game passed them), chained by buffer content, and `values`, the shared " +
    "buffer after the last octave. Variable persistence: the op's own constants as its run read them (`fields`) and " +
    "`values`, its output register when run returned. `values` is 1,024 floats, row-major, row r and column i being " +
    "world tile (x + i, y + r). " +
    (others.length > 0
      ? `Cross-checked: ${others.map((o) => o.buildLine.replace(/^Version: /, "")).join("; ")} returned bit-identical values. `
      : "") +
    "Captured by scripts/probes/quick-vp-grid (#451). Graded by crates/fmw-noise/src/fixtures.rs.";

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
    lines.push(`      "octaves": ${String(c.octaves)},`);
    lines.push(`      "inputScale": ${String(f32(c.inputScale))},`);
    lines.push(`      "outputScale": ${String(c.outputScale)},`);
    lines.push(`      "offsetX": ${String(c.offsetX)},`);
    lines.push(`      "offsetY": ${String(c.offsetY)},`);
    if (c.op === "quick_multioctave_noise") {
      lines.push(`      "octaveInputScaleMultiplier": ${String(c.octaveInputScaleMultiplier)},`);
      lines.push(`      "octaveOutputScaleMultiplier": ${String(c.octaveOutputScaleMultiplier)},`);
    } else {
      lines.push(`      "persistence": ${JSON.stringify(c.persistence)},`);
    }
    lines.push(`      "identicalRepeatChunks": ${String(primary.repeats.get(k) ?? 0)},`);
    lines.push('      "chunks": [');
    CHUNK_ORIGINS.forEach(([x, y], j) => {
      const chunk = perCase.get(`${String(x)},${String(y)}`);
      if (!chunk) throw new Error("unreachable");
      const extra = chunk.octaves
        ? `"octaves": [${chunk.octaves
            .map(
              (o) =>
                `{ "x0": ${String(o.x0)}, "y0": ${String(o.y0)}, "step": ${String(o.step)}, ` +
                `"inputScale": ${String(o.inputScale)}, "outputScale": ${String(o.outputScale)} }`,
            )
            .join(", ")}]`
        : `"fields": ${JSON.stringify(chunk.fields)}`;
      const vals = chunk.values.map((b) => String(bitsToNumber(b))).join(",");
      const sep = j === CHUNK_ORIGINS.length - 1 ? "" : ",";
      lines.push(
        `        { "x": ${String(x)}, "y": ${String(y)}, ${extra}, "values": [${vals}] }${sep}`,
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
