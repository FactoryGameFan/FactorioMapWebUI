/**
 * Vulcanus's biome system - the radial biome-noise -> raw -> full -> clamped chain,
 * plus `mountain_volcano_spots` (driving the solved spot-noise pipeline) - transcribed
 * verbatim from `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`
 * (`~/GitHub/factorio-data`, tag 2.1.11, lines ~229-389). This is the structure Task 9
 * (elevation) and Task 10 (tiles) both build on.
 *
 * The chain, per biome (mountains/ashlands/basalts):
 *
 *   biome_noise  = biome_multiscale(seed1, scale, bias)          -- distance-lerped 2-scale noise
 *   *_raw        = lerp(biome_noise, starting_weights, clamp(2*starting_area, 0, 1))
 *   *_biome_full = *_raw - max(the other two raws)               -- unclamped, for away-from-edge targeting
 *   *_biome      = clamp(*_biome_full * biome_contrast, 0, 1)    -- clamped 0..1
 *
 * where `biome_multiscale(seed1, scale, bias)` =
 *   bias + lerp(biome_noise(seed1, scale*0.5),
 *               biome_noise(seed1 + 1000, scale),
 *               clamp(distance / 10000, 0, 1))
 * (`distance` = `distance_from_nearest_point{points = starting_positions}`), and each
 * `starting_weights` is a per-biome sign pattern of the three `*_start` blobs (Task 6):
 *   ashlands:  -mountains_start + ashlands_start - basalts_start
 *   basalts:   -mountains_start - ashlands_start + basalts_start
 *   mountains:  mountains_start - ashlands_start - basalts_start
 *
 * `biome_contrast = 2`, `biome_noise` seed1/scale/bias: mountains {342, 60, 0},
 * ashlands {12416, 40, 0}, basalts {42416, 80, 0}.
 *
 * MOUNTAINS is special: its raw has a PRE-volcano stage (`mountains_raw_pre_volcano`,
 * used by `volcano_area`), then the volcano field is folded back in via
 * `mountains_raw_volcano`; `mountains_biome_full` uses the post-volcano raw. This
 * split exists so `mountain_volcano_spots` can depend on the mountains biome without a
 * cycle (volcano_area reads the PRE-volcano value):
 *
 *   mountains_raw_volcano = 0.5*mountains_raw_pre_volcano
 *     + max(2*mountain_volcano_spots, 10*clamp((mountain_volcano_spots - 0.33)*3, 0, 1))
 *
 * `mountain_volcano_spots` = max(starting_volcano_spot, raw_spots - starting_protector):
 * - `starting_volcano_spot` / `starting_protector` are `starting_spot_at_angle` discs
 *   (Task 3) placed at the mountains angle (protector mirrored 180*starting_direction),
 *   distorted by the same wobble sum that pre-offsets the spot-noise query.
 * - `raw_spots` is `spot_noise{...}` fed through {@link selectSpots}. This config is
 *   UNUSUAL vs Nauvis resources (`regularPatches.ts`), mapped exactly:
 *     seed1 = 1, candidate_spot_count = 1, skip_span = 1, skip_offset = 0,
 *     region_size = 256, hard_region_target_quantity = 0, basement_value = 0
 *     spacing = volcano_spot_spacing = 1500*volcanism
 *     density_expression       = volcano_area / volcanism_sq   (evaluated at each spot)
 *     spot_favorability_expr   = volcano_area                  (evaluated at each spot)
 *     spot_quantity_expression = volcano_spot_radius^2
 *     spot_radius_expression   = volcano_spot_radius   (given DIRECTLY, not rq*cbrt(q))
 *     maximum_spot_basement_radius = volcano_spot_radius   (= the cull radius)
 *   With quantity = radius^2 the cone peak `3q/(pi r^2)` collapses to a constant 3/pi;
 *   the density/favorability only gate WHICH single candidate per region survives
 *   (target = density(spot)*region_size^2; <=0 density => no spot). The query point is
 *   PRE-OFFSET by the wobble terms (x + wobble_x/2 + wobble_large_x/12 + wobble_huge_x/80),
 *   exactly as the source writes it. Cone rendering (max-of-cones over the basement,
 *   effective radius = min(max_basement_radius, radius_expr)) mirrors `regularPatches.ts`
 *   in the f32 noise machine.
 *
 *   volcano_area        = lerp(mountains_biome_full_pre_volcano, 0, starting_area)
 *   volcano_spot_radius = 200 * volcanism
 *   volcano_spot_spacing= 1500 * volcanism
 *   volcanism           = 0.3 + 0.7 * slider_rescale(control:vulcanus_volcanism:size, 3)
 *                                     / slider_rescale(vulcanus_scale_multiplier, 3)
 *   volcanism_sq        = volcanism * volcanism
 * (`vulcanus_scale_multiplier` is itself `slider_rescale(control:...:frequency, 3)`, so
 * volcanism nests two slider_rescales; at the default preset both = 1 => volcanism = 1.)
 *
 * The `cracks` argument is accepted for interface parity with Tasks 9/10 (which build
 * cracks + biomes together and thread both onward); no biome expression references the
 * crack fields - they feed elevation's basalt lakes, not the biome chain - so it is
 * deliberately unused here.
 */
