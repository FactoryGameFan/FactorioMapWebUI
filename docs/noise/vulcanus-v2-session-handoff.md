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
| 1. Capture the oracle fixture | **in fix round 1** - see below |
| 2. Resource levers on `EvalCtx` | pending |
| 3. Favorabilities + starting ore spots | pending |
| 4. Spot-noise wrapper + the four regions | pending |
| 5. Restore the tile coupling | pending |
| 6. Overlay catalog + renderer | pending |
| 7. Pipeline + panel wiring | pending |
| 8. Perf, notes, roadmap | pending |

Commits so far:

- `fe4f690` chore: git-ignore the superpowers SDD scratch directory
- `8f69c1e` test(vulcanus): capture V2 resource oracle fixture (Task 1, being amended)

## The open issue (Task 1, fix round 1)

The captured fixture is real and the capture code is correct, but its **probe
positions never land in ore**. The 61 positions were inherited from the
`vulcanus-cracks` capture (a near grid plus rings at r=500/1500/3300 plus one
deep point); ore patches are ~25-30 tiles in radius and sparse.

Measured over the committed fixture:

| Region | points with `region > 0` | cone-attributable points |
| --- | --- | --- |
| tungsten | 0 | **0** (max is exactly `-1.0`, the `basement_value`) |
| coal | 0 | 2 |
| calcite | 0 | 3 |
| sulfur | 0 | 2 |

("cone-attributable" = `region > -0.999` **and** not equal to that resource's
`starting_*` term, i.e. the spot cone is genuinely visible.)

So Task 4 could implement the entire spot-selection machinery as `() => -1`, and
`metalTile` as `() => 0`, and every assertion built on this fixture would still
pass. That is precisely the half of the port the plan flags as risky.

**The fix in flight:** keep all 61 original positions and their order (they carry
the favorability, starting-spot and far-field f32 coverage), append a 32x32 scan
grid at 137-tile stride offset `(+0.5, +0.25)` - 1085 positions total - and
re-capture. Acceptance: every region must show at least one point with
`region > 0` and roughly 20 cone-attributable points. If two widening attempts
still leave a region with no positive point, the implementer reports back rather
than iterating.

Re-run the coverage check after any re-capture:

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

- Non-default frequency sliders produce a fractional `region_size`
  (`500 + 500/f`), which the port floors. Only `f = 1` is oracle-covered. First
  thing to check if a non-default-frequency preset renders wrong.
