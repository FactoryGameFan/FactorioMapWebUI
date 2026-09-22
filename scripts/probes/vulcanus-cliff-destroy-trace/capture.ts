/**
 * WHO destroys a Vulcanus cliff after it passed the apply-stage collision
 * test, read out of the running game (#84).
 *
 *   node --experimental-strip-types scripts/probes/vulcanus-cliff-destroy-trace/capture.ts
 *
 * `../vulcanus-cliff-wouldcollide/` recorded every `Surface::wouldCollide`
 * decision and showed that, with the game's own entity kills fed in, the
 * cells the port still gets wrong in `[1500,1500]` all PASSED that test and
 * are absent from the game's map anyway. Something destroys them later. This
 * probe breaks on every place a cliff's life changes - `Cliff::setup`
 * (created), `Cliff::destroyEnd`'s shrink (trimmed), `Entity::forceDestroy`
 * (gone), `destroyEnd`'s self-destroy (with the entity the trimmed box hit),
 * and `Surface::wouldCollide`'s verdicts - and records each with its caller
 * chain, so the killer is named rather than inferred. `summarise` folds that
 * into the committed fixture: each destroy's ROOT frame and its chain's
 * first cliff.
 *
 * `Cliff::setCliffOrientation` is inlined at every call that matters, so its
 * by-name breakpoint resolves and never fires; trims are read at the `strb`
 * inside `destroyEnd` instead. It stays in `probe.py` so the hit count keeps
 * saying so.
 *
 * The replay machinery is the wouldCollide probe's, and its header carries
 * the traps that each cost a session: the debug copy must be re-signed with
 * `get-task-allow` and NOT quarantined, and only 2.0.77 has a symbol table.
 * 2.0.77 places the same Vulcanus cliffs as 2.1.17 in these regions (measured
 * 2026-09-07), so its answers transfer.
 *
 * Two regions, the two that carry every apply-stage error the port has left
 * (graded in `crates/fmw-noise/src/fixtures.rs`):
 * `[1500,1500]` at the default settings, and `[-2200,-1500]` at
 * `vulcanus_volcanism` frequency 0.5, the region
 * `oracle-vulcanus-cliff-volcanism-ore` captured on 2.1.17.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildCliffControlLua,
  parseCliffDumpFull,
  type Region,
} from "../../../test/oracle/oracle.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");
const INSTALLS = join(homedir(), "GitHub", "factorio-oracle", "installs");
const GAME_APP = join(INSTALLS, "factorio-2.0.77.app");
const DEBUG_APP = join(INSTALLS, "factorio-2.0.77-debug.app");
const DEBUG_BIN = join(DEBUG_APP, "Contents", "MacOS", "factorio");
const EXPECTED_VERSION = "2.0.77";
const SEED = 123456;

type Controls = Record<string, { frequency: number; size: number; richness: number }>;

interface Target {
  readonly label: string;
  readonly region: Region;
  readonly autoplaceControls?: Controls;
}

const TARGETS: readonly Target[] = [
  { label: "[1500,1500] default", region: { x0: 1500, y0: 1500, x1: 1756, y1: 1756 } },
  {
    label: "[-2200,-1500] f0.5",
    region: { x0: -2200, y0: -1500, x1: -1944, y1: -1244 },
    autoplaceControls: { vulcanus_volcanism: { frequency: 0.5, size: 1, richness: 1 } },
  },
];

/** One event as `probe.py` writes it. */
interface Event {
  readonly kind:
    | "setup"
    | "onDestroy"
    | "forceDestroy"
    | "setOrientation"
    | "trim"
    | "destroyEndCollide"
    | "wouldCollide";
  readonly tid: number;
  readonly this: number;
  readonly pos: readonly [number, number] | null;
  readonly orientation: number | null;
  readonly to?: number;
  readonly stack: readonly string[];
  /** `destroyEndCollide`: the vtable of what the trimmed box hit; `wouldCollide`: the entity half's hit. */
  readonly entity?: string;
  readonly entity_aabb?: readonly [number, number, number, number];
  /** `wouldCollide` only. */
  readonly proto?: number;
  readonly tile?: number;
  readonly result?: number;
}

