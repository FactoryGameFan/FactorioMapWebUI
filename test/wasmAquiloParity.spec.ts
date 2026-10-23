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

import {
  type AquiloRenderRequest,
  type AquiloResourceControls,
  encodeRenderRequest,
} from "../src/noise/wasm/request";

/**
 * Tier 2 of the Rust port's gate for Aquilo: the WASM build's raw f64 bits,
 * folded order-sensitively, one named field at a time, against values frozen
 * from the WASM run.
 *
 * It follows `wasmVulcanusParity.spec.ts`. **It detects divergence; it does not
 * establish correctness** - tier 1 grades the fields against the game. What
 * this adds is the native half: `crates/fmw-wasm/src/native_parity.rs`
 * recomputes the same folds natively and checks them against the same frozen
 * rows, so native == frozen and WASM == frozen together give native == WASM.
 * That is the check that sees a libm call differing between the two hosts.
 *
 * ## Why the frozen values come from WASM
 *
 * They were written by the first run of this spec with `FMW_FREEZE_TIER2=1`,
 * from the module, and the native test then matched them on its own. Native
 * output was never copied into the table.
 *
 * ## The window
 *
 * A 26x26 window at 7.3 tiles per pixel from (-613.5, 428.25), Fulgora's own
 * window. Its positions are not whole tiles, so every sample takes the point
 * path, as a zoomed-out render does.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  aquilo_field_count: () => number;
  checksum_aquilo: (requestLen: number, field: number) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/** A WASM `u64` arrives in JavaScript as a SIGNED BigInt. See wasmEngine.spec.ts. */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

/** `surfaceSeedForPlanet("aquilo", 123456)` - the derived seed previews render at. */
const SEED0 = 3111923328;

/** The nine tiles in `TILE_ORDER`, the planet's `autoplace_settings.tile` order. */
const TILE_NAMES = [
  "snow-flat",
  "snow-crests",
  "snow-lumpy",
  "snow-patchy",
  "ice-rough",
  "ice-smooth",
  "brash-ice",
  "ammoniacal-ocean",
  "ammoniacal-ocean-2",
];

/**
 * Every field `AquiloParity::field` selects, in its order: the eleven
 * `AquiloResourceFields`, the eight `AquiloTerrainFields`, then the nine tile
 * scores. **One name per line, bare and quoted**: `native_parity.rs` scans
 * this block at compile time, so the mapping from index to frozen row cannot
 * drift from the one this spec uses. The tile rows are spelled out for the
 * same reason - the scan takes literal lines only.
 */
// prettier-ignore
const FIELD_NAMES = [
  "startingCrudeOil",
  "startingLithiumBrine",
  "startingFluorineVent",
  "startingFluorineVentTiny",
  "startingMask",
  "crudeOilSpots",
  "lithiumBrineSpots",
  "fluorineVentSpots",
  "crudeOilProbability",
  "lithiumBrineProbability",
  "fluorineVentProbability",
  "wobbleX",
  "wobbleY",
  "aux",
  "islandPeaks",
  "elevation",
  "highFrequencyPeaks",
  "snowIce",
  "tileVariant",
  "tile:snow-flat",
  "tile:snow-crests",
  "tile:snow-lumpy",
  "tile:snow-patchy",
  "tile:ice-rough",
  "tile:ice-smooth",
  "tile:brash-ice",
  "tile:ammoniacal-ocean",
  "tile:ammoniacal-ocean-2",
];

interface Sliders {
  readonly label: string;
  readonly controls: AquiloResourceControls;
}

/**
 * The second case is the `moved` case of
 * `test/fixtures/oracle-aquilo-entity-fields.seed123456.json`, with its
 * read-back values (the game stores the fluorine size as an f32). Every lever
 * differs from every other, so a swapped pair shows.
 */
const SLIDERS: readonly Sliders[] = [
  { label: "default sliders", controls: {} },
  {
    label: "moved sliders",
    controls: {
      crudeOil: { frequency: 1.5, size: 0.5 },
      lithiumBrine: { frequency: 0.5, size: 2 },
      fluorineVent: { frequency: 2, size: 0.1666666716337204 },
    },
  },
];

const WINDOW = { originX: -613.5, originY: 428.25, tilesPerPixel: 7.3, size: 26 } as const;

