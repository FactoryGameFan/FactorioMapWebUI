//! Gleba's twelve plants: each one's autoplace probability (#454, slice 4).
//!
//! Transcribed from `space-age/prototypes/entity/plants.lua` (each plant's
//! `autoplace` and its `local_expressions`) and
//! `space-age/prototypes/planet/planet-gleba-map-gen.lua`
//! (`gleba_water_plant_ramp`, `gleba_decal_noise` and the three
//! `gleba_*_region` expressions) at 2.1.23. FactMapGen
//! (`factorio_gleba_plants.go`, AGPL-3.0, which credits this repo) holds the
//! same expressions; every value here is graded against the game's own
//! `calculate_tile_properties`, not against it.
//!
//! **Stingfrond's Lua table has TWO `autoplace` keys.** The first carries
//! `tile_restriction = {"midland-turquoise-bark"}` and a clamp; the second,
//! order `a[tree]-b[forest]-e`, has neither. A Lua table constructor keeps the
//! last value for a repeated key, so the second is the one the game runs, and
//! the prototypes report stingfrond with that order and no restriction. Only
//! yumako-tree and jellystem are restricted to tiles.
//!
//! The richness (`random_penalty_at(3, 1)` for most) is not ported: each plant
//! is its own group, so richness never breaks a tie, and a tree's richness
//! places nothing.
//!
//! Every step is f32, in the Lua's order, like the terrain fields.

use crate::at::At;
use crate::eval::math::{clamp, f32r, max2, min2};
use crate::expressions::gleba_resources::ResourceInputs;
use crate::expressions::gleba_terrain::{noise, select};
use crate::multioctave_noise::Prepared;
use crate::poison;

/// The twelve plants, in the order their autoplace `order` sorts them, which
/// is the order the chunk's stream serves them in.
pub const PLANTS: [&str; 12] = [
    "yumako-tree",
    "jellystem",
    "sunnycomb",
    "boompuff",
    "stingfrond",
    "lickmaw",
    "teflilly",
    "funneltrunk",
    "slipstack",
    "hairyclubnub",
    "cuttlepop",
    "water-cane",
];

/// The plant fields at one position. All values are f32-valued.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct GlebaPlantFields {
    /// `gleba_decal_noise`.
    pub decal_noise: f64,
    /// `gleba_water_plant_ramp`.
    pub water_plant_ramp: f64,
    /// `gleba_funnel_trunk_region`, funneltrunk's probability.
    pub funnel_trunk_region: f64,
    /// `gleba_boompuff_region`, boompuff's probability.
    pub boompuff_region: f64,
    /// `gleba_teflilly_region`, teflilly's probability.
    pub teflilly_region: f64,
    /// `entity:<plant>:probability`, in [`PLANTS`] order.
    pub probability: [f64; 12],
}

/// The per-render state of the plant fields.
pub struct GlebaPlants {
    decal_a: Prepared,
    decal_b: Prepared,
    /// `control:gleba_plants:size`, in its f32 slot.
    size: f64,
}

/// `max(main_probability, invasion_probability)` with each a
/// `min(cap, scale * (box + noise - offset) * size)`, the shape most of the
/// plants share.
struct Patch {
    cap: f64,
    scale: f64,
    offset: f64,
}

impl Patch {
    fn eval(&self, area: f64, noise: f64, size: f64) -> f64 {
        let (cap, scale, offset) = (f32r(self.cap), f32r(self.scale), f32r(self.offset));
        min2(
            cap,
            f32r(f32r(scale * f32r(f32r(area + noise) - offset)) * size),
        )
    }

    /// The same, with the scale multiplied by `gleba_water_plant_ramp`
    /// first: `min(cap, ramp * scale * (box + noise - offset) * size)`.
    fn eval_ramped(&self, ramp: f64, area: f64, noise: f64, size: f64) -> f64 {
        let (cap, scale, offset) = (f32r(self.cap), f32r(self.scale), f32r(self.offset));
        min2(
            cap,
            f32r(f32r(f32r(ramp * scale) * f32r(f32r(area + noise) - offset)) * size),
        )
    }
}

