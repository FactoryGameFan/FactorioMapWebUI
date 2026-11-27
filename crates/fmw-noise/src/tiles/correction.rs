//! Tile correction: the pass a real surface runs after the tile argmax
//! (`TileCorrectionMapGenerationTask`), ported for Gleba (#454, slice 2).
//!
//! Read out of the Factorio 2.1.23 linux64 headless binary (build 87750) with
//! Ghidra, then checked against real surfaces: the reverse-engineering notes are
//! `docs/noise/tile-correction-NOTES.md`. The game's own map preview does NOT
//! run this pass; a generated surface does, so a player's map shows its result.
//!
//! ## What it does
//!
//! It removes tile shapes the transition art cannot draw: mostly a lower-layer
//! tile one tile wide between two higher-layer tiles, and diagonal-only
//! contacts. A tile in such a shape is replaced by the neighbour tile that made
//! it inconsistent, and the change spreads outward.
//!
//! - **One task per chunk.** It copies the chunk and its eight neighbours into a
//!   96 x 96 area, indexed `[a][b]` with `a` the x offset and `b` the y offset,
//!   so the centre chunk is `32..64` on both.
//! - **The scan.** For every tile of the centre chunk, `a` outer then `b` inner,
//!   it runs [`Area::correct_from`]: a breadth-first walk outward from that tile over
//!   a "fixed" map that starts with only the seed. Each tile the walk reaches is
//!   checked against its FIXED neighbours ([`Area::is_consistent`]); while it is not
//!   consistent it takes the tile that made it so, and a cycle stops on the tile
//!   it returned to. A changed tile, or one the check asked to revisit, joins
//!   the walk. Every reached tile becomes fixed.
//! - **The second pass.** Every tile the scan changed is checked again against
//!   ALL its neighbours, and walked again if it fails. In the game the tiles the
//!   second pass changes are pushed into the walk's own queue, which the next
//!   walk clears, so only the last walk's tiles are written back. That looks
//!   like an accident and it is copied exactly (`shared queue` below): without
//!   it, two of 65,536 tiles come out different.
//! - **Write-back.** The changed tiles are written to the surface, anywhere in
//!   the 3 x 3 chunks, and later tasks read them. So **the result depends on
//!   the order the chunks are corrected in.** [`correct_chunks`] uses columns
//!   (x outer, y inner), which is what one `request_to_generate_chunks` with a
//!   radius produces, the way a game start asks for its spawn area. Requesting
//!   the same chunks one by one in another order moved 16 to 450 of 65,536
//!   tiles in the game (`scripts/probes/gleba-real-surface/README.md`).
//!
//! ## What is not ported
//!
//! - The prototype table that says which tiles may touch (`TilePrototype` at
//!   `+0x1b28`, with a replacement table at `+0x1b48`). Every Gleba tile may
//!   touch every other here; a planet with `allowed_neighbors` needs it.
//! - The out-of-map tile, the list-driven re-run (`+0x48a0`), large tiles and
//!   variation selection, none of which changes a Gleba tile id.
//!
//! Tiles are small integer ids, `1..`, with `0` reserved (the game's empty id);
//! `layers[id]` is the tile's effective layer (layer group plus offset), the
//! only property the checks compare.

/// The side of a correction area: three chunks.
pub const AREA: usize = 96;

const AREA_I: i32 = AREA as i32;

/// The eight neighbours in the order the walk visits them, `(da, db)`. Read
/// from the binary's table at `.rodata 0xede450`.
const RING: [(i32, i32); 8] = [
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];

/// One 96 x 96 correction area, `[a][b]`.
pub struct Area<'a> {
    tiles: Box<[[u8; AREA]; AREA]>,
    layers: &'a [u16],
    /// The walk's "fixed" map, as generation stamps: a tile is fixed when its
    /// stamp equals `generation`. Bumping the generation clears the map, which
    /// the game does with a 9 KB `memset` per walk.
    stamps: Box<[[u32; AREA]; AREA]>,
    generation: u32,
}

/// Whether a neighbour's state is read through the fixed map or not: the scan
/// checks against fixed tiles only, the second pass against every tile.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fixed {
    Walk,
    All,
}

/// What [`Area::is_consistent`] reports, the game's two out-parameters
/// included.
struct Verdict {
    consistent: bool,
    /// The tile should join the walk even if it does not change.
    revisit: bool,
    /// The last neighbour tile examined: the replacement when inconsistent.
    offending: u8,
}

