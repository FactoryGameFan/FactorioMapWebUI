import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  expectRecordedRows,
  flushRecording,
  frozen,
  frozenCount,
  RECORDING,
  record,
} from "./tier2Frozen";

import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import {
  type FulgoraTile,
  makeFulgoraLandProbabilities,
  makeFulgoraOceanTestFrom,
  makeFulgoraStack,
  makeFulgoraTileResolverFrom,
} from "../src/noise/tiles/fulgoraCatalog";

/**
 * Tier 2 of the Rust port's gate for Fulgora's landmask chain (#223): strict
 * bit equality between the two ports over a swept grid, folded
 * order-sensitively, one named field at a time.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong - and here they demonstrably ARE both wrong in
 * the same places, which is the point of tier 1 grading each against the game
 * separately. #273 records the largest of those gaps.
 *
 * ## The trig crosses the boundary as a value
 *
 * `startingSpotAtAngle` is plain f64 arithmetic with no narrowing anywhere, so
 * a one-ULP `sin` difference between V8 and the libm `wasm32-unknown-unknown`
 * links would land straight in the result. #270 measured that those two libms
 * really do disagree - on 1 of 600 slider positions, in a place `cargo test` on
 * the host could not see.
 *
 * Every call site's angle is a per-render constant, so this spec computes both
 * bearings' sine and cosine in V8 and hands them to the module. That makes the
 * question moot rather than bounded. **If a future change computes the trig
 * inside the module instead, this spec is what should go red.**
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  fulgora_field_count: () => number;
  checksum_fulgora: (
    seed0: number,
    islandsFrequency: number,
    islandsSize: number,
    sinStart: number,
    cosStart: number,
    sinVault: number,
    cosVault: number,
    field: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/** A WASM `u64` arrives in JavaScript as a SIGNED BigInt. See wasmEngine.spec.ts. */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const scratch = new DataView(new ArrayBuffer(8));
