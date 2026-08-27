//! The per-tile placement roll and the two gates around it.
//!
//! Ported from `src/noise/placement/placementRoll.ts`, whose module comment
//! carries the reverse engineering. What a reader of this port needs:
//!
//! `generateEntities` seeds taus88 once per chunk from the chunk position - no
//! `map_seed` anywhere in the word - then walks the chunk's 1024 tiles in
//! DECREASING tile index, drawing one `U` per tile and placing the arbitrated
//! winner where `U < probability`.
//!
//! ## Two departures, both deliberate
//!
//! 1. **No cross-overlay arbitration.** The game picks one winner per tile by
//!    maximum probability across every entity autoplacer in the chunk,
//!    including ones this app has never ported. Each overlay is rolled
//!    separately here and given its own `salt` so the streams do not
//!    correlate. The salt is the one value in this file with no counterpart in
//!    the game.
//! 2. **No jitter draws.** The game spends two extra draws per PLACEMENT to
//!    offset the entity within its tile, which makes its draw count
//!    data-dependent. Dropping them fixes the count at one draw per tile -
//!    which is what makes [`PlacementRoll::roll`] a pure function of world
//!    position, and therefore safe for the tiled renderer.
//!
//! ## The caching is not the TypeScript's, and the difference is stated
//!
//! The TypeScript puts a single-slot `(chunkX, chunkY)` check in front of a
//! `Map`, because a JavaScript `Map` lookup on a string key built per call is
//! worth avoiding. Here the key is a `(i64, i64)` in a `BTreeMap` and the
//! borrow would have to escape the `RefCell` to be held across calls, so the
//! single slot is dropped rather than reproduced. **That is a shape decision,
//! not a measured one** - no benchmark compared the two here.
//!
//! `BTreeMap` rather than `HashMap` for the reason `vulcanus_biomes`' region
//! cache gives: nothing iterates it today, and a determinism-critical port
//! should not carry a container whose iteration order is unspecified.

use crate::poison;
use crate::taus88::{seeded_state, taus88_next};
use core::cell::RefCell;
use std::collections::BTreeMap;

/// Tiles per chunk edge; 1024 tiles per chunk.
pub const CHUNK: i64 = 32;

/// Tiles in one chunk.
pub const TILES_PER_CHUNK: usize = (CHUNK * CHUNK) as usize;

/// The `(2*1+1) = 3x3` legibility mark the roll overlays paint.
///
/// A geyser is 2.8 x 2.8 tiles and a Vulcanus rock about 3 x 2.2, and both
/// place rarely enough that a 1px dot disappears. The mark is what makes the
/// overlay readable; it is also what forces the halo-widened sweep box, since
/// a mark centred just outside a worker tile still owes that tile pixels.
///
/// **Both planets' rock overlays use this radius**, and a note here used to say
/// the Nauvis one "is the exception and keeps 1x1". That was wrong when it was
/// written: `rocks/catalog.rs` has shipped `NAUVIS_ROCK_MARK_RADIUS_PX = 1` -
/// a 3x3 mark, not a single pixel - since the 2026-07-28 measurement against
/// the game's own preview moved BOTH planets off 1x1, and that constant's own
/// doc block carries the table. `renderRocks.ts` and `elevationRenderRequest.ts`
/// each carried a copy of the same stale claim.
pub const PLACEMENT_MARK_RADIUS_PX: i64 = 1;

/// Per-overlay stream salts.
///
/// Values are arbitrary and carry no meaning beyond being distinct - EXCEPT
/// [`VULCANUS_ROCKS`](salt::VULCANUS_ROCKS), which is 0 so that one overlay
/// reproduces the game's own seed word exactly and
/// [`the unit test`](placement_roll_word) can pin the reverse-engineered
/// constants against it.
///
/// Only the two Vulcanus overlays are here. The TypeScript table also carries
/// Nauvis rocks, enemy bases, crude oil, the three `random_penalty` stand-ins
/// and Fulgora scrap; each lands with the overlay that reads it, the same way
/// the resource catalog landed partial with the cliff stack.
pub mod salt {
    /// Vulcanus rocks. Zero on purpose - see the module docs.
    pub const VULCANUS_ROCKS: u32 = 0;
    /// The Vulcanus sulfuric-acid geyser.
    pub const VULCANUS_GEYSER: u32 = 0x001d_94e5;
    /// Nauvis rocks - the three rock prototypes share one stream.
    pub const NAUVIS_ROCKS: u32 = 0x005f_1e21;
    /// Nauvis enemy bases.
    pub const ENEMY_BASES: u32 = 0x00a3_c07b;
    /// The biter spawner's `random_penalty` draw.
    ///
    /// **Not a placement roll.** It stands in for a batch noise op rather than
    /// for `generateEntities`' per-tile draw, but the need is identical - a
    /// deterministic, position-pure uniform per tile - so it reuses this
    /// machinery instead of introducing a second one. Same for the spitter.
    pub const ENEMY_BITER_PENALTY: u32 = 0x002c_81d3;
    /// The spitter spawner's `random_penalty` draw.
    pub const ENEMY_SPITTER_PENALTY: u32 = 0x004e_0937;
}

