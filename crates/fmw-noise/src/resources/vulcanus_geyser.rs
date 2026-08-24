//! The sulfuric-acid-geyser placement: the roll against
//! [`sulfuric_acid_geyser_probability`], gated by a lava tile restriction and
//! by collision against geysers already placed in the same chunk.
//!
//! Ported from `makeVulcanusGeyserPlacement` in
//! `src/noise/preview/renderVulcanusResources.ts`.
//!
//! ## The prototype data, from source (2.1.12)
//!
//! | | `sulfuric-acid-geyser` |
//! | --- | --- |
//! | type | `resource` |
//! | autoplace order | `c` (every other resource is `b`) |
//! | probability | `vulcanus_sulfuric_acid_geyser_probability`, no `random_penalty` |
//! | `collision_box` | 2.8 x 2.8 |
//! | `map_generator_bounding_box` | **not declared** - so the collision box is the map-gen box |
//! | `tile_restriction` | none - the lava gate comes from the collision MASK |
//! | `collision_mask` | `resource` layer only (the `type = "resource"` default) |
//!
//! ## Measured, against `test/fixtures/oracle-entity-counts.seed123456.json`
//!
//! Factorio 2.1.12, seed 123456. **Only oracle region 4 has a usable
//! denominator**: regions 2 `[0,0]` and 3 `[4096,4096]` contain no sulfur at
//! all, so the game has 0 geysers there and so does this model. Region 4
//! `[-256,-256]` has 56.
//!
//! | variant | region 4 (game 56) |
//! | --- | --- |
//! | bare roll, no gates | 81 (44.6%) |
//! | + lava tile restriction only | 81 (44.6%) |
//! | + collision only | 56 (0.0%) |
//! | **+ both gates (shipped)** | **56 (0.0%)** |
//!
//! **Do not read the exact 56 as precision.** n = 56 is a small denominator
//! (Poisson sigma ~7.5, i.e. 13%) and the salt is arbitrary. Re-running region
//! 4 over eight salts gives **46-63** placements, mean 55.3 against the game's
//! 56 - so the MODEL is unbiased and the exact hit is one draw from that
//! spread.

use crate::eval::ctx::VulcanusResourceControls;
use crate::expressions::vulcanus_stack::VulcanusStack;
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use crate::resources::vulcanus_catalog::{sulfuric_acid_geyser_probability, VulcanusResource};
use crate::tiles::vulcanus_catalog::VulcanusTile;

/// The geyser's `collision_box`, 2.8 x 2.8 tiles
/// (`space-age/prototypes/entity/resources.lua:182`:
/// `{{-1.4,-1.4},{1.4,1.4}}`).
///
/// **Checked for `map_generator_bounding_box` rather than assumed.** That field
/// overrides the collision box during map generation and cost an earlier task
/// 87-132 points when it was missed; a grep across `base/`, `core/` and
/// `space-age/` at 2.1.12 returns 8 declarations - the two spawners, the four
/// worms, the base Nauvis tree family and `gleba-spawner-small` - and **no
/// resource**. So the collision box really is the map-gen box here.
///
/// **There is no argmax box question at all.** The rock overlay had to answer
/// one (and answered it with an ordering theorem); the geyser is a single
/// prototype with a single box, so the question does not arise.
pub const GEYSER_COLLISION_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 2.8, h: 2.8 };

/// The geyser placement source.
///
/// **`enabled` gates the RENDERER, not the probability.** The game's
/// expression carries a leading `(control:sulfuric_acid_geyser:size > 0)`
/// factor, and this port applies it exactly where the TypeScript does - as a
/// catalog filter in the renderer, not inside
/// [`sulfuric_acid_geyser_probability`]. Folding it into the probability here
/// would be a second place for the same factor to live, and the two could
/// disagree at a `size` the region field does not already collapse.
pub struct VulcanusGeyserPlacement<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    enabled: bool,
}

impl<'a, 'b> VulcanusGeyserPlacement<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, controls: &VulcanusResourceControls) -> Self {
        Self {
            stack,
            enabled: VulcanusResource::SulfuricAcidGeyser.enabled(controls),
        }
    }

    /// Whether the `size` lever leaves the geyser enabled at all.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::VULCANUS_GEYSER, self)
    }
}