function request(s: Sliders): AquiloRenderRequest {
  return {
    planet: "aquilo",
    view: "terrain",
    seed0: SEED0,
    width: WINDOW.size,
    height: WINDOW.size,
    originX: WINDOW.originX,
    originY: WINDOW.originY,
    tilesPerPixel: WINDOW.tilesPerPixel,
    aquiloResourceControls: s.controls,
  };
}

/** Write `req` into the module's scratch buffer and return the bytes written. */
function writeRequest(engine: EngineExports, req: AquiloRenderRequest): number {
  const buffer = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
  return encodeRenderRequest(buffer, req);
}

const PLANET = "aquilo";

afterAll(flushRecording);

expectRecordedRows(PLANET, FIELD_NAMES.length * SLIDERS.length);

describe("the Aquilo field graph folds to its frozen checksums", () => {
  it("covers every field the module exposes, so a new one cannot go untested", async () => {
    const engine = await instantiate();
    expect(FIELD_NAMES).toHaveLength(engine.aquilo_field_count());
  });

  it("names the nine tiles in the catalog's order", () => {
    expect(FIELD_NAMES.slice(-TILE_NAMES.length)).toEqual(TILE_NAMES.map((n) => `tile:${n}`));
  });

  it("folds 676 points to the frozen checksum for every field, at two slider settings", async () => {
    const engine = await instantiate();
    let compared = 0;
    for (const s of SLIDERS) {
      const len = writeRequest(engine, request(s));
      for (const [field, name] of FIELD_NAMES.entries()) {
        const wasm = u64(engine.checksum_aquilo(len, field));
        if (RECORDING) {
          record(PLANET, s.label, name, wasm);
          compared++;
          continue;
        }
        const want = frozen(PLANET, s.label, name);
        expect(want, `no frozen checksum for ${name} (${s.label})`).toBeDefined();
        expect(wasm, `wasm ${name} (${s.label})`).toBe(want);
        compared++;
      }
    }
    expect(compared).toBe(FIELD_NAMES.length * SLIDERS.length);
    if (!RECORDING) expect(frozenCount(PLANET)).toBe(FIELD_NAMES.length * SLIDERS.length);
  }, 300000);

  it("a request the module cannot decode folds 0, rather than trapping", async () => {
    // A trap would poison the instance for every later call, so a rejected
    // request returns 0. It also protects the fold above: a bad request that
    // folded something plausible would compare equal to itself everywhere.
    const engine = await instantiate();
    const len = writeRequest(engine, request(SLIDERS[0] as Sliders));

    // A real request first, so the two arms differ by the corruption alone.
    expect(u64(engine.checksum_aquilo(len, 0))).not.toBe(0n);

    const buffer = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
    const magic = buffer[0] as number;
    buffer[0] = magic ^ 0xff;
    expect(u64(engine.checksum_aquilo(len, 0)), "bad magic").toBe(0n);
    buffer[0] = magic;

    // And a Fulgora request, which decodes fine but is the wrong planet.
    const fulgoraLen = encodeRenderRequest(buffer, {
      planet: "fulgora",
      view: "landmask",
      seed0: 2967702466,
      width: 4,
      height: 4,
      originX: 0,
      originY: 0,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });
    expect(u64(engine.checksum_aquilo(fulgoraLen, 0)), "wrong planet").toBe(0n);
  });

  it("the second slider setting really is a different chain, so running both says something", async () => {
    // Anti-vacuity. At default sliders every lever is neutral, so a one-setting
    // spec would not exercise a lever. Frozen at the measured count rather
    // than left as a floor: if it moves, read it - do not widen it.
    const engine = await instantiate();
    const foldsAt = (s: Sliders): bigint[] => {
      const len = writeRequest(engine, request(s));
      return FIELD_NAMES.map((_, field) => u64(engine.checksum_aquilo(len, field)));
    };
    const a = foldsAt(SLIDERS[0] as Sliders);
    const b = foldsAt(SLIDERS[1] as Sliders);
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (a[i] !== b[i]) differing++;
    }
    // 11 of 28, measured. The window is mostly ocean away from every well, so
    // the other spot and probability fields sit at their basement value in
    // both settings and the terrain fields do not read a lever. The 11 are the
    // four starting-spot fields plus the lithium spot and probability fields,
    // `islandPeaks` and the terrain fields that read it.
    expect(differing).toBe(11);
  }, 300000);
});
