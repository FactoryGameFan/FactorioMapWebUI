/**
 * The entity-DENSITY oracle: how many entities of a given name the game actually
 * places in a region, for the default preset.
 *
 * This is the ground truth the approximate placement roll
 * (`src/noise/placement/placementRoll.ts`) is validated against. The roll drops
 * the game's cross-overlay arbitration and its per-placement jitter draws, so
 * individual entity POSITIONS are not expected to match - only how many tiles
 * come up placed over a region. That is exactly what a count answers and what
 * `test/entityDensity.spec.ts` asserts; see
 * `docs/superpowers/specs/2026-07-27-placement-roll-stipple-design.md`.
 *
 * The recipe is `sampleCliffEntities`' (see `oracle.ts`): a probe mod forces
 * generation of every 32-tile chunk overlapping the region, then reads the
 * result back and `error("DUMPED-OK")`s to exit. Only the `control.lua` body and
 * the dump filename differ - `count_entities_filtered{area, name}` per requested
 * name instead of `find_entities_filtered{type = "cliff"}`.
 *
 * Two things worth knowing before changing this file:
 *
 * 1. **`count_entities_filtered` raises on a name whose prototype is not
 *    loaded.** A Nauvis run (base only) cannot be asked for
 *    `huge-volcanic-rock`, so each run is passed only the names that exist in
 *    its own mod set. The capture below keeps two separate name lists for that
 *    reason.
 * 2. **The Space-Age path FORCES the surface seed** (`mgs.seed = seed`,
 *    the same read-modify-write {@link buildSpaceAgeTileControlLua} uses), so
 *    the sampled surface is the one `withCtxDefaults({ seed0: seed })` describes
 *    rather than the one a real save at `--map-gen-seed <seed>` would produce
 *    (that would be `seed + crc32(planet)`; see `src/model/planetSurfaceSeed.ts`).
 *    This matches every other committed Vulcanus oracle fixture, and it is what
 *    lets the spec build its fields from `fixture.seed` directly. Changing it
 *    means changing the spec's ctx to match.
 *
 * Run the capture (needs a local Factorio 2.1 install; writes the committed
 * fixture, so do it deliberately):
 *
 *   node --experimental-strip-types test/oracle/entityCounts.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The .ts extension is required because this file is executed directly by Node
// (`--experimental-strip-types`), which does no extension resolution.
import {
  buildConfigIni,
  buildFactorioArgs,
  buildSpaceAgeModList,
  buildTileMapGenSettings,
  DEFAULT_FACTORIO_BIN,
  defaultDataDir,
  oracleAvailable,
  type OracleOptions,
  type Region,
  type SpawnFn,
} from "./oracle.ts";

/** Name of the entity-count probe mod (distinct from the noise / tile / cliff probes). */
export const ENTITY_COUNT_PROBE_NAME = "oracle_entity_count_probe";
/** File the entity-count mod writes into `<write-data>/script-output/`. */
export const ENTITY_COUNT_DUMP_FILE = "oracle-entity-count-dump.json";
const MOD_VERSION = "0.0.1";

/** The entity-count mod's `info.json`. No noise-expression prototype is registered. */
export function buildEntityCountInfoJson(): object {
  return {
    name: ENTITY_COUNT_PROBE_NAME,
    version: MOD_VERSION,
    title: "Entity Count Oracle Probe",
    author: "FactorioMapWebUI",
    factorio_version: "2.1",
  };
}

/** `mod-list.json` enabling `base` plus the entity-count probe. */
export function buildEntityCountModList(): object {
  return {
    mods: [
      { name: "base", enabled: true },
      { name: ENTITY_COUNT_PROBE_NAME, enabled: true },
    ],
  };
}

/**
 * The entity-count mod's `control.lua`: on init, force-generate every 32-tile
 * chunk overlapping `region` (the cliff probe's exact call shape -
 * `request_to_generate_chunks` per chunk with radius 0, then one blocking
 * `force_generate_chunk_requests()`), then `count_entities_filtered{area, name}`
 * for each requested name and write `{ counts = { [name] = n, ... } }` JSON,
 * then `error(DUMPED-OK)` to exit.
 *
 * With `planet` set, the probe runs on that planet's own surface
 * (`game.planets[planet].create_surface()`, seed forced - see the file header)
 * instead of the default Nauvis surface at `game.surfaces[1]`; `mod-list.json`
 * must enable the Space-Age mods for that to resolve.
 *
 * Every requested name gets a key even when it counts zero (the loop assigns
 * unconditionally), so a missing key in the dump means the name was never asked
 * for - not that nothing was found. `names` must be non-empty: an empty Lua table
 * serializes as `[]`, not `{}`.
 */
