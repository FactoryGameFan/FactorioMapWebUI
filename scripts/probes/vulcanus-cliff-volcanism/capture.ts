/**
 * The Vulcanus cliff VOLCANISM sweep - the game's cliff entities in the three
 * regions of `oracle-vulcanus-cliff-entities.seed123456.json`, captured at
 * several settings of the `vulcanus_volcanism` autoplace control (#84).
 *
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts sweep
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts oos
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-volcanism/capture.ts ore
 *
 * `sweep` is the four-arm capture over the three known regions; `oos` is the
 * out-of-sample replication - eight FRESH regions at two arms, described at
 * `OUT_OF_SAMPLE` below; `ore` is the resource lever on the one region that
 * replication found concentrated, at `ORE_LEVER`.
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
 * `alsoResources` is on for every capture because the read-back of
 * `autoplace_controls` rides that block in the builder. The `sweep` and `oos`
 * fixtures drop the resource entities it also dumps, and their shape must not
 * change - their frozen rows and provenance describe the files as written. The
 * `ore` capture KEEPS them (`keepResources`): the first `ore` fixture
 * (2026-09-07) threw them away, so it could say the game's ore rule removed 65
 * cliffs where the port's removed 39 and could not say whether the port's ore
 * FIELD or its removal GEOMETRY was the part that disagreed. Prototype geometry
 * is still dropped everywhere.
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
  /**
   * Switch ALL four Vulcanus resource controls off (`size = 0`), the lever
   * `oracle-vulcanus-cliff-ore-direction` pulls. The ore rule removes cliffs
   * where ore lands, so a surplus cell that FOLLOWS this lever is the ore
   * rule's, and one that does not is something else's.
   */
  readonly resourcesOff?: boolean;
}

const RESOURCE_CONTROLS = ["tungsten_ore", "vulcanus_coal", "calcite", "sulfuric_acid_geyser"];

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
  /**
   * Write each case's `type = "resource"` entities into the fixture. Off by
   * default so the sweep and oos fixtures keep the shape their frozen rows and
   * provenance describe; on for the ore lever, where the entities ARE the
   * question.
   */
  readonly keepResources?: boolean;
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
 * against frequency 0.5, which READ as halving the residual rate (41 of 1248
 * against 21 of 1359, about 2.9 sigma) on the three known regions. It did not
 * replicate: out of sample the default arm is the better one, z = -1.80. See
 * `the_volcanism_contrast_out_of_sample` in `fixtures.rs`.
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

/**
 * The ore lever on the ONE region the replication found concentrated.
 *
 * Out of sample, the frequency 0.5 arm's `[-2200,-1500]` carried 74 of that
 * arm's 138 errors - 24 wrong and 47 SURPLUS of 795 comparable cells - while
 * the next worst region had 14. Surplus is a cell the port places and the game
 * does not, and the game's cliff-removing mechanism in this port's model is the
 * ore rule (`cliff_removal_probability`). So: the same region, the same slider,
 * with every Vulcanus resource control OFF. If the 47 follow the lever the
 * concentration is the ore rule at a non-default field; if they stay, it is
 * something the ore rule does not touch.
 *
 * The ON arm re-captures what the oos fixture already holds, on purpose: it is
 * the determinism check for the pair, and it keeps the fixture self-contained.
 *
 * It keeps the game's resource ENTITIES too. The first capture of this fixture
 * (2026-09-07) dropped them, and the answer it could give - the game's ore
 * rule removed 65 cliffs here, the port's removed 39 - stopped short of the
 * question that matters: whether the port's ore FIELD disagrees with the game
 * at this volcanism setting, or the field agrees and the removal geometry is
 * what differs. `fixtures.rs` intersects the entities with the port's footprint
 * where the cliff rule reads it. The OFF arm's list must come back empty, which
 * is the lever landing, checked rather than assumed.
 */
const ORE_LEVER: Capture = {
  out: "oracle-vulcanus-cliff-volcanism-ore.seed123456.json",
  regions: [{ x0: -2200, y0: -1500, x1: -1944, y1: -1244 }],
  arms: [
    { label: "frequency 0.5, resources ON", frequency: 0.5, size: 1 },
    { label: "frequency 0.5, ALL resources OFF", frequency: 0.5, size: 1, resourcesOff: true },
  ],
  keepResources: true,
  comment:
    "Every cliff entity (find_entities_filtered{type='cliff'}) the game placed in [-2200,-1500], " +
    "the region oracle-vulcanus-cliff-volcanism-oos found carrying 74 of the frequency 0.5 " +
    "arm's 138 errors, at frequency 0.5 with the four Vulcanus resource controls ON and OFF " +
    "(size 0, the lever oracle-vulcanus-cliff-ore-direction pulls) - does the surplus follow " +
    "the ore rule? (#84). Each arm also records the four resource controls the SURFACE " +
    "reported back, and each case carries every resource entity " +
    "(find_entities_filtered{type='resource'}) in the region as {x, y, name} at the entity's " +
    "own position (tile centres for the solid ores), so the port's ore FIELD can be graded " +
    "where the cliff rule reads it. The OFF arm's list is empty by construction.",
};

