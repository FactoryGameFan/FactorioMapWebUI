/**
 * Stone and the two stromatolites on a REAL Gleba surface, for grading the
 * engine's Gleba resource overlay (#454).
 *
 *   node --experimental-strip-types scripts/probes/gleba-entities/capture.ts
 *   FMW_ARM=default node --experimental-strip-types scripts/probes/gleba-entities/capture.ts
 *
 * Run from the repository root. Each run starts Factorio 2.1.23 once, through
 * `factorio-oracle`. Read `README.md` beside this file for what it found.
 *
 * ## The two arms
 *
 * - `graded` (the default) writes
 *   `test/fixtures/oracle-gleba-real-surface-entities.seed123456.json`. The
 *   controls of everything NOT graded are off: `gleba_plants`,
 *   `gleba_enemy_base` and `gleba_cliff` at size 0, and the cliff richness 0.
 *   No data-stage mod, so stone and both stromatolites place exactly as the
 *   game places them.
 * - `default` writes `...-entities-default.seed123456.json`: every control at
 *   its default, the map a player gets. It holds the same three entities, so
 *   the difference between the arms is what plants, cliffs and nests take
 *   away from them at `apply`.
 *
 * ## What it reads
 *
 * Map seed 123456 and Gleba's own `create_surface()`, so the surface seed is
 * the derived 3215206427. One `request_to_generate_chunks` around chunk (0, 0)
 * covers the window and a two-chunk margin, the way a game start asks for its
 * spawn area; then every `stone`, `iron-stromatolite` and `copper-stromatolite`
 * whose tile is in the window is listed, with its exact position. A census of
 * every other entity name in the window goes beside it.
 *
 * The `graded` arm also reads, from the prototypes at runtime, every entity
 * autoplacer the surface runs (its autoplace `order`, flags, boxes, collision
 * layers, control and tile restrictions) and the collision layers of each
 * Gleba tile. Those are what the per-chunk generator sorts and tests, so the
 * port takes them from the game rather than from the Lua. And it reads eleven
 * fields with `calculate_tile_properties` at a fixed pool of 1/256-grid
 * positions, for the tier-1 grade of the probability fields.
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
const INSTALL = {
  root: process.env.FMW_FACTORIO_2_1_23 ?? "/home/eric/factorio-headless/2.1.23/factorio",
  version: "2.1.23",
};

const ARM = process.env.FMW_ARM ?? "graded";
if (ARM !== "graded" && ARM !== "default") {
  throw new Error(`FMW_ARM must be graded or default, not ${ARM}`);
}
const OUT =
  process.env.FMW_OUT ??
  join(
    REPO,
    "test",
    "fixtures",
    ARM === "graded"
      ? "oracle-gleba-real-surface-entities.seed123456.json"
      : "oracle-gleba-real-surface-entities-default.seed123456.json",
  );

const MAP_SEED = 123456;
/** The window: tiles X0 .. X0 + SIDE - 1 on both axes. Chunk aligned. */
const X0 = Number(process.env.FMW_X0 ?? -512);
const SIDE = Number(process.env.FMW_SIDE ?? 1024);
const MARGIN_CHUNKS = 2;
/** The three entities graded, in the fixture's `names` order. */
const GRADED = ["copper-stromatolite", "iron-stromatolite", "stone"] as const;
/** Controls the `graded` arm turns off: everything that places something else. */
const OFF = ["gleba_plants", "gleba_enemy_base", "gleba_cliff"] as const;