/** `CliffOrientation` ids, in the engine's order (the port's `CLIFF_ORIENTATION_NAMES`). */
const ORIENTATIONS = [
  "west-to-east",
  "north-to-south",
  "east-to-west",
  "south-to-north",
  "west-to-north",
  "north-to-east",
  "east-to-south",
  "south-to-west",
  "west-to-south",
  "north-to-west",
  "east-to-north",
  "south-to-east",
  "west-to-none",
  "none-to-east",
  "east-to-none",
  "none-to-west",
  "north-to-none",
  "none-to-south",
  "south-to-none",
  "none-to-north",
] as const;

type Cell = readonly [number, number];

/** What ended or trimmed a cliff, named by the frame that started the chain. */
type Root = "applyCliffs" | "postSetup" | "destroyCliffsTrigger" | "updateConnections";

const ROOT_FRAMES: readonly [string, Root][] = [
  ["EntityMapGenerationTask::applyCliffs", "applyCliffs"],
  ["ResourceEntity::postSetup", "postSetup"],
  ["DestroyCliffsTriggerEffectItem::applyInternal", "destroyCliffsTrigger"],
  ["Cliff::updateConnections", "updateConnections"],
];

/** The destroy machinery every chain passes through, skipped when naming its root. */
const PLUMBING =
  /onToBeDestroyed|Entity::forceDestroy|\[inlined\] destroy$|Cliff::onDestroy|Cliff::destroyEnd/;

function rootOf(stack: readonly string[]): Root {
  const frame = stack.find((f) => !PLUMBING.test(f)) ?? "";
  const hit = ROOT_FRAMES.find(([name]) => frame.includes(name));
  if (hit === undefined) throw new Error(`unknown root frame "${frame}"`);
  return hit[1];
}

/** How many `Cliff::onDestroy` frames sit above this one: 0 is the chain's first cliff. */
function depthOf(stack: readonly string[]): number {
  return stack.filter((f) => f.includes("Cliff::onDestroy")).length;
}

const cellOf = (pos: readonly [number, number]): Cell => [pos[0] / 256, pos[1] / 256];
const onCellGrid = ([x, y]: Cell) => ((x % 4) + 4) % 4 === 2 && ((y % 4) + 4) % 4 === 2.5;
const tiles = (b: readonly number[]) => b.map((v) => v / 256);
const kindOf = (vtable: string) => vtable.replace("vtable for ", "");

/** A `Surface::wouldCollide` call that said collide. */
interface Kill {
  readonly prototype: "cliff-vulcanus" | "crater-cliff";
  readonly x: number;
  readonly y: number;
  readonly orientation: string;
  /** `tile`, or the entity half's hit by class: `Segment`, `SimpleEntity`, `Cliff`, ... */
  readonly by: string;
  readonly aabb: readonly number[] | null;
}

/** A cliff destroyed after `applyCliffs` created it. */
interface Destroy {
  readonly prototype: "cliff-vulcanus" | "crater-cliff";
  readonly x: number;
  readonly y: number;
  /** The orientation it stood with when destroyed - trimmed, for a cascade. */
  readonly orientation: string;
  readonly root: Root;
  /**
   * `direct`: the root destroyed it. `trimToNothing`: a neighbour's destroy
   * trimmed away its last end. `trimThenCollide`: a neighbour's destroy
   * trimmed it and its smaller box hit `collider`, so it destroyed itself.
   */
  readonly via: "direct" | "trimToNothing" | "trimThenCollide";
  readonly collider?: string;
  /** For a cascade: the chain's first cliff. */
  readonly origin?: Cell;
}

