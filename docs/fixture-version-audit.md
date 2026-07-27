# Fixture version audit - which stale fixtures actually matter

**Status: open, not yet run.** Written 2026-07-26 so the question survives the
session it came from. Nothing here has been executed; the conclusions section is
empty on purpose.

## The question

`pnpm refs:sync --fixtures` reports that 38 of 52 oracle fixtures were captured
on a Factorio older than the installed binary:

| captured on | fixtures |
| ----------- | -------- |
| 2.1.9       | 5        |
| 2.1.11      | 33       |
| 2.1.12      | 13       |
| unknown     | 1        |

**That list is not a bug list.** A fixture captured on 2.1.11 is stale, not
wrong - it means that ground truth has not been re-validated since. It only
matters if the subsystem it covers actually changed between its capture version
and now. The audit is the step that turns "38 are old" into "these N need
re-capturing."

This is worth doing because version skew is invisible from the inside. The
Vulcanus surface-seed bug passed every internal check for weeks: the fixture and
the code agreed with each other while both disagreed with the game. Re-reading
the game's own Lua across a version boundary is one of the few checks that comes
from outside that loop.

## Precondition

`~/GitHub/factorio-data` must be at the binary's version, which `pnpm refs:sync`
guarantees:

```bash
pnpm refs:sync --check     # exit 0 means data + docs match the binary
```

The relevant tags: `2.0.77`, `2.1.9`, `2.1.10`, `2.1.11`, `2.1.12`.

## Which files govern which fixtures

**Don't trust this table blindly - re-derive it.** An earlier version of this
doc was written from plausible-sounding filenames and was wrong in five of eight
rows, which is the exact false negative this audit exists to avoid: it sent you
to diff `core/lualib/resource-autoplace.lua` and
`base/prototypes/entity/resources.lua` for the resource fixtures, and both are
byte-identical from 2.0.77 through 2.1.12 while the real `starting_patches`
change sat in `core/prototypes/noise-functions.lua` the whole time.

The recipe, which cannot go stale:

```bash
D=~/GitHub/factorio-data
# where an expression is DEFINED (a noise-expression prototype declares it)
grep -rlE 'name *= *"<expression_name>"' $D/core $D/base $D/space-age --include="*.lua"
```

Definition sites are what matter. A bare `grep -rl <name>` also returns every
file that merely *calls* the expression, which for common names like `aux` or
`trees` is most of the prototype tree.

Derived that way at **tag 2.1.12**:

| Fixture group                                                                                                  | Defined in                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `oracle-basis`, `oracle-multioctave*`, `oracle-quick-multioctave`, `oracle-variable-persistence-*`, `oracle-multisample`, `oracle-expression-in-range`, `oracle-seed-vars` | **Nowhere in `factorio-data`** - these are native C++ ops. See the note below. |
| `oracle-elevation-lakes`, `oracle-elevation-island`, `oracle-elevation-nauvis*`                                | `core/prototypes/noise-programs.lua`                                                          |
| `oracle-cliffiness`, `oracle-cliff-elevation`, `oracle-cliff-offset-raw`, `oracle-cliff-entities`              | `core/prototypes/noise-programs.lua`                                                          |
| `oracle-resource-regular`, `oracle-resource-starting`, `oracle-random-penalty`, `oracle-starting-spot`         | `core/prototypes/noise-functions.lua`, `core/prototypes/noise-programs.lua`                    |
| `oracle-aux`, `oracle-moisture`, `oracle-temperature`                                                          | `core/prototypes/noise-programs.lua`                                                          |
| `oracle-tile-names.*`                                                                                          | the above, plus `base/prototypes/tile/tiles.lua` (tile autoplace decides the winner)          |
| `oracle-enemy-base`                                                                                            | `base/prototypes/noise-expressions.lua`                                                       |
| `oracle-trees`, `oracle-trees-controls`                                                                        | `core/prototypes/noise-programs.lua`, `base/prototypes/entity/trees.lua`                       |
| `oracle-rock-density`                                                                                          | `base/prototypes/noise-expressions.lua`                                                       |
| `oracle-vulcanus-*`                                                                                            | `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`, `space-age/prototypes/tile/tiles-vulcanus.lua` |
| `builtin-presets.json`, `map-*.dump.json` (2.1.9)                                                              | none of the above - these are **codec** fixtures, see the note below                          |