fn in_area(v: i32) -> bool {
    (0..AREA_I).contains(&v)
}

impl<'a> Area<'a> {
    /// An area of tile ids, `tiles[a][b]`.
    #[must_use]
    pub fn new(tiles: [[u8; AREA]; AREA], layers: &'a [u16]) -> Self {
        Self {
            tiles: Box::new(tiles),
            layers,
            stamps: Box::new([[0; AREA]; AREA]),
            generation: 0,
        }
    }

    /// The tile at `(a, b)`.
    #[must_use]
    pub fn tile(&self, a: usize, b: usize) -> u8 {
        self.tiles[a][b]
    }

    fn id(&self, a: i32, b: i32) -> u8 {
        self.tiles[a as usize][b as usize]
    }

    fn layer(&self, a: i32, b: i32) -> u16 {
        self.layers[self.id(a, b) as usize]
    }

    fn is_fixed(&self, mode: Fixed, a: i32, b: i32) -> bool {
        mode == Fixed::All || self.stamps[a as usize][b as usize] == self.generation
    }

    fn fix(&mut self, a: i32, b: i32) {
        self.stamps[a as usize][b as usize] = self.generation;
    }

    /// `countFixedNeighborsOfKind`: how many of the eight neighbours of
    /// `(a, b)` hold `id`. Despite the name it reads no fixed map.
    fn count_neighbours_of(&self, a: i32, b: i32, id: u8) -> u32 {
        let mut n = 0;
        for (da, db) in RING {
            let (x, y) = (a + da, b + db);
            if in_area(x) && in_area(y) && self.id(x, y) == id {
                n += 1;
            }
        }
        n
    }

    /// `checkForWeakDiagonalSupport`: one of two orthogonal pairs around
    /// `(a, b)` is entirely "high", where off the area, not fixed, or above
    /// `layer` all count. `which` picks the pairs: true is up-left and
    /// down-right, false up-right and down-left.
    fn weak_diagonal_support(&self, a: i32, b: i32, which: bool, layer: u16, mode: Fixed) -> bool {
        let high = |x: i32, y: i32| -> bool {
            !(in_area(x) && in_area(y)) || !self.is_fixed(mode, x, y) || layer < self.layer(x, y)
        };
        if which {
            (high(a - 1, b) && high(a, b - 1)) || (high(a + 1, b) && high(a, b + 1))
        } else {
            (high(a - 1, b) && high(a, b + 1)) || (high(a + 1, b) && high(a, b - 1))
        }
    }

    /// The same two pairs, but "high" needs the neighbour fixed and above
    /// `layer` (off the area still counts). The inlined strong check inside
    /// the higher-neighbour arm of [`Self::is_consistent`].
    fn strong_diagonal_support(
        &self,
        a: i32,
        b: i32,
        which: bool,
        layer: u16,
        mode: Fixed,
    ) -> bool {
        let high = |x: i32, y: i32| -> bool {
            !(in_area(x) && in_area(y)) || (self.is_fixed(mode, x, y) && layer < self.layer(x, y))
        };
        if which {
            (high(a - 1, b) && high(a, b - 1)) || (high(a + 1, b) && high(a, b + 1))
        } else {
            (high(a - 1, b) && high(a, b + 1)) || (high(a + 1, b) && high(a, b - 1))
        }
    }

