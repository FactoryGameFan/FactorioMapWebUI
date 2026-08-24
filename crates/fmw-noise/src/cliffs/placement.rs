//! Cliff placement: the 4-tile corner lattice, `CliffGenerator::crossesCliff`,
//! the per-chunk repair sweep, and the `toMaybeCliffOrientation` filter that
//! turns four edge crossings into a placed cliff.
//!
//! Ported from `src/noise/cliffs/cliffPlacement.ts`. Everything here is engine
//! behaviour; the planet enters only through the two fields and the two band
//! numbers.
//!
//! ## What is a lever and what is the game
//!
//! The TypeScript carries several options that are explicitly **not** the
//! game's rule, added so a spec could measure what a rule is worth (#84). They
//! are ported because a control that only exists in the other language is not a
//! control for this one - the whole point of `sweep_edge_order` is that a
//! residual which does NOT move when the order is permuted is not caused by the
//! order, and that argument has to be runnable here too.
//!
//! [`CliffBands::default`] is the game: `L, T, R, B`, the repair sweep on, no
//! cascade, and the rejections acting on the crossing.

use crate::cliffs::catalog::{
    cliff_collision_tile_box, is_cliff_placed, CHUNK_CELLS, CLIFF_CELL_CENTER_X,
    CLIFF_CELL_CENTER_Y, CLIFF_GRID_SIZE,
};
use crate::poison;

/// The two fields the placement pass samples at the corner lattice.
///
/// A trait rather than a pair of closures because `cliffiness` is evaluated at
/// every corner of every chunk the query touches and dominates the pass - the
/// TypeScript's own measurement says so - so it is the one call here worth
/// keeping static.
pub trait CliffFields {
    /// `cliff_elevation`, which band a cliff sits on.
    ///
    /// **Not the same field as the tile generator's `elevation`.**
    /// `multisample`'s offsets are in the CONSUMING program's grid units, and
    /// the cliff generator walks a 4-tile lattice where every per-tile consumer
    /// walks 1, so a 2x2 min-filter spans 4 tiles here and 1 there (#83).
    fn cliff_elevation(&self, x: f64, y: f64) -> f64;

    /// `cliffiness`, the gate on whether a cell may carry a cliff at all.
    ///
    /// Its SHAPE is planet-specific: Nauvis's `cliffiness_nauvis` is a hard 0
    /// or 10, Vulcanus's `cliffiness_basic` is continuous on `[0.5, 1.5]`. The
    /// comparison below is the same either way.
    fn cliffiness(&self, x: f64, y: f64) -> f64;
}

/// A tile-collision rejection: `true` for a tile a cliff cannot occupy.
///
/// `tryToAddCliff` looks up the cell's orientation, takes that orientation's
/// `collision_bounding_box`, and scans the inclusive tile rectangle against the
/// tile mask grid. Which tiles collide is planet-specific; the rule is not - a
/// tile collides when its `CollisionMask` shares a layer with the cliff's, and
/// the cliff mask holds `water_tile`.
pub trait TileCollision {
    fn collides(&self, x: i64, y: i64) -> bool;
}

/// An additional per-cell rejection, called with the cell's crossing code and
/// its centre. Return `true` to drop the cell.
///
/// **Deliberately opaque.** This module is planet-agnostic, and the one rule
/// that uses this hook is planet-specific and only partly explained - Vulcanus's
/// ORE -> CLIFF suppression, whose mechanism is
/// `ResourceEntityPrototype::cliff_removal_probability` but whose geometry is
/// still an empirical fit. Keeping it a bare predicate is what stops such a rule
/// from leaking into the shared core.
pub trait CellRejection {
    fn rejects(&self, code: u8, x: f64, y: f64) -> bool;
}

/// The order the repair sweep tries edges in, as indices
/// `0 = L (west)`, `1 = T (north)`, `2 = R (east)`, `3 = B (south)`.
///
/// The engine's order, and the default. **A permutation is not the game's
/// rule** - it exists only so a residual concentrated on one edge can be asked
/// whether it MOVES with the order. One that relocates is caused by the order;
/// one that does not is not.
pub const SWEEP_EDGE_ORDER_LTRB: [usize; 4] = [0, 1, 2, 3];

