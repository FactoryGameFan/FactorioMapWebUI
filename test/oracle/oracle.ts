/**
 * A reusable headless "oracle" for the noise reverse-engineering work: it routes
 * an arbitrary named noise expression onto a map-gen property (default
 * `elevation`), runs Factorio 2.1 headless for ~1.7 s, and reads the exact values
 * the game computed via `LuaSurface.calculate_tile_properties`. This is the ground
 * truth every noise primitive and every ported expression is validated against.
 *
 * The recipe (proven in docs/noise/basis-noise-NOTES.md, re-derived each session
 * until now): a tiny mod registers the probe expression at the data stage; a
 * `--map-gen-settings` JSON points `property_expression_names.<property>` at it; an
 * `on_init` handler samples the property, writes the values as JSON, and
 * `error("DUMPED-OK")`s to exit immediately.
 *
 * Pure builders are exported and unit-tested without Factorio; {@link
 * sampleExpression} wires them to disk and an (injectable) spawn, so the real run
 * is gated on a local install via {@link oracleAvailable}. Not shipped in the app.
 *
 * A third mode, `{ spaceAge: true, planet: "vulcanus" }` on {@link sampleExpression},
 * routes the probe onto a Space-Age planet's own surface (created at runtime via
 * `LuaPlanet::create_surface`) instead of the default Nauvis surface - required for
 * planet-specific named noise expressions (`vulcanus_*`, ...) to resolve. See
 * {@link buildSpaceAgeControlLua} for why Nauvis alone cannot sample them.
 *
 * A sibling path, {@link sampleTileNames}, answers a different question:
 * `calculate_tile_properties` only ever returns noise VALUES, never the tile the
 * game actually placed. That path generates real chunks (`request_to_generate_chunks`
 * + `force_generate_chunk_requests`) for the DEFAULT preset (no property routing)
 * and reads `surface.get_tile(x, y).name` back, so tile-selection logic can be
 * checked against the exact argmax the game chose.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Name the probe noise-expression is registered under. */
export const PROBE_NAME = "oracle_probe";
/** File the mod writes into `<write-data>/script-output/`. */
export const DUMP_FILE = "oracle-dump.json";
const MOD_VERSION = "0.0.1";

/** A map position, in world tiles (fractional allowed). */
export interface Position {
  readonly x: number;
  readonly y: number;
}

/** What a spawned Factorio process resolves to. Mirrors preview-service/render.mjs. */
export interface SpawnResult {
  readonly code: number | null;
  readonly stderr: string;
}

/** Injectable spawn: `(bin, args) => { done(): Promise<SpawnResult> }`. */
export type SpawnFn = (bin: string, args: readonly string[]) => { done(): Promise<SpawnResult> };

// ---------------------------------------------------------------------------
// Pure builders (unit-testable, no Factorio needed).
// ---------------------------------------------------------------------------

/** The mod's `info.json`. `factorio_version` must be "2.1" or the game skips it. */
export function buildInfoJson(): object {
  return {
    name: PROBE_NAME,
    version: MOD_VERSION,
    title: "Noise Oracle Probe",
    author: "FactorioMapWebUI",
    factorio_version: "2.1",
  };
}

/**
 * The data-stage `data.lua` that registers the probe. The expression is embedded
 * in a Lua long bracket (`[==[ ... ]==]`) so its braces, quotes and `var('...')`
 * survive verbatim - a plain quoted string would break on the first inner quote.
 */
export function buildDataLua(expression: string, probeName = PROBE_NAME): string {
  return `data:extend{{
  type = "noise-expression",
  name = "${probeName}",
  expression = [==[${expression}]==]
}}
`;
}

/** `mod-list.json` enabling `base` plus the probe. */
export function buildModList(probeName = PROBE_NAME): object {
  return {
    mods: [
      { name: "base", enabled: true },
      { name: probeName, enabled: true },
    ],
  };
}

/**
 * `mod-list.json` for the Space-Age variant: `base` plus the three DLC mods
 * `calculate_tile_properties` needs loaded for a `vulcanus_*` (or any other
 * planet) named noise expression to even exist (`space-age` depends on both
 * `elevated-rails` and `quality`), plus the probe.
 */
export function buildSpaceAgeModList(probeName = PROBE_NAME): object {
  return {
    mods: [
      { name: "base", enabled: true },
      { name: "space-age", enabled: true },
      { name: "elevated-rails", enabled: true },
      { name: "quality", enabled: true },
      { name: probeName, enabled: true },
    ],
  };
}

