# Fixture version audit - which stale fixtures actually matter

**Status: run.** Written 2026-07-26 so the question survives the session it came
from; the data-governed half was run 2026-07-28 and the noise primitives on
2026-07-29. Re-run against the **2.1.14** binary on 2026-08-10 - see "Re-run
2026-08-10" at the bottom. See Conclusions.

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
through `test/oracle/` - done on 2026-07-29, see Conclusions.

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

**Run 2026-07-28, against binary/data/docs all in sync at 2.1.12.**

### The 33 fixtures captured at 2.1.11: NONE need re-capturing

All seven data-governing files are byte-identical from 2.1.11 to 2.1.12
(`noise-programs.lua`, `noise-functions.lua`, `base/.../noise-expressions.lua`,
`tiles.lua`, `trees.lua`, `planet-vulcanus-map-gen.lua`, `tiles-vulcanus.lua`).

That was checked the weak way and the strong way. The weak way is diffing the
files you expect to matter, which only confirms a prediction. The strong way is
diffing **everything** and reading what moved:

| changed 2.1.11 -> 2.1.12 | map-gen relevant? |
| --- | --- |
| 5 x `info.json`, `changelog.txt` | no |
| graphics: `assemblerpipes`, `pump-connector`, `recycler-pictures`, `remnants`, `explosions`, `base-frozen-graphics` | no |
| `quality/` recycling + entity | no |
| `biter-ai-settings.lua`, `gleba-ai-settings.lua` (both deleted) | no - runtime unit AI (`destroy_when_commands_fail`), not autoplace; no fixture covers them |
| `space-age/prototypes/planet/planet.lua` (+2) | no - a `starmap_icon` on the `solar-system-edge` **space-location** |

Nothing in the map-gen data moved at all. The 2.1.11 fixtures are stale in date
only.

### The 5 codec fixtures at 2.1.9: the format tag DID change, and it was a live bug

This is what the audit was for, and it was not a stale-fixture problem.

The doc said to check the exchange **format tag** rather than the game version.
The tag moved: **Factorio 2.1.12 emits `2.1.12.2` where 2.1.9 emitted
`2.1.9.3`**, and `mapExchangeString.ts` accepted only the latter - so the app
**rejected every map-exchange string copied out of the current game**, with
`unsupported exchange format`. Shipped and live at the time it was found.

Scope, pinned in both directions rather than assumed:

| direction | status |
| --- | --- |
| export (app -> game) | **fine.** 2.1.12's own `helpers.parse_map_exchange_string` accepts a `2.1.9.3` string, verified through the game |
| import (game -> app) | **broken.** Fixed 2026-07-28 |

**The payload layout did not change; only the tag did.** Five 2.1.12 captures
varying seeds, autoplace controls, water/terrain_segmentation/cliff_settings/
starting_area, and the peaceful/no_enemies mid-block flags all decode and
re-encode **byte-for-byte** (`test/mapExchangeVersions.spec.ts`,
`map-exchange-2.1.12.strings.json`). So the five 2.1.9 fixtures are still valid
ground truth for the format they pin - they did not need re-capturing either.

`SUPPORTED_VERSIONS` is now a known-good **list**, not a range: the schemas here
are empirical, so accepting an unseen format risks decoding a changed layout into
plausible wrong values, which is worse than a clean rejection. A version joins the
list only with a fixture proving byte-exact round-trip.

### The noise-primitive fixtures: RE-SAMPLED 2026-07-29, all bit-identical

Closed. These are governed by native C++ ops, so the clean data diff above says
**nothing** about them - the only check is running the binary. Every one was
re-sampled through `test/oracle/sampleExpression` against **Factorio 2.1.12
(build 87038)**, with the same expressions, positions and seeds each fixture
records, and compared **exactly** (`Object.is`, not a tolerance). 120 headless
runs, ~2.5 minutes of game time.

| fixture | captured on | series | values compared | mismatched | max abs diff |
| --- | --- | --- | --- | --- | --- |
| `basis-noise-seeding.game.json` | 2.1.11 | 9 | 432 | 0 | 0 |
| `basis-noise.seed123456.json` | 2.1.11 | 1 | 512 | 0 | 0 |
| `oracle-basis.seed123456.json` | 2.1.11 | 1 | 38 | 0 | 0 |
| `oracle-expression-in-range.seed123456.json` | 2.1.11 | 3 | 404 | 0 | 0 |
| `oracle-multioctave.seed123456.json` | 2.1.11 | 7 | 266 | 0 | 0 |
| `oracle-multioctave-wrappers.seed123456.json` | 2.1.11 | 8 | 304 | 0 | 0 |
| `oracle-quick-multioctave.seed123456.json` | 2.1.11 | 5 | 190 | 0 | 0 |
| `oracle-variable-persistence-multioctave.seed123456.json` | 2.1.11 | 8 | 304 | 0 | 0 |
| `oracle-multisample.seed123456.json` (**control**) | 2.1.12 | 30 | 150 | 0 | 0 |
| `oracle-seed-vars.multi.json` (**control**) | 2.1.12 | 48 | 48 | 0 | 0 |
| **total** | | **120** | **2648** | **0** | **0** |

So `basis_noise` (including its seed combine, salt and clamp),
`multioctave_noise`, `quick_multioctave_noise`,
`variable_persistence_multioctave_noise`, their two Lua wrappers,
`expression_in_range`, `multisample` and the four seed vars are all
**unchanged 2.1.11 -> 2.1.12**, to the last bit of every float.

