# Enemy bases (M4) - reverse-engineering notes

Factorio 2.1.11 (build 86962). Measured 2026-07-20 against the headless oracle
(`test/oracle/oracle.ts` `sampleExpression`, routing a named expression onto
`elevation`). Companion to `spot-noise-NOTES.md`, `basis-noise-NOTES.md`,
`random-penalty-NOTES.md`. Source Lua: `~/GitHub/factorio-data` @ tag `2.1.11`,
`base/prototypes/noise-expressions.lua` (enemy expressions),
`base/prototypes/entity/{enemies,turrets}.lua` (autoplace bindings).

## The expressions (verbatim, `noise-expressions.lua:1-49`)

```
enemy_base_intensity   = clamp(distance, 0, 2400) / 325
enemy_base_radius      = sqrt(var('control:enemy-base:size')) * (15 + 4 * enemy_base_intensity)
enemy_base_frequency   = (0.00001 + 0.000003 * enemy_base_intensity) * var('control:enemy-base:frequency')
spot_radius_expression   = max(0, enemy_base_radius)
spot_quantity_expression = pi/90 * spot_radius_expression ^ 3

enemy_base_probability =
    spot_noise{ x=x, y=y,
                density_expression      = spot_quantity_expression * max(0, enemy_base_frequency),
                spot_quantity_expression = spot_quantity_expression,
                spot_radius_expression   = spot_radius_expression,
                spot_favorability_expression = 1,
                seed0 = map_seed, seed1 = 123,
                region_size = 512, candidate_point_count = 100,
                hard_region_target_quantity = 0,
                basement_value = -1000, maximum_spot_basement_radius = 128 }
  + (blob(1/8, 1) + blob(1/24, 1) + blob(1/64, 2) - 0.5) * spot_radius_expression / 150
      * (0.1 + 0.9 * clamp(distance / 3000, 0, 1))
  - 0.3
  + min(0, 20 / starting_area_radius * distance - 20)

blob(is, os) = basis_noise{ x=x, y=y, seed0=map_seed, seed1=123, input_scale=is, output_scale=os }

enemy_autoplace_base(distance_factor, seed) =
    random_penalty{ x = x + seed, y = y,
        source = min( enemy_base_probability * max(0, 1 + 0.002*distance_factor*(-312*distance_factor - starting_area_radius + distance)),
                      0.25 + distance_factor*0.05 ),
        amplitude = 0.1 }
```

## Autoplace bindings (who uses which `enemy_autoplace_base(distance_factor, seed)`)

- **biter-spawner** `(0, 6)` (`enemies.lua:209`), **spitter-spawner** `(0, 7)`
  (`enemies.lua:865`) - via `enemy_spawner_autoplace` (`enemy-autoplace-utils.lua:14`).
  Both have `distance_factor = 0`.
- **worms** (`enemy_worm_autoplace`, wrapped `* (1 - no_enemies_mode)`): small `(0, 2)`,
  medium `(2, 3)`, big `(5, 4)`, behemoth `(8, 5)` (`turrets.lua:421/1050/1193/1334`).
  Only the small worm is `distance_factor = 0`; medium/big/behemoth are distance-shaped
  (the `max(0, 1 + 0.002*df*(...))` factor and the `0.25 + df*0.05` cap do NOT collapse).
- `(0, 7)` is the **spitter-spawner, NOT a worm** (a common misread - `seed=7` is just
  the per-expression x-offset into `random_penalty`).

## Measured facts (the render-relevant ones)

1. **The field is basement-dominated.** `enemy_base_probability` sits at
   `basement_value = -1000` almost everywhere, rising to positive only *inside* base
   spot cones. Measured far grid `[800..1100]^2` stride 20: min `-1000.79`, max
   `0.781`; positive cells cluster into a few spot cones (e.g. `(1000,1040)=0.781`,
   `(1000,1020)=0.621`, `(980,1100)=0.583`).

2. **At `distance_factor = 0` the source reduces to `min(enemy_base_probability, 0.25)`**
   (the `max(0,1+...)` factor = 1, the cap = 0.25). Since `random_penalty` passes a
   `source <= 0` through unchanged, `enemy_autoplace_base(0, *)` == `enemy_base_probability`
   wherever the field is `<= 0.25` (i.e. everywhere except inside spot cones). Inside
   spots the placement prob **caps at 0.25** and is jittered DOWN:

   `enemy_autoplace_base = min(enemy_base_probability, 0.25) - 0.1 * U`, `U in [0,1)`
   the batched `random_penalty` draw (SUBTRACTIVE, not multiplicative). Verified:
   ebp 0.781 -> ap 0.172 (U=0.78), 0.621 -> 0.180 (U=0.70), 0.583 -> 0.233 (U=0.17),
   0.410 -> 0.210 (U=0.40), 0.498 -> 0.181 (U=0.69).

3. **`starting_area_radius = 150`** for the default `starting_area` setting - directly
   sampleable as the named value `starting_area_radius` (it equals the
   `starting_resource_placement_radius` constant). It scales with the `starting_area`
   map setting; only the default (150) is measured. (NB: `starting_area_weight` is a
   DIFFERENT, decreasing expression `1 - min(1, 0.5*tier_from_start)`; do not use it to
   derive the radius. `tier_from_start = max(0, distance - starting_area_radius)/starting_area_radius`
   at `noise-programs.lua:576` also exposes it, but direct sampling is simpler.)