/**
 * The runtime `control.lua`: on map creation, sample `property` at every position
 * and write `{ values, positions }` JSON, then `error(DUMPED-OK)` to exit. The dump
 * always keys the sampled array as `values`, whatever property was routed.
 */
export function buildControlLua(
  positions: readonly Position[],
  opts: { property?: string; dumpFile?: string } = {},
): string {
  const property = opts.property ?? "elevation";
  const dumpFile = opts.dumpFile ?? DUMP_FILE;
  const posLua = positions.map((p) => `    {x = ${p.x}, y = ${p.y}}`).join(",\n");
  return `script.on_init(function()
  local positions = {
${posLua}
  }
  local surface = game.surfaces[1]
  -- property_names come FIRST; the HTML docs list positions first and are wrong.
  local props = surface.calculate_tile_properties({"${property}"}, positions)
  helpers.write_file("${dumpFile}",
    helpers.table_to_json({ values = props["${property}"], positions = positions }), false)
  error("DUMPED-OK")
end)
`;
}

/**
 * The Space-Age runtime `control.lua`: unlike {@link buildControlLua} (which
 * samples the property already routed via `--map-gen-settings` onto the
 * default Nauvis surface at `game.surfaces[1]`), a planet's own named noise
 * expressions (e.g. `vulcanus_temperature`) only resolve correctly against
 * THAT planet's surface - Nauvis has no `vulcanus_*` control context. So this
 * variant creates the planet's surface on demand
 * (`game.planets[planet].create_surface()`, which does not accept a settings
 * argument - see `LuaPlanet::create_surface`), then rewrites that surface's
 * OWN `map_gen_settings` (seed + the property route onto the probe) via the
 * read-modify-write pattern the game's own docs show for
 * `LuaSurface::map_gen_settings`, before sampling. The `--map-gen-settings`
 * CLI file still configures Nauvis (required for `--create` to succeed) but
 * is otherwise irrelevant here, since nothing is ever sampled from it.
 */
export function buildSpaceAgeControlLua(
  positions: readonly Position[],
  opts: { property?: string; dumpFile?: string; planet?: string; seed?: number } = {},
): string {
  const property = opts.property ?? "elevation";
  const dumpFile = opts.dumpFile ?? DUMP_FILE;
  const planet = opts.planet ?? "vulcanus";
  const seed = opts.seed ?? 123456;
  const posLua = positions.map((p) => `    {x = ${p.x}, y = ${p.y}}`).join(",\n");
  return `script.on_init(function()
  local positions = {
${posLua}
  }
  local surface = game.planets["${planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${seed}
  mgs.property_expression_names["${property}"] = "${PROBE_NAME}"
  surface.map_gen_settings = mgs
  -- property_names come FIRST; the HTML docs list positions first and are wrong.
  local props = surface.calculate_tile_properties({"${property}"}, positions)
  helpers.write_file("${dumpFile}",
    helpers.table_to_json({ values = props["${property}"], positions = positions }), false)
  error("DUMPED-OK")
end)
`;
}

/**
 * The `--map-gen-settings` JSON object. Routes the probe onto `property` and pins
 * the seed (which the probe reads as `map_seed` -> `seed0`). Extra map-gen fields
 * merge in via `overrides`.
 */
export function buildMapGenSettings(
  opts: {
    seed?: number;
    property?: string;
    probeName?: string;
    overrides?: Record<string, unknown>;
  } = {},
): object {
  const property = opts.property ?? "elevation";
  const probeName = opts.probeName ?? PROBE_NAME;
  return {
    seed: opts.seed ?? 123456,
    property_expression_names: { [property]: probeName },
    ...opts.overrides,
  };
}

/**
 * The isolated `config.ini`. `read-data` points at the game's bundled data
 * (default: the `__PATH__executable__` token, which resolves next to the binary);
 * `write-data` is our scratch dir, so `script-output/` (and the dump) land there,
 * clear of the real install.
 */
export function buildConfigIni(
  writeDataDir: string,
  readDataDir = "__PATH__executable__/../data",
): string {
  return `[path]
read-data=${readDataDir}
write-data=${writeDataDir}
[general]
[other]
`;
}

