/**
 * The PREVIEW oracle: compare our rendered preview against the game's own
 * `--generate-map-preview` output for the same seed and settings.
 *
 * Every other oracle in this directory validates a *value* (a noise expression, a
 * tile name, an entity count or position). None of them can see a whole-overlay
 * error - a layer that is missing entirely, drawn in the wrong colour, at the
 * wrong scale, or composited in the wrong order - because each is checked against
 * the thing it is derived from rather than against the finished image. That is the
 * blind spot this closes (issue #22, item 6).
 *
 * ## The confounds are turned OFF rather than tolerated
 *
 * The obvious objection to a pixel diff is that the game's preview also draws
 * layers this app renders differently or not at all, so the disagreement would be
 * uninterpretable. It does not have to be: `autoplace_controls` can disable most
 * of them outright, and `test/fixtures/autoplace-can-be-disabled.dump.json` (the
 * game's own dump) records exactly which. `trees` and `rocks` are both disableable
 * - those are the two big ones - as are every resource and `nauvis_cliff`.
 *
 * So this compares LAYER BY LAYER, starting from terrain alone, with everything
 * that can be switched off switched off. A disagreement is then attributable to
 * the layer under test rather than to the pile of things around it.
 *
 * ## What no control can switch off, a data-stage mod does
 *
 * Controls do not reach everything the preview draws. `enemy-base` reports
 * `can_be_disabled: false`; Vulcanus has no cliff control at all, and its rocks,
 * crater cliffs, chimneys and lichen trees have no control either; nor do
 * Fulgora's ruins, fulgurite and big rocks. Each capture used to carry them, and
 * the specs either masked them out by colour or counted them as terrain
 * disagreement.
 *
 * {@link TERRAIN_ONLY_DATA_FINAL_FIXES} removes them at the data stage instead,
 * and `--generate-map-preview` honours it: the game logs the probe mod's
 * `data-final-fixes.lua` loading, and the PNG changes. Measured on 2.1.17
 * (build 87315), seed 123456, 1024 px, 2026-09-14:
 *
 * | planet   | pixels the mod changed | what they were                               |
 * | -------- | ---------------------: | -------------------------------------------- |
 * | Nauvis   |                  1,189 | enemy bases, and nothing else                |
 * | Vulcanus |                122,483 | 64,729 cliff + 54,161 rock + 3,593 tree tint |
 * | Fulgora  |                 34,766 | ruins, fulgurite and big rocks               |
 *
 * Every capture also passes an explicit `--mod-directory` and an isolated
 * `--config`, so the result no longer depends on the mods enabled in the local
 * Factorio profile. With only the four official mods listed, all four PNGs
 * captured before this change (2.1.12 and 2.1.14) came back BYTE-IDENTICAL from
 * 2.1.17, so the explicit list changes nothing on its own.
 *
 * Run (needs a local Factorio 2.1 install):
 *
 *   node --experimental-strip-types test/oracle/previewCompare.ts <planet> [scrap]
 *
 * `scrap` is Fulgora only: it leaves the `scrap` control on, for the scrap PNG.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_FACTORIO_BIN, buildConfigIni, defaultDataDir, oracleAvailable } from "./oracle.ts";

/**
 * The data-stage mod that leaves only terrain and resources in every planet's
 * map generation. Applied to every planet rather than the one being captured,
 * so there is one rule and no planet list to keep current.
 *
 * - `cliff_settings.richness = 0` removes Vulcanus's cliffs, which no control
 *   reaches: its `cliffiness_basic` tops out at exactly 0.5 when richness is 0,
 *   and a cliff needs more than 0.5. On Nauvis and Fulgora the cliff controls
 *   already do this, so it is redundant there.
 * - `treat_missing_as_default = false` is what removes Nauvis's enemy bases and
 *   trees. Neither is named in Nauvis's entity list; they are placed only
 *   because a missing entry defaults to on.
 * - Dropping every non-resource entry removes what IS named: Vulcanus's rocks,
 *   `crater-cliff`, chimneys and lichen trees, Fulgora's ruins, fulgurite and
 *   big rocks, and Nauvis's rocks and fish. Resources stay listed, because the
 *   scrap capture needs `scrap` and the terrain captures switch resources off by
 *   control anyway.
 *
 * Tiles and decoratives are untouched.
 */
export const TERRAIN_ONLY_DATA_FINAL_FIXES = `for _, planet in pairs(data.raw.planet) do
  local mgs = planet.map_gen_settings
  if mgs then
    if mgs.cliff_settings then mgs.cliff_settings.richness = 0 end
    local entity = mgs.autoplace_settings and mgs.autoplace_settings.entity
    if entity then
      entity.treat_missing_as_default = false
      for name in pairs(entity.settings or {}) do
        if not data.raw.resource[name] then entity.settings[name] = nil end
      end
    end
  end
end
`;

/** The official mods every capture enables, and nothing from the local profile. */
const OFFICIAL_MODS = ["base", "elevated-rails", "quality", "space-age"] as const;

/** The probe mod's name. Factorio requires the directory to be `<name>_<version>`. */
const PROBE_MOD = { name: "preview_terrain_only", version: "0.0.1" } as const;

/** Controls to force to size 0. Only names the game reports as disableable. */
export const DISABLEABLE = [
  "trees",
  "rocks",
  "nauvis_cliff",
  "iron-ore",
  "copper-ore",
  "coal",
  "stone",
  "crude-oil",
  "uranium-ore",
] as const;

