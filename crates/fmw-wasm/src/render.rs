//! The render entry point: decode a request, sweep the window, fill RGBA.
//!
//! One boundary crossing per sweep rather than one per sample - which is the
//! shape that made WASM measure well in the #215 spike, and the reason
//! `runRenderRequest`'s signature does not change.

use crate::abi::{self, Request, Status};
use fmw_noise::expressions::fulgora_scrap::ScrapControls;
use fmw_noise::expressions::fulgora_shared::FulgoraCtx;
use fmw_noise::expressions::fulgora_stack::FulgoraStack;
use fmw_noise::expressions::starting_spot_at_angle::AngleTrig;
use fmw_noise::tiles::fulgora_catalog::FulgoraTile;
use fmw_noise::tiles::fulgora_ocean::{ocean_tile, Ocean};

/// `planet` code for Fulgora. The only one ported so far.
pub const PLANET_FULGORA: u32 = 0;
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
    if req.planet != PLANET_FULGORA
        || !matches!(
            req.view,
            VIEW_LANDMASK | VIEW_TERRAIN | VIEW_SCRAP_FOOTPRINT
        )
    {
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
    render_fulgora(&req, &mut out[..needed]);
    Status::Ok
}

/// Sweep the window and paint one colour per pixel.
///
/// The land mask and the terrain view differ only in the palette: both run the
/// same chain, because deciding "is this ocean" IS the elevation chain. The
/// land mask skips the eight-way land argmax, which is measured at 15.7% of a
/// tile pixel at 8 tiles/px and 13.8% at 2 - real, but far from the "cheap
/// early-out" it looks like.
fn render_fulgora(req: &Request, out: &mut [u8]) {
    let ctx = FulgoraCtx {
        seed0: req.seed0,
        islands_frequency: req.islands_frequency,
        islands_size: req.islands_size,
    };
    // ONE stack for the whole window, so the four Voronoi point caches are warm
    // across it - the same reason the TypeScript renderer shares a stack.
    let mut stack = FulgoraStack::new(
        &ctx,
        &ScrapControls::default(),
        AngleTrig::new(req.sin_start, req.cos_start),
        AngleTrig::new(req.sin_vault, req.cos_vault),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{ABI_VERSION, MAGIC, REQUEST_BYTES};

    fn request(width: u32, height: u32) -> Vec<u8> {
        let mut b = vec![0u8; REQUEST_BYTES];
        b[0..4].copy_from_slice(&MAGIC.to_le_bytes());
        b[4..8].copy_from_slice(&ABI_VERSION.to_le_bytes());
        b[16..20].copy_from_slice(&2_967_702_466u32.to_le_bytes());
        b[20..24].copy_from_slice(&width.to_le_bytes());
        b[24..28].copy_from_slice(&height.to_le_bytes());
        b[32..40].copy_from_slice(&(-256.0f64).to_le_bytes());
        b[40..48].copy_from_slice(&(-256.0f64).to_le_bytes());
        b[48..56].copy_from_slice(&8.0f64.to_le_bytes());
        b[56..64].copy_from_slice(&1.0f64.to_le_bytes());
        b[64..72].copy_from_slice(&1.0f64.to_le_bytes());
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
        let mut b = request(4, 4);
        b[8..12].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
        let mut b = request(4, 4);
        b[12..16].copy_from_slice(&7u32.to_le_bytes());
        assert_eq!(render(&b, &mut out), Status::UnsupportedPlanetOrView);
    }
}