/** The headless `--create` argument vector, in order. */
export function buildFactorioArgs(p: {
  savePath: string;
  mapGenPath: string;
  seed: number;
  modDir: string;
  configPath: string;
}): string[] {
  return [
    "--create",
    p.savePath,
    "--map-gen-settings",
    p.mapGenPath,
    "--map-gen-seed",
    String(p.seed),
    "--mod-directory",
    p.modDir,
    "--config",
    p.configPath,
  ];
}

/** Parse the mod's dump into positions paired with their sampled values. */
export function parseDump(jsonText: string): { positions: Position[]; values: number[] } {
  const parsed = JSON.parse(jsonText) as { positions: Position[]; values: number[] };
  return { positions: parsed.positions, values: parsed.values };
}

// ---------------------------------------------------------------------------
// Tile-name oracle: a sibling path that generates real chunks and reads back
// `surface.get_tile(x, y).name` - the actual placed tile, which
// calculate_tile_properties (above) cannot report. Uses the DEFAULT preset (no
// property_expression_names routing), so this is the naturally-placed Nauvis
// tile mix.
// ---------------------------------------------------------------------------

/** Name of the tile-name probe mod (distinct from the noise-expression probe). */
export const TILE_PROBE_NAME = "oracle_tile_probe";
/** File the tile-name mod writes into `<write-data>/script-output/`. */
export const TILE_DUMP_FILE = "oracle-tile-dump.json";

/** The tile-name mod's `info.json`. No noise-expression prototype is registered. */
export function buildTileInfoJson(): object {
  return {
    name: TILE_PROBE_NAME,
    version: MOD_VERSION,
    title: "Tile Name Oracle Probe",
    author: "FactorioMapWebUI",
    factorio_version: "2.1",
  };
}

/** `mod-list.json` enabling `base` plus the tile-name probe. */
export function buildTileModList(): object {
  return {
    mods: [
      { name: "base", enabled: true },
      { name: TILE_PROBE_NAME, enabled: true },
    ],
  };
}

/** `--map-gen-settings` for the DEFAULT preset: just the seed, no property routing. */
export function buildTileMapGenSettings(seed = 123456): object {
  return { seed };
}

/**
 * The tile-name mod's `control.lua`: on init, requests chunk generation
 * individually AROUND EACH SAMPLE POSITION (a small `radius` chunks per point,
 * default 1 -> a 3x3 chunk neighborhood), rather than one big disc from the
 * origin - `request_to_generate_chunks` cost scales with radius^2, so a single
 * origin-centered disc covering points thousands of tiles out would generate
 * millions of chunks. Requests are queued for every point first, then a single
 * `force_generate_chunk_requests()` blocks until all of them finish, then the
 * mod reads `get_tile(x, y).name` at every position and writes
 * `{ results: [{x, y, name}, ...] }` JSON (echoing back the SAME floored x/y
 * that was actually passed to `get_tile`, so a caller can't accidentally pair
 * an unfloored input position with a floored tile sample), then
 * `error(DUMPED-OK)` to exit. `get_tile` takes int32 coords and rounds
 * non-integers down, so positions are floored before being embedded.
 */
export function buildTileControlLua(
  positions: readonly Position[],
  opts: { radius?: number; dumpFile?: string } = {},
): string {
  const dumpFile = opts.dumpFile ?? TILE_DUMP_FILE;
  const radius = opts.radius ?? 1;
  const posLua = positions
    .map((p) => `    {x = ${Math.floor(p.x)}, y = ${Math.floor(p.y)}}`)
    .join(",\n");
  return `script.on_init(function()
  local positions = {
${posLua}
  }
  local surface = game.surfaces[1]
  for i, p in ipairs(positions) do
    surface.request_to_generate_chunks({x = p.x, y = p.y}, ${radius})
  end
  surface.force_generate_chunk_requests()
  local results = {}
  for i, p in ipairs(positions) do
    local tile = surface.get_tile(p.x, p.y)
    results[i] = {x = p.x, y = p.y, name = tile.name}
  end
  helpers.write_file("${dumpFile}", helpers.table_to_json({ results = results }), false)
  error("DUMPED-OK")
end)
`;
}

