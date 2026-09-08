/**
 * `Surface::wouldCollide`'s OWN decisions, read out of the running game (#84).
 *
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-wouldcollide/capture.ts
 *
 * Every other Vulcanus cliff fixture records what SURVIVED the apply-stage
 * collision test. This one records the test itself: each call the map
 * generator makes to
 * `Surface::wouldCollide(CliffPrototype const&, MapPosition const&, CliffOrientation)`
 * while creating the three regions of `oracle-vulcanus-cliff-entities`, with
 * the box it tested, the AABB `getAABB` widened it to, what the tile half and
 * the entity half each returned, and the verdict. It is the only instrument
 * that grades the port's predicate against the game's predicate one boolean
 * at a time, rather than against the cliffs left standing.
 *
 * ## How it works, and why it is not a Lua capture
 *
 * No Lua API exposes the collision test the generator runs. So the capture is
 * an lldb breakpoint script (`probe.py`, beside this file) on the 2.0.77
 * mac-arm64 binary, driven through a `--create` run with the SAME probe mod
 * `test/oracle/oracle.ts`'s `buildCliffControlLua` builds for every other
 * cliff fixture - so the game generates the same surface, and the dump it
 * writes is the control that it did (283/885/409 cliffs, crater segments
 * included). Three things about that are load-bearing:
 *
 * - **It needs a debuggable copy of the game, and the copy must NOT be
 *   quarantined.** The shipped binary is signed with the hardened runtime and
 *   no `get-task-allow`, so lldb cannot attach; the fix is a bundle whose
 *   `Contents/MacOS/factorio` and `Info.plist` are real copies re-signed ad hoc
 *   with `get-task-allow`, everything else symlinked to the original. `cp`
 *   inherits `com.apple.quarantine`, and a quarantined ad-hoc binary launched
 *   from a terminal HANGS in `_dyld_start` forever: Gatekeeper puts up a dialog
 *   (`syspolicyd: Prompt shown, waiting for response`) nobody headless can
 *   answer, and answering it on the desktop moves the bundle to the Trash.
 *   `xattr -d com.apple.quarantine` on the copied binary before the first
 *   launch is the whole fix; it launches in 1.6s after that. `DEBUG_APP` below
 *   names the bundle; `docs/noise/vulcanus-cliffs-NOTES.md` has the recipe.
 * - **2.0.77, not the installed 2.1.17**, because it is the one local binary
 *   with an unstripped symbol table, and because the 2026-09-07 re-capture
 *   showed it places the same Vulcanus cliffs as 2.1.12 and 2.1.17 in all
 *   three regions, cell for cell. Every address in `probe.py` is a 2.0.77
 *   build 84539 address; re-derive with `nm -n | c++filt` for any other.
 * - **A bare-address breakpoint set before launch never resolves.** The
 *   by-name control hit 1350 times while seven address breakpoints sat at
 *   hit count 0; `probe.py` resolves each through the module's file address
 *   instead, and the run asserts every breakpoint was hit.
 *
 * The Gatekeeper trap and the breakpoint trap each cost a session. Both are
 * in the comments beside the code that hit them.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildCliffControlLua, type Region } from "../../../test/oracle/oracle.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FIXTURES = join(REPO, "test", "fixtures");
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");
const INSTALLS = join(homedir(), "GitHub", "factorio-oracle", "installs");
/** The unstripped install the addresses in `probe.py` belong to. */
const GAME_APP = join(INSTALLS, "factorio-2.0.77.app");
/** Its re-signed, un-quarantined copy - see the header. */
const DEBUG_APP = join(INSTALLS, "factorio-2.0.77-debug.app");
const DEBUG_BIN = join(DEBUG_APP, "Contents", "MacOS", "factorio");
const EXPECTED_VERSION = "2.0.77";

/** Every committed Vulcanus cliff fixture forces the surface seed to this. */
const SEED = 123456;

