/**
 * The game's per-tile entity placement roll, in a deliberately approximate form.
 *
 * Reverse-engineered in `docs/noise/placement-roll-NOTES.md`: `generateEntities`
 * seeds taus88 once per chunk from the chunk position (no `map_seed`), then walks
 * the chunk's tiles in DECREASING tile index, drawing one `U` per tile and placing
 * the arbitrated winner where `U < probability`.
 *
 * Two departures, both deliberate (see the 2026-07-27 spec):
 *
 * 1. **No cross-overlay arbitration.** The game picks one winner per tile by max
 *    probability across every entity autoplacer in the chunk - including ones this
 *    app has never ported. We roll each overlay separately, and give each its own
 *    `salt` so their streams do not correlate. The salt is the one value here with
 *    no counterpart in the game.
 * 2. **No jitter draws.** The game spends two extra draws per PLACEMENT to offset
 *    the entity within its tile, which makes its draw count data-dependent. Dropping
 *    them fixes the count at one draw per tile - which is what makes `roll(x, y)` a
 *    pure function of world position, and therefore safe for the tiled renderer.
 */
import { seededState, taus88Next } from "../taus88";

/** Tiles per chunk edge; 1024 tiles per chunk. */
const CHUNK = 32;
const TILES_PER_CHUNK = CHUNK * CHUNK;

/**
 * The (2*1+1) = 3x3 legibility mark for the roll overlays that use one.
 *
 * **Enemy bases, the Vulcanus sulfuric-acid geyser and crude oil use it** (Tasks
 * 6-8). A spawner is 7.4 x 6.4 tiles, a geyser and an oil well 2.8 x 2.8, and all
 * three place rarely enough that a 1px dot disappears. Their renderers paint the
 * mark and `elevationRenderRequest.ts`'s `placementMarkSweepBox` widens the tiled
 * sweep by this radius so marks are not clipped at worker-tile seams - which is
 * the second thing adopting this constant costs, and the one
 * `test/tiledEquality.spec.ts` enforces, with a separate case per overlay because
 * a window dense in one is empty of the other.
 *
 * **The two rock overlays keep their own constants** rather than this one, and
 * they disagree with each other: Nauvis paints 3x3 and Vulcanus a single pixel.
 * The reason is contrast against each planet's palette, not entity size - see
 * `NAUVIS_ROCK_MARK_RADIUS_PX` in `rocks/rockCatalog.ts`. Nauvis rocks acquired
 * their mark late (2026-07-27, on review of the deployed preview) and the sweep
 * halo had to come with it: `test/tiledEquality.spec.ts` failed on four cases the
 * moment the mark grew, which is exactly the cost this comment warns about.
 */
export const PLACEMENT_MARK_RADIUS_PX = 1;

/**
 * Per-overlay stream salts. Values are arbitrary and carry no meaning beyond being
 * distinct - EXCEPT `vulcanusRocks`, which is 0 so that one overlay reproduces the
 * game's own seed word exactly, letting the unit test pin the RE'd constants.
 */
export const PLACEMENT_SALT = {
  vulcanusRocks: 0,
  nauvisRocks: 0x5f1e21,
  enemyBases: 0xa3c07b,
  vulcanusGeyser: 0x1d94e5,
  crudeOil: 0x76b3af,
  /**
   * The two spawners' `random_penalty` draws (`renderEnemies.ts`). These are NOT
   * placement rolls - they stand in for a batch noise op, not for
   * `generateEntities`' per-tile draw - but the need is identical (a
   * deterministic, position-pure uniform per tile) so they reuse this machinery
   * rather than introducing a second one.
   */
  enemyBiterPenalty: 0x2c81d3,
  enemySpitterPenalty: 0x4e0937,
  /**
   * Crude oil's `random_penalty{source = 1, amplitude = 48}` draw
   * (`renderResources.ts`), the same batch-op stand-in as the two above.
   *
   * **Density does not depend on getting the game's batch right**, which is why a
   * stand-in is legitimate here rather than merely convenient. `source = 1` is a
   * constant and strictly positive, so *every* tile in the batch consumes exactly
   * one taus88 draw - the `source <= 0` pass-through can never fire. Each tile's
   * `U` is therefore marginally uniform on [0, 1) no matter where the batch
   * starts or how long it is, and a density is a sum of per-tile marginals. Batch
   * extent moves *which* tile gets which draw - positions - and the placement
   * port already declines to reproduce positions
   * (`test/entityDensity.spec.ts`). See `docs/noise/random-penalty-NOTES.md`.
   */
  crudeOilPenalty: 0x91c40d,
  /** Fulgora scrap's own roll stream (Task 4). */
  fulgoraScrap: 0x3ba58c,
} as const;

