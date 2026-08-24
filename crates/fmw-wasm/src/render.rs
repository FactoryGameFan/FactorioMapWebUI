//! The render entry point: decode a request, sweep the window, fill RGBA.
//!
//! One boundary crossing per sweep rather than one per sample - which is the
//! shape that made WASM measure well in the #215 spike, and the reason
//! `runRenderRequest`'s signature does not change.

use crate::abi::{self, FulgoraParams, Params, Request, Status, VulcanusBearing, VulcanusParams};
use fmw_noise::cliffs::catalog::{CLIFF_MAP_COLOR, CLIFF_MARK_BACK_PX, CLIFF_MARK_SIZE_PX};
use fmw_noise::cliffs::placement::{CliffBands, CliffPlacement};
use fmw_noise::cliffs::vulcanus_fields::{
    VulcanusCliffFields, VulcanusLavaTiles, VULCANUS_CLIFF_ELEVATION_0,
    VULCANUS_CLIFF_ELEVATION_INTERVAL, VULCANUS_CLIFF_SMOOTHING,
};
use fmw_noise::cliffs::vulcanus_ore_rejection::VulcanusOreRejection;
use fmw_noise::eval::ctx::{EvalCtx, ResourceLevers, VulcanusResourceControls};
use fmw_noise::expressions::fulgora_scrap::ScrapControls;
use fmw_noise::expressions::fulgora_shared::FulgoraCtx;
use fmw_noise::expressions::fulgora_stack::FulgoraStack;
use fmw_noise::expressions::starting_spot_at_angle::AngleTrig;
use fmw_noise::expressions::vulcanus_biomes::VulcanusBiomes;
use fmw_noise::expressions::vulcanus_stack::{VulcanusBase, VulcanusStack};
use fmw_noise::placement::roll::PLACEMENT_MARK_RADIUS_PX;
use fmw_noise::resources::vulcanus_catalog::{
    VulcanusResource, VulcanusResourcePlacement, RESOURCE_PROBABILITY_THRESHOLD,
    VULCANUS_RESOURCE_CATALOG,
};
use fmw_noise::resources::vulcanus_geyser::VulcanusGeyserPlacement;
use fmw_noise::rocks::catalog::{ROCK_MAP_COLOR, VULCANUS_ROCK_MARK_RADIUS_PX};
use fmw_noise::rocks::vulcanus_field::VulcanusRockFields;
use fmw_noise::rocks::vulcanus_placement::VulcanusRockPlacement;
use fmw_noise::tiles::fulgora_catalog::FulgoraTile;
use fmw_noise::tiles::fulgora_ocean::{ocean_tile, Ocean};
use fmw_noise::tiles::vulcanus_catalog::VulcanusTile;

/// `planet` code for Fulgora.
pub const PLANET_FULGORA: u32 = 0;

/// `planet` code for Vulcanus.
pub const PLANET_VULCANUS: u32 = 1;
/// `view` code for the land mask - land versus ocean, no land argmax.
pub const VIEW_LANDMASK: u32 = 0;
/// `view` code for the full terrain render, all ten tile colours.
pub const VIEW_TERRAIN: u32 = 1;
/// `view` code for the scrap FOOTPRINT - white where `probability > 0`.
///
/// Deliberately the footprint predicate rather than a rolled overlay. A roll
/// paints only where a random draw succeeds, about 40% of the positions where
/// the model's probability is nonzero, so diffing rolled pixels against the
/// game's drawn pixels measures the salt rather than the model. Whether the
/// model rolls at the right RATE is a separate question with its own gate.
pub const VIEW_SCRAP_FOOTPRINT: u32 = 2;

/// Terrain with the cliff footprint painted over it.
///
/// A composite rather than a bare field: the cliff overlay has nothing to draw
/// on its own, and the two passes share the whole field DAG below the tile
/// argmax. Sending it as one request is what lets the engine share that DAG -
/// splitting it would build the chain twice.
pub const VIEW_CLIFFS: u32 = 3;

/// Terrain with the rock overlay painted over it.
pub const VIEW_ROCKS: u32 = 4;

/// Terrain with the resource overlay painted over it.
pub const VIEW_RESOURCES: u32 = 5;

/// Terrain with every overlay this planet has, in the renderer's own order.
///
/// **The order is resources, then rocks, then cliffs**, which is the
/// TypeScript's and is not arbitrary: resources paint first so that a cliff or
/// a rock crossing an ore patch still reads as the thing that is in the way,
/// and cliffs last matches the Nauvis composite, where the cliff pass is
/// final.
pub const VIEW_ALL: u32 = 6;

/// The land colour, `FULGORA_LANDMASK_LAND_RGB` in
/// `src/noise/preview/renderFulgoraTerrain.ts`.
///
/// Magenta, and deliberately not a terrain colour: the island finder collapses
/// the image against the two ocean colours, so any non-ocean colour is correct,
/// and one that could never be mistaken for terrain is honest about that.
const LAND: [u8; 3] = [255, 0, 255];

/// `COLORS.shallow`.
const SHALLOW: [u8; 3] = [74, 42, 43];

