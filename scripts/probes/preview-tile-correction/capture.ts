/**
 * Does the game's map preview PNG run tile correction?
 *
 *   node --experimental-strip-types scripts/probes/preview-tile-correction/capture.ts
 *
 * Run from the repository root. It needs the 2.1.23 headless install named in
 * `INSTALL` below and writes `test/fixtures/oracle-preview-tile-correction.json`.
 * Read `README.md` beside this file for what it found.
 *
 * ## The question
 *
 * The engine matches the game's terrain-only preview PNGs except for one pixel
 * each on Nauvis and Vulcanus. At both, the game draws our SECOND-best tile.
 * The game has a pass we do not port, `TileCorrectionMapGenerationTask`, that
 * rewrites tile boundaries after the argmax (`docs/noise/tile-correction-NOTES.md`).
 * If the PNG runs it, those pixels are correction and need no formula fix. If
 * it does not, they are not.
 *
 * ## Three readings of the same tiles
 *
 * - **Raw argmax.** The game's own score for every candidate tile, read with
 *   `calculate_tile_properties` under the property name
 *   `tile:<name>:probability`, and the highest one taken. The same scores are
 *   read a second way, through a data-stage noise expression copied from each
 *   tile's `autoplace.probability_expression`, and the two must agree exactly.
 *   Both go through the game's POINT noise kernel, while map generation and the
 *   preview use the chunk-GRID kernel (`docs/noise/basis-noise-NOTES.md`). So a
 *   near tie can flip between the two, and margins are reported, not hidden.
 * - **Arm A, filled.** `get_tile` after generating every chunk around the one
 *   being read, so correction has its full 3x3 neighbourhood.
 * - **Arm B, isolated.** `get_tile` after generating ONE chunk, in a separate
 *   run, so no neighbour from arm A can exist.
 *
 * Each is compared with the PNG pixel, through each tile's `map_color`.
 *
 * ## The control, and why it can fail
 *
 * A probe that cannot see correction cannot say the PNG lacks it. So the probe
 * first looks for tiles where arm A DIFFERS from the raw argmax by a margin no
 * kernel difference can explain. Those are tiles the game corrected. At each
 * one the PNG must show either the corrected tile or the raw one, and that is
 * the answer. If there are none, the probe stops. Fulgora carries most of them
 * (its forced-seed residual is boundary rewrites), at the DERIVED seed the PNG
 * uses - not the forced-seed tiles of `oracle-fulgora-tiles`, which are a
 * different world (controller ruling R2). The two targets' own 3x3 blocks are
 * graded the same way.
 *
 * A second control checks the apparatus: where arm A and the raw argmax AGREE,
 * the PNG must show that tile. A shifted pixel grid or a wrong colour table
 * fails it.
 *
 * ## Levers matched to the PNG
 *
 * The PNGs were captured with `TERRAIN_ONLY_DATA_FINAL_FIXES` and each
 * planet's `disabled` controls at size 0 (`test/oracle/previewCompare.ts`).
 * Both are applied here and the controls are read back off every surface.
 * Vulcanus's resource controls do move tiles (`volcanic_jagged_ground_range`
 * reads `control:calcite:*`), so this is not optional.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import { DISABLEABLE, TERRAIN_ONLY_DATA_FINAL_FIXES } from "../../../test/oracle/previewCompare.ts";

// `test/oracle/decodePng.ts` imports `../../src/codec/crc32` without an
// extension, which Vite resolves and bare Node does not. Retry such a relative
// import with `.ts`, so this probe reads the PNGs with the same decoder (CRC
// checks included) the parity specs use.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return next(`${specifier}.ts`, context);
      }
      throw e;
    }
  },
});
const { decodePng } = await import("../../../test/oracle/decodePng.ts");

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = join(REPO, "test", "fixtures");
const OUT = join(FIXTURES, "oracle-preview-tile-correction.json");
const ORACLE = join(process.env.HOME ?? "", ".cargo", "bin", "factorio-oracle");

/** The PNGs' version. The root is nested; the outer folder does not resolve. */
const INSTALL = {
  root: "/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio",
  version: "2.1.23",
};

const MAP_SEED = 123456;

/**
 * A planned margin, in score units, below which a raw-argmax disagreement is
 * not counted as correction. The point and grid kernels differ by a few f32
 * ULPs of a noise value; on scores near 1 that is around 1e-6, and the Task 1
 * notes call Vulcanus's 5.8e-4 gap far too wide for rounding. 1e-3 sits above
 * both, so a tile counted here was changed by something other than the kernel.
 */
