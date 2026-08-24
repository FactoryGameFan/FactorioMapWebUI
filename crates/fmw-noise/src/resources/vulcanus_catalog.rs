//! The Vulcanus resource catalog, ported from
//! `src/noise/resources/vulcanusResourceCatalog.ts`.
//!
//! It landed PARTIAL with the cliff stack, carrying only the solid-ore
//! footprint the ore -> cliff rejection reads. The map colours, the entry
//! ordering and the geyser's rolled probability arrived with the resource
//! overlay itself, which is what the file now holds.
//!
//! ## The entry order, and the one place it matters
//!
//! The three solid ores are listed in
//! `space-age/prototypes/entity/resources.lua` order for tungsten-ore and
//! calcite. **Coal is not in that file** - despite appearing on Vulcanus,
//! `coal` is the base-mod prototype, routed onto the planet via
//! `property_expression_names["entity:coal:probability"]`. Since `base` loads
//! before `space-age`, coal's true global registration index precedes tungsten
//! and calcite rather than following them as this order suggests.
//!
//! Among those three the order is functionally inert: all three autoplace
//! `order = "b"`, so ties fall back to registration order, but their
//! favorabilities gate on disjoint biomes (basalts / mountains / ashlands), so
//! two of them are never simultaneously eligible at the same pixel and the
//! tie-break never fires.
//!
//! **That disjointness does NOT extend to the fourth entry.** The sulfuric acid
//! geyser gates on `vulcanus_mountains_sulfur_favorability`, drawn from the
//! same mountains biome as calcite's `vulcanus_mountains_resource_favorability`
//! (`planet-vulcanus-map-gen.lua:653` and `:664`), so calcite and the geyser
//! CAN be eligible at the same pixel and the tie-break fires for the first
//! time. **The geyser is last on purpose.** The game arbitrates a tile among
//! competing autoplacers by maximum probability; calcite's saturates to ~1
//! inside its footprint while the geyser's peaks below 0.09, so calcite wins
//! that pixel. The renderer reproduces that outcome by painting the geyser's
//! roll marks FIRST and the three thresholded ores over the top.

use crate::eval::ctx::{ResourceLevers, VulcanusResourceControls};
use crate::expressions::vulcanus_resources::ResourceFields;
use crate::expressions::vulcanus_stack::VulcanusStack;

/// The threshold a solid ore's probability must clear for the game to have
/// placed an entity on that tile: `probability >= 0.5`.
///
/// **This lives in the catalog rather than in a renderer because it has two
/// consumers.** The resource overlay paints with it, and the ore -> cliff
/// rejection asks the same question to decide whether an ore suppresses a
/// cliff. Two copies of the number could drift apart, and the cliff overlay
/// would then reject against a footprint the ore overlay does not draw - a
/// disagreement invisible in both renders.
pub const RESOURCE_PROBABILITY_THRESHOLD: f64 = 0.5;

/// Does the game hold a solid-ore entity on the tile whose centre is
/// `(x + 0.5, y + 0.5)`?
///
/// The three solid ores THRESHOLD, so their footprint is exactly
/// `1000 * region >= RESOURCE_PROBABILITY_THRESHOLD` over the entries whose
/// `size` lever is positive. A disabled ore occupies nothing, which is not a
/// special case bolted on: it is the same `size = 0` lever the game itself was
/// driven with to establish that ore suppresses cliffs (#99).
///
/// The geyser is deliberately absent - it ROLLS rather than thresholds, so it
/// has no footprint expressible this way. Callers that want it pass their own
/// predicate.
///
/// **The field is sampled at the tile's integer coordinate, not at its centre.**
/// That is what the TypeScript does and what the measurement was made with; the
/// doc comment above describes which tile the answer is about, not where the
/// sample is taken.
pub struct VulcanusOreFootprint {
    tungsten: bool,
    coal: bool,
    calcite: bool,
}

impl VulcanusOreFootprint {
    #[must_use]
    pub fn new(controls: &VulcanusResourceControls) -> Self {
        Self {
            tungsten: controls.tungsten_ore.size > 0.0,
            coal: controls.vulcanus_coal.size > 0.0,
            calcite: controls.calcite.size > 0.0,
        }
    }

