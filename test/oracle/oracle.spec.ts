import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { basisNoise, basisNoiseTablesFromSeed } from "../../src/noise/basisNoise";
import basisFixture from "../fixtures/oracle-basis.seed123456.json";
import {
  buildControlLua,
  buildDataLua,
  buildFactorioArgs,
  buildMapGenSettings,
  buildVoronoiExpression,
  DUMP_FILE,
  oracleAvailable,
  parseDump,
  parseTileDump,
  PROBE_NAME,
  type Position,
  sampleExpression,
  sampleTileNames,
  type SpawnResult,
  wslPathForGame,
} from "./oracle";
import tileNamesFixture from "../fixtures/oracle-tile-names.seed123456.json";
import tileNamesFixture654321 from "../fixtures/oracle-tile-names.seed654321.json";
import tileNamesFixture424242 from "../fixtures/oracle-tile-names.seed424242.json";

describe("oracle harness - pure builders", () => {
  it("buildDataLua registers the probe as a noise-expression, embedding the expression verbatim", () => {
    // Expression carries the exact metacharacters real trees use: braces, quotes,
    // var('...'). A naive quoted Lua string would break; a long bracket must not.
    const expr = "clamp(0.5 + var('control:aux:bias') + basis_noise{x = x, y = y}, 0, 1)";
    const lua = buildDataLua(expr);
    expect(lua).toContain('type = "noise-expression"');
    expect(lua).toContain(`name = "${PROBE_NAME}"`);
    expect(lua).toContain(expr);
  });

  it("buildControlLua dumps the routed property and exits with the DUMPED-OK sentinel", () => {
    const lua = buildControlLua([
      { x: 0.5, y: 0.5 },
      { x: -3.5, y: 7.125 },
    ]);
    // property_names come FIRST in calculate_tile_properties (the HTML docs are wrong).
    expect(lua).toContain('calculate_tile_properties({"elevation"}');
    expect(lua).toContain("x = 0.5");
    expect(lua).toContain("y = 7.125");
    expect(lua).toContain(DUMP_FILE);
    expect(lua).toContain("DUMPED-OK");
  });

  it("buildMapGenSettings routes the probe onto the target property and carries the seed", () => {
    const mgs = buildMapGenSettings({ seed: 987654, property: "elevation" }) as {
      seed: number;
      property_expression_names: Record<string, string>;
    };
    expect(mgs.seed).toBe(987654);
    expect(mgs.property_expression_names.elevation).toBe(PROBE_NAME);
  });

  it("buildFactorioArgs assembles the headless create CLI in order", () => {
    const args = buildFactorioArgs({
      savePath: "/w/probe.zip",
      mapGenPath: "/w/mgs.json",
      seed: 123456,
      modDir: "/w/mods",
      configPath: "/w/config.ini",
    });
    expect(args).toEqual([
      "--create",
      "/w/probe.zip",
      "--map-gen-settings",
      "/w/mgs.json",
      "--map-gen-seed",
      "123456",
      "--mod-directory",
      "/w/mods",
      "--config",
      "/w/config.ini",
    ]);
  });

  it("parseDump returns positions paired with their values", () => {
    const json = JSON.stringify({
      values: [0.1, -0.2],
      positions: [
        { x: 0.5, y: 0.5 },
        { x: 1.5, y: 2.5 },
      ],
    });
    const parsed = parseDump(json);
    expect(parsed.values).toEqual([0.1, -0.2]);
    expect(parsed.positions).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 2.5 },
    ]);
  });
});

