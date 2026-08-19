/**
 * Fulgora's shared layer: the Voronoi grid constant, the wobble fields that
 * distort the grid's input coordinates, the offset/distorted coordinates the
 * cell layer samples at, and the two starting cones that carve out spawn.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 22-124, which is byte-identical 2.1.12 -> 2.1.14.
 *
 * Everything here feeds `fulgoraCells.ts` and `fulgoraElevation.ts`, so the
 * exported names are load-bearing. Every field is `memoXY`-wrapped: the graph
 * below is a DAG, not a tree - `wobbleX` alone is read by `wx`, by both
 * starting cones, and (via `wobbleMask`) by `wy` - so an unmemoized read would
 * re-run its four octaves several times per pixel.
 */
import { memoXY } from "../eval/memoXY";
import { f32 } from "../eval/f32";
import { clamp, sliderToLinear } from "../eval/math";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import { startingSpotAtAngle } from "./vulcanusShared";

/**
 * `seed1` for `fulgora_wobble_x`. The game hashes a string `seed1` with a
 * standard CRC32 (identical to `src/codec/crc32.ts`), resolved once and
 * hardcoded here the way `nauvisShared.ts` does it:
 * `crc32(utf8("fulgora_wobble_x")) = 686434221` (0x28EA27AD).
 */
const SEED1_WOBBLE_X = 686434221;

/** `crc32(utf8("fulgora_wobble_y")) = 1609373499` (0x5FED173B). */
const SEED1_WOBBLE_Y = 1609373499;

/**
 * The free variables Fulgora's shared layer reads.
 *
 * `seed0` is `map_seed` as the noise program sees it - i.e. the FULGORA SURFACE
 * seed, not the user's map seed. Derive it with
 * `surfaceSeedForPlanet("fulgora", mapSeed)` before constructing this; the
 * oracle harness sets the surface seed explicitly instead, which is why the
 * spec passes its fixture seed raw.
 */
export interface FulgoraCtx {
  /** `map_seed` on the Fulgora surface. */
  readonly seed0: number;
  /** `control:fulgora_islands:frequency` (wire value). Neutral/default = 1. */
  readonly islandsFrequency?: number;
  /** `control:fulgora_islands:size` (wire value). Neutral/default = 1. */
  readonly islandsSize?: number;
}

export interface FulgoraShared {
  /**
   * `fulgora_grid` - the Voronoi cell size in tiles. A program CONSTANT, not a
   * field: it depends only on the islands frequency slider, so it is a number
   * here rather than an `(x, y)` function. The Lua comment calls 200 ideal and
   * ~180 the minimum viable size; the default lands at 175.
   */
  readonly grid: number;
  readonly wobbleInfluence: (x: number, y: number) => number;
  readonly wobbleMask: (x: number, y: number) => number;
  readonly wobbleX: (x: number, y: number) => number;
  readonly wobbleY: (x: number, y: number) => number;
  readonly ox: (x: number, y: number) => number;
  readonly oy: (x: number, y: number) => number;
  readonly wx: (x: number, y: number) => number;
  readonly wy: (x: number, y: number) => number;
  readonly startingCone: (x: number, y: number) => number;
  readonly startingVaultCone: (x: number, y: number) => number;
  readonly startingMask: (x: number, y: number) => number;
  readonly startingVaultMask: (x: number, y: number) => number;
}