/// `COLORS.deep`.
///
/// The Lua defines it as `{49*1.15, 31*1.15, 35*1.15}` = (56.35, 35.65, 40.25),
/// and the game **TRUNCATES**: green is the only discriminating channel, and
/// the game's own `--generate-map-preview` PNG shows 35 at every one of the
/// 370,891 deep-ocean pixels sampled, where every rounding rule gives 36.
/// Written as the truncation rather than as `[56, 35, 40]` so the reading stays
/// visible - using `round` here painted 91% of a whole-image Fulgora comparison
/// as different.
const DEEP: [u8; 3] = [
    (49.0 * 1.15) as u8,
    (31.0 * 1.15) as u8,
    (35.0 * 1.15) as u8,
];

/// The colour the scrap-footprint view paints where scrap COULD land.
///
/// The game's own `map_color` for scrap is `{0.9, 0.9, 0.9} * 255` = 229, and
/// that triple was confirmed against the preview PNG rather than from the Lua
/// alone. This view paints it so the two images can be compared directly.
const SCRAP_FOOTPRINT: [u8; 3] = [229, 229, 229];

/// The eight land tile colours, read from each tile's `map_color` in
/// `tiles-fulgora.lua` rather than picked by eye.
///
/// `oil-ocean-shallow` and `-shallow-2` both declare `{74, 42, 43}`, and
/// `oil-ocean-deep` and `-deep-2` both declare the scaled triple above - which
/// is why the resolver only has to get shallow-versus-deep right and never
/// which variant of each.
fn tile_color(tile: FulgoraTile) -> [u8; 3] {
    match tile {
        FulgoraTile::FulgoranDust => [112, 65, 50],
        FulgoraTile::FulgoranDunes => [125, 71, 59],
        FulgoraTile::FulgoranSand => [118, 68, 56],
        FulgoraTile::FulgoranRock => [131, 85, 66],
        FulgoraTile::FulgoranPaving => [120, 94, 67],
        FulgoraTile::FulgoranWalls => [114, 75, 65],
        FulgoraTile::FulgoranConduit => [100, 79, 68],
        FulgoraTile::FulgoranMachinery => [89, 79, 68],
        FulgoraTile::Shallow => SHALLOW,
        FulgoraTile::Deep => DEEP,
    }
}

/// Render one request into `out`, returning a [`Status`].
///
/// `out` must be at least `width * height * 4` bytes; the caller owns it, which
/// is what lets the module reuse one buffer for every request in a worker's
/// lifetime rather than allocating.
pub fn render(request: &[u8], out: &mut [u8]) -> Status {
    let req = match abi::decode(request) {
        Ok(r) => r,
        Err(status) => return status,
    };
    // The planet/view pair is checked BEFORE the buffer size, so an unsupported
    // view reports as one rather than as a size problem. Vulcanus has no ocean
    // and no scrap, so the land mask and the scrap footprint are meaningless
    // there rather than merely unimplemented.
    let supported = matches!(
        (req.planet, req.view),
        (
            PLANET_FULGORA,
            VIEW_LANDMASK | VIEW_TERRAIN | VIEW_SCRAP_FOOTPRINT
        ) | (
            PLANET_VULCANUS,
            VIEW_TERRAIN | VIEW_CLIFFS | VIEW_ROCKS | VIEW_RESOURCES | VIEW_ALL
        )
    );
    if !supported {
        return Status::UnsupportedPlanetOrView;
    }
    let Some(needed) = (req.width as usize)
        .checked_mul(req.height as usize)
        .and_then(|p| p.checked_mul(4))
    else {
        return Status::OutputTooLarge;
    };
    if needed > out.len() {
        return Status::OutputTooLarge;
    }
    // The decoder already guaranteed the block matches the planet code, so a
    // mismatch here would be a decoder bug rather than a caller error - which is
    // why these arms return a status instead of being `unreachable!()`. A trap
    // would poison the instance for every later request in the worker.
    match (req.planet, req.params) {
        (PLANET_FULGORA, Params::Fulgora(p)) => render_fulgora(&req, &p, &mut out[..needed]),
        (PLANET_VULCANUS, Params::Vulcanus(p)) => render_vulcanus(&req, &p, &mut out[..needed]),
        _ => return Status::UnsupportedPlanetOrView,
    }
    Status::Ok
}

