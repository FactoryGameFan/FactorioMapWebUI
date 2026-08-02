# `multisample` - reverse-engineering notes

The native Factorio builtin `multisample(expression, offset_x, offset_y)` has
no Lua source - it feeds Vulcanus's `vulcanus_basalt_lakes_multisample` (used by
`vulcanus_elev`, `core/prototypes/planet/planet-vulcanus-map-gen.lua`):

```
vulcanus_basalt_lakes_multisample = min(multisample(vulcanus_basalt_lakes, 0, 0),
                                         multisample(vulcanus_basalt_lakes, 1, 0),
                                         multisample(vulcanus_basalt_lakes, 0, 1),
                                         multisample(vulcanus_basalt_lakes, 1, 1))
```

Recovered from the headless oracle (`test/oracle/capture.ts multisample`,
fixture `test/fixtures/oracle-multisample.seed123456.json`, seed 123456).

## The game's own doc text (not previously read for this project)

`auxiliary/noise-expressions.html` (2.1.12 bundled docs, not previously grepped
for `multisample`):

> Evaluates the expression in a separate noise program with a larger grid.
> Sub-grids are copied to the main program. This means that sub-expression
> results of the given expression are not reused between the main noise
> program and the multisampling program. Repeated calls of this function with
> different offsets will be batched together as long as `expression` is the
> same.
>
> Parameters: `expression` (Number-returning Expression), `offset_x` (Number;
> constant 8-bit signed integer), `offset_y` (Number; constant 8-bit signed
> integer).

Also: the game's changelog records a relevant bug history -
`2.0.67`: "Fixed multisample noise operation not working properly for
LuaSurface.calculate_tile_properties()." The installed binary is 2.1.12, and
`~/GitHub/factorio-data` (tag 2.1.11) confirms the fix landed well before that,
so `calculate_tile_properties` (what the oracle harness uses) is a valid
channel for this primitive - unlike whatever the pre-2.0.67 bug broke.

The doc text describes an *implementation* detail (expressions built from bare
global `x`/`y` variables have no way to be "called at a different point" from
within the same expression graph, so the engine re-runs the sub-expression on a
grid shifted by the requested offsets and copies the result back) - not
necessarily "supersampling" in the anti-aliasing sense the task brief
speculated. The oracle data below settles which one it actually is.

## Derived rule

```
multisample(expression, dx, dy) at (x, y) == expression evaluated at (x + dx, y + dy)
```

A **plain integer coordinate shift**, not a half-tile supersample. Confirmed
`dx`/`dy` act identically and independently on `x` and `y` respectively (no
cross term), and hold at every tested magnitude, not just `{0, 1}`.

So the Vulcanus `vulcanus_basalt_lakes_multisample` line is exactly a 2x2
min-filter (an erosion / anti-flooding operator) over the basalt-lakes field at
integer-tile neighbors `(x,y), (x+1,y), (x,y+1), (x+1,y+1)` - not a
resolution-doubling supersample. "Sub-grids are copied to the main program" in
the doc text is describing how the engine re-evaluates `vulcanus_basalt_lakes`
(a closure over global `x`/`y`) at shifted coordinates without re-deriving the
whole compiled program per call - an implementation detail, not a different
sampling semantics. "Batched together" matches: all four calls share the same
`expression` (`vulcanus_basalt_lakes`) and differ only in `(dx, dy)`.

## Evidence

The inner-expression trick worked directly and needed no fallback: routing the
*bare* `x` and `y` variables (not a derived combination like `x + 0.001*y`) as
the `multisample` argument makes the returned number literally BE the sampled
world coordinate - no inversion, no ambiguity between the two axes.

Sampled independently for `x` and `y`, at 5 base points (fractional, negative,
far-from-origin: `(0.5, 0.25)`, `(10.5, -20.25)`, `(-5.25, 7.75)`,
`(100.125, -300.875)`, `(1234.5, -4321.5)`), crossed with 15 `(dx, dy)` pairs:
the real Vulcanus usage (`{0,1}x{0,1}`), an extended axis-aligned sweep
(`dx`/`dy` independently at `-2, -1, 0, 1, 2, 3`) to rule out any nonlinearity
or scale factor other than 1, and a handful of off-axis combos
(`(2,3), (-1,2), (3,-2)`) to rule out a cross term between the two axes.

A sample of the raw fixture (`test/fixtures/oracle-multisample.seed123456.json`),
base point `(100.125, -300.875)`:

| `(dx, dy)` | `sampledX`  | `x + dx`  | `sampledY`  | `y + dy`  |
|------------|-------------|-----------|-------------|-----------|
| (0, 0)     | 100.125     | 100.125   | -300.875    | -300.875  |
| (1, 0)     | 101.125     | 101.125   | -300.875    | -300.875  |
| (0, 1)     | 100.125     | 100.125   | -299.875    | -299.875  |
| (1, 1)     | 101.125     | 101.125   | -299.875    | -299.875  |
| (-2, 0)    | 98.125      | 98.125    | -300.875    | -300.875  |
| (3, 0)     | 103.125     | 103.125   | -300.875    | -300.875  |
| (0, -2)    | 100.125     | 100.125   | -302.875    | -302.875  |
| (2, 3)     | 102.125     | 102.125   | -297.875    | -297.875  |
| (3, -2)    | 103.125     | 103.125   | -302.875    | -302.875  |

Every one of the 15 offsets x 5 points x 2 axes = 150 comparisons matches
`x + dx` / `y + dy` exactly (see verification below) - `sampledY` never moves
under a change to `dx` alone, and vice versa, ruling out any cross term.

## Residuals

Worst absolute residual of `(x + dx, y + dy)` vs. the oracle, over ALL 150
comparisons: **0** (bit-for-bit exact, computed via plain `Number` addition in
Node against the raw fixture values - not merely "under the f32 floor" the way
other primitives land, but literally zero). This is expected: unlike the
octave/basis primitives, there is no noise math here at all, just a coordinate
substitution before re-running the (already f32-exact) inner expression - the
f32 noise, if any, is entirely inside whatever `expression` itself computes,
not in `multisample`'s own offset logic.

## Port

`src/noise/eval/multisample.ts`:

```ts
export function multisample(
  sampleAt: (x: number, y: number) => number,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number {
  return sampleAt(x + dx, y + dy);
}
```

Task 9 (`vulcanus_elev`) is expected to call this as:

```ts
const multisampled = Math.min(
  multisample(sampleBasaltLakes, x, y, 0, 0),
  multisample(sampleBasaltLakes, x, y, 1, 0),
  multisample(sampleBasaltLakes, x, y, 0, 1),
  multisample(sampleBasaltLakes, x, y, 1, 1),
);
```

where `sampleBasaltLakes` is the `vulcanus_basalt_lakes` expression port,
called at 4 integer-shifted neighbor points and combined with `Math.min` (the
`min(...)` in the Lua source, not part of `multisample` itself).

## AMENDED 2026-08-01: the offsets are in GRID UNITS, not tiles

Everything above is correct **for the channel it was measured in**, and that
qualification turned out to matter more than the result.

`sampleExpression` reads values back through `LuaSurface.calculate_tile_properties`,
whose noise program has a **1-tile grid**. In that channel `dx = 1` shifts by one
tile and the derived rule `multisample(e, dx, dy) == e(x + dx, y + dy)` holds
exactly, as the 150/150 residual-zero table shows.

It does not hold anywhere else. Measured through the **cliff generator**, whose
program walks the 4-tile corner lattice (`test/oracle/capture.ts multisample-grid`,
`test/multisampleGrid.spec.ts`): a probe routed onto `cliff_elevation` with the
placement rule collapsed puts its contour in one cell column, and

| probe | column | |
| --- | --- | --- |
| `x` | 70 | baseline |
| `multisample(x, 0, 0)` | 70 | identity |
| `multisample(x, 4, 0)` | **54** | shifted **16 tiles**, not 4 |
| `multisample(x, 0, 4)` | 70 | null control |

So the true rule is

```
multisample(e, dx, dy) at (x, y) == e(x + dx * G, y + dy * G)
```

where `G` is the **grid step of the noise program doing the calling** - 1 for
`calculate_tile_properties` and the tile renderer, 4 for cliff placement. The
doc text quoted above says exactly this and was read as an implementation note:
"evaluates the expression in a separate noise program with **a larger grid**".

The consequence for this port: `vulcanus_basalt_lakes_multisample`'s `min` over
`{0,1}x{0,1}` is a 1-tile min-filter for tiles and a **4-tile** one for cliffs.
`min` is erosion, so the cliff channel's elevation is markedly smoother. Using
the 1-tile field for cliffs was issue #18's root cause; see the top of
`docs/noise/cliffs-NOTES.md` for the numbers.

**The methodological point.** The measurement here was right, thorough and
non-vacuous - 150 comparisons, residual exactly zero, cross-terms ruled out - and
it still supported a false generalisation, because every one of those comparisons
came through one channel. A primitive documented as depending on the calling
program's grid cannot be characterised from a single caller. When adding an
oracle for a primitive, ask what varies between its CONSUMERS, not only what
varies in its arguments.