### The noise-primitive fixtures cannot be audited this way

`basis_noise`, `multioctave_noise`, `quick_multioctave_noise` and
`variable_persistence_multioctave_noise` are implemented in the engine, not in
Lua - `factorio-data` only *calls* them. A data diff will always come back
clean for those fixtures no matter what changed, so a clean diff is **not**
evidence they are current. The only check is re-sampling against the binary
through `test/oracle/`.

## The commands

The 33 fixtures captured on 2.1.11 are the bulk of the exposure, so start there:

```bash
D=~/GitHub/factorio-data

# The six files that between them define every data-governed fixture above
git -C $D diff --stat 2.1.11 2.1.12 -- \
  core/prototypes/noise-programs.lua \
  core/prototypes/noise-functions.lua \
  base/prototypes/noise-expressions.lua \
  base/prototypes/tile/tiles.lua \
  base/prototypes/entity/trees.lua \
  space-age/prototypes/planet/planet-vulcanus-map-gen.lua

# Then the wider net for the 5 codec-era fixtures
git -C $D diff --stat 2.1.9 2.1.12 -- core/ base/prototypes/
```

An empty `--stat` for a path is a real answer **for the data-governed fixtures
only** - that subsystem did not move, and the fixtures it governs can be
re-dated rather than re-captured. It says nothing about the noise-primitive
fixtures. Drop `--stat` to read the hunks for anything that did move.

### Already known, so skip it

`starting_patches` was checked on 2026-07-26. It changed between **2.0.77 and
2.1.9** - `starting_resource_placement_radius` 120 -> 150, `region_size`
`radius*2` -> `radius*3`, `suggested_minimum_candidate_point_spacing` 32 -> 48,
`maximum_spot_basement_radius` from a fixed 128 to one scaled by patch size,
`random_penalty_at(0.5, 1)` dropped from the favorability expression, a new
`origin_excluder = "distance > 40"`, the distance term clamped with `min(1,
...)`, and the inline lake term extracted into the planet-overridable
`starting_resources_lake_mask` (which also switched `elevation_lakes` ->
`elevation`). `regular_patches` was untouched in the same window.

All of it is in `core/prototypes/noise-functions.lua`, and
`noise-functions.lua` + `noise-programs.lua` are **unchanged from 2.1.9 through
2.1.12**. So the 33 fixtures captured at 2.1.11 are unaffected by this change;
only the 2.1.9-era ones sit near the boundary, and those are the codec fixtures
the map-gen Lua does not govern.

## What counts as "needs re-capture"

Not every diff invalidates a fixture. Re-capture when the change touches a
**value the fixture encodes** - a constant, a formula, a threshold, a default.
Ignore renames of locals, comment edits, reordering, and changes to prototypes
no fixture covers.

The known precedent, and the reason this doc exists: `starting_patches` changed
materially between 2.0.77 and 2.1.11 - radius 120 -> 150, `region_size` \*2 ->
\*3, spacing 32 -> 48, and the `random_penalty` favorability term was removed.
`regular_patches` was untouched in the same window. That is exactly the shape to
look for: one subsystem moves, its neighbour does not, and only the fixtures
covering the mover are stale in a way that matters.

## The codec fixtures are a separate question

The five 2.1.9 fixtures (`builtin-presets.json`, the `map-*.dump.json` files,
the two `*.example.json`) are **not** governed by the map-gen Lua at all. They
pin the exchange-string binary layout, whose version marker is the format tag
`2.1.9.3`, not the game version. They only go stale if the format tag changes -
so check that before diffing anything on their account.

## Recording the outcome

Whatever the audit concludes, write it back into
`test/fixtures/PROVENANCE.json`:

- Re-captured a fixture → update its `factorioVersion` and set `evidence` to
  describe the new capture.
- Confirmed a subsystem did not move → leave `factorioVersion` alone. It records
  where the ground truth *came from*, which does not change just because it was
  re-checked. Note the confirmation here instead.
- Never promote an `inferred` or `unknown` entry on the strength of a clean
  diff. Only a fresh capture against a known binary can do that.

`test/fixtureProvenance.spec.ts` enforces that every fixture keeps an entry, and
caps `unknown` at 1 so re-capturing
`autoplace-can-be-disabled.dump.json` is the one move that can lower the ratchet.

## Conclusions

_Not yet run._
