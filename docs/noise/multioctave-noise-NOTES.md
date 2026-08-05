# multioctave_noise - reverse-engineering notes

Source: originally Factorio 2.1.11 (build 86962), cracked two ways at once - by
disassembling `Noise::multioctaveNoise` in the non-stripped shipped Mach-O (the
same binary that gave up `basis_noise` and `spot_noise`), and by fitting the
output of the committed oracle (`test/oracle/`). **Re-read 2026-08-05 against
2.1.12 (build 87038), which corrected the octave offset, the entry point and the
precision** - see the update banner below. Reference implementation:
`src/noise/multioctaveNoise.ts`. Fixture:
`test/fixtures/oracle-multioctave.seed123456.json`. Test:
`test/multioctaveNoise.spec.ts`. Companion to `basis-noise-NOTES.md` /
`spot-noise-NOTES.md`.

This covers the plain `multioctave_noise` (`NoiseOperations::MultioctaveNoise`,
one of the 14 built-in noise operations). The `variable_persistence_...`,
`quick_...` and `amplitude_corrected_...` relatives are separate ops built on the
same core - see "Still open" below.

## The result

```
multioctave(x, y) = SUM_{k=0}^{N-1} amp_k * basis( f32(k*OFFSET + f32(x*IS_k)) , f32(y*IS_k) )

  N       = ceil(octaves)
  P       = persistence
  IS_0    = input_scale          (noise units per world tile, finest octave)
  IS_k+1  = f32(IS_k * 1/2)
  OFFSET  = 17.17                (per-octave x shift in NOISE space; see below)
  amp_0   = f32( sqrt(f32ratio) * output_scale )   -- sqrt and the multiply in f64
  amp_k+1 = f32(amp_k * (1/P))
  f32ratio= f32( ((1/P)^2 - 1) / ( fastpow((1/P)^2, N) - 1 ) )    -- all f32
  basis   = basis_noise with tables from (seed0, seed1)  [basis-noise-NOTES.md]

and the sum itself accumulates in f32: out = f32(out + f32(amp_k * basis(...))).
```

**Updated 2026-08-05: `OFFSET` was `-1774.83` here and the arithmetic was f64.
Both were wrong, and they were wrong in a way that hid each other** - see "The
octave offset was an alias" below. Worst error against the committed oracle went
`1.170e-4 -> 7.153e-7` (164x), and f32-exact samples `12/266 -> 62/266`.

So: **N octaves of `basis_noise` that all share ONE `(seed0, seed1)`**. Each
octave halves the input scale (lacunarity 1/2), multiplies amplitude by `1/P`, and
shifts x by a fixed per-octave offset. The offset is the whole trick for
decorrelating same-seed octaves - it is the "'x' variables are shifted to avoid
'fractal similarity'" comment at the top of the game's noise programs, made
concrete. The sum is RMS-normalised by `norm` so its variance stays ~1 across
octave counts and persistence.

Verified to **7.2e-7 worst over all 266 oracle samples**, across octaves 1..6,
persistence 0.45..0.9, varied input/output scales and three seeds - and the error
no longer depends on distance from the origin, which is the tell that the old
"grows at extreme coordinates" behaviour was the aliased offset and not a floor.
The 7.2e-7 that remains is **`basisNoise`'s own f64 evaluation, not this
composition**: a single octave already carries it (2.4e-7, 10/38 exact at
`octaves = 1`), so there is nothing left to find here. See "What is left".

## FIVE entry points, and the oracle does not use the one first disassembled

`nm` turns up five multioctave symbols, not one, and the difference is not
cosmetic - it is the reason a correct-looking disassembly produced a wrong
constant. `NoiseOperations::MultioctaveNoise::run(NoiseCache&)` is what a compiled
noise program executes, and it dispatches three ways:

| condition | callee |
| --- | --- |
| `Noise::vectorMultioctaveNoiseImplementationId != 0` | **`Noise::fastVectorMultioctaveNoise`** (tail call) |
| that global is 0 | scalar `Noise::multioctaveNoise(float,float,...)`, once per point |
| a size precheck at `run+100` passes | scalar `Noise::multioctaveNoise`, once for the whole request |

That global is a runtime-selected implementation id, non-zero on arm64, so **the
vector routine is the live path and the scalar overload is a fallback.** The
original notes read the scalar overload. This is the same trap recorded in
`variable-persistence-multioctave-noise-NOTES.md` ("the norm branch in the
`float const*` overload is a different entry point; the register `run` path the
oracle uses has none") - two for two, so on any future op in this family, **find
which entry point `::run` dispatches to before reading a loop.**

## Why these pieces (the disassembly)

Read off `Noise::fastVectorMultioctaveNoise` (arm64, 2.1.12 build 87038). It is
an octave loop (`w28` counts up to `w27` = `ceil(octaves)`) wrapping an inner
per-point loop that fills two scratch arrays with the octave's coordinates, then
one call to the vector `Noise::noise(count, xs, ys, scale, amp, xOff, yOff, ...)`
per octave:

- **Same seed every octave.** The seed-bearing `Noise` object (`x23`) is passed
  unchanged into every `Noise::noise` call. Octaves decorrelate purely through the
  coordinate change, not through re-seeding.
- **Lacunarity 1/2.** The per-octave input-scale register is multiplied by `0.5`
  each pass (`fmov s14,#0.5 ; fmul s11,s11,s14`), **in f32**.
- **Amplitude `*= 1/P`.** The amplitude register is multiplied by `1/persistence`
  each pass (`s13 = 1/P`, `fmul s10,s13,s10`), **in f32**. `1/P` is an exact
  f32 reciprocal (`fdiv s13, #1.0, s12`).
- **`output_scale` is folded into the STARTING amplitude**, not applied to the
  finished sum - so it rides the f32 amplitude chain rather than scaling a
  completed f64 total.
- **The sum accumulates in f32, one octave at a time.** `run` `bzero`s the output
  buffer, and the vector `Noise::noise` ends each point with
  `ldr s25,[x5] ; fadd s24,s25,s24 ; str s24,[x5],#4` - i.e.
  `out[i] = out[i] + f32(amp * basis)`. There is no f64 accumulator.
- **A fractional octave count is legal**, and it scales the *frequency*, not the
  amplitude: `N = ceil(octaves)` (`frintp`) and the base input scale is multiplied
  by `clamp(fastExp2(N - octaves), 1.0, f32(1.99999))`. Exactly 1 for integral
  `octaves`, which is all the fixture covers; ported because the binary does it.
- **Per-octave x offset.** The x fed to `Noise::noise` is `k*C + f32(scaledX)`,
  where the add is done in double and `fcvt`-ed back to f32, `k` is the loop
  counter (starts 0, so octave 0 is unshifted), and `C` is the double immediate
  `0x40312b851eb851ec`, **which is exactly `17.17`**. There is no division by any
  parameter - the earlier reading of this line ("`(k*C)/param6`, C =
  `0x40312b8551ec1eb8` = 17.17000305") had the two `movk` halves transposed, which
  is what made the constant look like an ugly 8-digit number instead of a round
  decimal, and there is no `fdiv` in the loop at all. y is never shifted.
- **The normalisation, and its MIXED precision.** The branch is on `1/P`, not on
  `P`: `1/P == 1` takes a `1/sqrt(N)` path, `1/P == 0` skips normalisation
  entirely, and everything else computes
  `sqrt( ((1/P)^2 - 1) / ( exp2(log2((1/P)^2) * N) - 1 ) )` times `output_scale`.
  It is reached for *every* octave count including N = 1, where it is ~1 but
  carries a fastapprox wobble that a `return 1` shortcut would get measurably
  wrong. **The ratio is computed entirely in f32, then widened: `fcvt d0,s0 ;
  fsqrt d0 ; fmul d0,d1 ; fcvt s10,d0`** - so the `sqrt` and the `output_scale`
  multiply happen in f64 and the result is rounded once. Doing the whole
  expression in one precision is wrong in either direction. The `1/sqrt(N)` branch
  is likewise `(double)output_scale / sqrt((double)N)` narrowed to f32.
  The `(1/P^2)^N` power is done with the game's approximate `Math::log2` /
  `Math::exp2f` (Paul Mineiro fastapprox).

`Math::log2` and `Math::exp2f` disassemble to textbook Mineiro `fastlog2` /
`fastpow2`; reproduced as `fastLog2` / `fastPow2` in `src/noise/fastApprox.ts`.
Matching them is what closes the last ~1e-4 for non-power-of-two persistence -
with a real `pow` the normalisation is off by ~1e-4 (for `P = 1/2`, `(1/P)^2 = 4`
is a power of two and fastapprox is near-exact, which is why P = 0.5 sits at the
basis floor).

**Updated 2026-08-05, and the constants below CHANGED.** This paragraph used to
list them as the decimals read out of the 2.1.11 disassembly - `-124.22551`,
`-1.4980303`, `-1.7258799`, `0.35208874`, `121.2740575`, `27.7280233`,
`4.84252568`, `-1.49012907`. Commit `9b49ebb` (2026-08-04) rewrote both functions
to round after every `fadd`/`fmul`/`fdiv` as the binary does, instead of
evaluating the polynomial in double and rounding once at the end, and wrote the
coefficients as the **exact f32 values** of the 2.1.12 arm64 immediates:

| | `fastLog2` | `fastPow2` |
| --- | --- | --- |
| | `-124.22551727294922` | `121.27405548095703` |
| | `-1.4980303049087524` | `27.728023529052734` |
| | `-1.7258800268173218` | `4.842525482177734` |
| | `0.35208871960639954` | `-1.4901291131973267` |

The polynomial and its coefficients were already right; only the rounding was
wrong. It is worth ~1e-5 relative, which no tolerance-based fixture here can
resolve - it was forced by `voronoi_spot_noise` x `minkowski3`, the first thing
in the repo compared f32-EXACT (96/175 -> 175/175). See
`src/noise/fastApprox.ts`, which carries the immediate encodings, and
`docs/noise/voronoi-NOTES.md`.

**So the `norm uses fastapprox pow` row in the results table below predates that
change** - its `6.7e-5 -> 2.9e-6` was measured against the old
double-accumulating implementation and has not been re-run. It still supports the
claim it was made for (the normalisation goes through fastapprox rather than a
real `pow`, a ~20x effect); it is not a current measurement of the residual.

## How the constants were pinned (oracle fitting)

The disassembly gives the structure; the oracle nails the numbers. Method:

1. Route `multioctave_noise{...}` onto `elevation`, sample a fixed point set at
   several `(octaves, persistence, input_scale, output_scale, seed1)`.
2. `octaves = 1` reproduces `basis_noise` (ratio 1.00000 at P = 0.5), pinning the
   base case and confirming `output_scale` is exactly linear (ratio 3.000 at
   `output_scale = 3`).
3. For N = 2, least-squares-fit `oracle = a0*basis(x*IS) + a1*basis(x*IS/2 +
   U, y*IS/2)` over the sample points while scanning `U`. The residual collapses
   to **0** at `scale1 = IS/2` (lacunarity confirmed), `a0 = norm`, `a1 = norm/P`
   (amplitude ratio `1/P` confirmed), and **`U = -1774.830000`** (res 2.5e-7).
   Beware: a *narrow* `U` scan finds a false local min near -238.8 - the basis
   field has near-collisions, so scan wide (the true `U` is IS-, seed- and
   P-independent, which the false one is not).
4. N = 3 confirms the offset is `k * U` (linear in k): octave 2 sits at `2U`.
5. The P = 0.9 residual (6.7e-5 with a real `pow`) drops to ~3e-6 once the
   normalisation uses fastapprox - identifying the fastapprox normalisation.

| claim | test | result |
| --- | --- | --- |
| octaves=1 == basis | ratio at P=0.5 | 1.00000 |
| output_scale linear | ratio at os=3 | 3.00000 |
| lacunarity = 1/2 | N=2 free fit residual | 0 at scale1=IS/2 |
| amplitude ratio = 1/P | fitted a1/a0 | 2.0000 at P=0.5 |
| offset = k*U, IS-independent | fit U at IS in {0.0625,0.125,0.25} | -1774.83 all, res ~3e-7 - **an ALIAS of 17.17, see below** |
| norm uses fastapprox pow | P=0.9 residual real vs fast pow | 6.7e-5 -> 2.9e-6 (pre-`9b49ebb`, see above) |
| full model | 6 configs x realistic points | < 5e-5 (now 7.2e-7 over all 266) |

## The octave offset was an ALIAS, and that is the whole bug

**This section replaces "The f32 floor", which said the residual was irreducible.
It was not; it was self-inflicted.**

The fit in step 3 above is not wrong, it is *degenerate*. The basis lattice has
period **256** on each axis, so any two offsets differing by a multiple of 256
name the same field. And

```
17.17 - (-1774.83) = 1792 = 7 * 256
```

exactly. The wide scan the note recommends found the alias seven periods out
instead of the real constant. In f64 the two are interchangeable - measured
directly, `OFF = +17.17` and `OFF = -1774.83` give **bit-identical output on all
266 oracle samples**. So nothing about the old model was detectably wrong.

In **f32** they are not remotely interchangeable, because the game rounds each
octave's x to f32:

| k | true `k*17.17` | its f32 ulp | aliased `k*-1774.83` | its f32 ulp |
| --- | --- | --- | --- | --- |
| 1 | 17.17 | 2.0e-6 | -1774.83 | 2.1e-4 |
| 3 | 51.51 | 6.1e-6 | -5324.49 | 6.4e-4 |
| 5 | 85.85 | 1.0e-5 | -8874.15 | 1.1e-3 |

A ~1e-3 quantisation of a lattice coordinate is a ~1e-3 perturbation of the
field. **That is the "~1e-4 floor" the old section described, and the reason it
"grew at extreme coordinates" - both were properties of the alias, not of the
game.**

### Why five earlier f32 attempts all made it worse

This is the part worth remembering. With the alias in place, moving toward the
game's real arithmetic is *actively harmful*: f64 was accidentally compensating
for a coordinate that was 100x too large by carrying 100x more precision than the
game does. Measured, against the same fixture:

| variant | worst | f32-exact |
| --- | --- | --- |
| f64, alias (the old shipped code) | 1.170e-4 | 12/266 |
| f64, true offset | 1.170e-4 | 12/266 |
| f32 op order, alias | 1.427e-3 | 10/266 |
| **f32 op order, true offset** | **7.153e-7** | **62/266** |

Neither fix does anything alone - one is a literal no-op, the other is a 12x
regression - and together they are 164x. Four earlier variants (f32 per term, f32
accumulation, `fcvt` the sum once, f32 scale chain) all sit in that third row's
band for the same reason, and were correctly recorded as failures of the
*hypothesis they were testing* while the actual defect sat in a constant nobody
was varying.

**The general lesson: a fitted constant that is degenerate under a periodicity is
only determined modulo that period, and the alias you happen to land on is
invisible until something else in the pipeline becomes precision-sensitive.**
Before trusting a fit, check whether the model has a period, and prefer the
representative of smallest magnitude - it is the one the original author is
likely to have typed, and the one that survives f32.

`variablePersistenceMultioctaveNoise` carries a fitted per-octave shift of
**`-7936`, which is `-31 * 256`** - an alias of 0. That is the same signature and
it is very likely the same defect; it is untouched by this change and worth
checking next.

## What is left (7.2e-7), and it is not this file's problem

The residual after the fix does **not** come from the composition. Decomposed
per case, `octaves = 1` already carries 2.4e-7 with only 10/38 samples f32-exact -
and at `octaves = 1, P = 0.5` the normalisation is exactly 1, so that case reduces
to a single `basisNoise` call. `src/noise/basisNoise.ts` evaluates in f64
throughout (no `Math.fround` anywhere) and its own header admits a "~2e-7 noise
floor"; the game's vector `Noise::noise` computes the same kernel in f32 NEON,
two lattice corners per 2-lane vector with a final `faddp`, and folds the
gradient magnitude into the stored gradient table.

So closing the last 7.2e-7 is a `basis_noise` job, not a `multioctave_noise` one.
See `basis-noise-NOTES.md`.

## The op's offset_x / offset_y parameters are NOT the per-octave shift

**This section previously said the per-octave shift was `k * 17.17000305 /
offset_x` and that `-1774.83` was the plain op's default `offset_x`. Both halves
are wrong** - there is no `fdiv` anywhere in `fastVectorMultioctaveNoise`, and the
per-octave shift is the bare constant `k * 17.17`.

The op does have `offset_x` / `offset_y` parameters, but they are something else:
`run` loads them from the operation's constant block and passes them straight
through to the vector `Noise::noise`, which applies them per point as
`(coord + offset) * input_scale` - a **single world-space translation applied
identically to every octave**, not a per-octave shift. They are 0 for every call
the fixture exercises, which is why the fit never saw them.

That makes the family consistent rather than split:

- **plain**: `offset_x`/`offset_y` are a world-space translation; per-octave
  decorrelation is the fixed `k * 17.17` noise-space shift.
- **quick_multioctave_noise**: `offset_x` is likewise a world-space translation
  `(x + offset_x) * scale`; quick decorrelates octaves by re-seeding, not by an x
  shift. See `quick-multioctave-noise-NOTES.md`.
- **variable_persistence**: world-space translation plus a fixed per-octave noise
  shift recorded as `k * (-7936)` - see the alias warning above, since
  `-7936 = -31 * 256`.

## Done since: quick_multioctave_noise

**SOLVED** - `src/noise/quickMultioctaveNoise.ts`,
`docs/noise/quick-multioctave-noise-NOTES.md`. The temperature/moisture/aux op. Sum
of N basis octaves, `OISM`/`OOSM` per-octave scale/amplitude multipliers, no
normalisation, world-space `offset_x`, seed word +2 per octave-pair (with a
`(7*(seed1>>8))&1` phase term). `quick_multioctave_noise_persistence` is a thin Lua
wrapper over it (just needs porting).

## Done since: variable_persistence_multioctave_noise

**SOLVED** - `src/noise/variablePersistenceMultioctaveNoise.ts`,
`docs/noise/variable-persistence-multioctave-noise-NOTES.md`. The elevation-tree op.
Horner sum of N same-seed basis octaves (lacunarity 1/2, scale `input_scale*0.5^(k+1)`),
weight `p^(N-1-k)` from a per-tile persistence expression, gain `2^N`, **no** RMS
normalisation (the norm branch in the `float const*` overload is a different entry
point; the register `run` path the oracle uses has none). `offset_x` is a world-space
translation `(x+offset_x)*scale`; per-octave decorrelation is a fixed `k*(-7936)` noise
shift, seed shared. `amplitude_corrected_multioctave_noise` (the Lua wrapper) just
sets `output_scale = (1-p)/2^N/(1-p^N)*amplitude` - port once desired, no new RE.

## Still open (the rest of the family)

- **`amplitude_corrected_multioctave_noise`** is a Lua wrapper
  (`core/prototypes/noise-functions.lua`) over `variable_persistence_multioctave_noise`
  (now done) - port the thin wrapper (with a `p == 1` guard) when the elevation tree
  needs it.
