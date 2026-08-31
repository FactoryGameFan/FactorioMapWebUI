/**
 * The TypeScript half of the WASM render boundary: writing a request.
 *
 * The Rust half is `crates/fmw-wasm/src/abi.rs`, and its module docs carry the
 * layout tables and the reasoning. Keep the two in step; three things make that
 * enforceable rather than a promise:
 *
 * - the module exports `request_bytes()` and `abi_version()`, and
 *   {@link encodeRenderRequest} refuses to write against a module that
 *   disagrees with the constants here;
 * - a committed round-trip fixture (`test/fixtures/wasm-request.v2.json`) pins
 *   the exact bytes of a known request of each planet's shape, so neither side
 *   can move a field without the other going red;
 * - every rejection has its own status code, so a mismatch says which kind.
 *
 * Little-endian throughout, which is the byte order WebAssembly specifies for
 * its own loads - so nothing swaps on any host.
 *
 * ## v2 splits the layout: a common prefix, then a planet block
 *
 * v1 was one fixed 104-byte struct with Fulgora's two island sliders and four
 * trig values baked in. Vulcanus needs 31 more `f64`, and Nauvis will need its
 * own set again, so the reserved word became `params_bytes` and each planet
 * declares its own block. A Fulgora request was 104 bytes until #363 added the
 * two scrap sliders, and is 120 now.
 */

import { f32 } from "../eval/f32";
import { seedNormalized, seedSmall } from "../expressions/vulcanusSeed";

/** `'FMWR'` little-endian. Must equal `fmw_wasm::abi::MAGIC`. */
export const MAGIC = 0x52574d46;

/** Must equal `fmw_wasm::abi::ABI_VERSION`. Bump both together, never one. */
export const ABI_VERSION = 2;

/** Must equal `fmw_wasm::abi::COMMON_BYTES`. */
export const COMMON_BYTES = 56;

/** Must equal `fmw_wasm::abi::FULGORA_PARAMS_BYTES`. */
export const FULGORA_PARAMS_BYTES = 64;

/** Must equal `fmw_wasm::abi::VULCANUS_PARAMS_BYTES`. */
export const VULCANUS_PARAMS_BYTES = 312;

/** Capacity of a Nauvis request's starting-point list. Mirrors
 * `fmw_wasm::abi::NAUVIS_MAX_STARTING_POINTS`. */
export const NAUVIS_MAX_STARTING_POINTS = 8;

/** Must equal `fmw_wasm::abi::NAUVIS_PARAMS_BYTES`: 376 bytes of levers and
 * boxes, then one count plus `NAUVIS_MAX_STARTING_POINTS` `[x, y]` pairs. */
export const NAUVIS_PARAMS_BYTES = 376 + 8 + NAUVIS_MAX_STARTING_POINTS * 16;

/**
 * The LARGEST request either side can produce, which is what `request_bytes()`
 * reports so one scratch buffer serves every planet.
 *
 * Under v1 this was the size of the only request there was. It is now a
 * capacity, and `encodeRenderRequest` returns the bytes it actually wrote.
 *
 * **NAUVIS is the largest now, not Vulcanus.** This was written as
 * `COMMON_BYTES + VULCANUS_PARAMS_BYTES` for three planets, which was correct
 * the whole time and silently wrong the moment the resource overlay took
 * Nauvis's block past it. A `Math.max` cannot go stale that way; the failure it
 * avoids is a scratch buffer too small, which surfaces as a truncated request
 * rather than as a size error.
 */
export const REQUEST_BYTES =
  COMMON_BYTES + Math.max(FULGORA_PARAMS_BYTES, VULCANUS_PARAMS_BYTES, NAUVIS_PARAMS_BYTES);

/** The `planet` codes the module understands. */
export const PLANET = { fulgora: 0, vulcanus: 1, nauvis: 2 } as const;

/**
 * The `view` codes the module understands.
 *
 * Adding a code is NOT a layout change - `view` is a `u32` in the common prefix
 * and has been since v1 - so `rocks`, `resources` and `all` arrived without an
 * ABI bump. What a new code does need is the module's own `supported` match to
 * name it, or the render comes back `unsupported planet or view`.
 */
export const VIEW = {
  landmask: 0,
  terrain: 1,
  scrapFootprint: 2,
  cliffs: 3,
  rocks: 4,
  resources: 5,
  all: 6,
  trees: 7,
  enemies: 8,
  elevationLakes: 9,
  elevationNauvis: 10,
  elevationIsland: 11,
} as const;