const MARGIN_MIN = 1e-3;

interface PlanetSpec {
  readonly planet: "nauvis" | "vulcanus" | "fulgora";
  /** The surface seed the game derives from map seed 123456. */
  readonly seed: number;
  /** Exactly the list `previewCompare.ts` disabled for this planet's PNG. */
  readonly disabled: readonly string[];
  readonly png: string;
}

const PLANETS: readonly PlanetSpec[] = [
  {
    planet: "nauvis",
    seed: 123456,
    disabled: DISABLEABLE,
    png: "oracle-preview-nauvis-terrain.seed123456.png",
  },
  {
    planet: "vulcanus",
    seed: 1249936247,
    disabled: [...DISABLEABLE, "calcite", "tungsten_ore", "vulcanus_coal", "sulfuric_acid_geyser"],
    png: "oracle-preview-vulcanus-terrain.seed123456.png",
  },
  {
    planet: "fulgora",
    seed: 2967702466,
    disabled: [...DISABLEABLE, "scrap", "fulgora_cliff"],
    png: "oracle-preview-fulgora-terrain.seed123456.png",
  },
];

/** The two pixels Task 1 measured (`docs/noise/tile-correction-NOTES.md`). */
const TARGETS = [
  { planet: "nauvis", x: 229, y: -19, gameDraws: "grass-1", weDraw: "grass-3" },
  {
    planet: "vulcanus",
    x: -361,
    y: 11,
    gameDraws: "volcanic-cracks",
    weDraw: "volcanic-cracks-warm",
  },
] as const;

/** A block is the 3x3 chunks around a centre chunk: 96x96 tiles. */
interface Job {
  readonly label: string;
  readonly cx: number;
  readonly cy: number;
  /** `request_to_generate_chunks` radius, in chunks. */
  readonly radius: number;
  /** Read the raw scores too (filled arm only). */
  readonly scores: boolean;
}

const BLOCK = 96;
const CENSUS = 3;

const chunkOf = (t: number): number => Math.floor(t / 32);

// ---------------------------------------------------------------------------
// The Lua.
// ---------------------------------------------------------------------------

/**
 * The data stage: the terrain-only mod the PNGs were captured with, plus a
 * named copy of every tile's probability expression, the second route to the
 * raw scores.
 */
function dataFinalFixesLua(): string {
  return `-- GENERATED by scripts/probes/preview-tile-correction/capture.ts.
${TERRAIN_ONLY_DATA_FINAL_FIXES}
for name, tile in pairs(data.raw.tile) do
  local a = tile.autoplace
  if a and a.probability_expression then
    data:extend({{
      type = "noise-expression",
      name = "tcprobe-" .. name,
      expression = a.probability_expression,
      local_expressions = a.local_expressions,
      local_functions = a.local_functions,
    }})
  end
end
`;
}

