# random_penalty - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962). Solved 2026-07-19 by disassembling the
non-stripped shipped executable (`NoiseOperations::RandomPenalty::run`,
`RandomPenalty.cpp`) and confirming against the headless oracle. Companion to
`basis-noise-NOTES.md` and `spot-noise-NOTES.md`; `random_penalty` is the same RNG
family (canonical L'Ecuyer taus88, base `0x3FBE2C`, primes 7919/7907, the 341
clamp).

Implementation: `src/noise/randomPenalty.ts`. Fixture:
`test/fixtures/oracle-random-penalty.seed123456.json`. Spec: `test/randomPenalty.spec.ts`.

## The primitive

`random_penalty{x, y, seed, source, amplitude}` subtracts a per-draw uniform
penalty from `source`:

```
output = source - amplitude * U          # U = taus88_output / 2^32,  U in [0,1)
```

Wrappers (`core/prototypes/noise-functions.lua`):

- `random_penalty_at(v, seed)` = `random_penalty{source = v, amplitude = v}`
- `random_penalty_between(from, to, seed)` = `random_penalty{source = to, amplitude = to - from}`
  (so the result lies in `[from, to]`)
- `random_penalty_inverse(seed, penalty)` = `random_penalty{source = 1, amplitude = 1/penalty}`
- `1 - random_penalty{... source = 1 ...}` appears directly too.

## It is a BATCH op (the important, non-obvious part)

`run(NoiseCache&)` evaluates a whole batch of query positions at once, and the RNG
state is **not** re-derived per tile:

1. **Seeded once, from the FIRST position in the batch:**

   ```
   word = max(341, 0x3FBE2C + 7919 * trunc(x0) + 7907 * trunc(y0 + seed))     (u32)
   ```

   - `x0, y0` are the coordinates of `positions[0]` only.
   - `trunc` is `fcvtzs` (truncate toward zero). `seed` (a constant) is folded into
     `y` (`y0 + seed`) *before* truncation.
   - **No `map_seed` dependence** - unlike `basis_noise`/`spot_noise`, there is no
     `seed0` XOR. Confirmed: varying the map seed leaves the values unchanged.
   - taus88 state `s1 = s2 = s3 = word` (the shared `src/noise/taus88.ts`).

2. **Streamed across the batch, LAST element to FIRST.** The op's loop index counts
   down, so `positions[N-1]` gets taus draw 0 and `positions[0]` gets the last draw.

3. **`source <= 0` passes through and consumes NO draw** (the documented "source
   must be > 0"). The tile outputs its `source` unchanged and the stream does not
   advance for it.

Because of (1) and (2), the value at a given `(x, y)` depends on the entire batch
and its order. A bare `calculate_tile_properties` probe of `random_penalty` is
therefore **not** a faithful per-tile oracle in isolation (same lesson as M2's
`get_tile` vs `calculate_tile_properties`): the oracle returns whatever the batch
produced, seeded from the batch's first point. The RE'd model reproduces measured
oracle batches exactly (3 batches + 2 singletons, plus the committed 5-config
fixture, to the f32 floor).

## The disassembly

```
lldb -b -o "disassemble --name '_ZNK15NoiseOperations13RandomPenalty3runER10NoiseCache'" "$FACTORIO_BIN"
```

lldb disassembles by mangled symbol name and annotates source lines - the fastest
oracle here (objdump's `--start-address/--stop-address` are broken on this Mach-O,
as noted in `noise-oracle-basis-measurements`). Key instructions:

- `w24 = 0x3FBE2C`; `madd w9, x_int, #7919, w24`; `mul w10, y_int, #7907`;
  `add w9, w10, w9` - the word, primes matching spot_noise.
- `fadd s0, y, ucvtf(seed_const)` before `fcvtzs` - `seed` folded into `y`.
- `cmp w9, #0x155; csel w9, w9, #341, hi` - unsigned clamp to >= 341.
- `dup.2s v0, w9` + scalar `w9` - taus88 state seeded to the word (2 lanes + scalar).
- loop: `fcmp source, #0.0; b.ls skip` (source<=0 guard); taus88 update (the
  `eor/ushl/bfxil` block, params 13/19/12, 2/25/4, 3/11/17 - canonical taus88);
  `ucvtf` the u32 draw, `* -2^-32` (`mov x12, #-0x4210000000000000`), `* amplitude`
  (`[x19,#0x1c]`), `+ source`.
- Op register/constant layout: out `+0x8`, x `+0xc`, y `+0x10`, source `+0x14`,
  seed const `+0x18`, amplitude const `+0x1c` (matches `ComplexExpression<...,3,2,0>`:
  3 register inputs + 2 constants).

## Composition inside spot selection - RESOLVED (2026-07-19, M3a Task 4)

How the game batches `random_penalty` inside the spot expressions is now pinned
against the pure-regular oracle (`test/fixtures/oracle-resource-regular...`). For
`regular_spot_quantity_expression = random_penalty_between(0.25, 2, 1) * quantityBase`:

- The batch = **all skip-set accepted spots** of the region, in **acceptance order**
  (the order `generatePoints` produced them), evaluated as ONE `random_penalty`
  batch BEFORE the favorability sort/trim (matches the spot-noise NOTES order of
  operations: generatePoints -> skip set -> evaluate expressions -> sort -> place).
- So per `RandomPenalty::run`: the stream is seeded from the FIRST accepted spot and
  consumed last-spot-first across that batch. Each spot's `U` therefore depends on
  the whole spot list, NOT on the spot's own position (the "singleton per spot"
  guess was close - uranium cones ~2% off - but wrong; the batch form is right).