/// Sweep the window and paint one colour per pixel.
///
/// The land mask and the terrain view differ only in the palette: both run the
/// same chain, because deciding "is this ocean" IS the elevation chain. The
/// land mask skips the eight-way land argmax, which is measured at 15.7% of a
/// tile pixel at 8 tiles/px and 13.8% at 2 - real, but far from the "cheap
/// early-out" it looks like.
fn render_fulgora(req: &Request, p: &FulgoraParams, out: &mut [u8]) {
    let ctx = FulgoraCtx {
        seed0: req.seed0,
        islands_frequency: p.islands_frequency,
        islands_size: p.islands_size,
    };
    // ONE stack for the whole window, so the four Voronoi point caches are warm
    // across it - the same reason the TypeScript renderer shares a stack.
    let mut stack = FulgoraStack::new(
        &ctx,
        &ScrapControls::default(),
        AngleTrig::new(p.sin_start, p.cos_start),
        AngleTrig::new(p.sin_vault, p.cos_vault),
    );
    let mut offset = 0usize;
    for py in 0..req.height {
        let wy = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let wx = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            let fields = stack.eval(wx, wy);
            let color = match req.view {
                VIEW_TERRAIN => tile_color(fields.tile()),
                VIEW_SCRAP_FOOTPRINT => {
                    if fields.scrap.probability > 0.0 {
                        SCRAP_FOOTPRINT
                    } else {
                        [0, 0, 0]
                    }
                }
                _ => match ocean_tile(&fields.elevation) {
                    None => LAND,
                    Some(Ocean::Shallow) => SHALLOW,
                    Some(Ocean::Deep) => DEEP,
                },
            };
            out[offset] = color[0];
            out[offset + 1] = color[1];
            out[offset + 2] = color[2];
            out[offset + 3] = 255;
            offset += 4;
        }
    }
}

/// The 19 Vulcanus tile colours, from each tile's own `map_color`.
///
/// Three of them are the same `[53, 53, 53]` in the game's data, so this is not
/// injective and nothing downstream may invert it.
fn vulcanus_tile_color(tile: VulcanusTile) -> [u8; 3] {
    tile.color()
}

/// The `EvalCtx` a Vulcanus request describes: its three sliders and its four
/// resource control pairs.
///
/// This and the three functions below are the ONE place a Vulcanus request
/// becomes a stack. They are factored out because
/// [`checksum_vulcanus`](crate::checksum_vulcanus) - tier 2 - builds the same
/// layers, and a second copy of this wiring is precisely what tier 2 cannot
/// catch: a bearing handed to the wrong layer would be reproduced identically
/// on both sides of the comparison and stay invisible. Sharing the wiring puts
/// it inside the comparison instead.
///
/// Four functions rather than one because the layers above `base` BORROW it, so
/// a single constructor returning all of them would be self-referential - see
/// `vulcanus_stack`'s module docs.
pub(crate) fn vulcanus_ctx(seed0: u32, p: &VulcanusParams) -> EvalCtx {
    let levers = |frequency: f64, size: f64| ResourceLevers { frequency, size };
    let mut ctx = EvalCtx::new(seed0);
    ctx.vulcanus_volcanism_frequency = p.volcanism_frequency;
    ctx.vulcanus_volcanism_size = p.volcanism_size;
    ctx.temperature_bias = p.temperature_bias;
    ctx.vulcanus_resource_controls = VulcanusResourceControls {
        tungsten_ore: levers(p.tungsten_frequency, p.tungsten_size),
        vulcanus_coal: levers(p.coal_frequency, p.coal_size),
        calcite: levers(p.calcite_frequency, p.calcite_size),
        sulfuric_acid_geyser: levers(p.sulfur_frequency, p.sulfur_size),
    };
    ctx
}

/// One bearing's `(sin, cos)` as an [`AngleTrig`].
///
/// The values are V8's, computed on the TypeScript side and carried in the
/// request - see `starting_spot_at_angle`'s module docs and #270.
fn bearing(p: &VulcanusParams, which: VulcanusBearing) -> AngleTrig {
    let (sin, cos) = p.bearing(which);
    AngleTrig::new(sin, cos)
}

/// The owning half of the stack: helpers, spawn, cracks and climate.
pub(crate) fn vulcanus_base(ctx: &EvalCtx, p: &VulcanusParams) -> VulcanusBase {
    VulcanusBase::new(
        ctx,
        [
            bearing(p, VulcanusBearing::SpawnAshlands),
            bearing(p, VulcanusBearing::SpawnMountains),
            bearing(p, VulcanusBearing::SpawnBasalts),
        ],
    )
}

/// The biome layer, which both the elevation and resource layers borrow.
pub(crate) fn vulcanus_biomes<'a>(
    base: &'a VulcanusBase,
    p: &VulcanusParams,
) -> VulcanusBiomes<'a> {
    base.biomes(
        bearing(p, VulcanusBearing::BiomeVolcanoSpot),
        bearing(p, VulcanusBearing::BiomeProtector),
    )
}

/// The borrowing half: elevation, resources, lava spots and the rock noise.
pub(crate) fn vulcanus_stack<'a>(
    base: &'a VulcanusBase,
    biomes: &'a VulcanusBiomes<'a>,
    p: &VulcanusParams,
) -> VulcanusStack<'a> {
    VulcanusStack::new(
        base,
        biomes,
        [
            bearing(p, VulcanusBearing::ResourceTungsten),
            bearing(p, VulcanusBearing::ResourceCoal),
            bearing(p, VulcanusBearing::ResourceCalcite),
            bearing(p, VulcanusBearing::ResourceSulfurFar),
            bearing(p, VulcanusBearing::ResourceSulfurNear),
        ],
    )
}