function controlLua(config: unknown): string {
  return `-- GENERATED by scripts/probes/preview-tile-correction/capture.ts.
local cfg = helpers.json_to_table([==[${JSON.stringify(config)}]==])
local BLOCK, CENSUS = ${String(BLOCK)}, ${String(CENSUS)}

local function census(s, job)
  local out = {}
  for dy = -CENSUS, CENSUS do
    for dx = -CENSUS, CENSUS do
      out[#out + 1] = s.is_chunk_generated({ job.cx + dx, job.cy + dy })
    end
  end
  return out
end

local function block_positions(job)
  local x0, y0 = (job.cx - 1) * 32, (job.cy - 1) * 32
  local ps = {}
  for y = y0, y0 + BLOCK - 1 do
    for x = x0, x0 + BLOCK - 1 do
      ps[#ps + 1] = { x = x, y = y }
    end
  end
  return ps
end

-- An ungenerated chunk may refuse get_tile; "" marks a tile that could not be read.
-- The centre chunk is read FIRST, and the census taken again after it and after
-- the rest: reading a neighbour might itself generate it, and that must not be
-- able to reach the centre's tiles before they are recorded.
local function read_tiles(s, ps, seen, job, o)
  -- Pre-filled, so table_to_json still sees an array after a sparse first pass.
  local out = {}
  for i = 1, #ps do out[i] = "" end
  for pass = 1, 2 do
    for i, p in ipairs(ps) do
      local centre = math.floor(p.x / 32) == job.cx and math.floor(p.y / 32) == job.cy
      if centre == (pass == 1) then
        local ok, name = pcall(function() return s.get_tile(p.x, p.y).name end)
        out[i] = ok and name or ""
        if ok then seen[name] = true end
      end
    end
    if o then
      if pass == 1 then o.afterCentreRead = census(s, job) else o.afterAllReads = census(s, job) end
    end
  end
  return out
end

local function apply_controls(s, disabled)
  local mgs = s.map_gen_settings
  for _, n in ipairs(disabled) do
    mgs.autoplace_controls[n] = { frequency = 1, size = 0, richness = 1 }
  end
  s.map_gen_settings = mgs
  local back = {}
  for _, n in ipairs(disabled) do
    local c = s.map_gen_settings.autoplace_controls[n]
    back[n] = c and c.size or -1
  end
  return back
end

local function run_planet(p)
  local s
  if p.planet == "nauvis" then
    -- Nauvis's own surface already holds chunks -7..6 from map creation, next
    -- to the target's chunk, so arm B could not be isolated there. A copy of
    -- its settings is the same world; arm A checks that against the real one.
    s = game.create_surface("tc-nauvis-" .. cfg.arm, game.surfaces["nauvis"].map_gen_settings)
  else
    s = game.planets[p.planet].create_surface()
  end
  local out = { surface = s.name, controls = apply_controls(s, p.disabled), jobs = {} }
  out.seed = s.map_gen_settings.seed
  local cands = {}
  for name in pairs(s.map_gen_settings.autoplace_settings.tile.settings) do cands[#cands + 1] = name end
  table.sort(cands)
  out.candidates = cands
  for i, job in ipairs(p.jobs) do out.jobs[i] = { before = census(s, job) } end
  for _, job in ipairs(p.jobs) do
    s.request_to_generate_chunks({ x = job.cx * 32 + 16, y = job.cy * 32 + 16 }, job.radius)
  end
  s.force_generate_chunk_requests()
  local seen = {}
  for i, job in ipairs(p.jobs) do
    local o = out.jobs[i]
    o.after = census(s, job)
    local ps = block_positions(job)
    o.tiles = read_tiles(s, ps, seen, job, o)
    if job.scores then
      local native, copy = {}, {}
      for _, n in ipairs(cands) do
        native[#native + 1] = "tile:" .. n .. ":probability"
        copy[#copy + 1] = "tcprobe-" .. n
      end
      local a = s.calculate_tile_properties(native, ps)
      local b = s.calculate_tile_properties(copy, ps)
      o.scores, o.routeMismatches = {}, 0
      for k, n in ipairs(cands) do
        -- Unknown property names are silently dropped; a missing one fails here.
        assert(a[native[k]] and #a[native[k]] == #ps, "no values for " .. native[k])
        assert(b[copy[k]] and #b[copy[k]] == #ps, "no values for " .. copy[k])
        local vals = {}
        for j = 1, #ps do
          local va, vb = a[native[k]][j], b[copy[k]][j]
          if va ~= vb and (va == va or vb == vb) then o.routeMismatches = o.routeMismatches + 1 end
          -- table_to_json writes -inf and nan as bare words, which no JSON
          -- parser reads; send them as strings.
          if va ~= va then va = "nan" elseif va == math.huge then va = "inf"
          elseif va == -math.huge then va = "-inf" end
          vals[j] = va
        end
        o.scores[n] = vals
      end
    end
  end
  for _, n in ipairs(cands) do seen[n] = true end
  out.mapColors = {}
  for n in pairs(seen) do
    local c = prototypes.tile[n].map_color
    out.mapColors[n] = { c.r, c.g, c.b }
  end
  if p.planet == "nauvis" and cfg.arm == "filled" then
    -- The copy must be the real world: same block, read off game.surfaces.nauvis.
    local real = game.surfaces["nauvis"]
    local job = p.jobs[1]
    real.request_to_generate_chunks({ x = job.cx * 32 + 16, y = job.cy * 32 + 16 }, job.radius)
    real.force_generate_chunk_requests()
    out.realNauvisTiles = read_tiles(real, block_positions(job), {}, job, nil)
    out.realNauvisSeed = real.map_gen_settings.seed
  end
  return out
end

script.on_init(function()
  assert(script.active_mods["space-age"], "space-age is not loaded")
  local out = { arm = cfg.arm, planets = {} }
  for _, p in ipairs(cfg.planets) do out.planets[p.planet] = run_planet(p) end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
`;
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

interface JobDump {
  before: boolean[];
  after: boolean[];
  afterCentreRead: boolean[];
  afterAllReads: boolean[];
  tiles: string[];
  scores?: Record<string, number[]>;
  routeMismatches?: number;
}
interface PlanetDump {
  surface: string;
  seed: number;
  controls: Record<string, number>;
  candidates: string[];
  mapColors: Record<string, [number, number, number]>;
  jobs: JobDump[];
  realNauvisTiles?: string[];
  realNauvisSeed?: number;
}
interface Dump {
  arm: string;
  planets: Record<string, PlanetDump>;
}

async function runArm(
  arm: "filled" | "isolated",
  jobs: Record<string, Job[]>,
): Promise<{ dump: Dump; buildLine: string }> {
  const dir = await mkdtemp(join(tmpdir(), `tile-correction-${arm}-`));
  try {
    const controlPath = join(dir, "control.lua");
    const config = {
      arm,
      planets: PLANETS.map((p) => ({
        planet: p.planet,
        disabled: p.disabled,
        jobs: jobs[p.planet],
      })),
    };
    await writeFile(controlPath, controlLua(config));
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "preview_tile_correction_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: controlPath,
          data_final_fixes_lua: dataFinalFixesLua(),
        },
        seed: MAP_SEED,
        // Nauvis's levers go in at map creation, so the real surface and its
        // copy both carry them. The Lua sets them again and reads them back.
        map_gen_settings: {
          autoplace_controls: Object.fromEntries(
            DISABLEABLE.map((n) => [n, { frequency: 1, size: 0, richness: 1 }]),
          ),
        },
        timeout_seconds: 900,
      }),
    );
    const workDir = join(dir, "work");
    // A successful run throws (DUMPED-OK). Keep the error: a real failure lands
    // here too, and its stdout carries the oracle's JSON report.
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
          INSTALL.root,
          "--version",
          INSTALL.version,
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
      // Left empty; the buildLine check below names the failure.
    }
    const buildLine = report.provenance?.buildLine ?? "";
    const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
    let text: string;
    try {
      text = await readFile(dumpPath, "utf8");
    } catch (e) {
      throw new Error(`${arm}: no dump at ${dumpPath}`, { cause: oracleError ?? e });
    }
    // Without --version a bad path silently runs another install with exit 0.
    if (!buildLine.includes(`Version: ${INSTALL.version} `)) {
      throw new Error(`${arm}: ran "${buildLine}", wanted ${INSTALL.version}`, {
        cause: oracleError,
      });
    }
    const nonFinite: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };
    const dump = JSON.parse(text, (_k, v: unknown) =>
      typeof v === "string" && v in nonFinite ? nonFinite[v] : v,
    ) as Dump;
    return { dump, buildLine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Grading.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
const sameRgb = (a: Rgb | undefined, b: Rgb | undefined): boolean =>
  a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

interface Png {
  at(x: number, y: number): Rgb;
}

async function loadPng(file: string): Promise<Png> {
  const img = decodePng(
    new Uint8Array(await readFile(join(FIXTURES, file))),
    (b) => new Uint8Array(inflateSync(b)),
  );
  if (img.width !== 1024 || img.height !== 1024) throw new Error(`${file}: not 1024x1024`);
  return {
    at(x, y) {
      // One tile per pixel, origin -512: tile (x, y) is pixel (x + 512, y + 512).
      const i = ((y + 512) * img.width + (x + 512)) * 3;
      return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]];
    },
  };
}

