/**
 * Is spot_noise with skip_span = ${String(span)}, skip_offset = 1 legal? Gleba's stone and
 * ore (`gleba_simple_spot`, planet-gleba-map-gen.lua) call it that way.
 *
 *   node --experimental-strip-types scripts/probes/spot-skip-offset/capture.ts
 *
 * Run from the repository root. It runs both installs below and writes
 * `test/fixtures/oracle-spot-skip-offset.json`. Read `README.md` beside this
 * file for what it found.
 *
 * ## Design
 *
 * The call is `gleba_simple_spot`'s own: seed0 = map_seed, seed1 = 1000,
 * region_size = spacing * 5, candidate_spot_count = 22, spacing 80,
 * quantity radius^2, hard_region_target_quantity = 0, basement_value = -1,
 * maximum_spot_basement_radius = radius * 2. Two things differ on purpose:
 * the wobble is left out (it only moves x and y), and the radius is 30 rather
 * than Gleba's 6 * size^0.5, so a coarse grid lands on cones.
 *
 * - Fixture arms, each in its OWN Factorio process so no two can share a spot
 *   cache key: `offset1` (skip_offset = 1) and `offset0` (the control).
 * - Diagnostic arms, NOT written to the fixture, that try to reproduce the
 *   old crash: `mixedCounts` (two expressions on one key, counts 22 and 23)
 *   and `mixedOffsets` (two expressions on one key, same count, offsets 0 and
 *   1). Their log lines are printed and stored in the fixture's `diagnostics`.
 *
 * The surface is Gleba with its seed FORCED to 123456, read back.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = join(REPO, "test", "fixtures", "oracle-spot-skip-offset.json");
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");

const INSTALLS = [
  {
    root: "/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio",
    version: "2.1.23",
  },
  { root: "/home/eric/factorio-headless-2.0.77", version: "2.0.77" },
] as const;

const SEED = 123456;
const RADIUS = 30;
const SPACING = 80;
const COUNT = 22;

const spot = (offset: number, count: number, span = 1): string =>
  `spot_noise{
  x = x, y = y,
  seed0 = map_seed, seed1 = 1000,
  skip_span = ${String(span)}, skip_offset = ${String(offset)},
  region_size = ${String(SPACING)} * 5,
  density_expression = 1, spot_favorability_expression = 1,
  candidate_spot_count = ${String(count)},
  suggested_minimum_candidate_point_spacing = ${String(SPACING)},
  spot_quantity_expression = ${String(RADIUS)} * ${String(RADIUS)},
  spot_radius_expression = ${String(RADIUS)},
  hard_region_target_quantity = 0,
  basement_value = -1,
  maximum_spot_basement_radius = ${String(RADIUS)} * 2
}`;

interface Arm {
  name: string;
  fixture: boolean;
  exprs: { name: string; expression: string }[];
}

const ARMS: readonly Arm[] = [
  { name: "offset1", fixture: true, exprs: [{ name: "spot", expression: spot(1, COUNT) }] },
  { name: "offset0", fixture: true, exprs: [{ name: "spot", expression: spot(0, COUNT) }] },
  {
    name: "mixedCounts",
    fixture: false,
    exprs: [
      { name: "a", expression: spot(0, COUNT) },
      { name: "b", expression: spot(0, COUNT + 1) },
    ],
  },
  {
    name: "mixedOffsets",
    fixture: false,
    exprs: [
      { name: "a", expression: spot(0, COUNT) },
      { name: "b", expression: spot(1, COUNT) },
    ],
  },
  {
    name: "mixedSpans",
    fixture: false,
    exprs: [
      { name: "a", expression: spot(0, COUNT) },
      { name: "b", expression: spot(1, COUNT, 2) },
    ],
  },
  { name: "offset5", fixture: false, exprs: [{ name: "a", expression: spot(5, COUNT) }] },
  {
    name: "offsetsOfSpan4",
    fixture: false,
    exprs: [0, 1, 2, 3].map((k) => ({ name: `o${String(k)}`, expression: spot(k, COUNT, 4) })),
  },
];

/** 32 x 16 = 512 points on the 1/256 grid. Regions are 400 wide, centred on 400k. */
function positions(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let j = 0; j < 16; j++)
    for (let i = 0; i < 32; i++) out.push({ x: -400 + 25 * i, y: -400 + 50 * j });
  return out;
}

