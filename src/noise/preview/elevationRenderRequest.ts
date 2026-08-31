import type { Point } from "../distanceFromNearestPoint";
import { CLIFF_MARK_BACK_PX, CLIFF_MARK_SIZE_PX } from "../cliffs/cliffCatalog";
import type { CliffControls, CliffSettingsInput } from "../cliffs/cliffCatalog";
import type { VulcanusResourceControls } from "../eval/ctx";
import type { EnemyControls } from "../enemies/enemyCatalog";
import type { Planet } from "../../model/planets";
import { PLACEMENT_MARK_RADIUS_PX } from "../placement/placementRoll";
import { NAUVIS_MAX_STARTING_POINTS } from "../wasm/request";
import type { ResourceControlLevers } from "../resources/resourceCatalog";
import type { RockControls } from "../rocks/rockCatalog";
import { renderCliffs } from "./renderCliffs";
import { renderElevation } from "./renderElevation";
import { renderEnemies } from "./renderEnemies";
import { renderResources } from "./renderResources";
import { renderRocks } from "./renderRocks";
import { renderTerrain } from "./renderTerrain";
import { renderTrees } from "./renderTrees";
import { renderVulcanusCliffs } from "./renderVulcanusCliffs";
import { makeVulcanusStack } from "../tiles/vulcanusCatalog";
import { renderVulcanusResources } from "./renderVulcanusResources";
import { renderVulcanusRocks } from "./renderVulcanusRocks";
import { renderVulcanusTerrain } from "./renderVulcanusTerrain";
import { renderFulgoraLandMask, renderFulgoraTerrain } from "./renderFulgoraTerrain";
import { renderThroughWasm, type EngineExports } from "../wasm/engine";
import { renderFulgoraResources } from "./renderFulgoraResources";
import { RESOURCE_CATALOG } from "../resources/resourceCatalog";
import { makeFulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraScrapControls } from "../expressions/fulgoraScrap";

