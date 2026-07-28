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
 * **`enemy-base` cannot be disabled** (`can_be_disabled: false`), so it is present
 * in every comparison. It is a layer this app does render, so that is survivable,
 * but it means "terrain only" is really "terrain plus whatever enemy bases the
 * game drew" and the comparison has to account for it.
 *
 * Run (needs a local Factorio 2.1 install):
 *
 *   node --experimental-strip-types test/oracle/previewCompare.ts
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_FACTORIO_BIN, oracleAvailable } from "./oracle.ts";

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

/** Run `--generate-map-preview` and return the PNG bytes. */
export async function generatePreview(opts: {
  seed: number;
  planet: string;
  size: number;
  disabled: readonly string[];
  factorioBin?: string;
}): Promise<Uint8Array> {
  const bin = opts.factorioBin ?? DEFAULT_FACTORIO_BIN;
  const work = await mkdtemp(join(tmpdir(), "preview-compare-"));
  try {
    const mgsPath = join(work, "mgs.json");
    const outPath = join(work, "preview.png");
    await writeFile(mgsPath, JSON.stringify(buildDisabledMapGenSettings(opts.seed, opts.disabled)));
    const args = [
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
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("close", (c) => {
        resolve({ code: c ?? -1, stderr: err });
      });
      child.on("error", (e) => {
        resolve({ code: -1, stderr: String(e) });
      });
    });
    try {
      return new Uint8Array(await readFile(outPath));
    } catch {
      throw new Error(
        `--generate-map-preview produced no PNG (exit ${String(code)}). stderr tail:\n${stderr.slice(-2000)}`,
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
  // Vulcanus has no `trees`/`rocks`/`nauvis_cliff`; naming a control the planet
  // does not define is harmless, but its own resources need disabling by name.
  const disabled =
    planet === "vulcanus"
      ? [...DISABLEABLE, "calcite", "tungsten_ore", "vulcanus_coal", "sulfuric_acid_geyser"]
      : DISABLEABLE;
  const png = await generatePreview({ seed, planet, size, disabled });
  const out = join(process.cwd(), `preview-${planet}-terrain.png`);
  await writeFile(out, png);
  console.log(`wrote ${out} (${String(png.length)} bytes)`);
}
