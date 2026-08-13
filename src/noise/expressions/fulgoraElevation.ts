/**
 * Fulgora's elevation mix chain - everything between the Voronoi layer and
 * `fulgora_elevation` itself.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 206-336, plus `fulgora_scrap_medium` (371), `fulgora_dunes` (513) and
 * `fulgora_rock` (523). Byte-identical 2.1.12 -> 2.1.14.
 *
 * The shape of the chain: `natural` is the organic landscape (one big
 * multioctave field, thresholded near sea level), the `*Pyramids` terms are the
 * Voronoi relief restricted to the island classes that get built on, and the
 * rest is a sequence of `max`/`lerp` steps that composite them, cut moats out
 * of vault islands, punch spots into vault centres, then flood the low ground
 * with oil. The last two steps invert everything above 0.6 so inland sand sits
 * in bowls with cliffs facing inwards, and finally step the whole field by +/-10
 * at the coast so the cliff generator has a sharp edge to bite on.
 *
 * `fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`, `fulgora_sprawl_mask`
 * and `fulgora_artificial_mask` are deliberately NOT ported. They are defined in
 * the middle of this same Lua block, which makes them look like part of the
 * chain, but nothing here reads them - they feed the deferred tile layer.
 */
import { memoXY } from "../eval/memoXY";
import { lerp, sliderRescale } from "../eval/math";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraCtx, FulgoraShared } from "./fulgoraShared";

/**
 * `seed1` for each multioctave call. The game hashes a string `seed1` with a
 * standard CRC32 (identical to `src/codec/crc32.ts`), resolved once and
 * hardcoded here the way `fulgoraShared.ts` does it.
 *
 * **Computed, never guessed.** A wrong seed here produces a perfectly plausible
 * map that no residual-size check would flag - it is a different noise field,
 * not a slightly wrong one. An earlier draft of `fulgoraCells.ts` carried a
 * hand-invented constant for exactly this reason.
 */
const SEED1_BASIS = 2183403986; // crc32("fulgora_basis") = 0x822419D2
const SEED1_BASIS_OIL = 1819171631; // crc32("fulgora_basis_oil") = 0x6C6E5B2F
const SEED1_ROCK = 3721161451; // crc32("fulgora_rock") = 0xDDCC6AEB
const SEED1_DUNES = 1783911317; // crc32("fulgora_dunes") = 0x6A545395
const SEED1_SCRAP_MEDIUM = 1100006120; // crc32("fulgora_scrap_medium") = 0x4190C2E8

/**
 * `fulgora_artificial_cap` - a named expression in the Lua, constant 0.25.
 * "The upper limit of pyramids, making them plateaus instead."
 */
const ARTIFICIAL_CAP = 0.25;

/** `fulgora_coastline` - constant 80. The coastline sits well above 0 so the */
const COASTLINE = 80;

/** `fulgora_coastline_drop` - constant 20. Applied as +/- half, at the coast. */
const COASTLINE_DROP = 20;

