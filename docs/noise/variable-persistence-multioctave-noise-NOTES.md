# variable_persistence_multioctave_noise - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962), cracked by disassembling the op's register
program `NoiseOperations::VariablePersistenceMultioctaveNoise::run` (@0x10174a318)
in the non-stripped shipped Mach-O and fitting the committed oracle (`test/oracle/`).
Reference implementation: `src/noise/variablePersistenceMultioctaveNoise.ts`.
Fixture: `test/fixtures/oracle-variable-persistence-multioctave.seed123456.json`.
Test: `test/variablePersistenceMultioctaveNoise.spec.ts`. Companion to
`multioctave-noise-NOTES.md`, `quick-multioctave-noise-NOTES.md`,
`basis-noise-NOTES.md`, `spot-noise-NOTES.md`.

This is the op the **elevation** tree uses (nauvis `make_0_12like_lakes`). Its
defining feature: `persistence` is a spatially-varying value - a noise *expression*
the game evaluates per tile - so successive octaves are attenuated by a persistence
that changes across the map.

## The result

```
varPers(x, y) = f32( gain * HORNER_{k=0..N-1} basis( f32(f32(x + offset_x)*S_k) ,
                                                     f32(y*S_k) ) )

  N     = octaves
  S_0   = f32(input_scale * 0.5)             (finest octave scale = input_scale/2)
  S_k+1 = f32(S_k * 0.5)
  p     = persistence at this tile
  gain  = f32(output_scale * 2^N)
  basis = basis_noise with tables from (seed0, seed1)  [basis-noise-NOTES.md]

Horner, with every step rounded to f32:
  acc = 0; for k: acc = f32(acc + basis(...)); if k < N-1: acc = f32(acc * p)
```

**Updated 2026-08-05: there is NO `OCTAVE_SHIFT`, and the arithmetic is f32.**
The fitted `k*(-7936)` was an alias of zero - see "The shift was an alias" below.
Worst error against the committed oracle went `1.847e-3 -> 1.144e-5` (161x).

So: **N octaves of `basis_noise` sharing ONE (seed0, seed1)**. Each octave halves
the input scale (lacunarity 1/2) and is weighted by a power of the per-tile
persistence, combined in Horner order - finest octave (k=0) gets the smallest
weight `p^(N-1)`, coarsest (k=N-1) gets `1`. The whole sum is scaled by
`output_scale * 2^N`. Verified to **1.1e-5 worst over all 266 oracle samples**,
and that residual is `basisNoise`'s own f32 floor amplified by the gain rather than
a modelling gap: `worst/gain` is **1.2e-7 to 2.4e-7 - one to two f32 ulps - in
every one of the seven cases**, including those with `offset_x` of 5000 and 40000.
The old "grows to ~2e-3 at large offset_x / far points" was the alias, not a floor.

Two things distinguish it from the plain / quick relatives:

1. **No RMS normalisation.** It is the raw weighted sum times a `2^N` gain. The
   `amplitude_corrected_multioctave_noise` Lua wrapper is what normalises, by
   passing `output_scale = (1 - p)/2^N/(1 - p^N) * amplitude`. (The
   `sqrt((p^2-1)/(p^(2N)-1))` RMS branch that *is* present in the
   `Noise::multioctaveNoise(...,float const*,...)` float overload @0x101734884 is a
   **different entry point**; the register `run` path @0x10174a318 that
   `calculate_tile_properties` - and thus the oracle - executes has none. The
   oracle is ground truth, so: no norm.)
2. **`offset_x` is a single world-space x translation** `(x + offset_x)*scale`,
   applied identically to every octave - like `quick_multioctave_noise`. The plain
   op has such a translation too, *plus* a per-octave `k*17.17` noise-space shift;
   this op has no per-octave shift at all.

Octaves here decorrelate through lacunarity alone - not by re-seeding (the seed is
shared, confirmed with seed1=999 and 256; the quick op's seed-phase reseed trick
does not apply) and not by any x shift.

## Why these pieces (the disassembly)

`VariablePersistenceMultioctaveNoise::run` builds a register program: an initial
input scale (`s8`, halved each octave via `fmov s9,#0.5; fmul s8,s8,s9`), an octave
count, and per octave a `Noise::noise` (one basis octave) whose output accumulates
into an output register. Between octaves the output register is multiplied
element-wise by the **persistence register** (`fmul v.4s, v.4s, v.4s` over the
per-tile buffer) - Horner: `out = out*p + basis_k`. The final octave multiplies by
a scalar constant (`output_scale * 2^N`) instead of the persistence buffer. The
loop passes the SAME seeds/offset constants every octave (only the scale changes),
which is why octaves share a seed and the only per-octave x change is the fixed
shift. The float overload @0x101734884 shows the same Horner + the (unused-here)
RMS-norm tail, and its per-octave x term uses the `0x40312b8551ec1eb8 = 17.17000305`
double - the same core constant as the plain op.