/// `gleba_select(input, from, to, slope, -10, 1)`, every box's plateau.
fn plateau(input: f64, from: f64, to: f64, slope: f64) -> f64 {
    select(input, from, to, slope, -10.0, 1.0)
}

/// `min(gleba_select(aux, ...), gleba_select(moisture, ...)) - 1`.
fn aux_moisture_box(t: &ResourceInputs, aux: [f64; 3], moisture: [f64; 3]) -> f64 {
    f32r(
        min2(
            plateau(t.aux, aux[0], aux[1], aux[2]),
            plateau(t.moisture, moisture[0], moisture[1], moisture[2]),
        ) - 1.0,
    )
}

impl GlebaPlants {
    #[must_use]
    pub fn new(seed0: u32, size: f64) -> Self {
        Self {
            // `gleba_decal_noise`: the first term has `output_scale = 0.5`.
            decal_a: noise(seed0, 1500, 2.0, 0.7, f32r(1.0 / 16.0), 0.5),
            decal_b: noise(seed0, 2500, 2.0, 0.7, f32r(1.0 / 20.0), 1.0),
            size: f32r(size),
        }
    }

    /// `control:gleba_plants:size`, in its f32 slot.
    #[must_use]
    pub fn size(&self) -> f64 {
        self.size
    }

