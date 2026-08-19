# quick_multioctave_noise - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962), cracked by disassembling
`NoiseExpressions::QuickMultioctaveNoise::run` in the non-stripped shipped Mach-O
and fitting the committed oracle (`test/oracle/`). Reference implementation:
`src/noise/quickMultioctaveNoise.ts`. Fixture:
`test/fixtures/oracle-quick-multioctave.seed123456.json`. Test:
`test/quickMultioctaveNoise.spec.ts`. Companion to `multioctave-noise-NOTES.md`,
`basis-noise-NOTES.md`, `spot-noise-NOTES.md`.

This is the op the **temperature / moisture / aux** climate trees use (each passes
`offset_x = <big> / var('control:<name>:frequency')`), so it is the M2 climate
primitive. It is a distinct op from the plain `multioctave_noise` -
`QuickMultioctaveNoise` (10 constants: seed0, seed1, input_scale, output_scale,
octaves, octave_output_scale_multiplier, octave_input_scale_multiplier, offset_x,
plus x/y register refs).

## The result

```
quick(x, y) = SUM_{k=0}^{N-1}  OS * OOSM^k *
              basis( (x + offset_x) * IS*OISM^k ,  y * IS*OISM^k ;
                     tables( octaveSeed0(seed0, seed1, k) , seed1 ) )

  N     = octaves
  IS    = input_scale                            OS   = output_scale
  OISM  = octave_input_scale_multiplier          OOSM = octave_output_scale_multiplier
  offset_x = world-space x translation, SAME for every octave
```

So: **N octaves of `basis_noise`, each octave scaling its input by `OISM` and its
output contribution by `OOSM`**, with three things that make it "quick" and unlike
the plain op:

1. **No RMS normalisation.** It is the raw weighted sum. The
   `quick_multioctave_noise_persistence` Lua wrapper
   (`core/prototypes/noise-functions.lua`) is what normalises, by pre-scaling
   `input_scale *= OISM^(N-1)` and `output_scale *= 2^(N-1)` before the call.
2. **`offset_x` is a single world-space translation**, applied identically to every
   octave: the sampled x is `(x + offset_x) * scale_k`. This is NOT the plain /
   variable-persistence op's per-octave `k * 17.17000305 / offset_x` shift. (Basis's
   own `offset_x` param works the same way - `(x + offset_x) * input_scale` - see the
   decoratives, which pass `offset_x = seed`.)
3. **Octaves are decorrelated by re-seeding, not by an x shift.** The basis seed word
   steps by +2 every *pair* of octaves - see below.

At the compile level (`QuickMultioctaveNoise::run` is a register-program builder, not
a runtime loop) the op emits N explicit `BasisNoise` ops, multiplying the running
input scale (`s8 *= s12`) and output scale (`s9 *= s13`) per octave and advancing a
seed accumulator (`w21 += w28`). "Quick" = the octaves are unrolled at compile time.

**Bit-exact against the game: 190/190, worst error exactly 0**, across octaves
1..6, both per-octave multipliers, offset_x in {0, 12000, 40000}, several
input/output scales and seven seed1 values.

That is a correction. This paragraph used to read "verified to the basis floor
(~1e-6) for small sampled coordinates, loosening to ~3e-3 where a large
`offset_x` ... or a far world point pushes the sampled coordinate to thousands of
noise units - the documented f32 floor", and the spec carried two tolerances to
match. **There was no floor.** The op was evaluating in f64 while the game
evaluates in f32; it scored 38/190 exact. See "The f32 correction" below.

Note the shape of the wrong belief, because it is now the third time this exact
one has been recorded in these notes. A distance-dependent residual was read as
evidence of a precision limit inherent to the coordinate magnitude. In all three
cases - the plain op's aliased `-1774.83`, the variable-persistence op's aliased
`-7936`, and this one - the residual grew with |coordinate| because the port was
computing in the wrong precision, not because large coordinates cost accuracy.
The tell each time was that the "floor" was never derived from anything; it was
named after the symptom.

## The per-octave seed (the whole subtlety)

Octaves pair up: the basis **seed word** steps by +2 every two octaves, so octaves
0,1 share a word, 2,3 the next, etc. Decorrelation between the two octaves of a pair
comes purely from their different input scales.