Implemented via a new `quantityBatch` option on `selectSpots`
(`src/noise/spotSelection.ts`) that evaluates the spot quantities over the skip set
at once; `src/noise/resources/regularPatches.ts` supplies it with
`randomPenaltyBatch(spots, ...)`. This dropped the oracle error from **3e-1 to
~2e-3**.

### The ~1e-3 residual - RESOLVED (2026-07-20): it was fastapprox `cbrt`, not the trim boundary

The residual that the batch fix left (worst ~4.8e-2 relative, ~3 units absolute) was
**not** an f32 instability at the trim boundary (no spot is kept/dropped differently).
It was a single, smooth mechanism found by instrumentation:

1. Decomposed each field value into `spotField + blobTerm`. Points that sit *exactly*
   on the basement constant (outside every cone - `spotField == basement`) still
   carried ~0.35-unit error, so the error there is entirely in the **blob term**, not
   the cone/trim path.
2. Ruled out `basement` (f32 == f64 to 9e-4) and `basisNoise` (f32-stable) as sources.
3. Isolated it to the `cbrt` in `regular_spot_height_typical` (which drives
   `regular_blob_amplitude`). The game's noise machine takes that cube root through its
   **fastapprox `pow`** (Paul Mineiro `fastlog2`/`fastpow2`, the same pair
   `multioctave_noise`'s normalisation uses), not an exact `cbrt`. Exact `Math.cbrt`
   is ~7e-5 relative high, and it multiplies a large blob-amplitude scalar (~1800), so
   it shows up as ~0.3-0.7 units on blob values of thousands.

The same fastapprox `cbrt` + f32 arithmetic applies to the **cone render** (a
`spot_noise` op, evaluated per tile in the f32 machine): `radius = min(32, rq *
fastCbrt(quantity))`, `peak = 3q/(pi r^2)`, `cone = peak - sqrt(d2)*(peak/radius)` -
all f32.

Fix (2026-07-20): extracted the fastapprox primitives to `src/noise/fastApprox.ts`
(added `fastCbrt`); routed `regularSpotHeightTypicalAt` / `startingBlobAmplitude`
(resourceMath.ts) and the cone radius/peak/slope + spot quantity (regularPatches.ts)
through it in f32. Result across the pure-regular oracle (iron + uranium, 2 seeds,
4105 pts each): **absolute error < 0.7 units everywhere**, relative < 1e-3 across
patch interiors, up to ~9e-3 only at cone-edge / basement zero-crossings (the same f32
floor M1 elevation_lakes = 7.4e-3 and Island = 6.66e-3 documented). `test/regularPatches.spec.ts`
is now **un-skipped**, asserting `worstAbs < 1.0 && worstRel < 1e-2`.

## The noise-evaluation path (crude oil) - the batch extent DOES NOT MATTER for density (2026-07-27, Task 8)

The section above pins the batch for the **spot-selection** path. Crude oil needs the
other one: `resource-autoplace.lua:103-105` multiplies oil's probability by a
`random_penalty` evaluated in the **noise-evaluation** path, over map-gen query tiles
rather than over a spot list.

```lua
local probability_expression = "clamp(var('" .. all_patches_name .. "'), 0, 1)"
if (params.random_probability or 1) < 1 then
  probability_expression = probability_expression
    .. "* random_penalty{x = x, y = y, source = 1, amplitude = 1 /" .. params.random_probability .. "}"
end
```

Oil's `random_probability = 1/48` (`base/prototypes/entity/resources.lua:271`) is the
only sub-1 value in the base resource catalog, so oil is the only resource this
touches.

**Task 8 was briefed to settle the batch extent, timeboxed, and to fall back to
dropping the factor if it could not. Neither branch was needed, because the question
turns out not to bear on what the port claims.** The argument is short:

- `source = 1` is a **constant and strictly positive**. The `source <= 0`
  pass-through - the one thing that makes stream consumption depend on the data -
  can never fire here. So *every* tile in the batch consumes exactly one taus88 draw.
- taus88's output is uniform on [0, 1). With one draw per tile unconditionally, each
  tile's `U` is marginally uniform **no matter where the batch starts or how long it
  is**.
- A density is a sum of per-tile marginals. It is therefore invariant to the batch
  decomposition. What the batch changes is *which* tile receives *which* draw - i.e.
  positions - and the placement port explicitly does not claim positions
  (`test/entityDensity.spec.ts`).

So oil uses the same batch-op stand-in the two spawner penalties use (a dedicated
`PLACEMENT_SALT.crudeOilPenalty` stream, Task 6): a deterministic, position-pure
uniform per tile. This is fallback **(b)-equivalent** - oil joins the density oracle -
without the RE the brief thought it required.

**The one case where this reasoning would fail is a batch of size 1**, where every
tile's `U` would be the *first* taus88 output from a word linear in `(x, y)`
(`0x3FBE2C + 7919x + 7907y`), and adjacent tiles could be strongly correlated rather
than independent. That is a real hazard for the argument, not a hypothetical: it is
precisely why "each tile draws once" is not by itself sufficient, and why the
singleton measurements in the section above were worth taking.

### Measured, against the game (seed 123456, Factorio 2.1.12)

| variant | region 0 `[0,0]-[512,512]` (game 8) | region 1 `[4096,...]` (game 0) |
| --- | --- | --- |
| old threshold footprint | 1234 | 248 |
| roll, no penalty factor | 118 | 0 |
| **roll + penalty (shipped)** | **7** | **0** |

### The factor is 96, not 48

The brief predicted the no-factor fallback would sit "~48x too high", from the
`1/48` in the prototype. That is wrong, and in two different ways at once:

- **Analytically the factor is 96.** `1 - 48U` is positive only for `U < 1/48`, and
  its mean *over that range* is 1/2, so `E[max(0, clamp * (1 - 48U))] = clamp / 96`.
  The `1/48` sets how *often* the penalty leaves anything, and a second factor of 2
  comes from how *much* it leaves. Confirmed against the field sums rather than left
  as algebra: over region 0, `sum(clamp)` is 1234.0 and `sum(penalised)` is 13.1
  against the predicted 1234/96 = 12.85.
- **But the ratio you would actually observe is neither 48 nor 96**, because the
  collision gate is not linear in density: gated, the no-factor roll places 118 and
  the penalised one 7, a ratio of ~17. Collision rejects a far larger share of the
  dense variant's hits than of the sparse one's.

So "48x" named a prototype constant and then attached it to three different
quantities that are not equal to each other. The lesson is the one this subsystem
keeps relearning - see `docs/noise/vulcanus-resources-NOTES.md` gap 4, where four
reasoned-not-measured numbers are collected.

### What is NOT settled

The batch extent itself. This section argues it is *irrelevant to density*, which is
all the port claims; it does not determine what the extent is. Anyone reaching for
tile-exact oil positions still has to do that RE, and the size-1 case above is where
they should start, because it is the one extent that would also invalidate the density
argument. `n = 8` in the only region with any oil is far too weak a denominator to
detect the difference from the outside - Poisson sigma on 8 is 2.83, so the measured
7-vs-8 would look identical under a mildly wrong model.