function foldF64(acc: bigint, value: number): bigint {
  let hash = acc === 0n ? FNV_OFFSET_BASIS : acc;
  scratch.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) {
    hash ^= BigInt(scratch.getUint8(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

function foldAll(values: readonly number[]): bigint {
  let acc = 0n;
  for (const v of values) acc = foldF64(acc, v);
  return acc;
}

/**
 * The field order the Rust `checksum_fulgora` selector uses, as accessor names.
 *
 * The module exports `fulgora_field_count()` and this list is asserted against
 * it, so a field added to the chain on the Rust side cannot silently go
 * untested - the count moves and the assertion names the gap. That is the same
 * trick the ABI uses for the control catalog.
 */
const SEED0 = 2967702466; // surfaceSeedForPlanet("fulgora", 123456)

// Off any lattice, and a step that is not a binary fraction, so the sweep
// crosses many Voronoi cells and few samples land on a cell centre.
const X0 = -613.5;
const Y0 = 428.25;
const STEP = 7.3;
const N = 26;

interface Case {
  readonly label: string;
  readonly islandsFrequency: number;
  readonly islandsSize: number;
}

// The default preset, plus one that moves BOTH sliders - which is what makes
// `grid` fractional and `sliderRescale` something other than exactly 1. At the
// defaults those two are 175 and 1, so a case list of one would not exercise
// either.
const CASES: readonly Case[] = [
  { label: "default sliders", islandsFrequency: 1, islandsSize: 1 },
  { label: "frequency 2, size 3", islandsFrequency: 2, islandsSize: 3 },
];

function tsFields(c: Case): number[][] {
  const ctx = {
    seed0: SEED0,
    islandsFrequency: c.islandsFrequency,
    islandsSize: c.islandsSize,
  };
  // ONE stack, so the ocean test reads the same field objects - and therefore
  // the same memo caches - the individual accessors below read. Building a
  // second set would be correct and would evaluate the whole chain twice.
  const stack = makeFulgoraStack(ctx);
  const { shared, cells, chain: elevation, masks, roads, ruins } = stack;
  const ocean = makeFulgoraOceanTestFrom(stack);
  const scrap = makeFulgoraScrap(stack);
  const resolve = makeFulgoraTileResolverFrom(stack);
  const landProbabilities = makeFulgoraLandProbabilities(ctx);
  const TILE_CODE: Record<string, number> = {
    "fulgoran-dust": 0,
    "fulgoran-dunes": 1,
    "fulgoran-sand": 2,
    "fulgoran-rock": 3,
    "fulgoran-paving": 4,
    "fulgoran-walls": 5,
    "fulgoran-conduit": 6,
    "fulgoran-machinery": 7,
    shallow: 8,
    deep: 9,
  };

  const accessors: ((x: number, y: number) => number)[] = [
    shared.wobbleInfluence,
    shared.wobbleMask,
    shared.wobbleX,
    shared.wobbleY,
    shared.ox,
    shared.oy,
    shared.wx,
    shared.wy,
    shared.startingCone,
    shared.startingVaultCone,
    shared.startingMask,
    shared.startingVaultMask,
    cells.cells,
    cells.pyramids,
    cells.spots,
    cells.spotsInv,
    cells.blanks,
    cells.mesa,
    cells.sprawl,
    cells.vaults,
    cells.vaultsAndStartingVault,
    elevation.basis,
    elevation.basisOil,
    elevation.rock,
    elevation.dunes,
    elevation.scrapMedium,
    elevation.natural,
    elevation.sprawlPyramids,
    elevation.vaultPyramids,
    elevation.vaultPyramidsAndStart,
    elevation.moats,
    elevation.mixPyramids,
    elevation.mixNatural,
    elevation.mixMoats,
    elevation.vaultSpots,
    elevation.mixSpots,
    elevation.oilMask,
    elevation.mixOil,
    elevation.sandBasins,
    elevation.preElevation,
    elevation.elevation,
    (x, y): number => {
      const wet = ocean(x, y);
      return wet === undefined ? 0 : wet === "shallow" ? 1 : 2;
    },
    masks.naturalMask,
    masks.naturalAndMesaMask,
    masks.artificialMask,
    roads.roadCells,
    roads.roadPyramids,
    roads.pyramidsBanding,
    roads.spotsPrebanding,
    roads.spotsBanding,
    roads.structureCells,
    roads.structureSubnoise,
    roads.structureFacets,
    roads.roadPavingThin,
    roads.roadPaving2,
    roads.roadPaving2b,
    roads.roadPaving2c,
    roads.roadDust,
    ruins.ruinsWalls,
    ruins.ruinsPaving,
    ruins.tileRuinPaving,
    ruins.tileRuinWalls,
    ruins.tileRuinConduit,
    ruins.tileRuinMachinery,
    scrap.probability,
    scrap.structTerm,
    scrap.vaultTerm,
    ...Array.from(
      { length: 8 },
      (_, k) =>
        (x: number, y: number): number =>
          landProbabilities(x, y)[k] as number,
    ),
    (x, y): number => TILE_CODE[resolve(x, y) as FulgoraTile] as number,
  ];

  const out: number[][] = accessors.map(() => []);
  for (let j = 0; j < N; j++) {
    const y = Y0 + j * STEP;
    for (let i = 0; i < N; i++) {
      const x = X0 + i * STEP;
      for (const [f, read] of accessors.entries()) (out[f] as number[]).push(read(x, y));
    }
  }
  return out;
}

/** The two bearings, computed in V8 and handed to the module. */
function trig(): [number, number, number, number] {
  const angle = SEED0 / 360;
  const a = (angle / 180) * Math.PI;
  const b = ((angle + 180) / 180) * Math.PI;
  return [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b)];
}

const FIELD_NAMES = [
  "wobbleInfluence",
  "wobbleMask",
  "wobbleX",
  "wobbleY",
  "ox",
  "oy",
  "wx",
  "wy",
  "startingCone",
  "startingVaultCone",
  "startingMask",
  "startingVaultMask",
  "cells",
  "pyramids",
  "spots",
  "spotsInv",
  "blanks",
  "mesa",
  "sprawl",
  "vaults",
  "vaultsAndStartingVault",
  "basis",
  "basisOil",
  "rock",
  "dunes",
  "scrapMedium",
  "natural",
  "sprawlPyramids",
  "vaultPyramids",
  "vaultPyramidsAndStart",
  "moats",
  "mixPyramids",
  "mixNatural",
  "mixMoats",
  "vaultSpots",
  "mixSpots",
  "oilMask",
  "mixOil",
  "sandBasins",
  "preElevation",
  "elevation",
  "oceanTile",
  "naturalMask",
  "naturalAndMesaMask",
  "artificialMask",
  "roadCells",
  "roadPyramids",
  "pyramidsBanding",
  "spotsPrebanding",
  "spotsBanding",
  "structureCells",
  "structureSubnoise",
  "structureFacets",
  "roadPavingThin",
  "roadPaving2",
  "roadPaving2b",
  "roadPaving2c",
  "roadDust",
  "ruinsWalls",
  "ruinsPaving",
  "tileRuinPaving",
  "tileRuinWalls",
  "tileRuinConduit",
  "tileRuinMachinery",
  "scrapProbability",
  "scrapStructTerm",
  "scrapVaultTerm",
  "landDust",
  "landDunes",
  "landSand",
  "landRock",
  "landPaving",
  "landWalls",
  "landConduit",
  "landMachinery",
  "resolvedTile",
];

const PLANET = "fulgora";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once at module scope so a partial
 * record run cannot pass its own count check. See `expectRecordedRows` in
 * `tier2Frozen.ts`.
 */
expectRecordedRows(PLANET, FIELD_NAMES.length * CASES.length);

describe("Rust and TypeScript agree bit for bit across Fulgora's landmask chain", () => {
  it("covers every field the module exposes, so a new one cannot go untested", async () => {
    const engine = await instantiate();
    expect(FIELD_NAMES).toHaveLength(engine.fulgora_field_count());
  });

  it("folds 676 grid points identically for all 76 fields, at two slider settings", async () => {
    const engine = await instantiate();
    const [sinStart, cosStart, sinVault, cosVault] = trig();
    let compared = 0;
    for (const c of CASES) {
      const ts = tsFields(c);
      for (const [field, name] of FIELD_NAMES.entries()) {
        const wasm = u64(
          engine.checksum_fulgora(
            SEED0,
            c.islandsFrequency,
            c.islandsSize,
            sinStart,
            cosStart,
            sinVault,
            cosVault,
            field,
            X0,
            Y0,
            STEP,
            N,
          ),
        );
        const tsFold = foldAll(ts[field] as number[]);

        // Recording compares the two arms first, so the table can only ever
        // capture a value both ports already agree on.
        if (RECORDING) {
          expect(wasm, `${name} (${c.label})`).toBe(tsFold);
          record(PLANET, c.label, name, wasm);
          compared++;
          continue;
        }

        // Both arms against the frozen value rather than against each other -
        // see `test/tier2Frozen.ts` for why that outlives #227.
        const want = frozen(PLANET, c.label, name);
        expect(want, `no frozen checksum for ${name} (${c.label})`).toBeDefined();
        expect(wasm, `wasm ${name} (${c.label})`).toBe(want);
        expect(tsFold, `TypeScript ${name} (${c.label})`).toBe(want);
        compared++;
      }
    }
    expect(compared).toBe(FIELD_NAMES.length * CASES.length);

    if (!RECORDING) expect(frozenCount(PLANET)).toBe(FIELD_NAMES.length * CASES.length);
  });

  it("the second slider case really is a different chain, so running both says something", () => {
    // Anti-vacuity. At the default sliders `grid` is exactly 175 and
    // `sliderRescale(1, 2)` is exactly 1, so a one-case spec would not exercise
    // either lever at all.
    const a = tsFields(CASES[0] as Case);
    const b = tsFields(CASES[1] as Case);
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (foldAll(a[i] as number[]) !== foldAll(b[i] as number[])) differing++;
    }
    expect(differing).toBeGreaterThan(30);
  });

  it("the sweep reaches land, shallow and deep, so the ocean fold is not one constant", () => {
    // Anti-vacuity for the last field: a window entirely at sea would fold a
    // column of 2s and agree between the ports while testing nothing.
    const ocean = tsFields(CASES[0] as Case)[FIELD_NAMES.indexOf("oceanTile")] as number[];
    for (const want of [0, 1, 2]) {
      expect(ocean.filter((v) => v === want).length, `class ${want}`).toBeGreaterThan(0);
    }
  });
});
