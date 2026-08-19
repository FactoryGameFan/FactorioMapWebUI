/**
 * Vulcanus's resource region fields (`planet-vulcanus-map-gen.lua` lines ~560-862,
 * `~/GitHub/factorio-data` tag 2.1.11). These are read by BOTH consumers: the tile
 * argmax (`vulcanus_metal_tile`, `vulcanus_calcite_region` and
 * `vulcanus_sulfuric_acid_region_patchy` appear inside four `*_range` expressions)
 * and the resource overlay - which is why they live here in `expressions/` rather
 * than beside the renderer.
 *
 * Two deliberate approximations, per the V2 design spec:
 *
 * 1. `random_penalty_between(0.9, 1, 1)` -> 1. It appears in every `*_probability`
 *    expression. `random_penalty` is a batch op whose value depends on the whole
 *    batch and its order (docs/noise/random-penalty-NOTES.md), so a per-pixel
 *    renderer cannot reproduce it; at rp = 1 the probability collapses to
 *    `1000 * region` and the penalty only perturbs the razor edge of a patch.
 * 2. Richness is not ported at all - the preview renders placement, not yield.
 */
import type { EvalCtx } from "../eval/ctx";
import { f32 } from "../eval/f32";
import { clamp, max, min } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { sliderRescale } from "../eval/math";
import { distanceFromNearestPoint } from "../distanceFromNearestPoint";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import type { SpotRegionKey } from "../spotCandidates";
import { selectSpots, type SelectedSpot } from "../spotSelection";
import type { VulcanusBiomes } from "./vulcanusBiomes";
import type { VulcanusCracks } from "./vulcanusCracks";
import type { VulcanusHelpers } from "./vulcanusHelpers";
import { startingSpotAtAngle } from "./vulcanusShared";
import { VULCANUS_STARTING_AREA_RADIUS, type VulcanusSpawn } from "./vulcanusSpawn";

export interface VulcanusResources {
  /** `vulcanus_basalts_resource_favorability` (tungsten). */
  basaltsFavorability(x: number, y: number): number;
  /** `vulcanus_mountains_resource_favorability` (calcite) - buffer 0.4, minus the volcano-peak term. */
  mountainsFavorability(x: number, y: number): number;
  /** `vulcanus_mountains_sulfur_favorability` - buffer 0.3, NO volcano-peak term. */
  mountainsSulfurFavorability(x: number, y: number): number;
  /** `vulcanus_ashlands_resource_favorability` (coal). */
  ashlandsFavorability(x: number, y: number): number;
  /** `vulcanus_starting_tungsten`. */
  startingTungsten(x: number, y: number): number;
  /** `vulcanus_starting_coal`. */
  startingCoal(x: number, y: number): number;
  /** `vulcanus_starting_calcite`. */
  startingCalcite(x: number, y: number): number;
  /** `vulcanus_starting_sulfur` (max of two spots). */
  startingSulfur(x: number, y: number): number;
  /** `vulcanus_tungsten_ore_region`. */
  tungstenRegion(x: number, y: number): number;
  /** `vulcanus_coal_region`. */
  coalRegion(x: number, y: number): number;
  /** `vulcanus_calcite_region`. */
  calciteRegion(x: number, y: number): number;
  /** `vulcanus_sulfuric_acid_region`. */
  sulfuricAcidRegion(x: number, y: number): number;
  /** `vulcanus_sulfuric_acid_patches` - the small-wavelength patchiness term. */
  sulfuricAcidPatches(x: number, y: number): number;
  /** `vulcanus_sulfuric_acid_region_patchy`. */
  sulfuricAcidRegionPatchy(x: number, y: number): number;
  /** `vulcanus_metal_tile` = `max(0, vulcanus_tungsten_ore_probability)`, with
   * `random_penalty_between(0.9, 1, 1)` approximated as `1` (an upper bound - see
   * the module doc comment). */
  metalTile(x: number, y: number): number;
}