4. **The starting area is clear of bases.** Within +-140 tiles of spawn every sampled
   cell is negative (2D block max ~ -0.9). The `- 0.3` and
   `min(0, 20/150*distance - 20)` terms hold the near-spawn field down; along +x it
   rises from -21.7 (d=0) to -12.0 (d=90), then drops to the -1000 basement at d>=100
   (the origin region's lone marginal spot fades out by ~d=95). Net: no positive
   footprint near spawn, so a `> 0` threshold clears the starting area for free.

## `candidate_point_count` - RESOLVED (empirically a non-issue)

The enemy `spot_noise` sets `candidate_point_count = 100` and leaves both
`candidate_spot_count` and `suggested_minimum_candidate_point_spacing` at engine
defaults - the opposite of every M3 resource call (which set `candidate_spot_count` +
explicit spacing). This looked like an un-RE'd path because the current
`spotSelection.ts` models only `candidateSpotCount` (the dart-throw acceptance target)
with a required `spacing`.

**But a spike settled it (2026-07-20):** a hand-port of `enemy_base_probability` over
the EXISTING `selectSpots` (mapping `candidate_point_count -> candidateSpotCount = 100`,
`hardRegionTargetQuantity = false`, cone peak `= 3q/(pi r^2)` with `r = spot_radius` at
the spot, `q = pi/90 r^3`) matches the oracle to `abs < 0.001` at all 7 checked points
(deep basement `(200,0)=-1000.29`; near-spawn `(60,0)=-15.107`; five cone-interior
points in the far region around `(1000,1000)`, `ebp` 0.41..0.78). The match is
**identical for spacing in {32, 45.25, 51.2}**.

Why the pool size and spacing do not bind: the regional density target
(`avg_density * region_area`) is small (frequency `~1e-5`), so only ~5 spots survive
the trim per 512^2 region - reached with the first few accepted candidates, long before
the 100-vs-128 pool bound or the Poisson-disk spacing-decay could change the kept set.
So `candidate_point_count = 100` == `candidateSpotCount = 100` here and **no
`spotSelection`/`spotCandidates` change is needed**. (This holds for THIS field's low
density; a spacing/pool-sensitive `spot_noise` would still need the extension. Validate
with a dense full-region oracle grid, not just these 7 points, to be safe.)

Cone geometry note: with `q = pi/90 r^3`, `peak = 3q/(pi r^2) = r/30` and slope
`= peak/r = 1/30`, so an enemy cone is `(r - dist)/30` - a shallow cone peaking at
`~0.5-1.0` (r ~ 15-30), which is why in-spot `ebp` tops out under 1 and the placement
source caps at 0.25. No `min(32, ...)` radius cap (that is resource-only).

## Shipped (2026-07-20) - the threshold render, SUPERSEDED 2026-07-27

Task 6 headless eyeball render (seed 123456, 2048-tile span centered on spawn,
tilesPerPixel 4): base regions render as scattered red blobs, spawn stays clear
(0 red pixels within an 80-tile radius of origin), and re-rendering with
`enemyControls: { frequency: 3, size: 2 }` roughly 8x'd the red pixel count
(2986 -> 23893 of 262144 total) with visibly bigger/more blobs, not a solid
sheet. `ENEMY_FOOTPRINT_THRESHOLD` **kept at 0.05** - the sparse render reads as
distinct base regions (not noise dust) and the dense render still shows plenty
of terrain between blobs, so no retune was needed. `test/enemyBaseField.spec.ts`
and `test/renderEnemies.spec.ts` re-run green with the threshold unchanged.
M4 enemy bases done: footprint overlay, spawners only (worms + per-nest
placement out of scope, see above). Cliffs remain the one open M4 item.

## The render now ROLLS, not thresholds (2026-07-27, Task 6)

`ENEMY_FOOTPRINT_THRESHOLD` is deleted. `renderEnemies.ts` places spawners through
`makePlacementSet` - the game's per-tile roll plus its two arbitration gates - and
paints a 3x3 mark per placement. The section above is kept as the record of the
threshold era; everything in it about the FIELD still holds, and only the render
rule changed.

Three things this task established that the section above did not know:

1. **The probability the game rolls is not `enemy_base_probability`.** Both
   spawners are `enemy_autoplace_base(0, seed)`, whose outermost operation is
   `random_penalty{x = x + seed, amplitude = 0.1}`. At `distance_factor = 0` the
   inner source collapses to exactly `min(enemy_base_probability, 0.25)`, so the
   penalty is the whole difference: `source - 0.1*U` per prototype, and
   `source - 0.1*min(U_biter, U_spitter)` for the arbitrated group of two.
   Dropping it leaves 47% more overshoot in region 0 (9 spawners above the game's
   19 with the penalty, 17 without) and 40% more in region 1 (15 above 142, against
   25). In raw counts that is 28 vs 36 and 157 vs 167.

2. **The collision box is `map_generator_bounding_box`, not `collision_box`.**
   Both spawners declare `{{-3.7,-3.2},{3.7,3.2}}` (7.4 x 6.4) beside a
   `collision_box` of 4.4 x 4.4, and `EntityPrototype.map_generator_bounding_box`
   is documented as "Used instead of the collision box during map generation".
   Measured, the map-gen box beats the collision box by 132 points in region 0 and
   87 in region 1. Neither rock overlay declares the field, so their use of
   `collision_box` was right - but check for it FIRST on any new overlay.

3. **The two spawners declare the SAME box**, so the argmax-box question is
   degenerate here in the strongest possible way: no box rule can differ. That is
   a third distinct kind of degeneracy after Vulcanus's ordering theorem and
   Nauvis rocks' lattice collapse.

Density against `test/fixtures/oracle-entity-counts.seed123456.json` (2.1.12, seed
123456), `biter-spawner + spitter-spawner`: region 1 `[4096,4096]` is 157 against
the game's 142 (**10.6%**), pinned in `test/entityDensity.spec.ts`. Region 0
`[0,0]` is 28 against 19 (**47.4%**) and is deliberately NOT pinned - see the
cross-overlay occupancy finding in `placement-roll-NOTES.md`.
