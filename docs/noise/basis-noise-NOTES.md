# basis_noise - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962), captured headless via probe
`noise-expression` prototypes read back with `LuaSurface.calculate_tile_properties`,
and cross-checked against a disassembly of the shipped executable (the Mach-O
retains its C++ symbols). Reference implementation: `src/noise/basisNoise.ts`.
Fixtures: `test/fixtures/basis-noise.seed123456.json` (field) and
`test/fixtures/basis-noise-seeding.game.json` (seed -> field). Tests:
`test/basisNoise.spec.ts`, `test/basisNoiseSeeding.spec.ts`.

## The result

```
basis_noise(x, y) = SUM over the 4 cell corners of  (1 - d)^3 * (D . G[h(i,j)])

  D          = (x, y) - corner        (in noise space: world coords * input_scale)
  d          = |D|^2                  (corners with d >= 1 contribute nothing)
  G[h]       = 4.2 * (cos(2*pi*h/256), sin(2*pi*h/256))
  h(i, j)    = a[i & 255] XOR b[j & 255]
  a, b       = per-axis permutations of 0..255
```

That formula is the ALGEBRA. It is not the arithmetic, and the difference is
worth 2.6x - see "The arithmetic is part of the answer" below.

Reproduces the game **exactly** over 512 independent points, at a different
`input_scale` than the tables were measured at: **512 of 512 bit-exact, max
error 0**, since 2026-08-18. It was 473 of 512 at max error 1.192e-7 until the
gradient table stopped being derived from a formula and was recovered from the
game instead (#234, and "Recovering the gradient table" below). The kernel did
not change; the 39 misses were the table. The same change took
`oracle-basis.seed123456.json` from 36 of 38 to 38 of 38 and the multioctave
fixture from 231 of 266 to 266 of 266.

For scale: the game's own `multioctave_noise{octaves=1}` and `basis_noise`
disagree by ~2e-6 (its `pow` is documented as coming from the fastapprox
library), so this now matches the game more closely than the game matches
itself.

The tables `a`, `b` and the gradient assignment are now derived **straight from
the seed** (`basisNoiseTablesFromSeed`); see "The seeding" below.

## Why this shape

[FFF-112](https://factorio.com/blog/post/fff-112) (2015) says: *"Our noise will
have the simple square grid from Perlin noise, the gradient summation idea from
simplex noise and a very cool hash function from 'Better Gradient Noise'."*

All three checked out, 11 years and two noise-system rewrites later:

- **Square grid from Perlin** - integer lattice, 4 corners per cell.
- **Gradient summation from simplex** - contributions are *summed* with a radial
  falloff, not separably interpolated. `(1-d)^3` reaches exactly 0 at `d = 1`,
  which is why integer lattice points return exactly 0 (the documented quirk
  falls out of the kernel; it is not special-cased).
- **Hash from Better Gradient Noise** - Kensler, Knoll & Shirley, SCI Technical
  Report UUSCI-2008-001. The FFF's link is dead; live copy at
  <http://eastfarthing.com/publications/noise.pdf>. Its Section 2 replaces
  Perlin's nested `P[P[i]+j]` with a separate permutation table per dimension,
  XORed: `H_ij = Px[i] ^ Py[j]`, for axial decorrelation.

Note FFF-112 says Wube took **only the hash**, not BGN's 4x4 reconstruction
kernel - and that is measurable: the full BGN kernel gives 0.212 at integer
lattice points where the game gives exactly 0.

## Evidence

| claim | test | result |
| --- | --- | --- |
| kernel is `(1-d)^3` | predict 3000 points using *measured* gradients | max err 3.5e-6; `(1-d)^2/^4/^5` all fail by ~1e0 |
| hash is `a[i] ^ b[j]` | collision `G(i1,j1)=G(i2,j2)` must force `G(i1,j2)=G(i2,j1)` | 162812 pairs, **0 violations** |
| hash group is `(Z/2)^8` | row permutations generate a group | order exactly 256, exactly 8 generators |
| gradient magnitude | direct measurement, 9216 lattice points | 4.19999919 +/- 1.4e-6 |
| 256 uniform directions | angle spacing | exactly 360/256 = 1.40625 deg, std 0.0000 |
| period 256 per axis | `G(k)` vs `G(k+256)` | 0.000e+00 (exact) |
| full model | 512 independent points from tables alone | max err 1.192e-7, 473/512 bit-exact |
| seed -> tables | 9 seed pairs generated from seed alone vs the game | max err 2.8e-7 |

## The arithmetic is part of the answer (#214, measured 2026-08-16)

The algebra above was right for a year while the arithmetic was wrong, and the
gap was invisible because every test compared against a tolerance. **Every
value in both fixtures is exactly f32** (checked, not assumed), so a bit-exact
port reproduces them exactly - which makes **exact match count** a far sharper
instrument than any bound. Under it, the old shape scores 132/512.

Four things were swept, 384 variants, against both fixtures:

| what | old | now | evidence |
| --- | --- | --- | --- |
| precision | f64 throughout | **f32 after every operation** | see the table below |
| falloff | `(1 - d) ** 3` | **`t * (t * t)`** | the game's two `fmul`s; `x*x*x` and `powf(3)` fold to different checksums over 4M points |
| corner sum | left to right | **pairwise, corners sharing a `cornerY` first** | 473/512 against 406 left-to-right, 353 the other pairing, 345 diagonal |
| gradient table | `Math.cos` at load, `* 4.2` at evaluation | **committed constants, magnitude folded in** | 473/512 against 208 |

The gradient table is where most of it lives, and the winning construction is
not the obvious one:

| table construction | exact | worst |
| --- | --- | --- |
| f64 angle, f64 trig, `* 4.2`, narrow | 208/512 | 2.682e-7 |
| f64 angle, narrowed trig, `* f32(4.2)` | 147/512 | 2.533e-7 |
| f32 angle, narrowed trig, `* f32(4.2)` | 234/512 | 2.384e-7 |
| **f32 angle, then trig and `* 4.2`, ONE narrowing** | **473/512** | **1.192e-7** |

So the angle is f32 and everything after it rounds once. The residual is 18
points at 1 ULP, 11 at 2 ULP and a short tail whose large ULP counts are
near-zero cancellations - consistent with the game's table coming from the
minimax polynomial in `Noise::Noise(bool)` rather than from libm. Extracting
those coefficients is the remaining lead; it needs the capstone tooling in the
method notes below, which is not in the repo.

**What does NOT discriminate, so do not claim it:** `t * (t * t)` versus
`(t * t) * t`, `dx*gx + dy*gy` versus `dy*gy + dx*gx`, and the order of the two
terms in `d`. All eight combinations score identically on both fixtures.
Narrowing the incoming `x`/`y` to f32 also changes nothing here (that is #191's
question, and this measurement does not answer it).

**Why the table is committed rather than derived at load:** #214 measured V8's
`Math.cos`/`Math.sin` differing from libm in the last bit, so a load-time table
depends on the engine, and the Rust port would derive a different one with
libm - putting a last-bit disagreement under every planet on both sides.
`scripts/gen-gradient-table.ts` regenerates it.

## Recovering the gradient table (#234, measured 2026-08-18)

The table is no longer a formula. `src/noise/basisGradientTable.ts` is generated
from `test/fixtures/basis-gradient-table.json`, which is inverted out of a
capture of the running game. That took the fixtures from 473/512, 36/38 and
231/266 exact to **512/512, 38/38 and 266/266, all at max error 0**.

### How

`scripts/probes/basis-gradient/` is a `create`-mode probe run through
[factorio-oracle](https://github.com/FactoryGameFan/factorio-oracle). It
registers `basis_noise` at `input_scale = 1` - so the noise coordinate IS the
world coordinate - routes `elevation` at it, and samples one f32 step off the
lattice along each axis. `scripts/recover-gradient-table.ts` then inverts it.

Three properties of the sampling grid matter, and each is a fact rather than a
preference:

- **A single row already covers every slot.** `a` and `sigma` are permutations,
  so one row of 256 `I` values touches all 256 gradient slots exactly once.
  16 rows give 16 independent samples per slot, which is what lets disagreement
  between them fail instead of averaging away.
- **A 17th row is sampled and never solved from.** Along x the far corner is
  `(i+1) mod 256`, and a whole row covers all 256 `i`, so that wrap is the
  game's own. Along y the far corner is row `j+1`, whose real wrap is mod 256
  rows, not mod 16. Wrapping it to row 0 instead poisons 256 of 4,096 equations
  and drags the recovered y table from 4,092 reproduced samples down to **148**.
  That was caught by a control, not by reading the code.
- **The inversion runs in three stages:** label each lattice point's slot from
  `atan2` (one corner is plenty for four digits, and it needs no seeding
  tables), then subtract the far corner's term and iterate to a fixed point in
  two rounds, then try each slot's f32 neighbours and keep whichever reproduces
  the most captured samples. Seeded from zeros, so no existing table is an
  input, and scored only against the probe's own samples.

The recovery deliberately imports nothing from `src/`. It produces the table
`basisGradientTable.ts` is generated from, so depending on that module would be
circular, and labelling slots by angle rather than by our own seeding
reimplementation is what makes the cross-check below a real control.

### The controls, and one that was malformed

| control | result |
| --- | --- |
| Each slot recovered from 16 independent lattice points | 4,086/4,096 x and 4,092/4,096 y samples reproduced |
| On-lattice values must be exactly 0 | 16/16 |
| Recovered magnitude must be the measured 4.2 | worst error 2.470e-7 |
| Two Factorio versions must agree | 2.0.77 and 2.1.14 give **byte-identical** captures and tables |
| Gauge equivalence with the fixture's own `a`/`b`/`sigma` | 65,536/65,536 lattice cells |

The gauge control failed at first and looked like a defect in the recovery. It
was the control that was wrong: `basis-noise.seed123456.json` stores a canonical
gauge, its `a` starting `0,1,2,4,8,16,32,15`, while `basisNoiseTablesFromSeed`
returns the game's own tables. Both produce identical noise, so equality was
never the right test - equivalence is.

### The limit, priced

Four slots are near zero and cannot be pinned by probing at all. Their ULP is
3.6e-15 and the game returns f32, so the information is not in the output at any
geometry. It costs nothing: perturbing them by 1.0e-9, which is 280x the actual
residual, changes **0 of the 512** values in `basis-noise.seed123456.json`. A
measured limit, not an open question.

### Re-running it

```bash
factorio-oracle run --probe scripts/probes/basis-gradient/probe.json --work-dir /tmp/bg
node scripts/recover-gradient-table.ts /tmp/bg/write/script-output/oracle-dump.json \
  test/fixtures/basis-gradient-table.json
node scripts/gen-gradient-table.ts
```

The probe must write `oracle-dump.json`; that name is factorio-oracle's contract.
`test/basisGradientTable.spec.ts` scores the old formula through the real kernel,
so the 473-versus-512 comparison stays reproducible rather than a claim here.

## The probing technique

The trick that made this tractable: **near a lattice point every other corner's
falloff nearly vanishes**, so

```
value(c + eps*u) ~= eps * (u . G[c])   + O(eps^3)
```

which reads gradients straight out of the game, one lattice point at a time. It
works for *any* candidate falloff, since every candidate has `falloff(0) = 1` -
so gradients can be measured **before** knowing the kernel, and the kernel then
solved with gradients held fixed. Two unknowns, separated.

**"Nearly" is load-bearing, and this used to say "vanishes".** It does not
vanish. At `eps = 1/256` the opposite corner still contributes 1.2e-4 of the
near term, which is 1,014 f32 epsilons - fine for reading a direction index to
four digits, fatal for reading a gradient to the last bit. See "Recovering the
gradient table" for the correction and what it cost.

Three traps, all of which cost a run:

- **`MapPosition` is 1/256 fixed-point** (the same fixed-point
  `src/codec/mapExchangeString.ts` decodes for `starting_points`). A world offset
  below 1/256 rounds to zero. An `eps` of 0.001 therefore lands exactly *on* the
  lattice and returns all zeros - which looks like a broken probe but is the game
  being precise. Choose `eps` via `input_scale`: one world tile = `input_scale`
  noise units.
- **Use power-of-two `input_scale`.** Noise coords must be exact in f32. Large
  world coords with a tiny `eps` cause catastrophic cancellation - at
  `input_scale = 1e-3` this inflated the noise floor ~1000x and made distinct
  gradients look continuous.
- **`calculate_tile_properties(property_names, positions)`** - property names
  come first. The HTML docs and `runtime-api.json` list `positions` first, but the
  `order` field (property_names=0) is authoritative.

## The seeding - SOLVED (2026-07-17, by disassembly)

The field-level probing (below) had mapped the *structure* of the seeding but
stalled on two pieces: the exact `(seed0, seed1)` combine, and how a taus88 stream
becomes the permutation tables. Both fell out immediately once the shipped
executable was disassembled - the macOS universal binary
(`.../Factorio.app/Contents/MacOS/factorio`, 2.1.11) is **not stripped**: it
retains mangled C++ symbols, so `NoiseOperations::BasisNoise`, `Noise::setSeed`
and `Noise::noise` are all findable by name and disassemblable directly.

### The whole algorithm

```
# From the BasisNoise ctor: how (seed0, seed1) become the two args to setSeed.
word    = max(seed0 + 7*(seed1 >> 8), 0x155)   # uint;  seed1 LOW byte is dropped here
lowByte = seed1 & 0xff                          # passed separately

# From Noise::setSeed(uint word, uchar lowByte): one continuous taus88 stream,
# seeded s1 = s2 = s3 = word, drives four backward Fisher-Yates (Durstenfeld)
# shuffles of identity[0..255], IN THIS ORDER:
scratch = shuffle(identity)     # draws   0..254
salt    = scratch[lowByte]      # a single byte, stored at this+5
yTable  = shuffle(identity)     # draws 255..509   (object offset +0x006)
xTable  = shuffle(identity)     # draws 510..764   (object offset +0x106)
gradPerm= shuffle(identity)     # draws 765..1019  (permutes the gradient table)

# From Noise::noise: the hash carries the salt as a constant XOR.
h(i, j) = xTable[i & 255] ^ yTable[j & 255] ^ salt
G       = gradientTable[ gradPerm[h] ]     # gradientTable is angle-ordered 4.2*(cos,sin)
```

`shuffle` is the textbook backward Durstenfeld: `for pos = 255..1: j = next() %
(pos+1); swap(t[pos], t[j])`. `next()` is one canonical L'Ecuyer taus88 step
(the game vectorizes it - z2/z3 in the two NEON lanes, z1 scalar - but the
sequence is identical to the scalar generator in `src/noise/spotCandidates.ts`).

Implementation: `basisNoiseTablesFromSeed` in `src/noise/basisNoise.ts`. It folds
the salt into `sigma` (`sigma[h] = gradPerm[h ^ salt]`) so the existing
`a[i]^b[j]` evaluator reproduces `gradPerm[xTable[i]^yTable[j]^salt]` unchanged.

### Why each earlier field-level observation falls out

- **`seed0` bit 0 is dead; `0..341` all collapse to one field; `342` is the
  first distinct one; `512==513`, `1024==1025`.** All from
  `word = max(seed0 + ..., 0x155)` seeding `s1=s2=s3=word`: the clamp guards the
  taus88 all-zero fixed point (0x155 = 341), and taus88's state words drop their
  low 1/3/4 bits on the first step, killing `seed0`'s bit 0.
- **`a`/`b` depend on `seed0` and `seed1>>8` only; the low byte is discarded.**
  Because the low byte does not enter `word`, and `a`/`b` are built purely from
  the `word`-seeded stream. The old `(0,256) ~ (0,0)` "coincidence" is real: both
  give `word <= 0x155` (clamped equal) with `lowByte = 0`.
- **`sigma` (hash -> direction) depends on the full `seed1`.** Because the low
  byte enters as `salt = scratch[lowByte]`, XORed into the hash at evaluation -
  a per-seed constant offset that makes the effective `hash -> direction` map move
  with the low byte while `a`/`b` stay put.

### How it was found in the binary (method notes)

1. `nm factorio | c++filt | grep BasisNoise` -> `NoiseOperations::BasisNoise::run`,
   the ctors taking `(uint seed0, uint seed1, ...)`, etc. `run` is a ~100-byte
   thunk that tail-calls `Noise::noise`; the seed math is in the `BasisNoise`
   ctor, which computes `setSeed(seed0 + 7*(seed1>>8), seed1 & 0xff)` and calls
   `Noise::setSeed`.
2. `objdump --macho` ignores `--start-address`/`--stop-address` and mis-maps
   vmaddr vs file offset - it dumped the whole 500 MB. A tiny capstone script
   (parse `LC_SEGMENT_64` for vmaddr->fileoff, disassemble a byte range,
   resolve `bl`/`b` targets against the `nm` table) is the workable disassembler.
3. `Noise::setSeed` is one clamp (`csel ... 0x155`) plus four Durstenfeld loops
   over one taus88 stream; the taus shift constants (`{13,19,12}/{2,25,4}/
   {3,11,17}`, masks `~1/~7/~15`) sit in `__const` and confirm canonical taus88.
   `Noise::Noise(bool)` builds the static template: `a[k]=k`, `b[k]=k` (identity),
   gradient slot `k` = a minimax-poly `(cos, sin)` at angle `2*pi*k/256`.
4. The one non-obvious bit is the **draw offset**: table `a` (the X table, at
   `this+0x106`) is the *third* shuffle, so it starts at draw 510, not 0 - the
   255-draw scratch pass and the Y table precede it. A gauge-robust GF(2) offset
   scan against the fixture pinned it at 510 (and revealed the fixture's "a" is
   the game's `this+0x106` X table, indexed by the x coordinate in `Noise::noise`).
5. Verified: generating `a`/`b`/`sigma` from the seed alone and evaluating
   reproduces the game to ~2e-7 across 9 `(seed0, seed1)` pairs exercising the
   `7*(seed1>>8)` combine (seed1 up to 65535), the nonzero-lowByte salt
   (low = 1..255), the `0x155` clamp (seed0 = 7), and `seed0 = 2^31`.

### The field-level structure work (superseded, kept for method)

Before the disassembly, the seeding was attacked purely through the field. That
work correctly established: the `0x155` clamp and `s1=s2=s3=word` seeding (shared
with `spot_noise`); that `basis` has no `SEED_BASE` (unlike spot); that there are
three seed-dependent permutations with `a`/`b` driven by `(seed0, seed1>>8)` and
`sigma` by the full `seed1`; and that `sigma` is **not** a fixed gradient table.
It could not crack the combine or the table generator by blind search - every
textbook shuffle off a taus88 stream failed the exact-integer-grid test, because
the real build burns 255 draws on the scratch pass first and salts the hash.
Lesson: for a generator that is one short function of machine code, a
**non-stripped binary is the fastest oracle by far** - hours of blind GF(2) /
shuffle search vs. one afternoon of disassembly.

The gauge-free tools built for that effort are still the right verification
harness:

**Raw direction-grid recovery.** With `input_scale = 1`, noise coord == world
coord. Near lattice point `(I,J)`, `value(I+eps, J) ~= C * cos(2*pi*K/256)` and
`value(I, J+eps) ~= C * sin(2*pi*K/256)`, so `K(I,J) =
round(atan2(vy,vx)/(2*pi)*256) mod 256` is the physical direction index. `eps =
1/256` is exact in f32 for `I,J <= 255`. This is denser and stricter than the
float field, and gauge-free.

> **Correction, 2026-08-18.** This paragraph used to say that `eps = 1/256`
> "isolates the `(I,J)` corner". It does not, and no offset can. `d` in the
> kernel is the SQUARED distance, so the corner at `(1,0)` sits at `d = 0.9922`,
> inside the falloff's support, and contributes about 1.2e-4 of the near term -
> 1,014 times f32 epsilon. Leaving one corner live would need `fy^2 > fx` and
> `fx^2 > fy` at once, which forces `fy > 1`; a scan of the unit cell agrees
> that every interior point has two or more live corners.
>
> The `~=` above was honest, and for its own purpose it is fine: `K` needs about
> four digits and the one-corner form gives them. Reading it as an exact
> inversion is what breaks. A one-corner inversion recovers **2 of 256** gradient
> slots while returning all 512 numbers at plausible magnitudes - it does not
> fail, it just answers wrongly. See "Recovering the gradient table".

**Which-seed GF(2) test** (`which_seed.py`). For each grid recover the
XOR-difference vectors `alpha(I) = L(a[I]^a[0])`, `beta(J) = L(b[J]^b[0])` via a
per-grid unscrambler; two grids share a table iff a single GF(2) 8x8 matrix maps
one grid's difference vectors to the other's. This is what proved `a`/`b` depend
on `seed1>>8` only, and (reused) what pinned the draw offset at 510.

### Reproducing the seeding oracle

Rebuild the headless probe in a scratch dir: a mod registering
`{ type = "noise-expression", name = "probe_elev", expression =
"basis_noise{x = x, y = y, seed0 = <S0>, seed1 = <S1>, input_scale = 0.125,
output_scale = 1}" }`, a `--map-gen-settings` JSON routing
`property_expression_names.elevation = "probe_elev"`, and an `on_init` that calls
`surface.calculate_tile_properties({"elevation"}, positions)` and
`helpers.write_file`s the result, then `error("DUMPED-OK")` to exit (~1.7 s/run).
An isolated `--config` INI with `read-data` at the app's `Contents/data` and
`write-data` in the scratch dir keeps it clear of the real install. The mod must
declare `"factorio_version": "2.1"`. Sample the *same* positions for every seed
and diff against `basisNoiseTablesFromSeed`.

## spot_noise - SOLVED (see spot-noise-NOTES.md)

`spot_noise` - which places every ore patch, long called "black magic" - was
cracked on 2026-07-17: taus88 candidate RNG + a dart-throw selection phase. Full
write-up in `docs/noise/spot-noise-NOTES.md`; implementations in
`src/noise/spotCandidates.ts` and `src/noise/spotSelection.ts`. The `0x155` clamp
and `s1=s2=s3=word` seeding proven there are what identified basis's `seed0` word,
and the shared taus88 is the same generator basis shuffles its tables with.

## Reproducing

The probe harness is not committed (it needs a Factorio install). Recipe: an
isolated `--config` INI with `read-data=__PATH__executable__/../data`, a mod
registering `{ type = "noise-expression", name = "probe", expression =
"basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 0, input_scale = ..., output_scale = 1}" }`,
`--map-gen-settings` pointing `property_expression_names.elevation` at it, and an
`on_init` that calls `calculate_tile_properties` and `helpers.write_file`s the
result. See `docs/mapexchangestrings/maptype-elevation-NOTES.md` for the same
headless setup.