import type { EvalCtx } from "../eval/ctx";
import { distanceFromNearestPoint } from "../distanceFromNearestPoint";
import { f32 } from "../eval/f32";
import { clamp, lerp, max } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { sliderRescale } from "../eval/sliderRescale";
import { selectSpots, type SelectedSpot } from "../spotSelection";
import type { SpotRegionKey } from "../spotCandidates";
import type { VulcanusCracks } from "./vulcanusCracks";
import type { VulcanusHelpers } from "./vulcanusHelpers";
import { startingSpotAtAngle } from "./vulcanusShared";
import { VULCANUS_STARTING_AREA_RADIUS, type VulcanusSpawn } from "./vulcanusSpawn";

/** `vulcanus_biome_contrast = 2` (higher = sharper biome transitions). */
export const VULCANUS_BIOME_CONTRAST = 2;

/** spot_noise `region_size` for `mountain_volcano_spots` (256, not the resource 1024). */
const VOLCANO_REGION_SIZE = 256;

export interface VulcanusBiomes {
  /** `vulcanus_mountains_biome` (clamped 0..1). */
  mountainsBiome(x: number, y: number): number;
  /** `vulcanus_ashlands_biome` (clamped 0..1). */
  ashlandsBiome(x: number, y: number): number;
  /** `vulcanus_basalts_biome` (clamped 0..1). */
  basaltsBiome(x: number, y: number): number;
  /** `vulcanus_mountains_biome_full` (unclamped). */
  mountainsBiomeFull(x: number, y: number): number;
  /** `vulcanus_ashlands_biome_full` (unclamped). */
  ashlandsBiomeFull(x: number, y: number): number;
  /** `vulcanus_basalts_biome_full` (unclamped). */
  basaltsBiomeFull(x: number, y: number): number;
  /** `mountain_volcano_spots`. */
  mountainVolcanoSpots(x: number, y: number): number;
  /** `vulcanus_mountains_raw_volcano`. */
  mountainsRawVolcano(x: number, y: number): number;
}

/** region index for a coordinate (regions centred on multiples of the region size). */
const regionIndex = (c: number): number =>
  Math.floor((c + VOLCANO_REGION_SIZE / 2) / VOLCANO_REGION_SIZE);

