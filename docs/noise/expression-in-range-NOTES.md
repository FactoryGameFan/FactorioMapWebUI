# `expression_in_range` - reverse-engineering notes

The native Factorio builtin
`expression_in_range(peak_multiplier, peak_maximum, expr_1..N, from_1..N, to_1..N)`
has no published formula. It was recovered from the headless oracle
(`test/oracle/capture.ts expression-in-range`, fixture
`test/fixtures/oracle-expression-in-range.seed123456.json`, seed 123456).

Arg order per the game docs (and confirmed by the probes): `peak_multiplier`,
`peak_maximum`, then ALL exprs, then ALL froms, then ALL tos. So the 2-D probe is
`expression_in_range(pm, pmax, expr1, expr2, from1, from2, to1, to2)`.

## The game's form (read from the binary, #521)

The formula below was derived from oracle sweeps and is right in exact math.
**In f32 it is not the game's.** `NoiseExpressions::expressionInRange` in the
2.1.23 binary (file 0x1542990, read with Ghidra) builds each dimension from two
folded constants:

```
half_i   = (to_i - from_i) * 0.5          folded in f64, held as f32
center_i = (from_i + to_i) * 0.5          folded in f64, held as f32
d_i      = half_i - |value_i - center_i|   every step f32
d_i      = d_i * peak_multiplier           (skipped when it is 1)
d_i      = min(d_i, peak_maximum)          (skipped when it is +inf)
result   = min over dims of d_i, starting from +inf
```

`value - center` subtracts a far-away center, so it rounds differently from
`value - from`. At the last differing Nauvis pixel, (229, -19), this form
reproduced the game's grass scores at all 36 values in a 3x3 around it, and
the edge form below matched 11. It took the Nauvis terrain count from 1 to 0.
The sweeps below could not see it: their ranges are centred on 0 or have
exact f32 bounds, where the two forms agree.

## Derived formula (exact-math form)

```
m      = min over all dims i of min(value_i - from_i, to_i - value_i)
result = min(peak_maximum, peak_multiplier * m)
```

- Per dimension, `min(value - from, to - value)` is the signed distance to the
  nearer edge of `[from, to]`: positive inside the range, exactly 0 on an edge,
  negative outside.
- Combining dimensions with `min` makes the N-D box a hard AND: any single dim out
  of range pulls the whole result down (it becomes the binding term).
- `peak_multiplier` is the falloff slope (per unit of edge distance).
- The plateau is clamped from above at `peak_maximum`. There is NO lower clamp -
  outside the range the value falls linearly without bound (reaches
  `-peak_multiplier * distance`).
- `peak_maximum = Infinity` leaves the plateau uncapped, so in-range values exceed
  1 (this is what lets sand-1's coastal term win over land tiles that top out near
  1). The implementation must not clamp that case.

## Evidence

Three oracle sweeps (each probe routed onto `elevation`, sampled via
`calculate_tile_properties`):

### 1-D bounded, `(pm=20, pmax=1)`, `expr = x/1000`, range `[-0.5, 0.5]`

Sweep `x` from -1500 to 1500 (step 25). Observed:

- Inside `[-0.5, 0.5]`: value is exactly `1` (= `peak_maximum`; the raw peak
  `20 * min(...)` reaches 10 at center and is clamped to 1).
- On the edges (`expr = ±0.5`): value `0`.
- Just outside (`expr = -0.475`): `0.5` = `20 * min(0.025, 0.975)`. This fixes the
  slope at `peak_multiplier`.
- Far outside (`expr = -1.5`): `-20` = `20 * min(-1.0, 2.0)`. Confirms no lower
  clamp.

### 1-D unbounded, `(pm=5, pmax=inf)`, same range

Identical triangular shape but with NO upper clamp: peak reaches `2.5` at center
(`5 * 0.5`), confirming the `peak_maximum = inf` branch. The parity test asserts the
in-range max exceeds 1.

### 2-D combination, `(pm=20, pmax=1)`, both ranges `[-0.5, 0.5]`

The fixture's `twoD` sweep (`test/fixtures/oracle-expression-in-range.seed123456.json`)
has two families: hold `expr1 = x/1000 = 0.2` (intermediate, in range) and sweep
`expr2 = y/1000` across and beyond its range; plus a diagonal `x = y` sweep where
both axes vary together. Only the diagonal is decisive - the held-`x` family is
confirmatory but does NOT by itself distinguish the candidates, because `x = 0.2`
saturates: its per-dim raw peak is `20 * 0.3 = 6`, clamped to `peak_maximum = 1`
before it can combine with anything, so at that saturation `min` and a
"product-of-clamped-per-dim-peaks" rule happen to agree.

The diagonal points (both dims at the same, non-saturated, intermediate edge
distance) are what actually pin the rule. Reading the fixture at `x = y = 475` and
`x = y = 525` (edge distance `±0.025`, well inside the linear, unclamped region):

| `x = y` | edge distance | oracle (fixture)      | `min` | `product` | `sum`  |
|---------|----------------|-----------------------|-------|-----------|--------|
| 475     | +0.025         | `0.5000001192092896`  | 0.5   | 0.25      | 1.0    |
| 525     | -0.025         | `-0.4999995231628418` | -0.5  | +0.25     | -1.0   |

(`product` and `sum` here are `(pm * ed_x) * (pm * ed_y)` and `(pm * ed_x) + (pm *
ed_y)` respectively, evaluated before any `pmax` clamp - the same construction as
the held-`x` table below.)

`min` matches both points; `sum` is wrong at both. `product` is wrong at `x=475`
and, decisively, at `x=525` it produces a **sign flip**: two symmetric
out-of-range edge distances (`-0.025` on each axis) multiply to a *positive*
`+0.25`, while the oracle stays negative (`~-0.5`). No product-style rule can
reproduce a value that stays negative when both inputs are negative - this single
point eliminates every product variant. `sum` is separately falsified by its own
magnitude mismatch throughout.

Against the held-`x` family (confirmatory only, since `x` saturates), the three
candidates predict (before the `pmax` clamp):

| `ey`   | oracle | `min` | `product` | `sum` |
|--------|--------|-------|-----------|-------|
| -1.000 | -10.0  | -10.0 | -60.0     | -4.0  |
| -0.750 |  -5.0  |  -5.0 | -30.0     |  1.0  |
| -0.525 |  -0.5  |  -0.5 |  -3.0     |  1.0  |

`min` matches exactly here too; `product` and `sum` diverge by wide margins. The
N-D rule is `min` across dimensions, and the diagonal `x=525` sign flip is the
single strongest piece of evidence for it.

## Residuals

Worst absolute residual of the derived formula vs. the oracle, over ALL points of
all three sweeps: **9.5e-7** (at `x = -1300` in the bounded 1-D sweep). This is pure
f32 noise from the game's pipeline - the formula is exact. Parity bound in
`test/expressionInRange.spec.ts` is the standard `8e-3` elevation f32 floor; the
observed worst sits ~4 orders of magnitude under it.

## Port

`src/noise/tiles/expressionInRange.ts`:

```ts
export function expressionInRange(
  peakMultiplier: number,
  peakMaximum: number,
  values: number[],
  froms: number[],
  tos: number[],
): number {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) {
    const edgeDistance = Math.min(values[i] - froms[i], tos[i] - values[i]);
    if (edgeDistance < m) m = edgeDistance;
  }
  return Math.min(peakMaximum, peakMultiplier * m);
}
```
