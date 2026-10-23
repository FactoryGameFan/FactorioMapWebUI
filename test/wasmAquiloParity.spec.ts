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

interface Window {
  readonly label: string;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

/**
 * Four 26x26 windows. The first is Fulgora's and its two cases keep their
 * original, unsuffixed labels. It is mostly ocean away from every well, so
 * eight fields fold a constant there. The other two exist to reach those:
 *
 * - `spawn window` holds the starting wells (the census puts starting crude
 *   oil near (32..60, -20..12), lithium brine near (-46..-25, 68..85) and
 *   fluorine vents near (-94..-40, -141..-67)), so the probabilities, the
 *   island peaks and, with moved sliders, the crude oil and fluorine spots
 *   vary.
 * - `ring window` straddles the starting-mask ramp (distance 300 to 340 from
 *   the origin), and holds random crude oil and lithium brine spots.
 * - `vent window` samples the fluorine vents closely (3 tiles per pixel). A
 *   small fluorine size shrinks the spot radius, and the spawn window's 12-tile
 *   step steps over it, so the fluorine size lever changed no fold there.
 */
const WINDOWS: readonly Window[] = [
  { label: "", originX: -613.5, originY: 428.25, tilesPerPixel: 7.3 },
  { label: "spawn window", originX: -156, originY: -156, tilesPerPixel: 12 },
  { label: "ring window", originX: 100, originY: 100, tilesPerPixel: 16 },
  { label: "vent window", originX: -110, originY: -150, tilesPerPixel: 3 },
];
const SIZE = 26;

const caseLabel = (s: Sliders, w: Window): string =>
  w.label === "" ? s.label : `${s.label}, ${w.label}`;

function request(s: Sliders, w: Window): AquiloRenderRequest {
  return {
    planet: "aquilo",
    view: "terrain",
    seed0: SEED0,
    width: SIZE,
    height: SIZE,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    aquiloResourceControls: s.controls,
  };
}

/** Write `req` into the module's scratch buffer and return the bytes written. */
function writeRequest(engine: EngineExports, req: AquiloRenderRequest): number {
  const buffer = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
  return encodeRenderRequest(buffer, req);
}

const PLANET = "aquilo";
const ROWS = FIELD_NAMES.length * SLIDERS.length * WINDOWS.length;

afterAll(flushRecording);

expectRecordedRows(PLANET, ROWS);

/** All folds of one request, by field index. */
function foldsOf(engine: EngineExports, req: AquiloRenderRequest): bigint[] {
  const len = writeRequest(engine, req);
  return FIELD_NAMES.map((_, field) => u64(engine.checksum_aquilo(len, field)));
}

describe("the Aquilo field graph folds to its frozen checksums", () => {
  it("covers every field the module exposes, so a new one cannot go untested", async () => {
    const engine = await instantiate();
    expect(FIELD_NAMES).toHaveLength(engine.aquilo_field_count());
  });

  it("names the nine tiles in the catalog's order", () => {
    expect(FIELD_NAMES.slice(-TILE_NAMES.length)).toEqual(TILE_NAMES.map((n) => `tile:${n}`));
  });

  it("folds 676 points to the frozen checksum for every field, at two slider settings in four windows", async () => {
    const engine = await instantiate();
    let compared = 0;
    for (const s of SLIDERS) {
      for (const w of WINDOWS) {
        const label = caseLabel(s, w);
        const folds = foldsOf(engine, request(s, w));
        for (const [field, name] of FIELD_NAMES.entries()) {
          const wasm = folds[field] as bigint;
          if (RECORDING) {
            record(PLANET, label, name, wasm);
            compared++;
            continue;
          }
          const want = frozen(PLANET, label, name);
          expect(want, `no frozen checksum for ${name} (${label})`).toBeDefined();
          expect(wasm, `wasm ${name} (${label})`).toBe(want);
          compared++;
        }
      }
    }
    expect(compared).toBe(ROWS);
    if (!RECORDING) expect(frozenCount(PLANET)).toBe(ROWS);
  }, 300000);

  it("a request the module cannot decode folds 0, rather than trapping", async () => {
    // A trap would poison the instance for every later call, so a rejected
    // request returns 0. It also protects the fold above: a bad request that
    // folded something plausible would compare equal to itself everywhere.
    const engine = await instantiate();
    const len = writeRequest(engine, request(SLIDERS[0] as Sliders, WINDOWS[0] as Window));

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

  it("a field index past the end folds 0, with the last real field as the control", async () => {
    const engine = await instantiate();
    const len = writeRequest(engine, request(SLIDERS[0] as Sliders, WINDOWS[0] as Window));
    const count = engine.aquilo_field_count();
    expect(u64(engine.checksum_aquilo(len, count - 1)), "last real field").not.toBe(0n);
    expect(u64(engine.checksum_aquilo(len, count)), "one past the end").toBe(0n);
    expect(u64(engine.checksum_aquilo(len, 0xffffffff)), "far past the end").toBe(0n);
  });

  it("no field folds the same in every case, so none is untested", async () => {
    // The brief window is mostly ocean and eight fields are constant there.
    // Across all eight cases every field must change at least once.
    const engine = await instantiate();
    const seen = FIELD_NAMES.map(() => new Set<bigint>());
    for (const s of SLIDERS) {
      for (const w of WINDOWS) {
        foldsOf(engine, request(s, w)).forEach((f, i) => (seen[i] as Set<bigint>).add(f));
      }
    }
    // A field that is one constant everywhere folds to the same number in
    // every case (the fold ignores the window), so one distinct fold per field
    // means it varies nowhere. The native test checks distinct VALUES directly.
    const sameEverywhere = FIELD_NAMES.filter((_, i) => (seen[i] as Set<bigint>).size === 1);
    expect(sameEverywhere).toEqual([]);
  }, 300000);

  it("each of the six lever values changes at least one fold in some window", async () => {
    // The moved case moves all six at once, which cannot show that EACH lever
    // is read. So move one lever to its moved value alone and compare with the
    // default, over every window and field.
    const engine = await instantiate();
    //
    // A size lever is compared against the same lever with only its frequency
    // moved, not against the default. A size changes a random spot's radius,
    // and the default layout puts no random fluorine spot in any window here
    // (its spot field is one value everywhere), so against the default a
    // fluorine size change has nothing to resize. Moving the frequency first
    // relocates the spots into the windows.
    const m = SLIDERS[1]?.controls as Required<AquiloResourceControls>;
    const f = (lever: "crudeOil" | "lithiumBrine" | "fluorineVent") => ({
      frequency: m[lever].frequency,
      size: m[lever].size,
    });
    const levers: [string, AquiloResourceControls, AquiloResourceControls][] = [
      ["crude oil frequency", {}, { crudeOil: { frequency: f("crudeOil").frequency } }],
      ["lithium brine frequency", {}, { lithiumBrine: { frequency: f("lithiumBrine").frequency } }],
      ["fluorine vent frequency", {}, { fluorineVent: { frequency: f("fluorineVent").frequency } }],
      ...(["crudeOil", "lithiumBrine", "fluorineVent"] as const).map(
        (k): [string, AquiloResourceControls, AquiloResourceControls] => [
          `${k} size`,
          { [k]: { frequency: f(k).frequency } },
          { [k]: { frequency: f(k).frequency, size: f(k).size } },
        ],
      ),
    ];
    for (const [name, baseControls, movedControls] of levers) {
      let changed = 0;
      for (const w of WINDOWS) {
        const base = foldsOf(engine, request({ label: "base", controls: baseControls }, w));
        const one = foldsOf(engine, request({ label: name, controls: movedControls }, w));
        changed += base.filter((fold, i) => fold !== one[i]).length;
      }
      expect(changed, `${name} changes no fold in any window`).toBeGreaterThan(0);
    }
  }, 300000);

  it("the second slider setting really is a different chain, so running both says something", async () => {
    // Anti-vacuity, frozen at the measured count rather than left as a floor:
    // if it moves, read it - do not widen it. Counted on the first window.
    const engine = await instantiate();
    const w = WINDOWS[0] as Window;
    const a = foldsOf(engine, request(SLIDERS[0] as Sliders, w));
    const b = foldsOf(engine, request(SLIDERS[1] as Sliders, w));
    let differing = 0;
    for (const [i] of FIELD_NAMES.entries()) {
      if (a[i] !== b[i]) differing++;
    }
    // 11 of 28, measured, and the count does not change with the added
    // windows (it reads the first only). Named, because a count alone would
    // pass if a different eleven moved. The window is mostly ocean away from
    // every well, so lithium brine is the only lever that reaches it: its spot
    // and probability fields, `islandPeaks` (which reads the spots),
    // `elevation`, and the seven tile scores that read elevation. The three
    // starting-spot fields do NOT differ, and neither do the crude oil and
    // fluorine vent spot fields, which sit at one value in both settings.
    expect(FIELD_NAMES.filter((_, i) => a[i] !== b[i])).toEqual([
      "lithiumBrineSpots",
      "lithiumBrineProbability",
      "islandPeaks",
      "elevation",
      "tile:snow-flat",
      "tile:snow-crests",
      "tile:snow-lumpy",
      "tile:snow-patchy",
      "tile:ice-rough",
      "tile:ice-smooth",
      "tile:brash-ice",
    ]);
    expect(differing).toBe(11);
  }, 300000);
});