/// Band phase and spacing, plus the levers.
#[derive(Debug, Clone, Copy)]
pub struct CliffBands {
    /// `cliff_elevation_0`: the elevation of the first cliff band.
    pub elevation0: f64,
    /// `cliff_elevation_interval`, already divided by the frequency lever.
    pub interval: f64,
    /// `cliff_smoothing`, 0..1.
    ///
    /// **A planet-level constant, and getting it wrong is invisible on Nauvis
    /// and catastrophic on Vulcanus.** Nauvis, Fulgora and Gleba all set 0
    /// explicitly; Vulcanus sets nothing and takes the prototype default of 1.
    /// With Nauvis's 0 the Vulcanus port reproduced 57-69% of real cliffs while
    /// placing 1.1-1.6x too many (#18).
    pub smoothing: f64,
    /// Run `CellEdgeCliffCrossingArray::fixImpossibleCells`. The game always
    /// does - `crossingsForChunk` calls it unconditionally at its tail - so
    /// `false` is a measurement lever, not a configuration.
    pub fix_impossible_cells: bool,
    /// When true, [`CliffPlacement::placed_cells`] returns nothing.
    pub disabled: bool,
    /// Apply the rejections by zeroing the rejected cell's four edge registers
    /// after the repair sweep, instead of filtering the emitted cell. A
    /// neighbour sharing one of those edges therefore loses it too, and its
    /// orientation changes.
    ///
    /// **The post-filter reading is refuted as a description of the output.**
    /// It came from `tryToAddCliff` ignoring `wouldCollide`'s return value, and
    /// `test/vulcanusCliffRejectionStage.spec.ts` measured it: under a
    /// post-filter a surviving cell keeps an edge whose neighbour was rejected,
    /// which the model predicts 1,662 times and the game shows 0 times.
    pub reject_at_crossing_stage: bool,
    /// Re-run the rejection pass until it finds nothing, so a cell whose
    /// ORIENTATION changed because a neighbour's edges were zeroed is re-tested
    /// with its new collision box.
    ///
    /// Measured and **rejected**: a bit-for-bit no-op at the shipping settings
    /// and net harmful on the collapsed rule. Rejected cells do not turn
    /// neighbours rejectable.
    pub rejection_cascades: bool,
    /// See [`SWEEP_EDGE_ORDER_LTRB`].
    pub sweep_edge_order: [usize; 4],
}

impl Default for CliffBands {
    /// The game's rules, with the two band numbers left at Nauvis's defaults.
    /// Callers set `elevation0`, `interval` and `smoothing` for their planet.
    fn default() -> Self {
        Self {
            elevation0: 10.0,
            interval: 40.0,
            smoothing: 0.0,
            fix_impossible_cells: true,
            disabled: false,
            reject_at_crossing_stage: false,
            rejection_cascades: false,
            sweep_edge_order: SWEEP_EDGE_ORDER_LTRB,
        }
    }
}

/// A placed cliff: the cell centre, plus the 8-bit edge-crossing `code`.
///
/// The code is carried out rather than discarded because it is the only thing
/// that names the cliff's ORIENTATION, and therefore its collision box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacedCliffCell {
    pub x: f64,
    pub y: f64,
    pub code: u8,
}

/// `CliffGenerator::crossesCliff(a, b, cliffinessAvg, elevation_0, interval)`:
/// does the edge between two corners cross a cliff band, and which way?
///
/// Returns `0` (no crossing), `+1` (crossing up, low-to-high in `a`/`b` order)
/// or `-1` (crossing down). Both elevations must be non-negative and their max
/// must reach `elevation_0`; the cliffiness gate compares the AVERAGE of the two
/// corners' cliffiness against `0.5`, not against zero.
///
/// **This is the op's poison hook**, and it has to be here rather than on a
/// numeric field: the output is a tri-state classification, and a one-ULP nudge
/// to an input changes which side of a comparison a value falls on essentially
/// never. Rotating the crossing is the smallest wrong answer this op can give -
/// the same argument [`poison::index_result`] carries for an argmax.
#[must_use]
pub fn crosses_cliff(a: f64, b: f64, cliff_avg: f64, e0: f64, interval: f64) -> i8 {
    poison::crossing_result(crosses_cliff_inner(a, b, cliff_avg, e0, interval))
}

fn crosses_cliff_inner(a: f64, b: f64, cliff_avg: f64, e0: f64, interval: f64) -> i8 {
    if a < 0.0 || b < 0.0 {
        return 0;
    }
    let boundary = e0 + interval * ((crate::eval::math::max2(a, b) - e0) / interval).floor();
    if boundary < e0 {
        return 0;
    }
    let d_a = a - boundary;
    let d_b = b - boundary;
    if cliff_avg > 0.5 {
        if d_a < 0.0 && d_b > 0.0 {
            return 1;
        }
        if d_a > 0.0 && d_b < 0.0 {
            return -1;
        }
    }
    0
}

/// Packs the four edge crossings into the cell code the orientation table keys
/// on. `-1` encodes as `3`, which `& 3` on a two's-complement value gives for
/// free - the same identity the TypeScript relies on.
#[inline]
#[must_use]
pub fn cell_code(l: i8, r: i8, t: i8, b: i8) -> u8 {
    let f = |v: i8| (i32::from(v)) & 3;
    ((f(l) << 6) | (f(r) << 4) | (f(t) << 2) | f(b)) as u8
}