    /// `isTileConsistentWithFixedTiles`: whether tile `c` may stand at
    /// `(a, b)` given its fixed neighbours. Transcribed branch for branch from
    /// the decompiled function, labels in the comments.
    #[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
    fn is_consistent(&self, a: i32, b: i32, c: u8, mode: Fixed) -> Verdict {
        let lc = self.layers[c as usize];
        let mut v = Verdict {
            consistent: true,
            revisit: false,
            offending: 0,
        };
        let fail = |mut v: Verdict| {
            v.consistent = false;
            v
        };
        let walk = mode == Fixed::Walk;
        for da in -1..=1i32 {
            for db in -1..=1i32 {
                if (da, db) == (0, 0) {
                    continue;
                }
                let (r, cc) = (a + da, b + db);
                if !(in_area(r) && in_area(cc) && self.is_fixed(mode, r, cc)) {
                    continue;
                }
                let n = self.id(r, cc);
                v.offending = n;
                if n == c {
                    continue;
                }
                let ln = self.layers[n as usize];
                if ln == lc {
                    continue;
                }
                let diag = da != 0 && db != 0;
                let which = da != db;

                // A lower neighbour with a higher tile beyond it: the
                // neighbour is a one-wide strip.
                if ln < lc {
                    let (ba, bb) = (a + 2 * da, b + 2 * db);
                    if in_area(ba) && in_area(bb) {
                        let beyond = self.id(ba, bb);
                        if beyond != n && ln < self.layers[beyond as usize] {
                            let mut check_weak = false;
                            if walk {
                                let beyond_fixed = self.is_fixed(mode, ba, bb);
                                if beyond_fixed {
                                    if !diag {
                                        return fail(v);
                                    }
                                    check_weak = true;
                                } else if !diag
                                    && self.count_neighbours_of(ba, bb, n)
                                        < self.count_neighbours_of(a, b, n)
                                {
                                    return fail(v);
                                }
                            } else {
                                if !diag {
                                    return fail(v);
                                }
                                check_weak = true;
                            }
                            if check_weak && !self.weak_diagonal_support(r, cc, which, ln, mode) {
                                return fail(v);
                            }
                        }
                    }
                }

                // A higher neighbour with a higher tile opposite: this tile
                // is the one-wide strip.
                let (oa, ob) = (a - da, b - db);
                if ln > lc
                    && in_area(oa)
                    && in_area(ob)
                    && self.id(oa, ob) != c
                    && self.layer(oa, ob) > lc
                {
                    if !(diag && self.weak_diagonal_support(a, b, which, lc, mode)) {
                        // L5907: fails outright unless the opposite tile is
                        // still free in the walk.
                        if !walk || self.is_fixed(mode, oa, ob) {
                            return fail(v);
                        }
                        v.revisit = true;
                    } else if !self.strong_diagonal_support(a, b, which, lc, mode) {
                        // L5921: weak support only.
                        v.revisit = true;
                    }
                }

                // A lower diagonal neighbour (L592b).
                if ln < lc && diag {
                    let rb = b + 2 * db;
                    let x2 = a + 2 * da;
                    let first = in_area(rb)
                        && self.is_fixed(mode, r, rb)
                        && self.id(r, rb) != n
                        && in_area(a)
                        && ln < self.layer(r, rb);
                    let mut check_second = true;
                    if first {
                        if walk && !self.is_fixed(mode, a, cc) {
                            v.revisit = true;
                        } else if self.layer(a, cc) <= ln {
                            return fail(v);
                        }
                        if !in_area(x2) || (walk && !self.is_fixed(mode, x2, cc)) {
                            check_second = false;
                        }
                    } else if !in_area(x2) || !self.is_fixed(mode, x2, cc) {
                        check_second = false;
                    }
                    if check_second && self.id(x2, cc) != n && in_area(b) && ln < self.layer(x2, cc)
                    {
                        if walk && !self.is_fixed(mode, r, b) {
                            v.revisit = true;
                        } else if self.layer(r, b) <= ln {
                            return fail(v);
                        }
                    }
                }

                // A higher diagonal neighbour (L5adf).
                if lc < ln && diag {
                    if in_area(oa) && in_area(b) && self.id(oa, b) != c && lc < self.layer(oa, b) {
                        if walk {
                            if !self.is_fixed(mode, a, cc) {
                                v.revisit = true;
                            } else if self.layer(a, cc) <= lc {
                                if self.is_fixed(mode, oa, b) {
                                    return fail(v);
                                }
                                v.revisit = true;
                            }
                        } else if self.layer(a, cc) <= lc {
                            return fail(v);
                        }
                    }
                    // L5b98
                    let yb = b - db;
                    if in_area(yb) && self.id(a, yb) != c && lc < self.layer(a, yb) {
                        if walk {
                            if self.is_fixed(mode, r, b) {
                                if lc < self.layer(r, b) {
                                    continue;
                                }
                                if self.is_fixed(mode, a, yb) {
                                    return fail(v);
                                }
                            }
                            v.revisit = true;
                        } else if self.layer(r, b) <= lc {
                            return fail(v);
                        }
                    }
                }
            }
        }
        v
    }