/** The fields read for tier 1, by property name. */
const FIELDS = [
  "gleba_scrub_noise",
  "gleba_decorative_knockout",
  "gleba_iron_stromatolite",
  "gleba_copper_stromatolite",
  "entity:iron-stromatolite:probability",
  "entity:copper-stromatolite:probability",
  "gleba_highland",
  "gleba_midland_aux_2",
  "gleba_stone_richness",
  "entity:stone:probability",
  "entity:stone:richness",
] as const;
/**
 * Field positions, two pools on the 1/256 grid. The SCOUT pool is fixed,
 * within POOL_RADIUS tiles. Most of Gleba has no stromatolite or stone at all,
 * so the fixture keeps the first QUOTA scout positions overall and then the
 * first QUOTA (not yet kept) where each stromatolite probability is above 0;
 * see `pickScout`. Stone is rarer still (65,536 scout positions held only 126
 * with any stone richness), so the STONE pool is read after generation: for
 * every stone the game placed, the corner (x - 0.5, y - 0.5) of its tile and
 * that corner moved one tile each way, nine positions. The first QUOTA of
 * those with richness above 0 are kept, then the first QUOTA at 0 or below.
 */
const POOL = 65536;
const POOL_RADIUS = 600;
const QUOTA = 512;
const QUOTA_FIELDS = [
  "entity:iron-stromatolite:probability",
  "entity:copper-stromatolite:probability",
] as const;

/** A small fixed LCG, so the pool is the same on every run. */
function pool(): [number, number][] {
  let s = 0x9e3779b9;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: [number, number][] = [];
  while (out.length < POOL) {
    const x = Math.round((next() * 2 - 1) * POOL_RADIUS * 256) / 256;
    const y = Math.round((next() * 2 - 1) * POOL_RADIUS * 256) / 256;
    out.push([x, y]);
  }
  return out;
}