/** A render job posted to the worker. `id` tags the response for staleness. */
export interface ElevationRenderRequest {
  id: number;
  seed0: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  tilesPerPixel: number;
  waterLevel: number;
  segmentationMultiplier: number;
  startingPositions: Point[];
  /**
   * Which planet's terrain to render (Task 11). Default `"nauvis"` when
   * omitted - existing (Nauvis) requests are byte-unchanged. Only the
   * terrain-family views (`"terrain"`/`"resources"`/`"enemies"`/`"cliffs"`/
   * `"trees"`/`"rocks"`/`"all"`) consult this; `"elevation"` is unaffected
   * (it dispatches purely on `mapType`, which only spans the Nauvis-family
   * elevation trees).
   *
   * `"vulcanus"` renders through `renderVulcanusTerrain` (Task 10's tile
   * resolver) instead of `renderTerrain`. Of the five overlays
   * (resources/enemies/cliffs/trees/rocks), only `resources` has a Vulcanus
   * port (V2, `renderVulcanusResources`) - the other four have no Vulcanus
   * meaning, so a terrain-family view that asks for one still gets plain
   * Vulcanus terrain colors rather than a Nauvis field composited on top.
   */
  planet?: Planet;
  /**
   * **Refused.** Kept on the interface only because `eval/ctx.ts` and
   * `expressions/elevationIsland.ts` still carry the field, so the type outlives
   * every module that acted on it. Passing one - including `[]`, which used to
   * mean "far-field only" - throws
   * `STARTING_LAKE_POSITIONS_UNSUPPORTED`. The lake positions are derived inside
   * the render from the seed and the starting positions, which is the game's own
   * rule.
   */
  startingLakePositions?: Point[];
  /**
   * Climate controls (Task 12b) - consumed only when `view: "terrain"`; the
   * elevation renderers ignore these. Each defaults to the game's default
   * (freq 1, bias 0, starting-area size/frequency 1) when omitted.
   */
  moistureFrequency?: number;
  moistureBias?: number;
  /** Only `trees` consumes temperature; tile selection is aux + moisture. */
  temperatureFrequency?: number;
  temperatureBias?: number;
  auxFrequency?: number;
  auxBias?: number;
  startingAreaMoistureSize?: number;
  startingAreaMoistureFrequency?: number;
  /** Which elevation tree to render. Default "lakes". */
  mapType?: "lakes" | "nauvis" | "island";
  /**
   * Which render to run: the water/land elevation mask ("elevation"), the full
   * terrain-tile color render ("terrain"), the terrain with the resource-patch
   * overlay composited on top ("resources"), the terrain with the enemy-base
   * footprint overlay composited on top ("enemies"), the terrain with the
   * cliff footprint overlay composited on top ("cliffs"), the terrain with the
   * tree-density blend composited on top ("trees"), the terrain with the rock
   * footprint overlay composited on top ("rocks"), or the terrain with all
   * five overlays composited on top at once ("all"). Default "elevation".
   * renderTerrain (and therefore "resources"/"enemies"/"cliffs"/"trees"/"rocks"/"all") always uses the
   * Nauvis climate + tile catalog (see renderTerrain.ts), so it is only faithful
   * when `mapType` is "nauvis" - callers (the preview panel) disable those
   * toggles for lakes/island presets rather than send an unfaithful request here.
   */
  /**
   * `"landmask"` is the island finder's view and nothing else's: Fulgora land
   * versus ocean, skipping the eight-way land argmax whose answer the finder
   * discards. It is deliberately absent from `ElevationPreviewPanel`'s own view
   * union, so no dev-mode toggle can select it. On any planet without a port it
   * falls back to that planet's terrain, like every other view here - see
   * `servedView`, which makes that fall-back explicit rather than incidental.
   */
  view?:
    | "elevation"
    | "terrain"
    | "resources"
    | "enemies"
    | "cliffs"
    | "trees"
    | "rocks"
    | "all"
    | "landmask";
  /**
   * Per-resource control levers (control:<res>:frequency|size|richness), keyed by
   * controlName - consumed only when `view: "resources"`. Missing entries default
   * to 1/1/1 inside the resolver.
   */
  resourceControls?: Record<string, ResourceControlLevers>;
  /**
   * Vulcanus resource control levers - consumed only when `planet: "vulcanus"`
   * and `view: "resources"`. Defaults to all-neutral.
   */
  vulcanusResourceControls?: VulcanusResourceControls;
  /**
   * The `fulgora_islands` autoplace control's frequency/size
   * (`control:fulgora_islands:*`) - consumed only when `planet: "fulgora"`.
   * Defaults to `{ frequency: 1, size: 1 }`, the game's own neutral position.
   *
   * Both levers are worth threading even though each is a single number,
   * because each defaults to the ONE value that hides its own implementation:
   * at frequency 1 the Voronoi `grid_size` is exactly 175, so its truncation to
   * a u16 is a no-op, and at size 1 `slider_rescale(size, 2)` is exactly 1, so
   * `fulgora_natural`'s scaling term vanishes. A render that ignored these
   * would look correct at every default and be wrong the moment either slider
   * moved.
   */
  fulgoraIslandControls?: { readonly frequency?: number; readonly size?: number };
  /**
   * `control:scrap:frequency` / `:size` - consumed only when `planet: "fulgora"`
   * and the view includes resources. No UI writes this yet; it exists so the
   * renderer reads the levers the game does rather than hardcoding neutral.
   */
  fulgoraScrapControls?: FulgoraScrapControls;
  /**
   * Escape hatch for `test/vulcanusStackCache.spec.ts`, which has to render the
   * same request BOTH ways to prove the shared cached stack is byte-identical
   * to per-renderer stacks. Defaults to the shared stack; there is no reason to
   * set this outside that test.
   */
  unsharedStacks?: boolean;
  /**
   * The enemy-base autoplace control's frequency/size (control:enemy-base:*) -
   * consumed only when `view: "enemies"`. Defaults to `{ frequency: 1, size: 1 }`
   * when omitted.
   */
  enemyControls?: EnemyControls;
  /**
   * The `nauvis_cliff` autoplace control's frequency/size (control:nauvis_cliff:*,
   * size doubles as continuity) - consumed only when `view: "cliffs"`. Defaults to
   * `{ frequency: 1, continuity: 1 }` when omitted.
   */
  cliffControls?: CliffControls;
  /**
   * The cliff-related MapGenSettings fields (cliff_elevation_0,
   * cliff_elevation_interval, cliff richness) - consumed only when
   * `view: "cliffs"`. Defaults to `{ cliffElevation0: 10, cliffElevationInterval:
   * 40, richness: 1 }` (the game's defaults) when omitted.
   */
  cliffSettings?: CliffSettingsInput;
  /**
   * The `trees` autoplace control's frequency/size (control:trees:*) - consumed
   * only when `view: "trees"` or `"all"`. Defaults to `{ frequency: 1, size: 1 }`.
   */
  treeControls?: { readonly frequency: number; readonly size: number };
  /**
   * The `rocks` autoplace control's frequency/size (control:rocks:*) - consumed
   * only when `view: "rocks"` or `"all"`. Defaults to `{ frequency: 1, size: 1 }`.
   */
  rockControls?: RockControls;
  /**
   * The full image this request is one tile of, when the renderer is tiling.
   * Absent means the request *is* the whole image (the single-render path).
   *
   * Used for exactly one thing: clamping the widened cliff cell-query box, so a
   * tiled render reproduces the untiled render byte for byte - including at the
   * image border, where the untiled render drops cliff cells centered outside
   * the image. `tilesPerPixel` is shared with the request.
   */
  fullImage?: {
    readonly originX: number;
    readonly originY: number;
    readonly width: number;
    readonly height: number;
  };
}

