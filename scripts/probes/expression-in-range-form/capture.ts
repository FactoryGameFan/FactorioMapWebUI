/**
 * Which f32 form of `expression_in_range` does the game evaluate? (#521)
 *
 * Reads the game's own inputs and scores at the last differing Nauvis pixel,
 * (229, -19), and its 3x3 neighbourhood: `aux`, `moisture`, `elevation`, the
 * four grass tiles' `noise_layer_noise(N)` and their `tile:<name>:probability`.
 * Then it rebuilds each grass score from the game's own inputs in two forms:
 *
 * - **edge**: `min(value - from, to - value)` per dim, what the port shipped;
 * - **center**: `half - |value - center|` per dim, with `half` and `center`
 *   folded from the constants, which is what the 2.1.23 binary's
 *   `NoiseExpressions::expressionInRange` builds (read with Ghidra).
 *
 * Both are equal in exact math. Because the inputs are the game's, the only
 * thing that can separate them is the form, so the control can fail: if the
 * game used the edge form, the edge column would be the exact one.
 *
 * Same surface settings as the preview PNG and
 * `scripts/probes/preview-tile-correction`: map seed 123456, the
 * terrain-only data-stage mod, and every disableable control at size 0.
 *
 * Measured 2026-11-24 on 2.1.23 (build 87750): center 36 of 36 exact, edge 11.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DISABLEABLE, TERRAIN_ONLY_DATA_FINAL_FIXES } from "../../../test/oracle/previewCompare.ts";

const run = promisify(execFile);
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");

/**
 * The install. hammond keeps the 2.1.23 headless build outside the oracle's
 * installs folder; set FACTORIO_2_1_23 to point elsewhere.
 */
const INSTALL = {
  root: process.env.FACTORIO_2_1_23 ?? "/home/eric/factorio-headless/2.1.23/factorio",
  version: "2.1.23",
};

const TARGET = { x: 229, y: -19 };

/** Each grass tile: its noise layer, and its (aux, moisture) box from tiles.lua. */
const GRASS = [
  { tile: "grass-1", layer: 19, from: [-10, 0.7], to: [11, 11] },
  { tile: "grass-2", layer: 20, from: [0.45, 0.45], to: [11, 0.8] },
  { tile: "grass-3", layer: 21, from: [-10, 0.6], to: [0.65, 0.9] },
  { tile: "grass-4", layer: 22, from: [-10, 0.5], to: [0.55, 0.7] },
] as const;

const PROPS = [
  "aux",
  "moisture",
  "elevation",
  ...GRASS.map((g) => `eir-layer-${String(g.layer)}`),
  ...GRASS.map((g) => `tile:${g.tile}:probability`),
];

const f = Math.fround;

/** The form the port shipped until #521. */
function edgeForm(values: number[], from: readonly number[], to: readonly number[]): number {
  let m = Infinity;
  values.forEach((v, i) => {
    m = Math.min(m, f(f(v) - f(from[i] ?? 0)), f(f(to[i] ?? 0) - f(v)));
  });
  return Math.min(1, f(20 * m));
}

/** The form the game's builder emits. */
function centerForm(values: number[], from: readonly number[], to: readonly number[]): number {
  let acc = Infinity;
  values.forEach((v, i) => {
    const lo = from[i] ?? 0;
    const hi = to[i] ?? 0;
    const half = f((hi - lo) * 0.5);
    const center = f((lo + hi) * 0.5);
    const d = Math.min(f(20 * f(half - Math.abs(f(f(v) - center)))), 1);
    acc = Math.min(acc, d);
  });
  return acc;
}

const dataFinalFixes = `${TERRAIN_ONLY_DATA_FINAL_FIXES}
${GRASS.map(
  (g) =>
    `data:extend({{ type = "noise-expression", name = "eir-layer-${String(g.layer)}", expression = "noise_layer_noise(${String(g.layer)})" }})`,
).join("\n")}
`;

