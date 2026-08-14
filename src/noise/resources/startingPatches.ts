/**
 * The `starting_patches` branch of `resource_autoplace_all_patches` (the near-spawn
 * ore patches), a close sibling of `regularPatches.ts` over the same solved
 * primitives (`selectSpots`, `basisNoise`), plus the map's `elevation` property
 * (elevation_nauvis on the default map) for the favorability coupling and
 * `distance_from_nearest_point` for distance.
 *
 *   starting_patches = spotField + (blobs0 - 1/4) * startingBlobAmplitude
 *   spotField        = max(basement_value, max over nearby spots of (peak - dist*slope))
 *   blobs0           = basis_noise{1/8,1} + basis_noise{1/24,1}
 *
 * All the following were verified against a has_starting=1 headless oracle in M3b
 * Task 5 (an earlier Task-3 draft had several of them wrong):
 * - region_size = starting_resource_placement_radius * 3 = 450 (not 1024),
 *   candidate_spot_count = 32, spacing = 48, hard_region_target_quantity = true
 *   (the last kept spot's cone shrinks self-similarly to hit the budget exactly).
 * - The candidate stream is seeded with `seed1 = params.seed1 + 1` (a distinct
 *   stream from the regular set), but the blob noise (`blobs0`) still uses the
 *   bare `params.seed1`.
 * - Spot QUANTITY is the constant `startingAreaSpotQuantity`; spot FAVORABILITY is
 *   DETERMINISTIC: `starting_resources_lake_mask * starting_modulation *
 *   origin_excluder * 2 - min(1, distance / starting_resource_placement_radius)`,
 *   where the lake mask reads the map `elevation` (there is NO random_penalty term).
 * - spot_radius uses the CONSTANT starting_area_spot_quantity (the coneScale shrink
 *   is applied once, not on top of a per-spot cbrt).
 * - maximum_spot_basement_radius = 2 * rq * saq^(1/3) is a HARD cull (the cone is
 *   still above basement there), not the safe 128 over-cull regular patches use.
 * - The cone radius has no `min(32, ...)` cap (regular caps at 32; starting can be
 *   larger). No `basis_noise{1/64,1.5}` term in the blob (that is regular-only).
 */
import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "../basisNoise";
import { distanceFromNearestPoint, type Point } from "../distanceFromNearestPoint";
import { f32 } from "../eval/f32";
import { makeElevationNauvis } from "../expressions/elevationNauvis";
import { fastCbrt } from "../fastApprox";
import { selectSpots, type SelectedSpot } from "../spotSelection";
import type { SpotRegionKey } from "../spotCandidates";
import type { ResourceParams } from "./resourceCatalog";
import {
  basementValue,
  startingAreaSpotQuantity,
  startingBlobAmplitude,
  startingDensityAt,
  startingFavorabilityBaseAt,
  type ResourceControls,
} from "./resourceMath";

/** suggested_minimum_candidate_point_spacing for the starting set. */
const STARTING_SPACING = 48;
/** region_size = starting_resource_placement_radius * 3 = 150 * 3. */
const STARTING_REGION_SIZE = 450;
const STARTING_CANDIDATE_SPOT_COUNT = 32;

export interface StartingPatchesCtx {
  readonly seed0: number;
  /** control:<x>:frequency, size, richness (the noise-function multipliers). */
  readonly controls: { frequency: number; size: number; richness: number };
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /** elevation inputs for the favorability coupling (elevation_nauvis on default). */
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingLakePositions?: readonly Point[];
  /** starting_patch_set_count (skip_span). 1 for the isolated oracle; 4 in the app. */
  readonly skipSpan?: number;
  /** starting_patch_set_index (skip_offset). */
  readonly skipOffset?: number;
}

export interface StartingPatches {
  /** Raw `starting_patches` field value (the counterpart to regular's `field`). */
  field(x: number, y: number): number;
}

/** region index for a coordinate (regions centred on multiples of STARTING_REGION_SIZE). */
const regionIndex = (c: number): number =>
  Math.floor((c + STARTING_REGION_SIZE / 2) / STARTING_REGION_SIZE);