/** `vulcanus_ore_spacing` (suggested_minimum_candidate_point_spacing). */
export const VULCANUS_ORE_SPACING = 128;

/** `basement_value` for every Vulcanus resource spot_noise call. */
const BASEMENT_VALUE = -1;
/** `maximum_spot_basement_radius` - the per-query cone cull radius. */
const MAX_SPOT_BASEMENT_RADIUS = 128;
/**
 * `skip_span` for every `vulcanus_place_*_spots` call. NOT a shared-stream partition -
 * each resource has its own `seed1` and therefore its own candidate stream; skip_span=3
 * just thins that stream to 1/3 density. The four skip_offsets (tungsten=2, coal=1,
 * calcite=1, sulfur=0) are not distinct either - coal and calcite share offset 1 on
 * their own separate streams, which is harmless precisely because the streams differ.
 */
const SKIP_SPAN = 3;

export function makeVulcanusResources(
  ctx: EvalCtx,
  helpers: VulcanusHelpers,
  spawn: VulcanusSpawn,
  biomes: VulcanusBiomes,
  cracks: VulcanusCracks,
): VulcanusResources {
  const r = VULCANUS_STARTING_AREA_RADIUS;
  const dir = spawn.startingDirection;
  const levers = ctx.vulcanusResourceControls;

  // vulcanus_resource_wobble_x = vulcanus_wobble_x + 0.25 * vulcanus_wobble_large_x
  // (and y). Note this is a DIFFERENT combination from vulcanusSpawn's three-wobble
  // sum - resources use two wobbles, one of them quarter-weighted.
  const wobbleX = memoXY((x, y) => helpers.wobbleX(x, y) + 0.25 * helpers.wobbleLargeX(x, y));
  const wobbleY = memoXY((x, y) => helpers.wobbleY(x, y) + 0.25 * helpers.wobbleLargeY(x, y));

  // slider_rescale(control:<x>:size, 2) - the "size" the region expressions scale by.
  // tungstenSize is unused by starting_tungsten (deliberately not slider-scaled, see
  // below) but IS read by vulcanus_tungsten_region's size expression further down.
  const tungstenSize = sliderRescale(levers.tungstenOre.size, 2);
  const coalSize = sliderRescale(levers.vulcanusCoal.size, 2);
  const calciteSize = sliderRescale(levers.calcite.size, 2);
  const sulfurSize = sliderRescale(levers.sulfuricAcidGeyser.size, 2);

  // --- favorabilities --------------------------------------------------------
  // All four share clamp((biome_full * (starting_area < 0.01) - buffer) * contrast, 0, 1).
  // `contrast` is 2 everywhere; only `buffer` and the mountains volcano term differ.
  const CONTRAST = 2;
  const favorability = (
    biomeFull: (x: number, y: number) => number,
    buffer: number,
  ): ((x: number, y: number) => number) =>
    memoXY((x, y) =>
      clamp(
        (biomeFull(x, y) * (spawn.startingArea(x, y) < 0.01 ? 1 : 0) - buffer) * CONTRAST,
        0,
        1,
      ),
    );

  const basaltsFavorability = favorability((x, y) => biomes.basaltsBiomeFull(x, y), 0.3);
  const ashlandsFavorability = favorability((x, y) => biomes.ashlandsBiomeFull(x, y), 0.3);
  const mountainsSulfurFavorability = favorability((x, y) => biomes.mountainsBiomeFull(x, y), 0.3);

  // mountains (calcite) is the odd one out: buffer 0.4 AND it subtracts the
  // volcano-peak indicator. Do not collapse it with mountainsSulfurFavorability.
  const mountainsMainRegion = favorability((x, y) => biomes.mountainsBiomeFull(x, y), 0.4);
  const mountainsFavorability = memoXY((x, y) =>
    clamp(mountainsMainRegion(x, y) - (biomes.mountainVolcanoSpots(x, y) > 0.78 ? 1 : 0), 0, 1),
  );

  // --- starting spots --------------------------------------------------------
  // `x_from_start`/`y_from_start` are the raw world (x, y) at the default origin
  // spawn (the Task 2 finding recorded in vulcanusShared.ts).
  const startingTungsten = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.basaltsAngle - 10 * dir,
      distance: 450 * r,
      // Deliberately NOT slider-scaled in the source: "don't use the slider for
      // radius because it can make tungsten in the safe area".
      radius: 30 / 1.5,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingCoal = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.ashlandsAngle + 15 * dir,
      distance: 180 * r,
      radius: 30 * coalSize,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingCalcite = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.mountainsAngle - 20 * dir,
      distance: 350 * r,
      radius: (35 / 1.5) * calciteSize,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingSulfur = memoXY((x, y) =>
    max(
      startingSpotAtAngle({
        angle: spawn.mountainsAngle + 10 * dir,
        distance: 590 * r,
        radius: 30,
        xDistortion: 0.75 * wobbleX(x, y),
        yDistortion: 0.75 * wobbleY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
      startingSpotAtAngle({
        angle: spawn.mountainsAngle + 30 * dir,
        distance: 200 * r,
        radius: 25 * sulfurSize,
        xDistortion: 0.75 * wobbleX(x, y),
        yDistortion: 0.75 * wobbleY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
    ),
  );

  const distanceAt = memoXY((x, y) => distanceFromNearestPoint(x, y, ctx.startingPositions));
  /** `vulcanus_ore_dist = max(1, distance / 4000)`. */
  const oreDist = (x: number, y: number): number => max(1, distanceAt(x, y) / 4000);

  interface SpotNoiseParams {
    /** `seed1` (the `seed` parameter of vulcanus_spot_noise). */
    readonly seed1: number;
    readonly candidateSpotCount: number;
    readonly skipOffset: number;
    /** `region_size`. Fractional values are floored - see the note below. */
    readonly regionSize: number;
    /** `density_expression`, evaluated at accepted spot positions. */
    readonly density: (x: number, y: number) => number;
    /** `spot_quantity_expression`, evaluated at accepted spot positions. */
    readonly quantity: (x: number, y: number) => number;
    /** `spot_radius_expression`, evaluated at accepted spot positions. */
    readonly radius: (x: number, y: number) => number;
    /** `spot_favorability_expression`, evaluated at accepted spot positions. */
    readonly favorability: (x: number, y: number) => number;
  }

  /**
   * `vulcanus_spot_noise{...}` - the shared noise-function wrapper.
   *
   * The wrapper samples at `(x + resource_wobble_x, y + resource_wobble_y)`, so the
   * WOBBLED coordinate is what selects the region and what the cone distance is
   * measured from. Using the raw coordinate for region lookup produces a
   * plausible-looking but wrong field.
   *
   * `hard_region_target_quantity = 0` => no last-spot shrink, so `coneScale` is
   * always 1; it is still applied below so the cone math stays faithful if that
   * ever changes.
   */
  const makeSpotNoise = (p: SpotNoiseParams): ((x: number, y: number) => number) => {
    // region_size can be fractional at a non-default frequency slider (500 + 500/f).
    // selectSpots uses it as an integer modulus, so floor it. Only the default
    // (f = 1, an exact integer) is oracle-covered - see vulcanus-resources-NOTES.md.
    const rs = Math.floor(p.regionSize);
    // Math.floor(rs / 2), matching spotSelection.ts's own `half` exactly. Identical to
    // plain `rs / 2` at every oracle-covered region size (1000/900/800, all even), but
    // must not silently diverge from spotSelection.ts at an odd rs that a non-default
    // frequency slider can reach (e.g. f = 1.5 gives rs = 833).
    const half = Math.floor(rs / 2);
    const regionIndex = (c: number): number => Math.floor((c + half) / rs);

    const cache = new Map<string, SelectedSpot[]>();
    const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
      const key = `${rX},${rY}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const regionKey: SpotRegionKey = {
        seed0: ctx.seed0,
        seed1: p.seed1,
        regionX: rX,
        regionY: rY,
      };
      const spots = selectSpots(regionKey, {
        density: p.density,
        quantity: p.quantity,
        favorability: p.favorability,
        regionSize: rs,
        candidateSpotCount: p.candidateSpotCount,
        spacing: VULCANUS_ORE_SPACING,
        skipSpan: SKIP_SPAN,
        skipOffset: p.skipOffset,
        hardRegionTargetQuantity: false,
      });
      cache.set(key, spots);
      return spots;
    };

    return (x: number, y: number): number => {
      const sx = x + wobbleX(x, y);
      const sy = y + wobbleY(x, y);
      let best = BASEMENT_VALUE;
      const rXlo = regionIndex(sx - MAX_SPOT_BASEMENT_RADIUS);
      const rXhi = regionIndex(sx + MAX_SPOT_BASEMENT_RADIUS);
      const rYlo = regionIndex(sy - MAX_SPOT_BASEMENT_RADIUS);
      const rYhi = regionIndex(sy + MAX_SPOT_BASEMENT_RADIUS);
      for (let rX = rXlo; rX <= rXhi; rX++) {
        for (let rY = rYlo; rY <= rYhi; rY++) {
          for (const s of regionSpots(rX, rY)) {
            const dx = sx - s.x;
            const dy = sy - s.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > MAX_SPOT_BASEMENT_RADIUS * MAX_SPOT_BASEMENT_RADIUS) continue;
            // Same f32 cone arithmetic as the Nauvis regular patches: the game
            // renders the cone in the f32 noise machine (see regularPatches.ts).
            //
            // The game's effective radius is min(maximum_spot_basement_radius,
            // radius_expression) (docs/noise/spot-noise-NOTES.md:319); that cap is
            // deliberately omitted here because it is unreachable from every reachable
            // UI state: radius = sliderRescale(v, 2) * min(1.2, oreDist) * 25, and the
            // `size` slider itself is bounded to [1/6, 6] (not sliderRescale, which is
            // unbounded for an arbitrary v - it is only <= 2 here because the caller's v
            // is), so radius <= 2 * 1.2 * 25 = 60, always well under
            // MAX_SPOT_BASEMENT_RADIUS (128). This does NOT hold for a `size` value
            // outside the slider's range that only an imported map-exchange string can
            // carry (e.g. size = 100 gives radius ~178 > 128, where the game's cap would
            // bind and this port's would not) - do not add the cap "defensively" for the
            // slider-reachable range; it would be dead code there.
            const radius = f32(p.radius(s.x, s.y) * s.coneScale);
            if (radius <= 0) continue;
            const peak = f32(f32(3 * s.quantity) / f32(f32(Math.PI * radius) * radius));
            const cone = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
            if (cone > best) best = cone;
          }
        }
      }
      return best;
    };
  };

  /** The shared `size` expression: `slider_rescale(size, 2) * min(1.2, ore_dist) * 25`. */
  const sizeExpr =
    (sizeRescaled: number) =>
    (x: number, y: number): number =>
      sizeRescaled * min(1.2, oreDist(x, y)) * 25;

  interface PlaceParams {
    readonly seed1: number;
    readonly candidateSpotCount: number;
    readonly skipOffset: number;
    readonly size: (x: number, y: number) => number;
    /** RAW `control:<x>:frequency` (NOT slider_rescaled - the source passes it through). */
    readonly frequency: number;
    readonly favor: (x: number, y: number) => number;
  }

  /** The spot_noise half shared by all three `vulcanus_place_*_spots` functions. */
  const placeSpots = (p: PlaceParams, regionBase: number): ((x: number, y: number) => number) =>
    makeSpotNoise({
      seed1: p.seed1,
      candidateSpotCount: p.candidateSpotCount,
      skipOffset: p.skipOffset,
      regionSize: regionBase + regionBase / p.frequency,
      density: (x, y) => p.favor(x, y) * 4,
      quantity: (x, y) => p.size(x, y) * p.size(x, y),
      radius: (x, y) => p.size(x, y),
      favorability: (x, y) => (p.favor(x, y) > 0.9 ? 1 : 0),
    });

  /** `vulcanus_place_metal_spots` - region_size 500 + 500/freq, plus the crack term. */
  const placeMetalSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 500);
    return (x, y) =>
      min(clamp(-1 + 4 * p.favor(x, y), -1, 1), spot(x, y) - cracks.hairlineCracks(x, y) / 30000);
  };

  /** `vulcanus_place_sulfur_spots` - region_size 450 + 450/freq. */
  const placeSulfurSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 450);
    return (x, y) => min(2 * p.favor(x, y) - 1, spot(x, y));
  };

  /** `vulcanus_place_non_metal_spots` - region_size 400 + 400/freq. */
  const placeNonMetalSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 400);
    return (x, y) => min(2 * p.favor(x, y) - 1, spot(x, y));
  };

  // --- the four regions ------------------------------------------------------
  // Each is max(starting_<ore>, min(1 - starting_circle, place_*(...))).
  const region = (
    starting: (x: number, y: number) => number,
    placed: (x: number, y: number) => number,
  ): ((x: number, y: number) => number) =>
    memoXY((x, y) => max(starting(x, y), min(1 - spawn.startingCircle(x, y), placed(x, y))));

  const tungstenRegion = region(
    startingTungsten,
    placeMetalSpots({
      seed1: 789,
      candidateSpotCount: 15,
      skipOffset: 2,
      size: sizeExpr(tungstenSize),
      frequency: levers.tungstenOre.frequency,
      favor: basaltsFavorability,
    }),
  );

  const coalRegion = region(
    startingCoal,
    placeNonMetalSpots({
      seed1: 782349,
      candidateSpotCount: 12,
      skipOffset: 1,
      size: sizeExpr(coalSize),
      frequency: levers.vulcanusCoal.frequency,
      favor: ashlandsFavorability,
    }),
  );

  const calciteRegion = region(
    startingCalcite,
    placeNonMetalSpots({
      seed1: 749,
      candidateSpotCount: 12,
      skipOffset: 1,
      size: sizeExpr(calciteSize),
      frequency: levers.calcite.frequency,
      favor: mountainsFavorability,
    }),
  );

  const sulfuricAcidRegion = region(
    startingSulfur,
    placeSulfurSpots({
      seed1: 759,
      candidateSpotCount: 9,
      skipOffset: 0,
      size: sizeExpr(sulfurSize),
      frequency: levers.sulfuricAcidGeyser.frequency,
      favor: mountainsSulfurFavorability,
    }),
  );

  // --- the sulfuric-acid patchy chain (terrain input only, no overlay) --------
  const patchNoise = makeMultioctaveNoise({
    seed0: ctx.seed0,
    seed1: 21000,
    octaves: 2,
    persistence: 0.7,
    inputScale: 1 / 3,
    outputScale: 1,
  });
  const sulfuricAcidPatches = memoXY((x, y) => 0.8 * Math.abs(patchNoise(x, y)));
  const sulfuricAcidRegionPatchy = memoXY(
    (x, y) => (1 + sulfuricAcidRegion(x, y)) * (0.5 + 0.5 * sulfuricAcidPatches(x, y)) - 1,
  );

  // vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability), where
  // probability = (control:tungsten_ore:size > 0) * 1000 * ((1 + region) * rp - 1)
  // and rp -> 1 (approximation 1), so it collapses to 1000 * region.
  const metalTile = memoXY((x, y) =>
    levers.tungstenOre.size > 0 ? max(0, 1000 * tungstenRegion(x, y)) : 0,
  );

  return {
    basaltsFavorability,
    mountainsFavorability,
    mountainsSulfurFavorability,
    ashlandsFavorability,
    startingTungsten,
    startingCoal,
    startingCalcite,
    startingSulfur,
    tungstenRegion,
    coalRegion,
    calciteRegion,
    sulfuricAcidRegion,
    sulfuricAcidPatches,
    sulfuricAcidRegionPatchy,
    metalTile,
  };
}