function controlLua(positions: [number, number][]): string {
  return `-- GENERATED by scripts/probes/gleba-entities/capture.ts.
local X0, SIDE, MARGIN = ${String(X0)}, ${String(SIDE)}, ${String(MARGIN_CHUNKS)}
local ARM = "${ARM}"
local OFF = helpers.json_to_table([==[${JSON.stringify(OFF)}]==])
local GRADED = helpers.json_to_table([==[${JSON.stringify(GRADED)}]==])
local FIELDS = helpers.json_to_table([==[${JSON.stringify(FIELDS)}]==])
local POSITIONS = helpers.json_to_table([==[${JSON.stringify(positions.map(([x, y]) => ({ x, y })))}]==])

local function layers(mask)
  local out = {}
  for name in pairs(mask.layers) do out[#out + 1] = name end
  table.sort(out)
  return out
end

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

script.on_init(function()
  local s = game.planets["gleba"].create_surface()
  local mgs = s.map_gen_settings
  if ARM == "graded" then
    for _, n in ipairs(OFF) do
      mgs.autoplace_controls[n] = { frequency = 1, size = 0, richness = 1 }
    end
    mgs.cliff_settings.richness = 0
  end
  s.map_gen_settings = mgs
  local controls = {}
  for n, c in pairs(s.map_gen_settings.autoplace_controls) do
    controls[n] = { frequency = c.frequency, size = c.size, richness = c.richness }
  end
  local cliffRichness = s.map_gen_settings.cliff_settings.richness

  local pregenerated = 0
  local c0, c1 = math.floor(X0 / 32) - MARGIN, math.floor((X0 + SIDE - 1) / 32) + MARGIN
  for cy = c0, c1 do
    for cx = c0, c1 do
      if s.is_chunk_generated({ cx, cy }) then pregenerated = pregenerated + 1 end
    end
  end

  -- Fields first, before any chunk exists: calculate_tile_properties needs none.
  local fields = {}
  if ARM == "graded" then
    local got = s.calculate_tile_properties(FIELDS, POSITIONS)
    for _, n in ipairs(FIELDS) do
      local v = got[n]
      if v then fields[n] = encode(v) end
    end
  end

  s.request_to_generate_chunks({ x = 16, y = 16 }, math.max(-c0, c1))
  s.force_generate_chunk_requests()

  local graded = {}
  for _, n in ipairs(GRADED) do graded[n] = true end
  local entities = {}
  local census = {}
  local area = { { X0 - 8, X0 - 8 }, { X0 + SIDE + 8, X0 + SIDE + 8 } }
  for _, e in pairs(s.find_entities_filtered({ area = area })) do
    local tx, ty = math.floor(e.position.x), math.floor(e.position.y)
    if tx >= X0 and tx < X0 + SIDE and ty >= X0 and ty < X0 + SIDE then
      census[e.name] = (census[e.name] or 0) + 1
    end
    -- The list takes a one-tile ring too: a stromatolite's box reaches one
    -- tile past its own, so one just outside can cover a window tile.
    if graded[e.name] and tx >= X0 - 1 and tx <= X0 + SIDE and ty >= X0 - 1 and ty <= X0 + SIDE then
      entities[#entities + 1] = { e.name, e.position.x, e.position.y }
    end
  end

  -- The stone pool: each placed stone's tile corner and its eight neighbours.
  local stonePositions = {}
  local stoneFields = {}
  if ARM == "graded" then
    for _, e in ipairs(entities) do
      if e[1] == "stone" then
        for dy = -1, 1 do
          for dx = -1, 1 do
            stonePositions[#stonePositions + 1] = { x = e[2] - 0.5 + dx, y = e[3] - 0.5 + dy }
          end
        end
      end
    end
    local got = s.calculate_tile_properties(FIELDS, stonePositions)
    for _, n in ipairs(FIELDS) do
      local v = got[n]
      if v then stoneFields[n] = encode(v) end
    end
  end

  -- The autoplacers this surface runs, and the facts the generator reads.
  local autoplacers = {}
  local planetEntities = s.map_gen_settings.autoplace_settings.entity.settings or {}
  for name, p in pairs(prototypes.entity) do
    local a = p.autoplace_specification
    if a then
      local control = a.control
      local active = planetEntities[name] ~= nil
        or (control ~= nil and s.map_gen_settings.autoplace_controls[control] ~= nil)
      if active then
        local restrictions = {}
        for _, r in pairs(a.tile_restriction or {}) do
          restrictions[#restrictions + 1] = r.first and (r.second and (r.first .. "|" .. r.second) or r.first) or tostring(r)
        end
        local cb, mb = p.collision_box, p.map_generator_bounding_box
        autoplacers[#autoplacers + 1] = {
          name = name,
          type = p.type,
          order = a.order,
          control = control or "",
          placementDensity = a.placement_density,
          offGrid = p.flags and p.flags["placeable-off-grid"] or false,
          collisionBox = { cb.left_top.x, cb.left_top.y, cb.right_bottom.x, cb.right_bottom.y },
          mapGenBox = { mb.left_top.x, mb.left_top.y, mb.right_bottom.x, mb.right_bottom.y },
          collisionLayers = layers(p.collision_mask),
          tileRestriction = restrictions,
        }
      end
    end
  end
  table.sort(autoplacers, function(a, b) return a.name < b.name end)

  local tiles = {}
  for name in pairs(s.map_gen_settings.autoplace_settings.tile.settings) do
    tiles[name] = layers(prototypes.tile[name].collision_mask)
  end

  helpers.write_file("oracle-dump.json", helpers.table_to_json({
    surfaceSeed = s.map_gen_settings.seed,
    controls = controls,
    cliffRichness = cliffRichness,
    pregenerated = pregenerated,
    entities = entities,
    census = census,
    autoplacers = autoplacers,
    tiles = tiles,
    fields = fields,
    stonePositions = stonePositions,
    stoneFields = stoneFields,
  }))
  error("DUMPED-OK")
end)
`;
}

interface Autoplacer {
  name: string;
  type: string;
  order: string;
  control: string;
  placementDensity: number;
  offGrid: boolean;
  collisionBox: number[];
  mapGenBox: number[];
  collisionLayers: string[];
  tileRestriction: string[] | Record<string, never>;
}

interface Dump {
  surfaceSeed: number;
  controls: Record<string, { frequency: number; size: number; richness: number }>;
  cliffRichness: number;
  pregenerated: number;
  entities: [string, number, number][];
  census: Record<string, number>;
  autoplacers: Autoplacer[];
  tiles: Record<string, string[]>;
  fields: Record<string, (number | string)[]> | [];
  stonePositions: { x: number; y: number }[] | Record<string, never>;
  stoneFields: Record<string, (number | string)[]> | [];
}