export function makeStartingPatches(
  params: ResourceParams,
  ctx: StartingPatchesCtx,
): StartingPatches {
  const controls: ResourceControls = { frequency: ctx.controls.frequency, size: ctx.controls.size };
  const spawn: readonly Point[] = ctx.startingPositions ?? [{ x: 0, y: 0 }];
  const distanceAt = (x: number, y: number): number =>
    distanceFromNearestPoint(x, y, spawn as Point[]);

  // starting_resources_lake_mask = clamp((elevation - 1)/10, 0, 1) couples to the
  // map's `elevation` PROPERTY, which on the default Nauvis map is elevation_nauvis
  // (NOT the literal elevation_lakes - verified against the game oracle: the
  // has_starting=1 fixture keeps the spot elevation_nauvis's favorability picks, not
  // elevation_lakes's). A non-default map type (Lakes/Island) would feed its own
  // elevation here; that generalization is deferred until the resolver needs it.
  const elevation = makeElevationNauvis({
    seed0: ctx.seed0,
    waterLevel: ctx.waterLevel,
    segmentationMultiplier: ctx.segmentationMultiplier,
    startingPositions: spawn as Point[],
    startingLakePositions: ctx.startingLakePositions as Point[] | undefined,
  });

  // blobs0 uses the bare seed1 (NOT +1 - that offset is candidate-stream only).
  const tables: BasisNoiseTables = basisNoiseTablesFromSeed(ctx.seed0, params.seed1);
  const basement = basementValue(params, controls);

  const skipSpan = ctx.skipSpan ?? 1;
  const skipOffset = ctx.skipOffset ?? 0;

  const quantity = startingAreaSpotQuantity(params, controls);

  // maximum_spot_basement_radius = 2 * starting_rq_factor * starting_area_spot_quantity^(1/3).
  // This is a HARD cull, not just a scan bound: unlike regular patches (radius capped
  // at 32, cull 128, where the cone is already far below basement at the cull), the
  // starting cone (radius ~10.5) is still ABOVE basement at this ~29.5-tile cull, so
  // the cutoff produces a real discontinuous drop to basement - the game's behavior.
  const maxBasementRadius = 2 * params.startingRqFactor * fastCbrt(quantity);

  // spot_favorability_expression = starting_resources_lake_mask * starting_modulation
  // * origin_excluder * 2 - min(1, distance / starting_resource_placement_radius). It
  // is DETERMINISTIC - there is no random_penalty term (an earlier draft added one;
  // the game expression, core/prototypes/noise-functions.lua, has none).
  const favorability = (x: number, y: number): number =>
    startingFavorabilityBaseAt(distanceAt(x, y), elevation(x, y), params, controls);

  // Selected spots per region, memoized (all resources in a set share the stream).
  const regionCache = new Map<string, SelectedSpot[]>();
  const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
    const key = `${rX},${rY}`;
    let spots = regionCache.get(key);
    if (spots) return spots;
    const regionKey: SpotRegionKey = {
      seed0: ctx.seed0,
      seed1: params.seed1 + 1,
      regionX: rX,
      regionY: rY,
    };
    spots = selectSpots(regionKey, {
      density: (x, y) => startingDensityAt(distanceAt(x, y), params, controls),
      quantity: () => quantity,
      favorability,
      regionSize: STARTING_REGION_SIZE,
      candidateSpotCount: STARTING_CANDIDATE_SPOT_COUNT,
      spacing: STARTING_SPACING,
      skipSpan,
      skipOffset,
      hardRegionTargetQuantity: true,
    });
    regionCache.set(key, spots);
    return spots;
  };

  const spotFieldAt = (x: number, y: number): number => {
    let best = basement;
    const rXlo = regionIndex(x - maxBasementRadius);
    const rXhi = regionIndex(x + maxBasementRadius);
    const rYlo = regionIndex(y - maxBasementRadius);
    const rYhi = regionIndex(y + maxBasementRadius);
    for (let rX = rXlo; rX <= rXhi; rX++) {
      for (let rY = rYlo; rY <= rYhi; rY++) {
        for (const s of regionSpots(rX, rY)) {
          const dx = x - s.x;
          const dy = y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxBasementRadius * maxBasementRadius) continue;
          // The cone is rendered per-tile in the f32 noise machine (cube root via
          // fastapprox `pow`), matching regularPatches. Starting patches have no
          // min(32, ...) radius cap; the hard-target trim's coneScale shrinks the
          // last kept spot's radius and peak self-similarly.
          // spot_radius_expression = starting_rq_factor * starting_area_spot_quantity^(1/3)
          // uses the CONSTANT quantity (same for every spot); the hard-target trim then
          // shrinks the last spot's radius (and peak) self-similarly by coneScale. Using
          // s.quantity here would double-apply the shrink to that last spot.
          const rBase = f32(params.startingRqFactor * fastCbrt(quantity));
          const radius = f32(rBase * s.coneScale);
          const peak = f32(f32(3 * s.quantity) / f32(f32(Math.PI * radius) * radius));
          const cone = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
          if (cone > best) best = cone;
        }
      }
    }
    return best;
  };

  const blobTermAt = (x: number, y: number): number => {
    const blobs0 = basisNoise(x / 8, y / 8, tables) + basisNoise(x / 24, y / 24, tables);
    return (blobs0 - 1 / 4) * startingBlobAmplitude(params, controls);
  };

  const field = (x: number, y: number): number => spotFieldAt(x, y) + blobTermAt(x, y);

  return { field };
}