/// `max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)` in `u32` arithmetic.
///
/// The clamp is the game's: an all-zero taus88 state is a fixed point, and 341
/// is the floor the engine applies to keep the seed word away from it.
#[must_use]
pub fn placement_roll_word(chunk_x: i64, chunk_y: i64, salt: u32) -> u32 {
    // The TypeScript uses `Math.imul`, which is a 32-bit signed multiply whose
    // result is taken modulo 2^32 by the following `>>> 0`. Casting through
    // `i32` reproduces that for a negative chunk coordinate, which is most of
    // the map.
    #[allow(clippy::cast_possible_truncation)]
    let cx = chunk_x as i32 as u32;
    #[allow(clippy::cast_possible_truncation)]
    let cy = chunk_y as i32 as u32;
    let sum = 0x003f_be2c_u32
        .wrapping_add(cx.wrapping_mul(7919))
        .wrapping_add(cy.wrapping_mul(7907))
        .wrapping_add(salt);
    sum.max(341)
}

/// One chunk's 1024 draws, indexed by tile index.
///
/// Draws are consumed in DECREASING tile index, so draw `k` belongs to tile
/// `1023 - k`. Getting that backwards produces a stream that is uniform,
/// deterministic and pure - and wrong at every tile, which no density check
/// would notice.
fn chunk_rolls(chunk_x: i64, chunk_y: i64, salt: u32) -> Box<[f64; TILES_PER_CHUNK]> {
    let mut state = seeded_state(placement_roll_word(chunk_x, chunk_y, salt));
    let mut out = Box::new([0.0f64; TILES_PER_CHUNK]);
    for k in 0..TILES_PER_CHUNK {
        out[TILES_PER_CHUNK - 1 - k] = f64::from(taus88_next(&mut state)) / 4_294_967_296.0;
    }
    out
}

/// One chunk's draws, keyed by chunk position.
///
/// Named because clippy's `type_complexity` fires on the `RefCell<BTreeMap<..>>`
/// spelled out, and a name is a better answer than an `allow`.
type RollCache = RefCell<BTreeMap<(i64, i64), Box<[f64; TILES_PER_CHUNK]>>>;

/// One chunk's resolved accept flags, keyed by chunk position.
type AcceptCache = RefCell<BTreeMap<(i64, i64), Box<[bool; TILES_PER_CHUNK]>>>;

/// The chunk a world position falls in, and its tile index inside that chunk.
///
/// `div_euclid` / `rem_euclid` rather than `/` and `%`, because the TypeScript
/// writes `Math.floor(tx / CHUNK)` and `tx & 31` - both of which are the
/// Euclidean forms for a negative coordinate, and neither of which is Rust's
/// truncating default.
fn chunk_of(x: f64, y: f64) -> ((i64, i64), usize) {
    #[allow(clippy::cast_possible_truncation)]
    let tx = x.floor() as i64;
    #[allow(clippy::cast_possible_truncation)]
    let ty = y.floor() as i64;
    let index = (ty.rem_euclid(CHUNK) * CHUNK + tx.rem_euclid(CHUNK)) as usize;
    ((tx.div_euclid(CHUNK), ty.div_euclid(CHUNK)), index)
}

/// `roll(x, y) -> U in [0, 1)` for one overlay. Place where `U < probability`.
///
/// The bare roll, with neither gate. It exists because the roll's own claim -
/// that it is an unbiased uniform draw, so the tiles it accepts match the
/// field's integral - holds independently of the gates, and is what localised
/// an early 2x error to the missing gates rather than to the stream.
pub struct PlacementRoll {
    salt: u32,
    cache: RollCache,
}

