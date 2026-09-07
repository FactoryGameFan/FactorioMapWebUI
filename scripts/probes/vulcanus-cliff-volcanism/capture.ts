/**
 * The Vulcanus cliff VOLCANISM sweep - the game's cliff entities in the three
 * regions of `oracle-vulcanus-cliff-entities.seed123456.json`, captured at
 * several settings of the `vulcanus_volcanism` autoplace control (#84).
 *
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts
 *
 * ## Why this lever
 *
 * Read off `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` at 2.1.17,
 * neither volcanism slider touches the cliff rule. `frequency` is the input
 * scale of the mountain and crack noise (`vulcanus_scale_multiplier`, line 51)
 * and `size` sets the volcano spot radius, spacing and density (lines 322-337).
 * Both move the ELEVATION the cliff bands sit on, and nothing else - so a sweep
 * over them changes the input to the cliff rule while the rule, both collision
 * tests and the ore rule stay fixed. If the residual the port carries at the
 * default (21 wrong orientations, 22 surplus, 6 missing of 1569) scales with
 * the arm, it lives on the elevation or multisample side; if it stays flat, it
 * lives in placement or connection (#307). Either way the arm can fail, which
 * is what `factorio-oracle`'s method.md asks of a probe.
 *
 * ## Which arms, and why frequency carries the sweep
 *
 * Measured on the engine before any capture, cliffs-view pixels moved per
 * region (65,536 each) when one lever leaves 1:
 *
 * | region             | size 0.5 | size 2 | size 3 | freq 2 | freq 0.5 |
 * | ------------------ | -------: | -----: | -----: | -----: | -------: |
 * | R1 `[0,0]`         |        0 |      0 |      0 |      0 |        0 |
 * | R2 `[1500,1500]`   |   36,731 | 33,115 | 43,364 | 60,130 |   36,152 |
 * | R3 `[-1200,800]`   |        0 |    298 |  5,288 | 55,351 |   43,964 |
 *
 * R1 is inside the starting area and cannot see either slider, so it is the
 * CONTROL in every arm: the game must place the same 283 cliffs cell for cell
 * whatever the slider says, or the engine's starting-area blindness is wrong.
 * R3 barely sees `size`, so frequency is the lever that reaches both regions
 * the residual lives in; `size 3` is the one size setting R3 sees at all.
 *
 * The default arm is not redundant. It re-captures the three regions at the
 * installed version, so it either reproduces the 2.1.12 fixture cell for cell
 * or shows the game moved underneath it - a version check that costs nothing
 * extra.
 *
 * ## What is reused, and what is new
 *
 * The Lua comes from `test/oracle/oracle.ts`'s `buildCliffControlLua`, which
 * already overrides `map_gen_settings.autoplace_controls` on a forced-seed
 * Vulcanus surface, generates the region's chunks with the same one-drain
 * protocol every committed cliff fixture used, and reads the controls BACK off
 * the surface - so an override that silently failed to apply cannot pass as a
 * setting that does not matter. Only the runner is new: each arm and region is
 * one `factorio-oracle run`, which records provenance and enforces a timeout.
 *
 * `alsoResources` is on ONLY because the read-back of `autoplace_controls`
 * rides that block in the builder; the resources and prototype geometry it
 * also dumps are dropped before the fixture is written.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildCliffControlLua,
  parseCliffDumpFull,
  type Position,
  type Region,
} from "../../../test/oracle/oracle.ts";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = join(REPO, "test", "fixtures");
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");
const OUT = "oracle-vulcanus-cliff-volcanism-sweep.seed123456.json";

/** The three regions of `oracle-vulcanus-cliff-entities.seed123456.json`, verbatim. */
const REGIONS: readonly Region[] = [
  { x0: 0, y0: 0, x1: 256, y1: 256 },
  { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
  { x0: -1200, y0: 800, x1: -944, y1: 1056 },
];

/** Every committed Vulcanus cliff fixture forces the surface seed to this. */
const SEED = 123456;

interface Arm {
  readonly label: string;
  readonly frequency: number;
  readonly size: number;
}

/**
 * Slider values are GUI notches (the app's own `PERCENT_STEPS` carry 0.5, 2 and
 * 3), and the default arm passes NO override, so its read-back reports what the
 * planet ships with rather than an echo of what was written.
 */
const ARMS: readonly Arm[] = [
  { label: "default", frequency: 1, size: 1 },
  { label: "frequency 0.5", frequency: 0.5, size: 1 },
  { label: "frequency 2", frequency: 2, size: 1 },
  { label: "size 3", frequency: 1, size: 3 },
];

interface Case {
  readonly region: Region;
  readonly cliffs: Position[];
}

interface CapturedArm extends Arm {
  /** `map_gen_settings.autoplace_controls.vulcanus_volcanism` read back off the surface. */
  readonly reported: { frequency: number; size: number; richness: number };
  readonly cases: Case[];
}

/** The installed game's version, read off the binary rather than assumed. */
async function installedVersion(): Promise<string> {
  const { stdout } = await run(ORACLE, ["installs", "list"]);
  const parsed = JSON.parse(stdout) as { installs: { version: string }[] };
  const versions = new Set(parsed.installs.map((i) => i.version));
  if (versions.size !== 1) {
    throw new Error(`expected exactly one install, found ${[...versions].join(", ")}`);
  }
  return parsed.installs[0].version;
}

/**
 * One region of one arm, through the oracle.
 *
 * `error("DUMPED-OK")` makes Factorio exit non-zero on a SUCCESSFUL run and the
 * tool keys success off the dump file, so a throw from `run` is expected and
 * the dump read is the real check. The dump name is the tool's contract.
 */
async function captureRegion(arm: Arm, region: Region, version: string) {
  const probeDir = await mkdtemp(join(tmpdir(), "volcanism-probe-"));
  const workDir = await mkdtemp(join(tmpdir(), "volcanism-work-"));
  try {
    const controlPath = join(probeDir, "control.lua");
    await writeFile(
      controlPath,
      buildCliffControlLua(region, {
        dumpFile: "oracle-dump.json",
        planet: "vulcanus",
        seed: SEED,
        alsoResources: true,
        autoplaceControls:
          arm.label === "default"
            ? undefined
            : { vulcanus_volcanism: { frequency: arm.frequency, size: arm.size, richness: 1 } },
      }),
    );
    const probePath = join(probeDir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify(
        {
          mode: "create",
          mod: {
            name: "vulcanus_cliff_volcanism_probe",
            version: "0.0.1",
            dependencies: ["base", "space-age"],
            control_lua_file: controlPath,
          },
          seed: SEED,
          timeout_seconds: 600,
        },
        null,
        2,
      ),
    );
    try {
      await run(
        ORACLE,
        ["run", "--probe", probePath, "--work-dir", workDir, "--version", version],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      // Expected: see the DUMPED-OK note above.
    }
    const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
    const dump = parseCliffDumpFull(await readFile(dumpPath, "utf8"));
    const reported = dump.autoplaceControls?.vulcanus_volcanism;
    if (reported === undefined) {
      throw new Error(`${arm.label}: the surface reported no vulcanus_volcanism control`);
    }
    return { cliffs: dump.cliffs, reported };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const version = await installedVersion();
  console.log(`capturing against Factorio ${version}`);
  const arms: CapturedArm[] = [];
  for (const arm of ARMS) {
    const cases: Case[] = [];
    let reported: CapturedArm["reported"] | undefined;
    for (const region of REGIONS) {
      const started = Date.now();
      const got = await captureRegion(arm, region, version);
      // The read-back has to AGREE with the arm, per region, or the arm is not
      // the arm. The default arm's read-back is the planet's own value.
      if (got.reported.frequency !== arm.frequency || got.reported.size !== arm.size) {
        throw new Error(
          `${arm.label} [${String(region.x0)},${String(region.y0)}]: surface reported ` +
            `${JSON.stringify(got.reported)}, wanted frequency ${String(arm.frequency)} ` +
            `size ${String(arm.size)}`,
        );
      }
      reported ??= got.reported;
      cases.push({ region, cliffs: got.cliffs });
      console.log(
        `  ${arm.label} [${String(region.x0)},${String(region.y0)}]: ` +
          `${String(got.cliffs.length)} cliffs in ${String(Math.round((Date.now() - started) / 1000))}s`,
      );
    }
    if (reported === undefined) throw new Error(`${arm.label}: no region captured`);
    arms.push({ ...arm, reported, cases });
  }

  const fixture = {
    _comment:
      `Ground truth from Factorio ${version} via factorio-oracle. Every cliff entity ` +
      "(find_entities_filtered{type='cliff'}) the game placed in the three regions of " +
      "oracle-vulcanus-cliff-entities.seed123456.json, once per ARM of the vulcanus_volcanism " +
      "autoplace control (#84). Each arm records the control the SURFACE reported back, so an " +
      "override that failed to apply cannot pass as a setting that does not matter. Positions " +
      "are cliff cell centres on the 4-tile grid; each entry carries LuaEntity.cliff_orientation. " +
      "Sampled on a create_surface() surface whose seed is FORCED to `seed`, like every other " +
      "Vulcanus cliff fixture. R1 [0,0] is inside the starting area and is the CONTROL: it must " +
      "not move between arms. The default arm is a re-capture of the 2.1.12 fixture at this " +
      "version. Graded by crates/fmw-noise/src/fixtures.rs. Regenerate: " +
      "node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts",
    _factorioVersion: version,
    seed: SEED,
    arms,
  };
  const out = join(FIXTURES, OUT);
  await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${out} (${String(arms.length)} arms x ${String(REGIONS.length)} regions)`);
}

await main();