/** The tiles a PNG colour could be, among this planet's colours. */
function tilesOfColour(colours: Record<string, Rgb>, c: Rgb): string[] {
  return Object.keys(colours)
    .filter((n) => sameRgb(colours[n], c))
    .sort();
}

interface Ranked {
  readonly argmax: string;
  readonly top: number;
  readonly scoreOf: (name: string) => number | undefined;
}

function rank(scores: Record<string, number[]>, candidates: string[], j: number): Ranked {
  let argmax = candidates[0];
  for (const n of candidates) if (scores[n][j] > scores[argmax][j]) argmax = n;
  return { argmax, top: scores[argmax][j], scoreOf: (n) => scores[n]?.[j] };
}

/** Which of the two readings the PNG pixel shows, at one tile. */
function pngVerdict(png: Rgb, colours: Record<string, Rgb>, filled: string, raw: string): string {
  const f = sameRgb(png, colours[filled]);
  const r = sameRgb(png, colours[raw]);
  if (f && r) return "same colour";
  if (f) return "filled";
  if (r) return "raw";
  return "neither";
}

interface DifferTile {
  x: number;
  y: number;
  filled: string;
  raw: string;
  rawScore: number;
  filledScore: number | null;
  margin: number | null;
  verdict: string;
}

function gradeBlock(
  job: Job,
  filled: JobDump,
  colours: Record<string, Rgb>,
  candidates: string[],
  png: Png,
) {
  const scores = filled.scores;
  if (scores === undefined) throw new Error(`${job.label}: no scores`);
  const x0 = (job.cx - 1) * 32;
  const y0 = (job.cy - 1) * 32;
  let agree = 0;
  let agreePngMatch = 0;
  const differ: DifferTile[] = [];
  const verdicts: Record<string, Record<string, number>> = {};
  for (let j = 0; j < BLOCK * BLOCK; j++) {
    const x = x0 + (j % BLOCK);
    const y = y0 + Math.floor(j / BLOCK);
    const r = rank(scores, candidates, j);
    const got = filled.tiles[j];
    const pix = png.at(x, y);
    if (got === r.argmax) {
      agree++;
      if (sameRgb(pix, colours[got])) agreePngMatch++;
      continue;
    }
    const fs = r.scoreOf(got);
    const margin = fs === undefined ? null : r.top - fs;
    const verdict = pngVerdict(pix, colours, got, r.argmax);
    const bin = margin === null ? "not a candidate" : margin >= MARGIN_MIN ? "large" : "small";
    verdicts[bin] ??= {};
    verdicts[bin][verdict] = (verdicts[bin][verdict] ?? 0) + 1;
    differ.push({
      x,
      y,
      filled: got,
      raw: r.argmax,
      rawScore: r.top,
      filledScore: fs ?? null,
      margin,
      verdict,
    });
  }
  return {
    label: job.label,
    centreChunk: [job.cx, job.cy],
    tiles: BLOCK * BLOCK,
    agree,
    agreePngMatch,
    differ: differ.length,
    verdictsByMargin: verdicts,
    differTiles: differ,
  };
}