/**
 * The status codes `render_request` returns. Mirrors `fmw_wasm::abi::Status`.
 *
 * Named rather than numbered at the call site, because "3" and "4" are exactly
 * the kind of thing that gets mis-read in a log a year later.
 */
export const STATUS: Record<number, string> = {
  0: "ok",
  1: "short buffer",
  2: "bad magic",
  3: "bad ABI version",
  4: "unsupported planet or view",
  5: "output too large",
  6: "params length disagrees with the planet",
};

/** What every request carries, whatever planet it is for. */
interface CommonRenderRequest {
  /** Which render. Defaults to the land mask, the view #223 shipped first. */
  readonly view?: keyof typeof VIEW;
  /** The SURFACE seed, not the map seed. */
  readonly seed0: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

export interface FulgoraRenderRequest extends CommonRenderRequest {
  /** Optional so existing Fulgora call sites need no change. */
  readonly planet?: "fulgora";
  readonly islandsFrequency: number;
  readonly islandsSize: number;
  /**
   * `control:scrap:frequency` and `control:scrap:size`, wire values, neutral
   * at 1.
   *
   * **Optional, for the reason `planet` is**, so the existing Fulgora call
   * sites need no change. `writeFulgoraParams` substitutes the neutral 1.
   *
   * **The module does NOT default these**, which is why the substitution has to
   * happen and why it happens exactly once. `FulgoraParams` reads both straight
   * into `ScrapControls`, so an unwritten field would encode 0 - a real slider
   * setting, and not the neutral one. One encoder-side default is the whole
   * defence, so do not add a second at a call site.
   */
  readonly scrapFrequency?: number;
  readonly scrapSize?: number;
}

/** One resource autoplace control's two sliders. Richness is not read. */
export interface ResourceLevers {
  readonly frequency: number;
  readonly size: number;
}

export interface VulcanusRenderRequest extends CommonRenderRequest {
  readonly planet: "vulcanus";
  readonly volcanismFrequency: number;
  readonly volcanismSize: number;
  readonly temperatureBias: number;
  readonly tungstenOre: ResourceLevers;
  readonly vulcanusCoal: ResourceLevers;
  readonly calcite: ResourceLevers;
  readonly sulfuricAcidGeyser: ResourceLevers;
  /**
   * The world box to enumerate cliff cells over, for the `cliffs` view.
   * Defaults to the request's own pixel box, which is what an untiled render
   * wants.
   *
   * **Computed here rather than in the module**, because the halo is
   * asymmetric, its two directions CROSS, and it needs the FULL image's
   * geometry - which the common prefix does not carry and only the tiled
   * renderer knows. `cliffCellQueryBox` is the one place that arithmetic lives
   * and `test/tiledEquality.spec.ts` is what guards it; the module reads the
   * answer.
   */
  readonly cellQueryBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /**
   * The world box to sweep for placement-roll hits, for the `rocks`,
   * `resources` and `all` views. Defaults to the request's own pixel box.
   *
   * A second box rather than a reuse of `cellQueryBox`, because the two halos
   * are different shapes: the cliff block spans `px - 2 ..= px + 1`, which is
   * asymmetric and whose directions cross, while a placement mark is a 3x3
   * centred on its pixel. Computed by `placementMarkSweepBox`, the same
   * function the TypeScript path passes to the two overlay renderers.
   *
   * The three THRESHOLDED ores ignore it - they paint one pixel each and sweep
   * the request's own box.
   */
  readonly placementSweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export interface NauvisRenderRequest extends CommonRenderRequest {
  readonly planet: "nauvis";
  /**
   * The map's starting points, world tiles. Omitted or empty means the origin.
   *
   * Capped at `NAUVIS_MAX_STARTING_POINTS`; the writer throws above that rather
   * than dropping points, because a silently shortened list moves
   * `distanceFromNearestPoint` and renders a subtly wrong planet. The spawn
   * reaches `elevation_nauvis`'s distance term, `moisture`'s starting-area
   * blend, the starting lakes, the tree distance term and the starting resource
   * patches.
   */
  readonly startingPositions?: readonly { readonly x: number; readonly y: number }[];
  /**
   * `10 * log2(control:water:size)`.
   *
   * **Carried and NOT read by the terrain view**, which is issue #326. The
   * shipped `renderTerrain.ts` resolves every tile at `waterLevel = 0` however
   * the slider is set - `TileResolverParams` has no such field - and tier 3
   * asserts the two ports are byte-identical, so the module ignores it too. It
   * is sent because the `elevation`, `resources` and `cliffs` views already
   * consume it and because fixing #326 should not also need a block growth.
   */
  readonly waterLevel: number;
  /** `control:water:frequency`, RAW - the `1.5 *` happens inside the layer. */
  readonly segmentationMultiplier: number;
  readonly moistureFrequency: number;
  readonly moistureBias: number;
  readonly auxFrequency: number;
  readonly auxBias: number;
  readonly startingAreaMoistureSize: number;
  readonly startingAreaMoistureFrequency: number;
  /**
   * `control:temperature:frequency` / `:bias`.
   *
   * **Read by the tree overlay and by nothing else.** The tile catalog keys on
   * aux and moisture, so the terrain view leaves these at their defaults. The
   * app exposes no slider for either, but `climateReads` parses both out of an
   * imported exchange string's `property_expression_names`, so a preset really
   * can move them - and dropping them would silently render the wrong forest.
   */
  readonly temperatureFrequency: number;
  readonly temperatureBias: number;
  /** `control:trees:frequency` / `:size`. */
  readonly treesFrequency: number;
  readonly treesSize: number;
  /** `control:rocks:frequency` / `:size`. */
  readonly rocksFrequency: number;
  readonly rocksSize: number;
  /**
   * The world box to sweep for placement-roll hits, for the `rocks` view.
   * Defaults to the request's own pixel box.
   *
   * A rock mark is a symmetric 3x3 centred on its pixel, so a rock centred just
   * outside a worker tile still owes that tile pixels. Computed by
   * `placementMarkSweepBox`, the same function the TypeScript path hands to
   * `renderRocks` - the module reads the answer rather than deriving it,
   * because the box is clamped to the FULL image and only the tiled renderer
   * knows that geometry.
   */
  readonly placementSweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /** `control:enemy-base:frequency` / `:size`. */
  readonly enemyFrequency: number;
  readonly enemySize: number;
  /** `control:nauvis_cliff:frequency`, and `:size` which doubles as continuity. */
  readonly cliffFrequency: number;
  readonly cliffContinuity: number;
  /** The cliff-related `MapGenSettings` fields. Richness 0 disables the layer. */
  readonly cliffElevation0: number;
  readonly cliffElevationInterval: number;
  readonly cliffRichness: number;
  /**
   * The world box to enumerate cliff cells over, for the `cliffs` view.
   * Defaults to the request's own pixel box.
   *
   * A SECOND box, and the only one on this planet that is not the placement
   * sweep box. The cliff block spans `px - 2 ..= px + 1` - asymmetric, and its
   * two directions CROSS, so a mark reaching backwards must be caught from
   * ahead of the tile. `cliffCellQueryBox` is the one place that arithmetic
   * lives; the module reads the answer.
   */
  readonly cellQueryBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /**
   * Six resources' `[frequency, size, richness]`, in `RESOURCE_CATALOG` order:
   * iron-ore, copper-ore, coal, stone, crude-oil, uranium-ore.
   *
   * The only per-ENTRY lever block on this planet - every other overlay has one
   * pair for the whole layer. Ordered by the catalog rather than by name, so
   * the writer and the decoder cannot disagree about which triple is which:
   * swapping two produces a plausible planet with its ores exchanged, which no
   * whole-image bound would catch.
   */
  readonly resourceLevers: readonly (readonly [number, number, number])[];
}

export type WasmRenderRequest = FulgoraRenderRequest | VulcanusRenderRequest | NauvisRenderRequest;

/**
 * `f32(f32(a / 180) * f32(PI))`, then f32 `sin`/`cos` - the narrowing lattice
 * `startingSpotAtAngle` needs (#279).
 *
 * `(a / 180) * PI32` is in that order on purpose: `a * (PI32 / 180)` is a
 * different number, because `PI32 / 180` is not exact.
 */
function trigOf(angleDegrees: number): { sin: number; cos: number } {
  const radians = f32(f32(angleDegrees / 180) * f32(Math.PI));
  return { sin: f32(Math.sin(radians)), cos: f32(Math.cos(radians)) };
}

/**
 * Fulgora's two bearings' sine and cosine, computed HERE and sent as values.
 *
 * A one-ULP `sin` difference lands straight in `startingSpotAtAngle`, and #270
 * measured that V8 and the libm `wasm32-unknown-unknown` links really do
 * disagree, in a place `cargo test` on the host cannot see. Every call site's
 * angle is a per-render constant, so lifting the trig out costs nothing and
 * closes the question instead of bounding it.
 *
 * **Every step is narrowed to f32, and this must stay token-for-token identical
 * to `fulgoraShared.ts`** (#279). The Rust side reads `spot.trig.sin` straight
 * into the arithmetic without re-narrowing, so an un-narrowed value sent from
 * here would make the WASM render differ from the TypeScript one - which is
 * precisely what tier 3's byte-identical RGBA comparison exists to catch, and it
 * would be a real divergence rather than a test problem.
 *
 * The bearing is `f32(seed0 / 360)` degrees and the vault sits at
 * `f32(angle + 180)`.
 */
export function bearingTrig(seed0: number): {
  sinStart: number;
  cosStart: number;
  sinVault: number;
  cosVault: number;
} {
  const angle = f32(seed0 / 360);
  const start = trigOf(angle);
  const vault = trigOf(f32(angle + 180));
  return {
    sinStart: start.sin,
    cosStart: start.cos,
    sinVault: vault.sin,
    cosVault: vault.cos,
  };
}

/**
 * Vulcanus's TEN bearings, in the order `fmw_wasm::abi::VulcanusBearing` names
 * them.
 *
 * The order is load-bearing and the enum on the Rust side exists so neither
 * half has to remember it: two of these swapped produces a perfectly plausible
 * planet with its biomes rotated, which no bound and no smoke test would catch.
 *
 * The narrowings differ per group and are transcribed from the call sites
 * rather than normalised:
 *
 * - the three SPAWN angles are narrowed by `vulcanusSpawn.ts`, with
 *   `f32(120 * direction)` narrowed separately before the add;
 * - the volcano-spot disc is the mountains angle unchanged, and the protector
 *   is `mountainsAngle + 180 * direction` with **no** narrowing - that is how
 *   `vulcanusBiomes.ts` writes it;
 * - the five RESOURCE angles narrow the offset and then the sum, as
 *   `vulcanusResources.ts` writes them.
 *
 * Normalising those three styles into one would change five of the ten values.
 */
export function vulcanusBearingTrig(seed0: number): { sin: number; cos: number }[] {
  const direction = -1 + 2 * (seedSmall(seed0) & 1);
  const ashlands = f32(seedNormalized(seed0) * 3600);
  const mountains = f32(ashlands + f32(120 * direction));
  const basalts = f32(ashlands + f32(240 * direction));
  const offset = (base: number, degrees: number): number => f32(base + f32(degrees * direction));

  return [
    trigOf(ashlands),
    trigOf(mountains),
    trigOf(basalts),
    // The volcano disc sits at the mountains bearing; the protector is mirrored
    // across it, un-narrowed, exactly as `vulcanusBiomes.ts` writes it.
    trigOf(mountains),
    trigOf(mountains + 180 * direction),
    offsetTrig(basalts, -10),
    offsetTrig(ashlands, 15),
    offsetTrig(mountains, -20),
    offsetTrig(mountains, 10),
    offsetTrig(mountains, 30),
  ];

  function offsetTrig(base: number, degrees: number): { sin: number; cos: number } {
    return trigOf(offset(base, degrees));
  }
}

/**
 * Write a request into `target`, returning the bytes written.
 *
 * The return value is the LENGTH of this request, not the buffer's capacity -
 * a Fulgora request is 120 bytes and a Vulcanus one is 368, and the module is
 * handed the length so it can check the declared block against what arrived.
 */
export function encodeRenderRequest(target: Uint8Array, req: WasmRenderRequest): number {
  const planet = req.planet ?? "fulgora";
  const paramsBytes =
    planet === "vulcanus"
      ? VULCANUS_PARAMS_BYTES
      : planet === "nauvis"
        ? NAUVIS_PARAMS_BYTES
        : FULGORA_PARAMS_BYTES;
  const total = COMMON_BYTES + paramsBytes;
  if (target.byteLength < total) {
    throw new RangeError(
      `WASM ${planet} request needs ${String(total)} bytes, target has ${String(target.byteLength)}`,
    );
  }
  const view = new DataView(target.buffer, target.byteOffset, total);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, ABI_VERSION, true);
  view.setUint32(8, PLANET[planet], true);
  view.setUint32(12, VIEW[req.view ?? "landmask"], true);
  // `setUint32` takes the number modulo 2^32, so a surface seed above 2^31 -
  // which is the normal case - writes its true bit pattern rather than
  // saturating. Fulgora's own seed for map seed 123456 is 2,967,702,466.
  view.setUint32(16, req.seed0, true);
  view.setUint32(20, req.width, true);
  view.setUint32(24, req.height, true);
  view.setUint32(28, paramsBytes, true);
  view.setFloat64(32, req.originX, true);
  view.setFloat64(40, req.originY, true);
  view.setFloat64(48, req.tilesPerPixel, true);