async function capture(positions: [number, number][]): Promise<{ dump: Dump; buildLine: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gleba-entities-"));
  try {
    const controlPath = join(dir, "control.lua");
    await writeFile(controlPath, controlLua(positions));
    const probePath = join(dir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "gleba_entities_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: controlPath,
        },
        seed: MAP_SEED,
        timeout_seconds: 900,
      }),
    );
    const workDir = join(dir, "work");
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
      // A successful run ends in error("DUMPED-OK"), so it lands here too.
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
    if (!buildLine.includes(`Version: ${INSTALL.version} `)) {
      throw new Error(`ran "${buildLine}", wanted ${INSTALL.version}`, { cause: oracleError });
    }
    const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
    const text = await readFile(dumpPath, "utf8").catch((e: unknown) => {
      throw new Error(`no dump at ${dumpPath}`, { cause: oracleError ?? e });
    });
    return { dump: JSON.parse(text) as Dump, buildLine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The f32 bits of a field value as hex, refusing anything that is not an f32. */
function f32Hex(v: number | string): string {
  const special: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity, "-0": -0 };
  const n = typeof v === "string" ? special[v] : v;
  if (n === undefined) throw new Error(`unknown field value ${String(v)}`);
  if (!Number.isNaN(n) && Math.fround(n) !== n) throw new Error(`${String(n)} is not an f32`);
  const f = new Float32Array([n]);
  return new Uint32Array(f.buffer)[0].toString(16).padStart(8, "0");
}

const scout = pool();
const { dump, buildLine } = await capture(scout);

/** The first `quota` indices below `n`, in order, not yet taken, that pass `ok`. */
function takeFirst(n: number, taken: Set<number>, ok: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < n && out.length < QUOTA; i++) {
    if (!taken.has(i) && ok(i)) {
      out.push(i);
      taken.add(i);
    }
  }
  if (out.length < QUOTA) throw new Error(`only ${String(out.length)} positions for a quota`);
  return out;
}

const positive = (v: (number | string)[] | undefined, i: number): boolean =>
  v !== undefined && typeof v[i] === "number" && v[i] > 0;

/** The kept scout indices: QUOTA overall, then QUOTA per stromatolite. */
function pickScout(fields: Record<string, (number | string)[]>): number[] {
  const taken = new Set<number>();
  const kept = takeFirst(scout.length, taken, () => true);
  for (const f of QUOTA_FIELDS) {
    if (fields[f] === undefined) throw new Error(`field ${f} did not come back`);
    kept.push(...takeFirst(scout.length, taken, (i) => positive(fields[f], i)));
  }
  return kept;
}

/** The kept stone-pool indices: QUOTA with richness above 0, then QUOTA without. */
function pickStone(fields: Record<string, (number | string)[]>, n: number): number[] {
  const taken = new Set<number>();
  const r = fields["gleba_stone_richness"];
  return [
    ...takeFirst(n, taken, (i) => positive(r, i)),
    ...takeFirst(n, taken, (i) => !positive(r, i)),
  ];
}

if (dump.pregenerated !== 0) throw new Error(`${String(dump.pregenerated)} chunks pregenerated`);
if (ARM === "graded") {
  for (const n of OFF) {
    if (dump.controls[n]?.size !== 0) throw new Error(`control ${n} read back non-zero`);
  }
  if (dump.cliffRichness !== 0)
    throw new Error(`cliff richness read back ${String(dump.cliffRichness)}`);
  const others = Object.keys(dump.census).filter((n) => !(GRADED as readonly string[]).includes(n));
  if (others.length > 0) throw new Error(`entities left in the window: ${others.join(", ")}`);
}

const names = [...GRADED];
const entities = dump.entities
  .map(([n, x, y]) => {
    const k = names.indexOf(n as (typeof GRADED)[number]);
    const fx = x * 256;
    const fy = y * 256;
    if (!Number.isInteger(fx) || !Number.isInteger(fy))
      throw new Error(`off the 1/256 grid: ${n} ${String(x)} ${String(y)}`);
    return [k, fx, fy] as [number, number, number];
  })
  // Sorted so a re-run writes the same bytes: by y, then x, then name.
  .sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);

