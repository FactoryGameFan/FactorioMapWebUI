# Vulcanus V2 (resources) - session handoff

**Maintained live during the V2 build.** Update the Status table and the
"Where we are" section at each task boundary. Mirrors the convention of
`docs/noise/M3-session-handoff.md`.

Last updated: 2026-07-24, during Task 1 fix round 1.

## What V2 is

Port Vulcanus's three solid ore patches (tungsten, calcite, coal) to the
client-side preview as an overlay, and restore the three resource-coupling terms
that V1 left stubbed in the tile catalog. The sulfuric-acid geyser's *field* is
computed (the tile catalog reads it) but its overlay is deferred to V3, because
it is a fluid rendered as scattered points rather than a solid patch.

## Read these first - authoritative, do not re-derive

| Path | What it holds |
| --- | --- |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/superpowers/specs/2026-07-24-vulcanus-v2-resources-design.md` | The approved design: scope, the two approximations, architecture, verification bar |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/superpowers/plans/2026-07-24-vulcanus-v2-resources.md` | The 8-task implementation plan, with the code to write in each task |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/.superpowers/sdd/2026-07-24-vulcanus-v2-resources/progress.md` | The SDD ledger - **the recovery map**. Task N is done only if it has a `Task N: complete` line |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/noise/vulcanus-tiles-NOTES.md` | V1's tile catalog + the three stubs V2 removes |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/noise/spot-noise-NOTES.md` | The solved spot_noise RNG + selection phase that V2 builds on |
| `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/noise/random-penalty-NOTES.md` | Why `random_penalty` is a batch op and cannot be reproduced per-pixel |

The ledger is gitignored scratch. If `git clean -fdx` has wiped it, rebuild from
`git log` and this file.

## Where we are

Branch **`feat/vulcanus-v2-resources`**, branched from `a0ea049` on `main`.
Nothing pushed. Execution is via `superpowers:subagent-driven-development`:
one fresh implementer subagent per task, a task review after each.

| Task | Status |
| --- | --- |
| 1. Capture the oracle fixture | **complete** (`9369cf6`, review clean, 1 fix round) |
| 2. Resource levers on `EvalCtx` | **complete** (`ba50dba`, review clean, 0 findings) |
| 3. Favorabilities + starting ore spots | **complete** (`614edec`, review clean) |
| 4. Spot-noise wrapper + the four regions | **complete** (`c06db88`, 1 fix round) |
| 5. Restore the tile coupling | next |
| 6. Overlay catalog + renderer | pending |
| 7. Pipeline + panel wiring | pending |
| 8. Perf, notes, roadmap | pending |

Commits so far:

- `fe4f690` chore: git-ignore the superpowers SDD scratch directory
- `8f69c1e` + `9369cf6` Task 1, the oracle fixture (second commit widened the grid)
- `a0178a2` this handoff doc
- `a197761` docs: the measured `random_penalty` envelope (see below)
- `ba50dba` Task 2, `EvalCtx` levers
- `614edec` Task 3, favorabilities + starting spots
- `201d475` + `c06db88` Task 4, spot-noise wrapper + regions (second commit fixed comments)

## Accuracy of the port, measured

Worst absolute residual against the game, over all 1085 fixture points:

| Expression | worst | note |
| --- | --- | --- |
| tungstenRegion | 1.79e-5 | median 2.95e-8 |
| calciteRegion | 1.66e-4 | median exactly 0 - over half bit-exact |
| the 8 Task 3 expressions | 3.2e-4 | startingSulfur is the worst |
| sulfuricAcidPatches | 2.92e-3 | see the coordinate-representability note below |

**`spotSelection.ts` needed no change.** The plan's main open worry was that
driving Factorio's favorability-sorted trim with a discriminating (0/1)
favorability for the first time would expose a bug in that shared primitive. It
did not.

**Why `sulfuricAcidPatches` is 10x everything else, and why that is fine.** Split
the fixture by whether a position's coordinates are exactly representable: over
the 1063 representable positions (including all 1024 dense-grid points) the worst
residual is **1.69e-4**. Every one of the top 10 residuals is among the 22 ring
positions with irrational coordinates, with a uniform implied positional offset of
2.3e-3 to 3.7e-3 tiles - the game evaluated at a marginally different coordinate
than we do. `input_scale = 1/3` makes this the highest-frequency multioctave in
the port, about 1.7x outside the primitive's oracle-verified envelope (those cases
top out at 0.2), so the same offset is invisible in every other field. Model error
was ruled out directly: f32-rounding the composed octave coordinates moves the
value only ~1e-4.

## Task 1 history - two findings worth carrying forward

**(a) The first capture could not see ore** (fixed in `9369cf6`). Its 61 probe
positions were inherited from the `vulcanus-cracks` capture, and ore patches are
~25-30 tiles in radius and sparse, so no probe landed in one: zero positive
regions, and `tungstenRegion`'s max was exactly `-1.0` (the `basement_value`).
Task 4 could have implemented the whole spot-selection machinery as `() => -1`
and still passed. Fixed by keeping the 61 originals in order and appending a
1024-point 32x32 scan grid at 137-tile stride (prime, so coprime with the
400/450/1000 `region_size`s). Final coverage:

| Region | `region > 0` | cone-attributable |
| --- | --- | --- |
| tungsten | 8 | 29 |
| coal | 4 | 29 |
| calcite | 11 | 63 |
| sulfur | 5 | 37 |

("cone-attributable" = `region > -0.999` **and** not equal to that resource's
`starting_*` term, i.e. the spot cone is genuinely visible.)