/// The knot pair and blend fraction `cliff_smoothing` interpolates a corner
/// between, for one axis.
///
/// `crossingsForChunk` walks each chunk's own 9x9 corner block and, per axis,
/// takes `lo = i & ~3`, `hi = min(lo + 4, CHUNK_CELLS - 1)`, `t = (i & 3) /
/// (hi - lo)` on the IN-CHUNK index. So the knots land at in-chunk indices 0, 4
/// and 7 - the second span is three corners wide, not four, because `hi` clamps
/// to 7 rather than to the block edge at 8.
///
/// That asymmetry is not a misreading. It is what makes smoothing "inaccurate"
/// in the prototype docs' own words, and it anchors the smoothed field to the
/// chunk grid, so it is deliberately discontinuous every 32 tiles. Index 8
/// falls out with `t = 0` on itself, which is the same world point as the next
/// chunk's index 0 - also a knot - so the two chunks agree there and this
/// reduces to a function of the GLOBAL corner index with no chunk loop.
#[must_use]
pub fn smoothing_knots(index: i64) -> (i64, i64, f64) {
    let n = CHUNK_CELLS as i64;
    let i = index.rem_euclid(n);
    let base = index - i;
    let lo = i & !3;
    let hi = (lo + 4).min(n - 1);
    #[allow(clippy::cast_precision_loss)]
    let t = ((i & 3) as f64) / ((hi - lo) as f64);
    (base + lo, base + hi, t)
}

/// `CellEdgeCliffCrossingArray::fixImpossibleCells`, the pass that runs at the
/// tail of `crossingsForChunk`.
///
/// It is a **single forward sweep** over one chunk's 8x8 cells (row-major, `cy`
/// outer), not a fixpoint: clearing an edge changes the two cells that share it,
/// and cells already visited are never revisited. Porting it as a
/// relax-until-stable loop would be a different algorithm.
///
/// Per cell it clears edges until the code is one the orientation table accepts,
/// choosing the first **clearable** edge in `order`. An edge is clearable only
/// if it is not on the chunk's outer boundary, so the chunk cannot disturb its
/// neighbours - which is what keeps the pass chunk-local and lets it run with no
/// chunk-ordering dependence.
///
/// The legality predicate needs no new table: the accepted set is exactly
/// [`is_cliff_placed`] plus code `0`, which is what extracting both of the
/// disassembly's jump tables and comparing against the placing codes showed.
///
/// **The `bool` parameter is a retry flag the function sets on ITSELF**, not a
/// caller-supplied mode - which is how it was read until 2026-07-30.
/// `crossingsForChunk` passes `false`, and an earlier note concluded from that
/// alone that the corner step never runs. It does: when the sweep reaches a cell
/// it cannot fix it turns the flag on and **restarts the whole pass**, which
/// this time begins by zeroing the eight outer edges of the chunk's four corner
/// cells. A second failure logs and abandons the rest of the chunk. Note the
/// restart re-sweeps the arrays **as already mutated** by the abandoned pass -
/// it is not a fresh start from the raw crossings.
pub fn fix_impossible_cells_sweep(
    v: &mut [i8],
    h: &mut [i8],
    w: usize,
    hh: usize,
    order: [usize; 4],
) {
    let v_index = |cx: usize, cy: usize| cy * (w + 1) + cx;
    let h_index = |cx: usize, cy: usize| cy * w + cx;
    // The sweep's own poison hook - see `poison::sweep_order` for why the choice
    // of edge, and not the crossings feeding it, is what this op can get wrong.
    let order = poison::sweep_order(order);

    let mut retry = 0usize;
    loop {
        if retry > 0 {
            // The eight edges: the two outer edges of each corner cell. Zeroing
            // these is what can make an otherwise unfixable corner cell legal,
            // since its only remaining crossings were the ones the sweep is
            // forbidden to clear.
            v[v_index(0, 0)] = 0;
            h[h_index(0, 0)] = 0;
            v[v_index(w, 0)] = 0;
            h[h_index(w - 1, 0)] = 0;
            v[v_index(0, hh - 1)] = 0;
            h[h_index(0, hh)] = 0;
            v[v_index(w, hh - 1)] = 0;
            h[h_index(w - 1, hh)] = 0;
        }

        let mut stuck = false;
        'sweep: for cy in 0..hh {
            for cx in 0..w {
                let li = v_index(cx, cy);
                let ri = v_index(cx + 1, cy);
                let ti = h_index(cx, cy);
                let bi = h_index(cx, cy + 1);

                loop {
                    let code = cell_code(v[li], v[ri], h[ti], h[bi]);
                    // The engine first counts non-zero edges and only consults
                    // the table when the count is below 3. That is pure
                    // optimisation: every placing code has one or two
                    // crossings, so 3 or 4 can never be legal.
                    if code == 0 || is_cliff_placed(code) {
                        break;
                    }
                    let mut cleared = false;
                    for e in order {
                        match e {
                            0 if v[li] != 0 && cx != 0 => v[li] = 0,
                            1 if h[ti] != 0 && cy != 0 => h[ti] = 0,
                            2 if v[ri] != 0 && cx < w - 1 => v[ri] = 0,
                            3 if h[bi] != 0 && cy < hh - 1 => h[bi] = 0,
                            _ => continue,
                        }
                        cleared = true;
                        break;
                    }
                    if !cleared {
                        stuck = true;
                        break 'sweep;
                    }
                }
            }
        }

        // Not stuck -> the pass completed. Stuck on the retry -> the engine logs
        // and abandons the chunk, leaving the arrays as they are.
        if !stuck || retry > 0 {
            return;
        }
        retry += 1;
    }
}