/** The 3x3 neighbourhood of a target: filled, isolated and raw, for context. */
function neighbourhood(
  job: Job,
  filled: JobDump,
  isolated: JobDump,
  candidates: string[],
  x: number,
  y: number,
) {
  const scores = filled.scores;
  if (scores === undefined) throw new Error(`${job.label}: no scores`);
  const rows: { filled: string[]; isolated: string[]; raw: string[] } = {
    filled: [],
    isolated: [],
    raw: [],
  };
  for (let dy = -1; dy <= 1; dy++) {
    const f: string[] = [];
    const i: string[] = [];
    const r: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      const j = (y + dy - (job.cy - 1) * 32) * BLOCK + (x + dx - (job.cx - 1) * 32);
      f.push(filled.tiles[j]);
      i.push(isolated.tiles[j]);
      r.push(rank(scores, candidates, j).argmax);
    }
    rows.filled.push(f.join(" "));
    rows.isolated.push(i.join(" "));
    rows.raw.push(r.join(" "));
  }
  return rows;
}

/**
 * Arm B, chunk by chunk over the target's 3x3 block: how many tiles `get_tile`
 * could read, and how many equal the raw argmax and the filled tile. The
 * centre chunk is the one generated; the other eight are its neighbours.
 */
function isolatedByChunk(job: Job, filled: JobDump, isolated: JobDump, candidates: string[]) {
  const scores = filled.scores;
  if (scores === undefined) throw new Error(`${job.label}: no scores`);
  const out: { chunk: number[]; readable: number; equalRaw: number; equalFilled: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const row = { chunk: [dx, dy], readable: 0, equalRaw: 0, equalFilled: 0 };
      for (let ty = 0; ty < 32; ty++) {
        for (let tx = 0; tx < 32; tx++) {
          const j = ((dy + 1) * 32 + ty) * BLOCK + (dx + 1) * 32 + tx;
          const got = isolated.tiles[j];
          if (got === "") continue;
          row.readable++;
          if (got === rank(scores, candidates, j).argmax) row.equalRaw++;
          if (got === filled.tiles[j]) row.equalFilled++;
        }
      }
      out.push(row);
    }
  }
  return out;
}

function checkSurface(p: PlanetSpec, d: PlanetDump, arm: string): void {
  if (d.seed !== p.seed) {
    throw new Error(`${arm} ${p.planet}: surface seed ${String(d.seed)}, wanted ${String(p.seed)}`);
  }
  for (const n of p.disabled) {
    if (d.controls[n] !== 0) {
      throw new Error(
        `${arm} ${p.planet}: control ${n} read back ${String(d.controls[n])}, wanted 0`,
      );
    }
  }
  if (d.candidates.length === 0) throw new Error(`${arm} ${p.planet}: no candidate tiles`);
}