function controlLua(arm: Arm, pos: { x: number; y: number }[]): string {
  const ps = pos.map((p) => `{x=${String(p.x)},y=${String(p.y)}}`).join(",");
  const names = arm.exprs.map((e) => JSON.stringify(`spotskip_${e.name}`)).join(",");
  return `
local names = { ${names} }
local ps = { ${ps} }
script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local s = game.planets["gleba"].create_surface()
  local mgs = s.map_gen_settings
  mgs.seed = ${String(SEED)}
  s.map_gen_settings = mgs
  assert(s.map_gen_settings.seed == ${String(SEED)}, "surface seed did not stick")
  local got = s.calculate_tile_properties(names, ps)
  local out = { surfaceSeed = s.map_gen_settings.seed, values = {} }
  for _, n in ipairs(names) do
    assert(got[n] and #got[n] == #ps, "no values for " .. n)
    out.values[n] = got[n]
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
`;
}

function dataLua(arm: Arm): string {
  const items = arm.exprs
    .map(
      (e) =>
        `{ type = "noise-expression", name = "spotskip_${e.name}", expression = [==[${e.expression}]==] }`,
    )
    .join(",\n  ");
  return `data:extend({\n  ${items}\n})\n`;
}

interface ArmResult {
  buildLine: string;
  values: Map<string, number[]> | null;
  crashLine: string | null;
  exitCode: unknown;
}

