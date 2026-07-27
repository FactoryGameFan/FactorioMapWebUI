# Vulcanus rocks - port notes

Factorio 2.1.12 (build 87038, mac-arm64). Ported 2026-07-26, same session as
`vulcanus-cliffs-NOTES.md`. Companion to `rocks-NOTES.md`-era work in
`src/noise/rocks/rockField.ts` (Nauvis) and to `placement-roll-NOTES.md`.

Source Lua: `~/GitHub/factorio-data` @ tag `2.1.12`,
`space-age/prototypes/decorative/decoratives-vulcanus.lua` and
`space-age/prototypes/planet/planet-map-gen.lua`.

## Four entities, two expressions

`planet_map_gen.vulcanus()`'s `autoplace_settings.entity` lists four rocks:
`huge-volcanic-rock`, `big-volcanic-rock`, and their `-hot` variants. The hot
variants **reuse the cold ones' probability expressions**, so there are only two:

```
vulcanus_rock_huge = min(0.2 * (1 - 0.75 * vulcanus_ashlands_biome),
                         -1.2 + 1.2 * min(aux, -0.1 + 1.1 * moisture)
                              + vulcanus_rock_noise
                              + 0.5 * vulcanus_decorative_knockout)

vulcanus_rock_big  = min(0.2 * (1 - 0.5 * vulcanus_ashlands_biome),
                         -1.0 + <the same three terms>)
```

All four declare `map_color = {129, 105, 78}` - identical to Nauvis's rocks, so
`ROCK_MAP_COLOR` is shared rather than duplicated.

The field the overlay uses is
`density = clamp(max(rock_huge, rock_big), 0, 1)`. Taking the max is **exact,
not an approximation**: per-tile arbitration among competing autoplacers is by
maximum probability (`placement-roll-NOTES.md`), so that is the probability the
game would actually roll where a rock wins.

### The four decorative siblings are deliberately excluded

The same Lua file defines `vulcanus_rock_medium`, `_cluster`, `_small` and
`_tiny`. Those prototypes appear in `autoplace_settings.**decorative**`, not
`entity`. The game's map preview charts entities, not decoratives, so including
them would paint ink the game's own preview does not.

## Almost everything was already ported

The two expressions read `aux`, `moisture`, `vulcanus_ashlands_biome` and
`vulcanus_rock_noise` - all already ported and oracle-validated for the V1 tile
catalog. The only new expression is `vulcanus_decorative_knockout`
(`planet-vulcanus-map-gen.lua:867`), commented there as "small wavelength noise
(5 tiles-ish) to make decoratives patchy":

```
multioctave_noise{x = x, y = y, persistence = 0.7, seed0 = map_seed,
                  seed1 = 1300000, octaves = 2, input_scale = 1/3}
```

No `output_scale`, so it defaults to 1.

## No rocks slider on Vulcanus, and the source says why

`planet_map_gen.vulcanus()`'s `autoplace_controls` carries the entry commented
out, with the reason inline (`planet-map-gen.lua:43`):

```lua
--["rocks"] = {}, -- can't add the rocks control otherwise nauvis rocks spawn
```

So there is no frequency or size lever to thread, unlike Nauvis's
`makeRockDensity` which takes both. `vulcanus_rock_noise` even has its own
`control:rocks:frequency` term commented out at its definition site.

## Accuracy

Against the game at 434 positions (`test/vulcanusRocks.spec.ts`):

| expression | worst residual |
| --- | --- |
| `vulcanus_decorative_knockout` | 1.18e-4 (2.22e-5 within r < 300) |
| `vulcanus_rock_huge` | under 5e-4 |
| `vulcanus_rock_big` | under 5e-4 |

The knockout's residual grows smoothly with distance - 2.22e-5 / 6.40e-5 /
1.18e-4 across r bands - which is the f32 coordinate floor amplified by its
`input_scale = 1/3`, the highest frequency in the Vulcanus port (tied with
`sulfuricAcidPatches`, which carries the same effect and the same explanation in
`vulcanus-resources-NOTES.md`). A coordinate error `e` becomes a phase error
`e/3`. **Smooth growth is what distinguishes a precision floor from a porting
error** - contrast the cliffs capture, where a 200x jump turned out to be a
single knife-edge probe position.

The spec asserts both the overall bound and a tighter near-field one, since the
near field is where the preview actually renders.

## The render WAS a threshold, and it did not look like the game (SUPERSEDED 2026-07-27)

**Superseded by the placement roll.** `renderVulcanusRocks` no longer thresholds:
since Tasks 3 and 4.5 it rolls the game's per-tile placement draw against `density`
and applies the tile-restriction and collision gates (`makePlacementSet`).
`VULCANUS_ROCK_FOOTPRINT_THRESHOLD` was deleted in Task 3, and the Nauvis overlay it
mirrored stopped thresholding in Task 5 (`ROCK_FOOTPRINT_THRESHOLD` is gone too). The
rest of this section is kept as the record of WHY the roll was necessary - the
plateau argument below is the reason thresholding could not be tuned into looking
right, and it is still the best short explanation of that. Read it as history, not as
current behaviour. Vulcanus still has no water exclusion (no water tile) and no
levers; both remain true.

**A threshold on a probability field is not a placement**, and it is worth
being blunt about the limit. Both expressions cap at 0.2, so `min(cap, ...)`
makes the field a **plateau** rather than a gradient, and thresholding cannot
turn it into scattered points. Measured over world `[-512, 512)^2` at seed
123456:

| threshold | coverage |
| --- | --- |
| 0.02 | 7.03% |
| 0.08 | 5.50% |
| 0.12 | 3.81% |
| 0.19 | 2.37% |

Even at 0.19 - a hair under the cap - a third of the ink survives. The Nauvis
constant was chosen because 0.02 painted ~1.6% there and read as scattered
specks; the same constant paints 7.0% here.

The threshold was **kept at Nauvis's 0.02 anyway**, rather than tuned to hit a
coverage number. Tuning would have bought a magic per-planet constant without
buying the intended look, since the plateau shape is the actual obstacle. The
honest description of what this draws is "rocky ground", not "rocks".

The real fix was the per-tile placement roll tracked in **issue #9**, which also
covers the sulfuric-acid geyser, Nauvis crude oil and Nauvis enemy bases. It
shipped for Vulcanus rocks in Tasks 3 and 4.5, for Nauvis rocks in Task 5, for
Nauvis enemy bases in Task 6 and for the sulfuric-acid geyser in Task 7; only
Nauvis crude oil is still outstanding.

**"Reads as rocky ground" was the one thing in the V3 work that wanted a human
eyeball**, since that is a judgement a test cannot make. The roll replaced the
plateau with scattered single pixels, so the specific complaint is gone.

## Validation status

**Entity-level validation now exists** and did not when this was written.
`test/entityDensity.spec.ts` compares the placed-tile count against real
`count_entities_filtered` counts from a 2.1.12 surface
(`test/fixtures/oracle-entity-counts.seed123456.json`) over three regions, and
agrees to 0.2% / 0.6% / 7.5%.

What that does and does not prove is worth keeping straight. Proven: the three
expressions match the game to the bounds above; the decorative/entity split is read
from the planet definition; and the total rock DENSITY matches. **Not** proven - and
in fact falsified - is the per-tile prototype identity: max-probability arbitration
predicts a 0% `huge-volcanic-rock` population where the game has ~28%. See the
FALSIFIED section of `docs/noise/placement-roll-NOTES.md`. Coverage against the
game's own map preview is still unchecked.
