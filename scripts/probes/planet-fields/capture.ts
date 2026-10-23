/**
 * Gleba's and Aquilo's tier-1 fields, read out of the game.
 *
 *   node --experimental-strip-types scripts/probes/planet-fields/capture.ts \
 *     --factoriotools <dir holding gleba-123.json and aquilo-123.json>
 *
 * Run from the repository root. It runs both installs below through
 * `factorio-oracle` and writes `test/fixtures/oracle-gleba-fields.seed123456.json`
 * and `test/fixtures/oracle-aquilo-fields.seed123456.json`. Read `README.md`
 * beside this file for what it found.
 *
 * ## What it reads
 *
 * `elevation`, `aux`, `moisture`, `temperature` and every tile score the
 * planet's surface lists in `autoplace_settings.tile.settings`, through
 * `calculate_tile_properties`. Each tile score is read two ways in one run:
 * the property name `tile:<name>:probability`, and a data-stage noise
 * expression `t_tile_<name>` = `var('tile:<name>:probability')`. The two must
 * agree bit for bit wherever both come back.
 *
 * ## The cross-check
 *
 * malte9799/FactorioTools (MIT, `packages/mapgen`) captured the same fields
 * from 2.0.77 with its own harness: MAP seed 123, the planet's surface from
 * `create_surface()` with its DERIVED seed, 100 integer positions in one batch,
 * and the same `var(...)` route under the same `t_tile_*` names. Its values are
 * `%.9g` decimals packed into f32, which recovers an f32 exactly. This probe
 * repeats that run on both installs and refuses to write unless 2.0.77 agrees
 * with their files bit for bit at every shared field. Their files are read as
 * data only, from the directory passed with `--factoriotools`; nothing of
 * theirs is committed. Their position generator is mirrored below and checked
 * against the positions stored in their files.
 *
 * ## Our capture
 *
 * The tier-1 convention: map seed 123456 and the surface seed FORCED to 123456.
 * A scout run on the first install reads a pool of 16,384 positions, and the
 * 1,024 kept are the first 4 pool positions where each tile wins the argmax,
 * filled up with pool positions in pool order. The final batch is then read on
 * both installs, which must agree bit for bit, and every tile that has a score
 * must win at least once in it. The fixture stores the values from that final
 * batch, read in the stored order.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");
const FACTORIOTOOLS_SHA = "e1ac68ee750488d7b8b03574e5747f81c672fce0";

/** The first install is the primary; the rest must match it bit for bit. */
const INSTALLS = [
  {
    root: "/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio",
    version: "2.1.23",
  },
  { root: "/home/eric/factorio-headless-2.0.77", version: "2.0.77" },
] as const;
type Install = (typeof INSTALLS)[number];

const PLANETS = ["gleba", "aquilo"] as const;
type Planet = (typeof PLANETS)[number];

const FORCED_SEED = 123456;
const THEIR_MAP_SEED = 123;
const COUNT = 1024;
const POOL = 16384;
/** Each tile gets up to this many of its own pool winners in the final batch. */
const PER_TILE = 4;
const CLIMATE = ["elevation", "moisture", "aux", "temperature"] as const;

type Pos = readonly [number, number];

// ---------------------------------------------------------------------------
// Positions.
// ---------------------------------------------------------------------------

/**
 * FactorioTools' `positions(count, spread, salt)` from
 * `packages/mapgen/scripts/make-fixtures.ts`, mirrored so the cross-check run
 * asks for exactly their batch. Checked against their stored list below.
 */
function theirPositions(count: number, spread: number, salt: number): Pos[] {
  const out: Pos[] = [];
  let s = salt;
  const rand = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    out.push([Math.round((rand() - 0.5) * spread), Math.round((rand() - 0.5) * spread)]);
  }
  return out;
}
/** Their planet fixtures all use this list. */
const THEIR_POSITIONS = [...theirPositions(40, 320, 8), ...theirPositions(60, 6000, 9)];

