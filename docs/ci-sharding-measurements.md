# CI sharding - the measurement record

Every CI timing measurement behind the current four-shard layout, lifted
verbatim out of `CLAUDE.md` at commit `57d3fb3` on 2026-08-25. It moved because
that section had grown to 22,384 characters inside a `CLAUDE.md` that was 29k
over Claude Code's 150k limit, and most of its length is the story of how a
number moved rather than a rule anyone needs at the keyboard.

**`CLAUDE.md` still carries the conclusions and the traps.** What lives here is
the evidence: the N=3 through N=6 comparison, the per-run shard tables from
#202, #203, #207 and #208, the three reasons splitting a heavy spec file was
rejected, and the `rust` job's own cost history.

The single most durable thing in here is that **a single CI run measures the
runner at least as much as it measures the suite** - identical spec files came
in anywhere from 294s to 469s. Do not tune on one run.

Nothing below has been edited. It is a snapshot, so it goes stale as the suite
grows; `CLAUDE.md` is the current state and this is the paper trail.

---

Two more things about that job, both measured on its first run (#230):

- **It WAS 19s and is not any more.** On its first run (#230) it was 19s, of
  which `scripts/verify-rust.sh` was 2s, the pinned-toolchain sync 10s and
  cargo-deny 1s, and it was the cheapest job in the workflow. #225's cliff half
  ended that: `the_apply_stage_beats_the_crossing_stage_on_three_counts_and_
loses_on_none` is 33s in the normal arm and **93s under poison**, taking the
  script alone to **1m50s** locally. Poison is the expensive half because
  `crossing_result` turns every lattice edge into a crossing, so far more cells
  place and the `onDestroy` cascade recurses over a dense set.

  It is kept because it is the ONLY grading of `cliffs::connections`, a
  445-line module on no render path - without it that port would have unit tests
  and no measurement against anything. It is still far under the test shards, so
  it does not move the gate wall; it is simply no longer free. Anyone adding a
  second fixture test of that shape should re-measure this job first.

  **#225's third part re-measured it and did not move it: 110.8s warm against
  the 1m50s above.** That is one run against a figure recorded in another
  session, so read it as "no measurable movement" rather than as a delta. It
  stayed flat because the rock and resource overlays deliberately did NOT get a
  test of that shape - the game's ground truth for the placement roll is a count
  per 512x512 region, ~33s each in a debug build, and that grading lives on the
  TypeScript side instead. See the phase-5 notes below for the reasoning.

  **Treat this job's cost as a RANGE, not a number: roughly 1m45s to 2m50s.**
  Three CI runs on code whose Rust half was equivalent between them came in at
  **1m44s (#310), 2m48s (an earlier run) and 2m49s (#312)** - and #312's run
  landed a second ABOVE the "1m44s to 2m48s" this paragraph first claimed, which
  is the paragraph's own point arriving immediately. Endpoints stated to the
  second invite exactly the chasing this warns against, so the figure is rounded. That is the same spread the
  test shards show (`one-ci-run-measures-the-runner` - identical spec files came
  in anywhere from 294s to 469s), and the honest response is to widen the figure
  rather than to replace it: a single run here measures the runner at least as
  much as the job. Do not "correct" this to whichever number you last saw. If a
  change to the Rust really does move this job, show it with more than one run.

- **It runs `bash scripts/verify-rust.sh` directly**, the one deviation from
  "the YAML names only package.json scripts". That does not reopen the drift
  the rule guards against, because `verify:rust` _is_ that one line, so the
  script file stays the single definition. Going through pnpm would add
  action-setup, setup-node and a full install (~28s) to a job that needs no
  JavaScript. If `verify:rust` ever grows a second command, the job must become
  `pnpm run verify:rust` with the setup steps restored.

Measured result: **9m03s -> 4m36s** at the time (2026-08-03, N=3, 171 spec
files). Do not read that as the current number: the suite has since grown to 201
files, which put N=3 back up to ~8m and is why the shard count moved to 4 - see
the shard table below.

**The anti-drift rule still holds, by a different mechanism.** The point of
"verbatim" was that there is exactly one definition of "this repo is
consistent". That is now enforced by the workflow naming only package.json
**scripts** - never the underlying commands - and by `verify`, `verify:static`
and `verify:shard` all composing the same `verify:lint`. Do not inline
`vp check` or `vue-tsc` into the YAML; add or edit a script instead.

**Two traps in that file, both of which look like tidying:**

- **The job named `verify` does no work, and must keep that name.** Ruleset `EJ`
  requires a status check called `verify`; a required check that never appears
  blocks every PR _forever_, on a check that cannot run. Renaming that job needs
  a ruleset PUT in the same change - see the two-step below.
- **It asserts `needs.*.result` explicitly rather than relying on `needs:`.**
  A job whose dependency _failed_ is **skipped**, and a skipped required check
  does not block a merge. Deleting those assertions would make a red suite
  mergeable. `if: ${{ !cancelled() }}` rather than `always()` is also
  deliberate: a superseded push should stay cancelled, not become a failure.

**Why FOUR shards and not three, and why local measurement said the opposite**
(#119, settled on CI 2026-08-10). This section used to argue for three, on the
grounds that `test/previewAgreement.spec.ts` was 67s of the 68s local suite and
therefore an unsplittable floor no shard count could beat. Local slowest-shard
wall was 55.7s at N=3 against 53.5s at N=4 - inside noise, for 33% more runner
minutes. That measurement was correct and its conclusion did not transfer: a dev
box has 12 cores and a runner has 4, so locally the CPU term is absorbed and only
the file floor is left visible.

One CI run, all four arms concurrently on the same runner pool (18 jobs), so the
comparison is within-run rather than against a different hour:

| N   | test-step walls (s)           | slowest job | runner-s |
| --- | ----------------------------- | ----------- | -------- |
| 3   | 452 / 356 / 102               | 488s        | 995      |
| 4   | 306 / 291 / 291 / 72          | **333s**    | 1071     |
| 5   | 311 / 213 / 174 / 74 / 67     | 343s        | 989      |
| 6   | 314 / 224 / 162 / 140 / 61/51 | 344s        | 1119     |

N=4 is **-155s of gate wall (-32%)** for **+7.6% runner-seconds**, not the +33%
the local numbers implied - total CPU is flat across arms and the only thing an
extra job adds is ~28s of checkout+install. N=5 and N=6 do not improve on N=4
(+5s and +8s, noise), so 4 is the point of diminishing return.

**The floor is no longer that one file, and the old premise expired rather than
being wrong.** The slowest N=6 shard (33 files, 314s) does **not contain**
`previewAgreement.spec.ts` - checked by running that exact shard locally, not
inferred. The suite grew **171 -> 201 spec files** through the #84 cliff work,
and `previewAgreement.spec.ts` is now **72.9s of 503s** of total per-file wall
(14.5%), with **ten** files over 20s (`vulcanusCliffRejectionStage` 52.1s,
`vulcanusStackCache` 47.8s, `cliffOreCascade` 30.1s, `entityDensity` 29.9s,
`vulcanusCliffBands` 28.4s, ...). So "split previewAgreement into its three
tests" is no longer the prerequisite for further sharding gain that #119
assumed; the binding shard is whichever one vitest's hash-split loads with
several heavy files, and **balance**, not count, is the remaining lever. Nobody
should raise N again without re-measuring **on CI** - and note this whole
paragraph has a shelf life, because it is a statement about the suite's current
file-weight distribution.

**Re-measured on CI 2026-08-14, after the Fulgora scrap work (#202).** That
branch added three 1024x1024 comparisons to `previewAgreement.spec.ts`, which
the scrap spec had flagged in advance as a shard-balance risk. The four shard
**jobs** came in at **259 / 351 / 389 / 133 seconds**, so the binding shard is
**389s against the 333s** in the table above - **+56s of gate wall, +17%**.

Two things that measurement settles:

- **The cost of those comparisons is real but modest**, and it was paid
  deliberately: they are what caught a rounding bug that had been wrong in
  shipped Fulgora terrain since V1 (`Math.round` where the game truncates,
  worth 35 percentage points of whole-image agreement).
- **Balance is still the lever, and the spread widened to 3x** - 389s against
  133s on the lightest shard. Raising N does not help: #119 measured N=5 and
  N=6 at +5s and +8s against N=4, inside noise, for more runner-minutes.

**The split this section used to recommend was measured on 2026-08-15 (#203),
and it is NOT the move.** The text here said splitting `previewAgreement.spec.ts`
into separate files "targets that spread directly". Three measurements say
otherwise, and all three are things the file-level timings above cannot show:

- **Hash-sharding does not let you balance anything on purpose.** Vitest shards
  by sha1 of each spec's path, sorted, then sliced into N contiguous chunks.
  Reimplementing that against this run's four logs reproduces **209 of the 210
  file placements** (the one miss is a single file at the shard 3/4 boundary,
  where the slice arithmetic differs by one), so it predicts where a file lands
  but not which side of a boundary a near-boundary file falls. Run it on a
  split into four natural per-planet names and two of the four parts collide in
  the same shard, putting the binding shard around **415s against the 366s it
  was**. Treat that number as a projection, not a measurement - the placements
  are solid, the per-part costs are estimates. The durable point needs neither:
  adding any spec file changes the count and re-slices every shard, so names
  picked to spread today do not stay spread.
- **Import time is a first-order cost, not overhead.** Shard 3 spent **332s
  importing against 260s running tests**. `isolate: true` is required here (see
  above), so each spec file gets a fresh module registry and re-imports the
  whole noise graph. Turning one file into four adds three more of those.
- **The binding shard is not bound by one file.** Shard 1 pairs
  `previewAgreement.spec.ts` (298s) with `vulcanusCliffRejectionStage.spec.ts`
  (205s) - **503s of that shard's 653s sitting on 2 of its 4 workers**. Moving
  one of them elsewhere leaves the other behind.

**And the runner noise is bigger than the effect anyone is trying to tune.**
#202's run and #203's run have the **same 210 spec files**, so vitest hands
them identical shards. The jobs still came in at **259 / 351 / 389 / 133**
against **366 / 273 / 327 / 137** - shard 1 up 41%, shard 3 down 16%, and the
binding shard changed identity from 3 to 1. Any rebalancing worth doing has to
beat that, and a single run cannot show that it did.

**Re-measured on CI 2026-08-15 after the Fulgora island finder (#207) - three
runs over the SAME 218 spec files, and they disagree by more than the effect
anyone would want to read out of them.** #207 and both runs of #208 (docs-only,
so identical spec files and identical shard assignment):

| run               | shards (s)            | binding |
| ----------------- | --------------------- | ------- |
| #207              | 391 / 378 / 469 / 400 | 469     |
| #208 first        | 248 / 269 / 259 / 294 | **294** |
| #208 after a redo | 366 / 281 / 416 / 368 | 416     |

Range **294-469 on identical test code**, a 59% spread, against a recorded 389s
for #202. Two of the three sit above 389 and one sits well below it, so the
finder probably did add gate wall - but the noise is the same size as the thing
being measured, and no honest point estimate comes out of this.

Note how that table was built, because it is the cheapest way to get one: three
runs of the same tests arrived for free from one PR's normal life (open, amend,
push). If a number here matters, collect it that way rather than from whichever
run you happened to look at. The first draft of this very paragraph read
"+80s, +21%" off #207 alone, and the next run refuted it.

That is the #202/#203 lesson arriving a second time, and it should be the
default assumption now: a single CI run here measures the runner as much as the
suite. Do not tune on one.

What IS solid, because it was measured locally where the spread is small:
**`test/findIslands.spec.ts` is the new heaviest file at 134.6s**, taking the
crown from `previewAgreement.spec.ts`. Read that with its history - it was
**240.4s** when the branch's last fix landed, and four of its tests were then
cut to a small `refineCount` for identical coverage. Why it is expensive at all:
the finder re-renders a candidate at a doubled pad whenever its island mask
touches the window border, and refinement pays 16x the pixels of the coarse
pass. One test in that file **cannot** be cheapened the same way and its own
comment explains why, so do not "finish the job" by lowering its refine count.

So the gate wall stays where it is, and the thing that actually broke was a
**timeout, not the wall**. On #203 - a docs-only change - the unchanged
"Vulcanus rock and cliff coverage" test hit its 120s budget at 150.5s. Across
four consecutive runs the same code measured **69.6s, 90.1s, 108.8s and
150.5s**, so run-to-run spread on a 4-core runner is about 40%, and main itself
had passed at 108.8s with 10% to spare. That file's budget is now 300s, with
the table in its own header comment. The green re-run measured that same test
at **139.7s**, which is the row that matters: given room it finishes, and it
finishes above 120s rather than just under, so the old ceiling was genuinely
too small and the new one is not hiding anything. Note what this means for the next heavy
test: the ceiling is per-test and hand-written, so a shard rebalance moves which
tests are near it.