/// The placed-cliff-cell query for one cliff configuration.
///
/// Built from the planet-agnostic geometry plus whatever the caller supplies:
/// the two fields, the two band numbers, and up to two rejections.
pub struct CliffPlacement<'a, F: CliffFields> {
    fields: &'a F,
    bands: CliffBands,
    tile_collides: Option<&'a dyn TileCollision>,
    cell_rejects: Option<&'a dyn CellRejection>,
}

impl<'a, F: CliffFields> CliffPlacement<'a, F> {
    #[must_use]
    pub fn new(fields: &'a F, bands: CliffBands) -> Self {
        Self {
            fields,
            bands,
            tile_collides: None,
            cell_rejects: None,
        }
    }

    #[must_use]
    pub fn with_tile_collision(mut self, t: &'a dyn TileCollision) -> Self {
        self.tile_collides = Some(t);
        self
    }

    #[must_use]
    pub fn with_cell_rejection(mut self, c: &'a dyn CellRejection) -> Self {
        self.cell_rejects = Some(c);
        self
    }

    /// `tryToAddCliff`'s rejection as a predicate on an already-placed cell:
    /// scan the orientation's collision box and drop the cell if any tile in it
    /// collides. With no [`TileCollision`] supplied this is a constant `false`
    /// and costs nothing - the box is never even resolved.
    ///
    /// Nothing narrows the box: `wouldCollide` floors the stored rectangle with
    /// `(box + position) >> 8` and scans the inclusive tile rect, with the box's
    /// own `1/8` orientation tag discarded.
    fn rejected(&self, code: u8, x: f64, y: f64) -> bool {
        let Some(t) = self.tile_collides else {
            return false;
        };
        // `None` only for a code that places nothing, which cannot reach here.
        let Some(b) = cliff_collision_tile_box(code, x, y) else {
            return false;
        };
        for tx in b.left..=b.right {
            for ty in b.top..=b.bottom {
                if t.collides(tx, ty) {
                    return true;
                }
            }
        }
        false
    }

    fn cell_rejected(&self, code: u8, x: f64, y: f64) -> bool {
        self.cell_rejects.is_some_and(|c| c.rejects(code, x, y))
    }