  if (planet === "vulcanus") {
    writeVulcanusParams(view, req as VulcanusRenderRequest);
  } else if (planet === "nauvis") {
    writeNauvisParams(view, req as NauvisRenderRequest);
  } else {
    writeFulgoraParams(view, req as FulgoraRenderRequest);
  }
  return total;
}

/**
 * Nauvis's block: eight climate levers, the tree overlay's four, the rock
 * overlay's two, its sweep box, the enemy overlay's two, then the cliff
 * overlay's five, its own query box, then the resource overlay's eighteen. No
 * trig, and two boxes.
 *
 * No trig because Nauvis reaches no `starting_spot_at_angle` - it is the one
 * planet whose whole chain is free of transcendentals, so nothing has to be
 * computed in V8 and handed across (#270).
 *
 * The tree overlay needs no box at all, which is a property of trees rather
 * than an omission: it reads its density FIELD at a one-cell border in world
 * coordinates instead of reading neighbouring image pixels. The rock and enemy
 * overlays do read the image - their 3x3 marks straddle seams - and because
 * both marks are symmetric and the same size, ONE box covers them both. The
 * cliff overlay needs its own, because its block spans `px - 2 ..= px + 1`:
 * asymmetric, and the two directions cross.
 */
function writeNauvisParams(view: DataView, req: NauvisRenderRequest): void {
  const p = COMMON_BYTES;
  view.setFloat64(p, req.waterLevel, true);
  view.setFloat64(p + 8, req.segmentationMultiplier, true);
  view.setFloat64(p + 16, req.moistureFrequency, true);
  view.setFloat64(p + 24, req.moistureBias, true);
  view.setFloat64(p + 32, req.auxFrequency, true);
  view.setFloat64(p + 40, req.auxBias, true);
  view.setFloat64(p + 48, req.startingAreaMoistureSize, true);
  view.setFloat64(p + 56, req.startingAreaMoistureFrequency, true);
  view.setFloat64(p + 64, req.temperatureFrequency, true);
  view.setFloat64(p + 72, req.temperatureBias, true);
  view.setFloat64(p + 80, req.treesFrequency, true);
  view.setFloat64(p + 88, req.treesSize, true);
  view.setFloat64(p + 96, req.rocksFrequency, true);
  view.setFloat64(p + 104, req.rocksSize, true);
  const sweep = req.placementSweepBox ?? {
    x0: req.originX,
    y0: req.originY,
    x1: req.originX + req.width * req.tilesPerPixel,
    y1: req.originY + req.height * req.tilesPerPixel,
  };
  view.setFloat64(p + 112, sweep.x0, true);
  view.setFloat64(p + 120, sweep.y0, true);
  view.setFloat64(p + 128, sweep.x1, true);
  view.setFloat64(p + 136, sweep.y1, true);
  view.setFloat64(p + 144, req.enemyFrequency, true);
  view.setFloat64(p + 152, req.enemySize, true);
  view.setFloat64(p + 160, req.cliffFrequency, true);
  view.setFloat64(p + 168, req.cliffContinuity, true);
  view.setFloat64(p + 176, req.cliffElevation0, true);
  view.setFloat64(p + 184, req.cliffElevationInterval, true);
  view.setFloat64(p + 192, req.cliffRichness, true);
  const cells = req.cellQueryBox ?? {
    x0: req.originX,
    y0: req.originY,
    x1: req.originX + req.width * req.tilesPerPixel,
    y1: req.originY + req.height * req.tilesPerPixel,
  };
  view.setFloat64(p + 200, cells.x0, true);
  view.setFloat64(p + 208, cells.y0, true);
  view.setFloat64(p + 216, cells.x1, true);
  view.setFloat64(p + 224, cells.y1, true);
  if (req.resourceLevers.length !== 6) {
    throw new Error(`resourceLevers must hold 6 entries, got ${req.resourceLevers.length}`);
  }
  for (let i = 0; i < 6; i++) {
    const at = p + 232 + i * 24;
    view.setFloat64(at, req.resourceLevers[i][0], true);
    view.setFloat64(at + 8, req.resourceLevers[i][1], true);
    view.setFloat64(at + 16, req.resourceLevers[i][2], true);
  }

  // The starting points. An empty list is legal and means the origin, which is
  // what the module does with a zero count and what the game's own default is.
  // Refusing an over-long list is deliberate: silently dropping points past the
  // cap would move `distanceFromNearestPoint` and render a subtly wrong planet.
  const spawn = req.startingPositions ?? [];
  if (spawn.length > NAUVIS_MAX_STARTING_POINTS) {
    throw new Error(
      `startingPositions holds ${spawn.length} points, over the ABI cap of ${NAUVIS_MAX_STARTING_POINTS}`,
    );
  }
  view.setFloat64(p + 376, spawn.length, true);
  for (let i = 0; i < NAUVIS_MAX_STARTING_POINTS; i++) {
    const at = p + 384 + i * 16;
    const pt = spawn[i];
    view.setFloat64(at, pt ? pt.x : 0, true);
    view.setFloat64(at + 8, pt ? pt.y : 0, true);
  }
}

function writeFulgoraParams(view: DataView, req: FulgoraRenderRequest): void {
  const trig = bearingTrig(req.seed0);
  const p = COMMON_BYTES;
  view.setFloat64(p, req.islandsFrequency, true);
  view.setFloat64(p + 8, req.islandsSize, true);
  view.setFloat64(p + 16, trig.sinStart, true);
  view.setFloat64(p + 24, trig.cosStart, true);
  view.setFloat64(p + 32, trig.sinVault, true);
  view.setFloat64(p + 40, trig.cosVault, true);
  // The ONE place an absent scrap slider becomes the neutral 1. See the field
  // docs on `FulgoraRenderRequest`.
  view.setFloat64(p + 48, req.scrapFrequency ?? 1, true);
  view.setFloat64(p + 56, req.scrapSize ?? 1, true);
}

function writeVulcanusParams(view: DataView, req: VulcanusRenderRequest): void {
  const p = COMMON_BYTES;
  view.setFloat64(p, req.volcanismFrequency, true);
  view.setFloat64(p + 8, req.volcanismSize, true);
  view.setFloat64(p + 16, req.temperatureBias, true);
  // The four resource controls in tungsten / coal / calcite / sulfur order,
  // frequency then size. The Rust struct names them, so a swapped pair here is
  // a wrong slider rather than a decode error.
  const levers = [req.tungstenOre, req.vulcanusCoal, req.calcite, req.sulfuricAcidGeyser];
  levers.forEach((lever, i) => {
    view.setFloat64(p + 24 + i * 16, lever.frequency, true);
    view.setFloat64(p + 32 + i * 16, lever.size, true);
  });
  vulcanusBearingTrig(req.seed0).forEach((t, i) => {
    view.setFloat64(p + 88 + i * 16, t.sin, true);
    view.setFloat64(p + 96 + i * 16, t.cos, true);
  });
  // The two world boxes, each defaulting to the request's own pixel box. Only
  // the views that read one consult it; every other view leaves both inert
  // rather than absent, so the block has one length per planet and
  // `BadParamsLength` stays a real check.
  const pixelBox = {
    x0: req.originX,
    y0: req.originY,
    x1: req.originX + req.width * req.tilesPerPixel,
    y1: req.originY + req.height * req.tilesPerPixel,
  };
  const writeBox = (at: number, box: typeof pixelBox): void => {
    view.setFloat64(at, box.x0, true);
    view.setFloat64(at + 8, box.y0, true);
    view.setFloat64(at + 16, box.x1, true);
    view.setFloat64(at + 24, box.y1, true);
  };
  writeBox(p + 248, req.cellQueryBox ?? pixelBox);
  writeBox(p + 280, req.placementSweepBox ?? pixelBox);
}