impl PlacementRoll {
    #[must_use]
    pub fn new(salt: u32) -> Self {
        Self {
            salt,
            cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// The draw for the tile containing `(x, y)`.
    #[must_use]
    pub fn roll(&self, x: f64, y: f64) -> f64 {
        let (chunk, index) = chunk_of(x, y);
        let mut cache = self.cache.borrow_mut();
        let rolls = cache
            .entry(chunk)
            .or_insert_with(|| chunk_rolls(chunk.0, chunk.1, self.salt));
        rolls[index]
    }
}

/// An entity's axis-aligned collision box, in tiles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementCollisionBox {
    pub w: f64,
    pub h: f64,
}

/// What one overlay contributes to the roll: the probability, and the two
/// gates the game applies around it.
///
/// A trait rather than three closures, because [`PlacementSet`] holds it for
/// the life of a render and closures capturing a borrowed stack would need the
/// same lifetime plumbing with none of the naming.
pub trait PlacementSource {
    /// The winning entity's clamped autoplace probability at this tile.
    fn probability(&self, x: f64, y: f64) -> f64;

    /// The tile-restriction gate. MUST be a pure function of world position.
    fn tile_allowed(&self, _x: f64, _y: f64) -> bool {
        true
    }

    /// The collision box for the prototype that wins this tile. `None` means
    /// the overlay does not model collision, which makes [`PlacementSet`]
    /// exactly `roll(x, y) < probability(x, y)`.
    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        None
    }
}

/// `placed(x, y) -> bool` for one overlay: the roll, plus the two gates the
/// game applies around it.
///
/// **Why a chunk resolver rather than a per-tile predicate.** Collision
/// rejection is order-dependent - whether a tile is accepted depends on which
/// of its neighbours were accepted before it. Left per-tile that would make the
/// answer depend on the render window, and the tiled-equals-whole gate would
/// fail at worker-tile seams. Containing it to a whole chunk, resolved as a
/// unit in the game's own tile order and independent of the window, keeps
/// `placed(x, y)` a pure function of world position. The chunk is the natural
/// unit because the roll is already seeded per chunk.
///
/// **The approximation this buys:** entities colliding ACROSS a chunk boundary
/// are not modelled, so the edges of every chunk are slightly denser than the
/// game's. At a 32-tile chunk and a ~3-tile box that is a perimeter effect on a
/// few percent of tiles, and it is the price of purity rather than an
/// oversight.
pub struct PlacementSet<'a> {
    salt: u32,
    source: &'a dyn PlacementSource,
    cache: AcceptCache,
}