/** Chunks generated in the census window, as "dx,dy" offsets from the centre chunk. */
function generated(census: boolean[]): string[] {
  const out: string[] = [];
  census.forEach((g, k) => {
    if (g) out.push(`${String((k % 7) - CENSUS)},${String(Math.floor(k / 7) - CENSUS)}`);
  });
  return out;
}

// ---------------------------------------------------------------------------

/**
 * The Fulgora control windows: the two 3x3-chunk blocks inside the PNG with the
 * most colour changes between neighbouring pixels, so the most tile boundaries.
 * Picked from the PNG alone, which says where boundaries are and nothing about
 * which reading the PNG follows.
 */
function fulgoraWindows(png: Png): Job[] {
  const scored: { cx: number; cy: number; edges: number }[] = [];
  for (let cy = -15; cy <= 14; cy++) {
    for (let cx = -15; cx <= 14; cx++) {
      let edges = 0;
      const x0 = (cx - 1) * 32;
      const y0 = (cy - 1) * 32;
      for (let y = y0; y < y0 + BLOCK; y++) {
        for (let x = x0; x < x0 + BLOCK; x++) {
          if (x + 1 < x0 + BLOCK && !sameRgb(png.at(x, y), png.at(x + 1, y))) edges++;
          if (y + 1 < y0 + BLOCK && !sameRgb(png.at(x, y), png.at(x, y + 1))) edges++;
        }
      }
      scored.push({ cx, cy, edges });
    }
  }
  scored.sort((a, b) => b.edges - a.edges);
  const picked: typeof scored = [];
  for (const s of scored) {
    if (picked.every((q) => Math.abs(q.cx - s.cx) >= 5 || Math.abs(q.cy - s.cy) >= 5)) {
      picked.push(s);
    }
    if (picked.length === 2) break;
  }
  // Radius 2, so every chunk of the 3x3 block has all its neighbours generated.
  return picked.map((s, k) => ({
    label: `fulgora control ${String(k + 1)} (${String(s.edges)} PNG edges)`,
    cx: s.cx,
    cy: s.cy,
    radius: 2,
    scores: true,
  }));
}