/** Build the Vulcanus biome system for one seed/ctx. */
export function makeVulcanusBiomes(
  ctx: EvalCtx,
  helpers: VulcanusHelpers,
  spawn: VulcanusSpawn,
  _cracks: VulcanusCracks,
): VulcanusBiomes {
  const r = VULCANUS_STARTING_AREA_RADIUS;

  const distanceAt = memoXY((x: number, y: number): number =>
    distanceFromNearestPoint(x, y, ctx.startingPositions),
  );

  // --- biome noise (distance-lerped 2-scale multioctave) ---------------------
  // biome_multiscale(seed1, scale, bias): the near scale is seed1 @ scale*0.5, the
  // far scale is (seed1 + 1000) @ scale, blended by clamp(distance/10000, 0, 1).
  const mountainsNear = helpers.biomeNoise(342, 60 * 0.5);
  const mountainsFar = helpers.biomeNoise(342 + 1000, 60);
  const ashlandsNear = helpers.biomeNoise(12416, 40 * 0.5);
  const ashlandsFar = helpers.biomeNoise(12416 + 1000, 40);
  const basaltsNear = helpers.biomeNoise(42416, 80 * 0.5);
  const basaltsFar = helpers.biomeNoise(42416 + 1000, 80);

  const multiscale =
    (near: (x: number, y: number) => number, far: (x: number, y: number) => number, bias: number) =>
    (x: number, y: number): number =>
      bias + lerp(near(x, y), far(x, y), clamp(distanceAt(x, y) / 10000, 0, 1));

  const mountainsBiomeNoise = memoXY(multiscale(mountainsNear, mountainsFar, 0));
  const ashlandsBiomeNoise = memoXY(multiscale(ashlandsNear, ashlandsFar, 0));
  const basaltsBiomeNoise = memoXY(multiscale(basaltsNear, basaltsFar, 0));

  // --- raw biomes (blend biome noise toward the starting weights near spawn) --
  const startingBlend = memoXY((x: number, y: number): number =>
    clamp(2 * spawn.startingArea(x, y), 0, 1),
  );

  const ashlandsRaw = memoXY((x: number, y: number): number =>
    lerp(
      ashlandsBiomeNoise(x, y),
      -spawn.mountainsStart(x, y) + spawn.ashlandsStart(x, y) - spawn.basaltsStart(x, y),
      startingBlend(x, y),
    ),
  );
  const basaltsRaw = memoXY((x: number, y: number): number =>
    lerp(
      basaltsBiomeNoise(x, y),
      -spawn.mountainsStart(x, y) - spawn.ashlandsStart(x, y) + spawn.basaltsStart(x, y),
      startingBlend(x, y),
    ),
  );
  const mountainsRawPreVolcano = memoXY((x: number, y: number): number =>
    lerp(
      mountainsBiomeNoise(x, y),
      spawn.mountainsStart(x, y) - spawn.ashlandsStart(x, y) - spawn.basaltsStart(x, y),
      startingBlend(x, y),
    ),
  );

  const mountainsBiomeFullPreVolcano = memoXY(
    (x: number, y: number): number =>
      mountainsRawPreVolcano(x, y) - max(ashlandsRaw(x, y), basaltsRaw(x, y)),
  );

  // --- volcano spots ---------------------------------------------------------
  // volcanism nests two slider_rescales (scale_multiplier is itself a slider_rescale).
  const volcanism =
    0.3 +
    (0.7 * sliderRescale(ctx.vulcanusVolcanismSize, 3)) / sliderRescale(helpers.scaleMultiplier, 3);
  const volcanoSpotRadius = 200 * volcanism;
  const volcanoSpotSpacing = 1500 * volcanism;
  const volcanismSq = volcanism * volcanism;

  const volcanoArea = memoXY((x: number, y: number): number =>
    lerp(mountainsBiomeFullPreVolcano(x, y), 0, spawn.startingArea(x, y)),
  );

  // The spot-noise query is pre-offset by the wobble sum (this same offset is the
  // starting_spot_at_angle x_distortion below).
  const offX = memoXY(
    (x: number, y: number): number =>
      helpers.wobbleX(x, y) / 2 + helpers.wobbleLargeX(x, y) / 12 + helpers.wobbleHugeX(x, y) / 80,
  );
  const offY = memoXY(
    (x: number, y: number): number =>
      helpers.wobbleY(x, y) / 2 + helpers.wobbleLargeY(x, y) / 12 + helpers.wobbleHugeY(x, y) / 80,
  );

  // Effective radius = min(maximum_spot_basement_radius, radius_expression); both are
  // volcano_spot_radius, so they coincide. quantity = radius^2 (f32, as the game does).
  const RADIUS = f32(volcanoSpotRadius);
  const QUANTITY = f32(RADIUS * RADIUS);
  const CULL_SQ = RADIUS * RADIUS;

  const regionCache = new Map<string, SelectedSpot[]>();
  const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
    const key = `${rX},${rY}`;
    const cached = regionCache.get(key);
    if (cached) return cached;
    const regionKey: SpotRegionKey = { seed0: ctx.seed0, seed1: 1, regionX: rX, regionY: rY };
    const spots = selectSpots(regionKey, {
      density: (x, y) => volcanoArea(x, y) / volcanismSq,
      quantity: () => QUANTITY,
      favorability: (x, y) => volcanoArea(x, y),
      regionSize: VOLCANO_REGION_SIZE,
      candidateSpotCount: 1,
      spacing: volcanoSpotSpacing,
      skipSpan: 1,
      skipOffset: 0,
      hardRegionTargetQuantity: false,
    });
    regionCache.set(key, spots);
    return spots;
  };

  // raw_spots = spot_noise field: max-of-cones over basement_value 0, cull radius RADIUS.
  const rawSpots = memoXY((x: number, y: number): number => {
    const qx = x + offX(x, y);
    const qy = y + offY(x, y);
    let best = 0; // basement_value = 0
    const rXlo = regionIndex(qx - RADIUS);
    const rXhi = regionIndex(qx + RADIUS);
    const rYlo = regionIndex(qy - RADIUS);
    const rYhi = regionIndex(qy + RADIUS);
    for (let rX = rXlo; rX <= rXhi; rX++) {
      for (let rY = rYlo; rY <= rYhi; rY++) {
        for (const s of regionSpots(rX, rY)) {
          const dx = qx - s.x;
          const dy = qy - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > CULL_SQ) continue;
          const peak = f32(f32(3 * s.quantity) / f32(f32(Math.PI * RADIUS) * RADIUS));
          const cone = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / RADIUS)));
          if (cone > best) best = cone;
        }
      }
    }
    return best;
  });

  const startingProtector = memoXY((x: number, y: number): number =>
    clamp(
      startingSpotAtAngle({
        angle: spawn.mountainsAngle + 180 * spawn.startingDirection,
        distance: (400 * r) / 2,
        radius: 800 * r,
        xDistortion: offX(x, y),
        yDistortion: offY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
      0,
      1,
    ),
  );

  const startingVolcanoSpot = memoXY((x: number, y: number): number =>
    clamp(
      startingSpotAtAngle({
        angle: spawn.mountainsAngle,
        distance: 400 * r,
        radius: 200,
        xDistortion: offX(x, y),
        yDistortion: offY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
      0,
      1,
    ),
  );

  const mountainVolcanoSpots = memoXY((x: number, y: number): number =>
    max(startingVolcanoSpot(x, y), rawSpots(x, y) - startingProtector(x, y)),
  );

  const mountainsRawVolcano = memoXY((x: number, y: number): number => {
    const spots = mountainVolcanoSpots(x, y);
    return (
      0.5 * mountainsRawPreVolcano(x, y) + max(2 * spots, 10 * clamp((spots - 0.33) * 3, 0, 1))
    );
  });

  // --- full + clamped biomes -------------------------------------------------
  const mountainsBiomeFull = memoXY(
    (x: number, y: number): number =>
      mountainsRawVolcano(x, y) - max(ashlandsRaw(x, y), basaltsRaw(x, y)),
  );
  const ashlandsBiomeFull = memoXY(
    (x: number, y: number): number =>
      ashlandsRaw(x, y) - max(mountainsRawVolcano(x, y), basaltsRaw(x, y)),
  );
  const basaltsBiomeFull = memoXY(
    (x: number, y: number): number =>
      basaltsRaw(x, y) - max(mountainsRawVolcano(x, y), ashlandsRaw(x, y)),
  );

  const mountainsBiome = memoXY((x: number, y: number): number =>
    clamp(mountainsBiomeFull(x, y) * VULCANUS_BIOME_CONTRAST, 0, 1),
  );
  const ashlandsBiome = memoXY((x: number, y: number): number =>
    clamp(ashlandsBiomeFull(x, y) * VULCANUS_BIOME_CONTRAST, 0, 1),
  );
  const basaltsBiome = memoXY((x: number, y: number): number =>
    clamp(basaltsBiomeFull(x, y) * VULCANUS_BIOME_CONTRAST, 0, 1),
  );

  return {
    mountainsBiome,
    ashlandsBiome,
    basaltsBiome,
    mountainsBiomeFull,
    ashlandsBiomeFull,
    basaltsBiomeFull,
    mountainVolcanoSpots,
    mountainsRawVolcano,
  };
}