    /// Enumerate the 4-tile placement grid over a world box and return the
    /// centre of every cell whose crossing code places a cliff.
    ///
    /// The chunk-structured path is the game's: each chunk builds its own edge
    /// arrays and runs the repair sweep in isolation, **including recomputing
    /// the edges it shares with its neighbours**, which both chunks own a
    /// private copy of. That is what makes the result independent of the query
    /// box, so worker tiling stays byte-identical.
    #[must_use]
    pub fn placed_cells(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<PlacedCliffCell> {
        if self.bands.disabled {
            return Vec::new();
        }

        // The INCLUSIVE cell-index range whose centres land in the query box.
        // Cell `cx` sits at `cx * G + CX`, and the emit filter keeps it when
        // that is in `[x0, x1)`, so the range is `ceil((x0 - CX) / G)` through
        // `ceil((x1 - CX) / G) - 1`.
        //
        // These used to be `floor`/`ceil` in the TypeScript, which overshot by
        // one cell at each end. Every extra cell was discarded by the emit
        // filter, so the OUTPUT was correct - but the chunk loop rounds this
        // range out to whole chunks, and one extra cell pulls in a whole extra
        // 8-cell chunk on each side. That is a fixed +2 chunks per axis per
        // call, measured at 1.83x the cliffiness samples when tiled.
        let ceil_cell = |v: f64, centre: f64| ((v - centre) / CLIFF_GRID_SIZE).ceil() as i64;
        let cx_min = ceil_cell(x0, CLIFF_CELL_CENTER_X);
        let cx_max = ceil_cell(x1, CLIFF_CELL_CENTER_X) - 1;
        let cy_min = ceil_cell(y0, CLIFF_CELL_CENTER_Y);
        let cy_max = ceil_cell(y1, CLIFF_CELL_CENTER_Y) - 1;
        if cx_max < cx_min || cy_max < cy_min {
            return Vec::new();
        }

        let n = CHUNK_CELLS;
        let (chunk_x0, chunk_x1, chunk_y0, chunk_y1) = if self.bands.fix_impossible_cells {
            (
                cx_min.div_euclid(n as i64),
                cx_max.div_euclid(n as i64),
                cy_min.div_euclid(n as i64),
                cy_max.div_euclid(n as i64),
            )
        } else {
            // The unswept path walks the cell range directly, so its corner
            // rectangle is the cells' own, one wider on each high side.
            (cx_min, cx_max, cy_min, cy_max)
        };

        // The corner indices actually sampled. The swept path walks each
        // chunk's own 9x9 block, so it reaches one corner past the last chunk.
        let (ci0, ci1, cj0, cj1) = if self.bands.fix_impossible_cells {
            (
                chunk_x0 * n as i64,
                (chunk_x1 + 1) * n as i64,
                chunk_y0 * n as i64,
                (chunk_y1 + 1) * n as i64,
            )
        } else {
            (cx_min, cx_max + 1, cy_min, cy_max + 1)
        };
        let mut corners = CornerCache::new(
            self.fields,
            self.bands.smoothing,
            CornerRect::covering(ci0, ci1, cj0, cj1),
        );

        let e0 = self.bands.elevation0;
        let interval = self.bands.interval;

        if !self.bands.fix_impossible_cells {
            let mut result = Vec::new();
            for cy in cy_min..=cy_max {
                for cx in cx_min..=cx_max {
                    let a = corners.get(cx, cy);
                    let b = corners.get(cx, cy + 1);
                    let c = corners.get(cx + 1, cy);
                    let d = corners.get(cx + 1, cy + 1);
                    let l = cross(a, b, e0, interval);
                    let r = cross(c, d, e0, interval);
                    let t = cross(a, c, e0, interval);
                    let bo = cross(b, d, e0, interval);
                    let code = cell_code(l, r, t, bo);
                    if !is_cliff_placed(code) {
                        continue;
                    }
                    #[allow(clippy::cast_precision_loss)]
                    let x = cx as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X;
                    #[allow(clippy::cast_precision_loss)]
                    let y = cy as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y;
                    if x < x0 || x >= x1 || y < y0 || y >= y1 {
                        continue;
                    }
                    if self.rejected(code, x, y) || self.cell_rejected(code, x, y) {
                        continue;
                    }
                    result.push(PlacedCliffCell { x, y, code });
                }
            }
            return result;
        }

        let mut result = Vec::new();
        let mut v = vec![0i8; (n + 1) * n];
        let mut h = vec![0i8; n * (n + 1)];

        for ch_y in chunk_y0..=chunk_y1 {
            for ch_x in chunk_x0..=chunk_x1 {
                let base_x = ch_x * n as i64;
                let base_y = ch_y * n as i64;

                for cy in 0..n {
                    for cx in 0..=n {
                        let a = corners.get(base_x + cx as i64, base_y + cy as i64);
                        let b = corners.get(base_x + cx as i64, base_y + cy as i64 + 1);
                        v[cy * (n + 1) + cx] = cross(a, b, e0, interval);
                    }
                }
                for cy in 0..=n {
                    for cx in 0..n {
                        let a = corners.get(base_x + cx as i64, base_y + cy as i64);
                        let b = corners.get(base_x + cx as i64 + 1, base_y + cy as i64);
                        h[cy * n + cx] = cross(a, b, e0, interval);
                    }
                }

                fix_impossible_cells_sweep(&mut v, &mut h, n, n, self.bands.sweep_edge_order);

                if self.bands.reject_at_crossing_stage {
                    self.apply_crossing_stage_rejections(&mut v, &mut h, n, base_x, base_y);
                }

                for cy in 0..n {
                    for cx in 0..n {
                        let code = cell_code(
                            v[cy * (n + 1) + cx],
                            v[cy * (n + 1) + cx + 1],
                            h[cy * n + cx],
                            h[(cy + 1) * n + cx],
                        );
                        if !is_cliff_placed(code) {
                            continue;
                        }
                        #[allow(clippy::cast_precision_loss)]
                        let x = (base_x + cx as i64) as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X;
                        #[allow(clippy::cast_precision_loss)]
                        let y = (base_y + cy as i64) as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y;
                        // Bounds-test BEFORE the collision test: the rejection
                        // resolves tiles and is the expensive half, and a chunk
                        // always overhangs the query box.
                        if x < x0 || x >= x1 || y < y0 || y >= y1 {
                            continue;
                        }
                        if !self.bands.reject_at_crossing_stage
                            && (self.rejected(code, x, y) || self.cell_rejected(code, x, y))
                        {
                            continue;
                        }
                        result.push(PlacedCliffCell { x, y, code });
                    }
                }
            }
        }
        result
    }

    /// Collect first, then clear: a cell's rejection is decided from the code
    /// the repair left, not from a code a previous cell's clearing has already
    /// eaten into.
    ///
    /// The zeroing runs over the whole chunk, including cells outside the query
    /// box, which is what keeps worker tiling byte-identical.
    fn apply_crossing_stage_rejections(
        &self,
        v: &mut [i8],
        h: &mut [i8],
        n: usize,
        base_x: i64,
        base_y: i64,
    ) {
        let mut pass = 0usize;
        loop {
            let mut kill: Vec<(usize, usize)> = Vec::new();
            for cy in 0..n {
                for cx in 0..n {
                    let code = cell_code(
                        v[cy * (n + 1) + cx],
                        v[cy * (n + 1) + cx + 1],
                        h[cy * n + cx],
                        h[(cy + 1) * n + cx],
                    );
                    if !is_cliff_placed(code) {
                        continue;
                    }
                    #[allow(clippy::cast_precision_loss)]
                    let x = (base_x + cx as i64) as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X;
                    #[allow(clippy::cast_precision_loss)]
                    let y = (base_y + cy as i64) as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y;
                    if self.rejected(code, x, y) || self.cell_rejected(code, x, y) {
                        kill.push((cx, cy));
                    }
                }
            }
            for (cx, cy) in &kill {
                v[cy * (n + 1) + cx] = 0;
                v[cy * (n + 1) + cx + 1] = 0;
                h[cy * n + cx] = 0;
                h[(cy + 1) * n + cx] = 0;
            }
            pass += 1;
            // One pass is the shipping model; the cascade stops when a pass
            // finds nothing, and `pass` is bounded by the cell count anyway.
            if !self.bands.rejection_cascades || kill.is_empty() || pass > 64 {
                return;
            }
        }
    }
}

/// One corner's two field samples.
#[derive(Clone, Copy)]
struct CornerSample {
    elev: f64,
    cliff: f64,
}

fn cross(p: CornerSample, q: CornerSample, e0: f64, interval: f64) -> i8 {
    crosses_cliff(p.elev, q.elev, (p.cliff + q.cliff) / 2.0, e0, interval)
}

/// The inclusive corner-index rectangle one `placed_cells` call touches,
/// widened to cover the smoothing knots those corners read.
#[derive(Clone, Copy)]
struct CornerRect {
    i0: i64,
    j0: i64,
    i1: i64,
    j1: i64,
}

impl CornerRect {
    /// Widen a sampled corner range to every index [`smoothing_knots`] can
    /// return for it.
    ///
    /// The low side rounds down to a chunk boundary, because `base` is the
    /// largest multiple of `CHUNK_CELLS` at or below the index. The high side
    /// gains `CHUNK_CELLS - 1`, because `hi` is at most `base + 7`.
    ///
    /// **The high pad is load-bearing at `t = 0`, which is the case that looks
    /// safe to drop.** A corner sitting exactly on a chunk boundary is its own
    /// `lo` knot with `t = 0`, so its `hi` knot is multiplied by zero and
    /// contributes nothing to the result - but it is still READ, exactly as the
    /// TypeScript reads it. Skipping the read instead of padding for it would
    /// change the arithmetic from `a + 0.0 * b` to `a`, which agree only while
    /// `b` is finite. `cliff_elevation` is finite today; that is a property of
    /// the field, not of this cache, and it is not this module's to assume.
    fn covering(i0: i64, i1: i64, j0: i64, j1: i64) -> Self {
        let n = CHUNK_CELLS as i64;
        Self {
            i0: i0.div_euclid(n) * n,
            j0: j0.div_euclid(n) * n,
            i1: i1 + n - 1,
            j1: j1 + n - 1,
        }
    }
}

/// The two per-corner caches, as dense grids over [`CornerRect`].
///
/// The TypeScript keys these by a `"i,j"` string in a `Map`; the query's corner
/// range is a known dense rectangle, so an index into a `Vec` is both cheaper
/// and simpler. Nothing about the OUTPUT depends on the choice - both fields are
/// pure functions of position - but the smoothing knots are read repeatedly and
/// `cliffiness` dominates the pass, so the cache is not optional.
///
/// **It allocates for the whole rectangle up front, and there is no cap on
/// that.** Worth stating rather than leaving to be discovered, because this
/// module sits behind a boundary whose contract is that errors return a status
/// and never trap: a caller-supplied query box large enough to exhaust linear
/// memory would abort the instance instead.
///
/// No cap is imposed anyway, and that is a deliberate choice rather than an
/// oversight. The chunk-structured pass VISITS essentially every corner of its
/// rectangle, so the TypeScript's `Map` ends up holding the same count - as
/// string keys and boxed numbers, so strictly more memory for the same query.
/// A cap here would reject renders the TypeScript performs happily, which is a
/// behaviour difference, and behaviour parity is the whole point of the port.
///
/// The exposure is small in practice and that is measured rather than hoped:
/// the app tiles cliff renders into 64-pixel workers, so a request's rectangle
/// is a few thousand corners whatever the zoom. A cap belongs here only if a
/// whole-image cliff render at a high tiles-per-pixel ever becomes a real call
/// site, and then it belongs on BOTH sides.
struct CornerCache<'a, F: CliffFields> {
    fields: &'a F,
    smoothing: f64,
    rect: CornerRect,
    w: usize,
    raw: Vec<f64>,
    raw_seen: Vec<bool>,
    sample: Vec<CornerSample>,
    sample_seen: Vec<bool>,
}