const control = `
local PROPS = helpers.json_to_table([==[${JSON.stringify(PROPS)}]==])
local DISABLED = helpers.json_to_table([==[${JSON.stringify(DISABLEABLE)}]==])
script.on_init(function()
  local s = game.create_surface("eir-nauvis", game.surfaces["nauvis"].map_gen_settings)
  local mgs = s.map_gen_settings
  for _, n in ipairs(DISABLED) do mgs.autoplace_controls[n] = { frequency = 1, size = 0, richness = 1 } end
  s.map_gen_settings = mgs
  local ps = {}
  for dy = -1, 1 do for dx = -1, 1 do ps[#ps + 1] = { x = ${String(TARGET.x)} + dx, y = ${String(TARGET.y)} + dy } end end
  local r = s.calculate_tile_properties(PROPS, ps)
  for _, n in ipairs(PROPS) do assert(r[n] and #r[n] == #ps, "no values for " .. n) end
  helpers.write_file("oracle-dump.json", helpers.table_to_json({ seed = s.map_gen_settings.seed, positions = ps, values = r }))
  error("DUMPED-OK")
end)
`;

interface Dump {
  seed: number;
  positions: { x: number; y: number }[];
  values: Record<string, number[]>;
}

async function capture(): Promise<{ dump: Dump; buildLine: string }> {
  const dir = await mkdtemp(join(tmpdir(), "eir-form-"));
  try {
    const controlPath = join(dir, "control.lua");
    await writeFile(controlPath, control);
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "expression_in_range_form_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: controlPath,
          data_final_fixes_lua: dataFinalFixes,
        },
        seed: 123456,
        map_gen_settings: {
          autoplace_controls: Object.fromEntries(
            DISABLEABLE.map((n) => [n, { frequency: 1, size: 0, richness: 1 }]),
          ),
        },
        timeout_seconds: 300,
      }),
    );
    const workDir = join(dir, "work");
    let stdout = "";
    try {
      stdout = (
        await run(
          ORACLE,
          [
            "run",
            "--probe",
            probePath,
            "--work-dir",
            workDir,
            "--factorio",
            INSTALL.root,
            "--version",
            INSTALL.version,
          ],
          { maxBuffer: 64 * 1024 * 1024 },
        )
      ).stdout;
    } catch (e) {
      // `error("DUMPED-OK")` exits non-zero on success; the report is on stdout.
      stdout = (e as { stdout?: string }).stdout ?? "";
    }
    const report = JSON.parse(stdout) as { provenance?: { buildLine?: string } };
    const buildLine = report.provenance?.buildLine ?? "";
    // Without --version a bad path silently runs another install with exit 0.
    if (!buildLine.includes(`Version: ${INSTALL.version} `)) {
      throw new Error(`ran "${buildLine}", wanted ${INSTALL.version}`);
    }
    const text = await readFile(
      join(workDir, "write", "script-output", "oracle-dump.json"),
      "utf8",
    );
    return { dump: JSON.parse(text) as Dump, buildLine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const { dump, buildLine } = await capture();
const col = (name: string): number[] => {
  const v = dump.values[name];
  if (!v) throw new Error(`no column ${name}`);
  return v;
};
let edgeExact = 0;
let centerExact = 0;
let total = 0;
dump.positions.forEach((p, i) => {
  const inputs = [col("aux")[i] ?? NaN, col("moisture")[i] ?? NaN];
  for (const g of GRASS) {
    const layer = col(`eir-layer-${String(g.layer)}`)[i] ?? NaN;
    const game = col(`tile:${g.tile}:probability`)[i] ?? NaN;
    const edge = f(edgeForm(inputs, g.from, g.to) + layer);
    const center = f(centerForm(inputs, g.from, g.to) + layer);
    total++;
    if (edge === game) edgeExact++;
    if (center === game) centerExact++;
    if (p.x === TARGET.x && p.y === TARGET.y) {
      console.log(
        `${g.tile} at (${String(p.x)}, ${String(p.y)}): game ${String(game)}, center ${String(center)}, edge ${String(edge)}`,
      );
    }
  }
});
console.log(`${buildLine}, surface seed ${String(dump.seed)}`);
console.log(
  `exact of ${String(total)}: center form ${String(centerExact)}, edge form ${String(edgeExact)}`,
);
const at = dump.positions.findIndex((p) => p.x === TARGET.x && p.y === TARGET.y);
console.log(
  `inputs at the target: aux ${String(col("aux")[at])}, moisture ${String(col("moisture")[at])}, ` +
    `layer 19 ${String(col("eir-layer-19")[at])}`,
);