describe("oracle harness - sampleExpression wiring", () => {
  it("writes the mod tree, invokes factorio, and returns the parsed values", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-wire-"));
    try {
      // Fake factorio: assert the args are what we built, then write the dump the
      // real game would have written, so we exercise the full read-back path.
      const fakeSpawn = (_bin: string, args: readonly string[]) => ({
        async done(): Promise<SpawnResult> {
          const savePath = args[args.indexOf("--create") + 1];
          const writeDir = join(savePath, "..");
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(join(writeDir, "script-output"), { recursive: true });
          await writeFile(
            join(writeDir, "script-output", DUMP_FILE),
            JSON.stringify({
              values: [11, 22],
              positions: [
                { x: 0.5, y: 0.5 },
                { x: 1.5, y: 2.5 },
              ],
            }),
          );
          return { code: 1, stderr: "control.lua:13: DUMPED-OK" };
        },
      });

      const values = await sampleExpression(
        "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 0, input_scale = 0.125}",
        [
          { x: 0.5, y: 0.5 },
          { x: 1.5, y: 2.5 },
        ],
        { workDir, factorioBin: "/fake/factorio", dataDir: "/fake/data", spawnFn: fakeSpawn },
      );

      expect(values).toEqual([11, 22]);
      // The mod files must actually be on disk for the real game to load them.
      const dataLua = await readFile(
        join(workDir, "mods", `${PROBE_NAME}_0.0.1`, "data.lua"),
        "utf8",
      );
      expect(dataLua).toContain("input_scale = 0.125");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("pathForGame translates the argument vector AND config.ini, not just argv", async () => {
    // The bug this exists to catch is specific and was hit for real: translating
    // only the argument vector produces a run that STARTS and then cannot write
    // its dump, because `write-data` lives inside config.ini. Factorio reports
    // that as `weakly_canonical: Access is denied`, which reads like a
    // permissions problem rather than a path-translation one.
    const workDir = await mkdtemp(join(tmpdir(), "oracle-xlate-"));
    try {
      // A stand-in for `wslpath -w`: unambiguous, reversible, and it leaves
      // anything that is not an absolute POSIX path alone, exactly as the real
      // translator does for the `__PATH__executable__` token.
      const toGame = (p: string): string => (p.startsWith("/") ? `X:${p}` : p);

      let seenArgs: readonly string[] = [];
      const fakeSpawn = (_bin: string, args: readonly string[]) => ({
        async done(): Promise<SpawnResult> {
          seenArgs = args;
          // Write the dump where the UNtranslated path says, because that is
          // where this process can actually see it - which is the whole point
          // of the two views being different.
          const { mkdir, writeFile } = await import("node:fs/promises");
          const writeDir = join(workDir, "write");
          await mkdir(join(writeDir, "script-output"), { recursive: true });
          await writeFile(
            join(writeDir, "script-output", DUMP_FILE),
            JSON.stringify({ values: [7], positions: [{ x: 0.5, y: 0.5 }] }),
          );
          return { code: 1, stderr: "control.lua:13: DUMPED-OK" };
        },
      });

      const values = await sampleExpression(
        "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 0, input_scale = 0.125}",
        [{ x: 0.5, y: 0.5 }],
        {
          workDir,
          factorioBin: "/fake/factorio",
          dataDir: "/fake/data",
          spawnFn: fakeSpawn,
          pathForGame: toGame,
        },
      );
      expect(values).toEqual([7]);

      // Every path in argv is in the GAME's view.
      for (const flag of ["--create", "--map-gen-settings", "--mod-directory", "--config"]) {
        const value = seenArgs[seenArgs.indexOf(flag) + 1];
        expect(value.startsWith("X:")).toBe(true);
      }
      // The seed is not a path and must survive untouched.
      expect(seenArgs[seenArgs.indexOf("--map-gen-seed") + 1]).toBe("123456");

      // And the half that argv-only translation would miss: config.ini.
      const configPath = join(workDir, "config.ini");
      const config = await readFile(configPath, "utf8");
      expect(config).toContain(`write-data=X:${join(workDir, "write")}`);
      expect(config).toContain("read-data=X:/fake/data");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("pathForGame defaults to the identity, so nothing changes off WSL", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-identity-"));
    try {
      let seenArgs: readonly string[] = [];
      const fakeSpawn = (_bin: string, args: readonly string[]) => ({
        async done(): Promise<SpawnResult> {
          seenArgs = args;
          const { mkdir, writeFile } = await import("node:fs/promises");
          const writeDir = join(workDir, "write");
          await mkdir(join(writeDir, "script-output"), { recursive: true });
          await writeFile(
            join(writeDir, "script-output", DUMP_FILE),
            JSON.stringify({ values: [7], positions: [{ x: 0.5, y: 0.5 }] }),
          );
          return { code: 1, stderr: "control.lua:13: DUMPED-OK" };
        },
      });

      await sampleExpression(
        "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 0, input_scale = 0.125}",
        [{ x: 0.5, y: 0.5 }],
        { workDir, factorioBin: "/fake/factorio", dataDir: "/fake/data", spawnFn: fakeSpawn },
      );

      expect(seenArgs[seenArgs.indexOf("--create") + 1]).toBe(join(workDir, "write", "probe.zip"));
      const config = await readFile(join(workDir, "config.ini"), "utf8");
      expect(config).toContain(`write-data=${join(workDir, "write")}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("wslPathForGame leaves anything that is not an absolute POSIX path alone", () => {
    // No `wslpath` is invoked for these, so the assertion holds on any platform.
    expect(wslPathForGame("__PATH__executable__/../data")).toBe("__PATH__executable__/../data");
    expect(wslPathForGame("V:\\factorio-2.1.14\\data")).toBe("V:\\factorio-2.1.14\\data");
    expect(wslPathForGame("relative/path")).toBe("relative/path");
  });
});

describe("oracle fixture is genuine ground truth", () => {
  // CI-safe: no Factorio needed. If our pure basisNoise reproduces the committed
  // dump, the harness captured real game values (and basisNoise is still correct).
  it("pure basisNoise reproduces the committed oracle-basis fixture to the noise floor", () => {
    const tables = basisNoiseTablesFromSeed(basisFixture.seed0, basisFixture.seed1);
    let worst = 0;
    let exact = 0;
    for (const p of basisFixture.points) {
      const got = basisNoise(p.x * basisFixture.inputScale, p.y * basisFixture.inputScale, tables);
      worst = Math.max(worst, Math.abs(got - p.v));
      if (Math.fround(got) === p.v) exact++;
    }
    // Measured EXACTLY 0 since 2026-08-18 (#234), when the gradient table
    // stopped being derived from a formula and started being recovered from the
    // game. It was 5.9605e-8 after #214 gave the kernel the game's own
    // arithmetic, and the bound before that was 2e-6 - the game's fastapprox
    // self-consistency floor - which is 33x slack and passed throughout the
    // period the kernel was wrong.
    expect(worst).toBe(0);
    // All 38 exactly, up from 36. The other two were 2 ULP out, and both were
    // the formula table rather than our arithmetic - they went away with the
    // table and the kernel did not change. This is the assertion that
    // discriminates; see test/basisNoise.spec.ts for why a bound alone cannot.
    expect(exact).toBe(38);
  });
});

describe("tile-name oracle (get_tile) - pure parsing", () => {
  it("parseTileDump parses a canned dump into {x, y, name} entries", () => {
    const json = JSON.stringify({
      results: [
        { x: 0, y: 0, name: "grass-1" },
        { x: 45, y: -45, name: "water" },
      ],
    });
    expect(parseTileDump(json)).toEqual([
      { x: 0, y: 0, name: "grass-1" },
      { x: 45, y: -45, name: "water" },
    ]);
  });

  it.each([
    ["seed123456", tileNamesFixture],
    ["seed654321", tileNamesFixture654321],
    ["seed424242", tileNamesFixture424242],
  ])("the committed %s tile-names fixture holds real Nauvis tile names", (_label, fixture) => {
    expect(fixture.tileNames.length).toBe(fixture.positions.length);
    for (const name of fixture.tileNames) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("the combined three-seed fixture set is tile-diverse enough to be a meaningful resolver oracle", () => {
    // A single seed's local terrain is biome-poor by luck (see the Task 2 review
    // finding: the original single-seed fixture was 86% grass-2/red-desert-0).
    // Combined across seeds and a wide spatial extent, a broken resolver that
    // defaults to grass/red-desert should no longer be able to score well.
    const all = [
      ...tileNamesFixture.tileNames,
      ...tileNamesFixture654321.tileNames,
      ...tileNamesFixture424242.tileNames,
    ];
    const distinct = new Set(all);
    // Actual captured diversity is 20 distinct tiles across 153 points (including
    // sand-1/2/3 and deepwater); 12 is a safe floor with headroom for regeneration.
    expect(distinct.size).toBeGreaterThanOrEqual(12);
  });
});

describe("oracle integration (gated on a local Factorio install)", () => {
  // Runs the REAL game (~1.7s). Proves the committed harness still reproduces the
  // committed fixture bit-for-bit - catches drift in the recipe or a game update.
  it.skipIf(!oracleAvailable())(
    "live oracle reproduces the committed fixture exactly",
    async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const workDir = await mkdtemp(join(tmpdir(), "oracle-live-"));
      try {
        const positions: Position[] = basisFixture.points.map((p) => ({ x: p.x, y: p.y }));
        const values = await sampleExpression(basisFixture.expression, positions, {
          workDir,
          seed: basisFixture.seed0,
        });
        expect(values.length).toBe(basisFixture.points.length);
        for (let i = 0; i < values.length; i++) {
          // Same game, same seed, same positions -> identical bytes.
          expect(values[i]).toBe(basisFixture.points[i].v);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // Same real-game smoke test for the get_tile path: a few positions from the
  // committed tile-names fixture, re-sampled live and checked for shape only
  // (chunk generation for a fresh mtime/thread pool is not guaranteed bit-exact
  // like calculate_tile_properties, but the tile the game places at a given seed
  // position is deterministic - see the exact-match assertion below).
  it.skipIf(!oracleAvailable())(
    "live get_tile oracle returns real tile names for a few fixture positions",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "oracle-tile-live-"));
      try {
        const positions: Position[] = tileNamesFixture.positions.slice(0, 3);
        const samples = await sampleTileNames(positions, {
          workDir,
          seed: tileNamesFixture.seed0,
        });
        expect(samples.length).toBe(positions.length);
        for (const s of samples) {
          expect(typeof s.name).toBe("string");
          expect(s.name.length).toBeGreaterThan(0);
        }
        // Same seed, same positions -> the game places the same tiles again.
        expect(samples.map((s) => s.name)).toEqual(tileNamesFixture.tileNames.slice(0, 3));
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("buildVoronoiExpression", () => {
  it("emits a voronoi call with every parameter, distance_type quoted", () => {
    const expr = buildVoronoiExpression({
      op: "voronoi_cell_id",
      x: "x",
      y: "y",
      seed1: "'fulgora_cells'",
      gridSize: 175,
      distanceType: "manhattan",
      jitter: 0.6,
    });
    expect(expr).toContain("voronoi_cell_id{");
    expect(expr).toContain("seed0 = map_seed");
    expect(expr).toContain("seed1 = 'fulgora_cells'");
    expect(expr).toContain("grid_size = 175");
    expect(expr).toContain("distance_type = 'manhattan'");
    expect(expr).toContain("jitter = 0.6");
  });

  it("passes x and y through verbatim so offset inputs can be probed", () => {
    const expr = buildVoronoiExpression({
      op: "voronoi_spot_noise",
      x: "x + 87.5",
      y: "y + 87.5",
      seed1: "1",
      gridSize: 64,
      distanceType: "euclidean",
      jitter: 0,
    });
    expect(expr).toContain("x = x + 87.5");
    expect(expr).toContain("y = y + 87.5");
  });
});
