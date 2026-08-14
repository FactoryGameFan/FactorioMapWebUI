/**
 * `enemy_base_probability`, the noise expression driving the deterministic
 * enemy-base spawner (used for the client-side enemy-base overlay), ported over
 * the same solved primitives as `regularPatches.ts` (`selectSpots`, `basisNoise`,
 * `distanceFromNearestPoint`). Single field, no per-resource params, no
 * `quantityBatch`, no hard-target shrink - the game's cone here has no
 * `min(32, ...)` radius cap (that clamp is resource-only) and `coneScale` is
 * always 1 (`hardRegionTargetQuantity: false`).
 *
 *   enemy_base_probability =
 *       spotField + blobTerm - 0.3 + min(0, (20 / starting_area_radius) * distance - 20)
 *   spotField = max(basement, max over nearby spots of (peak - dist*slope))
 *   blobTerm  = (basis_noise{1/8} + basis_noise{1/24} + 2*basis_noise{1/64} - 0.5)
 *                 * (spot_radius(distance) / 150) * (0.1 + 0.9*clamp(distance/3000, 0, 1))
 *
 * An M4 spike validated this exact math against the live game to abs < 0.001;
 * see test/enemyBaseField.spec.ts (validated against the Task 2 oracle fixture,
 * test/fixtures/oracle-enemy-base.seed123456.json).
 */
import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "../basisNoise";
import { distanceFromNearestPoint, type Point } from "../distanceFromNearestPoint";
import { f32 } from "../eval/f32";
import { selectSpots, type SelectedSpot } from "../spotSelection";
import type { SpotRegionKey } from "../spotCandidates";
import {
  ENEMY_BASEMENT,
  ENEMY_CANDIDATE_SPOT_COUNT,
  ENEMY_MAX_SPOT_BASEMENT_RADIUS,
  ENEMY_PLACEMENT_CAP,
  ENEMY_REGION_SIZE,
  ENEMY_SEED1,
  ENEMY_SPACING,
  STARTING_AREA_RADIUS,
  enemyDensity,
  enemySpotQuantity,
  enemySpotRadius,
  type EnemyControls,
} from "./enemyCatalog";

export interface EnemyBaseFieldCtx {
  readonly seed0: number;
  readonly controls: EnemyControls;
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
}

export interface EnemyBaseField {
  /** Raw `enemy_base_probability` (spot field + blob term - 0.3 + starting term). */
  field(x: number, y: number): number;
  /** clamp(min(field, ENEMY_PLACEMENT_CAP), 0, 1) - the deterministic spawner placement source. */
  probability(x: number, y: number): number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** region index for a coordinate (regions centred on multiples of ENEMY_REGION_SIZE). */
const regionIndex = (c: number): number =>
  Math.floor((c + ENEMY_REGION_SIZE / 2) / ENEMY_REGION_SIZE);

export function makeEnemyBaseField(ctx: EnemyBaseFieldCtx): EnemyBaseField {
  const controls: EnemyControls = ctx.controls;
  const spawn: readonly Point[] = ctx.startingPositions ?? [{ x: 0, y: 0 }];
  const distanceAt = (x: number, y: number): number =>
    distanceFromNearestPoint(x, y, spawn as Point[]);
  const tables: BasisNoiseTables = basisNoiseTablesFromSeed(ctx.seed0, ENEMY_SEED1);

  const regionCache = new Map<string, SelectedSpot[]>();
  const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
    const key = `${rX},${rY}`;
    let spots = regionCache.get(key);
    if (spots) return spots;
    const regionKey: SpotRegionKey = {
      seed0: ctx.seed0,
      seed1: ENEMY_SEED1,
      regionX: rX,
      regionY: rY,
    };
    spots = selectSpots(regionKey, {
      density: (x, y) => enemyDensity(distanceAt(x, y), controls),
      quantity: (x, y) => enemySpotQuantity(distanceAt(x, y), controls),
      favorability: () => 1,
      regionSize: ENEMY_REGION_SIZE,
      candidateSpotCount: ENEMY_CANDIDATE_SPOT_COUNT,
      spacing: ENEMY_SPACING,
      hardRegionTargetQuantity: false,
    });
    regionCache.set(key, spots);
    return spots;
  };

  const spotFieldAt = (x: number, y: number): number => {
    let best = ENEMY_BASEMENT;
    const R = ENEMY_MAX_SPOT_BASEMENT_RADIUS;
    const rXlo = regionIndex(x - R);
    const rXhi = regionIndex(x + R);
    const rYlo = regionIndex(y - R);
    const rYhi = regionIndex(y + R);
    for (let rX = rXlo; rX <= rXhi; rX++) {
      for (let rY = rYlo; rY <= rYhi; rY++) {
        for (const s of regionSpots(rX, rY)) {
          const dx = x - s.x;
          const dy = y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > R * R) continue;
          // radius = spot_radius at the spot (NO min(32,...) cap - resource-only); coneScale === 1.
          const radius = f32(enemySpotRadius(distanceAt(s.x, s.y), controls) * s.coneScale);
          if (radius <= 0) continue;
          const q = s.quantity;
          const peak = f32(f32(3 * q) / f32(f32(Math.PI * radius) * radius));
          const cone = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
          if (cone > best) best = cone;
        }
      }
    }
    return best;
  };

  const blobTermAt = (x: number, y: number): number => {
    const b =
      basisNoise(x / 8, y / 8, tables) +
      basisNoise(x / 24, y / 24, tables) +
      2 * basisNoise(x / 64, y / 64, tables); // blob(1/64, 2) -> output_scale 2
    const d = distanceAt(x, y);
    return (b - 0.5) * (enemySpotRadius(d, controls) / 150) * (0.1 + 0.9 * clamp(d / 3000, 0, 1));
  };

  const field = (x: number, y: number): number => {
    const d = distanceAt(x, y);
    return (
      spotFieldAt(x, y) + blobTermAt(x, y) - 0.3 + Math.min(0, (20 / STARTING_AREA_RADIUS) * d - 20)
    );
  };

  return {
    field,
    probability: (x, y) => clamp(Math.min(field(x, y), ENEMY_PLACEMENT_CAP), 0, 1),
  };
}