/**
 * Space-Age variant of {@link buildTileControlLua}: reads `get_tile(x, y).name` on a
 * PLANET'S OWN surface (default vulcanus) instead of the default Nauvis surface at
 * `game.surfaces[1]`. Creates the planet surface on demand
 * (`game.planets[planet].create_surface()`), rewrites its own `map_gen_settings.seed`
 * (the read-modify-write the game's docs show for `LuaSurface::map_gen_settings`, and
 * the same pattern {@link buildSpaceAgeControlLua} uses), then requests chunk
 * generation around each point and reads the placed tile. `get_tile` takes int32
 * coords and rounds non-integers down, so positions are floored before embedding.
 *
 * **`seed` here is the SURFACE seed, and forcing it makes a surface no save
 * produces.** The game generates a planet at `mapSeed + planet.map_seed_offset`
 * (`crc32(name)` by default; 0 only for Nauvis), so passing the map seed through
 * gives a synthetic world - fine for validating an expression port, useless for
 * validating seed plumbing. Drop the two `mgs.seed` lines to sample the surface a
 * real save at this `--map-gen-seed` would have. See
 * `src/model/planetSurfaceSeed.ts` and the "Planet surface seeds" section of
 * `docs/noise/vulcanus-resources-NOTES.md`.
 */
export function buildSpaceAgeTileControlLua(
  positions: readonly Position[],
  opts: { radius?: number; dumpFile?: string; planet?: string; seed?: number } = {},
): string {
  const dumpFile = opts.dumpFile ?? TILE_DUMP_FILE;
  const radius = opts.radius ?? 1;
  const planet = opts.planet ?? "vulcanus";
  const seed = opts.seed ?? 123456;
  const posLua = positions
    .map((p) => `    {x = ${Math.floor(p.x)}, y = ${Math.floor(p.y)}}`)
    .join(",\n");
  return `script.on_init(function()
  local positions = {
${posLua}
  }
  local surface = game.planets["${planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${seed}
  surface.map_gen_settings = mgs
  for i, p in ipairs(positions) do
    surface.request_to_generate_chunks({x = p.x, y = p.y}, ${radius})
  end
  surface.force_generate_chunk_requests()
  local results = {}
  for i, p in ipairs(positions) do
    local tile = surface.get_tile(p.x, p.y)
    results[i] = {x = p.x, y = p.y, name = tile.name}
  end
  helpers.write_file("${dumpFile}", helpers.table_to_json({ results = results }), false)
  error("DUMPED-OK")
end)
`;
}

/** Parse the tile-name mod's dump into `{x, y, name}` entries. */
export function parseTileDump(
  jsonText: string,
): { readonly x: number; readonly y: number; readonly name: string }[] {
  const parsed = JSON.parse(jsonText) as {
    results: { x: number; y: number; name: string }[];
  };
  return parsed.results;
}

// ---------------------------------------------------------------------------
// Cliff-entity oracle: a sibling path that generates real chunks over a region
// and reads back every ACTUAL placed cliff entity via
// `surface.find_entities_filtered{ type = "cliff", area = ... }` - the ground
// truth for the end-to-end placement rule (fields + crossesCliff + orientation
// table), which neither `calculate_tile_properties` (values only) nor
// `get_tile` (tiles only) can report. Uses the DEFAULT preset (no
// property_expression_names routing), so real cliff placement runs.
// ---------------------------------------------------------------------------

/** Name of the cliff-entity probe mod (distinct from the noise / tile-name probes). */
export const CLIFF_PROBE_NAME = "oracle_cliff_probe";
/** File the cliff-entity mod writes into `<write-data>/script-output/`. */
export const CLIFF_DUMP_FILE = "oracle-cliff-dump.json";

