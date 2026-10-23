/**
 * Aquilo's spot, well and iceberg fields at three lever settings, and an entity
 * census, read out of the game.
 *
 *   node --experimental-strip-types scripts/probes/aquilo-fields/capture.ts
 *
 * Run from the repository root. It runs both installs below through
 * `factorio-oracle` and writes
 * `test/fixtures/oracle-aquilo-entity-fields.seed123456.json` and
 * `test/fixtures/oracle-aquilo-entities.seed123456.json`. Read `README.md`
 * beside this file for what it found.
 *
 * ## The fields
 *
 * `FIELDS` below, read with `calculate_tile_properties` on a surface whose
 * `map_gen_settings.seed` is FORCED to 123456 (the tier-1 convention). Each
 * lever case sets all three Aquilo resource controls and reads them back. The
 * iceberg probabilities are read two ways when the game allows it: the
 * property name `entity:<name>:probability`, and a data-stage noise
 * expression holding the iceberg prototype's own `probability_expression`. The
 * two must agree bit for bit wherever both come back.
 *
 * ## The positions
 *
 * One fixed pool of 16,384 points on the 1/256 grid, all within 1,200 tiles of
 * the origin. Most are spread over disks of radius 1,200, 600 and 300; the rest
 * cluster around the four starting cones, whose centres come from the game's
 * own `aquilo_angle` (read in a first run). A radius-1 cone 80 tiles out would
 * otherwise be hit by almost no point of an even spread. Each case is scouted
 * over the whole pool, and the kept positions are, in pool order, the first 64
 * where each quota field passes its test, then the first 128 others. A quota
 * the pool cannot fill is recorded, not shrunk.
 *
 * ## The census
 *
 * A second pair of runs uses the planet's own surface with its DERIVED seed
 * (map seed 123456, so 3111923328) at default levers, generates chunks -8..8
 * and lists every `resource` and `simple-entity` over tiles -256..255 with the
 * tile under its position. The wells' `created_effect` rewrites tiles near them
 * during map generation, so the census is taken twice: as shipped, and with the
 * effect removed in the data stage. The entity lists must be identical, and
 * each entity records the tile under it in both.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");
const FIELDS_OUT = join(REPO, "test", "fixtures", "oracle-aquilo-entity-fields.seed123456.json");
const CENSUS_OUT = join(REPO, "test", "fixtures", "oracle-aquilo-entities.seed123456.json");

/** The first install is the primary; the rest must match it bit for bit. */
const INSTALLS = [
  {
    root: "/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio",
    version: "2.1.23",
  },
  { root: "/home/eric/factorio-headless-2.0.77", version: "2.0.77" },
] as const;
type Install = (typeof INSTALLS)[number];

const FORCED_SEED = 123456;
const MAP_SEED = 123456;
/** 123456 + crc32("aquilo"), as planet-autoplace asserts it. */
const DERIVED_SEED = 3111923328;
const CENSUS_CHUNKS = 8;

const POOL = 16384;
const POOL_RADIUS = 1200;
const QUOTA = 64;
const EXTRA = 128;

const CONTROL_NAMES = ["aquilo_crude_oil", "lithium_brine", "fluorine_vent"] as const;
type Lever = { frequency: number; size: number; richness: number };
const lever = (frequency: number, size: number): Lever => ({ frequency, size, richness: 1 });
const CASES: Record<string, Record<(typeof CONTROL_NAMES)[number], Lever>> = {
  default: {
    aquilo_crude_oil: lever(1, 1),
    lithium_brine: lever(1, 1),
    fluorine_vent: lever(1, 1),
  },
  size0: {
    aquilo_crude_oil: lever(1, 0),
    lithium_brine: lever(1, 0),
    fluorine_vent: lever(1, 0),
  },
  moved: {
    aquilo_crude_oil: lever(1.5, 0.5),
    lithium_brine: lever(0.5, 2),
    fluorine_vent: lever(2, 1 / 6),
  },
};
const CASE_LABELS = Object.keys(CASES);

const ICEBERGS = ["lithium-iceberg-huge", "lithium-iceberg-big"] as const;
/** What decoratives-aquilo.lua says; the probe reads the prototypes and checks. */
const ICEBERG_EXPRESSIONS: Record<(typeof ICEBERGS)[number], string> = {
  "lithium-iceberg-huge": "(aquilo_high_frequency_peaks - 0.8) * 0.1",
  "lithium-iceberg-big": "(aquilo_high_frequency_peaks - 0.7) * 0.8",
};
const icebergNative = (n: string): string => `entity:${n}:probability`;
const icebergWrapper = (n: string): string => `probe_entity_${n.replace(/-/g, "_")}`;