/// Sweep the window and paint Vulcanus's terrain.
///
/// One `VulcanusBase` and one `VulcanusStack` for the whole window, for the same
/// reason Fulgora shares one: the per-render state is the `Prepared` multioctave
/// tables, the `Plasma` leaves and the two spot-region caches, and rebuilding
/// those per pixel is the 20x mistake `multioctave_noise`'s docs record.
///
/// **The base and the biome layer are named locals rather than fields of the
/// stack**, because the layers above them borrow them - see
/// `vulcanus_stack`'s module docs. That is three lines here instead of one, and
/// it is the honest shape.
fn render_vulcanus(req: &Request, p: &VulcanusParams, out: &mut [u8]) {
    let ctx = vulcanus_ctx(req.seed0, p);
    let base = vulcanus_base(&ctx, p);
    let biomes = vulcanus_biomes(&base, p);
    let stack = vulcanus_stack(&base, &biomes, p);

    let mut offset = 0usize;
    for py in 0..req.height {
        let wy = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let wx = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            let color = vulcanus_tile_color(stack.tile(wx, wy));
            out[offset] = color[0];
            out[offset + 1] = color[1];
            out[offset + 2] = color[2];
            out[offset + 3] = 255;
            offset += 4;
        }
    }

    // Resources first, then rocks, then cliffs - the TypeScript composite's own
    // order. Resources paint first so that a cliff or a rock crossing an ore
    // patch still reads as the thing that is in the way.
    if matches!(req.view, VIEW_RESOURCES | VIEW_ALL) {
        paint_vulcanus_resources(req, p, &ctx, &stack, out);
    }
    if matches!(req.view, VIEW_ROCKS | VIEW_ALL) {
        paint_vulcanus_rocks(req, p, &stack, out);
    }
    if matches!(req.view, VIEW_CLIFFS | VIEW_ALL) {
        paint_vulcanus_cliffs(req, p, &ctx, &stack, out);
    }
}

/// JavaScript's `Math.round`, which is NOT Rust's `f64::round`.
///
/// Rust rounds a half away from zero; JavaScript rounds it toward positive
/// infinity, so `Math.round(-0.5)` is `-0` and `(-0.5f64).round()` is `-1`.
/// The sweep boxes below reach this with negative pixel offsets - a halo
/// extends one pixel outside the tile by construction - so the two rules are
/// reachable rather than theoretical, and the render must be byte-identical to
/// the TypeScript's.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// The pixel range a world box covers in this request's grid, as the
/// TypeScript's renderers compute it.
///
/// The result may extend OUTSIDE `0..width` / `0..height`, and that is the
/// point: a mark centred just beyond the tile still paints the part of itself
/// that falls inside. [`paint_mark`] clips, so a wider sweep can never paint
/// outside the tile's own bounds.
fn sweep_pixel_range(req: &Request, world_box: [f64; 4]) -> (i64, i64, i64, i64) {
    let [x0, y0, x1, y1] = world_box;
    #[allow(clippy::cast_possible_truncation)]
    let to_px = |v: f64, origin: f64| js_round((v - origin) / req.tiles_per_pixel) as i64;
    (
        to_px(x0, req.origin_x),
        to_px(x1, req.origin_x),
        to_px(y0, req.origin_y),
        to_px(y1, req.origin_y),
    )
}

/// Paint a `(2r+1)x(2r+1)` mark centred on one pixel, clipped to the grid.
///
/// The counterpart of `paintMark` in `src/noise/preview/renderCliffs.ts`.
/// Cliffs do NOT use it - their block is the EVEN 4 wide and anchored on the
/// cell's own footprint, which no radius can express, so they keep their own
/// painter.
fn paint_mark(out: &mut [u8], width: i64, height: i64, px: i64, py: i64, color: [u8; 3], r: i64) {
    for dy in -r..=r {
        let y = py + dy;
        if y < 0 || y >= height {
            continue;
        }
        for dx in -r..=r {
            let x = px + dx;
            if x < 0 || x >= width {
                continue;
            }
            #[allow(clippy::cast_sign_loss)]
            let o = ((y * width + x) * 4) as usize;
            out[o] = color[0];
            out[o + 1] = color[1];
            out[o + 2] = color[2];
            out[o + 3] = 255;
        }
    }
}