impl<'a> PlacementSet<'a> {
    #[must_use]
    pub fn new(salt: u32, source: &'a dyn PlacementSource) -> Self {
        Self {
            salt,
            source,
            cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// Whether the overlay places an entity on the tile containing `(x, y)`.
    #[must_use]
    pub fn placed(&self, x: f64, y: f64) -> bool {
        let (chunk, index) = chunk_of(x, y);
        // The chunk is resolved OUTSIDE the borrow. Resolving calls back into
        // `source`, which is arbitrary caller code, and a `RefCell` borrow held
        // across a callback fails at RUNTIME rather than at compile time. The
        // cost is one extra map lookup on a miss, which happens once per 1024
        // tiles.
        let hit = self.cache.borrow().get(&chunk).map(|set| set[index]);
        if let Some(placed) = hit {
            return placed;
        }
        let resolved = self.resolve_chunk(chunk.0, chunk.1);
        let placed = resolved[index];
        self.cache.borrow_mut().insert(chunk, resolved);
        placed
    }

    /// Resolve one chunk's accepted-tile set, walking `k = 0..1023` and taking
    /// `tile = 1023 - k`. That is both the draw order and the game's own
    /// processing order, which is what makes the greedy collision pass
    /// reproducible.
    ///
    /// The roll is tested FIRST because a tile whose roll fails places nothing,
    /// and therefore occupies no space - which keeps the expensive gates off
    /// ~99% of tiles.
    ///
    /// **That reordering is not free in general**, and the two conditions it
    /// rests on are worth checking before reusing this:
    ///
    /// 1. **The roll must not be data-dependent.** `chunk_rolls` precomputes
    ///    all 1024 draws from the chunk seed alone, because this port drops the
    ///    game's 2 jitter draws per placement. In the game those draws make the
    ///    stream depend on what placed earlier, so there gate-first and
    ///    roll-first would consume different values.
    /// 2. **All prototypes sharing the overlay must share one
    ///    `tile_allowed`.** For Vulcanus rocks they do - all four prototypes'
    ///    `tile_restriction` lists union to "not lava" - so no other rock can
    ///    win a tile this one is barred from. With heterogeneous restrictions
    ///    the game would arbitrate to a DIFFERENT winner on a restricted tile
    ///    and roll that one's probability, which a single
    ///    probability-then-restriction test cannot express.
    fn resolve_chunk(&self, chunk_x: i64, chunk_y: i64) -> Box<[bool; TILES_PER_CHUNK]> {
        let rolls = chunk_rolls(chunk_x, chunk_y, self.salt);
        let mut accepted = Box::new([false; TILES_PER_CHUNK]);

        // Accepted boxes so far, in chunk-local tile coordinates. A chunk
        // accepts a handful of tiles in practice (~4 for Vulcanus rocks), so a
        // linear scan is both cheaper and more exact than a bounded
        // neighbourhood sweep, which would have to assume a maximum box size.
        let mut placed_boxes: Vec<(f64, f64, PlacementCollisionBox)> = Vec::new();

        for k in 0..TILES_PER_CHUNK {
            let tile = TILES_PER_CHUNK - 1 - k;
            #[allow(clippy::cast_possible_wrap)]
            let lx = (tile & 31) as i64;
            #[allow(clippy::cast_possible_wrap)]
            let ly = (tile >> 5) as i64;
            #[allow(clippy::cast_precision_loss)]
            let x = (chunk_x * CHUNK + lx) as f64;
            #[allow(clippy::cast_precision_loss)]
            let y = (chunk_y * CHUNK + ly) as f64;

            // The accept is a CLASSIFICATION, so its control is
            // `poison::bool_result` rather than a numeric hook: a one-ULP nudge
            // to a probability changes which side of this comparison a draw
            // falls on essentially never. Hooked here rather than on
            // `placed()`'s return so the perturbation also cascades through the
            // collision pass, which is the order-dependent half.
            if !poison::bool_result(rolls[tile] < self.source.probability(x, y)) {
                continue;
            }
            if !self.source.tile_allowed(x, y) {
                continue;
            }

            if let Some(b) = self.source.collision_box(x, y) {
                #[allow(clippy::cast_precision_loss)]
                let (fx, fy) = (lx as f64, ly as f64);
                // Boxes are centred on their tile (jitter is not modelled), so
                // two candidates overlap when their centre separation is under
                // the sum of their half-extents.
                let blocked = placed_boxes.iter().any(|(px, py, pb)| {
                    (fx - px).abs() < (b.w + pb.w) / 2.0 && (fy - py).abs() < (b.h + pb.h) / 2.0
                });
                if blocked {
                    continue;
                }
                placed_boxes.push((fx, fy, b));
            }

            accepted[tile] = true;
        }
        accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reverse-engineered chunk seed word, stated independently of the
    /// implementation.
    ///
    /// `generateEntities` `+52..+104`:
    /// `word = max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY)`, `u32`, with no
    /// `map_seed` term - which is the surprising half, and the reason the word
    /// is worth pinning rather than trusting.
    #[test]
    fn reproduces_the_reverse_engineered_chunk_seed_word_at_salt_zero() {
        for (cx, cy) in [(0_i64, 0_i64), (1, 0), (0, 1), (-1, -1), (37, -94)] {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let expected = 0x003f_be2c_u32
                .wrapping_add((cx as i32 as u32).wrapping_mul(7919))
                .wrapping_add((cy as i32 as u32).wrapping_mul(7907))
                .max(341);
            assert_eq!(
                placement_roll_word(cx, cy, 0),
                expected,
                "chunk ({cx}, {cy})"
            );
        }
    }

    /// The clamp is real: an all-zero taus88 state is a fixed point, so a tiny
    /// word must be lifted rather than used.
    #[test]
    fn clamps_to_341_rather_than_returning_a_tiny_word() {
        let salt = 5_u32.wrapping_sub(0x003f_be2c);
        assert_eq!(placement_roll_word(0, 0, salt), 341);
    }

    /// Different salts give different streams, which is the whole content of
    /// the salt.
    #[test]
    fn gives_different_words_for_different_salts() {
        assert_ne!(
            placement_roll_word(3, 4, salt::VULCANUS_ROCKS),
            placement_roll_word(3, 4, salt::VULCANUS_GEYSER)
        );
    }

    /// Draws are consumed in DECREASING tile index, so the FIRST draw belongs
    /// to the LAST tile.
    ///
    /// The reversal is invisible to any density or uniformity check - the
    /// stream is equally uniform either way - so it takes a positional
    /// assertion against a hand-run taus88 to see it.
    #[test]
    fn assigns_the_first_draw_to_the_last_tile() {
        let roll = PlacementRoll::new(0);
        let mut state = seeded_state(placement_roll_word(0, 0, 0));
        let first = f64::from(taus88_next(&mut state)) / 4_294_967_296.0;
        // Tile index 1023 = (y & 31) * 32 + (x & 31) at x = 31, y = 31.
        assert_eq!(roll.roll(31.0, 31.0), first);
    }

    #[test]
    fn returns_u_in_the_unit_interval() {
        let roll = PlacementRoll::new(salt::VULCANUS_GEYSER);
        let mut y = -40.0;
        while y < 40.0 {
            let mut x = -40.0;
            while x < 40.0 {
                let u = roll.roll(x, y);
                assert!((0.0..1.0).contains(&u), "U = {u} at ({x}, {y})");
                x += 7.0;
            }
            y += 7.0;
        }
    }

    /// A pure function of world position: visiting in reverse must give the
    /// same answers, which is what the tiled renderer depends on.
    #[test]
    fn is_a_pure_function_of_world_position() {
        let a = PlacementRoll::new(salt::VULCANUS_ROCKS);
        let b = PlacementRoll::new(salt::VULCANUS_ROCKS);
        let points = [
            (0.0, 0.0),
            (1000.0, -1000.0),
            (-33.0, 64.0),
            (31.0, 31.0),
            (-1.0, -1.0),
        ];
        let forward: Vec<f64> = points.iter().map(|(x, y)| a.roll(*x, *y)).collect();
        let mut backward: Vec<f64> = points.iter().rev().map(|(x, y)| b.roll(*x, *y)).collect();
        backward.reverse();
        assert_eq!(forward, backward);
    }

    /// Negative world coordinates must not collapse onto chunk 0.
    ///
    /// `(-1, -1)` is tile 1023 of chunk `(-1, -1)`; `(31, 31)` is tile 1023 of
    /// chunk `(0, 0)`. A truncating `/` and `%` would make both of them the
    /// same tile of the same chunk.
    #[test]
    fn handles_negative_world_coordinates_without_collapsing_chunks() {
        let roll = PlacementRoll::new(0);
        assert_ne!(roll.roll(-1.0, -1.0), roll.roll(31.0, 31.0));
        assert_eq!(chunk_of(-1.0, -1.0), ((-1, -1), 1023));
        assert_eq!(chunk_of(31.0, 31.0), ((0, 0), 1023));
    }

    /// Two salts must decorrelate: their placements intersect at roughly the
    /// PRODUCT of their rates, not at the smaller of the two.
    #[test]
    fn decorrelates_two_salts() {
        let a = PlacementRoll::new(salt::VULCANUS_ROCKS);
        let b = PlacementRoll::new(salt::VULCANUS_GEYSER);
        let p = 0.2;
        let (mut na, mut nb, mut both) = (0usize, 0usize, 0usize);
        for y in 0..200 {
            for x in 0..200 {
                let ha = a.roll(f64::from(x), f64::from(y)) < p;
                let hb = b.roll(f64::from(x), f64::from(y)) < p;
                if ha {
                    na += 1;
                }
                if hb {
                    nb += 1;
                }
                if ha && hb {
                    both += 1;
                }
            }
        }
        #[allow(clippy::cast_precision_loss)]
        let rate = both as f64 / (200.0 * 200.0);
        // Independent gives ~0.04; a shared stream would give ~0.2.
        assert!((0.02..0.06).contains(&rate), "intersection rate {rate}");
        assert!(na > 0 && nb > 0, "neither stream fired: {na}, {nb}");
    }

    /// With no gates supplied, the set is exactly `roll < probability`.
    #[test]
    fn with_no_gates_the_set_is_the_bare_roll() {
        struct Half;
        impl PlacementSource for Half {
            fn probability(&self, _x: f64, _y: f64) -> f64 {
                0.5
            }
        }
        let source = Half;
        let set = PlacementSet::new(salt::VULCANUS_ROCKS, &source);
        let roll = PlacementRoll::new(salt::VULCANUS_ROCKS);
        let mut agreed = 0usize;
        for y in 0..64 {
            for x in 0..64 {
                let (fx, fy) = (f64::from(x), f64::from(y));
                assert_eq!(set.placed(fx, fy), roll.roll(fx, fy) < 0.5, "({fx}, {fy})");
                if set.placed(fx, fy) {
                    agreed += 1;
                }
            }
        }
        // Non-vacuity: at p = 0.5 about half of 4096 tiles must place, so the
        // assertion above is not comparing two constant `false`s.
        assert!((1800..2300).contains(&agreed), "placements {agreed}");
    }

    /// The collision gate is order-dependent, and the order is the game's:
    /// decreasing tile index. A box big enough to cover the chunk must leave
    /// exactly ONE tile placed, and it must be the HIGHEST-indexed tile whose
    /// roll succeeded - not the lowest.
    #[test]
    fn collision_keeps_the_first_tile_in_the_games_processing_order() {
        struct Always;
        impl PlacementSource for Always {
            fn probability(&self, _x: f64, _y: f64) -> f64 {
                1.0
            }
            fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
                Some(PlacementCollisionBox {
                    w: 1000.0,
                    h: 1000.0,
                })
            }
        }
        let source = Always;
        let set = PlacementSet::new(salt::VULCANUS_ROCKS, &source);
        let mut placed = Vec::new();
        for ty in 0..32 {
            for tx in 0..32 {
                if set.placed(f64::from(tx), f64::from(ty)) {
                    placed.push((tx, ty));
                }
            }
        }
        assert_eq!(placed, vec![(31, 31)], "only tile 1023 survives");
    }

    /// The tile gate rejects, and it rejects the tiles it is told to rather
    /// than a translate of them.
    #[test]
    fn the_tile_gate_rejects_exactly_the_tiles_it_names() {
        struct EvenRowsOnly;
        impl PlacementSource for EvenRowsOnly {
            fn probability(&self, _x: f64, _y: f64) -> f64 {
                1.0
            }
            fn tile_allowed(&self, _x: f64, y: f64) -> bool {
                #[allow(clippy::cast_possible_truncation)]
                let ty = y.floor() as i64;
                ty % 2 == 0
            }
        }
        let source = EvenRowsOnly;
        let set = PlacementSet::new(salt::VULCANUS_ROCKS, &source);
        for ty in 0..32 {
            for tx in 0..32 {
                assert_eq!(
                    set.placed(f64::from(tx), f64::from(ty)),
                    ty % 2 == 0,
                    "({tx}, {ty})"
                );
            }
        }
    }

    /// A chunk resolved because of one tile must answer for every other tile of
    /// the same chunk from the cache, and give the same answers a fresh set
    /// gives when asked in a different order.
    #[test]
    fn the_chunk_cache_does_not_change_any_answer() {
        struct Sparse;
        impl PlacementSource for Sparse {
            fn probability(&self, _x: f64, _y: f64) -> f64 {
                0.05
            }
            fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
                Some(PlacementCollisionBox { w: 3.0, h: 2.2 })
            }
        }
        let source = Sparse;
        let forward = PlacementSet::new(salt::VULCANUS_ROCKS, &source);
        let backward = PlacementSet::new(salt::VULCANUS_ROCKS, &source);
        let mut count = 0usize;
        for ty in -40..40 {
            for tx in -40..40 {
                if forward.placed(f64::from(tx), f64::from(ty)) {
                    count += 1;
                }
            }
        }
        for ty in (-40..40).rev() {
            for tx in (-40..40).rev() {
                assert_eq!(
                    forward.placed(f64::from(tx), f64::from(ty)),
                    backward.placed(f64::from(tx), f64::from(ty)),
                    "({tx}, {ty})"
                );
            }
        }
        assert!(count > 0, "nothing placed, so the comparison is vacuous");
    }
}