impl<'a, F: CliffFields> CornerCache<'a, F> {
    fn new(fields: &'a F, smoothing: f64, rect: CornerRect) -> Self {
        let w = (rect.i1 - rect.i0 + 1) as usize;
        let hh = (rect.j1 - rect.j0 + 1) as usize;
        let cells = w * hh;
        Self {
            fields,
            smoothing,
            rect,
            w,
            raw: vec![0.0; cells],
            raw_seen: vec![false; cells],
            sample: vec![
                CornerSample {
                    elev: 0.0,
                    cliff: 0.0
                };
                cells
            ],
            sample_seen: vec![false; cells],
        }
    }

    fn index(&self, i: i64, j: i64) -> usize {
        debug_assert!(i >= self.rect.i0 && i <= self.rect.i1);
        debug_assert!(j >= self.rect.j0 && j <= self.rect.j1);
        (j - self.rect.j0) as usize * self.w + (i - self.rect.i0) as usize
    }

    /// The unsmoothed `cliff_elevation` at a corner. Sampled at the BARE lattice
    /// `(i*4, j*4)` - the prototype's `grid_offset` is a CENTRE offset and
    /// `crossingsForChunk` never reads it.
    fn raw_elevation(&mut self, i: i64, j: i64) -> f64 {
        let k = self.index(i, j);
        if !self.raw_seen[k] {
            #[allow(clippy::cast_precision_loss)]
            let value = self
                .fields
                .cliff_elevation(i as f64 * CLIFF_GRID_SIZE, j as f64 * CLIFF_GRID_SIZE);
            self.raw[k] = value;
            self.raw_seen[k] = true;
        }
        self.raw[k]
    }