export interface FulgoraElevation {
  /** `fulgora_basis` - the organic landscape field, at the distorted coords. */
  readonly basis: (x: number, y: number) => number;
  /** `fulgora_basis_oil` - breaks up the oil areas. Heavily distorted. */
  readonly basisOil: (x: number, y: number) => number;
  /** `fulgora_rock` - billows noise, `0.33 + abs(...)`. Undistorted. */
  readonly rock: (x: number, y: number) => number;
  /** `fulgora_dunes` - ridged noise, `0.66 - abs(...)`. Read by the tile layer. */
  readonly dunes: (x: number, y: number) => number;
  /** `fulgora_scrap_medium` - read by the tile and resource layers. */
  readonly scrapMedium: (x: number, y: number) => number;
  /** `fulgora_natural` - the natural landscape distribution. */
  readonly natural: (x: number, y: number) => number;
  /** `fulgora_sprawl_pyramids` - pyramids on sprawl cells plus altered mesas. */
  readonly sprawlPyramids: (x: number, y: number) => number;
  /** `fulgora_vault_pyramids` - pyramids restricted to vault cells. */
  readonly vaultPyramids: (x: number, y: number) => number;
  /** `fulgora_vault_pyramids_and_start` - the above, forced on at spawn. */
  readonly vaultPyramidsAndStart: (x: number, y: number) => number;
  /** `fulgora_moats` - the moats of vault cells, cut out of other terrain. */
  readonly moats: (x: number, y: number) => number;
  /** `fulgora_mix_pyramids` - sprawl pyramids raised to the natural level. */
  readonly mixPyramids: (x: number, y: number) => number;
  /** `fulgora_mix_natural` - sprawl and natural landscapes composited. */
  readonly mixNatural: (x: number, y: number) => number;
  /** `fulgora_mix_moats` - the above with vault moats cut out. */
  readonly mixMoats: (x: number, y: number) => number;
  /** `fulgora_vault_spots` - roundish plateaus at vault centres. */
  readonly vaultSpots: (x: number, y: number) => number;
  /** `fulgora_mix_spots` - vault spots applied to the landscape. */
  readonly mixSpots: (x: number, y: number) => number;
  /** `fulgora_oil_mask` - `mixSpots < 0`. Oil sand and oil ocean. */
  readonly oilMask: (x: number, y: number) => number;
  /** `fulgora_mix_oil` - oil noise applied inside the oil mask. */
  readonly mixOil: (x: number, y: number) => number;
  /** `fulgora_sand_basins` - the field inverted above 0.3, forming bowls. */
  readonly sandBasins: (x: number, y: number) => number;
  /** `fulgora_pre_elevation` - `sandBasins * 60 + 80`, before the coastal step. */
  readonly preElevation: (x: number, y: number) => number;
  /** `fulgora_elevation` - the surface's elevation property. */
  readonly elevation: (x: number, y: number) => number;
}