export function makeFulgoraShared(ctx: FulgoraCtx): FulgoraShared {
  const seed0 = ctx.seed0;
  const islandsFrequency = ctx.islandsFrequency ?? 1;

  // "175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)".
  // A higher frequency slider subtracts more, shrinking the cell - more
  // islands, which is the direction the control's name implies.
  //
  // f32-rounded, matching the game bit-for-bit across the slider (see
  // `sliderToLinear`). It matters more here than the size of the error suggests:
  // grid is the denominator of every input_scale below, so an f64 grid would
  // push a small error into every noise field at once.
  const grid = Math.fround(175 - sliderToLinear(islandsFrequency, -50, 50));

  // The three multioctave calls, verbatim from the Lua. Note the two wobble
  // fields differ ONLY in their string seed1, so they are independent noise at
  // identical parameters - the x/y asymmetry comes from the seed, nothing else.
  const wobbleInfluenceNoise = makeMultioctaveNoise({
    seed0,
    seed1: 1,
    octaves: 3,
    persistence: 0.5,
    inputScale: 128 / grid / 20,
    outputScale: 3,
  });
  const wobbleXNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_WOBBLE_X,
    octaves: 4,
    persistence: 0.7,
    inputScale: 5 / grid,
    outputScale: grid * 0.07,
  });
  const wobbleYNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_WOBBLE_Y,
    octaves: 4,
    persistence: 0.7,
    inputScale: 5 / grid,
    outputScale: grid * 0.07,
  });

  const wobbleInfluence = memoXY(wobbleInfluenceNoise);
  const wobbleX = memoXY(wobbleXNoise);
  const wobbleY = memoXY(wobbleYNoise);

  // "We usually want a lot of wobble or none at all, so influence has a high
  // output scale and then we clamp it." The +0.6 biases most of the map to
  // fully-on rather than centring the mask.
  //
  // `0.6` is narrowed as a CONSTANT (case 2 in `src/noise/eval/f32.ts`): the
  // engine holds it as the f32 0.60000002384185791016, JavaScript's literal is
  // the f64 0.59999999999999997780, and no rounding of the result recovers the
  // difference. Measured over the 101-position fixture: 96/101 exact as an f64
  // literal, **101/101 at a residual of exactly 0** narrowed. It is the most
  // load-bearing of the eight in #273 - `wx`, `wy`, `fulgora_basis`,
  // `fulgora_pyramids` and `fulgora_pyramids_banding` all reach 101/101 with
  // it and none of them reaches 101/101 without it.
  const wobbleMask = memoXY((x: number, y: number) =>
    clamp(wobbleInfluence(x, y) + f32(0.6), 0, 1),
  );

  // Offset the grid by half a cell so spawn sits in the MIDDLE of a cell
  // rather than on a corner where four islands meet.
  const ox = memoXY((x: number, _y: number) => x + grid / 2);
  const oy = memoXY((_x: number, y: number) => y + grid / 2);

  const wx = memoXY((x: number, y: number) => ox(x, y) + wobbleX(x, y) * wobbleMask(x, y));
  const wy = memoXY((x: number, y: number) => oy(x, y) + wobbleY(x, y) * wobbleMask(x, y));

  // Both cones are placed by map_seed alone, so the starting island sits at a
  // seed-determined bearing from the origin. The vault sits opposite it (+180).
  const angle = seed0 / 360;

  // startingCone is max(0, A, B) over TWO discs: a wide one offset a little way
  // out, and a tight one at distance 1 whose distortion is damped to a quarter.
  // The tight disc is what keeps the very centre of spawn solid when the wobble
  // is running at full strength.
  const startingCone = memoXY((x: number, y: number) => {
    const dx = wobbleX(x, y);
    const dy = wobbleY(x, y);
    const wide = startingSpotAtAngle({
      angle,
      distance: grid / 30,
      radius: grid / 1.8,
      xDistortion: 1 * dx,
      yDistortion: 1 * dy,
      xFromStart: x,
      yFromStart: y,
    });
    const tight = startingSpotAtAngle({
      angle,
      distance: 1,
      radius: grid / 4,
      xDistortion: 0.25 * dx,
      yDistortion: 0.25 * dy,
      xFromStart: x,
      yFromStart: y,
    });
    return Math.max(0, wide, tight);
  });

  const startingVaultCone = memoXY((x: number, y: number) =>
    Math.max(
      0,
      startingSpotAtAngle({
        angle: angle + 180,
        distance: grid / 1.8,
        radius: grid / 1.8,
        xDistortion: 1 * wobbleX(x, y),
        yDistortion: 1 * wobbleY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
    ),
  );

  // The two masks are complementary comparisons of the same pair, so exactly
  // one can be 1 at a point where the cones differ, and both are 0 where they
  // are equal (which is everywhere both are clamped to 0, i.e. most of the map).
  const startingMask = memoXY((x: number, y: number) =>
    startingCone(x, y) - startingVaultCone(x, y) > 0 ? 1 : 0,
  );
  const startingVaultMask = memoXY((x: number, y: number) =>
    startingVaultCone(x, y) - startingCone(x, y) > 0 ? 1 : 0,
  );

  return {
    grid,
    wobbleInfluence,
    wobbleMask,
    wobbleX,
    wobbleY,
    ox,
    oy,
    wx,
    wy,
    startingCone,
    startingVaultCone,
    startingMask,
    startingVaultMask,
  };
}