const CAPTURES: Record<string, Capture> = { sweep: SWEEP, oos: OUT_OF_SAMPLE, ore: ORE_LEVER };

/** One `type = "resource"` entity as the game reports it, at its own position. */
interface ResourceEntity extends Position {
  readonly name: string;
}

interface Case {
  readonly region: Region;
  readonly cliffs: Position[];
  /** Present only when the capture sets `keepResources`. */
  readonly resources?: ResourceEntity[];
}

interface CapturedArm extends Arm {
  /** `map_gen_settings.autoplace_controls.vulcanus_volcanism` read back off the surface. */
  readonly reported: { frequency: number; size: number; richness: number };
  /** The four Vulcanus resource controls read back off the surface. */
  readonly reportedResources: Controls;
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

type Controls = Record<string, { frequency: number; size: number; richness: number }>;

/**
 * The `autoplace_controls` overrides one arm writes, or none for the default
 * arm - so its read-back reports what the planet ships with rather than an
 * echo of what was written.
 */
function overridesFor(arm: Arm): Controls | undefined {
  const out: Controls = {};
  if (arm.frequency !== 1 || arm.size !== 1) {
    out.vulcanus_volcanism = { frequency: arm.frequency, size: arm.size, richness: 1 };
  }
  if (arm.resourcesOff === true) {
    for (const name of RESOURCE_CONTROLS) out[name] = { frequency: 1, size: 0, richness: 1 };
  }
  return Object.keys(out).length === 0 ? undefined : out;
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
        autoplaceControls: overridesFor(arm),
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
    // The four resource controls, read back the same way, so a resources-off
    // arm proves the lever landed rather than assuming it.
    const resourceControls: Controls = {};
    for (const name of RESOURCE_CONTROLS) {
      const c = dump.autoplaceControls?.[name];
      if (c === undefined) throw new Error(`${arm.label}: the surface reported no ${name}`);
      resourceControls[name] = c;
    }
    // The entities themselves. `alsoResources` is on, so the list is always
    // present (empty for a resources-off arm); the Lua writes `name` on every
    // entry, and that is checked here rather than cast, because the grading
    // splits the list by name.
    if (dump.resources === undefined) {
      throw new Error(`${arm.label}: the dump carries no resources list`);
    }
    const resources: ResourceEntity[] = dump.resources.map((e) => {
      const name = (e as Partial<ResourceEntity>).name;
      if (typeof name !== "string") {
        throw new Error(
          `${arm.label}: a resource entity at ${String(e.x)},${String(e.y)} has no name`,
        );
      }
      return { x: e.x, y: e.y, name };
    });
    return { cliffs: dump.cliffs, reported, resourceControls, resources };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "sweep";
  const capture = Object.hasOwn(CAPTURES, which) ? CAPTURES[which] : undefined;
  if (capture === undefined) {
    throw new Error(`unknown capture "${which}"; one of ${Object.keys(CAPTURES).join(", ")}`);
  }
  const version = await installedVersion();
  console.log(`capturing "${which}" against Factorio ${version}`);
  const arms: CapturedArm[] = [];
  for (const arm of capture.arms) {
    const cases: Case[] = [];
    let reported: CapturedArm["reported"] | undefined;
    let reportedResources: Controls | undefined;
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
      // Same for the resource lever: every one of the four must report the
      // size the arm asked for, ON or OFF.
      const wantSize = arm.resourcesOff === true ? 0 : 1;
      for (const name of RESOURCE_CONTROLS) {
        if (got.resourceControls[name]?.size !== wantSize) {
          throw new Error(
            `${arm.label} [${String(region.x0)},${String(region.y0)}]: ${name} reported ` +
              `${JSON.stringify(got.resourceControls[name])}, wanted size ${String(wantSize)}`,
          );
        }
      }
      // The entity list is the lever's OTHER witness: a resources-off arm that
      // still dumps entities did not land, whatever the controls read back.
      if (arm.resourcesOff === true && got.resources.length !== 0) {
        throw new Error(
          `${arm.label} [${String(region.x0)},${String(region.y0)}]: resources OFF but the ` +
            `game dumped ${String(got.resources.length)} resource entities`,
        );
      }
      reported ??= got.reported;
      reportedResources ??= got.resourceControls;
      cases.push(
        capture.keepResources === true
          ? { region, cliffs: got.cliffs, resources: got.resources }
          : { region, cliffs: got.cliffs },
      );
      console.log(
        `  ${arm.label} [${String(region.x0)},${String(region.y0)}]: ` +
          `${String(got.cliffs.length)} cliffs, ${String(got.resources.length)} resource ` +
          `entities in ${String(Math.round((Date.now() - started) / 1000))}s`,
      );
    }
    if (reported === undefined) throw new Error(`${arm.label}: no region captured`);
    if (reportedResources === undefined) throw new Error(`${arm.label}: no resources read back`);
    arms.push({ ...arm, reported, reportedResources, cases });
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