/** Whether an entity's tile is inside the window, not the ring around it. */
const inWindow = (e: [number, number, number]): boolean => {
  const [tx, ty] = [Math.floor(e[1] / 256), Math.floor(e[2] / 256)];
  return tx >= X0 && tx < X0 + SIDE && ty >= X0 && ty < X0 + SIDE;
};
const counts = Object.fromEntries(
  names.map((n, k) => [n, entities.filter((e) => e[0] === k && inWindow(e)).length]),
);
for (const n of names) {
  if (counts[n] !== (dump.census[n] ?? 0)) throw new Error(`${n}: list and census disagree`);
}

const fixture = {
  about:
    ARM === "graded"
      ? "Stone and both stromatolites on a REAL Gleba surface (game.planets.gleba.create_surface(), derived seed) with gleba_plants, gleba_enemy_base and gleba_cliff at size 0 and cliff richness 0, no data-stage mod; one request_to_generate_chunks radius request covering the window and 2 chunks of margin, then force_generate_chunk_requests. Each entity is [name index, x * 256, y * 256], its exact position in 1/256 tile, listed when floor(position) is in the window or the one-tile ring around it (a stromatolite box reaches one tile past its own); counts and census are the window alone. autoplacers and tiles are read from the prototypes at runtime; fields are calculate_tile_properties at positions, as f32 hex bits. Written by scripts/probes/gleba-entities/capture.ts."
      : "Stone and both stromatolites on a REAL Gleba surface with every control at its default (the map a player gets), otherwise as the graded arm. Written by FMW_ARM=default scripts/probes/gleba-entities/capture.ts.",
  buildLine,
  mapSeed: MAP_SEED,
  surfaceSeed: dump.surfaceSeed,
  arm: ARM,
  window: { x0: X0, y0: X0, width: SIDE, height: SIDE },
  marginChunks: MARGIN_CHUNKS,
  controls: dump.controls,
  cliffRichness: dump.cliffRichness,
  census: dump.census,
  counts,
  names,
  entities,
  ...(ARM === "graded"
    ? {
        autoplacers: dump.autoplacers,
        tiles: dump.tiles,
        ...(() => {
          const scoutFields = dump.fields as Record<string, (number | string)[]>;
          const stoneFields = dump.stoneFields as Record<string, (number | string)[]>;
          const stonePool = (dump.stonePositions as { x: number; y: number }[]).map(
            (p) => [p.x, p.y] as [number, number],
          );
          const keptScout = pickScout(scoutFields);
          const keptStone = pickStone(stoneFields, stonePool.length);
          return {
            positions: [...keptScout.map((i) => scout[i]), ...keptStone.map((i) => stonePool[i])],
            fields: Object.fromEntries(
              FIELDS.map((n) => {
                const a = scoutFields[n];
                const b = stoneFields[n];
                if (a === undefined || b === undefined) {
                  throw new Error(`field ${n} did not come back`);
                }
                return [
                  n,
                  [...keptScout.map((i) => f32Hex(a[i])), ...keptStone.map((i) => f32Hex(b[i]))],
                ];
              }),
            ),
          };
        })(),
      }
    : {}),
};
/**
 * Indented like the other fixtures, except that each short array (an entity,
 * a position, a box, a layer list) stays on one line, so the file reads one
 * entity per line and diffs line by line.
 */
function format(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(
    /\[\n\s*([^[\]{}]*?)\n\s*\]/g,
    (_m, body: string) => `[${body.replace(/,\n\s*/g, ",")}]`,
  );
}
await writeFile(OUT, `${format(fixture)}\n`);
console.log(
  `wrote ${OUT}: ${buildLine}, surface seed ${String(dump.surfaceSeed)}, ${JSON.stringify(counts)}`,
);