export function buildEntityCountControlLua(
  region: Region,
  names: readonly string[],
  opts: { dumpFile?: string; planet?: string; seed?: number } = {},
): string {
  const dumpFile = opts.dumpFile ?? ENTITY_COUNT_DUMP_FILE;
  const namesLua = names.map((n) => `"${n}"`).join(", ");
  const surfaceLua =
    opts.planet === undefined
      ? `  local surface = game.surfaces[1]`
      : `  local surface = game.planets["${opts.planet}"].create_surface()
  local mgs = surface.map_gen_settings
  mgs.seed = ${opts.seed ?? 123456}
  surface.map_gen_settings = mgs`;
  return `script.on_init(function()
  local names = { ${namesLua} }
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
  local counts = {}
  for _, name in pairs(names) do
    counts[name] = surface.count_entities_filtered{area = {{x0, y0}, {x1, y1}}, name = name}
  end
  helpers.write_file("${dumpFile}", helpers.table_to_json({ counts = counts }), false)
  error("DUMPED-OK")
end)
`;
}

/** Default spawn wrapper around `node:child_process` (mirrors `oracle.ts`'s private one). */
const nodeSpawn: SpawnFn = (bin, args) => ({
  done: () =>
    new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      import("node:child_process")
        .then(({ spawn }) => {
          const child = spawn(bin, args as string[], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (d) => {
            stderr += String(d);
          });
          child.on("error", reject);
          child.on("close", (code) => {
            resolve({ code, stderr });
          });
        })
        .catch(reject);
    }),
});

/** Parse the entity-count mod's dump into `{ [name]: count }`. */
export function parseEntityCountDump(jsonText: string): Record<string, number> {
  const parsed = JSON.parse(jsonText) as { counts: Record<string, number> };
  return parsed.counts;
}

/**
 * Count every entity of each name the game placed in `region`, through the real
 * game, for the DEFAULT preset (no property routing). Forces generation of every
 * 32-tile chunk overlapping the region, so cost scales with the region's area
 * (tens of seconds for a 16x16-chunk region). Throws if the binary is missing
 * (gate with {@link oracleAvailable}) or if no dump was produced.
 *
 * Every name must exist as an entity prototype in the run's mod set, or the
 * game raises inside `count_entities_filtered` and no dump is written.
 */
export async function sampleEntityCounts(
  region: Region,
  names: readonly string[],
  opts: OracleOptions,
): Promise<Record<string, number>> {
  const seed = opts.seed ?? 123456;
  const factorioBin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const dataDir = opts.dataDir ?? defaultDataDir(factorioBin);
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  const { workDir } = opts;
  const modDir = join(workDir, "mods");
  const modFilesDir = join(modDir, `${ENTITY_COUNT_PROBE_NAME}_${MOD_VERSION}`);
  const writeDataDir = join(workDir, "write");
  const savePath = join(writeDataDir, "probe.zip");
  const mapGenPath = join(workDir, "map-gen-settings.json");
  const configPath = join(workDir, "config.ini");

  await mkdir(modFilesDir, { recursive: true });
  await mkdir(writeDataDir, { recursive: true });
  await writeFile(
    join(modFilesDir, "info.json"),
    JSON.stringify(buildEntityCountInfoJson(), null, 2),
  );
  await writeFile(
    join(modFilesDir, "control.lua"),
    buildEntityCountControlLua(region, names, {
      planet: opts.spaceAge ? (opts.planet ?? "vulcanus") : undefined,
      seed,
    }),
  );
  await writeFile(
    join(modDir, "mod-list.json"),
    JSON.stringify(
      opts.spaceAge ? buildSpaceAgeModList(ENTITY_COUNT_PROBE_NAME) : buildEntityCountModList(),
      null,
      2,
    ),
  );
  await writeFile(mapGenPath, JSON.stringify(buildTileMapGenSettings(seed)));
  await writeFile(configPath, buildConfigIni(writeDataDir, dataDir));

  const args = buildFactorioArgs({ savePath, mapGenPath, seed, modDir, configPath });
  const { stderr } = await spawnFn(factorioBin, args).done();

  const dumpPath = join(writeDataDir, "script-output", ENTITY_COUNT_DUMP_FILE);
  let jsonText: string;
  try {
    jsonText = await readFile(dumpPath, "utf8");
  } catch {
    throw new Error(
      `entity-count oracle produced no dump at ${dumpPath}. Factorio stderr tail:\n${stderr.slice(-2000)}`,
    );
  }
  return parseEntityCountDump(jsonText);
}