    /// `cliff_smoothing` applied to the cliff ELEVATION register only -
    /// cliffiness is read unsmoothed, because `crossingsForChunk` smooths the
    /// register at `[settings+0x1e0]` and then reads `[+0x1e4]` raw.
    ///
    /// At `s = 1` the `E(i,j)` term vanishes exactly, so the raw sample is
    /// skipped and only the knot corners are ever evaluated. That makes
    /// smoothing slightly cheaper than no smoothing rather than dearer.
    fn elevation_at(&mut self, i: i64, j: i64) -> f64 {
        if self.smoothing == 0.0 {
            return self.raw_elevation(i, j);
        }
        let (ilo, ihi, tx) = smoothing_knots(i);
        let (jlo, jhi, ty) = smoothing_knots(j);
        let bilinear = (1.0 - tx) * (1.0 - ty) * self.raw_elevation(ilo, jlo)
            + tx * (1.0 - ty) * self.raw_elevation(ihi, jlo)
            + (1.0 - tx) * ty * self.raw_elevation(ilo, jhi)
            + tx * ty * self.raw_elevation(ihi, jhi);
        if self.smoothing == 1.0 {
            return bilinear;
        }
        (1.0 - self.smoothing) * self.raw_elevation(i, j) + self.smoothing * bilinear
    }