/// Composite the Vulcanus rock overlay over terrain that is already painted.
///
/// Rolls rather than thresholds: it draws the placement set's per-tile `U` and
/// places where `U < density(x, y)` AND the tile-restriction and collision
/// gates pass. Positions are not tile-exact - there is no cross-overlay
/// arbitration against other autoplacers and no jitter draw within the tile -
/// but density is the property under test, and this is a faithful roll against
/// it rather than a threshold on it.
///
/// Two differences from the Nauvis renderer, neither of which needs a branch
/// here: Vulcanus has no water tile to exclude, and it deliberately omits the
/// `rocks` autoplace control, so there is no frequency or size to thread.
///
/// The 3x3 mark can straddle a tile seam, which is why the sweep runs over the
/// halo-widened `placement_sweep_box` rather than the request's own pixel box.
fn paint_vulcanus_rocks(
    req: &Request,
    p: &VulcanusParams,
    stack: &VulcanusStack<'_>,
    out: &mut [u8],
) {
    let fields = VulcanusRockFields::new(stack, req.seed0);
    let placement = VulcanusRockPlacement::new(&fields);
    let set = placement.placement_set();

    let (px0, px1, py0, py1) = sweep_pixel_range(req, p.placement_sweep_box);
    let width = i64::from(req.width);
    let height = i64::from(req.height);
    for py in py0..py1 {
        #[allow(clippy::cast_precision_loss)]
        let wy = req.origin_y + py as f64 * req.tiles_per_pixel;
        for px in px0..px1 {
            #[allow(clippy::cast_precision_loss)]
            let wx = req.origin_x + px as f64 * req.tiles_per_pixel;
            if !set.placed(wx, wy) {
                continue;
            }
            paint_mark(
                out,
                width,
                height,
                px,
                py,
                ROCK_MAP_COLOR,
                VULCANUS_ROCK_MARK_RADIUS_PX,
            );
        }
    }
}

/// Composite the Vulcanus ore overlay over terrain that is already painted.
///
/// **Two placement modes, because Vulcanus has two kinds of resource**, and the
/// catalog's `placement` picks per entry:
///
/// - The three solid ores THRESHOLD. Their probability is
///   `(size > 0) * 1000 * ((1 + region) * rp - 1)`, which is
///   `(size > 0) * 1000 * region` once `random_penalty` goes to 1, and it
///   saturates to ~1 inside a patch and 0 outside - so `probability >= 0.5` is
///   the patch boundary.
/// - The sulfuric-acid geyser ROLLS. Its probability peaks below 0.09 anywhere
///   on the map, so no threshold on it yields a footprint.
///
/// **Paint order: geyser marks first, then the three thresholded ores over the
/// top.** The game arbitrates a tile among competing autoplacers by maximum
/// probability, and calcite saturates to ~1 against the geyser's <0.09, so a
/// solid ore must win a shared pixel. Painting the ores last reproduces that
/// without a colour test: any geyser pixel an ore also claims is simply
/// overwritten. It also keeps the ore pass a per-pixel pure function of world
/// position.
///
/// **No water exclusion**, unlike the Nauvis renderer: Vulcanus has no water
/// tile, and ore exclusion is expressed through the biome favorabilities rather
/// than a tile test. The geyser's roll does carry a lava gate, which is a
/// different mechanism - a collision mask, not a favorability.
fn paint_vulcanus_resources(
    req: &Request,
    p: &VulcanusParams,
    ctx: &EvalCtx,
    stack: &VulcanusStack<'_>,
    out: &mut [u8],
) {
    let controls = &ctx.vulcanus_resource_controls;
    let active: Vec<VulcanusResource> = VULCANUS_RESOURCE_CATALOG
        .into_iter()
        .filter(|r| r.enabled(controls))
        .collect();
    if active.is_empty() {
        return;
    }
    let width = i64::from(req.width);
    let height = i64::from(req.height);

    // Pass 1: the rolled entries, painted as 3x3 marks. Unlike rocks - where a
    // block would merge scattered rocks into a blob - a geyser is a 2.8 x 2.8
    // entity placed roughly once per 3000 tiles, so a single pixel disappears.
    for entry in active
        .iter()
        .filter(|r| r.placement() == VulcanusResourcePlacement::Roll)
    {
        let geyser = VulcanusGeyserPlacement::new(stack, controls);
        let set = geyser.placement_set();
        let (px0, px1, py0, py1) = sweep_pixel_range(req, p.placement_sweep_box);
        for py in py0..py1 {
            #[allow(clippy::cast_precision_loss)]
            let wy = req.origin_y + py as f64 * req.tiles_per_pixel;
            for px in px0..px1 {
                #[allow(clippy::cast_precision_loss)]
                let wx = req.origin_x + px as f64 * req.tiles_per_pixel;
                if !set.placed(wx, wy) {
                    continue;
                }
                paint_mark(
                    out,
                    width,
                    height,
                    px,
                    py,
                    entry.map_color(),
                    PLACEMENT_MARK_RADIUS_PX,
                );
            }
        }
    }

    // Pass 2: the thresholded ores, over the top. They paint one pixel each and
    // sweep the request's own box rather than the halo, because there is no
    // mark to straddle a seam. First in catalog order wins a pixel.
    let thresholded: Vec<VulcanusResource> = active
        .into_iter()
        .filter(|r| r.placement() == VulcanusResourcePlacement::Threshold)
        .collect();
    if thresholded.is_empty() {
        return;
    }
    for py in 0..req.height {
        let wy = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let wx = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            // One evaluation for all three ores rather than one per ore. The
            // TypeScript asks each entry's own memoised region closure and
            // stops at the first winner; this reads the same values off one
            // pass of the layer, which is the same numbers in fewer calls.
            let regions = stack.resources(wx, wy);
            for entry in &thresholded {
                if 1000.0 * entry.region(&regions) < RESOURCE_PROBABILITY_THRESHOLD {
                    continue;
                }
                let color = entry.map_color();
                let o = ((py * req.width + px) * 4) as usize;
                out[o] = color[0];
                out[o + 1] = color[1];
                out[o + 2] = color[2];
                out[o + 3] = 255;
                break; // first in catalog order wins
            }
        }
    }
}