    /// `correctFromTile`: the breadth-first walk from `(a, b)`.
    ///
    /// Changed tiles go to `changed`, or, with `shared` set, into the walk's
    /// own queue (the second pass passes the queue as its changed list). Returns
    /// the queue as it ends.
    fn correct_from(
        &mut self,
        a: i32,
        b: i32,
        changed: &mut Vec<(i32, i32)>,
        shared: bool,
    ) -> Vec<(i32, i32)> {
        self.generation += 1;
        let mut queue = vec![(a, b)];
        self.fix(a, b);
        let mut i = 0;
        while i < queue.len() {
            let (qa, qb) = queue[i];
            i += 1;
            for (da, db) in RING {
                let (na, nb) = (qa + da, qb + db);
                if !(in_area(na) && in_area(nb)) || self.is_fixed(Fixed::Walk, na, nb) {
                    continue;
                }
                let original = self.id(na, nb);
                let mut tried: Vec<u8> = Vec::new();
                let mut current = original;
                let mut revisit;
                loop {
                    let verdict = self.is_consistent(na, nb, current, Fixed::Walk);
                    revisit = verdict.revisit;
                    if verdict.consistent {
                        break;
                    }
                    tried.push(current);
                    let next = verdict.offending;
                    let cycled = tried.contains(&next);
                    current = next;
                    if cycled || next == 0 {
                        break;
                    }
                }
                if current == original || current == 0 {
                    if revisit {
                        queue.push((na, nb));
                    }
                } else {
                    if shared {
                        queue.push((na, nb));
                    } else {
                        changed.push((na, nb));
                    }
                    self.tiles[na as usize][nb as usize] = current;
                    queue.push((na, nb));
                }
                self.fix(na, nb);
            }
        }
        queue
    }

    /// The whole task for the centre chunk: the scan, then the second pass.
    /// Returns the positions the game writes back, possibly with repeats.
    pub fn correct_centre_chunk(&mut self) -> Vec<(usize, usize)> {
        let mut changed = Vec::new();
        for a in 32..64 {
            for b in 32..64 {
                self.correct_from(a, b, &mut changed, false);
            }
        }
        let first = changed.clone();
        let mut unused = Vec::new();
        let mut last_queue = Vec::new();
        for (a, b) in first {
            let c = self.id(a, b);
            if !self.is_consistent(a, b, c, Fixed::All).consistent {
                last_queue = self.correct_from(a, b, &mut unused, true);
            }
        }
        changed.extend(last_queue);
        changed
            .into_iter()
            .map(|(a, b)| (a as usize, b as usize))
            .collect()
    }
}

/// A rectangle of tile ids in world coordinates, row-major (`y` outer), whose
/// corner sits on a chunk corner.
pub struct TileWorld {
    /// The world chunk at the rectangle's top-left.
    pub chunk_x0: i32,
    pub chunk_y0: i32,
    /// Size in chunks.
    pub chunks_wide: i32,
    pub chunks_high: i32,
    /// `tiles[(y - 32 * chunk_y0) * width + (x - 32 * chunk_x0)]`.
    pub tiles: Vec<u8>,
}

impl TileWorld {
    /// Width in tiles.
    #[must_use]
    pub fn width(&self) -> usize {
        (self.chunks_wide * 32) as usize
    }

    fn index(&self, x: i32, y: i32) -> usize {
        let (i, j) = (x - 32 * self.chunk_x0, y - 32 * self.chunk_y0);
        j as usize * self.width() + i as usize
    }

    /// The tile at world `(x, y)`, which must lie inside.
    #[must_use]
    pub fn at(&self, x: i32, y: i32) -> u8 {
        self.tiles[self.index(x, y)]
    }
}

/// Run the correction task for every chunk in `cx0..=cx1` by `cy0..=cy1`, in
/// columns order (x outer, y inner), each reading and writing `world` as the
/// game's tasks read and write the surface. The world must hold one chunk more
/// on every side.
pub fn correct_chunks(
    world: &mut TileWorld,
    layers: &[u16],
    (cx0, cx1): (i32, i32),
    (cy0, cy1): (i32, i32),
) {
    assert!(cx0 > world.chunk_x0 && cx1 < world.chunk_x0 + world.chunks_wide - 1);
    assert!(cy0 > world.chunk_y0 && cy1 < world.chunk_y0 + world.chunks_high - 1);
    for cx in cx0..=cx1 {
        for cy in cy0..=cy1 {
            let (gx0, gy0) = ((cx - 1) * 32, (cy - 1) * 32);
            let mut tiles = [[0u8; AREA]; AREA];
            for (a, column) in tiles.iter_mut().enumerate() {
                for (b, t) in column.iter_mut().enumerate() {
                    *t = world.at(gx0 + a as i32, gy0 + b as i32);
                }
            }
            let mut area = Area::new(tiles, layers);
            for (a, b) in area.correct_centre_chunk() {
                let k = world.index(gx0 + a as i32, gy0 + b as i32);
                world.tiles[k] = area.tile(a, b);
            }
        }
    }
}