## How the constants were pinned (oracle fitting)

Structure from the disassembly; numbers from the oracle. The op's `persistence`
must be a genuine expression (a **constant** persistence hits a degenerate compile
path), so the fit routes an expression persistence onto elevation AND captures that
persistence field separately (route the same expression onto elevation), then fits
with the per-tile `p_i`. Decisive experiments:

| claim | test | result |
| --- | --- | --- |
| octaves=1 == 2*basis at IS/2 | N=1, offset_x=0 | `2*basis(x*IS/2)`, floor (1.8e-7) |
| output_scale linear | ratio at os=3 | 3.00000 |
| no normalisation | N=2 free fit, norm on vs off | norm OFF wins to floor; norm ON res 0.22 |
| gain = 2^N | fitted C at N=1..6 | 2, 4, 8, 16, 32, 64 |
| lacunarity 1/2, weight p^(N-1-k) | N=2 fit: octave-1 scale + weight | S_1=IS/4, Horner `[p,1]`, floor |
| ~~per-octave shift = k*(-7936)~~ | wide U scan, N=2..4 | -7936 exactly, res floor - **REFUTED, an alias of 0** |
| ~~shift is input-scale-independent~~ | same fit at IS in {1/8,1/16,1/64} | -7936 all three - it is period-independent, which is not the same thing |
| ~~shift is seed-independent~~ | seed1=999 | -7936 |
| offset_x = world translation | N=1 offset_x=5000 | `(x+offset_x)*(IS/2)`, floor (2.2e-7) |

## The shift was an ALIAS of zero (2026-08-05)

**This section replaces "The f32 floor", which attributed the residual to a
precision limit. There was no shift to be imprecise about.**

The three struck rows above, and the "trap" the notes recorded, are all one thing.
The scan reported `-7936`, and warned that a *narrow* scan finds "false minima" at
`-4864` and `-3840`. Every one of those numbers is a multiple of 256:

```
-7936 = -31*256      -4864 = -19*256      -3840 = -15*256
```

The basis lattice has period **256** per axis, so all of them - and `0` - name the
same field. There were never any false minima; the fit direction was completely
flat, and "the true value only holds up under a wide scan" was picking one
arbitrary representative out of infinitely many. The independence checks
(input-scale, seed, offset_x, persistence) could not discriminate either, because
the *period* is independent of all of those.

`VariablePersistenceMultioctaveNoise::run` settles it: the octave loop reloads the
x and y offsets from the same two constant slots (`+0xa2c`, `+0xa30`) on every
iteration and contains **no counter-scaled term at all**. The shift is zero.

Removing it changes nothing in f64 (measured: identical worst, identical
f32-exact count) and everything in f32:

| variant | worst | f32-exact |
| --- | --- | --- |
| f64, shift -7936 (the old shipped code) | 1.847e-3 | 61/266 |
| f64, no shift | 1.847e-3 | 61/266 |
| f32 op order, shift -7936 | **3.629e-1** | 45/266 |
| **f32 op order, no shift** | **1.144e-5** | 66/266 |

Note the third row: reproducing the game's arithmetic *with* the alias is nearly
**200x worse than doing nothing**, because `k*(-7936)` at octave 5 lands near
-39680 where an f32 ulp is ~3.9e-3. Exactly the pairing found in the plain op
(`multioctave-noise-NOTES.md`) - neither half of the fix is an improvement alone.

## amplitude_corrected_multioctave_noise (the wrapper)

`core/prototypes/noise-functions.lua` defines it as a thin wrapper over this op:

```
variable_persistence_multioctave_noise{
  input_scale  = input_scale,
  output_scale = (1 - persistence) / 2^octaves / (1 - persistence^octaves) * amplitude,
  offset_x = offset_x, octaves = octaves, persistence = persistence }
```

i.e. it just chooses `output_scale` to normalise the op's `2^N`-gained geometric
sum to the requested `amplitude` (note the `1 - p^N` -> geometric-series sum, and
the `/2^N` cancelling the op's gain). A `p == 1` guard (0/0) belongs in the wrapper
port, not the primitive. Port it once this primitive ships - no new RE needed.