async function runArm(
  install: (typeof INSTALLS)[number],
  arm: Arm,
  pos: { x: number; y: number }[],
): Promise<ArmResult> {
  const dir = await mkdtemp(join(tmpdir(), "spot-skip-"));
  try {
    await writeFile(join(dir, "control.lua"), controlLua(arm, pos));
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "spot_skip_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: join(dir, "control.lua"),
          data_lua: dataLua(arm),
        },
        seed: SEED,
        timeout_seconds: 600,
      }),
    );
    const workDir = join(dir, "work");
    let oracleError: unknown;
    let stdout = "";
    let stderr = "";
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
      stderr = r.stderr;
    } catch (e) {
      oracleError = e;
      stdout = (e as { stdout?: string }).stdout ?? "";
      stderr = (e as { stderr?: string }).stderr ?? "";
    }
    let report: { provenance?: { buildLine?: string }; exitCode?: unknown } = {};
    try {
      report = JSON.parse(stdout) as typeof report;
    } catch {
      // The buildLine check below names the failure.
    }
    const buildLine = report.provenance?.buildLine ?? "";
    if (!buildLine.includes(`Version: ${install.version} `)) {
      throw new Error(`${arm.name}: ran "${buildLine}", wanted ${install.version}`, {
        cause: oracleError,
      });
    }
    // Look for the crash in everything the run left: the oracle's output and the game log.
    let log = `${stdout}\n${stderr}`;
    for (const f of ["factorio-current.log"]) {
      try {
        log += `\n${await readFile(join(workDir, f), "utf8")}`;
      } catch {
        // Not every layout keeps it there.
      }
    }
    const crashLine = log.split("\n").find((l) => l.includes("SpotNoiseCache.cpp")) ?? null;
    let values: Map<string, number[]> | null = null;
    try {
      const text = await readFile(
        join(workDir, "write", "script-output", "oracle-dump.json"),
        "utf8",
      );
      const dump = JSON.parse(text) as { surfaceSeed: number; values: Record<string, number[]> };
      if (dump.surfaceSeed !== SEED)
        throw new Error(`${arm.name}: surface seed ${String(dump.surfaceSeed)}`);
      values = new Map();
      for (const e of arm.exprs) {
        const v = dump.values[`spotskip_${e.name}`];
        if (!v || v.length !== pos.length || !v.every(Number.isFinite))
          throw new Error(`${arm.name}/${e.name}: bad values`);
        values.set(e.name, v);
      }
    } catch (e) {
      if (arm.fixture)
        throw new Error(`${install.version} ${arm.name}: no dump`, { cause: oracleError ?? e });
    }
    return { buildLine, values, crashLine, exitCode: report.exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function stats(v: number[]): { cells: number; spotCells: number; distinct: number; max: number } {
  const above = v.filter((x) => x > 0);
  return {
    cells: v.length,
    spotCells: above.length,
    distinct: new Set(above.map((x) => x.toFixed(6))).size,
    max: Math.max(...v),
  };
}

async function main(): Promise<void> {
  const pos = positions();
  const per: Record<string, unknown>[] = [];
  const fields = new Map<string, Map<string, number[]>>();
  for (const install of INSTALLS) {
    const entry: Record<string, unknown> = { version: install.version };
    const mine = new Map<string, number[]>();
    for (const arm of ARMS) {
      const r = await runArm(install, arm, pos);
      console.log(
        `  ${install.version} ${arm.name}: ${r.buildLine} dump=${String(r.values !== null)} crash=${r.crashLine ?? "none"}`,
      );
      entry[arm.name] = {
        buildLine: r.buildLine,
        dumped: r.values !== null,
        crashLine: r.crashLine,
      };
      if (arm.fixture && r.values) {
        const v = r.values.get("spot") as number[];
        mine.set(arm.name, v);
        entry[`${arm.name}Stats`] = stats(v);
      }
    }
    fields.set(install.version, mine);
    per.push(entry);
  }

  const [primary, ...others] = INSTALLS;
  const p = fields.get(primary.version) as Map<string, number[]>;
  const o1 = p.get("offset1") as number[];
  const o0 = p.get("offset0") as number[];
  for (const other of others) {
    const q = fields.get(other.version) as Map<string, number[]>;
    for (const n of ["offset1", "offset0"]) {
      const a = p.get(n) as number[];
      const b = q.get(n) as number[];
      const at = a.findIndex((x, i) => x !== b[i]);
      if (at >= 0)
        throw new Error(`${other.version} ${n} differs from ${primary.version} at ${String(at)}`);
    }
  }
  // Offset 1 keeps indices 1.. of the same accepted list offset 0 keeps from 0, so it
  // is offset 0 with one spot fewer: never higher anywhere (cones combine by max).
  const differing = o1.map((x, i) => (x !== o0[i] ? i : -1)).filter((i) => i >= 0);
  const higher = differing.filter((i) => o1[i] > o0[i]);
  const summary = {
    sameEverywhere: differing.length === 0,
    differingCells: differing.length,
    offset1HigherCells: higher.length,
    offset1Stats: stats(o1),
    offset0Stats: stats(o0),
  };
  console.log(JSON.stringify(summary));
  if (summary.sameEverywhere)
    throw new Error("offset 1 equals offset 0: offset is ignored (a finding)");

  const comment =
    `Ground truth from Factorio ${primary.version} and ${others.map((o) => o.version).join(", ")}, read with ` +
    "calculate_tile_properties on a Gleba surface with seed forced to 123456. Each arm is its own Factorio process. " +
    "The call is gleba_simple_spot's (seed1 1000, skip_span 1, region_size 400, 22 candidates, spacing 80, quantity " +
    "radius^2, basement -1) minus the wobble, with radius 30. `positions` is a 32 x 16 grid (x -400..375 step 25, " +
    "y -400..350 step 50), i.e. 3 x 3 regions. `offset1` and `offset0` are the field at skip_offset 1 and 0. " +
    "Captured by scripts/probes/spot-skip-offset. Graded by Stage 3 (Gleba stone and ore).";
  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(comment)},`,
    `  "_factorioVersion": ${JSON.stringify(primary.version)},`,
    `  "_crossChecked": ${JSON.stringify(others.map((o) => o.version))},`,
    `  "summary": ${JSON.stringify(summary)},`,
    `  "diagnostics": ${JSON.stringify(per)},`,
    `  "positions": [${pos.map((q) => `[${String(q.x)},${String(q.y)}]`).join(",")}],`,
    `  "offset1": ${JSON.stringify(o1)},`,
    `  "offset0": ${JSON.stringify(o0)}`,
    "}",
    "",
  ];
  await writeFile(OUT, lines.join("\n"));
  console.log(`wrote ${OUT}`);
}

await main();
