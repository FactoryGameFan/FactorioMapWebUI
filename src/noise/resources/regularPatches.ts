/**
 * The `regular_patches` branch of `resource_autoplace_all_patches` (the whole-map
 * ore patches), ported over the solved primitives: `selectSpots` (spot selection),
 * `basisNoise` (blob noise) and `randomPenalty` (per-spot size jitter). Starting
 * patches and the outer `max(starting, regular)` are M3b.
 *
 *   regular_patches = spotField + (blobs0 + basis_noise{1/64,1.5} - 1/3) * blobAmplitude(distance)
 *   spotField       = max(basement_value, max over nearby spots of (peak - dist*slope))
 *   blobs0          = basis_noise{1/8,1} + basis_noise{1/24,1}
 *
 * The empirical unknown, resolved against the oracle (docs/noise/random-penalty-NOTES.md
 * "Composition inside spot selection - RESOLVED"): a spot's
 * `regular_spot_quantity_expression = random_penalty_between(min,max,1) *
 * quantityBase(distance)`. `random_penalty` is a batch op, and the game evaluates the
 * quantity expression over ALL skip-set accepted spots as ONE batch (in acceptance
 * order, seeded from the first spot, streamed) before the trim - NOT per spot. This is
 * supplied via selectSpots' `quantityBatch`.
 *
 * Precision: the game's spot_noise op renders the cone in the f32 noise machine, with
 * the radius cube root through its fastapprox `pow` ({@link fastCbrt}). Matching that
 * (fastCbrt + f32 cone/quantity arithmetic here) pins the field to the game within
 * ~0.7 units everywhere; exact Math.cbrt + f64 left a ~3-unit / 4.8e-2-relative
 * residual at cone edges. See docs/noise/random-penalty-NOTES.md and test/regularPatches.spec.ts.
 */
import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "../basisNoise";
import { distanceFromNearestPoint, type Point } from "../distanceFromNearestPoint";
import { f32 } from "../eval/f32";
import { fastCbrt } from "../fastApprox";
import { randomPenaltyBatch } from "../randomPenalty";
import { selectSpots, type SelectedSpot } from "../spotSelection";
import type { SpotRegionKey } from "../spotCandidates";
import type { ResourceParams } from "./resourceCatalog";
import {
  basementValue,
  DOUBLE_DENSITY_DISTANCE,
  REGULAR_PATCH_FADE_IN_DISTANCE,
  regularBlobAmplitudeAt,
  regularDensityAt,
  regularSpotQuantityBaseAt,
  type ResourceControls,
} from "./resourceMath";

/** suggested_minimum_candidate_point_spacing for the regular set (= 32*sqrt(2)). */
const REGULAR_SPACING = 45.254833995939045;
const REGION_SIZE = 1024;
/** maximum_spot_basement_radius - the per-query cone cull radius. */
const MAX_SPOT_BASEMENT_RADIUS = 128;
/** spot_radius_expression cap: min(32, rq * quantity^(1/3)). */
const MAX_SPOT_RADIUS = 32;

export interface RegularPatchesCtx {
  readonly seed0: number;
  /** control:<x>:frequency, size, richness (the noise-function multipliers). */
  readonly controls: { frequency: number; size: number; richness: number };
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /** regular_patch_set_count (skip_span). 1 for the isolated oracle; 6 in the app. */
  readonly skipSpan?: number;
  /** regular_patch_set_index (skip_offset). */
  readonly skipOffset?: number;
}