/// Composite the Vulcanus cliff footprint over terrain that is already painted.
///
/// The whole field DAG is shared with the terrain pass above - the tile resolver
/// the lava rejection asks and the resource regions the ore rejection asks are
/// the SAME `VulcanusStack` the argmax just used. Building a private one here
/// would duplicate the entire chain, which is the mistake the TypeScript's
/// `sharedStack` plumbing exists to avoid.
///
/// Two rejections run, and both act on the CROSSING rather than as a
/// post-filter: a rejected cell's four edge registers are zeroed, so a surviving
/// neighbour loses the shared one and changes orientation. The post-filter
/// reading predicts 1,662 cases of a survivor keeping such an edge and the game
/// shows 0.
///
/// **Lava exclusion happens at PLACEMENT, not at paint time.** The Nauvis
/// renderer skips water-coloured pixels as it paints; here the cells never
/// exist, because `tryToAddCliff` runs a real collision test and drops the
/// entity. A paint-time skip would leave the cell in the placement and every
/// spec that scores against `find_entities_filtered` would still count it.
fn paint_vulcanus_cliffs(
    req: &Request,
    p: &VulcanusParams,
    ctx: &EvalCtx,
    stack: &VulcanusStack<'_>,
    out: &mut [u8],
) {
    let fields = VulcanusCliffFields::new(stack, req.seed0);
    let lava = VulcanusLavaTiles::new(stack);
    let ore = VulcanusOreRejection::new(stack, &ctx.vulcanus_resource_controls);
    let placement = CliffPlacement::new(
        &fields,
        CliffBands {
            elevation0: VULCANUS_CLIFF_ELEVATION_0,
            interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
            smoothing: VULCANUS_CLIFF_SMOOTHING,
            reject_at_crossing_stage: true,
            ..CliffBands::default()
        },
    )
    .with_tile_collision(&lava)
    .with_cell_rejection(&ore);

    let [x0, y0, x1, y1] = p.cell_query_box;
    let width = req.width as i64;
    let height = req.height as i64;
    let lo = CLIFF_MARK_BACK_PX;
    let hi = CLIFF_MARK_SIZE_PX - CLIFF_MARK_BACK_PX - 1;

    for cell in placement.placed_cells(x0, y0, x1, y1) {
        let cx = ((cell.x - req.origin_x) / req.tiles_per_pixel).floor() as i64;
        let cy = ((cell.y - req.origin_y) / req.tiles_per_pixel).floor() as i64;
        for dy in -lo..=hi {
            let y = cy + dy;
            if y < 0 || y >= height {
                continue;
            }
            for dx in -lo..=hi {
                let x = cx + dx;
                if x < 0 || x >= width {
                    continue;
                }
                let o = ((y * width + x) * 4) as usize;
                out[o] = CLIFF_MAP_COLOR[0];
                out[o + 1] = CLIFF_MAP_COLOR[1];
                out[o + 2] = CLIFF_MAP_COLOR[2];
                out[o + 3] = 255;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{
        ABI_VERSION, COMMON_BYTES, FULGORA_PARAMS_BYTES, MAGIC, VULCANUS_BEARINGS,
        VULCANUS_PARAMS_BYTES,
    };

    /// A common prefix for `planet`, sized for that planet's block.
    fn prefix(planet: u32, params_bytes: usize, width: u32, height: u32, seed0: u32) -> Vec<u8> {
        let mut b = vec![0u8; COMMON_BYTES + params_bytes];
        b[0..4].copy_from_slice(&MAGIC.to_le_bytes());
        b[4..8].copy_from_slice(&ABI_VERSION.to_le_bytes());
        b[8..12].copy_from_slice(&planet.to_le_bytes());
        b[16..20].copy_from_slice(&seed0.to_le_bytes());
        b[20..24].copy_from_slice(&width.to_le_bytes());
        b[24..28].copy_from_slice(&height.to_le_bytes());
        b[28..32].copy_from_slice(&(params_bytes as u32).to_le_bytes());
        b[32..40].copy_from_slice(&(-256.0f64).to_le_bytes());
        b[40..48].copy_from_slice(&(-256.0f64).to_le_bytes());
        b[48..56].copy_from_slice(&8.0f64.to_le_bytes());
        b
    }

    fn request(width: u32, height: u32) -> Vec<u8> {
        let mut b = prefix(
            PLANET_FULGORA,
            FULGORA_PARAMS_BYTES,
            width,
            height,
            2_967_702_466,
        );
        b[56..64].copy_from_slice(&1.0f64.to_le_bytes());
        b[64..72].copy_from_slice(&1.0f64.to_le_bytes());
        b
    }

    /// A Vulcanus terrain request at the real surface seed for map seed 123456,
    /// with the ten bearings computed on the host the way a tier-1 test does.
    ///
    /// The trig is host libm here rather than V8's, which is fine for a shape
    /// test - the point of sending it as values is that the SHIPPED path uses
    /// V8's, and tier 3 is where that is checked against the TypeScript.
    fn vulcanus_request(width: u32, height: u32) -> Vec<u8> {
        let mut b = prefix(
            PLANET_VULCANUS,
            VULCANUS_PARAMS_BYTES,
            width,
            height,
            1_249_936_247,
        );
        b[12..16].copy_from_slice(&VIEW_TERRAIN.to_le_bytes());
        // Neutral sliders: frequency and size are 1, temperature bias 0.
        for at in [56, 64, 80, 88, 96, 104, 112, 120, 128, 136] {
            b[at..at + 8].copy_from_slice(&1.0f64.to_le_bytes());
        }
        let ctx = EvalCtx::new(1_249_936_247);
        let spawn = fmw_noise::expressions::vulcanus_spawn::VulcanusSpawn::with_host_trig(&ctx);
        let dir = spawn.starting_direction;
        let narrowed =
            |base: f64, offset: f64| f64::from((base + f64::from((offset * dir) as f32)) as f32);
        let angles = [
            spawn.ashlands_angle,
            spawn.mountains_angle,
            spawn.basalts_angle,
            spawn.mountains_angle,
            spawn.mountains_angle + 180.0 * dir,
            narrowed(spawn.basalts_angle, -10.0),
            narrowed(spawn.ashlands_angle, 15.0),
            narrowed(spawn.mountains_angle, -20.0),
            narrowed(spawn.mountains_angle, 10.0),
            narrowed(spawn.mountains_angle, 30.0),
        ];
        assert_eq!(angles.len(), VULCANUS_BEARINGS);
        for (i, a) in angles.into_iter().enumerate() {
            let t = AngleTrig::from_degrees(a);
            let at = COMMON_BYTES + 88 + i * 16;
            b[at..at + 8].copy_from_slice(&t.sin.to_le_bytes());
            b[at + 8..at + 16].copy_from_slice(&t.cos.to_le_bytes());
        }
        b
    }

    /// The deep colour truncates. Written out because it is the reading that a
    /// `round` would silently undo, and it was worth 91% of a whole-image
    /// comparison when it was wrong.
    #[test]
    fn the_deep_colour_truncates_rather_than_rounding() {
        assert_eq!(DEEP, [56, 35, 40]);
        // GREEN is `31 * 1.15` = 35.65, and it is the only channel that can
        // tell truncation from rounding: it rounds to 36 under every rounding
        // rule and the game shows 35. Red (56.35) and blue (40.25) floor and
        // round identically, so neither discriminates.
        assert_eq!((31.0f64 * 1.15).round() as u8, 36);
        assert_eq!((31.0f64 * 1.15) as u8, 35);
        assert_eq!((49.0f64 * 1.15).round() as u8, (49.0f64 * 1.15) as u8);
        assert_eq!((35.0f64 * 1.15).round() as u8, (35.0f64 * 1.15) as u8);
    }

    #[test]
    fn fills_every_pixel_with_an_opaque_known_colour() {
        let mut out = vec![0u8; 32 * 16 * 4];
        assert_eq!(render(&request(32, 16), &mut out), Status::Ok);
        let mut seen = [0usize; 3];
        for px in out.chunks_exact(4) {
            assert_eq!(px[3], 255, "alpha must be opaque");
            match [px[0], px[1], px[2]] {
                LAND => seen[0] += 1,
                SHALLOW => seen[1] += 1,
                DEEP => seen[2] += 1,
                other => panic!("unexpected colour {other:?}"),
            }
        }
        // Non-vacuity: this window really does contain all three, so a renderer
        // that painted one colour everywhere would fail here rather than pass.
        assert!(seen.iter().all(|c| *c > 0), "colour counts {seen:?}");
    }

    /// Row-major, and the row stride is `width`. A transposed loop produces the
    /// same colour histogram, so only a positional check sees it.
    #[test]
    fn writes_rows_major_with_the_requested_width() {
        let mut wide = vec![0u8; 8 * 2 * 4];
        assert_eq!(render(&request(8, 2), &mut wide), Status::Ok);
        // The second row of an 8x2 render must equal the first row of a render
        // whose origin is one row further down.
        let mut shifted_req = request(8, 1);
        shifted_req[40..48].copy_from_slice(&(-256.0f64 + 8.0).to_le_bytes());
        let mut shifted = vec![0u8; 8 * 4];
        assert_eq!(render(&shifted_req, &mut shifted), Status::Ok);
        assert_eq!(&wide[32..64], &shifted[..]);
    }

    #[test]
    fn refuses_an_output_buffer_that_is_too_small() {
        let mut out = vec![0u8; 32 * 16 * 4 - 1];
        assert_eq!(render(&request(32, 16), &mut out), Status::OutputTooLarge);
    }

    #[test]
    fn refuses_a_planet_or_view_it_cannot_render() {
        let mut out = vec![0u8; 4 * 4 * 4];
        // An unknown planet code is caught by the decoder, because it cannot
        // know how long the block should be.
        let mut b = request(4, 4);
        b[8..12].copy_from_slice(&99u32.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
        // An unknown VIEW is caught by the dispatch, after a clean decode.
        let mut b = request(4, 4);
        b[12..16].copy_from_slice(&7u32.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
        // Vulcanus has no ocean and no scrap, so the land mask and the scrap
        // footprint are meaningless there rather than merely unimplemented.
        let mut b = vulcanus_request(4, 4);
        b[12..16].copy_from_slice(&VIEW_LANDMASK.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
        let mut b = vulcanus_request(4, 4);
        b[12..16].copy_from_slice(&VIEW_SCRAP_FOOTPRINT.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
    }

    /// Vulcanus's terrain sweep paints only colours the catalog knows, and more
    /// than one of them.
    ///
    /// The non-vacuity half matters more than it looks: a renderer that painted
    /// a single colour everywhere would satisfy "every colour is in the
    /// catalog" perfectly, and that is the failure a wrongly-wired stack
    /// produces.
    #[test]
    fn vulcanus_paints_only_catalogued_colours_and_more_than_one() {
        use fmw_noise::tiles::vulcanus_catalog::TILE_ORDER;
        let mut out = vec![0u8; 24 * 12 * 4];
        assert_eq!(render(&vulcanus_request(24, 12), &mut out), Status::Ok);
        let known: Vec<[u8; 3]> = TILE_ORDER.iter().map(|t| t.color()).collect();
        let mut distinct: Vec<[u8; 3]> = Vec::new();
        for px in out.chunks_exact(4) {
            assert_eq!(px[3], 255, "alpha must be opaque");
            let rgb = [px[0], px[1], px[2]];
            assert!(known.contains(&rgb), "uncatalogued colour {rgb:?}");
            if !distinct.contains(&rgb) {
                distinct.push(rgb);
            }
        }
        assert!(
            distinct.len() > 1,
            "one colour over the whole window: {distinct:?}"
        );
    }

    /// The Vulcanus sweep is row-major with the requested stride, checked the
    /// same positional way Fulgora's is - a transposed loop gives the same
    /// histogram.
    #[test]
    fn vulcanus_writes_rows_major_with_the_requested_width() {
        let mut wide = vec![0u8; 8 * 2 * 4];
        assert_eq!(render(&vulcanus_request(8, 2), &mut wide), Status::Ok);
        let mut shifted_req = vulcanus_request(8, 1);
        shifted_req[40..48].copy_from_slice(&(-256.0f64 + 8.0).to_le_bytes());
        let mut shifted = vec![0u8; 8 * 4];
        assert_eq!(render(&shifted_req, &mut shifted), Status::Ok);
        assert_eq!(&wide[32..64], &shifted[..]);
    }

    /// The rendered colour is the catalogued colour of the tile the stack
    /// resolves - not some other tile's, and not a palette that drifted from
    /// the catalog.
    ///
    /// Checked against the stack directly rather than against a second copy of
    /// the colour table, so a mis-wired `vulcanus_tile_color` shows up here.
    #[test]
    fn each_vulcanus_pixel_carries_its_own_tiles_colour() {
        let mut out = vec![0u8; 6 * 6 * 4];
        let req_bytes = vulcanus_request(6, 6);
        assert_eq!(render(&req_bytes, &mut out), Status::Ok);
        let req = abi::decode(&req_bytes).expect("should decode");
        let Params::Vulcanus(p) = req.params else {
            panic!("wrong block")
        };
        let trig = |which: VulcanusBearing| {
            let (sin, cos) = p.bearing(which);
            AngleTrig::new(sin, cos)
        };
        let mut ctx = EvalCtx::new(req.seed0);
        ctx.vulcanus_volcanism_frequency = p.volcanism_frequency;
        ctx.vulcanus_volcanism_size = p.volcanism_size;
        let base = VulcanusBase::new(
            &ctx,
            [
                trig(VulcanusBearing::SpawnAshlands),
                trig(VulcanusBearing::SpawnMountains),
                trig(VulcanusBearing::SpawnBasalts),
            ],
        );
        let biomes = base.biomes(
            trig(VulcanusBearing::BiomeVolcanoSpot),
            trig(VulcanusBearing::BiomeProtector),
        );
        let stack = VulcanusStack::new(
            &base,
            &biomes,
            [
                trig(VulcanusBearing::ResourceTungsten),
                trig(VulcanusBearing::ResourceCoal),
                trig(VulcanusBearing::ResourceCalcite),
                trig(VulcanusBearing::ResourceSulfurFar),
                trig(VulcanusBearing::ResourceSulfurNear),
            ],
        );
        for py in 0..6u32 {
            for px in 0..6u32 {
                let wx = req.origin_x + f64::from(px) * req.tiles_per_pixel;
                let wy = req.origin_y + f64::from(py) * req.tiles_per_pixel;
                let want = stack.tile(wx, wy).color();
                let at = ((py * 6 + px) * 4) as usize;
                assert_eq!([out[at], out[at + 1], out[at + 2]], want, "at {px},{py}");
            }
        }
    }
}