The seed word Factorio actually hashes is `seed0 + 7*(seed1>>8)` (see
`basisNoiseTablesFromSeed` in `basis-noise-NOTES.md`); the per-octave +2 lands on that
*combined* word, and the parity of the `7*(seed1>>8)` part shifts which octave of each
pair the +2 falls on. Writing `phase = (7*(seed1>>8)) & 1`, the `seed0` we pass to
`basisNoiseTablesFromSeed` for octave k is:

```
seed0_k = seed0 - phase + 2*floor((k + phase) / 2)
```

- **phase 0** (all `seed1 < 256`, i.e. every base-game quick usage - seed1 = 5,6,7,123):
  reduces to `seed0 + 2*floor(k/2)` -> word offsets 0,0,2,2,4,4,...
- **phase 1** (e.g. seed1 = 999, where `7*(seed1>>8) = 21` is odd): `-1,1,1,3,3,5,...`

Pinned by capturing `quick_multioctave_noise` at `octave_input_scale_multiplier = 1`
and `octave_output_scale_multiplier = 1` (all octaves identical scale/amplitude), so
each octave's contribution is a bare `basis` at one scale; the prefix-sum
differences `quick(N+1) - quick(N)` then isolate octave N, whose seed-word offset the
oracle reads directly. Confirmed for phase 0 (seed1 = 137, 42, 7, 512) and phase 1
(seed1 = 999, 256, 300).

## How the pieces were pinned (oracle fitting)

Structure from the disassembly; numbers from the oracle. The decisive experiments:

| claim | test | result |
| --- | --- | --- |
| octave 0 == basis | 1 octave, offset_x=0 | `OS*basis(x*IS)`, floor |
| `offset_x` world-space | 1 octave, offset_x=25000 | `(x+off)*IS`, floor |
| OISM/OOSM per-octave | 2 octaves, distinct multipliers | scale*=OISM, amp*=OOSM, floor |
| octaves 0,1 share a seed | `OISM=OOSM=1`, 2 octaves | `2*basis`, floor |
| seed word +2 per pair | `OISM=OOSM=1`, octaves 1..6, diff | 0,0,2,2,4,4 (phase 0) |
| phase from `7*(seed1>>8)&1` | same, seed1 with odd `7*(seed1>>8)` | `-phase + 2*floor((k+phase)/2)` |
| no normalisation | 1 octave == basis exactly (floor) | norm == 1 |

The trap that cost the most time: assuming `quick(N)` differences cleanly *and* that
the per-octave seed is a plain `2*floor(k/2)`. It is a prefix sum (no norm, so
`quick(N+1) - quick(N)` is exactly octave N), but the seed rule's phase term only
shows up once you test a `seed1 >= 256` whose `7*(seed1>>8)` is odd - every small
seed1 masks it. See the seed section above.

## Still open

Nothing on the arithmetic: the op is bit-exact.

One thing this fixture cannot answer, recorded so nobody reads 190/190 as
covering it. **Whether the game rounds `x + offset_x` to f32 before multiplying
by the input scale is not resolved here.** Narrowing only the product scores
190/190 with worst 0 as well, because every `(position + offset_x)` the fixture
uses is already exact in f32. The port narrows both, matching what a register
machine does and what `variable_persistence_multioctave_noise` does at its
identical `(x + offset_x)` step. A caller passing a DERIVED x - Fulgora-style,
off the f32 grid - is where the two forms would part, and no fixture covers
that. If one is ever captured, this is the question to ask of it.