export interface RegularPatches {
  /** Raw `regular_patches` field value (= the oracle's all_patches with has_starting=0). */
  field(x: number, y: number): number;
  /** clamp(field, 0, 1) - the M3a solid-footprint probability (stipple deferred). */
  probability(x: number, y: number): number;
  /** The autoplace richness at (x, y) (0 where size <= 0). */
  richness(x: number, y: number): number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** region index for a coordinate (regions centred on multiples of REGION_SIZE). */
const regionIndex = (c: number): number => Math.floor((c + REGION_SIZE / 2) / REGION_SIZE);

export function makeRegularPatches(params: ResourceParams, ctx: RegularPatchesCtx): RegularPatches {
  const controls: ResourceControls = { frequency: ctx.controls.frequency, size: ctx.controls.size };
  const spawn: readonly Point[] = ctx.startingPositions ?? [{ x: 0, y: 0 }];
  const distanceAt = (x: number, y: number): number =>
    distanceFromNearestPoint(x, y, spawn as Point[]);

  const tables: BasisNoiseTables = basisNoiseTablesFromSeed(ctx.seed0, params.seed1);
  const basement = basementValue(params, controls);

  const skipSpan = ctx.skipSpan ?? 1;
  const skipOffset = ctx.skipOffset ?? 0;

  // regular_spot_quantity_expression = random_penalty_between(min, max, 1) *
  // quantityBase(distance), evaluated at ALL skip-set spots as ONE batch (in
  // acceptance order) - random_penalty is a batch op seeded from the first spot and
  // streamed, so a spot's jitter depends on the whole spot list, not just itself.
  const source = params.randomSpotSizeMax;
  const amplitude = params.randomSpotSizeMax - params.randomSpotSizeMin;
  const spotQuantityBatch = (spots: readonly { x: number; y: number }[]): number[] => {
    const jitter = randomPenaltyBatch(
      spots,
      spots.map(() => source),
      { seed: 1, amplitude },
    );
    return spots.map((s, i) =>
      f32(jitter[i] * f32(regularSpotQuantityBaseAt(distanceAt(s.x, s.y), params, controls))),
    );
  };

  // Selected spots per region, memoized (all resources in a set share the stream).
  const regionCache = new Map<string, SelectedSpot[]>();
  const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
    const key = `${rX},${rY}`;
    let spots = regionCache.get(key);
    if (spots) return spots;
    const regionKey: SpotRegionKey = {
      seed0: ctx.seed0,
      seed1: params.seed1,
      regionX: rX,
      regionY: rY,
    };
    spots = selectSpots(regionKey, {
      density: (x, y) => regularDensityAt(distanceAt(x, y), params, controls),
      quantity: () => 0, // unused: quantityBatch overrides
      quantityBatch: spotQuantityBatch,
      favorability: () => 1,
      regionSize: REGION_SIZE,
      candidateSpotCount: params.candidateSpotCount,
      spacing: REGULAR_SPACING,
      skipSpan,
      skipOffset,
      hardRegionTargetQuantity: false,
    });
    regionCache.set(key, spots);
    return spots;
  };

  const spotFieldAt = (x: number, y: number): number => {
    let best = basement;
    const rXlo = regionIndex(x - MAX_SPOT_BASEMENT_RADIUS);
    const rXhi = regionIndex(x + MAX_SPOT_BASEMENT_RADIUS);
    const rYlo = regionIndex(y - MAX_SPOT_BASEMENT_RADIUS);
    const rYhi = regionIndex(y + MAX_SPOT_BASEMENT_RADIUS);
    for (let rX = rXlo; rX <= rXhi; rX++) {
      for (let rY = rYlo; rY <= rYhi; rY++) {
        for (const s of regionSpots(rX, rY)) {
          const dx = x - s.x;
          const dy = y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > MAX_SPOT_BASEMENT_RADIUS * MAX_SPOT_BASEMENT_RADIUS) continue;
          // The cone is rendered per-tile by the game's spot_noise op, in the f32
          // noise machine (cube root via fastapprox `pow`); f64/exact-cbrt leaves the
          // ~1e-3 residual at cone edges (docs/noise/random-penalty-NOTES.md).
          // regular patches have no hard-target shrink, so coneScale === 1.
          const radius = Math.min(
            MAX_SPOT_RADIUS,
            f32(params.regularRqFactor * fastCbrt(s.quantity)),
          );
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
    const extra = 1.5 * basisNoise(x / 64, y / 64, tables);
    return (blobs0 + extra - 1 / 3) * regularBlobAmplitudeAt(distanceAt(x, y), params, controls);
  };

  const field = (x: number, y: number): number => spotFieldAt(x, y) + blobTermAt(x, y);

  const richnessDistanceFactor = (distance: number): number => {
    // max((double_density_distance - fade_in + distance) / (double_density_distance*2), 1)
    // fade_in term applies because none of the base resources pass has_starting = nil.
    return Math.max(
      (DOUBLE_DENSITY_DISTANCE - REGULAR_PATCH_FADE_IN_DISTANCE + distance) /
        (DOUBLE_DENSITY_DISTANCE * 2),
      1,
    );
  };

  return {
    field,
    probability: (x, y) => (ctx.controls.size > 0 ? clamp(field(x, y), 0, 1) : 0),
    richness: (x, y) => {
      if (ctx.controls.size <= 0) return 0;
      let r = field(x, y) / params.randomProbability;
      r += params.additionalRichness;
      if (params.minimumRichness > 0) r = Math.max(r, params.minimumRichness);
      return (
        params.richnessPostMultiplier *
        ctx.controls.richness *
        r *
        richnessDistanceFactor(distanceAt(x, y))
      );
    },
  };
}