**Two guards, because "everything matched" is exactly what a broken harness
also reports.**

1. **Controls.** The two fixtures already captured at 2.1.12
   (`oracle-multisample`, `oracle-seed-vars`) were re-sampled in the same run
   and had to reproduce. They did, 198/198. `oracle-seed-vars` also exercises
   the Space-Age path (`create_surface` on Vulcanus with the seed forced), so
   both harness modes are covered, not just the plain Nauvis one.
2. **The comparison discriminates.** Perturbing ONE stored value per fixture by
   one part in 1e12 and re-running the comparator flags **10 mismatches, one in
   each of the 10 fixtures** - so the 0/2648 above is a real result and not a
   comparison that silently compared nothing. Both numbers matter: 2648 values
   compared, 10/10 fixtures fail on a 1e-12 nudge.

Two things this does **not** cover, stated so nobody reads more into it:

- The `sigma`/`a`/`b` tables inside `basis-noise.seed123456.json` are binary-RE
  artefacts, not oracle-samplable. What was re-captured is that fixture's 512
  sampled values; the tables stay pinned only indirectly, through them.
- One expression per fixture group at one seed is not the whole op. The
  parameter sweeps the original captures chose (octave counts, non-power-of-2
  persistence, large `offset_x`, odd seeds, seed1 >= 256) are wide, but they are
  still a sample.

Eight fixtures therefore move to `factorioVersion: 2.1.12` in `PROVENANCE.json`
with evidence describing the fresh capture, per "Recording the outcome" below.
This is a real re-capture, not a re-dating on the strength of a clean diff: the
game was run and the bytes were compared. The fixture files themselves are
untouched - the re-sampled values were identical, so there was nothing to
rewrite, and their `_comment` fields still record the original 2.1.11 capture.

Worth noting for anyone repeating this: `oracle-basis` was already being
re-sampled live on every `pnpm vp test` run on a machine with Factorio (the
gated `it.skipIf(!oracleAvailable())` case in `test/oracle/oracle.spec.ts`
asserts exact equality). That one fixture had a standing guard; the other seven
had none, which is why they needed this.

### What changed as a result

- `SUPPORTED_VERSIONS` accepts `2.1.12.2`; new fixture + spec.
- The UI now shows the targeted Factorio version, because the reason this bug
  survived three patch releases is that **nothing in the app said which format it
  spoke**. Both values are derived (target from `PROVENANCE.json`, formats from
  the decoder) and pinned by `test/factorioTarget.spec.ts`, so they cannot rot the
  way the hardcoded `2.1.9.3` did.
- No fixture was re-captured **on 2026-07-28**, because none needed to be. The
  2026-07-29 follow-up did re-capture the eight 2.1.11 noise-primitive fixtures
  against the binary (see the section above) - they were bit-identical, so only
  their `PROVENANCE.json` entries changed, not the fixtures.

### The lesson, which is not the one the issue expected

The issue framed this as "turn 38 stale fixtures into N that need re-capturing".
The answer to that question is **zero**. The value was entirely in the check the
procedure told you to do *first* and almost as an aside - verify the format tag -
which found a shipped, user-facing bug that no fixture staleness would ever have
revealed. Version-skew audits are worth running even when the fixtures turn out
fine.

## Re-run 2026-08-10: the binary reached 2.1.14, and the data half clears again

Steam moved the binary to **2.1.14** on 2026-08-10 (mtime 14:29), so
`pnpm refs:sync --check` reports drift against `factorio-data` and the API docs,
both pinned at 2.1.12. The data-governed half of this audit was re-run **without
repinning anything**, because the question only needs the tags:

```bash
git -C ~/GitHub/factorio-data fetch --tags -q origin
git -C ~/GitHub/factorio-data diff --stat 2.1.12 2.1.14 -- \
  core/prototypes/noise-programs.lua core/prototypes/noise-functions.lua \
  base/prototypes/noise-expressions.lua core/lualib/resource-autoplace.lua \
  base/prototypes/entity/resources.lua base/prototypes/entity/trees.lua \
  base/prototypes/entity/enemies.lua
```

**Result: one file changed, and its change is inert for map generation.**
Everything else in that set is byte-identical 2.1.12 -> 2.1.14.
`base/prototypes/entity/enemies.lua` is 8 insertions / 8 deletions, and every one
of the 16 lines is a `buildable_entities` list - which governs enemy **expansion**
(what a unit may build once the game is running), not autoplace. Nothing named
`autoplace`, `map_generator_bounding_box` or `probability_expression` is touched;
`grep -iE '^[+-].*(autoplace|map_generator_bounding_box|probability_expression)'`
over that diff returns nothing.

So **no fixture needs re-capturing for the 2.1.14 bump**, by the same rule this
document already sets out. That is the third consecutive time the answer has been
zero, which is worth saying plainly: the data half of this audit is cheap and keeps
coming back clean, and the expensive half - the noise primitives, which no data diff
can ever clear - has not been re-sampled against 2.1.14. Only `oracle-basis` carries
a standing re-sample guard.

**The useful part was again a side effect, not the fixtures.** The tag diff was run
while pinning `AutoplaceSpecification::placement_density` for #22 item 5, and its
value there was proving that the "no entity sets `placement_density`" result holds
at 2.1.14 and not merely at the 2.1.12 the local checkout happens to sit on. Reading
the reference material at a version the binary has moved past is the exact failure
this document exists to prevent; `git grep <pattern> <tag>` answers it without
touching the checkout.