/** A cliff trimmed by a neighbour's destroy (`Cliff::destroyEnd`'s shrink). */
interface Trim {
  readonly x: number;
  readonly y: number;
  readonly from: string;
  readonly to: string;
  readonly root: Root;
  readonly origin: Cell;
}

/**
 * Fold the raw events into what the fixture keeps. Order within a thread is
 * the game's order: a chain's first cliff is broken on before any cliff its
 * `onDestroy` reaches, so the most recent depth-0 destroy on a thread is the
 * origin of every deeper event after it.
 */
function summarise(events: readonly Event[]) {
  const kills: Kill[] = [];
  const destroys: Destroy[] = [];
  const trims: Trim[] = [];
  const origins = new Map<number, Cell>();
  const colliders = new Map<number, string>();
  const protoOnGrid = new Map<number, number>();
  for (const e of events) {
    if (e.kind === "wouldCollide" && e.pos !== null && e.proto !== undefined) {
      protoOnGrid.set(
        e.proto,
        (protoOnGrid.get(e.proto) ?? 0) + (onCellGrid(cellOf(e.pos)) ? 1 : 0),
      );
    }
  }
  const vulcanusProto = [...protoOnGrid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const e of events) {
    if (e.pos === null) throw new Error(`${e.kind} event with no position`);
    const [x, y] = cellOf(e.pos);
    const prototype = onCellGrid([x, y]) ? "cliff-vulcanus" : "crater-cliff";
    const orientation = ORIENTATIONS[e.orientation ?? -1] ?? String(e.orientation);
    switch (e.kind) {
      case "wouldCollide":
        if (e.result === 0) break;
        kills.push({
          prototype: e.proto === vulcanusProto ? "cliff-vulcanus" : "crater-cliff",
          x,
          y,
          orientation,
          by: e.tile !== 0 ? "tile" : kindOf(e.entity ?? "?"),
          aabb: e.tile !== 0 || e.entity_aabb === undefined ? null : tiles(e.entity_aabb),
        });
        break;
      case "destroyEndCollide":
        colliders.set(e.this, kindOf(e.entity ?? "?"));
        break;
      case "forceDestroy": {
        const depth = depthOf(e.stack);
        const root = rootOf(e.stack);
        if (depth === 0) {
          origins.set(e.tid, [x, y]);
          destroys.push({ prototype, x, y, orientation, root, via: "direct" });
          break;
        }
        const origin = origins.get(e.tid);
        if (origin === undefined) throw new Error(`cascade at ${x},${y} with no origin`);
        const collider = colliders.get(e.this);
        colliders.delete(e.this);
        destroys.push({
          prototype,
          x,
          y,
          orientation,
          root,
          via: collider === undefined ? "trimToNothing" : "trimThenCollide",
          ...(collider === undefined ? {} : { collider }),
          origin,
        });
        break;
      }
      case "trim": {
        const origin = origins.get(e.tid);
        if (origin === undefined) throw new Error(`trim at ${x},${y} with no origin`);
        trims.push({
          x,
          y,
          from: orientation,
          to: ORIENTATIONS[e.to ?? -1] ?? String(e.to),
          root: rootOf(e.stack),
          origin,
        });
        break;
      }
      default:
        break;
    }
  }
  if (colliders.size !== 0) throw new Error(`${String(colliders.size)} self-destroys never landed`);
  return { kills, destroys, trims };
}

async function assertDebugBinary(): Promise<void> {
  const { stdout } = await run(DEBUG_BIN, ["--version"], { timeout: 60_000 });
  const line = stdout.split("\n")[0] ?? "";
  if (!line.includes(`Version: ${EXPECTED_VERSION} `)) {
    throw new Error(`${DEBUG_BIN} reports "${line}", wanted ${EXPECTED_VERSION}`);
  }
  const { stdout: attrs } = await run("xattr", [DEBUG_BIN]);
  if (attrs.includes("com.apple.quarantine")) {
    throw new Error(
      `${DEBUG_BIN} is quarantined; run: xattr -d com.apple.quarantine "${DEBUG_BIN}"`,
    );
  }
}