    /// True when no ore is enabled, so the whole rejection can be skipped.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        !self.tungsten && !self.coal && !self.calcite
    }

    /// Whether a solid ore stands on tile `(tx, ty)`.
    #[must_use]
    pub fn occupies(&self, stack: &VulcanusStack<'_>, tx: i64, ty: i64) -> bool {
        if self.is_empty() {
            return false;
        }
        #[allow(clippy::cast_precision_loss)]
        let r = stack.ore_regions(tx as f64, ty as f64);
        (self.tungsten && 1000.0 * r.tungsten >= RESOURCE_PROBABILITY_THRESHOLD)
            || (self.calcite && 1000.0 * r.calcite >= RESOURCE_PROBABILITY_THRESHOLD)
            || (self.coal && 1000.0 * r.coal >= RESOURCE_PROBABILITY_THRESHOLD)
    }
}

/// How an entry decides where it is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VulcanusResourcePlacement {
    /// Draw wherever the entry's own probability clears
    /// [`RESOURCE_PROBABILITY_THRESHOLD`], i.e. paint the patch as a solid
    /// footprint. Right for the three solid ores, whose probability saturates
    /// to ~1 inside a patch and 0 outside: the threshold IS the patch boundary.
    Threshold,
    /// Draw where the game's per-tile placement draw beats `probability`,
    /// subject to the two arbitration gates. Right for the geyser, whose
    /// probability never exceeds ~0.09 anywhere: there is no threshold that
    /// yields a footprint, because a geyser is an individual entity the game
    /// rolls for, not a patch.
    Roll,
}

/// The four Vulcanus resources the overlay draws, in catalog order.
///
/// An enum with methods rather than a table of closures, because a `const`
/// array cannot hold closures in Rust and a table of function pointers would
/// lose the names this order depends on. The order itself lives in
/// [`VULCANUS_RESOURCE_CATALOG`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VulcanusResource {
    TungstenOre,
    Calcite,
    Coal,
    SulfuricAcidGeyser,
}

/// The catalog, in the order the renderer walks it. See the module docs for
/// why the geyser is last and why the first three are interchangeable.
pub const VULCANUS_RESOURCE_CATALOG: [VulcanusResource; 4] = [
    VulcanusResource::TungstenOre,
    VulcanusResource::Calcite,
    VulcanusResource::Coal,
    VulcanusResource::SulfuricAcidGeyser,
];

impl VulcanusResource {
    /// The entity/prototype name, for messages and tests.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::TungstenOre => "tungsten-ore",
            Self::Calcite => "calcite",
            Self::Coal => "coal",
            Self::SulfuricAcidGeyser => "sulfuric-acid-geyser",
        }
    }

    /// `map_color`, scaled to 0..255 the way the game's preview tints it.
    ///
    /// Tungsten's is `{r = 98/256, g = 86/256, b = 150/256}` and rounds to
    /// (98, 86, 149) - note the blue, which is 149 rather than 150 because the
    /// Lua divides by 256 and the render multiplies by 255.
    #[must_use]
    pub const fn map_color(self) -> [u8; 3] {
        match self {
            Self::TungstenOre => [98, 86, 149],
            // map_color = {0.8, 0.7, 0.7}
            Self::Calcite => [204, 179, 179],
            // map_color = {0, 0, 0} (base/prototypes/entity/resources.lua)
            Self::Coal => [0, 0, 0],
            // map_color = {0.78, 0.78, 0.1}
            Self::SulfuricAcidGeyser => [199, 199, 26],
        }
    }

    /// How the renderer turns this entry into pixels.
    #[must_use]
    pub const fn placement(self) -> VulcanusResourcePlacement {
        match self {
            Self::SulfuricAcidGeyser => VulcanusResourcePlacement::Roll,
            _ => VulcanusResourcePlacement::Threshold,
        }
    }

    /// Which `control:<x>:frequency|size` pair gates this entry.
    #[must_use]
    pub const fn levers(self, controls: &VulcanusResourceControls) -> ResourceLevers {
        match self {
            Self::TungstenOre => controls.tungsten_ore,
            Self::Calcite => controls.calcite,
            Self::Coal => controls.vulcanus_coal,
            Self::SulfuricAcidGeyser => controls.sulfuric_acid_geyser,
        }
    }

    /// Whether the entry's `size` lever leaves it enabled at all.
    ///
    /// The game's own probability expressions carry a leading
    /// `(control:<x>:size > 0)` factor; the renderer applies it as a filter
    /// rather than repeating it in every formula.
    #[must_use]
    pub const fn enabled(self, controls: &VulcanusResourceControls) -> bool {
        self.levers(controls).size > 0.0
    }

    /// The `VulcanusResources` region this entry is built from.
    ///
    /// For a [`VulcanusResourcePlacement::Threshold`] entry this is the game's
    /// own probability expression up to the `1000 *` scale the renderer
    /// applies, and it decides the footprint. For the geyser the renderer does
    /// NOT consult it - it is the field
    /// [`sulfuric_acid_geyser_probability`] is a formula over, kept here
    /// because the geyser's extent ("where the game would roll at all") is
    /// still `region > 0`.
    ///
    /// It is `sulfuric_acid_region_patchy`, NOT the plain
    /// `sulfuric_acid_region` that richness uses, because `probability > 0` is
    /// exactly `patchy > 0`.
    #[must_use]
    pub const fn region(self, r: &ResourceFields) -> f64 {
        match self {
            Self::TungstenOre => r.tungsten_region,
            Self::Calcite => r.calcite_region,
            Self::Coal => r.coal_region,
            Self::SulfuricAcidGeyser => r.sulfuric_acid_region_patchy,
        }
    }
}