async function main(): Promise<void> {
  const pngs: Record<string, Png> = {};
  for (const p of PLANETS) pngs[p.planet] = await loadPng(p.png);

  const targetJob = (t: (typeof TARGETS)[number], radius: number, scores: boolean): Job => ({
    label: `${t.planet} target (${String(t.x)},${String(t.y)})`,
    cx: chunkOf(t.x),
    cy: chunkOf(t.y),
    radius,
    scores,
  });
  const windows = fulgoraWindows(pngs.fulgora);
  const filledJobs: Record<string, Job[]> = {
    nauvis: [targetJob(TARGETS[0], 1, true)],
    vulcanus: [targetJob(TARGETS[1], 1, true)],
    fulgora: windows,
  };

  console.log(`arm A (filled) against ${INSTALL.version}`);
  const A = await runArm("filled", filledJobs);
  console.log(`  ${A.buildLine}`);
  for (const p of PLANETS) checkSurface(p, A.dump.planets[p.planet], "filled");

  // The copy of Nauvis must be the real world.
  const nauvisA = A.dump.planets.nauvis;
  if (nauvisA.realNauvisSeed !== 123456) throw new Error("real Nauvis seed did not read back");
  const realDiff = (nauvisA.realNauvisTiles ?? []).filter((n, k) => n !== nauvisA.jobs[0].tiles[k]);
  if (nauvisA.realNauvisTiles?.length !== BLOCK * BLOCK || realDiff.length !== 0) {
    throw new Error(
      `the Nauvis copy differs from the real surface at ${String(realDiff.length)} tiles`,
    );
  }

  // Grade every block filled against raw against the PNG.
  const blocks: Record<string, ReturnType<typeof gradeBlock>[]> = {};
  for (const p of PLANETS) {
    const d = A.dump.planets[p.planet];
    blocks[p.planet] = filledJobs[p.planet].map((job, k) => {
      if (d.jobs[k].routeMismatches !== 0) {
        throw new Error(
          `${job.label}: the two score routes disagree at ${String(d.jobs[k].routeMismatches)} values`,
        );
      }
      return gradeBlock(job, d.jobs[k], d.mapColors, d.candidates, pngs[p.planet]);
    });
  }

  // The apparatus control: where filled and raw agree, the PNG must show it.
  for (const [planet, bs] of Object.entries(blocks)) {
    for (const b of bs) {
      console.log(
        `  ${b.label}: ${String(b.agree)} agree (PNG matches ${String(b.agreePngMatch)}), ` +
          `${String(b.differ)} differ ${JSON.stringify(b.verdictsByMargin)}`,
      );
      if (b.agreePngMatch < 0.99 * b.agree) {
        throw new Error(
          `${planet} ${b.label}: the PNG matches only ${String(b.agreePngMatch)} agreeing tiles`,
        );
      }
    }
  }

  // The correction control: tiles arm A changed by a margin no kernel explains.
  const controlTiles = blocks.fulgora.flatMap((b) =>
    b.differTiles.filter((t) => t.margin !== null && t.margin >= MARGIN_MIN),
  );
  if (controlTiles.length === 0) {
    throw new Error(
      "BLOCKED: no Fulgora tile where get_tile differs from the raw argmax by the margin, " +
        "so this probe cannot see correction",
    );
  }

  // Arm B: the targets, and the Fulgora chunk carrying the most control tiles.
  const perChunk = new Map<string, number>();
  for (const t of controlTiles) {
    const key = `${String(chunkOf(t.x))},${String(chunkOf(t.y))}`;
    perChunk.set(key, (perChunk.get(key) ?? 0) + 1);
  }
  const [bestKey] = [...perChunk.entries()].sort((a, b) => b[1] - a[1])[0];
  const [bcx, bcy] = bestKey.split(",").map(Number);
  const isoJobs: Record<string, Job[]> = {
    nauvis: [targetJob(TARGETS[0], 0, false)],
    vulcanus: [targetJob(TARGETS[1], 0, false)],
    fulgora: [
      { label: `fulgora isolated chunk (${bestKey})`, cx: bcx, cy: bcy, radius: 0, scores: false },
    ],
  };
  console.log(`arm B (isolated) against ${INSTALL.version}`);
  const B = await runArm("isolated", isoJobs);
  for (const p of PLANETS) checkSurface(p, B.dump.planets[p.planet], "isolated");

  // The isolated Fulgora chunk, graded against arm A's scores at the same tiles.
  const fA = A.dump.planets.fulgora;
  const isoF = B.dump.planets.fulgora.jobs[0];
  const isoInChunk = {
    tiles: 0,
    agreeRaw: 0,
    agreeFilled: 0,
    controlTiles: 0,
    controlFollowRaw: 0,
  };
  {
    const wk = windows.findIndex((w) => Math.abs(w.cx - bcx) <= 1 && Math.abs(w.cy - bcy) <= 1);
    const w = windows[wk];
    const scoresA = fA.jobs[wk].scores;
    if (scoresA === undefined) throw new Error("unreachable");
    for (let y = bcy * 32; y < bcy * 32 + 32; y++) {
      for (let x = bcx * 32; x < bcx * 32 + 32; x++) {
        const jA = (y - (w.cy - 1) * 32) * BLOCK + (x - (w.cx - 1) * 32);
        const jB = (y - (bcy - 1) * 32) * BLOCK + (x - (bcx - 1) * 32);
        const raw = rank(scoresA, fA.candidates, jA).argmax;
        const iso = isoF.tiles[jB];
        isoInChunk.tiles++;
        if (iso === raw) isoInChunk.agreeRaw++;
        if (iso === fA.jobs[wk].tiles[jA]) isoInChunk.agreeFilled++;
        if (controlTiles.some((t) => t.x === x && t.y === y)) {
          isoInChunk.controlTiles++;
          if (iso === raw) isoInChunk.controlFollowRaw++;
        }
      }
    }
  }

  const targets = TARGETS.map((t) => {
    const d = A.dump.planets[t.planet];
    const job = filledJobs[t.planet][0];
    const fj = d.jobs[0];
    const ij = B.dump.planets[t.planet].jobs[0];
    const scores = fj.scores;
    if (scores === undefined) throw new Error("unreachable");
    const j = (t.y - (job.cy - 1) * 32) * BLOCK + (t.x - (job.cx - 1) * 32);
    const ranked = d.candidates
      .map((n) => ({ tile: n, score: scores[n][j] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    const pix = pngs[t.planet].at(t.x, t.y);
    const f32ulp = (v: number): number => {
      const b = new Float32Array([Math.abs(v)]);
      const u = new Uint32Array(b.buffer);
      u[0] += 1;
      return b[0] - Math.abs(v);
    };
    return {
      planet: t.planet,
      tile: [t.x, t.y],
      pixel: [t.x + 512, t.y + 512],
      pngColour: pix,
      pngTile: tilesOfColour(d.mapColors, pix),
      taskOneGameDraws: t.gameDraws,
      taskOneWeDraw: t.weDraw,
      getTileFilled: fj.tiles[j],
      getTileIsolated: ij.tiles[j],
      rawArgmax: ranked[0].tile,
      rawTopScores: ranked,
      rawGapF32Ulps: Math.round((ranked[0].score - ranked[1].score) / f32ulp(ranked[0].score)),
      neighbourhood: neighbourhood(job, fj, ij, d.candidates, t.x, t.y),
      isolation: {
        before: generated(ij.before),
        after: generated(ij.after),
        afterCentreRead: generated(ij.afterCentreRead),
        afterAllReads: generated(ij.afterAllReads),
        filledAfter: generated(fj.after),
        byChunk: isolatedByChunk(job, fj, ij, d.candidates),
      },
    };
  });

  const comment =
    `Ground truth from Factorio ${A.buildLine.replace(/^Version: /, "")} via factorio-oracle, map seed 123456, ` +
    "DERIVED surface seeds (Nauvis 123456, Vulcanus 1249936247, Fulgora 2967702466), with the terrain-only " +
    "data-final-fixes mod and each planet's PNG controls at size 0, read back off every surface. Asks whether " +
    "the --generate-map-preview PNG shows the tile get_tile reports after full generation (arm A, 'filled') or " +
    "the raw argmax of the game's own tile scores (calculate_tile_properties 'tile:<name>:probability', the " +
    "POINT noise kernel; cross-checked equal at every value to a data-stage copy of each probability_expression). " +
    "blocks: per 96x96 block, tiles where filled and raw agree (and how many the PNG matches - the apparatus " +
    `control), and every tile where they differ as a differColumns row, binned by margin (raw score minus the filled tile's score, ` +
    `'large' >= ${String(MARGIN_MIN)}), with which reading the PNG pixel shows. Fulgora blocks are the correction ` +
    "control. targets: the two Task 1 pixels in full, with arm B ('isolated': one chunk generated alone, in a " +
    "separate run) and the chunk census around it. Regenerate: " +
    "node --experimental-strip-types scripts/probes/preview-tile-correction/capture.ts";

  const fixture = {
    _comment: comment,
    _factorioVersion: INSTALL.version,
    _buildLine: A.buildLine,
    mapSeed: MAP_SEED,
    marginMin: MARGIN_MIN,
    mapColors: Object.fromEntries(
      PLANETS.map((p) => [p.planet, A.dump.planets[p.planet].mapColors]),
    ),
    targets,
    differColumns: ["x", "y", "filled", "raw", "rawScore", "filledScore", "margin", "pngShows"],
    blocks: Object.fromEntries(
      Object.entries(blocks).map(([planet, bs]) => [
        planet,
        bs.map((b) => ({
          ...b,
          differTiles: b.differTiles.map((t) => [
            t.x,
            t.y,
            t.filled,
            t.raw,
            t.rawScore,
            t.filledScore,
            t.margin,
            t.verdict,
          ]),
        })),
      ]),
    ),
    controlTileCount: controlTiles.length,
    isolatedFulgoraChunk: {
      chunk: [bcx, bcy],
      before: generated(isoF.before),
      after: generated(isoF.after),
      afterCentreRead: generated(isoF.afterCentreRead),
      afterAllReads: generated(isoF.afterAllReads),
      ...isoInChunk,
    },
  };
  // One line per array of plain values, so each differing tile is one line.
  const text = JSON.stringify(fixture, null, 2).replace(
    /\[\n\s+([^[\]{}]*?)\n\s+\]/g,
    (_m, inner: string) => `[${inner.replace(/\n\s+/g, " ")}]`,
  );
  await writeFile(OUT, `${text}\n`);
  for (const t of targets) {
    console.log(
      `  ${t.planet} ${JSON.stringify(t.tile)}: PNG ${t.pngTile.join("/")}, filled ${t.getTileFilled}, ` +
        `isolated ${t.getTileIsolated}, raw ${t.rawArgmax} (gap ${String(t.rawGapF32Ulps)} ULPs)`,
    );
  }
  console.log(`  isolated Fulgora chunk ${bestKey}: ${JSON.stringify(isoInChunk)}`);
  console.log(`wrote ${OUT}`);
}

await main();
