//! Tile correction: the pass a real surface runs after the tile argmax
//! (`TileCorrectionMapGenerationTask`), ported for Gleba (#454, slice 2) and
//! used by Aquilo and Nauvis.
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
//! ## Tiles that may not touch ([`Neighbours`])
//!
//! A tile prototype's `allowed_neighbors` (`TilePrototype +0x1b28`, made
//! symmetric in `TilePrototype::postLoadSetup`) can forbid a pair outright:
//! Nauvis's `deepwater` allows only `water`. Two more rules then apply, read
//! from the 2.1.23 binary (#454 follow-up, Nauvis):
//!
//! - In `isTileConsistentWithFixedTiles`, a fixed neighbour that does not
//!   allow the candidate makes it inconsistent at once, before any layer test,
//!   with that neighbour as the offending tile.
//! - In `correctFromTile`, when the candidate does not allow the offending
//!   tile, the next candidate is not the offending tile but the offending
//!   tile's replacement entry for the candidate (`+0x1b48`). That table is
//!   built in `GlobalContext::postPrototypesConstructedSetup`: a breadth-first
//!   search over the allowed graph from the offending tile to the candidate,
//!   which records the first step. Between deepwater and land it is `water`.
//!
//! [`Area::new`] allows every pair, which is what Gleba needs.
//!
//! ## What is not ported
//!
//! - The out-of-map tile, the list-driven re-run (`+0x48a0`), large tiles and
//!   variation selection, none of which changes a Gleba or Nauvis tile id.
//! - The replacement search runs over a planet's own tiles here, in id order;
//!   the game's runs over every tile prototype. They agree whenever the first
//!   step of every shortest path is a tile of the planet and unique, which is
//!   true for Nauvis (only `water` allows `deepwater`, measured at runtime).
//!
//! Tiles are small integer ids, `1..`, with `0` reserved (the game's empty id)
//! and [`UNKNOWN`] reserved for a tile not yet read; `layers[id]` is the tile's
//! effective layer (layer group plus offset), the only property the checks
//! compare.
//!
//! ## Reading raw tiles lazily
//!
//! [`correct_window`] is the entry point a renderer uses. It asks for a raw
//! tile only when the pass first reads it, so the outer ring of chunks, which
//! is read but never corrected, costs only the band the walks reach. The
//! output is the same as filling every tile first: a tile's value does not
//! change between the moment an eager copy would have taken it and the moment
//! the lazy read takes it, because nothing writes the world while an area is
//! alive. `lazy_and_eager_reads_agree` checks that on random grids.
//!
//! The scan also skips a walk whose seed sits in a 3 x 3 block of one id
//! (`Area::uniform_around`), a walk that can change nothing. The lazy read
//! holds whatever a walk compares. The skip holds as long as every check
//! passes over a fixed neighbour holding the candidate's own id, which is the
//! first thing `is_consistent` does, so a rule added after that test (such as
//! tiles that may not touch) keeps it exact.

use core::cell::{Cell, RefCell};

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

/// A tile id that has not been read yet. Real ids are below it.
pub const UNKNOWN: u8 = u8::MAX;

/// Where an area reads a tile it does not hold yet, by area position `(a, b)`.
type Source<'s> = RefCell<&'s mut dyn FnMut(usize, usize) -> u8>;

/// Which tile ids may touch, and what correction puts between two that may
/// not. Indexed by correction id; id 0 is unused.
pub struct Neighbours {
    allowed: Vec<Vec<bool>>,
    /// `replacement[o][c]`: the tile tried after `c` when the offending tile
    /// `o` and `c` may not touch. 0 when no path joins them.
    replacement: Vec<Vec<u8>>,
}

impl Neighbours {
    /// From a symmetric table of which ids may touch (`allowed[a][b]`, ids
    /// `0..allowed.len()`). The replacement table is the game's search: from
    /// `o`, every id `o` allows starts a path; paths grow breadth first, in id
    /// order, and the first to reach `c` names its first step.
    #[must_use]
    pub fn from_allowed(allowed: Vec<Vec<bool>>) -> Self {
        let n = allowed.len();
        let mut replacement = vec![vec![0u8; n]; n];
        for o in 1..n {
            for c in 1..n {
                replacement[o][c] = if c == o || allowed[o][c] {
                    c as u8
                } else {
                    first_step(&allowed, o, c)
                };
            }
        }
        Self {
            allowed,
            replacement,
        }
    }