**(b) `random_penalty -> 1` is looser than the design spec first claimed.** The
oracle shows `vulcanus_metal_tile != max(0, 1000 * tungstenRegion)`: worst
divergence **132.86** (idx 341, region 0.4387, oracle 305.84), and at small
regions it flips placement outright (idx 733/769 have `region > 0` but
`metal_tile == 0`). Implied `p` over the eight `region > 0` points spans
**[0.9077, 0.9748]**; zero of 1085 points violate `p in [0.9, 1]`.

Consequences, both already written into the spec and the plan:

- `rp = 1` is an **upper bound**, not an equality - our footprint is the largest
  the game could produce, never smaller.
- Task 4 verifies `metal_tile` against the `p in [0.9, 1]` **envelope** rather
  than an absolute tolerance (the plan's original tolerance of 4 was ~30x too
  tight). User ruled on this 2026-07-24.
- **Task 5's `get_tile` parity may be capped below 100%** by edge-of-patch tiles
  where the game rolled a low `p`. The plan's stop condition is still "agreement
  must go UP" - do not chase 100%, and do not relax the bound.

Coverage check to re-run after any re-capture:

```bash
node -e "
const f=require('./test/fixtures/oracle-vulcanus-resources.seed123456.json');
const pairs=[['tungstenRegion','startingTungsten'],['coalRegion','startingCoal'],
             ['calciteRegion','startingCalcite'],['sulfuricAcidRegion','startingSulfur']];
for(const [r,s] of pairs){const R=f[r],S=f[s];
  let pos=0,cone=0;
  for(let i=0;i<R.length;i++){ if(R[i]>0) pos++;
    if(R[i]>-0.999 && Math.abs(R[i]-S[i])>1e-9) cone++; }
  console.log(r.padEnd(20),'positive:',pos,' cone-attributable:',cone);}
"
```

## Decisions already made - do not relitigate

- **Scope:** three solid ores. The geyser overlay is V3; its region field is
  still computed here because `volcanic_soil_light_range` reads it.
- **All three coupling terms restored**, including
  `vulcanus_sulfuric_acid_region_patchy`.
- **`random_penalty_between(0.9, 1, 1)` is approximated as 1.** It is a batch op;
  the Nauvis M3.5 stipple work was deferred for the same reason. At `rp = 1` the
  probability collapses to `1000 * region`.
- **Richness is not ported.** The preview renders placement, not yield.
- **Verification bar:** oracle-sample every new expression to the f32 floor, plus
  re-run the `get_tile` parity harness. No entity-level `find_entities` check.
- **Workspace:** feature branch in place, no worktree (user's choice).

## Gotchas a cold start will trip on

- **The oracle binary is Factorio 2.1.12**, not 2.1.11. The six game-data files
  this port reads are byte-identical between tags 2.1.11 and 2.1.12 (verified),
  so `git -C ~/GitHub/factorio-data checkout 2.1.11` is still fine - but fixture
  `_comment` strings should say 2.1.12.
- **Never edit a fixture or an expected value to make a test pass.** Standing
  repo rule. A mismatch is a real finding.
- **Task 5 has a hard stop condition.** `test/vulcanusTiles.spec.ts` currently
  measures 96.85% (369/381) against `get_tile`, and its own comment blames the
  three V2 stubs. If restoring the coupling does not raise that number, the
  coupling port is wrong - report it, do not relax the bound, do not proceed.
- **Task 4 residuals may be a `selectSpots` bug, not a Vulcanus bug.** Nauvis
  passes a constant favorability, so `selectSpots`' favorability-sorted trim has
  never run with a discriminating (0/1) favorability. Fix it in `selectSpots` and
  re-run the full suite (it is shared with Nauvis M3), do not special-case it.
- **The wobbled sample position selects the region.** `vulcanus_spot_noise`
  samples at `(x + resource_wobble_x, y + resource_wobble_y)`; using the raw
  coordinate for region lookup yields a plausible-looking but wrong field.
- Run `vp` through pnpm (`pnpm vp test`); a bare `vp` fails with `EBADDEVENGINES`.
- Full gate is `pnpm run verify`. The oracle capture is manual and needs a local
  Factorio + Space Age install.
- Hyphens, never em/en dashes, in all files.
- Nothing has been pushed. Do not push without asking.

## Untested / known-thin areas to carry forward

**Task 8 must write these into `docs/noise/vulcanus-resources-NOTES.md`.**
`src/noise/expressions/vulcanusResources.ts:231` already forward-references that
file, and the `region_size` caveat is currently documented *only* in that dangling
comment.

- **Non-default frequency sliders** produce a fractional `region_size`
  (`base + base/f`), which the port floors. Only `f = 1` is oracle-covered. First
  thing to check if a non-default-frequency preset renders wrong.
- **Near-spawn starting ore patches are unverified.** No fixture point has a
  `starting_*` value above about -0.5, so the "inside the spot" regime is
  untested. Judged acceptable rather than worth another capture round:
  `startingSpotAtAngle` is a single branch-free linear-in-distance expression,
  already pinned by 1085 points spanning -700 to -0.5, so no code path activates
  only near the centre. Contrast with the Task 1 gap, where the spot machinery
  genuinely never ran.
- **The `min(maximum_spot_basement_radius, radius)` cap is omitted** from the cone
  radius. Unreachable at any legal slider (`sliderRescale(v, 2)` maxes at 2, so
  radius <= 2 * 1.2 * 25 = 60 < 128). Deliberate - do not "fix" it.
- `distanceAt` in `vulcanusResources.ts` duplicates the one in
  `vulcanusBiomes.ts:124`. Correct, just a second single-slot cache.
