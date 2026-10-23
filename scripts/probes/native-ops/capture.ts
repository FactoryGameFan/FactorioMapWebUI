/**
 * The native noise ops Gleba and Aquilo need, read out of the game.
 *
 *   node --experimental-strip-types scripts/probes/native-ops/capture.ts
 *
 * Run from the repository root. It runs BOTH installs below, refuses to write
 * on any bit difference, and writes `test/fixtures/oracle-native-ops.json`.
 * Read `README.md` beside this file for what it found.
 *
 * ## Why these expressions
 *
 * - `sin` / `cos` are the noise VM's own polynomials, not libm. The trig is the
 *   WHOLE value in every case here. A fixture that adds sin to terms near 117
 *   (frankh/factorio-mapgen's) would hide a 1-ULP error under the sum.
 * - `terrace` is Gleba's elevation shaper (`NoiseOperations::Terrace::run`).
 * - `pow(x, 0.5)`, `x ^ 0.5` and `sqrt(x)` are Aquilo's `formation_broken`.
 *   `Folding::pow` should turn exponent 0.5 into an exact sqrt node.
 *
 * Each expression is registered as its own named noise expression in the data
 * stage and read by name through `calculate_tile_properties`. None of them
 * depends on the planet or the seed, so a plain Nauvis surface is enough and
 * `x` / `y` are the only inputs.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = join(REPO, "test", "fixtures", "oracle-native-ops.json");
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");

/** The first install is the primary; the rest must match it bit for bit. */
const INSTALLS = [
  {
    root: "/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio",
    version: "2.1.23",
  },
  { root: "/home/eric/factorio-headless-2.0.77", version: "2.0.77" },
] as const;

const terrace = (value: string, offset: number, strength: number): string =>
  `terrace{value = ${value}, offset = ${String(offset)}, width = 20, strength = ${String(strength)}}`;

/** name -> game expression. The name is the property read back. */
const EXPRESSIONS: readonly { name: string; expression: string }[] = [
  { name: "sin_x_div_64", expression: "sin(x / 64)" },
  { name: "cos_x_div_64", expression: "cos(x / 64)" },
  { name: "sin_x_mul_13_37", expression: "sin(x * 13.37)" },
  { name: "cos_y_mul_0_731", expression: "cos(y * 0.731)" },
  { name: "terrace_o40_s0_2", expression: terrace("x / 10", 40, 0.2) },
  { name: "terrace_o40_s0", expression: terrace("x / 10", 40, 0) },
  { name: "terrace_o40_s0_5", expression: terrace("x / 10", 40, 0.5) },
  { name: "terrace_o40_s0_95", expression: terrace("x / 10", 40, 0.95) },
  { name: "terrace_om7_5_s0_2", expression: terrace("x / 10", -7.5, 0.2) },
  { name: "terrace_o0_s0_2", expression: terrace("x / 10", 0, 0.2) },
  { name: "pow_fn_half", expression: "pow(abs(x) + 0.001, 0.5)" },
  { name: "pow_op_half", expression: "(abs(x) + 0.001) ^ 0.5" },
  { name: "sqrt_fn", expression: "sqrt(abs(x) + 0.001)" },
];

const COUNT = 1024;

/** Deterministic positions on the 1/256 grid, with the edge cases forced in. */
function positions(): { x: number; y: number }[] {
  let s = 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const grid = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo) * 256) / 256;
  const out = [
    { x: 0, y: 0 },
    { x: -4096, y: -512 },
    { x: 4096, y: 512 },
    { x: -1 / 256, y: 1 / 256 },
    { x: 1 / 256, y: -1 / 256 },
  ];
  while (out.length < COUNT) out.push({ x: grid(-4096, 4096), y: grid(-512, 512) });
  return out;
}

function controlLua(pos: { x: number; y: number }[]): string {
  const ps = pos.map((p) => `{x=${String(p.x)},y=${String(p.y)}}`).join(",");
  const names = EXPRESSIONS.map((e) => JSON.stringify(`nativeops_${e.name}`)).join(",");
  return `
local names = { ${names} }
local ps = { ${ps} }
script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local s = game.surfaces["nauvis"]
  local got = s.calculate_tile_properties(names, ps)
  local out = { values = {} }
  for _, n in ipairs(names) do
    -- Unknown property names are silently dropped; a missing one fails here.
    assert(got[n] and #got[n] == #ps, "no values for " .. n)
    out.values[n] = got[n]
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
`;
}

function dataLua(): string {
  const items = EXPRESSIONS.map(
    (e) =>
      `{ type = "noise-expression", name = "nativeops_${e.name}", expression = [==[${e.expression}]==] }`,
  ).join(",\n  ");
  return `data:extend({\n  ${items}\n})\n`;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsOf = (v: number): number => {
  f32[0] = v;
  if (f32[0] !== v) throw new Error(`${String(v)} is not an exact f32`);
  return u32[0];
};
const hex = (b: number): string => b.toString(16).padStart(8, "0");
/** The shortest decimal that reads back as the same f32. */
function shortest(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const t = v.toPrecision(p);
    if (Math.fround(Number(t)) === v) return String(Number(t));
  }
  return String(v);
}