export function makeFulgoraElevation(
  shared: FulgoraShared,
  cells: FulgoraCells,
  ctx: FulgoraCtx,
): FulgoraElevation {
  const seed0 = ctx.seed0;
  const grid = shared.grid;

  // The five multioctave sources, verbatim from the Lua. Only `basis` reads the
  // distorted coordinates and only `basis` sets an `output_scale`; where the Lua
  // omits `output_scale` the engine default of 1 applies.
  const basisNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_BASIS,
    octaves: 6,
    persistence: 0.5,
    inputScale: 128 / grid / 7.5,
    outputScale: 0.5,
  });
  const basisOilNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_BASIS_OIL,
    octaves: 4,
    persistence: 0.65,
    inputScale: 1 / 10,
    outputScale: 1,
  });
  const rockNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_ROCK,
    octaves: 4,
    persistence: 0.7,
    inputScale: 1 / 3,
    outputScale: 1,
  });
  const dunesNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_DUNES,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 6,
    outputScale: 1,
  });
  const scrapMediumNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_SCRAP_MEDIUM,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 18,
    outputScale: 1,
  });

  const basis = memoXY((x: number, y: number) => basisNoise(shared.wx(x, y), shared.wy(x, y)));

  // Note the distortion here is 1.5x the wobble and does NOT go through
  // `wobbleMask` - so unlike `wx`/`wy`, the oil noise is displaced even where
  // the mask has turned the island distortion off.
  const basisOil = memoXY((x: number, y: number) =>
    basisOilNoise(x + 1.5 * shared.wobbleX(x, y), y + 1.5 * shared.wobbleY(x, y)),
  );

  const rock = memoXY((x: number, y: number) => 0.33 + Math.abs(rockNoise(x, y)));
  const dunes = memoXY((x: number, y: number) => 0.66 - Math.abs(dunesNoise(x, y)));
  const scrapMedium = memoXY(scrapMediumNoise);

  // `slider_rescale(size, 2)` is a program CONSTANT - it depends only on the
  // slider - so it is hoisted out of the per-position path. At the default size
  // of 1 it is exactly 1, which is why the spec tests it against its own probe
  // rather than through this field. See `sliderRescale`.
  const sizeRescale = sliderRescale(ctx.islandsSize ?? 1, 2);

  const natural = memoXY((x: number, y: number) => basis(x, y) * 2 * sizeRescale - 0.85);

  // Mesas take the pyramid relief scaled by an oil/rock term; sprawl cells take
  // it whole; every other class takes none of it (`sprawl` and `mesa` are
  // mutually exclusive 0/1 flags, so the bracket is one or the other).
  const sprawlPyramids = memoXY(
    (x: number, y: number) =>
      cells.pyramids(x, y) *
      (cells.sprawl(x, y) +
        cells.mesa(x, y) * Math.min(1, Math.abs(0.9 - 0.2 * basisOil(x, y) + 0.05 * rock(x, y)))),
  );

  const vaultPyramids = memoXY((x: number, y: number) =>
    Math.max(cells.vaults(x, y) * cells.pyramids(x, y), 0.5 * shared.startingVaultCone(x, y)),
  );
  const vaultPyramidsAndStart = memoXY((x: number, y: number) =>
    Math.max(vaultPyramids(x, y), 0.5 * shared.startingCone(x, y)),
  );

  // The moat is a V cut around the pyramid: the first arm falls away below the
  // island, the second rises with it, and `max` takes whichever is nearer the
  // surface. The `-0.05` floor is what guarantees some oil ocean in the moat.
  const moats = memoXY((x: number, y: number) => {
    const v = vaultPyramidsAndStart(x, y);
    return Math.min(ARTIFICIAL_CAP, 1.5 * Math.max(-0.05 - v * 2, (v - 0.35) * 2));
  });

  const mixPyramids = memoXY((x: number, y: number) =>
    Math.min(ARTIFICIAL_CAP, (sprawlPyramids(x, y) - 0.185) * 4),
  );
  const mixNatural = memoXY((x: number, y: number) => Math.max(natural(x, y), mixPyramids(x, y)));
  const mixMoats = memoXY((x: number, y: number) =>
    lerp(
      mixNatural(x, y),
      moats(x, y),
      Math.max(cells.vaultsAndStartingVault(x, y), shared.startingMask(x, y)),
    ),
  );

  // "normal spot inverse is roughly 0.5 to 1, but the lower bound can be a bit
  // less in corners" - hence the steep `-10 + 11.5 *` remap, which turns that
  // narrow band into a plateau with near-vertical sides before the cap flattens
  // its top. The two starting terms carry a +0.5 bump so spawn blends in.
  const vaultSpots = memoXY((x: number, y: number) =>
    Math.min(
      ARTIFICIAL_CAP,
      -10 +
        11.5 *
          Math.max(
            cells.vaults(x, y) * cells.spotsInv(x, y),
            shared.startingVaultMask(x, y) * (0.5 + 0.5 * shared.startingVaultCone(x, y)),
            shared.startingMask(x, y) * (0.5 + 0.5 * shared.startingCone(x, y)),
          ),
    ),
  );

  const mixSpots = memoXY(
    (x: number, y: number) =>
      Math.max(mixMoats(x, y), vaultSpots(x, y)) + Math.max(0, shared.startingCone(x, y) - 0.8),
  );

  // Comparisons yield 1 or 0, matching the engine's boolean-to-number convention.
  const oilMask = memoXY((x: number, y: number) => (mixSpots(x, y) < 0 ? 1 : 0));

  // Inside the mask, drop the field further by an oil-noise amount - but the
  // `min(-0.01, ...)` guarantees the result stays negative, so applying the
  // noise can never lift an oil area back out of the mask it was chosen by.
  const mixOil = memoXY((x: number, y: number) => {
    const s = mixSpots(x, y);
    return lerp(s, Math.min(-0.01, s - 0.4 + 0.6 * basisOil(x, y)), oilMask(x, y));
  });

  // The inversion: above 0.3 the field folds back down, so high inland ground
  // becomes a bowl whose cliffs face inwards. This is what makes inland sand
  // areas negative, and why the tile layer needs `oilMask` rather than a plain
  // "elevation < coastline" test to decide where liquid goes.
  const sandBasins = memoXY((x: number, y: number) => {
    const o = mixOil(x, y);
    return Math.min(o, 0.6 - o);
  });

  const preElevation = memoXY((x: number, y: number) => sandBasins(x, y) * 60 + COASTLINE);

  // The coastal step: +10 on land, -10 in water, so the coastline is a cliff
  // face rather than a gradual slope the cliff smoothing could smear.
  const elevation = memoXY(
    (x: number, y: number) =>
      preElevation(x, y) + ((sandBasins(x, y) > 0 ? 1 : 0) - 0.5) * COASTLINE_DROP,
  );

  return {
    basis,
    basisOil,
    rock,
    dunes,
    scrapMedium,
    natural,
    sprawlPyramids,
    vaultPyramids,
    vaultPyramidsAndStart,
    moats,
    mixPyramids,
    mixNatural,
    mixMoats,
    vaultSpots,
    mixSpots,
    oilMask,
    mixOil,
    sandBasins,
    preElevation,
    elevation,
  };
}