/**
 * The scout pool: points on the 1/256 grid, cycling through four square
 * half-widths so near-spawn and far-out terrain both appear early in pool
 * order. The origin and two exact half-tile points come first.
 */
function pool(): Pos[] {
  let s = 0x2545f491;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const grid = (half: number): number => Math.floor((next() * 2 - 1) * half * 256) / 256;
  const halves = [256, 1024, 4096, 16384];
  const out: Pos[] = [
    [0, 0],
    [0.5, 0.5],
    [-0.5, -0.5],
  ];
  for (let i = 0; out.length < POOL; i++) {
    const h = halves[i % halves.length];
    out.push([grid(h), grid(h)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Lua.
// ---------------------------------------------------------------------------

const underscored = (n: string): string => n.replace(/-/g, "_");

/**
 * One `t_tile_<name>` per tile any of the two planets lists, as FactorioTools
 * defines them: `var('tile:<name>:probability')`. Tiles with no autoplace are
 * skipped, as theirs are.
 */
function dataFinalFixesLua(): string {
  return `-- GENERATED by scripts/probes/planet-fields/capture.ts.
local done = {}
for _, planet in ipairs({ ${PLANETS.map((p) => JSON.stringify(p)).join(", ")} }) do
  local mgs = data.raw.planet[planet].map_gen_settings
  for name in pairs(mgs.autoplace_settings.tile.settings) do
    if not done[name] and data.raw.tile[name] and data.raw.tile[name].autoplace then
      done[name] = true
      data:extend({{
        type = "noise-expression",
        name = "t_tile_" .. string.gsub(name, "-", "_"),
        expression = "var('tile:" .. name .. ":probability')",
      }})
    end
  end
end
`;
}

interface RunConfig {
  /** null keeps the surface's derived seed. */
  forceSeed: number | null;
  /** Also read the `tile:<name>:probability` route. */
  native: boolean;
  /** Read the four climate fields too. */
  climate: boolean;
  positions: Pos[];
  planets: readonly Planet[];
}

function controlLua(cfg: RunConfig): string {
  return `-- GENERATED by scripts/probes/planet-fields/capture.ts.
local cfg = helpers.json_to_table([==[${JSON.stringify(cfg)}]==])
local CLIMATE = { ${CLIMATE.map((c) => JSON.stringify(c)).join(", ")} }

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

local function read(s, names, o)
  local got = s.calculate_tile_properties(names, cfg.positions)
  for _, n in ipairs(names) do
    local v = got[n]
    -- Unknown property names are silently dropped; the TypeScript decides
    -- what a missing one means.
    if v then
      assert(#v == #cfg.positions, "wrong length for " .. n)
      o.values[n] = encode(v)
    end
  end
end

script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local out = { planets = {} }
  for _, planet in ipairs(cfg.planets) do
    local s = game.planets[planet].create_surface()
    if cfg.forceSeed then
      local mgs = s.map_gen_settings
      mgs.seed = cfg.forceSeed
      s.map_gen_settings = mgs
    end
    local tiles = {}
    for n in pairs(s.map_gen_settings.autoplace_settings.tile.settings) do tiles[#tiles + 1] = n end
    table.sort(tiles)
    local o = { seed = s.map_gen_settings.seed, tiles = tiles, values = {} }
    -- One batch for the var route with the climate fields, as FactorioTools reads them.
    local names = {}
    if cfg.climate then for _, c in ipairs(CLIMATE) do names[#names + 1] = c end end
    for _, n in ipairs(tiles) do names[#names + 1] = "t_tile_" .. string.gsub(n, "-", "_") end
    read(s, names, o)
    if cfg.native then
      local native = {}
      for _, n in ipairs(tiles) do native[#native + 1] = "tile:" .. n .. ":probability" end
      read(s, native, o)
    end
    out.planets[planet] = o
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
`;
}

// ---------------------------------------------------------------------------
// Running the game.
// ---------------------------------------------------------------------------

interface PlanetDump {
  seed: number;
  tiles: string[];
  values: Record<string, (number | string)[]>;
}

interface PlanetRead {
  seed: number;
  tiles: string[];
  /** property name -> f32 bits as hex, one per position. */
  bits: Map<string, string[]>;
}

interface RunResult {
  version: string;
  buildLine: string;
  planets: Record<Planet, PlanetRead>;
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

async function runOracle(install: Install, mapSeed: number, cfg: RunConfig): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "planet-fields-"));
  try {
    await writeFile(join(dir, "control.lua"), controlLua(cfg));
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "planet_fields_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: join(dir, "control.lua"),
          data_final_fixes_lua: dataFinalFixesLua(),
        },
        seed: mapSeed,
        timeout_seconds: 900,
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
    const dump = JSON.parse(text) as { planets: Record<Planet, PlanetDump> };
    const planets = {} as Record<Planet, PlanetRead>;
    for (const p of cfg.planets) {
      const d = dump.planets[p];
      const bits = new Map<string, string[]>();
      for (const [name, vs] of Object.entries(d.values)) {
        bits.set(
          name,
          vs.map((v, i) => bitsOf(v, `${install.version} ${p} ${name}[${String(i)}]`)),
        );
      }
      planets[p] = { seed: d.seed, tiles: d.tiles, bits };
    }
    return { version: install.version, buildLine, planets };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

const varName = (tile: string): string => `t_tile_${underscored(tile)}`;
const nativeName = (tile: string): string => `tile:${tile}:probability`;

/** The tiles whose var-route score came back. */
const scoredTiles = (r: PlanetRead): string[] => r.tiles.filter((t) => r.bits.has(varName(t)));

/**
 * The native route must agree with the var route wherever it came back.
 * Returns how many tiles the native route answered.
 */
function checkRoutes(r: PlanetRead, where: string): number {
  let answered = 0;
  for (const t of r.tiles) {
    const a = r.bits.get(nativeName(t));
    const b = r.bits.get(varName(t));
    if (!a) continue;
    answered++;
    if (!b) throw new Error(`${where} ${t}: native route answered, var route did not`);
    const at = a.findIndex((h, i) => h !== b[i]);
    if (at >= 0)
      throw new Error(`${where} ${t}: routes differ at ${String(at)}: ${a[at]} vs ${b[at]}`);
  }
  return answered;
}

/** Strict argmax per position; NaN never wins, a tie has no winner. */
function winners(r: PlanetRead, n: number): (string | null)[] {
  const tiles = scoredTiles(r);
  const cols = tiles.map((t) => (r.bits.get(varName(t)) ?? []).map(valueOf));
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let who: string | null = null;
    let tie = false;
    tiles.forEach((t, k) => {
      const v = cols[k][i];
      if (Number.isNaN(v)) return;
      if (v > best) {
        best = v;
        who = t;
        tie = false;
      } else if (v === best) tie = true;
    });
    out.push(tie || best === -Infinity ? null : who);
  }
  return out;
}

function winCounts(r: PlanetRead, n: number): Record<string, number> {
  const counts: Record<string, number> = { "(tie or none)": 0 };
  for (const t of scoredTiles(r)) counts[t] = 0;
  for (const w of winners(r, n)) counts[w ?? "(tie or none)"]++;
  return counts;
}

/** Throws on the first bit difference between two reads of the same batch. */
function requireIdentical(a: PlanetRead, b: PlanetRead, label: string, pos: readonly Pos[]): void {
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

interface CrossScore {
  fields: number;
  mismatches: string[];
  /** Fields we read and their file lacks. */
  theirsMissing: string[];
}

interface TheirFixture {
  seed: number;
  planet: string;
  positions: [number, number][];
  values: Record<string, string>;
}

/**
 * Compare one of our cross-check reads with their file. A field they lack is a
 * NOTE, not a mismatch: their writer skips any name the game did not return.
 * Every value both sides hold must agree bit for bit.
 */
function scoreAgainstTheirs(ours: PlanetRead, theirs: TheirFixture, label: string): CrossScore {
  const n = theirs.positions.length;
  const mismatches: string[] = [];
  const theirsMissing: string[] = [];
  let fields = 0;
  const wanted = [...CLIMATE, ...ours.tiles.map(varName)];
  for (const name of wanted) {
    const mine = ours.bits.get(name);
    const b64 = theirs.values[name];
    if (!mine && !b64) continue;
    if (mine && !b64) {
      theirsMissing.push(name);
      continue;
    }
    if (!mine || !b64) {
      mismatches.push(`${name}: theirs has it, ours does not`);
      continue;
    }
    fields++;
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 4 * n)
      throw new Error(`${label} ${name}: their column has ${String(buf.length)} bytes`);
    let diff = 0;
    let first = -1;
    for (let i = 0; i < n; i++) {
      const h = hex(buf.readUInt32LE(4 * i));
      if (h !== mine[i]) {
        diff++;
        if (first < 0) first = i;
      }
    }
    if (diff > 0) {
      const h = hex(buf.readUInt32LE(4 * first));
      mismatches.push(
        `${name}: ${String(diff)}/${String(n)} differ; first at (${String(theirs.positions[first][0])}, ${String(theirs.positions[first][1])}): ours ${mine[first]} (${String(valueOf(mine[first]))}), theirs ${h} (${String(valueOf(h))})`,
      );
    }
  }
  // Their keys we never asked for are their entity rows; list any other.
  for (const k of Object.keys(theirs.values)) {
    if (!k.startsWith("t_entity_") && !wanted.includes(k)) mismatches.push(`${k}: theirs only`);
  }
  return { fields, mismatches, theirsMissing };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const shortBuild = (b: string): string => b.replace(/^Version: /, "");

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--factoriotools");
  const theirDir = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (!theirDir)
    throw new Error("pass --factoriotools <dir> with their gleba-123.json and aquilo-123.json");
  const theirs = {} as Record<Planet, TheirFixture>;
  for (const p of PLANETS) {
    theirs[p] = JSON.parse(await readFile(join(theirDir, `${p}-123.json`), "utf8")) as TheirFixture;
    if (theirs[p].seed !== THEIR_MAP_SEED || theirs[p].planet !== p)
      throw new Error(`${p}: their file is not seed 123 ${p}`);
    if (JSON.stringify(theirs[p].positions) !== JSON.stringify(THEIR_POSITIONS)) {
      throw new Error(`${p}: their positions are not the mirrored generator's`);
    }
  }

  // 1. The cross-check: their convention, every install.
  console.log("cross-check runs (map seed 123, derived surface seeds)");
  const cross: RunResult[] = [];
  for (const install of INSTALLS) {
    const r = await runOracle(install, THEIR_MAP_SEED, {
      forceSeed: null,
      native: true,
      climate: true,
      positions: THEIR_POSITIONS,
      planets: PLANETS,
    });
    console.log(`  ${r.buildLine}`);
    for (const p of PLANETS) {
      const want = (THEIR_MAP_SEED + crc32(p)) >>> 0;
      if (r.planets[p].seed !== want)
        throw new Error(`${p}: derived seed ${String(r.planets[p].seed)}, wanted ${String(want)}`);
    }
    cross.push(r);
  }
  const crossScores: Record<string, Record<Planet, CrossScore>> = {};
  for (const r of cross) {
    crossScores[r.version] = {} as Record<Planet, CrossScore>;
    for (const p of PLANETS) {
      const s = scoreAgainstTheirs(r.planets[p], theirs[p], `${r.version} ${p}`);
      crossScores[r.version][p] = s;
      console.log(
        `  ${r.version} ${p} vs FactorioTools: ${String(s.fields)} fields x ${String(THEIR_POSITIONS.length)}, ` +
          `${s.mismatches.length === 0 ? "bit-identical" : `${String(s.mismatches.length)} MISMATCHED`}`,
      );
      for (const m of s.mismatches) console.log(`    ${m}`);
      if (s.theirsMissing.length > 0)
        console.log(`    not in their file: ${s.theirsMissing.join(", ")}`);
    }
  }
  const at2077 = crossScores["2.0.77"];
  if (PLANETS.some((p) => at2077[p].mismatches.length > 0)) {
    throw new Error(
      "2.0.77 disagrees with FactorioTools; one of the two harnesses is wrong. Nothing written.",
    );
  }

  // 2. Scout the pool on the primary install, then pick the batch.
  const [primaryInstall] = INSTALLS;
  const pl = pool();
  console.log(`scout run: ${String(pl.length)} positions, forced seed ${String(FORCED_SEED)}`);
  const scout = await runOracle(primaryInstall, FORCED_SEED, {
    forceSeed: FORCED_SEED,
    native: false,
    climate: false,
    positions: pl,
    planets: PLANETS,
  });
  const chosen = new Map<Planet, number[]>();
  for (const p of PLANETS) {
    const r = scout.planets[p];
    if (r.seed !== FORCED_SEED) throw new Error(`${p}: forced seed read back as ${String(r.seed)}`);
    const w = winners(r, pl.length);
    const keep = new Set<number>();
    for (const t of scoredTiles(r)) {
      let got = 0;
      for (let i = 0; i < w.length && got < PER_TILE; i++) {
        if (w[i] === t) {
          keep.add(i);
          got++;
        }
      }
      if (got === 0)
        throw new Error(
          `${p}: ${t} never wins in the ${String(pl.length)}-position pool; widen it`,
        );
    }
    for (let i = 0; keep.size < COUNT; i++) keep.add(i);
    chosen.set(
      p,
      [...keep].sort((a, b) => a - b),
    );
    console.log(`  ${p}: pool win counts ${JSON.stringify(winCounts(r, pl.length))}`);
  }

  // 3. The final batch per planet, on every install. Each planet has its own
  //    positions, so each gets its own run.
  for (const p of PLANETS) {
    const idx = chosen.get(p) ?? [];
    const pos = idx.map((i) => pl[i]);
    const finals: RunResult[] = [];
    for (const install of INSTALLS) {
      const r = await runOracle(install, FORCED_SEED, {
        forceSeed: FORCED_SEED,
        native: true,
        climate: true,
        positions: pos,
        planets: [p],
      });
      console.log(`  ${p} final: ${r.buildLine}`);
      finals.push(r);
    }
    const [primary, ...others] = finals;
    const pr = primary.planets[p];
    if (pr.seed !== FORCED_SEED)
      throw new Error(`${p}: forced seed read back as ${String(pr.seed)}`);
    for (const o of others)
      requireIdentical(pr, o.planets[p], `${p} ${o.version} vs ${primary.version}`, pos);

    const nativeAnswered: Record<string, number> = {};
    for (const r of finals)
      nativeAnswered[r.version] = checkRoutes(r.planets[p], `${r.version} ${p}`);
    const tiles = scoredTiles(pr);
    const dropped = pr.tiles.filter((t) => !tiles.includes(t));
    for (const c of CLIMATE) if (!pr.bits.has(c)) throw new Error(`${p}: no ${c}`);

    const counts = winCounts(pr, pos.length);
    const never = tiles.filter((t) => counts[t] === 0);
    if (never.length > 0)
      throw new Error(`${p}: never wins in the final batch: ${never.join(", ")}`);
    console.log(`  ${p}: final win counts ${JSON.stringify(counts)}`);

    // Batch independence: the scout read the same positions in a bigger batch.
    let batchDiffs = 0;
    for (const t of tiles) {
      const a = pr.bits.get(varName(t)) ?? [];
      const b = scout.planets[p].bits.get(varName(t)) ?? [];
      idx.forEach((pi, k) => {
        if (a[k] !== b[pi]) batchDiffs++;
      });
    }
    console.log(`  ${p}: values that differ from the scout batch: ${String(batchDiffs)}`);

    const s77 = at2077[p];
    const otherBuilds = others.map((o) => shortBuild(o.buildLine));
    const comment =
      `Ground truth from Factorio ${shortBuild(primary.buildLine)}, read with calculate_tile_properties on ` +
      `game.planets["${p}"].create_surface() with map_gen_settings.seed FORCED to ${String(FORCED_SEED)} ` +
      `(map seed ${String(FORCED_SEED)}). One batch, in the order of \`positions\` (1/256 grid). Each field is ` +
      "the hex of its f32, one per position. `tiles` are the tile scores, keyed by tile name: read as " +
      "'tile:<name>:probability' and as a data-stage var('tile:<name>:probability') expression, bit-identical " +
      `wherever both answered. ${dropped.length > 0 ? `No score came back for ${dropped.join(", ")}, so it is left out. ` : ""}` +
      `Cross-checked: ${otherBuilds.join("; ")} returned bit-identical values. The same probe, run in ` +
      `malte9799/FactorioTools' convention (map seed 123, derived seed), agrees bit for bit with their ` +
      `${FACTORIOTOOLS_SHA} packages/mapgen/test/fixtures/${p}-123.json at their ${String(THEIR_POSITIONS.length)} ` +
      `positions on 2.0.77 (${String(s77.fields)} fields)` +
      (s77.theirsMissing.length > 0
        ? `; their file has no column for ${s77.theirsMissing.join(", ")}`
        : "") +
      `. Positions: the first ${String(PER_TILE)} positions of a ` +
      `${String(POOL)}-position scout pool where each tile wins the strict argmax, filled up in pool order. ` +
      "Captured by scripts/probes/planet-fields.";

    const out = {
      _comment: comment,
      _factorioVersion: primary.version,
      _crossChecked: others.map((o) => o.version),
      _crossCheckedAgainst: `malte9799/FactorioTools ${FACTORIOTOOLS_SHA} packages/mapgen/test/fixtures/${p}-123.json`,
      planet: p,
      seed: FORCED_SEED,
      nativeRouteAnswered: nativeAnswered,
      winCounts: counts,
      positions: pos,
      climate: Object.fromEntries(CLIMATE.map((c) => [c, pr.bits.get(c) ?? []])),
      tiles: Object.fromEntries(tiles.map((t) => [t, pr.bits.get(varName(t)) ?? []])),
    };
    const lines = [
      "{",
      `  "_comment": ${JSON.stringify(out._comment)},`,
      `  "_factorioVersion": ${JSON.stringify(out._factorioVersion)},`,
      `  "_crossChecked": ${JSON.stringify(out._crossChecked)},`,
      `  "_crossCheckedAgainst": ${JSON.stringify(out._crossCheckedAgainst)},`,
      `  "planet": ${JSON.stringify(p)},`,
      `  "seed": ${String(FORCED_SEED)},`,
      `  "nativeRouteAnswered": ${JSON.stringify(nativeAnswered)},`,
      `  "winCounts": ${JSON.stringify(counts)},`,
      `  "positions": ${JSON.stringify(pos)},`,
      '  "climate": {',
      ...CLIMATE.map(
        (c, k) =>
          `    ${JSON.stringify(c)}: ${JSON.stringify(out.climate[c])}${k < CLIMATE.length - 1 ? "," : ""}`,
      ),
      "  },",
      '  "tiles": {',
      ...tiles.map(
        (t, k) =>
          `    ${JSON.stringify(t)}: ${JSON.stringify(out.tiles[t])}${k < tiles.length - 1 ? "," : ""}`,
      ),
      "  }",
      "}",
      "",
    ];
    const file = join(
      REPO,
      "test",
      "fixtures",
      `oracle-${p}-fields.seed${String(FORCED_SEED)}.json`,
    );
    await writeFile(file, lines.join("\n"));
    console.log(`wrote ${file}`);
  }
}

await main();