/// `vulcanus_sulfuric_acid_geyser_probability`, verbatim from
/// `space-age/prototypes/planet/planet-vulcanus-map-gen.lua:849` (2.1.12):
///
/// ```text
/// (control:sulfuric_acid_geyser:size > 0)
///   * (0.025 * ((vulcanus_sulfuric_acid_region_patchy > 0)
///               + 2 * vulcanus_sulfuric_acid_region_patchy))
/// ```
///
/// It reaches the geyser via
/// `property_expression_names["entity:sulfuric-acid-geyser:probability"]`,
/// which replaces the prototype's own `probability_expression = 0`. **There is
/// no `random_penalty` wrapper** - unlike its calcite/coal/tungsten neighbours
/// in the same file, and unlike the Nauvis spawners, both of which do wrap
/// theirs. Read from source rather than trusted from a comment.
///
/// The leading `size > 0` factor is applied by the renderer's `enabled` filter,
/// so it is not repeated here.
///
/// **The peak is not 0.065, and it is not 0.0883 either.** 0.065 sat in the
/// TypeScript as a reasoned bound (assuming `region <= 1` and `patches <= 0.8`)
/// and is wrong, because `region` is a `max` against
/// `vulcanus_starting_sulfur`, which is not capped at 1. It was replaced by a
/// measurement: sweeping +/-3000 tiles at seed 123456 on a 7-tile grid and
/// refining around the argmax found the peak at (2481, -1985), "where `patchy`
/// is 1.217", and recorded the value as **0.0883**.
///
/// Those two numbers do not agree with each other. This expression at
/// `patchy = 1.217` is `0.025 * (1 + 2*1.217) = 0.08585`, and evaluating the
/// port at that exact position at seed 123456 gives `patchy = 1.2172893` and
/// **0.0858645** - so the position and the `patchy` are right and the recorded
/// probability is not. 0.0883 would need a `patchy` of 1.266.
///
/// Nothing depends on the difference: both are two orders of magnitude below
/// calcite's saturated ~1, which is all the catalog-ordering argument needs.
/// It is corrected here, and in the TypeScript comment it came from, because a
/// number nobody re-derives is a number that gets quoted.
///
/// The result may be NEGATIVE where the geyser cannot place. That is the game's
/// expression, unclamped, and a negative probability simply never wins the
/// roll.
#[must_use]
pub fn sulfuric_acid_geyser_probability(patchy: f64) -> f64 {
    crate::poison::f64_result(0.025 * (f64::from(u8::from(patchy > 0.0)) + 2.0 * patchy))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The geyser is LAST, and it is the only rolled entry. Both halves are
    /// load-bearing: the renderer paints rolled marks first and thresholded
    /// ores over the top, which is how a solid ore wins a pixel it shares with
    /// a geyser.
    #[test]
    fn the_geyser_is_last_and_is_the_only_rolled_entry() {
        assert_eq!(
            VULCANUS_RESOURCE_CATALOG[3],
            VulcanusResource::SulfuricAcidGeyser
        );
        let rolled: Vec<&str> = VULCANUS_RESOURCE_CATALOG
            .iter()
            .filter(|r| r.placement() == VulcanusResourcePlacement::Roll)
            .map(|r| r.name())
            .collect();
        assert_eq!(rolled, vec!["sulfuric-acid-geyser"]);
    }

    /// Every entry reads its OWN lever pair, which a `match` arm can get wrong
    /// in a way that still compiles and still renders something plausible.
    #[test]
    fn each_entry_reads_its_own_lever_pair() {
        let mut controls = VulcanusResourceControls::default();
        controls.tungsten_ore.size = 2.0;
        controls.calcite.size = 3.0;
        controls.vulcanus_coal.size = 4.0;
        controls.sulfuric_acid_geyser.size = 5.0;
        let sizes: Vec<f64> = VULCANUS_RESOURCE_CATALOG
            .iter()
            .map(|r| r.levers(&controls).size)
            .collect();
        assert_eq!(sizes, vec![2.0, 3.0, 4.0, 5.0]);
    }

    /// The same for the region projection: four entries, four distinct fields.
    #[test]
    fn each_entry_reads_its_own_region_field() {
        let fields = ResourceFields {
            tungsten_region: 11.0,
            calcite_region: 22.0,
            coal_region: 33.0,
            sulfuric_acid_region_patchy: 44.0,
            // The plain region is deliberately given a value the catalog must
            // NOT return: the geyser reads `patchy`, and reading the other one
            // would still produce a plausible extent.
            sulfuric_acid_region: 99.0,
            ..ResourceFields::default()
        };
        let regions: Vec<f64> = VULCANUS_RESOURCE_CATALOG
            .iter()
            .map(|r| r.region(&fields))
            .collect();
        assert_eq!(regions, vec![11.0, 22.0, 33.0, 44.0]);
    }

    /// Tungsten's blue channel is 149, not 150.
    ///
    /// The Lua writes `b = 150/256` and the render scales by 255, so
    /// `round(150/256 * 255)` is 149. Transcribing the Lua numerator directly
    /// gives 150 and looks right.
    #[test]
    fn tungstens_blue_channel_survives_the_two_fifty_six_to_two_fifty_five_scale() {
        assert_eq!(VulcanusResource::TungstenOre.map_color(), [98, 86, 149]);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let scaled = (150.0 / 256.0 * 255.0f64).round() as u8;
        assert_eq!(scaled, 149);
    }

    /// Coal is BLACK, and that is the game's `map_color` rather than a
    /// placeholder. A renderer that treated `[0, 0, 0]` as "unset" would drop
    /// the whole overlay.
    #[test]
    fn coal_is_genuinely_black() {
        assert_eq!(VulcanusResource::Coal.map_color(), [0, 0, 0]);
    }

    /// The geyser probability's discrete term is a STEP, not a scale: at
    /// `patchy` just above zero it jumps to 0.025, and at zero it is zero.
    ///
    /// Dropping the `(patchy > 0)` term entirely leaves `0.05 * patchy`, which
    /// is continuous through the origin and would look correct in every plot.
    #[test]
    fn the_probability_steps_at_zero_rather_than_passing_through_it() {
        assert_eq!(sulfuric_acid_geyser_probability(0.0), 0.0);
        let epsilon = sulfuric_acid_geyser_probability(f64::MIN_POSITIVE);
        assert!(
            epsilon >= 0.025,
            "the step is missing: {epsilon} at patchy just above 0"
        );
        // And the linear term is still there on top of the step.
        assert!(sulfuric_acid_geyser_probability(1.0) > epsilon);
    }

    /// The expression is NOT clamped, so it goes negative where the geyser
    /// cannot place. A negative probability simply never wins the roll, which
    /// is the game's own behaviour; clamping it to zero would change nothing
    /// here and would hide a sign error elsewhere.
    #[test]
    fn a_negative_region_gives_a_negative_probability_rather_than_zero() {
        assert!(sulfuric_acid_geyser_probability(-1.0) < 0.0);
    }

    /// The measured peak, so a change to the region chain that lifts the
    /// geyser into competition with calcite is visible.
    ///
    /// The `patchy` here is what the port evaluates at (2481, -1985) at seed
    /// 123456, the argmax a +/-3000-tile sweep found. See
    /// [`sulfuric_acid_geyser_probability`]'s docs for why the probability is
    /// 0.08586 rather than the 0.0883 recorded beside that position in the
    /// TypeScript.
    #[test]
    fn the_measured_peak_is_far_below_a_solid_ores() {
        let peak = sulfuric_acid_geyser_probability(1.217_289_334_385_441_2);
        assert!((peak - 0.085_864_466_7).abs() < 1e-9, "peak {peak}");
        // The whole of the catalog-ordering argument: calcite saturates to ~1
        // inside its footprint, so it out-bids the geyser by more than 10x
        // wherever the two are both eligible.
        assert!(peak * 10.0 < 1.0, "the geyser could out-bid calcite");
    }
}
