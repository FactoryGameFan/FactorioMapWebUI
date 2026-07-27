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

Every path below was confirmed to exist at tag 2.1.12. Diff only the files that
govern the fixtures you care about - a whole-tree diff is mostly translation
strings and unrelated prototypes.

| Fixture group                                                | Governed by                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `oracle-basis`, `oracle-multioctave*`, `oracle-quick-*`, `oracle-variable-persistence-*` | `core/prototypes/noise-functions.lua`, `core/prototypes/noise-programs.lua` |
| `oracle-elevation-*`, `oracle-cliff*`, `oracle-cliffiness`   | `core/prototypes/noise-programs.lua`, cliff prototypes under `base/prototypes/entity/` |
| `oracle-resource-regular`, `oracle-resource-starting`, `oracle-random-penalty` | `core/lualib/resource-autoplace.lua`, `base/prototypes/entity/resources.lua` |
| `oracle-aux`, `oracle-moisture`, `oracle-temperature`, `oracle-tile-names.*` | `base/prototypes/tile/tiles.lua`                                          |
| `oracle-enemy-base`                                          | `base/prototypes/entity/enemy-autoplace-utils.lua`                        |
| `oracle-trees*`, `oracle-rock-density`                       | `base/prototypes/entity/trees.lua`, rock/resource prototypes              |
| `oracle-vulcanus-*`                                          | `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`                 |
| `builtin-presets.json`, `map-*.dump.json` (2.1.9)            | none of the above - these are **codec** fixtures, see the note below      |

## The commands

The 33 fixtures captured on 2.1.11 are the bulk of the exposure, so start there:

```bash
D=~/GitHub/factorio-data

# The highest-value diff: everything the noise ports read, 2.1.11 -> 2.1.12
git -C $D diff --stat 2.1.11 2.1.12 -- \
  core/prototypes/noise-functions.lua \
  core/prototypes/noise-programs.lua \
  core/lualib/resource-autoplace.lua \
  base/prototypes/entity/resources.lua \
  base/prototypes/tile/tiles.lua \
  base/prototypes/entity/enemy-autoplace-utils.lua \
  base/prototypes/entity/trees.lua

# Then the wider net for the 5 codec-era fixtures
git -C $D diff --stat 2.1.9 2.1.12 -- core/ base/prototypes/
```

An empty `--stat` for a path is a real answer: that subsystem did not move, and
every fixture it governs can be re-dated rather than re-captured. Drop `--stat`
to read the hunks for anything that did move.

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