The same caveat applies to narrowing the incoming `x`/`y` at all (#191): all 38
fixture positions are already on the f32 grid, so turning that narrowing off
also leaves the score at 190/190.

`quick_multioctave_noise_persistence` (`noise-functions.lua`) is a thin Lua wrapper
over this op (pre-scaling input/output scale and mapping persistence ->
`octave_output_scale_multiplier`); it is ported. Its Lua-side arithmetic stays in
f64 - Lua numbers are doubles - and the results land in the op's f32 constant
slots, which is where the port narrows them. The
`variable_persistence_multioctave_noise` op (used by the elevation tree) is a
*different* primitive - see `multioctave-noise-NOTES.md`.

## Correction (2026-07-19, M2 Task 10): the "+2 per pair" rule was a masked over-fit

The "per-octave seed" section above (`seed0_k = seed0 - phase + 2*floor((k +
phase) / 2)`, i.e. the basis seed word stepping by +2 every *pair* of octaves)
is **wrong** - or more precisely, it is numerically indistinguishable from the
truth for every seed this doc's own oracle captures ever used, which is why it
went undetected for as long as it did.

The actual rule is a flat **`seed0_k = seed0 + k`** - a distinct basis seed
word for every single octave, no pairing at all.

**Why the old rule looked right:** `taus88`'s `s1` state update masks its input
with `& 0xfffffffe` (clears the low bit) before the first left-shift. That
means `basisNoiseTablesFromSeed(W)` and `basisNoiseTablesFromSeed(W + 1)`
produce byte-identical tables whenever `W` is **even** - the odd successor's
low bit gets thrown away before it can affect anything. So for an even base
word, "+1 every octave" and "+2 every pair" agree exactly: octaves 0 and 1
both hash to the same table either way (`W` and `W+1` collide), and so do
octaves 2 and 3, etc. Every fixture and hand-derived experiment in the
sections above used `seed0 = 123456`, which is even - so the pairing artifact
was baked into every oracle capture and never had a chance to show up.

**What exposed it:** Task 10's tile-resolver parity test exercises the
temperature/moisture/aux trees at three seeds, one of them **odd - 654321**.
For an odd base word, `W` and `W+1` are genuinely different tables (no
low-bit collision), so "+2 per pair" and "+1 per octave" diverge starting at
octave 1. Per-octave isolation against the live game (sampling
`quick_multioctave_noise` at `octaves = 1..4` and differencing consecutive
results, the same prefix-sum trick used above) showed octave 0 and 2 matching
the old formula but octaves 1 and 3 off by roughly 0.02-0.05 - precisely the
two octaves the old formula reused an even-derived word for, when the true
per-octave word for an odd `seed0` is one higher and does not collide.

The flat `seed0 + k` reproduces the live game to the basis floor at both
parities, and is bit-identical to the old formula's output at the historical
`seed0 = 123456` fixture (including its one `phase >= 1` case, `seed1 =
999`) - so nothing in this document's existing oracle evidence is
contradicted, it was just never sufficient to distinguish the two rules. See
`src/noise/quickMultioctaveNoise.ts`'s `octaveSeed0` doc for the code-level
version of this note.

This is left in place above (not deleted) as a worked example of how an
even/odd-masking RNG detail can hide a wrong derivation behind a coincidence -
worth remembering the next time a new op is pinned against a single seed
fixture.

## Correction (2026-08-18): the "f32 floor" was the port evaluating in f64

The op is now **190/190 bit-exact against the committed oracle, worst error
exactly 0**. It was 38/190. Nothing about the structure above changed - the
octave shape, `offset_x` semantics and the flat `seed0 + k` seed rule are all
as documented. What changed is the precision the arithmetic runs in.

### How it was found

Not by a scan or a fit. `src/noise/quickMultioctaveNoise.ts` imported no `f32`
helper at all, while both of its relatives narrow after every operation - so the
first thing measured was simply whether that was the whole story.

Two hypotheses were on the table. The other one, an aliased `offset_x` in the
`-1774.83` / `-7936` family, was **refuted before any sweep was run**: the file
contains no fitted constant to alias. Its only numeric literals are `0`, `NaN`
and the Lua wrapper's `1/oism` and `2**(N-1)`. `offset_x` arrives from the
caller, and the fixture's values (0, 12000, 40000) are the game's own. There was
nothing there to be aliased, and the 190/190 result confirms it - an aliasing
defect cannot coexist with a residual of exactly zero.

### The four ingredients, each measured load-bearing

Scored by exact f32 match count over all 190 fixture values (all of which are
exactly f32 - checked, not assumed). Each row turns off ONE thing and re-scores:

| variant | exact | worst |
| --- | --- | --- |
| **all four (shipped)** | **190/190** | **0** |
| params not narrowed to f32 | 109/190 | 1.098e-3 |
| `amp * basis` not rounded before the add | 132/190 | 4.768e-7 |
| scale/amp by `OISM**k` instead of a running chain | 143/190 | 4.971e-5 |
| scale/amp chain steps not rounded | 137/190 | 1.206e-4 |
| none of them (the old f64 shape) | 38/190 | 1.057e-3 |

The 38 the old shape got right are exactly the one-octave case, where
`output_scale = 1`, `offset_x = 0` and `input_scale = 0.125` are all exact in
f32 and there is no chain to accumulate error along.

**Narrowing the parameters is the single biggest term**, and it is `f32.ts`'s
"narrow the CONSTANT" case rather than its "narrow the product" case. The values
callers pass have no exact f32 form: `octave_output_scale_multiplier` 0.6, 0.65,
0.7; `input_scale` 0.1, 0.08, 1/6; `octave_input_scale_multiplier` 0.55. The
game holds these in f32 constant slots. No amount of rounding the result
recovers the difference.

**Two of the four were only visible to exact-match counting.** Dropping just the
`amp * basis` rounding leaves the worst residual at 4.768e-7 - indistinguishable
from correct by any bound anyone would write - while 58 points stop being
bit-exact. This is #162's thesis reproduced on a new op.

### What the old bounds would have accepted

The spec's old assertions were `worstNear < 5e-5` and `worstFar < 3e-3`. The
"scale/amp by powers" defect above measures **4.971e-5**, at a point the old
split classified as far-field. **The old spec passes that defect on both
counts.** The spec now asserts `toBe(0)` and `toBe(190)`, with an accompanying
test that every fixture value is f32-exact so the scoring cannot silently stop
being valid.

### Op order, as ported

```
scale_0 = f32(input_scale)      amp_0 = f32(output_scale)
OFF = f32(offset_x)             OISM  = f32(oism)   OOSM = f32(oosm)

per octave k:
  xk    = f32(f32(x + OFF) * scale)          # inner rounding: see "Still open"
  yk    = f32(y * scale)
  sum   = f32(sum + f32(amp * basis(xk, yk, tables(seed0 + k, seed1))))
  scale = f32(scale * OISM)
  amp   = f32(amp * OOSM)
```

The scale and amplitude chains are chains, not powers - `s8 *= s12` / `s9 *= s13`
per octave in `QuickMultioctaveNoise::run`, in f32 registers. Deriving the k-th
term as `input_scale * OISM**k` instead costs 47 exact matches.

### The Lua wrapper was a SECOND f64 evaluation, worth 1.964e-3

Fixing the op did not fix `quick_multioctave_noise_persistence`. It went from
38/152 to **114/152** and its worst error did not move at all - still 1.964e-3.

The reason is a trap worth naming, because "Lua wrapper" invites exactly the
wrong inference. The wrapper is a **`noise-function` whose body is an expression
STRING**:

```lua
name = "quick_multioctave_noise_persistence",
expression = "quick_multioctave_noise{...
              input_scale = input_scale * octave_input_scale_multiplier ^ (octaves - 1),
              output_scale = output_scale * 2 ^ (octaves - 1),
              octave_input_scale_multiplier = 1 / octave_input_scale_multiplier}"
```

Lua never evaluates that arithmetic. The **noise machine** compiles and folds it,
in f32, one operation at a time, like everything else it evaluates. Doing the
transform in f64 and narrowing only at the op boundary rounds the wrong quantity.
In f32 per operation the wrapper is **152/152, worst 0**.

`^` has an integral exponent here, and the noise machine's `^` is three functions
selected by the exponent - exact exponentiation by squaring for an integer, exact
`sqrt` for 0.5, fastapprox otherwise (#161, #163). `noiseMachinePow` implements
the dispatch. **This fixture cannot discriminate the integral branch**: `Math.pow`
narrowed to f32 also scores 152/152, because the only bases are 0.5 and 0.6 at
exponents 0, 2, 3 and 4. Squaring is used because it is what the game does.

### Open: amplitude_corrected_multioctave_noise is 81/152 and the same fix does NOT work

`amplitude_corrected_multioctave_noise` is the same shape of wrapper - a
`noise-function` expression over `variable_persistence_multioctave_noise`:

```lua
output_scale = (1 - persistence) / 2 ^ octaves / (1 - persistence ^ octaves) * amplitude
```

Its op underneath is bit-exact (266/266) and its own fixture is all-f32 with all
38 positions on the 1/256 grid, so the fixture can grade it. It measures
**1.788e-7 worst, 81/152 exact**.

**Rewriting its transform f32-per-op with the integral `^` does not fix it:**
84/152 exact, worst 3.576e-7 - three more exact matches and a worse worst. So
the shipped f64 transform stays, and its spec bound is set to the measured
1.788e-7 rather than the `< 5e-3` it carried before (~28,000x slack).

That is left explicitly open rather than closed by picking whichever variant
scored higher. Three more exact matches out of 152 is not a mechanism, and the
lesson from `-1774.83` and `-7936` is that a small improvement in a fit is the
easiest thing in this codebase to mistake for a finding. Whoever picks this up:
the association order of the two divisions, and whether `1 - persistence ^ N`
folds at compile time or per tile, are the two things not yet tested.