    fn get(&mut self, i: i64, j: i64) -> CornerSample {
        let k = self.index(i, j);
        if !self.sample_seen[k] {
            let elev = self.elevation_at(i, j);
            #[allow(clippy::cast_precision_loss)]
            let cliff = self
                .fields
                .cliffiness(i as f64 * CLIFF_GRID_SIZE, j as f64 * CLIFF_GRID_SIZE);
            self.sample[k] = CornerSample { elev, cliff };
            self.sample_seen[k] = true;
        }
        self.sample[k]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sweep clears the FIRST CLEARABLE edge in `L, T, R, B`, and the choice
    /// is observable: an interior cell with all four edges crossing is illegal,
    /// and which two survive depends entirely on the order.
    ///
    /// Set up so nothing else in the chunk moves - every other cell's code is
    /// already legal, checked by the assertion on the untouched edges - so this
    /// isolates the choice rather than the sweep as a whole.
    ///
    /// **This is the test that sees [`poison::sweep_order`]**, and nothing else
    /// does: the end-to-end cliff fixture is red under poison from the crossing
    /// hook alone.
    #[test]
    fn the_sweep_clears_the_first_clearable_edge_in_l_t_r_b_order() {
        let n = CHUNK_CELLS;
        let build = || {
            let mut v = vec![0i8; (n + 1) * n];
            let mut h = vec![0i8; n * (n + 1)];
            // The four edges of interior cell (1, 1), all crossing upward.
            v[(n + 1) + 1] = 1; // L
            v[(n + 1) + 2] = 1; // R
            h[n + 1] = 1; // T
            h[2 * n + 1] = 1; // B
            (v, h)
        };
        let code_at = |v: &[i8], h: &[i8], cx: usize, cy: usize| {
            cell_code(
                v[cy * (n + 1) + cx],
                v[cy * (n + 1) + cx + 1],
                h[cy * n + cx],
                h[(cy + 1) * n + cx],
            )
        };

        let (mut v, mut h) = build();
        assert_eq!(code_at(&v, &h, 1, 1), 85, "all four edges crossing");
        assert!(!is_cliff_placed(85), "85 is not a placing code");

        fix_impossible_cells_sweep(&mut v, &mut h, n, n, SWEEP_EDGE_ORDER_LTRB);
        // L then T cleared, leaving R and B: code 17, `east-to-south`.
        assert_eq!(
            code_at(&v, &h, 1, 1),
            17,
            "L, T, R, B clears west then north"
        );

        // The same cell under a rotated order keeps its west edge and loses the
        // other three - a different, also legal, code. Without this arm the
        // assertion above would pass for any order that happens to terminate.
        let (mut v2, mut h2) = build();
        fix_impossible_cells_sweep(&mut v2, &mut h2, n, n, [1, 2, 3, 0]);
        assert_eq!(
            code_at(&v2, &h2, 1, 1),
            64,
            "T, R, B, L clears north, east, south"
        );
    }

    /// An edge on the chunk's outer boundary is NOT clearable, which is what
    /// keeps the pass chunk-local and lets it run with no chunk-ordering
    /// dependence. A cell in the corner is therefore denied its first choice.
    #[test]
    fn the_sweep_will_not_clear_an_edge_on_the_chunks_boundary() {
        let n = CHUNK_CELLS;
        let mut v = vec![0i8; (n + 1) * n];
        let mut h = vec![0i8; n * (n + 1)];
        // Cell (0, 1): its LEFT edge is on the chunk boundary, so `L` is denied
        // and the sweep must fall through to `T`.
        v[n + 1] = 1; // L, on the boundary
        v[(n + 1) + 1] = 1; // R
        h[n] = 1; // T
        h[2 * n] = 1; // B
        fix_impossible_cells_sweep(&mut v, &mut h, n, n, SWEEP_EDGE_ORDER_LTRB);
        assert_eq!(v[n + 1], 1, "the boundary edge survives");
        assert_eq!(h[n], 0, "north was cleared instead");
    }

    /// `crosses_cliff` needs both corners non-negative and their max at or above
    /// `elevation_0`, and the cliffiness gate compares the AVERAGE to 0.5 rather
    /// than to zero. Each clause is planted so it can fail on its own.
    #[test]
    fn a_crossing_needs_a_band_a_sign_and_the_cliffiness_gate() {
        let (e0, interval) = (70.0, 120.0);
        // A rising edge across the band at 70.
        assert_eq!(crosses_cliff(69.0, 71.0, 1.0, e0, interval), 1);
        assert_eq!(crosses_cliff(71.0, 69.0, 1.0, e0, interval), -1);
        // The gate is on the AVERAGE, and 0.5 exactly does not open it.
        assert_eq!(crosses_cliff(69.0, 71.0, 0.5, e0, interval), 0);
        assert_eq!(crosses_cliff(69.0, 71.0, 0.500_001, e0, interval), 1);
        // A negative corner is never a crossing, whatever the other one is.
        assert_eq!(crosses_cliff(-1.0, 200.0, 1.5, e0, interval), 0);
        // Below the first band there is nothing to cross.
        assert_eq!(crosses_cliff(10.0, 60.0, 1.5, e0, interval), 0);
        // Two corners inside the same band do not cross it.
        assert_eq!(crosses_cliff(80.0, 100.0, 1.5, e0, interval), 0);
    }

    /// The knots land at in-chunk indices 0, 4 and 7 - the second span is THREE
    /// corners wide, not four, because `hi` clamps to `CHUNK_CELLS - 1` rather
    /// than to the block edge at 8. That asymmetry is what the prototype docs
    /// mean by smoothing making placement "inaccurate".
    #[test]
    fn the_smoothing_knots_are_zero_four_and_seven_with_an_uneven_second_span() {
        let spans: Vec<(i64, i64, f64)> = (0..9).map(smoothing_knots).collect();
        assert_eq!(spans[0], (0, 4, 0.0));
        assert_eq!(spans[1], (0, 4, 0.25));
        assert_eq!(spans[4], (4, 7, 0.0));
        // Three wide, so the step is a third rather than a quarter.
        assert_eq!(spans[5], (4, 7, 1.0 / 3.0));
        assert_eq!(spans[7], (4, 7, 1.0));
        // Index 8 is the next chunk's index 0 - a knot on itself, `t = 0`, which
        // is what makes the smoothed field agree across the chunk seam.
        assert_eq!(spans[8], (8, 12, 0.0));
        // ...and it holds on the negative side, where a truncating remainder
        // would fold the knots onto the wrong chunk.
        assert_eq!(smoothing_knots(-1), (-4, -1, 1.0));
        assert_eq!(smoothing_knots(-8), (-8, -4, 0.0));
    }
}