/** `max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)` in u32 arithmetic. */
export function placementRollWord(chunkX: number, chunkY: number, salt: number): number {
  const sum = (0x3fbe2c + Math.imul(7919, chunkX) + Math.imul(7907, chunkY) + salt) >>> 0;
  return Math.max(341, sum);
}

function chunkRolls(chunkX: number, chunkY: number, salt: number): Float64Array {
  const st = seededState(placementRollWord(chunkX, chunkY, salt));
  const out = new Float64Array(TILES_PER_CHUNK);
  // Draws are consumed in decreasing tile index, so draw k belongs to tile 1023-k.
  for (let k = 0; k < TILES_PER_CHUNK; k++) {
    out[TILES_PER_CHUNK - 1 - k] = taus88Next(st) / 4294967296;
  }
  return out;
}

/**
 * Build `roll(x, y) -> U in [0, 1)` for one overlay. Place where `U < probability`.
 *
 * Caching: a single-slot (chunkX, chunkY) check in front of a `Map`. Renderers sweep
 * row-major, so the single slot hits for 32 consecutive pixels and the Map catches
 * the revisit when the next pixel row re-enters a chunk already built. Building a
 * chunk costs 1024 taus88 steps, amortised to ~1 step per tile over the chunk.
 */
export function makePlacementRoll(salt: number): (x: number, y: number) => number {
  const cache = new Map<string, Float64Array>();
  let lastX = NaN;
  let lastY = NaN;
  let last: Float64Array | null = null;

  return (x, y) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (cx !== lastX || cy !== lastY || last === null) {
      const key = `${cx},${cy}`;
      let rolls = cache.get(key);
      if (rolls === undefined) {
        rolls = chunkRolls(cx, cy, salt);
        cache.set(key, rolls);
      }
      last = rolls;
      lastX = cx;
      lastY = cy;
    }
    return last[(ty & 31) * CHUNK + (tx & 31)];
  };
}

/** An entity's axis-aligned collision box, in tiles. */
export interface PlacementCollisionBox {
  readonly w: number;
  readonly h: number;
}

export interface PlacementSetOptions {
  readonly salt: number;
  /** The winning entity's clamped autoplace probability at this tile. */
  readonly probability: (x: number, y: number) => number;
  /** Tile-restriction gate. MUST be a pure function of world position. */
  readonly tileAllowed?: (x: number, y: number) => boolean;
  /** Collision box in tiles for the prototype that wins this tile. */
  readonly collisionBox?: (x: number, y: number) => PlacementCollisionBox;
}

/**
 * Resolve one chunk's accepted-tile set, walking `k = 0..1023` and taking
 * `tile = 1023 - k`. That is both the draw order and the game's own processing
 * order, which is what makes the greedy collision pass reproducible.
 *
 * The roll is tested first because a tile whose roll fails places nothing, and
 * therefore occupies no space - which keeps the expensive gates off ~99% of tiles.
 *
 * **That reordering is NOT free in general**, and the two conditions it rests on
 * are worth checking before reusing this helper:
 *
 * 1. **The roll must not be data-dependent.** `chunkRolls` precomputes all 1024
 *    draws from the chunk seed alone, because this port drops the game's 2 jitter
 *    draws per placement (see the file header). In the game those draws make the
 *    stream depend on what placed earlier, so there gate-first and roll-first would
 *    consume different values.
 * 2. **All prototypes sharing the overlay must share one `tileAllowed`.** Here they
 *    do - all four Vulcanus rock prototypes' `tile_restriction` lists union to "not
 *    lava", so no other rock can win a tile this one is barred from. With
 *    heterogeneous restrictions the game would arbitrate to a *different* winner on
 *    a restricted tile and roll that one's probability, which a single
 *    probability-then-restriction test cannot express.
 */
