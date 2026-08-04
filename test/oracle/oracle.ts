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
  opts: {
    radius?: number;
    dumpFile?: string;
    planet?: string;
    seed?: number;
    /**
     * Override `map_gen_settings.autoplace_controls`, keyed by the GAME's own
     * control names (`calcite`, `sulfuric_acid_geyser`, ...). Added for #84: the
     * resource controls are NOT an entity-only lever - `vulcanus_calcite_region`
     * depends on `control:calcite:size` and `frequency`, and it feeds the TILE
     * expression `volcanic_jagged_ground_range` in
     * `space-age/prototypes/tile/tiles-vulcanus.lua`. So switching a resource
     * off moves tiles, and whether any of them is cliff-BLOCKING is the question
     * this probe exists to answer against the game rather than against our port.
     */
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  } = {},
): string {
  const dumpFile = opts.dumpFile ?? TILE_DUMP_FILE;
  const radius = opts.radius ?? 1;
  const planet = opts.planet ?? "vulcanus";
  const seed = opts.seed ?? 123456;
  const posLua = positions
    .map((p) => `    {x = ${Math.floor(p.x)}, y = ${Math.floor(p.y)}}`)
    .join(",\n");
  const controlsLua = Object.entries(opts.autoplaceControls ?? {})
    .map(
      ([k, v]) =>
        `\n  mgs.autoplace_controls[${JSON.stringify(k)}] = ` +
        `{frequency = ${String(v.frequency)}, size = ${String(v.size)}, richness = ${String(v.richness)}}`,
    )
    .join("");
  return `script.on_init(function()
  local positions = {
${posLua}
  }
  local surface = game.planets["${planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${seed}${controlsLua}
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
  -- Read the controls BACK off the surface. "No tile moved" and "the override
  -- never applied" print the same thing without this.
  local applied = {}
  for k, v in pairs(surface.map_gen_settings.autoplace_controls) do
    applied[k] = {frequency = v.frequency, size = v.size, richness = v.richness}
  end
  helpers.write_file("${dumpFile}", helpers.table_to_json({ results = results, autoplaceControls = applied }), false)
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

/**
 * {@link parseTileDump} plus the `autoplace_controls` the surface reported back.
 * Older dumps carry no such key, so it defaults to an empty object rather than
 * throwing - a fixture captured before #84 is still readable.
 */
export function parseTileDumpFull(jsonText: string): {
  samples: { readonly x: number; readonly y: number; readonly name: string }[];
  autoplaceControls: Record<string, { frequency: number; size: number; richness: number }>;
} {
  const parsed = JSON.parse(jsonText) as {
    results: { x: number; y: number; name: string }[];
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  };
  return { samples: parsed.results, autoplaceControls: parsed.autoplaceControls ?? {} };
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
    cliffSettings?: Readonly<Record<string, number | string>>;
    propertyRoutes?: Readonly<Record<string, string>>;
    autoplaceControls?: Readonly<
      Record<string, { frequency: number; size: number; richness: number }>
    >;
    alsoResources?: boolean;
    protoNames?: readonly string[];
    disableAutoplaceCategories?: readonly string[];
    excludeFromAutoplaceCategory?: Readonly<Record<string, readonly string[]>>;
    countTileNames?: readonly string[];
    alsoEntities?: boolean;
  } = {},
): string {
  const dumpFile = opts.dumpFile ?? CLIFF_DUMP_FILE;
  // With `planet` set, run on that planet's own surface with the seed FORCED,
  // exactly as `buildEntityCountControlLua` does - so a Vulcanus capture describes
  // the surface `withCtxDefaults({ seed0: seed })` describes, not the
  // `seed + crc32(planet)` one a real save would generate. Every committed
  // Vulcanus fixture is captured this way; see `entityCounts.ts`'s header.
  // Cliff settings go on the SAME `mgs` round-trip as the seed, before any chunk
  // in the sampled region is generated, so generation sees them in force.
  const settingsLua = Object.entries(opts.cliffSettings ?? {})
    .map(
      ([k, v]) =>
        `\n  mgs.cliff_settings.${k} = ${typeof v === "string" ? JSON.stringify(v) : String(v)}`,
    )
    .join("");
  // Property routes ride the same round-trip. Routing `cliff_elevation` at a
  // probe expression is what lets the CLIFF GENERATOR be used as the readout for
  // an expression, instead of `calculate_tile_properties` - a different channel,
  // and the whole point when the primitive under test is documented as
  // grid-dependent.
  const routesLua = Object.entries(opts.propertyRoutes ?? {})
    .map(
      ([k, v]) => `\n  mgs.property_expression_names[${JSON.stringify(k)}] = ${JSON.stringify(v)}`,
    )
    .join("");
  // Rides the same `mgs` round-trip as the cliff settings and the routes, so a
  // resource arm and a cliff arm are set the same way and land before any chunk
  // in the sampled region exists.
  const autoplaceLua = Object.entries(opts.autoplaceControls ?? {})
    .map(
      ([k, v]) =>
        `\n  mgs.autoplace_controls[${JSON.stringify(k)}] = ` +
        `{frequency = ${String(v.frequency)}, size = ${String(v.size)}, richness = ${String(v.richness)}}`,
    )
    .join("");
  // The LEVER for "is any placed ENTITY what suppresses these cliffs" (#84).
  // `autoplace_settings[category] = {treat_missing_as_default = false, settings
  // = {}}` switches a whole autoplace category off wholesale, which
  // `autoplace_controls` cannot do: a control only reaches the prototypes that
  // name one, so rocks, chimneys and crater-cliffs have no control to turn.
  //
  // It rides the same `mgs` round-trip as everything else, and the dump reports
  // `autoplace_settings` read BACK off the surface - which is the arm that
  // separates "no entity matters" from "the override never applied".
  const autoplaceSettingsLua = (opts.disableAutoplaceCategories ?? [])
    .map(
      (c) =>
        `\n  mgs.autoplace_settings[${JSON.stringify(c)}] = ` +
        `{treat_missing_as_default = false, settings = {}}`,
    )
    .join("");
  // The same lever aimed at ONE prototype instead of a whole category: keep the
  // category's own settings, minus the named entries. Built by reading the
  // surface's defaults rather than by listing 19 Vulcanus tile names here, so it
  // cannot drift from the game's own list.
  //
  // This is what makes lava a LEVER rather than a model: with `lava`/`lava-hot`
  // out of the tile autoplace, the cliff generator's tile-collision rejection has
  // nothing to reject against, while the elevation the crossings read is
  // untouched (tiles are downstream of it). The cells that appear are then the
  // game's own answer to "which cliffs does lava suppress".
  const excludeLua = Object.entries(opts.excludeFromAutoplaceCategory ?? {})
    .map(
      ([cat, names]) => `
  do
    local kept = {}
    for n, v in pairs((mgs.autoplace_settings[${JSON.stringify(cat)}] or {}).settings or {}) do
      kept[n] = v
    end
${names.map((n) => `    kept[${JSON.stringify(n)}] = nil`).join("\n")}
    mgs.autoplace_settings[${JSON.stringify(cat)}] =
      {treat_missing_as_default = false, settings = kept}
  end`,
    )
    .join("");
  // The Nauvis path needs the same round-trip when settings are overridden. It
  // is safe on `surfaces[1]` because the sampled regions are far from spawn and
  // therefore ungenerated at `on_init` - a setting cannot retro-edit a chunk
  // that already exists, so a near-spawn region would silently ignore this.
  const overridesLua = `${settingsLua}${routesLua}${autoplaceLua}${autoplaceSettingsLua}${excludeLua}`;
  const nauvisLua =
    overridesLua === ""
      ? `  local surface = game.surfaces[1]`
      : `  local surface = game.surfaces[1]
  local mgs = surface.map_gen_settings${overridesLua}
  surface.map_gen_settings = mgs`;
  const surfaceLua =
    opts.planet === undefined
      ? nauvisLua
      : `  local surface = game.planets["${opts.planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${String(opts.seed ?? 123456)}${overridesLua}
  surface.map_gen_settings = mgs`;
  // `resources`, `protos` and `autoplace` stay nil unless asked for, so
  // `table_to_json` simply omits them and every existing fixture's shape is
  // byte-identical to what it was before this option existed.
  const resourceLua =
    opts.alsoResources !== true
      ? "  local resources, protos, autoplace = nil, nil, nil"
      : `  local resources = {}
  for i, e in ipairs(surface.find_entities_filtered{ type = "resource", area = {{x0, y0}, {x1, y1}} }) do
    resources[i] = {x = e.position.x, y = e.position.y, name = e.name}
  end
  -- Prototype geometry read off the RUNNING GAME. #94 ruled entity collision
  -- out for ore by reasoning about layers; the game then said ore suppresses
  -- cliffs anyway, so the layers belong in the fixture rather than in a claim.
  -- The collision boxes are what makes the geyser separable from the ores: its
  -- half-extent is 1.398 against their 0.098.
  local protos = {}
  for _, n in ipairs({${(opts.protoNames ?? []).map((p) => JSON.stringify(p)).join(", ")}}) do
    local p = prototypes.entity[n]
    if p then
      local layers = {}
      if p.collision_mask and p.collision_mask.layers then
        for l, v in pairs(p.collision_mask.layers) do if v then layers[#layers + 1] = l end end
      end
      table.sort(layers)
      protos[n] = {
        type = p.type,
        layers = layers,
        box = p.collision_box and {
          lx = p.collision_box.left_top.x, ly = p.collision_box.left_top.y,
          rx = p.collision_box.right_bottom.x, ry = p.collision_box.right_bottom.y,
        } or nil,
      }
    end
  end
  local autoplace = {}
  for k, v in pairs(surface.map_gen_settings.autoplace_controls) do
    autoplace[k] = {frequency = v.frequency, size = v.size, richness = v.richness}
  end`;
  // Every entity in the region, whatever its type - the positive half of the
  // lever above. "No entity suppresses these cliffs" is worth much more when the
  // same run says WHICH entities were standing there to not suppress them.
  const entitiesLua =
    opts.alsoEntities !== true
      ? "  local entities = nil"
      : `  local entities = {}
  for i, e in ipairs(surface.find_entities_filtered{ area = {{x0, y0}, {x1, y1}} }) do
    entities[i] = {x = e.position.x, y = e.position.y, name = e.name, type = e.type}
  end`;
  // Read BACK, per category: the proof an autoplace_settings lever landed. An
  // empty entity list, or an unmoved cliff, means nothing either way unless this
  // says the category was actually changed. Emitted whenever a lever is pulled
  // as well as on demand, so a lever can never be reported without it.
  const usesLever =
    (opts.disableAutoplaceCategories ?? []).length > 0 ||
    Object.keys(opts.excludeFromAutoplaceCategory ?? {}).length > 0;
  const apSettingsLua =
    opts.alsoEntities !== true && !usesLever
      ? "  local apSettings = nil"
      : `  local apSettings = {}
  for k, v in pairs(surface.map_gen_settings.autoplace_settings or {}) do
    local n = 0
    for _ in pairs(v.settings or {}) do n = n + 1 end
    apSettings[k] = {treat_missing_as_default = v.treat_missing_as_default, settingsCount = n}
  end`;
  // Tiles counted in the SAME run that placed the cliffs. This is the
  // non-vacuity arm for a tile lever: "lava suppresses no cliffs" and "the lava
  // override never applied" are otherwise the same observation.
  const tileCountLua =
    (opts.countTileNames ?? []).length === 0
      ? "  local tileCounts = nil"
      : `  local tileCounts = {}
  for _, n in ipairs({${(opts.countTileNames ?? []).map((n) => JSON.stringify(n)).join(", ")}}) do
    tileCounts[n] = surface.count_tiles_filtered{ name = n, area = {{x0, y0}, {x1, y1}} }
  end`;
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
${resourceLua}
${entitiesLua}
${apSettingsLua}
${tileCountLua}
  helpers.write_file("${dumpFile}", helpers.table_to_json({
    cliffs = cliffs, cliffSettings = settings,
    resources = resources, protos = protos, autoplaceControls = autoplace,
    entities = entities, autoplaceSettings = apSettings, tileCounts = tileCounts,
  }), false)
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

/** A prototype's collision geometry, as the running game reports it. */
export interface DumpedProto {
  readonly type: string;
  readonly layers: string[];
  readonly box?: { lx: number; ly: number; rx: number; ry: number };
}

/** The cliff probe's full dump: the entities plus the settings that produced them. */
export interface CliffDump {
  readonly cliffs: Position[];
  readonly cliffSettings?: DumpedCliffSettings;
  /** Present only with `alsoResources`. `type = "resource"` entities in the same region. */
  readonly resources?: Position[];
  /** Present only with `alsoResources`. Collision geometry of `protoNames`. */
  readonly protos?: Record<string, DumpedProto>;
  /** Present only with `alsoResources`. The autoplace controls the surface read BACK. */
  readonly autoplaceControls?: Record<
    string,
    { frequency: number; size: number; richness: number }
  >;
  /** Present only with `alsoEntities`. EVERY entity in the region, any type. */
  readonly entities?: { x: number; y: number; name: string; type: string }[];
  /**
   * Present only with `alsoEntities`. `autoplace_settings` read back off the
   * surface, per category - the proof that a `disableAutoplaceCategories` lever
   * applied, rather than an empty entity list that could mean anything.
   */
  readonly autoplaceSettings?: Record<
    string,
    { treat_missing_as_default: boolean; settingsCount: number }
  >;
  /** Present only with `countTileNames`. Tile counts in the region, per name. */
  readonly tileCounts?: Record<string, number>;
}

/** Parse the cliff-entity mod's dump into `{x, y}` cliff positions. */
export function parseCliffDump(jsonText: string): Position[] {
  const parsed = JSON.parse(jsonText) as CliffDump;
  return parsed.cliffs;
}

/**
 * Parse the cliff-entity mod's dump whole, including the effective settings.
 *
 * `cliffs` is normalised to an array because `helpers.table_to_json` serialises
 * an EMPTY Lua table as `{}`, not `[]` - so a run that legitimately placed no
 * cliffs comes back as an object and `.length` reads `undefined` rather than 0.
 * That is a real configuration (setting `richness` high on Nauvis raises
 * `cliffiness_nauvis`'s cutoff until nothing qualifies), and it must read as
 * zero rather than as a broken dump.
 */
export function parseCliffDumpFull(jsonText: string): CliffDump {
  const parsed = JSON.parse(jsonText) as {
    cliffs?: unknown;
    cliffSettings?: DumpedCliffSettings;
    resources?: unknown;
    protos?: Record<string, DumpedProto>;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
    entities?: unknown;
    autoplaceSettings?: Record<
      string,
      { treat_missing_as_default: boolean; settingsCount: number }
    >;
    tileCounts?: Record<string, number>;
  };
  return {
    cliffs: Array.isArray(parsed.cliffs) ? (parsed.cliffs as Position[]) : [],
    cliffSettings: parsed.cliffSettings,
    // The `Array.isArray` guard is load-bearing on BOTH lists, not defensive
    // padding: an EMPTY Lua table serialises to `{}`, so a resources-off arm -
    // exactly the arm these captures exist for - comes back as an object and
    // dies on the first `for ... of` without it.
    resources:
      parsed.resources === undefined
        ? undefined
        : Array.isArray(parsed.resources)
          ? (parsed.resources as Position[])
          : [],
    protos: parsed.protos,
    autoplaceControls: parsed.autoplaceControls,
    // Same `{}`-for-empty hazard as `resources`, and it bites harder here: the
    // whole point of the lever arm is that its entity list comes back EMPTY.
    entities:
      parsed.entities === undefined
        ? undefined
        : Array.isArray(parsed.entities)
          ? (parsed.entities as { x: number; y: number; name: string; type: string }[])
          : [],
    autoplaceSettings: parsed.autoplaceSettings,
    tileCounts: parsed.tileCounts,
  };
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
   * Override fields of `map_gen_settings.cliff_settings` on the created surface,
   * keyed by the GAME's own field names so the generated Lua is a direct
   * assignment with no translation layer to get wrong.
   *
   * This is the sharpest tool the cliff work has: `cliff_settings` is where the
   * whole placement rule's constants live, so a term can be turned OFF in the
   * game rather than modelled. `cliff_elevation_interval` set huge leaves a
   * single contour at `cliff_elevation_0` (no band arithmetic); `cliff_smoothing
   * = 0` removes the smoothing. Together they reduce the rule to "an edge
   * crosses iff elevation crosses `cliff_elevation_0`, wherever the gate is
   * open".
   *
   * **`richness = 4` does NOT hold the gate open everywhere, and this comment
   * used to say it did.** The reasoning was that `0.5*log2(4) = 1` saturates
   * `cliffiness_basic` at 1.5 - but the expression is
   * `clamp(0.5*log2(richness) + qmn, 0, 1) + 0.5`, so at richness 4 the clamp is
   * `clamp(1 + qmn, 0, 1)`, which is still 0 - and the `> 0.5` gate still SHUT -
   * wherever `qmn <= -1`. Measured 2026-08-03 (#84): routing the `cliffiness`
   * property at the literal `1` instead places strictly more cliffs at 13 of 15
   * levels, by up to 135 at one. Worse, richness 4 shifts the clamp by exactly
   * +1, so the corners that decide the gate become the ones the DEFAULT field
   * clamps flat - the 8,409-of-12,675 population no fixture validates.
   *
   * So prefer `probeProperty: "cliffiness", probeExpression: "1"` when the gate
   * is meant to be out of the way: that is a construction, not a model.
   * `richness = 4` stays useful as the arm that keeps `cliffiness_basic` in the
   * loop, and `oracle-vulcanus-cliff-bands` captures both for that reason.
   *
   * Omit to take whatever the planet supplies. Either way the dump reports the
   * settings the surface read BACK ({@link CliffDump.cliffSettings}), so an
   * override that failed to apply cannot be mistaken for one that did nothing.
   */
  cliffSettings?: Readonly<Record<string, number | string>>;
  /**
   * Register this expression as `oracle_probe` at the data stage and route it
   * onto {@link probeProperty} (default `cliff_elevation`) for the cliff
   * sampler, so the CLIFF GENERATOR becomes the readout for an expression
   * instead of `calculate_tile_properties`.
   *
   * That distinction is the point. The two are different channels - the cliff
   * generator walks a 4-tile corner lattice, `calculate_tile_properties` does
   * not - and `multisample` is documented as evaluating "in a separate noise
   * program with a larger grid". Every measurement of that primitive so far went
   * through the other channel, so a grid dependence would have been invisible.
   */
  probeExpression?: string;
  /** Property {@link probeExpression} is routed onto. Default `cliff_elevation`. */
  probeProperty?: string;
  /**
   * Override `map_gen_settings.autoplace_controls`, keyed by the GAME's own
   * control names (`tungsten_ore`, `calcite`, `vulcanus_coal`,
   * `sulfuric_acid_geyser` - note the underscores, and that they are NOT the
   * entity names).
   *
   * This is {@link cliffSettings}'s trick applied one subsystem over: instead of
   * arguing about whether resources and cliffs interact, set `size = 0` and let
   * the game answer. It is what settled the direction of the cliff/ore exclusion
   * (#84, #24) - with the resources off, cliffs appear where the game otherwise
   * leaves a hole, while forcing 335 cliffs through an ore field moves the ore
   * not one tile.
   *
   * The dump reports the controls the surface read BACK
   * ({@link CliffDump.autoplaceControls}), for the same reason `cliffSettings`
   * does: an override that silently failed to apply and a term that does not
   * matter are otherwise indistinguishable.
   */
  autoplaceControls?: Readonly<
    Record<string, { frequency: number; size: number; richness: number }>
  >;
  /**
   * Also dump `type = "resource"` entities and the collision geometry of the
   * named prototypes, in the SAME run as the cliffs.
   *
   * Two runs cannot answer this question. "The resources moved" and "the cliffs
   * moved" have to be read off one generated surface or the comparison is
   * between two different worlds; and a resource arm's non-vacuity check ("the
   * ore really did disappear") has to come from the arm itself.
   */
  alsoResources?: boolean;
  /** Entity prototypes whose collision box and mask layers to dump. Needs {@link alsoResources}. */
  protoNames?: readonly string[];
  /**
   * `map_gen_settings.autoplace_settings` categories (`"entity"`, `"tile"`,
   * `"decorative"`) to switch off wholesale - `treat_missing_as_default = false`
   * with no settings, so nothing in the category is placed.
   *
   * This is the lever `autoplaceControls` cannot pull. A control only reaches
   * prototypes that name one, so the ores have one and the rocks, chimneys and
   * crater-cliffs do not; asking "does ANY placed entity suppress these cliffs"
   * needs the category. Pair it with {@link alsoEntities}, whose read-back of
   * `autoplace_settings` is what proves the override applied.
   */
  disableAutoplaceCategories?: readonly string[];
  /**
   * Per autoplace category, prototype names to REMOVE from the category's own
   * settings (the rest are kept, `treat_missing_as_default` goes false). Built
   * in Lua from the surface's own defaults, so it never has to restate the
   * game's list.
   *
   * This is what turns lava into a lever: with `lava`/`lava-hot` out of the tile
   * autoplace, the cliff generator's tile-collision rejection has nothing to
   * reject against, while the elevation its crossings read is untouched. Pair it
   * with {@link countTileNames} - "lava suppresses nothing" and "the override
   * never applied" are otherwise the same observation.
   */
  excludeFromAutoplaceCategory?: Readonly<Record<string, readonly string[]>>;
  /** Count tiles of these names in the region, in the same run. */
  countTileNames?: readonly string[];
  /**
   * Dump every entity in the region (any type, with its `type`), not just the
   * `entityType` ones. The positive half of the lever above: it says what was
   * standing where, rather than only that the cliffs did or did not move.
   */
  alsoEntities?: boolean;
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
  return (await sampleTileNamesFull(positions, opts)).samples;
}

/**
 * {@link sampleTileNames} plus the `autoplace_controls` the SURFACE read back,
 * and the ability to override them.
 *
 * Added for #84. The resource controls are not an entity-only lever:
 * `vulcanus_calcite_region` depends on `control:calcite:size` and `frequency`
 * and feeds the TILE expression `volcanic_jagged_ground_range`, so switching a
 * resource off moves tiles. Whether any of those tiles is cliff-BLOCKING decides
 * whether the ore lever is confounded for cliffs, and that has to be asked of
 * the game rather than of our own tile model.
 *
 * The read-back is the point of the separate entry: "no tile moved" and "the
 * override never applied" print the same thing without it.
 */
export async function sampleTileNamesFull(
  positions: readonly Position[],
  opts: OracleOptions & {
    radius?: number;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  },
): Promise<{
  samples: TileSample[];
  autoplaceControls: Record<string, { frequency: number; size: number; richness: number }>;
}> {
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
      ? buildSpaceAgeTileControlLua(positions, {
          radius: opts.radius,
          planet: opts.planet,
          seed,
          autoplaceControls: opts.autoplaceControls,
        })
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
  return parseTileDumpFull(jsonText);
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
      cliffSettings: opts.cliffSettings,
      autoplaceControls: opts.autoplaceControls,
      alsoResources: opts.alsoResources,
      protoNames: opts.protoNames,
      disableAutoplaceCategories: opts.disableAutoplaceCategories,
      excludeFromAutoplaceCategory: opts.excludeFromAutoplaceCategory,
      countTileNames: opts.countTileNames,
      alsoEntities: opts.alsoEntities,
      propertyRoutes:
        opts.probeExpression === undefined
          ? undefined
          : { [opts.probeProperty ?? "cliff_elevation"]: PROBE_NAME },
    }),
  );
  // The probe is a data-stage registration, so it goes in the same mod as the
  // control script rather than a second mod.
  if (opts.probeExpression !== undefined)
    await writeFile(join(modFilesDir, "data.lua"), buildDataLua(opts.probeExpression));
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