/**
 * Map-gen settings with every named control forced to size 0.
 *
 * `size: 0` is the game's own "off" for an autoplace control - the same value the
 * app's `ControlRow` writes at the bottom notch, and what
 * `makeResourceResolver`/the render passes already treat as "never appears".
 */
export function buildDisabledMapGenSettings(
  seed: number,
  disabled: readonly string[],
): Record<string, unknown> {
  const autoplace_controls: Record<string, { frequency: number; size: number; richness: number }> =
    {};
  for (const name of disabled) {
    autoplace_controls[name] = { frequency: 1, size: 0, richness: 1 };
  }
  return { seed, autoplace_controls };
}

/**
 * Run `--generate-map-preview` and return the PNG bytes.
 *
 * `dataFinalFixes`, when given, is installed as a probe mod's
 * `data-final-fixes.lua` - not `data.lua`, which may run before `space-age` and
 * find no planet to change. The run fails loudly if the game's log does not
 * show that file loading, because a mod that silently did not load produces a
 * perfectly plausible PNG with every entity still in it.
 */
export async function generatePreview(opts: {
  seed: number;
  planet: string;
  size: number;
  disabled: readonly string[];
  dataFinalFixes?: string;
  factorioBin?: string;
}): Promise<Uint8Array> {
  const bin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const work = await mkdtemp(join(tmpdir(), "preview-compare-"));
  try {
    const mgsPath = join(work, "mgs.json");
    const outPath = join(work, "preview.png");
    await writeFile(mgsPath, JSON.stringify(buildDisabledMapGenSettings(opts.seed, opts.disabled)));
    const configPath = join(work, "config.ini");
    await writeFile(configPath, buildConfigIni(join(work, "write"), defaultDataDir(bin)));
    const modDir = join(work, "mods");
    await mkdir(modDir);
    const enabled: string[] = [...OFFICIAL_MODS];
    if (opts.dataFinalFixes !== undefined) {
      const probeDir = join(modDir, `${PROBE_MOD.name}_${PROBE_MOD.version}`);
      await mkdir(probeDir);
      await writeFile(
        join(probeDir, "info.json"),
        JSON.stringify({
          ...PROBE_MOD,
          title: "Preview: terrain only",
          author: "FactorioMapWebUI",
          factorio_version: "2.1",
          dependencies: ["base", "space-age"],
        }),
      );
      await writeFile(join(probeDir, "data-final-fixes.lua"), opts.dataFinalFixes);
      enabled.push(PROBE_MOD.name);
    }
    await writeFile(
      join(modDir, "mod-list.json"),
      JSON.stringify({ mods: enabled.map((name) => ({ name, enabled: true })) }),
    );
    const args = [
      "--config",
      configPath,
      "--mod-directory",
      modDir,
      "--generate-map-preview",
      outPath,
      "--map-gen-settings",
      mgsPath,
      "--map-preview-planet",
      opts.planet,
      "--map-gen-seed",
      String(opts.seed),
      "--map-preview-size",
      String(opts.size),
    ];
    const { spawn } = await import("node:child_process");
    // Both streams, because the game's "Loading mod" lines arrive on stdout.
    const { code, log } = await new Promise<{ code: number; log: string }>((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const append = (d: Buffer): void => {
        text += d.toString();
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("close", (c) => {
        resolve({ code: c ?? -1, log: text });
      });
      child.on("error", (e) => {
        resolve({ code: -1, log: String(e) });
      });
    });
    const loadLine = `Loading mod ${PROBE_MOD.name} ${PROBE_MOD.version} (data-final-fixes.lua)`;
    if (opts.dataFinalFixes !== undefined && !log.includes(loadLine)) {
      throw new Error(
        `the game never logged "${loadLine}", so the PNG would show every entity. log tail:\n${log.slice(-2000)}`,
      );
    }
    try {
      return new Uint8Array(await readFile(outPath));
    } catch {
      throw new Error(
        `--generate-map-preview produced no PNG (exit ${String(code)}). log tail:\n${log.slice(-2000)}`,
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!oracleAvailable()) {
    console.error("Factorio binary not found; set FACTORIO_BIN.");
    process.exit(1);
  }
  const seed = 123456;
  const size = 1024;
  const planet = process.argv[2] ?? "nauvis";
  const scrap = process.argv[3] === "scrap";
  if (scrap && planet !== "fulgora") {
    console.error("`scrap` applies to fulgora only.");
    process.exit(1);
  }
  // Naming a control the planet does not define is harmless, so the Nauvis
  // names stay in every arm; each planet's OWN disableable controls are added.
  // Fulgora's are `scrap` and `fulgora_cliff` - `fulgora_islands` reports
  // can_be_disabled: false, so it cannot be switched off and is not listed.
  const disabled =
    planet === "vulcanus"
      ? [...DISABLEABLE, "calcite", "tungsten_ore", "vulcanus_coal", "sulfuric_acid_geyser"]
      : planet === "fulgora"
        ? [...DISABLEABLE, ...(scrap ? [] : ["scrap"]), "fulgora_cliff"]
        : DISABLEABLE;
  const png = await generatePreview({
    seed,
    planet,
    size,
    disabled,
    dataFinalFixes: TERRAIN_ONLY_DATA_FINAL_FIXES,
  });
  const out = join(process.cwd(), `preview-${planet}-${scrap ? "scrap" : "terrain"}.png`);
  await writeFile(out, png);
  console.log(`wrote ${out} (${String(png.length)} bytes)`);
}