/** The three regions of `oracle-vulcanus-cliff-entities.seed123456.json`, verbatim. */
const REGIONS: readonly Region[] = [
  { x0: 0, y0: 0, x1: 256, y1: 256 },
  { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
  { x0: -1200, y0: 800, x1: -944, y1: 1056 },
];

const OUT = "oracle-vulcanus-wouldcollide.seed123456.json";

/** One event as `probe.py` writes it. */
interface Event {
  readonly tid: number;
  readonly orientation: number;
  readonly proto: number;
  readonly pos: readonly [number, number];
  readonly box: { l: number; t: number; r: number; b: number; o_lo: number; o_hi: number };
  readonly aabb: { l: number; t: number; r: number; b: number; o_lo: number; o_hi: number };
  readonly path: "tile" | "transitions";
  readonly tile_hit: number;
  readonly entity_hit: number;
  readonly entity_vtable?: string;
  readonly entity_aabb?: { l: number; t: number; r: number; b: number };
  readonly result: number;
}

/** One call as the fixture records it. */
interface Call {
  readonly prototype: "cliff-vulcanus" | "crater-cliff";
  readonly x: number;
  readonly y: number;
  readonly orientation: number;
  readonly box: readonly [number, number, number, number];
  readonly rotation: readonly [number, number];
  readonly aabb: readonly [number, number, number, number];
  readonly tileHit: boolean;
  readonly entity: { kind: string; aabb: readonly [number, number, number, number] | null } | null;
  readonly result: boolean;
}

/** Refuse to run against a binary whose addresses `probe.py` does not describe. */
async function assertDebugBinary(): Promise<void> {
  const { stdout } = await run(DEBUG_BIN, ["--version"], { timeout: 60_000 });
  const line = stdout.split("\n")[0] ?? "";
  if (!line.includes(`Version: ${EXPECTED_VERSION} `)) {
    throw new Error(`${DEBUG_BIN} reports "${line}", wanted ${EXPECTED_VERSION}`);
  }
  // A quarantined copy never gets this far - it hangs instead - but a copy
  // that was re-quarantined by a later cp would, so say it out loud.
  const { stdout: attrs } = await run("xattr", [DEBUG_BIN]);
  if (attrs.includes("com.apple.quarantine")) {
    throw new Error(
      `${DEBUG_BIN} is quarantined; run: xattr -d com.apple.quarantine "${DEBUG_BIN}"`,
    );
  }
}

/**
 * Build the work dir with the ORIGINAL app through the oracle - config.ini,
 * map-gen-settings.json, the probe mod and a first dump - then replay the exact
 * same `--create` under lldb with the debug copy. The oracle records provenance
 * and enforces a timeout; lldb gets a ready-made world.
 */
async function captureRegion(region: Region): Promise<{ calls: Call[]; cliffs: number }> {
  const probeDir = await mkdtemp(join(tmpdir(), "wouldcollide-probe-"));
  const workDir = await mkdtemp(join(tmpdir(), "wouldcollide-work-"));
  try {
    const controlPath = join(probeDir, "control.lua");
    await writeFile(
      controlPath,
      buildCliffControlLua(region, {
        dumpFile: "oracle-dump.json",
        planet: "vulcanus",
        seed: SEED,
      }),
    );
    const probePath = join(probeDir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify(
        {
          mode: "create",
          mod: {
            name: "vulcanus_cliff_wouldcollide_probe",
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
    // A successful run throws (DUMPED-OK); the dump read below is the check.
    try {
      await run(
        ORACLE,
        ["run", "--probe", probePath, "--work-dir", workDir, "--factorio", GAME_APP],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      // expected
    }
    const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
    const firstDump = JSON.parse(await readFile(dumpPath, "utf8")) as { cliffs: unknown[] };

    // The replay: same argv the oracle used (read off its log line), debug binary.
    const eventsPath = join(probeDir, "events.json");
    const commands = [
      `command script import ${join(HERE, "probe.py")}`,
      "script probe.setup(lldb.debugger)",
      `process launch -- --create ${join(workDir, "write", "probe.zip")} --map-gen-settings ${join(workDir, "map-gen-settings.json")} --map-gen-seed ${String(SEED)} --mod-directory ${join(workDir, "mods")} --config ${join(workDir, "config.ini")}`,
      "script probe.assert_all_hit(lldb.debugger)",
      `script probe.dump(${JSON.stringify(eventsPath)})`,
    ];
    const lldbScript = join(probeDir, "probe.lldb");
    await writeFile(lldbScript, `${commands.join("\n")}\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("lldb", ["-b", "-s", lldbScript, DEBUG_BIN], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("lldb replay timed out after 900s"));
      }, 900_000);
      // A missing lldb emits `error` and never `exit`; without this the
      // promise would sit until the timer fired and blame a timeout.
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to start lldb: ${err.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (!out.includes("probe: wrote")) {
          reject(
            new Error(`lldb replay wrote no events (exit ${String(code)}):\n${out.slice(-2000)}`),
          );
        } else {
          resolve();
        }
      });
    });
    // The replay's own dump must reproduce the oracle run's: same world.
    const replayDump = JSON.parse(await readFile(dumpPath, "utf8")) as { cliffs: unknown[] };
    if (replayDump.cliffs.length !== firstDump.cliffs.length) {
      throw new Error(
        `replay placed ${String(replayDump.cliffs.length)} cliffs, the oracle run ${String(firstDump.cliffs.length)}`,
      );
    }
    const events = JSON.parse(await readFile(eventsPath, "utf8")) as Event[];
    return { calls: toCalls(events), cliffs: replayDump.cliffs.length };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Label the two `CliffPrototype` pointers a run sees: the one whose calls sit
 * on the 4-tile cell grid is `cliff-vulcanus`, the other `crater-cliff`.
 */
function toCalls(events: readonly Event[]): Call[] {
  const onGrid = new Map<number, number>();
  for (const e of events) {
    const [x, y] = [e.pos[0] / 256, e.pos[1] / 256];
    const hit = x % 4 === 2 && y % 4 === 2.5 ? 1 : 0;
    onGrid.set(e.proto, (onGrid.get(e.proto) ?? 0) + hit);
  }
  const protos = [...onGrid.entries()].sort((a, b) => b[1] - a[1]);
  if (protos.length > 2) throw new Error(`expected two prototypes, saw ${String(protos.length)}`);
  const label = new Map<number, Call["prototype"]>();
  label.set(protos[0][0], "cliff-vulcanus");
  if (protos.length === 2) {
    if (protos[1][1] !== 0) throw new Error("both prototypes have calls on the cell grid");
    label.set(protos[1][0], "crater-cliff");
  }
  return events.map((e) => {
    const kind = label.get(e.proto);
    if (kind === undefined) throw new Error("unlabelled prototype");
    return {
      prototype: kind,
      x: e.pos[0] / 256,
      y: e.pos[1] / 256,
      orientation: e.orientation,
      box: [e.box.l, e.box.t, e.box.r, e.box.b],
      rotation: [e.box.o_lo, e.box.o_hi],
      aabb: [e.aabb.l, e.aabb.t, e.aabb.r, e.aabb.b],
      tileHit: e.tile_hit !== 0,
      entity:
        e.entity_hit !== 0
          ? {
              kind: (e.entity_vtable ?? "?").replace("vtable for ", ""),
              aabb: e.entity_aabb
                ? [e.entity_aabb.l, e.entity_aabb.t, e.entity_aabb.r, e.entity_aabb.b]
                : null,
            }
          : null,
      result: e.result !== 0,
    };
  });
}

const COMMENT =
  "Ground truth from Factorio 2.0.77 (build 84539, mac-arm64), read out of the running game with lldb " +
  "rather than through Lua: every call the map generator made to Surface::wouldCollide(CliffPrototype const&, " +
  "MapPosition const&, CliffOrientation) - the APPLY-stage collision test EntityMapGenerationTask::applyCliffs " +
  "runs on each queued cliff - while creating the three regions of oracle-vulcanus-cliff-entities.seed123456.json " +
  "on a forced-seed Vulcanus surface (the same probe mod, so the same 283/885/409 cliffs came out). Per call: the " +
  "prototype (cliff-vulcanus, or crater-cliff for the eight-segment crater rings, told apart by which of the two " +
  "CliffPrototype pointers the generator passed sits on the 4-tile cell grid), the cell centre and orientation id " +
  "(CLIFF_ORIENTATION_NAMES order), `box` = that orientation's collision_bounding_box with the position added, in " +
  "1/256 MapPosition units [left, top, right, bottom]; `rotation` = the box's orientation word as two 16-bit halves " +
  "[sin, -cos] in 1.15 fixed point (0x5A82 = 45 degrees, the rotbb 1/8 tag; 0 with 0x8001 is the identity); " +
  "`aabb` = what BoundingBox::getAABB returned for it; `tileHit` = what Surface::checkTileCollisions returned; " +
  "`entity` = the entity Surface::collideWithEntity returned, by vtable symbol, with its own AABB; `result` = the " +
  "call's return, true meaning the cliff is destroyed. Calls outside the region are the chunk halo the generator " +
  "also queued. Captured by scripts/probes/vulcanus-cliff-wouldcollide (#84). Graded by " +
  "crates/fmw-noise/src/fixtures.rs.";

async function main(): Promise<void> {
  await assertDebugBinary();
  const cases: { region: Region; calls: Call[] }[] = [];
  for (const region of REGIONS) {
    const started = Date.now();
    const { calls, cliffs } = await captureRegion(region);
    console.log(
      `  [${String(region.x0)},${String(region.y0)}]: ${String(calls.length)} calls, ${String(cliffs)} cliffs, ` +
        `${String(Math.round((Date.now() - started) / 1000))}s`,
    );
    cases.push({ region, calls });
  }
  // Pretty at the top, one line per call: 2,157 calls pretty-printed would be
  // thirty thousand lines for no reader's benefit.
  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(COMMENT)},`,
    `  "_factorioVersion": ${JSON.stringify(EXPECTED_VERSION)},`,
    `  "seed": ${String(SEED)},`,
    '  "cases": [',
  ];
  cases.forEach((c, ci) => {
    lines.push("    {", `      "region": ${JSON.stringify(c.region)},`, '      "calls": [');
    c.calls.forEach((call, i) => {
      lines.push(`        ${JSON.stringify(call)}${i + 1 < c.calls.length ? "," : ""}`);
    });
    lines.push("      ]", `    }${ci + 1 < cases.length ? "," : ""}`);
  });
  lines.push("  ]", "}");
  const out = join(FIXTURES, OUT);
  await writeFile(out, `${lines.join("\n")}\n`);
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}

await main();