const TILES = [
  "ammoniacal-ocean",
  "ammoniacal-ocean-2",
  "brash-ice",
  "ice-rough",
  "ice-smooth",
  "snow-crests",
  "snow-flat",
  "snow-lumpy",
  "snow-patchy",
] as const;

const NAMED = [
  "aquilo_starting_crude_oil",
  "aquilo_starting_lithium_brine",
  "aquilo_starting_flourine_vent",
  "aquilo_starting_flourine_vent_tiny",
  "aquilo_starting_mask",
  "aquilo_crude_oil_spots",
  "aquilo_lithium_brine_spots",
  "aquilo_flourine_vent_spots",
  "aquilo_crude_oil_probability",
  "aquilo_lithium_brine_probability",
  "aquilo_flourine_vent_probability",
  "aquilo_island_peaks",
  "aquilo_wobble_x",
  "aquilo_wobble_y",
  "aquilo_aux",
  "aquilo_elevation",
  "aquilo_high_frequency_peaks",
  "aquilo_snow_ice",
  "aquilo_tile_variant",
] as const;

/** Every field the fixture stores, in fixture order. */
const FIELDS = [
  ...NAMED,
  ...ICEBERGS.map(icebergNative),
  ...TILES.map((t) => `tile:${t}:probability`),
];

/** The four starting cones: name, distance, radius, angle offset (Lua). */
const CONES = [
  { name: "aquilo_starting_crude_oil", distance: 40, radius: 30 * 0.8, offset: 0 },
  { name: "aquilo_starting_lithium_brine", distance: 80, radius: 30 * 0.6, offset: 120 },
  { name: "aquilo_starting_flourine_vent", distance: 160, radius: 30 * 0.6, offset: 240 },
  { name: "aquilo_starting_flourine_vent_tiny", distance: 80, radius: 1, offset: 240 },
] as const;

/** Quota fields and their test. */
const QUOTAS: { field: string; test: string; pass: (v: number) => boolean }[] = [
  ...["aquilo_crude_oil_spots", "aquilo_lithium_brine_spots", "aquilo_flourine_vent_spots"].map(
    (field) => ({ field, test: "> -1", pass: (v: number) => v > -1 }),
  ),
  ...CONES.map((c) => ({ field: c.name, test: "> 0", pass: (v: number) => v > 0 })),
  ...ICEBERGS.map((n) => ({ field: icebergNative(n), test: "> 0", pass: (v: number) => v > 0 })),
];

type Pos = readonly [number, number];

// ---------------------------------------------------------------------------
// The pool.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const onGrid = (v: number): number => Math.floor(v * 256) / 256;

/**
 * A point of the disk of radius `r` around (cx, cy), by rejection from the
 * square, so no transcendental decides a position. Also rejects anything past
 * POOL_RADIUS from the origin.
 */
function diskPoint(next: () => number, cx: number, cy: number, r: number): Pos {
  for (;;) {
    const dx = (next() * 2 - 1) * r;
    const dy = (next() * 2 - 1) * r;
    if (dx * dx + dy * dy > r * r) continue;
    const x = onGrid(cx + dx);
    const y = onGrid(cy + dy);
    if (x * x + y * y > POOL_RADIUS * POOL_RADIUS) continue;
    return [x, y];
  }
}

interface ConeCentre {
  name: string;
  x: number;
  y: number;
  /** The disk the cluster samples, twice the cone's radius (at least 2). */
  r: number;
}

/**
 * Cone centres from `starting_spot_at_angle` in core noise-functions.lua:
 * delta_x = distance * sin(angle_rad) - x, delta_y = -distance * cos(angle_rad)
 * - y, so the centre is (d sin a, -d cos a). Rounded to the 1/256 grid, so a
 * last-bit difference in Math.sin cannot move a pool point.
 */
function coneCentres(angleDeg: number): ConeCentre[] {
  return CONES.map((c) => {
    const a = ((angleDeg + c.offset) / 180) * Math.PI;
    return {
      name: c.name,
      x: Math.round(c.distance * Math.sin(a) * 256) / 256,
      y: Math.round(-c.distance * Math.cos(a) * 256) / 256,
      r: Math.max(2, 2 * c.radius),
    };
  });
}

/**
 * Sixteen slots, cycled: 8 even over the 1,200 disk, 2 over a 600 disk, 2 over
 * a 300 disk, and one per starting cone. The origin comes first.
 */
