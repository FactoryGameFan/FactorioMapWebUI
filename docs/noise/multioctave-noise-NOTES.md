# multioctave_noise - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962), cracked two ways at once - by
disassembling `Noise::multioctaveNoise` in the non-stripped shipped Mach-O (the
same binary that gave up `basis_noise` and `spot_noise`), and by fitting the
output of the committed oracle (`test/oracle/`). Reference implementation:
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
multioctave(x, y) = output_scale * norm * SUM_{k=0}^{N-1} (1/P)^k *
                    basis( x*IS*(1/2)^k + k*OFFSET , y*IS*(1/2)^k )

  N       = octaves
  P       = persistence
  IS      = input_scale          (noise units per world tile, finest octave)
  OFFSET  = -1774.83             (per-octave x shift in NOISE space; see below)
  norm    = sqrt( ((1/P)^2 - 1) / ( fastpow((1/P)^2, N) - 1 ) )
  basis   = basis_noise with tables from (seed0, seed1)  [basis-noise-NOTES.md]
```

So: **N octaves of `basis_noise` that all share ONE `(seed0, seed1)`**. Each
octave halves the input scale (lacunarity 1/2), multiplies amplitude by `1/P`, and
shifts x by a fixed per-octave offset. The offset is the whole trick for
decorrelating same-seed octaves - it is the "'x' variables are shifted to avoid
'fractal similarity'" comment at the top of the game's noise programs, made
concrete. The sum is RMS-normalised by `norm` so its variance stays ~1 across
octave counts and persistence.

Verified to ~3e-5 in a realistic preview window (grows to ~1e-4 at extreme
coordinates - the f32 floor, see below), across octaves 1..6, persistence
0.45..0.9, varied input/output scales and three seeds.

## Why these pieces (the disassembly)

`Noise::multioctaveNoise(float x, float y, uint seed0, uint seed1, float, float,
float, float, float persistence, NoiseScratch&, float*)` is a single tight loop
(`w24` = octave count, decremented per iteration) that calls `Noise::noise` (one
`basis` octave) each pass. Read straight off the arm64:

- **Same seed every octave.** `seed0` (x22) and `seed1` (x21) are loaded once and
  passed unchanged into every `Noise::noise` call. Octaves decorrelate purely
  through the coordinate change, not through re-seeding.
- **Lacunarity 1/2.** The per-octave input-scale register is multiplied by `0.5`
  each pass (`fmov s0,#0.5 ; fmul s12,s12,s0`).
- **Amplitude `*= 1/P`.** The amplitude register is multiplied by `1/persistence`
  each pass (`s13 = 1/P`, `fmul s9,s13,s9`). `1/P` is an exact reciprocal.
- **Per-octave x offset.** The x fed to `Noise::noise` is
  `scaledX + (k * C) / param6`, computed in double then `fcvt`-ed to f32, where
  `k` is the loop counter (starts 0, so octave 0 is unshifted) and `C` is the
  double constant `0x40312b8551ec1eb8 = 17.17000305`. For the plain op's default
  `param6` this works out to a fixed **-1774.83 per octave**, independent of
  input_scale, seed and persistence (all confirmed by fitting - see below). y is
  never shifted.
- **The normalisation.** Reached whenever `P != 1` (so for *every* octave count,
  including N = 1): `sqrt( ((1/P)^2 - 1) / ( exp2(log2((1/P)^2) * N) - 1 ) )`,
  times `output_scale`. The `(1/P^2)^N` power is done with the game's approximate
  `Math::log2` / `Math::exp2f` (Paul Mineiro fastapprox), so `norm` is not exactly
  1 even at N = 1 - it carries a fastapprox wobble that a `return 1` shortcut would
  get measurably wrong. For `P == 1` the ratio is 0/0 and the game instead uses
  `1/sqrt(N)`.

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
| offset = k*(-1774.83), IS-independent | fit U at IS in {0.0625,0.125,0.25} | -1774.83 all, res ~3e-7 |
| norm uses fastapprox pow | P=0.9 residual real vs fast pow | 6.7e-5 -> 2.9e-6 (pre-`9b49ebb`, see above) |
| full model | 6 configs x realistic points | < 5e-5 |

## The f32 floor

The remaining error is not a modelling gap, it is precision. The game computes
each octave's coordinate and rounds it to f32 before sampling basis; we evaluate
in f64. Because the per-octave offset (`k * -1774.83`, up to ~-8900 at 6 octaves)
makes the coordinate large, a f64-vs-f32 coordinate difference of ~1e-4 tiles can
land in a different basis lattice cell and change the value by ~1e-4. In a
realistic preview window this stays ~3e-5; only at extreme coordinates
(thousands of tiles out) does it reach ~1e-4. Naively `fround`-ing the composed
coordinate makes it *worse* (the game's exact f32 op order differs), so it is left
in f64 - correct to the noise floor where a preview actually samples. Bit-exactness
is explicitly not the goal (see the roadmap).

## The offset_x parameter (plain op default = -1774.83)

The per-octave x shift is `k * 17.17000305 / offset_x`, and the plain op's fixed
-1774.83 is just its default `offset_x`. Confirmed from the disassembly (the
`0x40312b8551ec1eb8 = 17.17000305` double, divided by the offset_x register). NOTE
the two relatives split on offset semantics:

- **plain / variable_persistence**: per-octave shift `k * 17.17000305 / offset_x`
  (offset_x large -> tiny shift). Same `fdiv`-by-offset_x in both cores.
- **quick_multioctave_noise**: `offset_x` is instead a single world-space translation
  `(x + offset_x) * scale`, applied identically to every octave; quick decorrelates
  octaves by re-seeding, not by an x shift. See `quick-multioctave-noise-NOTES.md`.

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