async function captureTarget(t: Target) {
  const probeDir = await mkdtemp(join(tmpdir(), "destroy-trace-probe-"));
  const workDir = await mkdtemp(join(tmpdir(), "destroy-trace-work-"));
  try {
    const controlPath = join(probeDir, "control.lua");
    await writeFile(
      controlPath,
      buildCliffControlLua(t.region, {
        dumpFile: "oracle-dump.json",
        planet: "vulcanus",
        seed: SEED,
        alsoResources: true,
        autoplaceControls: t.autoplaceControls,
      }),
    );
    const probePath = join(probeDir, "probe.json");
    await writeFile(
      probePath,
      JSON.stringify({
        mode: "create",
        mod: {
          name: "vulcanus_cliff_destroy_trace_probe",
          version: "0.0.1",
          dependencies: ["base", "space-age"],
          control_lua_file: controlPath,
        },
        seed: SEED,
        timeout_seconds: 600,
      }),
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
    const firstDump = parseCliffDumpFull(await readFile(dumpPath, "utf8"));
    const reported = firstDump.autoplaceControls?.vulcanus_volcanism;
    const wanted = t.autoplaceControls?.vulcanus_volcanism;
    if (wanted !== undefined && reported?.frequency !== wanted.frequency) {
      throw new Error(`${t.label}: surface reports volcanism ${JSON.stringify(reported)}`);
    }

    const eventsPath = join(probeDir, "events.json");
    const commands = [
      `command script import ${join(HERE, "probe.py")}`,
      "script probe.setup(lldb.debugger)",
      `process launch -- --create ${join(workDir, "write", "probe.zip")} --map-gen-settings ${join(workDir, "map-gen-settings.json")} --map-gen-seed ${String(SEED)} --mod-directory ${join(workDir, "mods")} --config ${join(workDir, "config.ini")}`,
      "script probe.assert_hit(lldb.debugger)",
      `script probe.dump(${JSON.stringify(eventsPath)})`,
    ];
    const lldbScript = join(probeDir, "probe.lldb");
    await writeFile(lldbScript, `${commands.join("\n")}\n`);
    const log = await new Promise<string>((resolve, reject) => {
      const child = spawn("lldb", ["-b", "-s", lldbScript, DEBUG_BIN], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("lldb replay timed out after 1800s"));
      }, 1_800_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to start lldb: ${err.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (!out.includes("probe: wrote")) {
          reject(
            new Error(`lldb replay wrote no events (exit ${String(code)}):\n${out.slice(-3000)}`),
          );
        } else {
          resolve(out);
        }
      });
    });
    const replayDump = parseCliffDumpFull(await readFile(dumpPath, "utf8"));
    if (replayDump.cliffs.length !== firstDump.cliffs.length) {
      throw new Error(
        `replay placed ${String(replayDump.cliffs.length)} cliffs, the oracle run ${String(firstDump.cliffs.length)}`,
      );
    }
    const events = JSON.parse(await readFile(eventsPath, "utf8")) as Event[];
    // The offsets in probe.py are one build's. Every cliff-vulcanus sits on
    // the 4-tile cell grid (x = 2 mod 4, y = 2.5 mod 4); crater-cliff does not,
    // so demand only that MOST setup positions do.
    const setups = events.filter((e) => e.kind === "setup" && e.pos !== null);
    const onGrid = setups.filter((e) => {
      const [x, y] = [e.pos![0] / 256, e.pos![1] / 256];
      return ((x % 4) + 4) % 4 === 2 && ((y % 4) + 4) % 4 === 2.5;
    }).length;
    if (onGrid < setups.length * 0.8) {
      throw new Error(`only ${String(onGrid)} of ${String(setups.length)} setups on the cell grid`);
    }
    const hitLine = log.split("\n").find((l) => l.startsWith("probe: hit counts")) ?? "";
    return {
      summary: summarise(events),
      cliffs: replayDump.cliffs.length,
      events: events.length,
      hitLine,
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

const OUT = join(
  HERE,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "oracle-vulcanus-cliff-destroy-trace.seed123456.json",
);

const COMMENT =
  "Ground truth from Factorio 2.0.77 (build 84539, mac-arm64), read out of the running game with lldb " +
  "rather than through Lua: what happened to every cliff the map generator created while making two regions " +
  "on a forced-seed Vulcanus surface - [1500,1500] at the default settings (the region of " +
  "oracle-vulcanus-cliff-entities) and [-2200,-1500] at vulcanus_volcanism frequency 0.5 (the region of " +
  "oracle-vulcanus-cliff-volcanism-ore). 2.0.77 places the same cliffs as 2.1.17 in both, cell for cell " +
  "and orientation for orientation, with the same 1215 resource entities in the second. Per case: `kills`, every " +
  "Surface::wouldCollide call that said collide, with `by` = `tile` or the class of the entity its entity half " +
  "hit (Segment/SegmentedUnit = a demolisher's body, SimpleEntity = a rock, Cliff = a crater-cliff) and that " +
  "entity's AABB in tiles; `destroys`, every cliff Entity::forceDestroy ended, with the orientation it stood " +
  "with, the `root` frame that started its chain (applyCliffs = the wouldCollide kill; postSetup = " +
  "ResourceEntity::postSetup, the ore rule; destroyCliffsTrigger = DestroyCliffsTriggerEffectItem, run by a " +
  "demolisher's Segment::update from Surface::onChunkGenerated), `via` (direct; trimToNothing = a neighbour's " +
  "destroy trimmed its last end away; trimThenCollide = Cliff::destroyEnd trimmed it and its smaller box hit " +
  "`collider`, so it destroyed ITSELF) and the chain's first cliff as `origin`; `trims`, every " +
  "Cliff::destroyEnd shrink with its root and origin. Positions are cell centres in tiles. Captured by " +
  "scripts/probes/vulcanus-cliff-destroy-trace (#84). Graded by crates/fmw-noise/src/fixtures.rs.";

async function main(): Promise<void> {
  await assertDebugBinary();
  const cases = [];
  for (const t of TARGETS) {
    const started = Date.now();
    const got = await captureTarget(t);
    console.log(
      `  ${t.label}: ${String(got.events)} events, ${String(got.cliffs)} cliffs, ` +
        `${String(Math.round((Date.now() - started) / 1000))}s; ${got.hitLine}`,
    );
    cases.push({ label: t.label, region: t.region, cliffs: got.cliffs, ...got.summary });
  }
  // One line per event, pretty at the top - the wouldCollide fixture's shape.
  const lines = [
    "{",
    `  "_comment": ${JSON.stringify(COMMENT)},`,
    `  "_factorioVersion": ${JSON.stringify(EXPECTED_VERSION)},`,
    `  "seed": ${String(SEED)},`,
    '  "cases": [',
  ];
  cases.forEach((c, ci) => {
    lines.push(
      "    {",
      `      "label": ${JSON.stringify(c.label)},`,
      `      "region": ${JSON.stringify(c.region)},`,
      `      "cliffs": ${String(c.cliffs)},`,
    );
    const lists = [
      ["kills", c.kills],
      ["destroys", c.destroys],
      ["trims", c.trims],
    ] as const;
    lists.forEach(([name, list], li) => {
      lines.push(`      "${name}": [`);
      list.forEach((item, i) =>
        lines.push(`        ${JSON.stringify(item)}${i + 1 < list.length ? "," : ""}`),
      );
      lines.push(`      ]${li + 1 < lists.length ? "," : ""}`);
    });
    lines.push(`    }${ci + 1 < cases.length ? "," : ""}`);
  });
  lines.push("  ]", "}");
  await writeFile(OUT, `${lines.join("\n")}\n`);
  console.log(`wrote ${OUT}`);
}

await main();