/** The rendered pixels, with `buffer` posted back as a transferable. */
export interface ElevationRenderResult {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

/** A world-tile box, inclusive lower / exclusive upper on both axes. */
export interface WorldBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The world box to sweep/enumerate for `req`: its own pixel box, widened by
 * `radiusPx` pixels' worth of world tiles so a mark centered just outside this
 * tile still owes it pixels, then intersected with the full image so the outer
 * border keeps the untiled behavior.
 *
 * The halo is exact rather than conservative, and it is **asymmetric whenever
 * the mark is**. A mark at world `wx` maps to pixel `px = floor((wx - originX) /
 * tpp)` and paints `px - back .. px + fwd`, so it touches this tile
 *
 *     on the low side  iff `px + fwd >= 0`      -> widen x0 by `fwd * tpp`
 *     on the high side iff `px - back <= w - 1` -> widen x1 by `back * tpp`
 *
 * (using `floor(v) >= -k` iff `v >= -k` for integer `k`, and pairing with an
 * inclusive-lower / exclusive-upper enumeration). Note the directions CROSS: a
 * mark that reaches far *backwards* has to be caught from *ahead* of the tile.
 *
 * A symmetric `max(back, fwd)` on both sides is correct but not free. The cliff
 * pass quantizes its enumeration to 32-tile chunks, so one surplus tile of halo
 * can pull in a whole extra chunk per axis - measured at 512x512 tiled 16 ways,
 * a symmetric 2/2 halo cost 24,336 cliffiness evaluations against 17,424 for the
 * exact 1/2 one, a **1.40x** overhead for zero pixels of difference. See
 * `docs/noise/vulcanus-cliffs-NOTES.md`.
 */
function haloQueryBox(req: ElevationRenderRequest, backPx: number, fwdPx: number): WorldBox {
  const tpp = req.tilesPerPixel;
  const x0 = req.originX;
  const y0 = req.originY;
  const x1 = req.originX + req.width * tpp;
  const y1 = req.originY + req.height * tpp;
  const full = req.fullImage;
  if (!full) return { x0, y0, x1, y1 };
  // Crossed on purpose - see the doc above.
  const lo = fwdPx * tpp;
  const hi = backPx * tpp;
  return {
    x0: Math.max(x0 - lo, full.originX),
    y0: Math.max(y0 - lo, full.originY),
    x1: Math.min(x1 + hi, full.originX + full.width * tpp),
    y1: Math.min(y1 + hi, full.originY + full.height * tpp),
  };
}

/**
 * The world box to enumerate cliff cells over for `req`, so a cell whose block
 * reaches into this tile is always enumerated.
 *
 * The cliff block is **not** symmetric: it spans `px - CLIFF_MARK_BACK_PX ..
 * px + CLIFF_MARK_SIZE_PX - CLIFF_MARK_BACK_PX - 1`, i.e. 2 back and 1 forward,
 * which is what anchors it on the cell's own 4-tile footprint. This used to
 * widen by `CLIFF_MARK_BACK_PX` in both directions ("the larger of the block's
 * two directions"), a description that fit the 5x5 centred mark it was written
 * for and outlived it. Correct, and one tile too wide on the low side.
 *
 * Exported for direct unit testing: the tiled-equals-untiled gate pins the
 * widening (drop it and the gate fails) but cannot pin the clamp, which only
 * changes pixels when a cliff cell happens to sit just outside the image border
 * next to non-water terrain.
 */
export function cliffCellQueryBox(req: ElevationRenderRequest): WorldBox {
  return haloQueryBox(req, CLIFF_MARK_BACK_PX, CLIFF_MARK_SIZE_PX - CLIFF_MARK_BACK_PX - 1);
}

/**
 * The world box to sweep for a placement roll that paints a 3x3 mark -
 * `haloQueryBox` at `PLACEMENT_MARK_RADIUS_PX`. Shared by Nauvis enemy bases
 * (`renderEnemies.ts`), Vulcanus geysers (`renderVulcanusResources.ts`) and
 * Nauvis crude oil (`renderResources.ts`).
 *
 * A 3x3 mark straddles worker-tile seams, hence the halo (a spawner is
 * 7.4 x 6.4 tiles, a geyser 2.8 x 2.8, and both are rare enough that a dot would
 * vanish). Each renderer documents its sweep side; `test/tiledEquality.spec.ts`
 * is what fails without it, and it carries a separate case per overlay because a
 * window dense in one is empty of the other.
 *
 * **Both rock overlays also use this**, and both paint a 3x3 mark. This comment
 * has now been wrong twice in the same place: it first said "both rock overlays
 * paint a 1x1 pixel and need no equivalent", then was corrected to "only the
 * Nauvis rock overlay is 1x1" - which was already false, because the
 * 2026-07-28 preview comparison moved BOTH planets off 1x1 in one change.
 * `NAUVIS_ROCK_MARK_RADIUS_PX` and `VULCANUS_ROCK_MARK_RADIUS_PX` are both 1,
 * and `rockCatalog.ts` says "the planets agree" at the second one.
 *
 * This halo is exact and cannot be tightened - unlike the cliff one it faces
 * (`cliffCellQueryBox`), the mark really is symmetric. It is, however, where the
 * remaining tiled-vs-whole cost lives: one pixel of widening crosses a 32-tile
 * chunk boundary, so an interior tile resolves 6 chunks per axis instead of 4
 * and every seam chunk is resolved by both neighbours (1.89x `resolveChunk`
 * calls, measured). That is structural rather than a defect - a rock one pixel
 * outside genuinely owes this tile pixels, and knowing whether it exists means
 * resolving its chunk. See `docs/noise/vulcanus-cliffs-NOTES.md`.
 */
export function placementMarkSweepBox(req: ElevationRenderRequest): WorldBox {
  // Genuinely symmetric: a 3x3 mark centred on its pixel.
  return haloQueryBox(req, PLACEMENT_MARK_RADIUS_PX, PLACEMENT_MARK_RADIUS_PX);
}

/**
 * The Rust engine's Vulcanus path - every view the panel offers for it.
 *
 * Vulcanus has no ocean and no scrap, so the land mask and the scrap footprint
 * are meaningless there rather than merely unimplemented; the module rejects
 * them by status. Everything else - `terrain`, `cliffs`, `rocks`, `resources`
 * and the `all` composite - now renders through the engine, which is what
 * completes #225.
 *
 * **The composites are single requests, not a terrain render plus overlay
 * calls.** Each overlay has nothing to draw on its own and shares the whole
 * field DAG below the tile argmax with terrain, so splitting `all` into four
 * requests would build that chain four times. The module paints resources, then
 * rocks, then cliffs over one terrain sweep - the same order this file used when
 * it composed them itself.
 *
 * The copy note on the Fulgora function below applies here identically.
 */
function renderVulcanusThroughWasm(
  req: ElevationRenderRequest,
  engine: EngineExports,
  view: "terrain" | "cliffs" | "rocks" | "resources" | "all",
): ElevationRenderResult {
  const levers = (c: { frequency?: number; size?: number } | undefined) => ({
    frequency: c?.frequency ?? 1,
    size: c?.size ?? 1,
  });
  const controls = req.vulcanusResourceControls;
  const pixels = renderThroughWasm(engine, {
    planet: "vulcanus",
    view,
    seed0: req.seed0,
    width: req.width,
    height: req.height,
    originX: req.originX,
    originY: req.originY,
    tilesPerPixel: req.tilesPerPixel,
    volcanismFrequency: 1,
    volcanismSize: 1,
    temperatureBias: 0,
    tungstenOre: levers(controls?.tungstenOre),
    vulcanusCoal: levers(controls?.vulcanusCoal),
    calcite: levers(controls?.calcite),
    sulfuricAcidGeyser: levers(controls?.sulfuricAcidGeyser),
    // Each is inert for the views that do not read it. Both are computed by the
    // same functions the TypeScript path passes to its overlay renderers, so
    // the halo arithmetic lives in one place and `tiledEquality.spec.ts` keeps
    // guarding it.
    cellQueryBox: cliffCellQueryBox(req),
    placementSweepBox: placementMarkSweepBox(req),
  });
  const owned = new Uint8ClampedArray(pixels);
  return { id: req.id, buffer: owned.buffer, width: req.width, height: req.height };
}

/**
 * The Rust engine's Fulgora path - the land mask, and now the full terrain
 * render too.
 *
 * **The copy here is real and is the only one.** Reading the output is
 * zero-copy - `renderThroughWasm` hands back a view over WebAssembly linear
 * memory - but `postMessage` cannot transfer a view over WASM memory, and the
 * buffer is reused by the next render anyway. So this slices once into a fresh
 * `ArrayBuffer` and that is what gets transferred. At 1024x1024 it is 4 MB,
 * well under a millisecond against renders measured in seconds.
 *
 * Written out because a wrong belief about where a copy happens is exactly the
 * kind of thing that gets repeated.
 */
function renderFulgoraThroughWasm(
  req: ElevationRenderRequest,
  engine: EngineExports,
  which: "landmask" | "terrain",
): ElevationRenderResult {
  const view = renderThroughWasm(engine, {
    view: which,
    seed0: req.seed0,
    width: req.width,
    height: req.height,
    originX: req.originX,
    originY: req.originY,
    tilesPerPixel: req.tilesPerPixel,
    islandsFrequency: req.fulgoraIslandControls?.frequency ?? 1,
    islandsSize: req.fulgoraIslandControls?.size ?? 1,
  });
  const owned = new Uint8ClampedArray(view);
  return { id: req.id, buffer: owned.buffer, width: req.width, height: req.height };
}

/**
 * The Rust engine's Nauvis path - every view `view` declares, plus the three
 * elevation codes.
 *
 * The terrain render, all five overlays, and the `all` composite. The module
 * refuses anything else with `unsupported planet or view`, so a mistake here is
 * loud rather than silent.
 *
 * **`"elevation"` is ported as of #227**, as three `view` codes rather than
 * one, because the common prefix has no `mapType` field. See the gate at the
 * tail of `runRenderRequest`, which still keeps two cases on the TypeScript
 * path: a spawn list over the ABI cap, and a non-Nauvis `planet`.
 *
 * **A caller-supplied `startingLakePositions` is refused outright** rather
 * than routed anywhere - see `STARTING_LAKE_POSITIONS_UNSUPPORTED` and the
 * guard at the top of `runRenderRequest`. The module derives the lake list from
 * the seed and the origin spawn, which is the game's own rule, so an explicit
 * list was always a wrong answer rather than a slow one; once the TypeScript
 * arm goes there is nothing left that could honour it. The app never set it.
 *
 * **`waterLevel` is sent and deliberately ignored by the module** - issue #326.
 * `renderTerrain.ts` resolves every tile at `waterLevel = 0` however the slider
 * is set, and these two renders are asserted byte-identical, so the engine has
 * to reproduce that rather than fix it here.
 *
 * The copy is the same single one Fulgora's path makes and for the same reason;
 * see `renderFulgoraThroughWasm`.
 */
function renderNauvisThroughWasm(
  req: ElevationRenderRequest,
  engine: EngineExports,
  view:
    | "terrain"
    | "trees"
    | "rocks"
    | "enemies"
    | "cliffs"
    | "resources"
    | "all"
    | "elevationLakes"
    | "elevationNauvis"
    | "elevationIsland",
): ElevationRenderResult {
  const pixels = renderThroughWasm(engine, {
    planet: "nauvis",
    view,
    seed0: req.seed0,
    width: req.width,
    height: req.height,
    originX: req.originX,
    originY: req.originY,
    tilesPerPixel: req.tilesPerPixel,
    waterLevel: req.waterLevel,
    segmentationMultiplier: req.segmentationMultiplier,
    // Each of these is OPTIONAL on the request and defaulted inside
    // `makeMoisture` / `makeAux` on the TypeScript path. The module has no such
    // fallback - it reads eight f64s - so the defaults are applied here, and
    // they have to be the SAME ones. A wrong default is a silent divergence
    // rather than an error, which is what `test/wasmNauvisRenderParity.spec.ts`
    // is for: it renders windows with these levers moved and unmoved.
    moistureFrequency: req.moistureFrequency ?? 1,
    moistureBias: req.moistureBias ?? 0,
    auxFrequency: req.auxFrequency ?? 1,
    auxBias: req.auxBias ?? 0,
    startingAreaMoistureSize: req.startingAreaMoistureSize ?? 1,
    startingAreaMoistureFrequency: req.startingAreaMoistureFrequency ?? 1,
    // Trees are the only consumer of temperature, and the only view that reads
    // the two tree levers. Defaulted here to the same values `makeTreeDensity`
    // uses, for the reason the block above states.
    temperatureFrequency: req.temperatureFrequency ?? 1,
    temperatureBias: req.temperatureBias ?? 0,
    treesFrequency: req.treeControls?.frequency ?? 1,
    treesSize: req.treeControls?.size ?? 1,
    rocksFrequency: req.rockControls?.frequency ?? 1,
    rocksSize: req.rockControls?.size ?? 1,
    enemyFrequency: req.enemyControls?.frequency ?? 1,
    enemySize: req.enemyControls?.size ?? 1,
    cliffFrequency: req.cliffControls?.frequency ?? 1,
    cliffContinuity: req.cliffControls?.continuity ?? 1,
    cliffElevation0: req.cliffSettings?.cliffElevation0 ?? 10,
    cliffElevationInterval: req.cliffSettings?.cliffElevationInterval ?? 40,
    cliffRichness: req.cliffSettings?.richness ?? 1,
    // Catalog ORDER, not the request's key order: the module indexes this by
    // position. `RESOURCE_CATALOG` is the one definition of that order on this
    // side, so a resource added to it cannot silently shift the block.
    resourceLevers: RESOURCE_CATALOG.map((entry) => {
      const levers = req.resourceControls?.[entry.controlName];
      return [levers?.frequency ?? 1, levers?.size ?? 1, levers?.richness ?? 1] as const;
    }),
    // The asymmetric, crossed halo - a different shape from the placement
    // sweep box above, which is why both are sent.
    cellQueryBox: cliffCellQueryBox(req),
    // The same box `renderRocks` is handed on the TypeScript path, so the two
    // sweep identical pixel ranges. `haloQueryBox` stays the one place that
    // arithmetic lives.
    placementSweepBox: placementMarkSweepBox(req),
    startingPositions: req.startingPositions,
  });
  const owned = new Uint8ClampedArray(pixels);
  return { id: req.id, buffer: owned.buffer, width: req.width, height: req.height };
}

/**
 * What a caller-supplied `startingLakePositions` is refused with.
 *
 * Exported so specs assert the exact string rather than a substring of whatever
 * the `Error` happened to say.
 */
export const STARTING_LAKE_POSITIONS_UNSUPPORTED =
  "startingLakePositions is not supported: the render derives the lake list from " +
  "the seed and the starting positions, which is the game's own rule";

/**
 * The view this request actually renders, which is not always the one it asks
 * for.
 *
 * Four `(planet, view)` pairs have no renderer of their own: Vulcanus has no
 * enemy bases, no trees and no ocean, and Nauvis has no land mask. Asking for
 * one has always produced the planet's plain terrain, because the overlay
 * blocks below simply never match and the land-mask branch is Fulgora's alone.
 * The request rendered; it just rendered terrain.
 *
 * That silence is the problem. The Rust engine refuses all four outright - see
 * the `supported` match in `crates/fmw-wasm/src/render.rs`, which pins
 * `(Vulcanus, landmask)` as unsupported in its own test - so the fall-through
 * has to become explicit BEFORE #227 deletes the TypeScript terrain renderers
 * it lands on. Left alone, those four requests would stop rendering and start
 * throwing, and Trap 2's error path would discard the reason.
 *
 * Normalising onto `"terrain"` rather than widening the engine's gate is what
 * keeps the pixels identical: `"terrain"` is precisely what these four already
 * draw. Widening the gate would ask the module for a render it has deliberately
 * decided is meaningless.
 *
 * Nothing in the app can reach any of the four - `ElevationPreviewPanel`'s
 * `effectiveView` emits only `terrain|resources|cliffs|rocks|all` on Vulcanus,
 * and `"landmask"` is absent from its view union on every planet - so this
 * closes a hole in the type surface rather than in anything a user sees. It is
 * still worth closing: the type permits all four, and `findIslands` already
 * posts a hand-built request rather than one the panel produced.
 */
function servedView(
  planet: Planet,
  view: ElevationRenderRequest["view"],
): ElevationRenderRequest["view"] {
  if (planet === "vulcanus" && (view === "enemies" || view === "trees" || view === "landmask")) {
    return "terrain";
  }
  if (planet === "nauvis" && view === "landmask") return "terrain";
  return view;
}

/**
 * Pure render step shared by the worker and its tests: run renderElevation or
 * renderTerrain (per `req.view`, once `servedView` has normalised it) and hand
 * back the transferable RGBA buffer. No Worker or DOM canvas involved.
 *
 * `engine` is optional and opt-in. When a caller supplies an instantiated Rust
 * engine AND the request is Fulgora's land mask - the one path #223 ports - the
 * render goes through WebAssembly; otherwise it takes the TypeScript path
 * exactly as before. A parameter rather than module state, so nothing has to be
 * registered, reset between tests, or reasoned about across files.
 *
 * The two paths are BYTE-IDENTICAL, which `test/wasmFulgoraRenderParity.spec.ts`
 * asserts across four windows, so this is a speed choice and not a behaviour
 * switch.
 */
export function runRenderRequest(
  req: ElevationRenderRequest,
  engine?: EngineExports,
): ElevationRenderResult {
  // FIRST, before the planet split, and deliberately so.
  //
  // The two checks this replaces sat inside leaves of the view/planet dispatch
  // and between them missed three cases: the Vulcanus branch returns before the
  // Nauvis gate is ever evaluated, the Fulgora branch likewise - and that one is
  // reachable, since `findIslands` posts `planet: "fulgora", view: "landmask"` -
  // and `"landmask"` on Nauvis is in the outer view test but absent from the
  // Nauvis gate's allowlist. A guard that runs before any of that has no leaves
  // to miss.
  //
  // `!== undefined` rather than a truthiness test because it states the type's
  // own distinction, `Point[] | undefined`, instead of relying on a coincidence.
  // The coincidence is real and was measured: `[]` is TRUTHY in JavaScript, so
  // a truthiness test refuses an empty list too and the two forms agree on
  // every value this field can legally hold. The form to avoid is a length
  // test - `!== undefined && length > 0` - which would wave `[]` through, and
  // `[]` is a meaningful value rather than an absent one: `elevationLakes.ts`
  // documented "Pass `[]` for the old far-field-only behavior".
  //
  // An error rather than a silent no-op because the TYPE outlives every
  // consumer: `eval/ctx.ts` and `expressions/elevationIsland.ts` survive #227
  // while every module that acted on the override does not. Accepting and
  // ignoring it would render a different planet than the caller asked for and
  // say nothing.
  if (req.startingLakePositions !== undefined) {
    throw new Error(STARTING_LAKE_POSITIONS_UNSUPPORTED);
  }
  const planet = req.planet ?? "nauvis";
  const view = servedView(planet, req.view);
  let image: ImageData;
  if (
    view === "terrain" ||
    view === "resources" ||
    view === "enemies" ||
    view === "cliffs" ||
    view === "trees" ||
    view === "rocks" ||
    view === "all" ||
    view === "landmask"
  ) {
    if (planet === "vulcanus") {
      // Vulcanus has its own resource and cliff overlays. The remaining three
      // Nauvis overlays (enemies, trees, rocks) have no Vulcanus port, so a
      // terrain-family view that asks for one still gets plain terrain rather
      // than a Nauvis field composited onto Vulcanus colors.
      const wantsResources = view === "resources" || view === "all";
      // Checked BEFORE the TypeScript stack is built, for the reason the
      // Fulgora branch gives: `makeVulcanusStack` derives seed tables for the
      // whole biome, crack, climate and elevation chain, and building them only
      // to throw them away would be most of the saving.
      //
      // Every Vulcanus view the planet has is served here now (#225). What is
      // left below is the TypeScript path, which stays because it is the arm
      // tier 3 compares against - the two are byte-identical, so an engine that
      // failed to load is slower and never wrong.
      if (
        engine !== undefined &&
        (view === "terrain" ||
          view === "cliffs" ||
          view === "rocks" ||
          view === "resources" ||
          view === "all")
      ) {
        return renderVulcanusThroughWasm(req, engine, view);
      }
      // ONE stack for the whole composite. Two things make this pay, and both
      // are needed: the overlays reuse the field objects terrain built, and
      // those objects carry a cross-traversal cache (`memoRegion`), so a pass
      // that walks the image in a different order from terrain - the rock
      // overlay resolves whole 32x32 chunks - still hits values terrain
      // computed. Sharing without the cache buys almost nothing, because
      // `memoXY` holds only the last coordinate.
      const stack =
        req.unsharedStacks === true
          ? undefined
          : makeVulcanusStack(
              {
                seed0: req.seed0,
                startingPositions: req.startingPositions,
                vulcanusResourceControls: req.vulcanusResourceControls,
              },
              { cacheShared: true },
            );
      image = renderVulcanusTerrain({
        seed0: req.seed0,
        width: req.width,
        height: req.height,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        ctx: {
          startingPositions: req.startingPositions,
          vulcanusResourceControls: req.vulcanusResourceControls,
        },
        stack,
      });
      // Resources paint first, then the two obstruction overlays on top, so a
      // cliff or a rock crossing an ore patch still reads as the thing that is
      // in the way. Cliffs last matches the Nauvis order below, where
      // renderCliffs is the final pass.
      if (wantsResources) {
        renderVulcanusResources(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: {
            startingPositions: req.startingPositions,
            vulcanusResourceControls: req.vulcanusResourceControls,
          },
          // The geyser rolls and paints a 3x3 mark; the three solid ores
          // threshold and paint 1x1, and ignore this.
          sweepBox: placementMarkSweepBox(req),
          stack,
        });
      }
      if (view === "rocks" || view === "all") {
        renderVulcanusRocks(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: { startingPositions: req.startingPositions },
          sweepBox: placementMarkSweepBox(req),
          sharedStack: stack,
        });
      }
      if (view === "cliffs" || view === "all") {
        renderVulcanusCliffs(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: { startingPositions: req.startingPositions },
          cellQueryBox: cliffCellQueryBox(req),
          sharedStack: stack,
        });
      }
      return { id: req.id, buffer: image.data.buffer, width: req.width, height: req.height };
    }
    if (planet === "fulgora") {
      // The one path the Rust engine serves so far (#223). Checked BEFORE the
      // TypeScript stack is built, because `makeFulgoraStack` derives seed
      // tables for eight multioctave fields, and building them only to throw
      // them away would be most of the saving.
      if (engine !== undefined && (view === "landmask" || view === "terrain")) {
        return renderFulgoraThroughWasm(req, engine, view);
      }
      // Fulgora has a resources overlay now; it still has no cliffs and no
      // rocks, so those views fall back to plain terrain - the same fallback
      // the Vulcanus branch applies to the overlays it lacks. A view that asks
      // for an overlay this planet has no port for gets the terrain, never a
      // Nauvis field composited onto another planet's colours.
      const fulgoraCtx = {
        islandsFrequency: req.fulgoraIslandControls?.frequency,
        islandsSize: req.fulgoraIslandControls?.size,
      };
      const stack =
        req.unsharedStacks === true
          ? undefined
          : makeFulgoraStack({ seed0: req.seed0, ...fulgoraCtx });
      const fulgoraRender = {
        seed0: req.seed0,
        width: req.width,
        height: req.height,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        ctx: fulgoraCtx,
        stack,
      };
      // Returns straight away: a land mask takes no overlays, and compositing
      // resources onto it would paint over the very bit the caller wants.
      if (view === "landmask") {
        const mask = renderFulgoraLandMask(fulgoraRender);
        return { id: req.id, buffer: mask.data.buffer, width: req.width, height: req.height };
      }
      image = renderFulgoraTerrain(fulgoraRender);
      if (view === "resources" || view === "all") {
        renderFulgoraResources(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: fulgoraCtx,
          scrapControls: req.fulgoraScrapControls,
          stack,
        });
      }
      return { id: req.id, buffer: image.data.buffer, width: req.width, height: req.height };
    }
    // Every Nauvis view the Rust engine serves. `"elevation"` is no longer the
    // exception - it is served at the tail of this function under its own three
    // `view` codes as of #227 - so this list is the seven TILE-family views and
    // the elevation gate is separate because it paints a different palette.
    // Checked BEFORE the TypeScript render rather than after, so the engine's
    // work replaces it instead of being thrown away.
    //
    // The Nauvis block carries the spawn list as of #227, so a moved spawn no
    // longer forces the TypeScript path - the module reads the same points and
    // reaches the same distance terms. An over-long list is refused by the
    // writer rather than silently shortened, so it cannot arrive here wrong.
    //
    // `startingLakePositions` no longer appears here: it is refused outright at
    // the top of this function, so by the time the gate is evaluated there is
    // nothing left to test. The spawn-list cap still forces the TypeScript path,
    // and it is the last thing that does.
    if (
      engine !== undefined &&
      (view === "terrain" ||
        view === "trees" ||
        view === "rocks" ||
        view === "enemies" ||
        view === "cliffs" ||
        view === "resources" ||
        view === "all") &&
      req.startingPositions.length <= NAUVIS_MAX_STARTING_POINTS
    ) {
      return renderNauvisThroughWasm(req, engine, view);
    }
    image = renderTerrain({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      ctx: {
        segmentationMultiplier: req.segmentationMultiplier,
        startingPositions: req.startingPositions,
        moistureFrequency: req.moistureFrequency,
        moistureBias: req.moistureBias,
        auxFrequency: req.auxFrequency,
        auxBias: req.auxBias,
        startingAreaMoistureSize: req.startingAreaMoistureSize,
        startingAreaMoistureFrequency: req.startingAreaMoistureFrequency,
      },
    });
    if (view === "trees" || view === "all") {
      renderTrees(image, {
        seed0: req.seed0,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        treesFrequency: req.treeControls?.frequency ?? 1,
        treesSize: req.treeControls?.size ?? 1,
        segmentationMultiplier: req.segmentationMultiplier,
        moistureFrequency: req.moistureFrequency,
        moistureBias: req.moistureBias,
        temperatureFrequency: req.temperatureFrequency,
        temperatureBias: req.temperatureBias,
        startingAreaMoistureSize: req.startingAreaMoistureSize,
        startingAreaMoistureFrequency: req.startingAreaMoistureFrequency,
        startingPositions: req.startingPositions,
      });
    }
    if (view === "resources" || view === "all") {
      renderResources(image, {
        seed0: req.seed0,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        controls: req.resourceControls ?? {},
        startingPositions: req.startingPositions,
        segmentationMultiplier: req.segmentationMultiplier,
        waterLevel: req.waterLevel,
        startingLakePositions: req.startingLakePositions,
        moistureFrequency: req.moistureFrequency,
        moistureBias: req.moistureBias,
        auxFrequency: req.auxFrequency,
        auxBias: req.auxBias,
        startingAreaMoistureSize: req.startingAreaMoistureSize,
        startingAreaMoistureFrequency: req.startingAreaMoistureFrequency,
        sweepBox: placementMarkSweepBox(req),
      });
    }
    // Rocks paint after resources (and cliffs last of all) so an obstruction
    // crossing an ore patch reads as the obstruction - same order as the
    // Vulcanus branch above. Trees stay under resources: a forest is cleared,
    // not an obstacle you route around.
    if (view === "rocks" || view === "all") {
      renderRocks(image, {
        seed0: req.seed0,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        controls: req.rockControls ?? { frequency: 1, size: 1 },
        segmentationMultiplier: req.segmentationMultiplier,
        moistureFrequency: req.moistureFrequency,
        moistureBias: req.moistureBias,
        auxFrequency: req.auxFrequency,
        auxBias: req.auxBias,
        startingAreaMoistureSize: req.startingAreaMoistureSize,
        startingAreaMoistureFrequency: req.startingAreaMoistureFrequency,
        startingPositions: req.startingPositions,
        sweepBox: placementMarkSweepBox(req),
      });
    }
    if (view === "enemies" || view === "all") {
      renderEnemies(image, {
        seed0: req.seed0,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        controls: req.enemyControls ?? { frequency: 1, size: 1 },
        startingPositions: req.startingPositions,
        segmentationMultiplier: req.segmentationMultiplier,
        moistureFrequency: req.moistureFrequency,
        moistureBias: req.moistureBias,
        auxFrequency: req.auxFrequency,
        auxBias: req.auxBias,
        startingAreaMoistureSize: req.startingAreaMoistureSize,
        startingAreaMoistureFrequency: req.startingAreaMoistureFrequency,
        sweepBox: placementMarkSweepBox(req),
      });
    }
    if (view === "cliffs" || view === "all") {
      renderCliffs(image, {
        seed0: req.seed0,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        controls: req.cliffControls ?? { frequency: 1, continuity: 1 },
        settings: req.cliffSettings ?? {
          cliffElevation0: 10,
          cliffElevationInterval: 40,
          richness: 1,
        },
        segmentationMultiplier: req.segmentationMultiplier,
        waterLevel: req.waterLevel,
        startingPositions: req.startingPositions,
        startingLakePositions: req.startingLakePositions,
        cellQueryBox: cliffCellQueryBox(req),
      });
    }
  } else {
    // The elevation view, ported in #227. It rides the Nauvis param block,
    // which already carries every lever the trees read - seed, water level,
    // segmentation and the spawn list - so this needed three `view` codes and
    // no layout change. `mapType` picks the code because the common prefix has
    // no `mapType` field; see `VIEW` in `src/noise/wasm/request.ts`.
    //
    // **`startingLakePositions` is gone from this gate**, because it is refused
    // at the top of the function now. It was a CORRECTNESS carve-out rather
    // than a speed one - the module derives the lake list from the seed and the
    // spawn, which is the game's own rule - and an ABI one besides, the request
    // being a fixed-size struct with no room for a variable-length array. With
    // the TypeScript arm going there is no path that could honour it, so the
    // honest answer is to refuse rather than to ignore.
    //
    // **A non-Nauvis `planet` also stays on TypeScript.** `mapType` spans the
    // Nauvis family only, and the branch below ignores `planet` outright, so
    // routing an odd pairing through the module would change behaviour for no
    // gain. `planet` defaults to `"nauvis"`, so the app never sends one.
    if (
      engine !== undefined &&
      planet === "nauvis" &&
      req.startingPositions.length <= NAUVIS_MAX_STARTING_POINTS
    ) {
      return renderNauvisThroughWasm(
        req,
        engine,
        req.mapType === "nauvis"
          ? "elevationNauvis"
          : req.mapType === "island"
            ? "elevationIsland"
            : "elevationLakes",
      );
    }
    image = renderElevation({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      mapType: req.mapType,
      ctx: {
        waterLevel: req.waterLevel,
        segmentationMultiplier: req.segmentationMultiplier,
        startingPositions: req.startingPositions,
        startingLakePositions: req.startingLakePositions,
      },
    });
  }
  return { id: req.id, buffer: image.data.buffer, width: req.width, height: req.height };
}