interface Capture {
  version: string;
  buildLine: string;
  bits: Map<string, string[]>;
  values: Map<string, number[]>;
}

async function capture(
  install: (typeof INSTALLS)[number],
  pos: { x: number; y: number }[],
): Promise<Capture> {
  const dir = await mkdtemp(join(tmpdir(), "native-ops-"));
  try {
    await writeFile(join(dir, "control.lua"), controlLua(pos));
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "native_ops_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: join(dir, "control.lua"),
          data_lua: dataLua(),
        },
        seed: 123456,
        timeout_seconds: 600,
      }),
    );
    const workDir = join(dir, "work");
    // A successful run throws (DUMPED-OK); keep the error as the cause.
    let oracleError: unknown;
    let stdout = "";
    try {
      const r = await run(
        ORACLE,
        [
          "run",
          "--probe",
          probePath,
          "--work-dir",
          workDir,
          "--factorio",
          install.root,
          "--version",
          install.version,
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } catch (e) {
      oracleError = e;
      stdout = (e as { stdout?: string }).stdout ?? "";
    }
    let report: { provenance?: { buildLine?: string } } = {};
    try {
      report = JSON.parse(stdout) as typeof report;
    } catch {
      // The buildLine check below names the failure.
    }
    const buildLine = report.provenance?.buildLine ?? "";
    let text: string;
    try {
      text = await readFile(join(workDir, "write", "script-output", "oracle-dump.json"), "utf8");
    } catch (e) {
      throw new Error(`${install.version}: no dump`, { cause: oracleError ?? e });
    }
    // Without --version a bad path silently runs another install with exit 0.
    if (!buildLine.includes(`Version: ${install.version} `)) {
      throw new Error(`ran "${buildLine}", wanted ${install.version}`, { cause: oracleError });
    }
    const dump = JSON.parse(text) as { values: Record<string, number[]> };
    const bits = new Map<string, string[]>();
    const values = new Map<string, number[]>();
    for (const e of EXPRESSIONS) {
      const v = dump.values[`nativeops_${e.name}`];
      if (!v || v.length !== pos.length) throw new Error(`${e.name}: wrong length`);
      if (!v.every(Number.isFinite)) throw new Error(`${e.name}: non-finite value`);
      bits.set(
        e.name,
        v.map((x) => hex(bitsOf(x))),
      );
      values.set(e.name, v);
    }
    return { version: install.version, buildLine, bits, values };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const pos = positions();
  const captures: Capture[] = [];
  for (const install of INSTALLS) {
    const c = await capture(install, pos);
    console.log(`  ${c.buildLine}`);
    captures.push(c);
  }
  const [primary, ...others] = captures;
  for (const other of others) {
    for (const [name, b] of primary.bits) {
      const o = other.bits.get(name) ?? [];
      const at = b.findIndex((h, i) => h !== o[i]);
      if (at >= 0) {
        throw new Error(
          `${other.version} differs from ${primary.version} at ${name}[${String(at)}] ` +
            `(x=${String(pos[at].x)}, y=${String(pos[at].y)}): ${o[at]} vs ${b[at]}`,
        );
      }
    }
  }

  const comment =
    `Ground truth from Factorio ${primary.buildLine.replace(/^Version: /, "")}, read with ` +
    "calculate_tile_properties on a Nauvis surface, one named noise expression per row. Positions are 1,024 " +
    "points on the 1/256 grid (x in [-4096, 4096], y in [-512, 512]) and `bits` is each result as the hex of " +
    "its f32, in the same order as `positions`. `values` is the shortest decimal that reads back as that f32. " +
    "Trig is the whole value in every sin/cos row. The terrace rows are terrace{value = x / 10, width = 20, " +
    "offset, strength}. The pow rows are the three spellings of exponent 0.5 on abs(x) + 0.001. " +
    `Cross-checked: ${others.map((o) => o.buildLine.replace(/^Version: /, "")).join("; ")} returned bit-identical values. ` +
    "Captured by scripts/probes/native-ops. Graded by Stage 2 (terrace, sin, cos) and Stage 1 (pow).";

  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(comment)},`,
    `  "_factorioVersion": ${JSON.stringify(primary.version)},`,
    `  "_crossChecked": ${JSON.stringify(others.map((o) => o.version))},`,
    `  "positions": [${pos.map((p) => `[${String(p.x)},${String(p.y)}]`).join(",")}],`,
    '  "expressions": [',
  ];
  EXPRESSIONS.forEach((e, k) => {
    const b = primary.bits.get(e.name) ?? [];
    const v = primary.values.get(e.name) ?? [];
    lines.push("    {");
    lines.push(`      "name": ${JSON.stringify(e.name)},`);
    lines.push(`      "expression": ${JSON.stringify(e.expression)},`);
    lines.push(`      "bits": ${JSON.stringify(b)},`);
    lines.push(`      "values": [${v.map(shortest).join(",")}]`);
    lines.push(k === EXPRESSIONS.length - 1 ? "    }" : "    },");
  });
  lines.push("  ]", "}", "");
  await writeFile(OUT, lines.join("\n"));
  console.log(`wrote ${OUT}`);
}

await main();