function pool(centres: ConeCentre[]): Pos[] {
  const next = rng(0x2545f491);
  const out: Pos[] = [[0, 0]];
  for (let i = 0; out.length < POOL; i++) {
    const k = i % 16;
    if (k < 8) out.push(diskPoint(next, 0, 0, POOL_RADIUS));
    else if (k < 10) out.push(diskPoint(next, 0, 0, 600));
    else if (k < 12) out.push(diskPoint(next, 0, 0, 300));
    else {
      const c = centres[k - 12];
      out.push(diskPoint(next, c.x, c.y, c.r));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Lua.
// ---------------------------------------------------------------------------

function fieldsDataLua(): string {
  return `-- GENERATED by scripts/probes/aquilo-fields/capture.ts.
-- Each iceberg's own probability_expression, as a named noise expression.
local exprs = {}
for _, n in ipairs({ ${ICEBERGS.map((n) => JSON.stringify(n)).join(", ")} }) do
  local a = data.raw["simple-entity"][n].autoplace
  exprs[n] = a.probability_expression
  data:extend({{
    type = "noise-expression",
    name = "probe_entity_" .. string.gsub(n, "-", "_"),
    expression = a.probability_expression,
    local_expressions = a.local_expressions,
  }})
end
data:extend({{ type = "mod-data", name = "aquilo-fields-probe", data = { icebergExpressions = exprs } }})
`;
}

function censusDataLua(stripEffect: boolean): string {
  return `-- GENERATED by scripts/probes/aquilo-fields/capture.ts.
${
  stripEffect
    ? `for _, n in ipairs({"crude-oil", "lithium-brine", "fluorine-vent"}) do data.raw.resource[n].created_effect = nil end`
    : "-- created_effect left as shipped."
}
`;
}

/** Shared Lua: number encoding and the batch read. */
const LUA_HELPERS = `
-- table_to_json writes -inf and nan as bare words and may lose the sign of
-- zero; send those as strings.
local function encode(vs)
  local out = {}
  for i, v in ipairs(vs) do
    if v ~= v then out[i] = "nan"
    elseif v == math.huge then out[i] = "inf"
    elseif v == -math.huge then out[i] = "-inf"
    elseif v == 0 and 1 / v < 0 then out[i] = "-0"
    else out[i] = v end
  end
  return out
end

local function read(s, names, positions)
  local got = s.calculate_tile_properties(names, positions)
  local out = {}
  for _, n in ipairs(names) do
    local v = got[n]
    -- Unknown property names are dropped; the TypeScript decides what a
    -- missing one means.
    if v then
      assert(#v == #positions, "wrong length for " .. n)
      out[n] = encode(v)
    end
  end
  return out
end

local function set_controls(s, levers, seed)
  local mgs = s.map_gen_settings
  if seed then mgs.seed = seed end
  for n, l in pairs(levers) do
    mgs.autoplace_controls[n] = { frequency = l.frequency, size = l.size, richness = l.richness }
  end
  s.map_gen_settings = mgs
  local back = {}
  for n in pairs(levers) do
    local c = s.map_gen_settings.autoplace_controls[n]
    back[n] = c and { frequency = c.frequency, size = c.size, richness = c.richness } or false
  end
  return back
end
`;

interface FieldsConfig {
  mode: "angle" | "fields";
  seed: number;
  names: string[];
  /** Per case: levers and positions. `angle` mode uses only `default`. */
  cases: Record<string, { levers: Record<string, Lever>; positions: Pos[] }>;
  /** Also read the default case on a created surface, to compare with the planet's. */
  copyCheck: boolean;
}

function fieldsControlLua(cfg: FieldsConfig): string {
  return `-- GENERATED by scripts/probes/aquilo-fields/capture.ts.
local cfg = helpers.json_to_table([==[${JSON.stringify(cfg)}]==])
${LUA_HELPERS}
script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local out = { cases = {}, icebergExpressions = prototypes.mod_data["aquilo-fields-probe"].data.icebergExpressions }
  local planet = game.planets["aquilo"].create_surface()
  local base = planet.map_gen_settings
  local labels = {}
  for label in pairs(cfg.cases) do labels[#labels + 1] = label end
  table.sort(labels)
  for _, label in ipairs(labels) do
    local c = cfg.cases[label]
    local s = (label == "default") and planet or game.create_surface("aquilo-" .. label, base)
    local back = set_controls(s, c.levers, cfg.seed)
    out.cases[label] = { surface = s.name, seed = s.map_gen_settings.seed, controls = back, values = read(s, cfg.names, c.positions) }
  end
  if cfg.copyCheck then
    local c = cfg.cases.default
    local s = game.create_surface("aquilo-default-copy", base)
    local back = set_controls(s, c.levers, cfg.seed)
    out.defaultCopy = { surface = s.name, seed = s.map_gen_settings.seed, controls = back, values = read(s, cfg.names, c.positions) }
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
`;
}

function censusControlLua(): string {
  return `-- GENERATED by scripts/probes/aquilo-fields/capture.ts.
local C = ${String(CENSUS_CHUNKS)}
local LO, HI = -C * 32, C * 32 - 1
script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local s = game.planets["aquilo"].create_surface()
  local mgs = s.map_gen_settings
  local controls = {}
  for _, n in ipairs({ ${CONTROL_NAMES.map((n) => JSON.stringify(n)).join(", ")} }) do
    local c = mgs.autoplace_controls[n]
    controls[n] = c and { frequency = c.frequency, size = c.size, richness = c.richness } or false
  end
  s.request_to_generate_chunks({ 0, 0 }, C)
  s.force_generate_chunk_requests()
  local list = {}
  for _, e in ipairs(s.find_entities_filtered({ type = { "resource", "simple-entity" }, area = { { LO, LO }, { HI + 1, HI + 1 } } })) do
    list[#list + 1] = {
      name = e.name, type = e.type, x = e.position.x, y = e.position.y,
      tile = s.get_tile(e.position).name,
      amount = (e.type == "resource") and e.amount or false,
    }
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json({ seed = mgs.seed, region = { LO, HI }, controls = controls, entities = list }))
  error("DUMPED-OK")
end)
`;
}

// ---------------------------------------------------------------------------
// Running the game.
// ---------------------------------------------------------------------------

async function runOracle(
  install: Install,
  name: string,
  controlLua: string,
  dataLua: string,
): Promise<{ buildLine: string; dump: unknown }> {
  const dir = await mkdtemp(join(tmpdir(), "aquilo-fields-"));
  try {
    await writeFile(join(dir, "control.lua"), controlLua);
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name,
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: join(dir, "control.lua"),
          data_final_fixes_lua: dataLua,
        },
        seed: MAP_SEED,
        timeout_seconds: 1800,
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
      throw new Error(`${install.version} ${name}: no dump`, { cause: oracleError ?? e });
    }
    // Without --version a bad path silently runs another install with exit 0.
    if (!buildLine.includes(`Version: ${install.version} `)) {
      throw new Error(`ran "${buildLine}", wanted ${install.version}`, { cause: oracleError });
    }
    return { buildLine, dump: JSON.parse(text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const hex = (b: number): string => b.toString(16).padStart(8, "0");
function bitsOf(v: number | string, where: string): string {
  if (v === "nan") throw new Error(`${where}: NaN, whose payload Lua cannot show`);
  const n = v === "inf" ? Infinity : v === "-inf" ? -Infinity : v === "-0" ? -0 : Number(v);
  f32[0] = n;
  if (!Object.is(f32[0], n)) throw new Error(`${where}: ${String(v)} is not an exact f32`);
  return hex(u32[0]);
}
const valueOf = (h: string): number => {
  u32[0] = parseInt(h, 16);
  return f32[0];
};

interface CaseDump {
  surface: string;
  seed: number;
  controls: Record<string, Lever | false>;
  values: Record<string, (number | string)[]>;
}
interface FieldsDump {
  cases: Record<string, CaseDump>;
  defaultCopy?: CaseDump;
  icebergExpressions: Record<string, string>;
}
interface CaseRead {
  surface: string;
  seed: number;
  controls: Record<string, Lever | false>;
  bits: Map<string, string[]>;
}
interface FieldsRead {
  version: string;
  buildLine: string;
  cases: Record<string, CaseRead>;
  defaultCopy?: CaseRead;
  icebergExpressions: Record<string, string>;
}

function toRead(d: CaseDump, where: string): CaseRead {
  const bits = new Map<string, string[]>();
  for (const [name, vs] of Object.entries(d.values)) {
    bits.set(
      name,
      vs.map((v, i) => bitsOf(v, `${where} ${name}[${String(i)}]`)),
    );
  }
  return { surface: d.surface, seed: d.seed, controls: d.controls, bits };
}

async function runFields(install: Install, cfg: FieldsConfig): Promise<FieldsRead> {
  const { buildLine, dump } = await runOracle(
    install,
    "aquilo_fields_probe",
    fieldsControlLua(cfg),
    fieldsDataLua(),
  );
  const d = dump as FieldsDump;
  const cases: Record<string, CaseRead> = {};
  for (const [label, c] of Object.entries(d.cases)) {
    cases[label] = toRead(c, `${install.version} ${label}`);
    if (c.seed !== cfg.seed) {
      throw new Error(`${label}: forced seed read back as ${String(c.seed)}`);
    }
    if (cfg.mode === "fields" || label === "default") {
      for (const n of CONTROL_NAMES) {
        const want = cfg.cases[label].levers[n];
        const got = c.controls[n];
        if (
          !got ||
          Math.abs(got.frequency - want.frequency) > 1e-6 ||
          Math.abs(got.size - want.size) > 1e-6 ||
          Math.abs(got.richness - want.richness) > 1e-6
        ) {
          throw new Error(
            `${install.version} ${label} ${n}: control read back as ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`,
          );
        }
      }
    }
  }
  const defaultCopy = d.defaultCopy
    ? toRead(d.defaultCopy, `${install.version} default-copy`)
    : undefined;
  return {
    version: install.version,
    buildLine,
    cases,
    defaultCopy,
    icebergExpressions: d.icebergExpressions,
  };
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

/** Throws on the first bit difference between two reads of the same batch. */
function requireIdentical(a: CaseRead, b: CaseRead, label: string, pos: readonly Pos[]): void {
  if (a.seed !== b.seed) throw new Error(`${label}: seeds ${String(a.seed)} vs ${String(b.seed)}`);
  const ka = [...a.bits.keys()].sort();
  const kb = [...b.bits.keys()].sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) {
    throw new Error(`${label}: different fields came back:\n${ka.join(",")}\n${kb.join(",")}`);
  }
  for (const [name, x] of a.bits) {
    const y = b.bits.get(name) ?? [];
    const at = x.findIndex((h, i) => h !== y[i]);
    if (at >= 0) {
      throw new Error(
        `${label}: ${name}[${String(at)}] at (${String(pos[at][0])}, ${String(pos[at][1])}): ${x[at]} vs ${y[at]}`,
      );
    }
  }
}

/**
 * Pick the iceberg column: the native name and the wrapper must agree wherever
 * both answered. Returns which route answered, and puts the result under the
 * native name.
 */
function resolveIcebergs(r: CaseRead, where: string): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const n of ICEBERGS) {
    const a = r.bits.get(icebergNative(n));
    const b = r.bits.get(icebergWrapper(n));
    if (a && b) {
      const at = a.findIndex((h, i) => h !== b[i]);
      if (at >= 0) {
        throw new Error(`${where} ${n}: routes differ at ${String(at)}: ${a[at]} vs ${b[at]}`);
      }
      routes[n] = "both, bit-identical";
    } else if (a) {
      routes[n] = "native only";
    } else if (b) {
      routes[n] = "wrapper only";
      r.bits.set(icebergNative(n), b);
    } else {
      throw new Error(`${where} ${n}: neither route answered`);
    }
    r.bits.delete(icebergWrapper(n));
  }
  return routes;
}

function requireAllFields(r: CaseRead, where: string): void {
  const missing = FIELDS.filter((f) => !r.bits.has(f));
  if (missing.length > 0) throw new Error(`${where}: no value came back for ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Census.
// ---------------------------------------------------------------------------

interface CensusEntity {
  name: string;
  type: string;
  x: number;
  y: number;
  tile: string;
  amount: number | false;
}
interface CensusDump {
  seed: number;
  region: [number, number];
  controls: Record<string, Lever | false>;
  entities: CensusEntity[];
}

const byPosition = (a: CensusEntity, b: CensusEntity): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.x !== b.x ? a.x - b.x : a.y - b.y;

async function runCensus(
  install: Install,
  stripEffect: boolean,
): Promise<{ buildLine: string; d: CensusDump }> {
  const { buildLine, dump } = await runOracle(
    install,
    "aquilo_census_probe",
    censusControlLua(),
    censusDataLua(stripEffect),
  );
  const d = dump as CensusDump;
  if (d.seed !== DERIVED_SEED) {
    throw new Error(`census: surface seed ${String(d.seed)}, wanted ${String(DERIVED_SEED)}`);
  }
  for (const n of CONTROL_NAMES) {
    const c = d.controls[n];
    if (!c || c.frequency !== 1 || c.size !== 1 || c.richness !== 1) {
      throw new Error(`census: ${n} reads ${JSON.stringify(c)}, wanted 1/1/1`);
    }
  }
  d.entities.sort(byPosition);
  return { buildLine, d };
}

function tally<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function tilesUnder(es: { name: string; t: string }[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const name of [...new Set(es.map((e) => e.name))].sort()) {
    out[name] = tally(
      es.filter((e) => e.name === name),
      (e) => e.t,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const shortBuild = (b: string): string => b.replace(/^Version: /, "");

async function main(): Promise<void> {
  const [primaryInstall] = INSTALLS;

  // 1. The angle, for the cone clusters. The default case only, at the origin.
  const angleRun = await runFields(primaryInstall, {
    mode: "angle",
    seed: FORCED_SEED,
    names: ["aquilo_angle"],
    cases: { default: { levers: CASES.default, positions: [[0, 0]] } },
    copyCheck: false,
  });
  const angleBits = angleRun.cases.default.bits.get("aquilo_angle");
  if (!angleBits) throw new Error("aquilo_angle did not come back");
  const angle = valueOf(angleBits[0]);
  const centres = coneCentres(angle);
  console.log(`aquilo_angle ${String(angle)} (${angleBits[0]}); ${angleRun.buildLine}`);
  for (const c of centres) console.log(`  ${c.name} centre (${String(c.x)}, ${String(c.y)})`);

  // 2. Scout every case over the whole pool on the primary install.
  const pl = pool(centres);
  const scoutNames = [...new Set([...QUOTAS.map((q) => q.field), ...ICEBERGS.map(icebergWrapper)])];
  const scout = await runFields(primaryInstall, {
    mode: "fields",
    seed: FORCED_SEED,
    names: scoutNames,
    cases: Object.fromEntries(CASE_LABELS.map((l) => [l, { levers: CASES[l], positions: pl }])),
    copyCheck: false,
  });
  console.log(`scout: ${String(pl.length)} positions x ${String(CASE_LABELS.length)} cases`);

  const chosen: Record<string, number[]> = {};
  const quotaReport: Record<
    string,
    Record<
      string,
      {
        test: string;
        inPool: number;
        kept: number;
        shortfall: number;
        poolMin: number;
        poolMax: number;
      }
    >
  > = {};
  for (const label of CASE_LABELS) {
    const r = scout.cases[label];
    resolveIcebergs(r, `scout ${label}`);
    const keep = new Set<number>();
    quotaReport[label] = {};
    for (const q of QUOTAS) {
      const col = r.bits.get(q.field);
      if (!col) throw new Error(`scout ${label}: no ${q.field}`);
      const vals = col.map(valueOf);
      const hits = vals.map((v, i) => (q.pass(v) ? i : -1)).filter((i) => i >= 0);
      const kept = hits.slice(0, QUOTA);
      for (const i of kept) keep.add(i);
      quotaReport[label][q.field] = {
        test: q.test,
        inPool: hits.length,
        kept: kept.length,
        shortfall: QUOTA - kept.length,
        poolMin: vals.reduce((a, b) => Math.min(a, b)),
        poolMax: vals.reduce((a, b) => Math.max(a, b)),
      };
    }
    const quotaKept = keep.size;
    for (let i = 0, added = 0; i < pl.length && added < EXTRA; i++) {
      if (!keep.has(i)) {
        keep.add(i);
        added++;
      }
    }
    chosen[label] = [...keep].sort((a, b) => a - b);
    console.log(
      `  ${label}: ${String(quotaKept)} quota positions + ${String(chosen[label].length - quotaKept)} others`,
    );
    for (const [f, q] of Object.entries(quotaReport[label])) {
      console.log(
        `    ${f} ${q.test}: ${String(q.inPool)} in pool (range ${String(q.poolMin)}..${String(q.poolMax)}), kept ${String(q.kept)}${q.shortfall > 0 ? `, SHORT BY ${String(q.shortfall)}` : ""}`,
      );
    }
  }

  // 3. The final batches, on every install. One run holds every case.
  const finalNames = [...FIELDS, ...ICEBERGS.map(icebergWrapper)];
  const finalCfg: FieldsConfig = {
    mode: "fields",
    seed: FORCED_SEED,
    names: finalNames,
    cases: Object.fromEntries(
      CASE_LABELS.map((l) => [l, { levers: CASES[l], positions: chosen[l].map((i) => pl[i]) }]),
    ),
    copyCheck: true,
  };
  const finals: FieldsRead[] = [];
  const routes: Record<string, Record<string, Record<string, string>>> = {};
  for (const install of INSTALLS) {
    const r = await runFields(install, finalCfg);
    console.log(`final: ${r.buildLine}`);
    for (const [n, e] of Object.entries(ICEBERG_EXPRESSIONS)) {
      if (r.icebergExpressions[n] !== e) {
        throw new Error(
          `${r.version} ${n}: probability_expression is "${r.icebergExpressions[n]}", wanted "${e}"`,
        );
      }
    }
    routes[r.version] = {};
    for (const label of CASE_LABELS) {
      routes[r.version][label] = resolveIcebergs(r.cases[label], `${r.version} ${label}`);
      requireAllFields(r.cases[label], `${r.version} ${label}`);
    }
    if (!r.defaultCopy) throw new Error("no default-copy read");
    resolveIcebergs(r.defaultCopy, `${r.version} default-copy`);
    requireIdentical(
      r.cases.default,
      r.defaultCopy,
      `${r.version} planet surface vs created surface`,
      finalCfg.cases.default.positions,
    );
    finals.push(r);
  }
  const [primary, ...others] = finals;
  for (const o of others) {
    for (const label of CASE_LABELS) {
      requireIdentical(
        primary.cases[label],
        o.cases[label],
        `${label} ${o.version} vs ${primary.version}`,
        finalCfg.cases[label].positions,
      );
      if (JSON.stringify(primary.cases[label].controls) !== JSON.stringify(o.cases[label].controls))
        throw new Error(`${label}: controls read back differently on ${o.version}`);
    }
  }
  console.log("  every case bit-identical across versions; planet surface = created surface");

  // Batch independence: the scout read the same positions in a bigger batch.
  let batchDiffs = 0;
  let batchCompared = 0;
  for (const label of CASE_LABELS) {
    for (const q of QUOTAS) {
      const a = primary.cases[label].bits.get(q.field) ?? [];
      const b = scout.cases[label].bits.get(q.field) ?? [];
      chosen[label].forEach((pi, k) => {
        batchCompared++;
        if (a[k] !== b[pi]) batchDiffs++;
      });
    }
  }
  console.log(
    `  values that differ from the scout batch: ${String(batchDiffs)} of ${String(batchCompared)}`,
  );
  if (batchDiffs > 0) throw new Error("the final batch disagrees with the scout batch");

  // Per case, how many final positions pass each quota test, and a NaN-free check.
  const finalPassing: Record<string, Record<string, number>> = {};
  for (const label of CASE_LABELS) {
    finalPassing[label] = {};
    for (const q of QUOTAS) {
      const col = primary.cases[label].bits.get(q.field) ?? [];
      finalPassing[label][q.field] = col.filter((h) => q.pass(valueOf(h))).length;
    }
  }

  const otherBuilds = others.map((o) => shortBuild(o.buildLine));
  const fieldsComment =
    `Ground truth from Factorio ${shortBuild(primary.buildLine)}, read with calculate_tile_properties with ` +
    `map_gen_settings.seed FORCED to ${String(FORCED_SEED)} (map seed ${String(MAP_SEED)}). Three lever cases, each ` +
    `setting all three Aquilo resource controls (aquilo_crude_oil, lithium_brine, fluorine_vent) and reading them ` +
    `back (\`controls\` holds the read-back values). The default case is game.planets["aquilo"].create_surface(); ` +
    `the others are game.create_surface() with its map_gen_settings, and the default case read on such a copy came ` +
    `back bit-identical to the planet surface. Each case is one batch, in the order of its \`positions\` (1/256 grid, ` +
    `within ${String(POOL_RADIUS)} tiles of the origin); each field is the hex of its f32, one per position. ` +
    `entity:<name>:probability: see \`icebergRoutes\` for which route answered; the data-stage route is the iceberg ` +
    `prototype's own probability_expression as a named noise expression. Cross-checked: ${otherBuilds.join("; ")} ` +
    `returned bit-identical values for every case. Positions: per case, the first ${String(QUOTA)} positions of a ` +
    `${String(POOL)}-position scout pool where each quota field passes its test, then the first ${String(EXTRA)} ` +
    `others, in pool order; \`quotas\` records any shortfall. Captured by scripts/probes/aquilo-fields.`;

  const lines: string[] = [
    "{",
    `  "_comment": ${JSON.stringify(fieldsComment)},`,
    `  "_factorioVersion": ${JSON.stringify(primary.version)},`,
    `  "_buildLines": ${JSON.stringify(finals.map((f) => f.buildLine))},`,
    `  "_crossChecked": ${JSON.stringify(others.map((o) => o.version))},`,
    `  "planet": "aquilo",`,
    `  "seed": ${String(FORCED_SEED)},`,
    `  "aquiloAngle": ${JSON.stringify({ value: angle, bits: angleBits[0] })},`,
    `  "coneClusterCentres": ${JSON.stringify(centres)},`,
    `  "icebergExpressions": ${JSON.stringify(primary.icebergExpressions)},`,
    `  "icebergRoutes": ${JSON.stringify(routes)},`,
    `  "quotas": ${JSON.stringify(quotaReport)},`,
    `  "finalPassing": ${JSON.stringify(finalPassing)},`,
    '  "cases": {',
  ];
  CASE_LABELS.forEach((label, ci) => {
    const c = primary.cases[label];
    lines.push(`    ${JSON.stringify(label)}: {`);
    lines.push(`      "controls": ${JSON.stringify(c.controls)},`);
    lines.push(`      "positions": ${JSON.stringify(finalCfg.cases[label].positions)},`);
    lines.push('      "fields": {');
    FIELDS.forEach((f, k) => {
      lines.push(
        `        ${JSON.stringify(f)}: ${JSON.stringify(c.bits.get(f))}${k < FIELDS.length - 1 ? "," : ""}`,
      );
    });
    lines.push("      }");
    lines.push(`    }${ci < CASE_LABELS.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}", "");

  // 4. The census, as shipped and with the wells' created_effect removed, on every install.
  const census: {
    version: string;
    buildLine: string;
    shipped: CensusDump;
    noEffect: CensusDump;
  }[] = [];
  for (const install of INSTALLS) {
    const a = await runCensus(install, false);
    const b = await runCensus(install, true);
    if (a.buildLine !== b.buildLine) throw new Error("census runs used different builds");
    const key = (e: CensusEntity): string => `${e.name}@${String(e.x)},${String(e.y)}`;
    if (JSON.stringify(a.d.entities.map(key)) !== JSON.stringify(b.d.entities.map(key))) {
      throw new Error(`${install.version}: the entities differ with the effect removed`);
    }
    console.log(`census: ${a.buildLine}, ${String(a.d.entities.length)} entities`);
    census.push({ version: install.version, buildLine: a.buildLine, shipped: a.d, noEffect: b.d });
  }
  const [c0, ...cRest] = census;
  const censusDiffs: Record<string, string> = {};
  for (const o of cRest) {
    const same =
      JSON.stringify(o.shipped.entities) === JSON.stringify(c0.shipped.entities) &&
      JSON.stringify(o.noEffect.entities) === JSON.stringify(c0.noEffect.entities);
    censusDiffs[o.version] = same
      ? "identical (names, positions, amounts, tiles under, both arms)"
      : "DIFFERENT";
    console.log(`  census ${o.version} vs ${c0.version}: ${censusDiffs[o.version]}`);
  }
  const ents = c0.shipped.entities.map((e, i) => ({
    ...e,
    tileWithoutEffect: c0.noEffect.entities[i].tile,
  }));
  const totals = tally(ents, (e) => e.name);
  const under = tilesUnder(ents.map((e) => ({ name: e.name, t: e.tile })));
  const underNoEffect = tilesUnder(ents.map((e) => ({ name: e.name, t: e.tileWithoutEffect })));
  console.log(`  totals ${JSON.stringify(totals)}`);
  console.log(`  tiles under (shipped) ${JSON.stringify(under)}`);
  console.log(`  tiles under (no effect) ${JSON.stringify(underNoEffect)}`);

  const censusComment =
    `Ground truth from Factorio ${shortBuild(c0.buildLine)}: game.planets["aquilo"].create_surface() with its ` +
    `DERIVED seed ${String(DERIVED_SEED)} (map seed ${String(MAP_SEED)}, read back) and the three resource controls ` +
    `read back as 1/1/1. request_to_generate_chunks({0,0}, ${String(CENSUS_CHUNKS)}) then ` +
    `force_generate_chunk_requests(); every resource and simple-entity found over tiles ${String(c0.shipped.region[0])}..` +
    `${String(c0.shipped.region[1])} (the planet-autoplace region), sorted by name, x, y. \`tile\` is ` +
    `surface.get_tile(position).name as shipped; \`tileWithoutEffect\` is the same read in a second run with ` +
    `created_effect removed from crude-oil, lithium-brine and fluorine-vent in data-final-fixes, where the entity ` +
    `list (name and position) was asserted identical. The wells' created_effect rewrites tiles near them during map ` +
    `generation, so \`tileWithoutEffect\` is the tile the autoplace saw. amount is the resource amount (false for ` +
    `simple-entity). Cross-checked: ${cRest.map((o) => `${shortBuild(o.buildLine)} ${censusDiffs[o.version]}`).join("; ")}. ` +
    `Captured by scripts/probes/aquilo-fields.`;
  const censusLines = [
    "{",
    `  "_comment": ${JSON.stringify(censusComment)},`,
    `  "_factorioVersion": ${JSON.stringify(c0.version)},`,
    `  "_buildLines": ${JSON.stringify(census.map((c) => c.buildLine))},`,
    `  "_crossChecked": ${JSON.stringify(censusDiffs)},`,
    `  "mapSeed": ${String(MAP_SEED)},`,
    `  "surfaceSeed": ${String(DERIVED_SEED)},`,
    `  "region": ${JSON.stringify(c0.shipped.region)},`,
    `  "totals": ${JSON.stringify(totals)},`,
    `  "tilesUnder": ${JSON.stringify(under)},`,
    `  "tilesUnderWithoutEffect": ${JSON.stringify(underNoEffect)},`,
    '  "entities": [',
    ...ents.map(
      (e, i) =>
        `    ${JSON.stringify([e.name, e.x, e.y, e.tile, e.tileWithoutEffect, e.amount])}${i < ents.length - 1 ? "," : ""}`,
    ),
    "  ],",
    `  "entityColumns": ["name", "x", "y", "tile", "tileWithoutEffect", "amount"]`,
    "}",
    "",
  ];

  // A census that differs between versions is written from the primary, with
  // the difference recorded in `_crossChecked`; the fields already threw.
  if (Object.values(censusDiffs).includes("DIFFERENT")) {
    console.log("  NOTE: the census differs between versions; written from the primary");
  }
  await writeFile(FIELDS_OUT, lines.join("\n"));
  console.log(`wrote ${FIELDS_OUT}`);
  await writeFile(CENSUS_OUT, censusLines.join("\n"));
  console.log(`wrote ${CENSUS_OUT}`);
}

await main();