/** A world-tile axis-aligned region `[x0, x1) x [y0, y1)`. */
export interface Region {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The cliff-entity mod's `info.json`. No noise-expression prototype is registered. */
export function buildCliffInfoJson(): object {
  return {
    name: CLIFF_PROBE_NAME,
    version: MOD_VERSION,
    title: "Cliff Entity Oracle Probe",
    author: "FactorioMapWebUI",
    factorio_version: "2.1",
  };
}

/** `mod-list.json` enabling `base` plus the cliff-entity probe. */
export function buildCliffModList(): object {
  return {
    mods: [
      { name: "base", enabled: true },
      { name: CLIFF_PROBE_NAME, enabled: true },
    ],
  };
}

/**
 * The cliff-entity mod's `control.lua`: on init, force-generate every 32-tile
 * chunk overlapping `region` (`request_to_generate_chunks` per chunk with
 * radius 0, then a single blocking `force_generate_chunk_requests()`), then read
 * every placed cliff back with `find_entities_filtered{ type = "cliff", area =
 * {{x0,y0},{x1,y1}} }` and write `{ cliffs: [{x, y, name, orientation}, ...] }`
 * JSON (the entity's `position`, which for a cliff is the cell CENTER on the
 * game's 4-tile grid), then `error(DUMPED-OK)` to exit. Chunk generation over the
 * whole region (not a per-point neighborhood like the tile path) is what makes
 * real cliffs appear.
 *
 * **`orientation` is what makes this an oracle for the port's tables rather than
 * only for its counts** (added 2026-07-30). `CLIFF_CODE_TO_ORIENTATION` maps a
 * cell's 8-bit crossing code to one of 20 `CliffOrientation`s, and until now it
 * was checked only against the binary's own jump table - so a misread and a
 * mistranscription would agree with each other. The game's `cliff_orientation`
 * string breaks that loop. It also yields the true `collision_bounding_box` for
 * cliffs we do NOT place, which is otherwise unobtainable: no placement, no code,
 * no box.
 */
export function buildCliffControlLua(
  region: Region,
  opts: {
    dumpFile?: string;
    planet?: string;
    seed?: number;
    entityType?: string;
    cliffSmoothing?: number;
  } = {},
): string {
  const dumpFile = opts.dumpFile ?? CLIFF_DUMP_FILE;
  // With `planet` set, run on that planet's own surface with the seed FORCED,
  // exactly as `buildEntityCountControlLua` does - so a Vulcanus capture describes
  // the surface `withCtxDefaults({ seed0: seed })` describes, not the
  // `seed + crc32(planet)` one a real save would generate. Every committed
  // Vulcanus fixture is captured this way; see `entityCounts.ts`'s header.
  // `cliff_smoothing` is set on the SAME `mgs` round-trip as the seed, before any
  // chunk is generated, so the surface is created with it already in force.
  const smoothingLua =
    opts.cliffSmoothing === undefined
      ? ""
      : `\n  mgs.cliff_settings.cliff_smoothing = ${String(opts.cliffSmoothing)}`;
  const surfaceLua =
    opts.planet === undefined
      ? `  local surface = game.surfaces[1]`
      : `  local surface = game.planets["${opts.planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${String(opts.seed ?? 123456)}${smoothingLua}
  surface.map_gen_settings = mgs`;
  return `script.on_init(function()
${surfaceLua}
  local x0, y0, x1, y1 = ${region.x0}, ${region.y0}, ${region.x1}, ${region.y1}
  local cx0 = math.floor(x0 / 32)
  local cy0 = math.floor(y0 / 32)
  local cx1 = math.ceil(x1 / 32) - 1
  local cy1 = math.ceil(y1 / 32) - 1
  for cy = cy0, cy1 do
    for cx = cx0, cx1 do
      surface.request_to_generate_chunks({x = cx * 32 + 16, y = cy * 32 + 16}, 0)
    end
  end
  surface.force_generate_chunk_requests()
  local ents = surface.find_entities_filtered{ type = "${opts.entityType ?? "cliff"}", area = {{x0, y0}, {x1, y1}} }
  local cliffs = {}
  for i, e in ipairs(ents) do
    -- \`cliff_orientation\` is a Cliff-subclass attribute, so reading it on any
    -- other type RAISES. This probe is reused verbatim with entityType =
    -- "resource" (captureVulcanusResourceEntities), hence the guard - without it
    -- that capture dies on its first entity.
    local orientation = nil
    if e.type == "cliff" then orientation = e.cliff_orientation end
    cliffs[i] = {x = e.position.x, y = e.position.y, name = e.name, orientation = orientation}
  end
  -- Read the cliff settings back OFF THE SURFACE rather than echoing what was
  -- written. That is what makes a smoothing sweep non-vacuous: if an override
  -- silently failed to apply, "the cliffs did not move" and "the setting did
  -- not change" are otherwise indistinguishable. It also reports the PROTOTYPE
  -- default when nothing was overridden, which is the only direct evidence of
  -- Vulcanus's cliff_smoothing = 1 outside the .lua data files.
  local cs = surface.map_gen_settings.cliff_settings
  local settings = {
    name = cs.name,
    cliff_elevation_0 = cs.cliff_elevation_0,
    cliff_elevation_interval = cs.cliff_elevation_interval,
    cliff_smoothing = cs.cliff_smoothing,
    richness = cs.richness,
  }
  helpers.write_file("${dumpFile}", helpers.table_to_json({ cliffs = cliffs, cliffSettings = settings }), false)
  error("DUMPED-OK")
end)
`;
}

/** The cliff-placement settings the surface reported, as dumped by the probe. */
export interface DumpedCliffSettings {
  readonly name: string;
  readonly cliff_elevation_0: number;
  readonly cliff_elevation_interval: number;
  readonly cliff_smoothing: number;
  readonly richness: number;
}

/** The cliff probe's full dump: the entities plus the settings that produced them. */
export interface CliffDump {
  readonly cliffs: Position[];
  readonly cliffSettings?: DumpedCliffSettings;
}

/** Parse the cliff-entity mod's dump into `{x, y}` cliff positions. */
export function parseCliffDump(jsonText: string): Position[] {
  const parsed = JSON.parse(jsonText) as CliffDump;
  return parsed.cliffs;
}

/** Parse the cliff-entity mod's dump whole, including the effective settings. */
export function parseCliffDumpFull(jsonText: string): CliffDump {
  return JSON.parse(jsonText) as CliffDump;
}

// ---------------------------------------------------------------------------
// Integration: run the real (or a fake) Factorio and read the values back.
// ---------------------------------------------------------------------------

/** The known macOS Steam install, used when `FACTORIO_BIN` is unset. */
export const DEFAULT_FACTORIO_BIN =
  process.env.FACTORIO_BIN ??
  `${process.env.HOME ?? ""}/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio`;

/** Bundled data dir sits next to the binary (`Contents/MacOS/factorio` -> `Contents/data`). */
export function defaultDataDir(bin: string): string {
  return join(dirname(bin), "..", "data");
}

/** True when a runnable Factorio binary is present, for gating the integration tests. */
export function oracleAvailable(bin: string = DEFAULT_FACTORIO_BIN): boolean {
  return existsSync(bin);
}

/** Default spawn wrapper around `node:child_process`. */
const nodeSpawn: SpawnFn = (bin, args) => ({
  done: () =>
    new Promise<SpawnResult>((resolve, reject) => {
      import("node:child_process")
        .then(({ spawn }) => {
          const child = spawn(bin, args as string[], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (d) => {
            stderr += String(d);
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
        })
        .catch(reject);
    }),
});

export interface OracleOptions {
  /** Scratch working dir (caller owns/cleans it). Mods, config, save, dump live here. */
  workDir: string;
  /** Map seed -> `seed0`. Default 123456. */
  seed?: number;
  /** Property the probe is routed onto. Default "elevation". */
  property?: string;
  /** Factorio binary. Default `FACTORIO_BIN` or the macOS Steam path. */
  factorioBin?: string;
  /** Bundled data dir. Default derived from the binary. */
  dataDir?: string;
  /** Extra `--map-gen-settings` fields (control levers, etc.). */
  mapGenOverrides?: Record<string, unknown>;
  /** Injectable spawn (default: real `node:child_process`). */
  spawnFn?: SpawnFn;
  /**
   * Route the probe through a Space-Age planet surface instead of the default
   * Nauvis surface at `game.surfaces[1]`. Enables `space-age`/`elevated-rails`/
   * `quality` in `mod-list.json` and creates/configures the planet's own
   * surface at runtime (see {@link buildSpaceAgeControlLua}) - required for
   * planet-specific named noise expressions (e.g. `vulcanus_temperature`) to
   * resolve. Default false; the non-Space-Age path is unaffected either way.
   */
  spaceAge?: boolean;
  /** Which planet's surface to route onto when {@link spaceAge} is set. Default "vulcanus". */
  planet?: string;
  /** Entity `type` for {@link sampleCliffEntities}'s dump. Default "cliff". */
  entityType?: string;
  /**
   * Override `map_gen_settings.cliff_settings.cliff_smoothing` on the created
   * surface. Omit to take whatever the planet's prototype supplies - which is
   * the point of {@link CliffDump.cliffSettings}: the dump reports the value the
   * game actually read back, so "the override applied" is measured rather than
   * assumed. See `docs/noise/cliffs-NOTES.md`; Vulcanus takes the prototype
   * default of 1 while every other planet sets 0 explicitly.
   */
  cliffSmoothing?: number;
}

/**
 * Sample a named noise `expression` at `positions` through the real game, returning
 * the values the game computed (aligned with `positions`). ~1.7 s per call. Throws
 * if the binary is missing (gate calls with {@link oracleAvailable}) or if no dump
 * was produced.
 */
export async function sampleExpression(
  expression: string,
  positions: readonly Position[],
  opts: OracleOptions,
): Promise<number[]> {
  const seed = opts.seed ?? 123456;
  const property = opts.property ?? "elevation";
  const factorioBin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const dataDir = opts.dataDir ?? defaultDataDir(factorioBin);
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  const { workDir } = opts;
  const modDir = join(workDir, "mods");
  const modFilesDir = join(modDir, `${PROBE_NAME}_${MOD_VERSION}`);
  const writeDataDir = join(workDir, "write");
  const savePath = join(writeDataDir, "probe.zip");
  const mapGenPath = join(workDir, "map-gen-settings.json");
  const configPath = join(workDir, "config.ini");

  await mkdir(modFilesDir, { recursive: true });
  await mkdir(writeDataDir, { recursive: true });
  await writeFile(join(modFilesDir, "info.json"), JSON.stringify(buildInfoJson(), null, 2));
  await writeFile(join(modFilesDir, "data.lua"), buildDataLua(expression));
  await writeFile(
    join(modFilesDir, "control.lua"),
    opts.spaceAge
      ? buildSpaceAgeControlLua(positions, { property, planet: opts.planet, seed })
      : buildControlLua(positions, { property }),
  );
  await writeFile(
    join(modDir, "mod-list.json"),
    JSON.stringify(opts.spaceAge ? buildSpaceAgeModList() : buildModList(), null, 2),
  );
  await writeFile(
    mapGenPath,
    JSON.stringify(buildMapGenSettings({ seed, property, overrides: opts.mapGenOverrides })),
  );
  await writeFile(configPath, buildConfigIni(writeDataDir, dataDir));

  const args = buildFactorioArgs({ savePath, mapGenPath, seed, modDir, configPath });
  const { stderr } = await spawnFn(factorioBin, args).done();

  const dumpPath = join(writeDataDir, "script-output", DUMP_FILE);
  let jsonText: string;
  try {
    jsonText = await readFile(dumpPath, "utf8");
  } catch {
    throw new Error(
      `oracle produced no dump at ${dumpPath}. Factorio stderr tail:\n${stderr.slice(-2000)}`,
    );
  }
  return parseDump(jsonText).values;
}

/** A tile-name oracle result: the ACTUAL floored position `get_tile` was called at, plus its name. */
export interface TileSample {
  readonly x: number;
  readonly y: number;
  readonly name: string;
}

/**
 * Sample the placed tile name (`surface.get_tile(x, y).name`) at `positions`
 * through the real game, for the DEFAULT preset (no property routing) -
 * `sampleExpression` can only report noise values, not the tile the game
 * actually chose. Returns one {@link TileSample} per input position, in order,
 * carrying back the SAME floored x/y that was actually passed to `get_tile`
 * (not necessarily equal to the fractional input) so callers can't pair an
 * unfloored position with a floored sample. `opts.radius` is the PER-POINT
 * chunk-generation radius (default 1, i.e. a 3x3 chunk neighborhood around
 * each point) - scattered far-apart points are generated individually rather
 * than as one giant origin-centered disc, since generation cost scales with
 * radius^2. ~1-2s per call depending on point count; throws if the binary is
 * missing (gate calls with {@link oracleAvailable}) or if no dump was
 * produced.
 */
export async function sampleTileNames(
  positions: readonly Position[],
  opts: OracleOptions & { radius?: number },
): Promise<TileSample[]> {
  const seed = opts.seed ?? 123456;
  const factorioBin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const dataDir = opts.dataDir ?? defaultDataDir(factorioBin);
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  const { workDir } = opts;
  const modDir = join(workDir, "mods");
  const modFilesDir = join(modDir, `${TILE_PROBE_NAME}_${MOD_VERSION}`);
  const writeDataDir = join(workDir, "write");
  const savePath = join(writeDataDir, "probe.zip");
  const mapGenPath = join(workDir, "map-gen-settings.json");
  const configPath = join(workDir, "config.ini");

  await mkdir(modFilesDir, { recursive: true });
  await mkdir(writeDataDir, { recursive: true });
  await writeFile(join(modFilesDir, "info.json"), JSON.stringify(buildTileInfoJson(), null, 2));
  await writeFile(
    join(modFilesDir, "control.lua"),
    opts.spaceAge
      ? buildSpaceAgeTileControlLua(positions, { radius: opts.radius, planet: opts.planet, seed })
      : buildTileControlLua(positions, { radius: opts.radius }),
  );
  await writeFile(
    join(modDir, "mod-list.json"),
    JSON.stringify(
      opts.spaceAge ? buildSpaceAgeModList(TILE_PROBE_NAME) : buildTileModList(),
      null,
      2,
    ),
  );
  await writeFile(mapGenPath, JSON.stringify(buildTileMapGenSettings(seed)));
  await writeFile(configPath, buildConfigIni(writeDataDir, dataDir));

  const args = buildFactorioArgs({ savePath, mapGenPath, seed, modDir, configPath });
  const { stderr } = await spawnFn(factorioBin, args).done();

  const dumpPath = join(writeDataDir, "script-output", TILE_DUMP_FILE);
  let jsonText: string;
  try {
    jsonText = await readFile(dumpPath, "utf8");
  } catch {
    throw new Error(
      `tile oracle produced no dump at ${dumpPath}. Factorio stderr tail:\n${stderr.slice(-2000)}`,
    );
  }
  return parseTileDump(jsonText);
}

/**
 * Sample every ACTUAL cliff entity the game placed in `region`, through the real
 * game, for the DEFAULT preset (no property routing) - the end-to-end ground
 * truth for the cliff placement rule (`makeCliffPlacement`), which neither
 * `sampleExpression` (values) nor `sampleTileNames` (tiles) can report. Forces
 * generation of every 32-tile chunk overlapping the region, then returns each
 * cliff's `position` (the cell center on the 4-tile grid). Slower than a
 * point-sample (chunk generation over the whole region: seconds to tens of
 * seconds for a 16x16-chunk region); throws if the binary is missing (gate with
 * {@link oracleAvailable}) or if no dump was produced.
 */
export async function sampleCliffEntities(
  region: Region,
  opts: OracleOptions,
): Promise<Position[]> {
  return (await sampleCliffEntitiesFull(region, opts)).cliffs;
}

/**
 * As {@link sampleCliffEntities}, but returns the effective `cliff_settings` the
 * surface reported alongside the entities. Use this whenever a capture varies a
 * cliff setting: the reported value is the proof the override took, and a sweep
 * that cannot show that is not a sweep.
 */
export async function sampleCliffEntitiesFull(
  region: Region,
  opts: OracleOptions,
): Promise<CliffDump> {
  const seed = opts.seed ?? 123456;
  const factorioBin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const dataDir = opts.dataDir ?? defaultDataDir(factorioBin);
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  const { workDir } = opts;
  const modDir = join(workDir, "mods");
  const modFilesDir = join(modDir, `${CLIFF_PROBE_NAME}_${MOD_VERSION}`);
  const writeDataDir = join(workDir, "write");
  const savePath = join(writeDataDir, "probe.zip");
  const mapGenPath = join(workDir, "map-gen-settings.json");
  const configPath = join(workDir, "config.ini");

  await mkdir(modFilesDir, { recursive: true });
  await mkdir(writeDataDir, { recursive: true });
  await writeFile(join(modFilesDir, "info.json"), JSON.stringify(buildCliffInfoJson(), null, 2));
  await writeFile(
    join(modFilesDir, "control.lua"),
    buildCliffControlLua(region, {
      planet: opts.spaceAge === true ? (opts.planet ?? "vulcanus") : undefined,
      seed,
      entityType: opts.entityType,
      cliffSmoothing: opts.cliffSmoothing,
    }),
  );
  await writeFile(
    join(modDir, "mod-list.json"),
    JSON.stringify(
      opts.spaceAge === true ? buildSpaceAgeModList(CLIFF_PROBE_NAME) : buildCliffModList(),
      null,
      2,
    ),
  );
  await writeFile(mapGenPath, JSON.stringify(buildTileMapGenSettings(seed)));
  await writeFile(configPath, buildConfigIni(writeDataDir, dataDir));

  const args = buildFactorioArgs({ savePath, mapGenPath, seed, modDir, configPath });
  const { stderr } = await spawnFn(factorioBin, args).done();

  const dumpPath = join(writeDataDir, "script-output", CLIFF_DUMP_FILE);
  let jsonText: string;
  try {
    jsonText = await readFile(dumpPath, "utf8");
  } catch {
    throw new Error(
      `cliff oracle produced no dump at ${dumpPath}. Factorio stderr tail:\n${stderr.slice(-2000)}`,
    );
  }
  return parseCliffDumpFull(jsonText);
}
