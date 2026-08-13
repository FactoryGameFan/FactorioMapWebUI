/**
 * Fulgora's Voronoi layer and the island classification built on it.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 126-205 (byte-identical 2.1.12 -> 2.1.14).
 *
 * This is where Fulgora's shape comes from: the map is a Voronoi tiling, and
 * every island in a rendered preview is one cell. `cells` gives each cell a
 * stable pseudo-random id in [0, 1), and the four class fields below slice that
 * id into what the cell becomes - most of the map is `blanks`, which turns into
 * oil ocean.
 */
import { memoXY } from "../eval/memoXY";
import { makeVoronoi, type Voronoi } from "../voronoiNoise";
import type { FulgoraCtx, FulgoraShared } from "./fulgoraShared";

/**
 * `seed1` for every Voronoi field here. All three calls use the string
 * `'fulgora_cells'` - `pyramids` and `spots` deliberately share `cells`' seed
 * so they describe the SAME tiling rather than three unrelated ones.
 *
 * `crc32(utf8("fulgora_cells")) = 1512814397` (0x5A2BB73D).
 */
const SEED1_CELLS = 1512814397;

/** `fulgora_jitter` - a named expression in the Lua, constant 0.6. */
const FULGORA_JITTER = 0.6;

export interface FulgoraCells {
  /** `voronoi_cell_id` over the distorted coordinates - the per-island id. */
  readonly cells: (x: number, y: number) => number;
  /** `voronoi_pyramid_noise` over the same tiling - the island's relief. */
  readonly pyramids: (x: number, y: number) => number;
  /** `voronoi_spot_noise`, euclidean, over HALF-distorted coordinates. Inverted cones. */
  readonly spots: (x: number, y: number) => number;
  /** `1 - spots`. Upright cones, for the vault moats. */
  readonly spotsInv: (x: number, y: number) => number;
  /** `cells < 0.33` - becomes oil ocean. The majority of the map. */
  readonly blanks: (x: number, y: number) => number;
  /** `cells > 0.75` - treated as natural landscape. */
  readonly mesa: (x: number, y: number) => number;
  /** `(cells > 0.5) - mesa` - sprawling settlement islands. */
  readonly sprawl: (x: number, y: number) => number;
  /** `1 - blanks - sprawl - mesa` - vault islands with moats. */
  readonly vaults: (x: number, y: number) => number;
  /** `max(vaults, startingVaultMask)` - forces a vault at the starting vault cone. */
  readonly vaultsAndStartingVault: (x: number, y: number) => number;
}

export function makeFulgoraCells(shared: FulgoraShared, ctx: FulgoraCtx): FulgoraCells {
  const seed0 = ctx.seed0;
  const gridSize = shared.grid;

  // `cells` and `pyramids` are the SAME voronoi field read through two
  // different ops - identical seeds, grid, distance type and jitter - so they
  // share one instance and therefore one per-cell point cache. Building two
  // would be correct but would double the point generation for no reason.
  const manhattan: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_CELLS,
    gridSize,
    distanceType: "manhattan",
    jitter: FULGORA_JITTER,
  });

  // `spots` needs its own instance because the distance type differs
  // (euclidean, not manhattan) - and note it is sampled at DIFFERENT
  // coordinates too: `ox + wobbleX/2`, i.e. half the distortion `wx` applies.
  // The moats therefore sit slightly off the islands they belong to.
  const euclidean: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_CELLS,
    gridSize,
    distanceType: "euclidean",
    jitter: FULGORA_JITTER,
  });

  const cells = memoXY((x: number, y: number) =>
    manhattan.cellId(shared.wx(x, y), shared.wy(x, y)),
  );
  const pyramids = memoXY((x: number, y: number) =>
    manhattan.pyramidNoise(shared.wx(x, y), shared.wy(x, y)),
  );
  const spots = memoXY((x: number, y: number) =>
    euclidean.spotNoise(
      shared.ox(x, y) + shared.wobbleX(x, y) / 2,
      shared.oy(x, y) + shared.wobbleY(x, y) / 2,
    ),
  );
  const spotsInv = memoXY((x: number, y: number) => 1 - spots(x, y));

  // Comparisons yield 1 or 0, matching the engine's boolean-to-number
  // convention. The four classes PARTITION every position - `vaults` is defined
  // as the remainder rather than as its own comparison, so the sum is 1 by
  // construction, and the spec asserts it at every fixture position.
  const blanks = memoXY((x: number, y: number) => (cells(x, y) < 0.33 ? 1 : 0));
  const mesa = memoXY((x: number, y: number) => (cells(x, y) > 0.75 ? 1 : 0));
  const sprawl = memoXY((x: number, y: number) => (cells(x, y) > 0.5 ? 1 : 0) - mesa(x, y));
  const vaults = memoXY((x: number, y: number) => 1 - blanks(x, y) - sprawl(x, y) - mesa(x, y));
  const vaultsAndStartingVault = memoXY((x: number, y: number) =>
    Math.max(vaults(x, y), shared.startingVaultMask(x, y)),
  );

  return {
    cells,
    pyramids,
    spots,
    spotsInv,
    blanks,
    mesa,
    sprawl,
    vaults,
    vaultsAndStartingVault,
  };
}
