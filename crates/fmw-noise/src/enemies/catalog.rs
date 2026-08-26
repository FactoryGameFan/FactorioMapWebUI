//! Enemy-base constants and distance scalars, ported from
//! `src/noise/enemies/enemyCatalog.ts`.

/// `basis_noise` / `spot_noise` `seed1` for the enemy layer.
pub const ENEMY_SEED1: u32 = 123;

/// `spot_noise` region size, in tiles.
pub const ENEMY_REGION_SIZE: u64 = 512;

/// `candidate_spot_count`.
pub const ENEMY_CANDIDATE_SPOT_COUNT: usize = 100;

/// `suggested_minimum_candidate_point_spacing`.
pub const ENEMY_SPACING: f64 = 45.254_833_995_939_045;

/// The spot field's basement - what a position with no cone over it reads.
///
/// **This value is why the exact-match metric needs reading carefully on this
/// layer.** A position at the basement sits near -1007, where one f32 ULP is
/// about 6e-5 - larger than the whole residual - so it is exact for free. See
/// the field's own tier-1 test.
pub const ENEMY_BASEMENT: f64 = -1000.0;

/// How far a spot can be from a sample and still raise it above the basement.
pub const ENEMY_MAX_SPOT_BASEMENT_RADIUS: f64 = 128.0;

/// The cap the spawner applies: `clamp(min(field, cap), 0, 1)`.
///
/// Both spawners pass `distance_factor = 0`, at which
/// `enemy_autoplace_base`'s `min(probability * max(0, 1 + ...), 0.25 + df*0.05)`
/// collapses to exactly `min(enemy_base_probability, 0.25)`.
pub const ENEMY_PLACEMENT_CAP: f64 = 0.25;

/// `starting_area_radius`, read by the field's starting-area term.
pub const STARTING_AREA_RADIUS: f64 = 150.0;

/// `map_color` for the enemy-base overlay.
pub const ENEMY_MAP_COLOR: [u8; 3] = [255, 26, 26];

/// `random_penalty{..., amplitude = 0.1}`, the outermost operation of the
/// spawners' actual `probability_expression`.
///
/// Read by the RENDER path, not by the field - it is ported here so the render
/// PR does not have to come back for it, and it grades nothing in this layer.
pub const ENEMY_RANDOM_PENALTY_AMPLITUDE: f64 = 0.1;

/// Both spawners' `map_generator_bounding_box`, `{{-3.7,-3.2},{3.7,3.2}}`.
///
/// **Deliberately NOT `collision_box`** (`{{-2.2,-2.2},{2.2,2.2}}`). The
/// prototype docs describe `map_generator_bounding_box` as "Used instead of the
/// collision box during map generation ... if the box is bigger, the entities
/// will be placed farther apart", and the two measure very differently.
///
/// Neither Nauvis nor Vulcanus rocks declare this field, which is why the rock
/// overlays correctly use `collision_box`. **Check for
/// `map_generator_bounding_box` FIRST when porting any further overlay.**
///
/// Read by the render path, like the amplitude above.
pub const ENEMY_SPAWNER_MAP_GEN_BOX: (f64, f64) = (7.4, 6.4);

/// The `enemy-base` autoplace control's two sliders.
#[derive(Clone, Copy, Debug)]
pub struct EnemyControls {
    /// `control:enemy-base:frequency`; 1 at the default. A plain multiplier on
    /// `enemy_frequency`, so it is dead at 1.
    pub frequency: f64,
    /// `control:enemy-base:size`; 1 at the default. Enters as `sqrt(size)`, so
    /// it is dead at 1 too.
    pub size: f64,
}

impl EnemyControls {
    /// Both sliders at 1.
    #[must_use]
    pub const fn defaults() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
        }
    }
}

/// `clamp(distance, 0, 2400) / 325`.
///
/// **Everything below saturates at `distance = 2400`**, so a sweep placed past
/// it grades the clamp and nothing else.
#[must_use]
pub fn enemy_intensity(distance: f64) -> f64 {
    crate::eval::math::clamp(distance, 0.0, 2400.0) / 325.0
}

/// `max(0, sqrt(size) * (15 + 4*intensity))`.
#[must_use]
pub fn enemy_spot_radius(distance: f64, controls: &EnemyControls) -> f64 {
    let intensity = enemy_intensity(distance);
    crate::eval::math::max2(0.0, controls.size.sqrt() * (15.0 + 4.0 * intensity))
}

/// `(PI/90) * radius^3`.
///
/// # `powf`, not `powi`, and not `r * r * r`
///
/// The TypeScript writes `radius ** 3`, which is `Math.pow`. Measured over
/// every integer distance from 0 to 2400 at six size sliders - 14,406 radii -
/// `r ** 3` and `r * r * r` differ at **about a quarter of them**, by one f64
/// ULP. `powi(3)` is the same trap: CLAUDE.md records it disagreeing with V8 by
/// one ULP on `p ** octaves`, which is why `multioctave_noise` uses `powf`.
///
/// **This is Nauvis's first transcendental**, so it looked like the layer's #270
/// exposure: `cargo test` runs on the host libm and cannot see a
/// `wasm32-unknown-unknown` difference, and the usual mitigation - computing the
/// value in V8 and passing it across - does not apply, because this is evaluated
/// per SPOT at a position-dependent distance rather than once per render.
///
/// **Measured, that exposure is almost entirely absorbed, and by something one
/// level down.** The consumer narrows to f32: the cone's `peak` is
/// `f32(f32(3q) / ...)`, and an f32 carries about 1.2e-7 of relative precision.
/// Bracketed by planting a multiplicative error into the TypeScript and running
/// the tier-2 sweep:
///
/// | relative change in `quantity` | tier 2 |
/// | --- | --- |
/// | 1e-7 | RED |
/// | 1e-9, 1e-12 | not seen |
///
/// One f64 ULP is 2.2e-16, so `powf` against `r * r * r` is **two orders of
/// magnitude below what any tier can resolve** - planted, it is not seen. The
/// same argument covers a one-ULP wasm-libm difference in `powf` itself.
///
/// So write `powf` because it is what the reference writes, not because a
/// fixture would catch you. The thing that pins it is
/// `fixtures::the_spot_quantity_cube_is_powf_and_a_plain_product_would_diverge`,
/// which measures the divergence directly rather than through a consumer that
/// rounds it away.
#[must_use]
pub fn enemy_spot_quantity(distance: f64, controls: &EnemyControls) -> f64 {
    let radius = enemy_spot_radius(distance, controls);
    (std::f64::consts::PI / 90.0) * radius.powf(3.0)
}

/// `(1e-5 + 3e-6*intensity) * controls.frequency`.
#[must_use]
pub fn enemy_frequency(distance: f64, controls: &EnemyControls) -> f64 {
    let intensity = enemy_intensity(distance);
    (1e-5 + 3e-6 * intensity) * controls.frequency
}

/// `quantity * max(0, frequency)`.
#[must_use]
pub fn enemy_density(distance: f64, controls: &EnemyControls) -> f64 {
    let quantity = enemy_spot_quantity(distance, controls);
    let frequency = enemy_frequency(distance, controls);
    quantity * crate::eval::math::max2(0.0, frequency)
}
