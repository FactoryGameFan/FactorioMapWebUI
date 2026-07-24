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
import { clamp, max } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { sliderRescale } from "../eval/sliderRescale";
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
}

/** `vulcanus_ore_spacing` (suggested_minimum_candidate_point_spacing). */
export const VULCANUS_ORE_SPACING = 128;

export function makeVulcanusResources(
  ctx: EvalCtx,
  helpers: VulcanusHelpers,
  spawn: VulcanusSpawn,
  biomes: VulcanusBiomes,
  _cracks: VulcanusCracks,
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
  // tungstenSize is unused here (starting_tungsten deliberately isn't slider-scaled,
  // see below) but Task 4's vulcanus_tungsten_region reads it - kept computed,
  // underscore-prefixed to satisfy the unused-var lint until then.
  const _tungstenSize = sliderRescale(levers.tungstenOre.size, 2);
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

  return {
    basaltsFavorability,
    mountainsFavorability,
    mountainsSulfurFavorability,
    ashlandsFavorability,
    startingTungsten,
    startingCoal,
    startingCalcite,
    startingSulfur,
  };
}
