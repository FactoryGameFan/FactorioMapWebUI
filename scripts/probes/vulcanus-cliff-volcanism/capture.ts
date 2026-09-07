/**
 * The Vulcanus cliff VOLCANISM sweep - the game's cliff entities in the three
 * regions of `oracle-vulcanus-cliff-entities.seed123456.json`, captured at
 * several settings of the `vulcanus_volcanism` autoplace control (#84).
 *
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts sweep
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts oos
 *
 * `sweep` is the four-arm capture over the three known regions; `oos` is the
 * out-of-sample replication - eight FRESH regions at two arms, described at
 * `OUT_OF_SAMPLE` below.
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
const SWEEP_ARMS: readonly Arm[] = [
  { label: "default", frequency: 1, size: 1 },
  { label: "frequency 0.5", frequency: 0.5, size: 1 },
  { label: "frequency 2", frequency: 2, size: 1 },
  { label: "size 3", frequency: 1, size: 3 },
];

interface Capture {
  readonly out: string;
  readonly regions: readonly Region[];
  readonly arms: readonly Arm[];
  readonly comment: string;
}

/** The four-arm sweep over the three regions of `oracle-vulcanus-cliff-entities`, verbatim. */
const SWEEP: Capture = {
  out: "oracle-vulcanus-cliff-volcanism-sweep.seed123456.json",
  regions: [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
  ],
  arms: SWEEP_ARMS,
  comment:
    "Every cliff entity (find_entities_filtered{type='cliff'}) the game placed in the three " +
    "regions of oracle-vulcanus-cliff-entities.seed123456.json, once per ARM of the " +
    "vulcanus_volcanism autoplace control (#84). R1 [0,0] is inside the starting area and is " +
    "the CONTROL: it must not move between arms. The default arm is a re-capture of the 2.1.12 " +
    "fixture at this version.",
};

/**
 * The out-of-sample replication of the sweep's headline contrast - default
 * against frequency 0.5, which halved the residual rate (41 of 1248 against 21
 * of 1359, about 2.9 sigma) on the three known regions.
 *
 * Eight FRESH 256x256 regions, disjoint from every one of the 23 Vulcanus
 * cliff regions already captured (listed by walking every
 * `oracle-vulcanus-cliff*` fixture for `{x0, y0, x1, y1}`), all more than
 * 1000 tiles from the origin so none is inside the starting area R1 proved
 * blind, and spread over all four quadrants. Two arms rather than four
 * because n per arm, not arm count, is what the 2.9 sigma needs.
 *
 * Each was checked on the engine before capture - "a window must contain the
 * thing it grades" - for cliff pixels in BOTH arms and for movement between
 * them, cliffs-view at 1 tile/px over 65,536 pixels:
 *
 * | region          | cliff px default | cliff px f0.5 | moved  |
 * | --------------- | ---------------: | ------------: | -----: |
 * | `[2000,-1200]`  |            5,120 |         9,968 | 50,873 |
 * | `[-2200,-1500]` |            3,488 |        13,424 | 62,935 |
 * | `[1800,3400]`   |           12,288 |         3,200 | 57,775 |
 * | `[600,2200]`    |            7,568 |        12,480 | 51,824 |
 * | `[4000,-600]`   |           11,280 |         7,104 | 60,403 |
 * | `[-2800,400]`   |            8,608 |         4,096 | 56,648 |
 * | `[1400,-3200]`  |           13,776 |        10,560 | 42,280 |
 * | `[2600,800]`    |           11,712 |         5,328 | 61,609 |
 *
 * Four candidates were dropped for having under 2,000 cliff pixels in one arm
 * (`[-3200,-2000]` 384, `[3200,1600]` 1,200, `[-1400,-2600]` 1,904,
 * `[-600,-2000]` 896): a region with almost no cliffs in an arm grades almost
 * nothing there.
 */
const OUT_OF_SAMPLE: Capture = {
  out: "oracle-vulcanus-cliff-volcanism-oos.seed123456.json",
  regions: [
    { x0: 2000, y0: -1200, x1: 2256, y1: -944 },
    { x0: -2200, y0: -1500, x1: -1944, y1: -1244 },
    { x0: 1800, y0: 3400, x1: 2056, y1: 3656 },
    { x0: 600, y0: 2200, x1: 856, y1: 2456 },
    { x0: 4000, y0: -600, x1: 4256, y1: -344 },
    { x0: -2800, y0: 400, x1: -2544, y1: 656 },
    { x0: 1400, y0: -3200, x1: 1656, y1: -2944 },
    { x0: 2600, y0: 800, x1: 2856, y1: 1056 },
  ],
  arms: SWEEP_ARMS.filter((a) => a.label === "default" || a.label === "frequency 0.5"),
  comment:
    "Every cliff entity (find_entities_filtered{type='cliff'}) the game placed in eight FRESH " +
    "256x256 regions, disjoint from every Vulcanus cliff region captured before it, at the " +
    "default and the frequency 0.5 arm of the vulcanus_volcanism control - the out-of-sample " +
    "replication of oracle-vulcanus-cliff-volcanism-sweep's headline contrast (#84). Every " +
    "region is more than 1000 tiles from the origin, outside the starting area the sweep's R1 " +
    "proved blind to the slider.",
};

const CAPTURES: Record<string, Capture> = { sweep: SWEEP, oos: OUT_OF_SAMPLE };

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
    // A successful run throws (DUMPED-OK), so the error cannot be re-thrown
    // here. It is KEPT, because a real failure - a missing binary, a Lua error
    // before the dump, a timeout - also lands here, and without it the next
    // line reports an ENOENT on the dump that hides the cause.
    let oracleError: unknown;
    try {
      await run(
        ORACLE,
        ["run", "--probe", probePath, "--work-dir", workDir, "--version", version],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (e) {
      oracleError = e;
    }
    const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
    let dumpText: string;
    try {
      dumpText = await readFile(dumpPath, "utf8");
    } catch (e) {
      throw new Error(
        `${arm.label} [${String(region.x0)},${String(region.y0)}]: no dump at ${dumpPath}`,
        { cause: oracleError ?? e },
      );
    }
    const dump = parseCliffDumpFull(dumpText);
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
  const which = process.argv[2] ?? "sweep";
  const capture = CAPTURES[which];
  if (capture === undefined) {
    throw new Error(`unknown capture "${which}"; one of ${Object.keys(CAPTURES).join(", ")}`);
  }
  const version = await installedVersion();
  console.log(`capturing "${which}" against Factorio ${version}`);
  const arms: CapturedArm[] = [];
  for (const arm of capture.arms) {
    const cases: Case[] = [];
    let reported: CapturedArm["reported"] | undefined;
    for (const region of capture.regions) {
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
      `Ground truth from Factorio ${version} via factorio-oracle. ${capture.comment} ` +
      "Each arm records the control the SURFACE reported back, so an override that failed to " +
      "apply cannot pass as a setting that does not matter. Positions are cliff cell centres on " +
      "the 4-tile grid; each entry carries LuaEntity.cliff_orientation. Sampled on a " +
      "create_surface() surface whose seed is FORCED to `seed`, like every other Vulcanus cliff " +
      "fixture. Graded by crates/fmw-noise/src/fixtures.rs. Regenerate: " +
      `node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts ${which}`,
    _factorioVersion: version,
    seed: SEED,
    arms,
  };
  const out = join(FIXTURES, capture.out);
  await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `wrote ${out} (${String(arms.length)} arms x ${String(capture.regions.length)} regions)`,
  );
}

await main();