    /// Every plant field at one position, given the terrain fields there.
    #[must_use]
    pub fn eval(&self, at: At, t: &ResourceInputs) -> GlebaPlantFields {
        let size = self.size;
        let (n, nb) = (t.plants_noise, t.plants_noise_b);

        // --- gleba_water_plant_ramp: `clamp((0.8 - gleba_moisture) * 20, 0, 1)`.
        let water_plant_ramp = clamp(f32r(f32r(f32r(0.8) - t.moisture) * 20.0), 0.0, 1.0);

        // --- gleba_decal_noise: `0.6 * a + 0.3 - abs(b)`.
        let decal_noise = f32r(
            f32r(f32r(f32r(0.6) * f64::from(self.decal_a.eval_at(at))) + f32r(0.3))
                - f64::from(self.decal_b.eval_at(at)).abs(),
        );

        // --- yumako-tree and jellystem: `min(0.2, 0.3 * (1 - noise) * size)`.
        let seedable = min2(f32r(0.2), f32r(f32r(f32r(0.3) * f32r(1.0 - n)) * size));

        // --- sunnycomb
        let sunnycomb = max2(
            Patch {
                cap: 0.08,
                scale: 0.15,
                offset: 0.45,
            }
            .eval(f32r(plateau(t.moisture, 0.0, 0.25, 0.01) - 1.0), nb, size),
            Patch {
                cap: 0.05,
                scale: 0.15,
                offset: 0.4,
            }
            .eval(f32r(plateau(t.moisture, 0.0, 0.35, 0.01) - 1.0), nb, size),
        );

        // --- gleba_boompuff_region
        let boompuff_region = max2(
            Patch {
                cap: 0.1,
                scale: 0.15,
                offset: 0.45,
            }
            .eval(
                aux_moisture_box(t, [0.5, 1.0, 0.05], [0.25, 0.5, 0.01]),
                n,
                size,
            ),
            Patch {
                cap: 0.05,
                scale: 0.1,
                offset: 0.55,
            }
            .eval(
                aux_moisture_box(t, [0.55, 1.0, 0.15], [0.1, 0.6, 0.01]),
                n,
                size,
            ),
        );

        // --- stingfrond (its second, live, autoplace)
        let stingfrond = max2(
            Patch {
                cap: 0.05,
                scale: 0.1,
                offset: 0.25,
            }
            .eval(
                aux_moisture_box(t, [0.0, 0.5, 0.15], [0.25, 0.5, 0.01]),
                n,
                size,
            ),
            Patch {
                cap: 0.05,
                scale: 0.1,
                offset: 0.55,
            }
            .eval(
                aux_moisture_box(t, [0.0, 0.5, 0.15], [0.1, 0.25, 0.01]),
                n,
                size,
            ),
        );

        // --- lickmaw
        let lickmaw = Patch {
            cap: 0.02,
            scale: 0.1,
            offset: 0.2,
        }
        .eval(
            aux_moisture_box(t, [0.7, 1.0, 0.15], [0.5, 0.75, 0.01]),
            n,
            size,
        );

        // --- gleba_teflilly_region
        let teflilly_region = max2(
            Patch {
                cap: 0.1,
                scale: 0.15,
                offset: 0.3,
            }
            .eval(
                aux_moisture_box(t, [0.3, 0.7, 0.15], [0.5, 0.75, 0.01]),
                nb,
                size,
            ),
            Patch {
                cap: 0.05,
                scale: 0.15,
                offset: 0.55,
            }
            .eval(
                aux_moisture_box(t, [0.55, 0.85, 0.15], [0.4, 0.7, 0.01]),
                nb,
                size,
            ),
        );

        // --- gleba_funnel_trunk_region
        let funnel_trunk_region = max2(
            Patch {
                cap: 0.08,
                scale: 0.15,
                offset: 0.25,
            }
            .eval(
                aux_moisture_box(t, [0.0, 0.4, 0.05], [0.5, 0.75, 0.01]),
                nb,
                size,
            ),
            Patch {
                cap: 0.01,
                scale: 0.1,
                offset: 0.5,
            }
            .eval(
                aux_moisture_box(t, [0.0, 0.55, 0.05], [0.4, 0.6, 0.01]),
                nb,
                size,
            ),
        );

        // --- slipstack, hairyclubnub and cuttlepop: ramped by the coast.
        let ramp = water_plant_ramp;
        let slipstack = Patch {
            cap: 0.02,
            scale: 0.2,
            offset: 0.2,
        }
        .eval_ramped(ramp, f32r(plateau(t.aux, 0.7, 1.0, 0.1) - 1.0), n, size);
        let hairyclubnub = Patch {
            cap: 0.02,
            scale: 0.2,
            offset: 0.2,
        }
        .eval_ramped(ramp, f32r(plateau(t.aux, 0.0, 0.3, 0.15) - 1.0), n, size);
        let cuttlepop = Patch {
            cap: 0.03,
            scale: 0.2,
            offset: 0.2,
        }
        .eval_ramped(ramp, f32r(plateau(t.aux, 0.35, 0.65, 0.1) - 1.0), nb, size);

        // --- water-cane: `min(0.8, (min(1, 1.5 * ramp) + 0.5 * decal - noise
        //     - 0.5 * gleba_select(aux, 0.45, 0.55, 0.2, 0, 1) - 0.7) * size)`.
        let mid_aux = select(t.aux, 0.45, 0.55, 0.2, 0.0, 1.0);
        let cane_sum = f32r(
            f32r(
                f32r(f32r(min2(1.0, f32r(1.5 * ramp)) + f32r(0.5 * decal_noise)) - n)
                    - f32r(0.5 * mid_aux),
            ) - f32r(0.7),
        );
        let water_cane = min2(f32r(0.8), f32r(cane_sum * size));

        GlebaPlantFields {
            decal_noise,
            water_plant_ramp,
            funnel_trunk_region,
            boompuff_region,
            teflilly_region,
            probability: [
                seedable,
                seedable,
                sunnycomb,
                boompuff_region,
                stingfrond,
                lickmaw,
                teflilly_region,
                funnel_trunk_region,
                slipstack,
                hairyclubnub,
                cuttlepop,
                poison::f64_result(water_cane),
            ],
        }
    }
}