// ---------------------------------------------------------------------------
// Capture driver: writes the committed fixture. Run deliberately, not in CI.
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * Entity names to count per planet. Both lists are captured in one pass, since
 * later tasks assert their own overlay against this same fixture.
 *
 * `big-sand-rock` is the third prototype the Nauvis rocks overlay charts
 * (`ROCK_MAP_COLOR` is shared by all three - see `src/noise/rocks/rockCatalog.ts`)
 * and it is not optional: measured at seed 123456, the far region below is
 * desert, where the count is `huge-rock`=0, `big-rock`=0, `big-sand-rock`=64.
 * Counting only the first two there would read as a total disagreement with the
 * roll rather than as a biome.
 */
const NAMES = {
  nauvis: [
    "huge-rock",
    "big-rock",
    "big-sand-rock",
    "crude-oil",
    "biter-spawner",
    "spitter-spawner",
  ],
  vulcanus: [
    "huge-volcanic-rock",
    "big-volcanic-rock",
    "huge-volcanic-rock-hot",
    "big-volcanic-rock-hot",
    "sulfuric-acid-geyser",
  ],
} as const;

/**
 * Two chunk-aligned regions per planet - one near spawn, one far from it - plus
 * one spawn-CENTRED Vulcanus region.
 *
 * The extra region exists because `sulfuric-acid-geyser` counts **0** in both of
 * the other two Vulcanus regions at seed 123456 (measured; the surface generates
 * fine there - tungsten/coal/calcite are all in the thousands - the geysers just
 * are not in that quadrant). A zero count is useless as a density denominator, so
 * region 4 gives the geyser overlay something to compare against (56 geysers).
 * Appended last so the first four indices stay stable.
 */
const REGIONS: readonly { planet: "nauvis" | "vulcanus"; region: Region }[] = [
  { planet: "nauvis", region: { x0: 0, y0: 0, x1: 512, y1: 512 } },
  { planet: "nauvis", region: { x0: 4096, y0: 4096, x1: 4608, y1: 4608 } },
  { planet: "vulcanus", region: { x0: 0, y0: 0, x1: 512, y1: 512 } },
  { planet: "vulcanus", region: { x0: 4096, y0: 4096, x1: 4608, y1: 4608 } },
  { planet: "vulcanus", region: { x0: -256, y0: -256, x1: 256, y1: 256 } },
];

const SEED = 123456;

async function capture(): Promise<void> {
  if (!oracleAvailable()) {
    throw new Error(`no Factorio binary at ${DEFAULT_FACTORIO_BIN} (set FACTORIO_BIN)`);
  }
  const counts: { planet: string; region: number; name: string; count: number }[] = [];

  for (const [index, entry] of REGIONS.entries()) {
    const names = NAMES[entry.planet];
    const workDir = await mkdtemp(join(tmpdir(), "oracle-entity-counts-"));
    const started = Date.now();
    try {
      const result = await sampleEntityCounts(entry.region, names, {
        workDir,
        seed: SEED,
        spaceAge: entry.planet !== "nauvis",
        planet: entry.planet,
      });
      for (const name of names) {
        const count = result[name];
        if (typeof count !== "number") {
          throw new Error(`dump has no count for "${name}" (got ${JSON.stringify(result)})`);
        }
        counts.push({ planet: entry.planet, region: index, name, count });
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  ${entry.planet} region ${index} [${entry.region.x0},${entry.region.y0}]-` +
          `[${entry.region.x1},${entry.region.y1}] in ${secs}s: ` +
          names.map((n) => `${n}=${String(result[n])}`).join(" "),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Per-region entity counts " +
      "(count_entities_filtered by name) after chunk-forced generation, at the DEFAULT " +
      "preset. Vulcanus regions are sampled on a create_surface() surface whose seed is " +
      "FORCED to `seed` (like every other Vulcanus oracle fixture), not the derived " +
      "mapSeed + crc32('vulcanus'). `region` indexes `regions`. Compared against the " +
      "placement roll's placed-tile count in test/entityDensity.spec.ts - density only; " +
      "individual positions are NOT expected to match (see " +
      "docs/superpowers/specs/2026-07-27-placement-roll-stipple-design.md). " +
      "Regenerate: node --experimental-strip-types test/oracle/entityCounts.ts",
    seed: SEED,
    regions: REGIONS.map((r) => ({ planet: r.planet, ...r.region })),
    counts,
  };
  const out = join(FIXTURES, "oracle-entity-counts.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${REGIONS.length} regions, ${counts.length} counts)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await capture();
}