impl PlacementSource for VulcanusGeyserPlacement<'_, '_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        sulfuric_acid_geyser_probability(self.stack.resources(x, y).sulfuric_acid_region_patchy)
    }

    /// The two Vulcanus tiles no geyser may sit on.
    ///
    /// **Derived from the collision MASK, not from a `tile_restriction`.** The
    /// geyser prototype declares none - that field only appears in the shared
    /// `resource_autoplace` helper, which this literal prototype does not use.
    /// What gates it instead is `type = "resource"`, whose default collision
    /// mask is `{layers = {resource = true}}`
    /// (`core/lualib/collision-mask-defaults.lua:187`), against the tiles' own
    /// masks: on Vulcanus exactly `lava` and `lava-hot` use
    /// `tile_collision_masks.lava()`, which lists `resource = true`. Every
    /// other Vulcanus tile uses `ground()`, which does not.
    ///
    /// So the forbidden set coincides with the rock overlay's while being
    /// reached by a completely different route, and the geyser is a single
    /// prototype, so `resolve_chunk`'s "all prototypes sharing the overlay must
    /// share one `tile_allowed`" precondition is trivially met.
    ///
    /// **This gate rejects nothing in the one oracle region that has geysers**,
    /// which is worth stating so nobody reads its 0 as evidence it is inert:
    /// over a +/-2000-tile sample at seed 123456, 426 of 5627 tiles with a
    /// positive geyser probability are lava, and the gate rejects 12 of 195
    /// roll hits (~6%). Oracle region 4 simply has no lava where its sulfur is.
    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        !matches!(
            self.stack.tile(x, y),
            VulcanusTile::Lava | VulcanusTile::LavaHot
        )
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(GEYSER_COLLISION_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::{EvalCtx, ResourceLevers};
    use crate::expressions::vulcanus_stack::VulcanusBase;

    /// The box is the prototype's 2.8 x 2.8, and it is SQUARE - unlike the
    /// rock overlay's, whose two axes differ. Pinned so a copy-paste from that
    /// file shows up here.
    #[test]
    fn the_box_is_the_prototypes_two_point_eight_square() {
        assert_eq!(GEYSER_COLLISION_BOX.w, 2.8);
        assert_eq!(GEYSER_COLLISION_BOX.h, 2.8);
    }

    /// A zero `size` lever removes the geyser entirely.
    ///
    /// **It acts through the REGION, not through a factor in the probability.**
    /// `vulcanus_place_sulfur_spots` reads `control:sulfuric_acid_geyser:size`,
    /// so a zero lever collapses `sulfuric_acid_region_patchy` itself and the
    /// probability goes to zero without anything here testing the lever. That
    /// is why the stack has to be rebuilt for each arm rather than reusing one:
    /// building the stack at `size = 0` and then asking an "enabled" placement
    /// about it reports zero for the wrong reason, and would pass on a
    /// renderer filter that never ran.
    ///
    /// The window is where the sulfur is at this seed. A block at the origin
    /// integrates to exactly 0, so a test written there would assert nothing.
    #[test]
    fn a_zero_size_lever_places_no_geyser_at_all() {
        const X0: i32 = -64;
        const Y0: i32 = 64;
        const SIZE: i32 = 64;

        let count = |size: f64| -> usize {
            let mut ctx = EvalCtx::new(123_456);
            ctx.vulcanus_resource_controls.sulfuric_acid_geyser = ResourceLevers {
                frequency: 1.0,
                size,
            };
            let base = VulcanusBase::with_host_trig(&ctx);
            let biomes = base.biomes_with_host_trig();
            let stack = VulcanusStack::with_host_trig(&base, &biomes);
            let g = VulcanusGeyserPlacement::new(&stack, &ctx.vulcanus_resource_controls);
            assert_eq!(g.is_enabled(), size > 0.0);
            let set = g.placement_set();
            let mut n = 0usize;
            for ty in Y0..Y0 + SIZE {
                for tx in X0..X0 + SIZE {
                    if set.placed(f64::from(tx), f64::from(ty)) {
                        n += 1;
                    }
                }
            }
            n
        };

        assert_eq!(count(0.0), 0, "a disabled geyser must place nothing");
        // Non-vacuity: the SAME window places with the lever on, so the zero
        // above is the lever rather than an empty window or a broken field.
        assert!(count(1.0) > 0, "no geysers placed with the lever on");
    }
}