    fn may_touch(&self, a: u8, b: u8) -> bool {
        self.allowed[a as usize][b as usize]
    }
}

/// The game's search for `replacement[o][c]` (see [`Neighbours::from_allowed`]).
/// The queue holds `(tile, first step)`; a tile is marked seen once it is
/// expanded, and a tile not yet seen may be queued more than once, as in the
/// game.
fn first_step(allowed: &[Vec<bool>], o: usize, c: usize) -> u8 {
    let n = allowed.len();
    let mut seen = vec![false; n];
    seen[o] = true;
    let mut queue: Vec<(usize, usize)> = Vec::new();
    for x in 1..n {
        if allowed[o][x] {
            queue.push((x, x));
            seen[x] = true;
        }
    }
    let mut i = 0;
    while i < queue.len() {
        let (t, first) = queue[i];
        i += 1;
        if t == c {
            return first as u8;
        }
        for y in 1..n {
            if allowed[t][y] && !seen[y] {
                queue.push((y, first));
            }
        }
        seen[t] = true;
    }
    0
}

/// One 96 x 96 correction area, `[a][b]`.
pub struct Area<'a> {
    tiles: Box<[[Cell<u8>; AREA]; AREA]>,
    /// Fills an [`UNKNOWN`] tile on first read; `None` when every tile was
    /// given up front.
    source: Option<Source<'a>>,
    layers: &'a [u16],
    /// `None` lets every pair touch.
    neighbours: Option<&'a Neighbours>,
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
            tiles: Box::new(tiles.map(|column| column.map(Cell::new))),
            source: None,
            layers,
            neighbours: None,
            stamps: Box::new([[0; AREA]; AREA]),
            generation: 0,
        }
    }

    /// An area that reads each tile from `source` the first time the pass
    /// needs it.
    pub fn lazy(layers: &'a [u16], source: &'a mut dyn FnMut(usize, usize) -> u8) -> Self {
        Self {
            tiles: Box::new(core::array::from_fn(|_| {
                core::array::from_fn(|_| Cell::new(UNKNOWN))
            })),
            source: Some(RefCell::new(source)),
            layers,
            neighbours: None,
            stamps: Box::new([[0; AREA]; AREA]),
            generation: 0,
        }
    }

    /// An area whose tiles obey `neighbours` (see [`Neighbours`]).
    #[must_use]
    pub fn with_neighbours(
        tiles: [[u8; AREA]; AREA],
        layers: &'a [u16],
        neighbours: &'a Neighbours,
    ) -> Self {
        let mut area = Self::new(tiles, layers);
        area.neighbours = Some(neighbours);
        area
    }

    fn may_touch(&self, a: u8, b: u8) -> bool {
        self.neighbours.is_none_or(|n| n.may_touch(a, b))
    }

    /// The tile `correctFromTile` tries after `current` was found
    /// inconsistent with `offending`: the offending tile itself, or, when the
    /// two may not touch, the offending tile's replacement for `current`.
    fn next_candidate(&self, current: u8, offending: u8) -> u8 {
        match self.neighbours {
            Some(n) if offending != current && !n.may_touch(current, offending) => {
                n.replacement[offending as usize][current as usize]
            }
            _ => offending,
        }
    }

    /// The tile at `(a, b)`.
    #[must_use]
    pub fn tile(&self, a: usize, b: usize) -> u8 {
        let cell = &self.tiles[a][b];
        let v = cell.get();
        if v != UNKNOWN {
            return v;
        }
        let source = self
            .source
            .as_ref()
            .expect("an eager area holds every tile");
        let v = (source.borrow_mut())(a, b);
        assert!(v != UNKNOWN, "a source returned the UNKNOWN id");
        cell.set(v);
        v
    }

    fn id(&self, a: i32, b: i32) -> u8 {
        self.tile(a as usize, b as usize)
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
                // A neighbour that may not touch this tile at all.
                if !self.may_touch(n, c) {
                    return fail(v);
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

    /// Whether the seed `(a, b)` and its eight neighbours all hold one id. A
    /// walk from such a seed changes nothing: each neighbour it checks sees
    /// only fixed tiles of its own id (the seed and the ring tiles fixed
    /// before it), which every check skips at `n == c`, so none is changed or
    /// queued. The scan skips those walks; that is what makes open ocean
    /// cheap. Testing ids rather than layers keeps it true for tiles that may
    /// not touch, which fail before any layer test.
    fn uniform_around(&self, a: i32, b: i32) -> bool {
        let c = self.id(a, b);
        RING.iter().all(|&(da, db)| self.id(a + da, b + db) == c)
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
                    let next = self.next_candidate(current, verdict.offending);
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
                    self.tiles[na as usize][nb as usize].set(current);
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
        self.correct_centre_chunk_skipping(true)
    }

    /// [`Self::correct_centre_chunk`], with the uniform-seed skip switchable
    /// so a test can show it changes nothing.
    fn correct_centre_chunk_skipping(&mut self, skip_uniform: bool) -> Vec<(usize, usize)> {
        let mut changed = Vec::new();
        for a in 32..64 {
            for b in 32..64 {
                if !(skip_uniform && self.uniform_around(a, b)) {
                    self.correct_from(a, b, &mut changed, false);
                }
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
/// on every side, every tile filled. Every pair of tiles may touch.
pub fn correct_chunks(
    world: &mut TileWorld,
    layers: &[u16],
    chunks_x: (i32, i32),
    chunks_y: (i32, i32),
) {
    correct_chunks_with(world, layers, None, chunks_x, chunks_y);
}

/// [`correct_chunks`] for tiles that obey `neighbours` (`None` lets every
/// pair touch).
pub fn correct_chunks_with(
    world: &mut TileWorld,
    layers: &[u16],
    neighbours: Option<&Neighbours>,
    (cx0, cx1): (i32, i32),
    (cy0, cy1): (i32, i32),
) {
    assert!(
        !world.tiles.contains(&UNKNOWN),
        "an eager world holds every tile"
    );
    correct_chunks_reading(
        world,
        &mut |_, _| unreachable!("every tile is known"),
        layers,
        neighbours,
        (cx0, cx1),
        (cy0, cy1),
    );
}

/// [`correct_chunks`] over a world whose [`UNKNOWN`] tiles are read from
/// `raw(x, y)` (world coordinates) the first time a task needs them.
fn correct_chunks_reading(
    world: &mut TileWorld,
    raw: &mut dyn FnMut(i32, i32) -> u8,
    layers: &[u16],
    neighbours: Option<&Neighbours>,
    (cx0, cx1): (i32, i32),
    (cy0, cy1): (i32, i32),
) {
    assert!(cx0 > world.chunk_x0 && cx1 < world.chunk_x0 + world.chunks_wide - 1);
    assert!(cy0 > world.chunk_y0 && cy1 < world.chunk_y0 + world.chunks_high - 1);
    let mut changes: Vec<(usize, u8)> = Vec::new();
    for cx in cx0..=cx1 {
        for cy in cy0..=cy1 {
            let (gx0, gy0) = ((cx - 1) * 32, (cy - 1) * 32);
            changes.clear();
            {
                let mut source = |a: usize, b: usize| {
                    let (x, y) = (gx0 + a as i32, gy0 + b as i32);
                    let k = world.index(x, y);
                    if world.tiles[k] == UNKNOWN {
                        world.tiles[k] = raw(x, y);
                    }
                    world.tiles[k]
                };
                let mut area = Area::lazy(layers, &mut source);
                area.neighbours = neighbours;
                for (a, b) in area.correct_centre_chunk() {
                    let v = area.tile(a, b);
                    changes.push((a * AREA + b, v));
                }
            }
            // Written back after the area is gone, in the order the task
            // reports them (a repeat writes the same final value).
            for &(ab, v) in &changes {
                let (a, b) = ((ab / AREA) as i32, (ab % AREA) as i32);
                let k = world.index(gx0 + a, gy0 + b);
                world.tiles[k] = v;
            }
        }
    }
}

/// The tiles of a window as a real surface holds them, row-major (`y` outer):
/// `raw(x, y)` is a tile's id before correction (`1..`, below [`UNKNOWN`]),
/// and correction runs over every chunk the window touches plus
/// `margin_chunks` on each side, in columns order. Raw tiles are read lazily
/// (see the module docs), so `raw` is called at most once per tile and only
/// for tiles the pass reads: every tile of the corrected chunks, and the band
/// of the ring beyond them that the walks reach.
///
/// The margin stands in for the chunks a real map has generated around the
/// window: correction writes into neighbouring chunks, so a chunk's result
/// depends on its neighbours' tasks. `neighbours` says which tiles may not
/// touch (`None` lets every pair touch).
pub fn correct_window(
    raw: &mut dyn FnMut(i32, i32) -> u8,
    layers: &[u16],
    neighbours: Option<&Neighbours>,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
) -> Vec<u8> {
    correct_window_reading_out(
        raw,
        layers,
        neighbours,
        (x0, y0),
        (width, height),
        margin_chunks,
        ((x0, y0), (width, height)),
    )
}

/// [`correct_window`], reading the result out over `out` (an origin and a
/// size, in world tiles) rather than over the window itself.
///
/// The correction is the window's, unchanged: the same chunks, the same
/// margin, the same order. Only the rectangle copied out differs, so the
/// window's own tiles come out exactly as [`correct_window`] gives them. It
/// exists for a renderer that also needs a few tiles just past the window (the
/// Nauvis rock pass's one-pixel sweep halo, #566): those sit in the margin
/// chunks this pass has already corrected, so reading them costs nothing,
/// where widening the window itself would correct a whole extra ring of
/// chunks.
///
/// `out` must lie inside the corrected chunks (the window's plus the margin),
/// which the assert checks. A tile there that no walk read is resolved through
/// `raw`, as a window tile is.
pub fn correct_window_reading_out(
    raw: &mut dyn FnMut(i32, i32) -> u8,
    layers: &[u16],
    neighbours: Option<&Neighbours>,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
    ((ox, oy), (ow, oh)): ((i32, i32), (u32, u32)),
) -> Vec<u8> {
    let chunk = |v: i32| v.div_euclid(32);
    let (cx0, cx1) = (
        chunk(x0) - margin_chunks,
        chunk(x0 + width as i32 - 1) + margin_chunks,
    );
    let (cy0, cy1) = (
        chunk(y0) - margin_chunks,
        chunk(y0 + height as i32 - 1) + margin_chunks,
    );
    let mut world = TileWorld {
        chunk_x0: cx0 - 1,
        chunk_y0: cy0 - 1,
        chunks_wide: cx1 - cx0 + 3,
        chunks_high: cy1 - cy0 + 3,
        tiles: Vec::new(),
    };
    world.tiles = vec![UNKNOWN; world.width() * (world.chunks_high * 32) as usize];
    correct_chunks_reading(&mut world, raw, layers, neighbours, (cx0, cx1), (cy0, cy1));
    if ow > 0 && oh > 0 {
        assert!(
            chunk(ox) >= cx0
                && chunk(ox + ow as i32 - 1) <= cx1
                && chunk(oy) >= cy0
                && chunk(oy + oh as i32 - 1) <= cy1,
            "the read-out rectangle must lie inside the corrected chunks"
        );
    }
    let mut out = Vec::with_capacity(ow as usize * oh as usize);
    for y in oy..oy + oh as i32 {
        for x in ox..ox + ow as i32 {
            let k = world.index(x, y);
            if world.tiles[k] == UNKNOWN {
                world.tiles[k] = raw(x, y);
            }
            out.push(world.tiles[k]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small deterministic generator, so the grids need no dependency.
    fn lcg(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *state >> 33
    }

    /// Blobby random tiles over a world: ids 1..=4 with distinct layers, in
    /// patches, so correction has strips and corners to fix.
    fn raw_tile(seed: u64, x: i32, y: i32) -> u8 {
        let mut s =
            seed ^ ((x.div_euclid(3) as u64) << 32) ^ (y.div_euclid(3) as u64 & 0xffff_ffff);
        lcg(&mut s);
        let base = (lcg(&mut s) % 4) as u8 + 1;
        let mut t = seed.wrapping_add(((x as u64) << 20) ^ (y as u64));
        lcg(&mut t);
        if lcg(&mut t).is_multiple_of(7) {
            (lcg(&mut t) % 4) as u8 + 1
        } else {
            base
        }
    }

    /// A rule for the random grids: id 1 may touch only id 2, the shape of
    /// Nauvis's deepwater. The tests below run with and without it.
    fn one_touches_only_two() -> Neighbours {
        let mut allowed = vec![vec![true; 5]; 5];
        for (i, row) in allowed.iter_mut().enumerate() {
            row[i] = false;
        }
        for other in [3, 4] {
            allowed[1][other] = false;
            allowed[other][1] = false;
        }
        Neighbours::from_allowed(allowed)
    }

    /// Skipping the walks from seeds inside a block of one id changes neither
    /// the tiles nor the positions written back, on random areas where
    /// correction has plenty to do, with and without a neighbour rule.
    #[test]
    fn skipping_uniform_seeds_changes_nothing() {
        let layers = [0, 10, 20, 30, 40];
        let rule = one_touches_only_two();
        for rules in [None, Some(&rule)] {
            skipping_uniform_seeds_changes_nothing_under(&layers, rules);
        }
    }

    fn skipping_uniform_seeds_changes_nothing_under(layers: &[u16], rules: Option<&Neighbours>) {
        let mut skipped_somewhere = false;
        for seed in 0..12u64 {
            let mut tiles = [[0u8; AREA]; AREA];
            for (a, column) in tiles.iter_mut().enumerate() {
                for (b, t) in column.iter_mut().enumerate() {
                    *t = raw_tile(seed, a as i32, b as i32);
                }
            }
            let mut with = Area::new(tiles, layers);
            let mut without = Area::new(tiles, layers);
            with.neighbours = rules;
            without.neighbours = rules;
            for a in 32..64 {
                for b in 32..64 {
                    skipped_somewhere |= with.uniform_around(a, b);
                }
            }
            let written = (
                with.correct_centre_chunk_skipping(true),
                without.correct_centre_chunk_skipping(false),
            );
            assert!(!written.1.is_empty(), "seed {seed}: nothing to correct");
            assert_eq!(written.0, written.1, "seed {seed}: written positions");
            for a in 0..AREA {
                for b in 0..AREA {
                    assert_eq!(
                        with.tile(a, b),
                        without.tile(a, b),
                        "seed {seed} at ({a}, {b})"
                    );
                }
            }
        }
        assert!(
            skipped_somewhere,
            "no seed was uniform, so nothing was tested"
        );
    }

    /// The lazy window and an eager world corrected over the same chunks give
    /// the same tiles, and the lazy one reads fewer raw tiles. Over several
    /// seeds, windows and margins, so a lazy read that went stale would show,
    /// with and without a neighbour rule. The rule must also change the
    /// result somewhere, or its arm would grade nothing.
    #[test]
    fn lazy_and_eager_reads_agree() {
        let layers = [0, 10, 20, 30, 40];
        let rule = one_touches_only_two();
        let plain = lazy_and_eager_reads_agree_under(&layers, None);
        let ruled = lazy_and_eager_reads_agree_under(&layers, Some(&rule));
        assert_ne!(plain, ruled, "the neighbour rule changed no tile");
    }

    fn lazy_and_eager_reads_agree_under(
        layers: &[u16],
        rules: Option<&Neighbours>,
    ) -> Vec<Vec<u8>> {
        let mut results = Vec::new();
        for seed in 0..6u64 {
            for &((x0, y0), (w, h), margin) in &[
                ((-40, 17), (70u32, 50u32), 1),
                ((0, 0), (64, 64), 0),
                ((-96, -64), (100, 100), 1),
            ] {
                let mut reads = 0usize;
                let lazy = correct_window(
                    &mut |x, y| {
                        reads += 1;
                        raw_tile(seed, x, y)
                    },
                    layers,
                    rules,
                    (x0, y0),
                    (w, h),
                    margin,
                );

                let chunk = |v: i32| v.div_euclid(32);
                let (cx0, cx1) = (chunk(x0) - margin, chunk(x0 + w as i32 - 1) + margin);
                let (cy0, cy1) = (chunk(y0) - margin, chunk(y0 + h as i32 - 1) + margin);
                let mut world = TileWorld {
                    chunk_x0: cx0 - 1,
                    chunk_y0: cy0 - 1,
                    chunks_wide: cx1 - cx0 + 3,
                    chunks_high: cy1 - cy0 + 3,
                    tiles: Vec::new(),
                };
                let (wx0, wy0) = (world.chunk_x0 * 32, world.chunk_y0 * 32);
                let (ww, wh) = (world.width(), (world.chunks_high * 32) as usize);
                for j in 0..wh {
                    for i in 0..ww {
                        world
                            .tiles
                            .push(raw_tile(seed, wx0 + i as i32, wy0 + j as i32));
                    }
                }
                let raw_world = world.tiles.clone();
                correct_chunks_with(&mut world, layers, rules, (cx0, cx1), (cy0, cy1));
                let mut eager = Vec::new();
                for y in y0..y0 + h as i32 {
                    for x in x0..x0 + w as i32 {
                        eager.push(world.at(x, y));
                    }
                }
                assert_eq!(lazy, eager, "seed {seed}, window ({x0}, {y0})");
                // Non-vacuity: correction changed something, and the lazy
                // pass skipped part of the outer ring.
                let changed = world
                    .tiles
                    .iter()
                    .zip(&raw_world)
                    .filter(|(a, b)| a != b)
                    .count();
                assert!(changed > 0, "seed {seed}: nothing to correct");
                assert!(reads < ww * wh, "seed {seed}: read {reads} of {}", ww * wh);
                results.push(lazy);
            }
        }
        results
    }

    /// Ids 1..=3 in a chain: 1 may touch only 2, 2 touches both, 3 only 2. Id
    /// 4 touches nothing. The deepwater, water, land shape, plus an island.
    fn chain() -> Neighbours {
        let mut allowed = vec![vec![false; 5]; 5];
        for (a, b) in [(1, 2), (2, 3)] {
            allowed[a][b] = true;
            allowed[b][a] = true;
        }
        Neighbours::from_allowed(allowed)
    }

    /// The replacement is the first step from the offending tile toward the
    /// candidate, the tile itself when the two may touch, and 0 when nothing
    /// joins them.
    #[test]
    fn the_replacement_is_the_first_step_of_the_search() {
        let n = chain();
        assert_eq!(n.replacement[1][3], 2);
        assert_eq!(n.replacement[3][1], 2);
        assert_eq!(n.replacement[1][2], 2);
        assert_eq!(n.replacement[2][3], 3);
        assert_eq!(n.replacement[1][4], 0);
        assert_eq!(n.replacement[4][1], 0);
    }

    /// The search takes the first step in id order when two paths are equally
    /// short: 1 reaches 4 through 2 or 3, and 2 comes first.
    #[test]
    fn a_tie_between_paths_goes_to_the_lower_id() {
        let mut allowed = vec![vec![false; 5]; 5];
        for (a, b) in [(1, 2), (1, 3), (2, 4), (3, 4)] {
            allowed[a][b] = true;
            allowed[b][a] = true;
        }
        assert_eq!(Neighbours::from_allowed(allowed).replacement[1][4], 2);
    }

    /// An area half "land" (3) and half "deepwater" (1), both on one layer, so
    /// the layer checks see nothing to fix. Without the neighbour rule nothing
    /// changes; with it, every changed tile becomes "water" (2), and no
    /// deepwater touches land in the centre chunk.
    #[test]
    fn forbidden_neighbours_are_replaced_by_the_tile_between_them() {
        let layers = [0u16, 10, 10, 10, 10];
        let mut tiles = [[3u8; AREA]; AREA];
        for column in tiles.iter_mut().skip(48) {
            *column = [1u8; AREA];
        }
        let mut plain = Area::new(tiles, &layers);
        assert!(plain.correct_centre_chunk().is_empty());

        let rules = chain();
        let mut area = Area::with_neighbours(tiles, &layers, &rules);
        let changed = area.correct_centre_chunk();
        assert!(!changed.is_empty());
        for (a, b) in &changed {
            assert_eq!(area.tile(*a, *b), 2, "({a}, {b})");
        }
        for a in 32..64i32 {
            for b in 32..64i32 {
                if area.id(a, b) != 1 {
                    continue;
                }
                for (da, db) in RING {
                    assert_ne!(area.id(a + da, b + db), 3, "({a}, {b})");
                }
            }
        }
    }
}

// The order the game queues correction tasks in, near the edge of a request.
// Tests model it; renderers keep columns order (see
// `requested_correction_order`).

/// Run the correction task for each chunk of `order`, in that order, as
/// `correct_chunks` does in columns order. Tiles of `world` that are
/// [`UNKNOWN`] are read from `raw(x, y)` the first time a task needs them, and
/// `neighbours` says which tiles may not touch (`None` lets every pair touch).
/// The world must hold one chunk more on every side of every chunk named.
pub fn correct_chunks_in_order(
    world: &mut TileWorld,
    raw: &mut dyn FnMut(i32, i32) -> u8,
    layers: &[u16],
    neighbours: Option<&Neighbours>,
    order: &[(i32, i32)],
) {
    let mut changes: Vec<(usize, u8)> = Vec::new();
    for &(cx, cy) in order {
        assert!(cx > world.chunk_x0 && cx < world.chunk_x0 + world.chunks_wide - 1);
        assert!(cy > world.chunk_y0 && cy < world.chunk_y0 + world.chunks_high - 1);
        let (gx0, gy0) = ((cx - 1) * 32, (cy - 1) * 32);
        changes.clear();
        {
            let mut source = |a: usize, b: usize| {
                let (x, y) = (gx0 + a as i32, gy0 + b as i32);
                let k = world.index(x, y);
                if world.tiles[k] == UNKNOWN {
                    world.tiles[k] = raw(x, y);
                }
                world.tiles[k]
            };
            let mut area = Area::lazy(layers, &mut source);
            area.neighbours = neighbours;
            for (a, b) in area.correct_centre_chunk() {
                changes.push((a * AREA + b, area.tile(a, b)));
            }
        }
        for &(ab, v) in &changes {
            let (a, b) = ((ab / AREA) as i32, (ab % AREA) as i32);
            let k = world.index(gx0 + a, gy0 + b);
            world.tiles[k] = v;
        }
    }
}

/// The order the game queues tile-correction tasks in when `requested` chunks
/// are requested one after another (`MapGenerationManager::request`, read
/// from the 2.1.23 binary).
///
/// A request for a chunk asks for its 3 x 3 neighbourhood one stage lower
/// first, depth first, and queues a stage only after its prerequisites: a
/// chunk's entity stage needs its 3 x 3 at the stage after correction, and each
/// of those needs its own 3 x 3 corrected. The neighbours are visited x outer,
/// y inner, the chunk itself included, and a chunk already queued at a stage
/// is not queued again. So one request queues the 5 x 5 around it, and a run
/// of requests corrects close to, but not exactly in, columns order. Each
/// queue then runs in full, so this is the order the tasks run.
///
/// `generateAllSynchronously` runs the queues; the spawn-area radius request
/// asks for its chunks in columns order (measured: a radius request and a
/// chunk-by-chunk columns request give the same surface).
///
/// **Inside a generated area this gives the same tiles as [`correct_chunks`]'s
/// columns order; it differs within about two chunks of the edge of what was
/// requested.** Measured on real surfaces: on Fulgora a radius-6 request
/// differs from radius 7, 10 and 18 at 5 tiles near its edge, and a rows-order
/// request at 10; on Gleba a rows-order request is 16 tiles off columns order.
/// This order reproduces all of them at every tile. A renderer cannot know
/// what a game requested, so the renderers use columns order, and this is the
/// tests' model of the edge.
#[must_use]
pub fn requested_correction_order(requested: &[(i32, i32)]) -> Vec<(i32, i32)> {
    let around =
        |(x, y): (i32, i32)| (-1..=1).flat_map(move |dx| (-1..=1).map(move |dy| (x + dx, y + dy)));
    let mut after_correction = std::collections::HashSet::new();
    let mut corrected = std::collections::HashSet::new();
    let mut order = Vec::new();
    for &chunk in requested {
        for n in around(chunk) {
            if !after_correction.insert(n) {
                continue;
            }
            for m in around(n) {
                if corrected.insert(m) {
                    order.push(m);
                }
            }
        }
    }
    order
}

#[cfg(test)]
mod request_order_tests {
    use super::*;

    /// One request queues the 5 x 5 around it, in the order the nested
    /// neighbour walk first reaches each chunk.
    #[test]
    fn one_request_queues_its_five_by_five_in_walk_order() {
        let order = requested_correction_order(&[(0, 0)]);
        assert_eq!(
            order,
            vec![
                (-2, -2),
                (-2, -1),
                (-2, 0),
                (-1, -2),
                (-1, -1),
                (-1, 0),
                (0, -2),
                (0, -1),
                (0, 0),
                (-2, 1),
                (-1, 1),
                (0, 1),
                (-2, 2),
                (-1, 2),
                (0, 2),
                (1, -2),
                (1, -1),
                (1, 0),
                (1, 1),
                (1, 2),
                (2, -2),
                (2, -1),
                (2, 0),
                (2, 1),
                (2, 2),
            ]
        );
    }

    /// A second request queues only the chunks the first did not, and the
    /// order is not columns: the next column's top arrives before this
    /// column's bottom.
    #[test]
    fn a_second_request_adds_only_new_chunks() {
        let order = requested_correction_order(&[(0, 0), (0, 1)]);
        assert_eq!(order.len(), 30);
        assert_eq!(&order[25..], &[(-2, 3), (-1, 3), (0, 3), (1, 3), (2, 3)]);
        let columns: Vec<_> = (-2..=2)
            .flat_map(|x| (-2..=3).map(move |y| (x, y)))
            .collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, columns, "every chunk once");
        assert_ne!(order, columns, "and not in columns order");
    }

    /// The order and the touching rule compose: in columns order with a rule
    /// that forbids 1 beside 3, `correct_chunks_in_order` is
    /// `correct_chunks_with`, and the rule changes the result.
    #[test]
    fn the_order_and_the_neighbour_rule_compose() {
        let layers = [0u16, 1, 2, 3];
        let mut allowed = vec![vec![true; 4]; 4];
        allowed[1][3] = false;
        allowed[3][1] = false;
        let rules = Neighbours::from_allowed(allowed);
        let mut tiles = Vec::new();
        let mut r = 0x2545_f491u32;
        for _ in 0..(5 * 32) * (5 * 32) {
            r ^= r << 13;
            r ^= r >> 17;
            r ^= r << 5;
            tiles.push((r % 3) as u8 + 1);
        }
        let world = || TileWorld {
            chunk_x0: 0,
            chunk_y0: 0,
            chunks_wide: 5,
            chunks_high: 5,
            tiles: tiles.clone(),
        };
        let (mut a, mut b, mut plain) = (world(), world(), world());
        correct_chunks_with(&mut a, &layers, Some(&rules), (1, 3), (1, 3));
        let columns: Vec<_> = (1..=3).flat_map(|x| (1..=3).map(move |y| (x, y))).collect();
        correct_chunks_in_order(
            &mut b,
            &mut |_, _| unreachable!(),
            &layers,
            Some(&rules),
            &columns,
        );
        assert!(a.tiles == b.tiles, "the two paths agree under the rule");
        correct_chunks_in_order(
            &mut plain,
            &mut |_, _| unreachable!(),
            &layers,
            None,
            &columns,
        );
        assert!(a.tiles != plain.tiles, "the rule reaches the result");
    }

    /// `correct_chunks` is columns order, and on noisy tiles the order the
    /// tasks run in changes the result, which is why the order is modelled.
    #[test]
    fn correct_chunks_is_columns_order() {
        let layers = [0u16, 1, 2, 3];
        let mut tiles = Vec::new();
        let mut r = 0x9e37_79b9u32;
        for _ in 0..(5 * 32) * (5 * 32) {
            r ^= r << 13;
            r ^= r >> 17;
            r ^= r << 5;
            tiles.push((r % 3) as u8 + 1);
        }
        let world = |tiles: &Vec<u8>| TileWorld {
            chunk_x0: 0,
            chunk_y0: 0,
            chunks_wide: 5,
            chunks_high: 5,
            tiles: tiles.clone(),
        };
        let (mut a, mut b, mut c) = (world(&tiles), world(&tiles), world(&tiles));
        correct_chunks(&mut a, &layers, (1, 3), (1, 3));
        let columns: Vec<_> = (1..=3).flat_map(|x| (1..=3).map(move |y| (x, y))).collect();
        correct_chunks_in_order(&mut b, &mut |_, _| unreachable!(), &layers, None, &columns);
        assert_eq!(a.tiles, b.tiles);
        assert!(a.tiles != tiles, "correction changed something");
        let rows: Vec<_> = (1..=3).flat_map(|y| (1..=3).map(move |x| (x, y))).collect();
        correct_chunks_in_order(&mut c, &mut |_, _| unreachable!(), &layers, None, &rows);
        let moved = a.tiles.iter().zip(&c.tiles).filter(|(x, y)| x != y).count();
        assert!(moved > 0, "the order matters");
    }
}