function resolveChunk(cx: number, cy: number, opts: PlacementSetOptions): Uint8Array {
  const { probability, tileAllowed, collisionBox } = opts;
  const rolls = chunkRolls(cx, cy, opts.salt);
  const accepted = new Uint8Array(TILES_PER_CHUNK);

  // Accepted boxes so far, in chunk-local tile coordinates. A chunk accepts a
  // handful of tiles in practice (~4 for Vulcanus rocks), so a linear scan is
  // both cheaper and more exact than a bounded neighbourhood sweep, which would
  // have to assume a maximum box size.
  const accX: number[] = [];
  const accY: number[] = [];
  const accW: number[] = [];
  const accH: number[] = [];

  for (let k = 0; k < TILES_PER_CHUNK; k++) {
    const tile = TILES_PER_CHUNK - 1 - k;
    const lx = tile & 31;
    const ly = tile >> 5;
    const x = cx * CHUNK + lx;
    const y = cy * CHUNK + ly;

    if (rolls[tile] >= probability(x, y)) continue;
    if (tileAllowed !== undefined && !tileAllowed(x, y)) continue;

    if (collisionBox !== undefined) {
      const b = collisionBox(x, y);
      let blocked = false;
      for (let i = 0; i < accX.length; i++) {
        // Boxes are centred on their tile (jitter is not modelled), so two
        // candidates overlap when their centre separation is under the sum of
        // their half-extents.
        if (
          Math.abs(lx - accX[i]) < (b.w + accW[i]) / 2 &&
          Math.abs(ly - accY[i]) < (b.h + accH[i]) / 2
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      accX.push(lx);
      accY.push(ly);
      accW.push(b.w);
      accH.push(b.h);
    }

    accepted[tile] = 1;
  }
  return accepted;
}

/**
 * Build `placed(x, y) -> boolean` for one overlay: the roll, plus the two gates
 * the game applies around it (`docs/noise/placement-roll-NOTES.md`: the winner is
 * picked by max probability "subject to collision-mask and tile-restriction
 * checks"). With neither gate supplied this is exactly
 * `makePlacementRoll(salt)(x, y) < probability(x, y)`.
 *
 * **Why a chunk resolver rather than a per-tile predicate.** Collision rejection
 * is order-dependent: whether a tile is accepted depends on which of its
 * neighbours were accepted before it. Left per-tile that would make the answer
 * depend on the render window, and `test/tiledEquality.spec.ts` would fail at
 * worker-tile seams. Containing it to a whole chunk - resolved as a unit, in the
 * game's own tile order, independent of the window - keeps `placed(x, y)` a pure
 * function of world position. The chunk is the natural unit because the roll is
 * already seeded per chunk.
 *
 * **The approximation this buys:** entities colliding ACROSS a chunk boundary are
 * not modelled, so the edges of every chunk are slightly denser than the game's.
 * At a 32-tile chunk and a ~3-tile box that is a perimeter effect on a few percent
 * of tiles, and it is the price of purity, not an oversight.
 *
 * Caching mirrors `makePlacementRoll`: a single-slot (chunkX, chunkY) check in
 * front of a `Map`, which is what makes a row-major sweep amortise to ~1 chunk
 * resolution per 1024 tiles.
 */
export function makePlacementSet(opts: PlacementSetOptions): (x: number, y: number) => boolean {
  const cache = new Map<string, Uint8Array>();
  let lastX = NaN;
  let lastY = NaN;
  let last: Uint8Array | null = null;

  return (x, y) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (cx !== lastX || cy !== lastY || last === null) {
      const key = `${cx},${cy}`;
      let set = cache.get(key);
      if (set === undefined) {
        set = resolveChunk(cx, cy, opts);
        cache.set(key, set);
      }
      last = set;
      lastX = cx;
      lastY = cy;
    }
    return last[(ty & 31) * CHUNK + (tx & 31)] === 1;
  };
}
