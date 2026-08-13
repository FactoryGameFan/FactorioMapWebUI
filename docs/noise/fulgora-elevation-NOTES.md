# Fulgora elevation - measured findings

Working notes for the Fulgora port (issue #27). **Every claim here states how it
was measured.** A stated cause with no stated measurement is a hypothesis, not a
finding - that rule exists because an earlier NOTES file in this repo recorded
five guesses as findings and all five were later falsified.

Source Lua: `~/GitHub/factorio-data/space-age/prototypes/planet/planet-fulgora-map-gen.lua`.

**Version:** ported against **2.1.14**. The map-gen Lua is byte-identical
2.1.12 -> 2.1.14 - checked as an empty `git diff` over
`space-age/prototypes/planet/`, `core/prototypes/noise-programs.lua`,
`core/prototypes/noise-functions.lua` and `base/prototypes/noise-expressions.lua`,
not inferred from a changelog.

---

## Task 7: the shared layer (`fulgoraShared.ts`)

Lua lines 22-124. Fixture: `test/fixtures/oracle-fulgora-shared.seed123456.json`,
101 positions, seed 123456. Spec: `test/fulgoraExpressions.spec.ts`.

### `fulgora_grid` is NOT an integer - the plan's assumption is refuted

`fulgora_grid` is `175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)`.
The implementation plan carried an open question: the Voronoi primitive documents
`grid_size` as a 16-bit **unsigned integer**, so does the game truncate, round,
or never produce a fraction?

Measured by sampling `175 - slider_to_linear(<s>, -50, 50)` on a real Fulgora
surface at five slider positions:

| frequency | grid | integer? |
| --- | --- | --- |
| 0.5 | 194.34263610839844 | no |
| 1 (default) | 175 | **yes** |
| 2 | 155.65736389160156 | no |
| 3 | 144.3426513671875 | no |
| 6 | 125 | **yes** |

It is integral only at the two slider **endpoints**, where `log2(s)/log2(6)` is
exactly 0 and 1. That is a property of those positions, not of the expression.
So `fulgora_grid` is a genuine float and the port keeps it one.

Whether the **Voronoi call** then truncates it to a u16 is a different question,
about `grid_size` rather than about this expression, and it belongs to the cell
layer (Task 8). It is **open**. Do not assume the answer from this row.

### `slider_to_linear` is f32 per-operation, and only `s = 3` can prove it

An f64 chain rounded once at the end reproduces four of the five values above
and misses `s = 3` by exactly one f32 ulp (144.34263610839844 against the game's
144.3426513671875). Rounding **every operation** to f32 matches all five exactly.

Measured, all five positions, worst |diff| at f32:

| evaluation order | worst |
| --- | --- |
| f64 throughout, one final round | 1.526e-5 |
| f32 on the log2 ratio only | 1.526e-5 |
| f64 throughout, rounded at the end | 1.526e-5 |
| **f32 per operation** | **0** |

**The sweep design is the finding here, not just the answer.** The other four
probes cannot see the difference: 0.5, 1 and 2 have power-of-two numerators, and
at `s = 6` the ratio is exactly 1 whatever `log2(6)` evaluates to. A four-point
sweep that skipped 3 would have "confirmed" the f64 form. This is the third time
in this repo an f32-vs-f64 detail has hidden behind a sweep that happened to
avoid the one discriminating input (cf. #165, #166, #167).

`sliderToLinear` in `src/noise/eval/math.ts` was changed to f32 for **all**
callers. Nauvis's moisture use is unaffected because its default size is 1, so
`log2(1) = 0` is exact either way - which is what the function's own comment had
predicted would eventually matter.

### `log2` is EXACT, not fastapprox - tried and refuted

The obvious suspect for the `s = 3` miss was the game's fastapprox `Math::log2`.
It is wrong: `fastLog2` misses **all five** values, and breaks the exact 175 at
the default `s = 1` (it gives 175.00004611664207). `slider_to_linear` is
evaluated on the prototype side rather than by the noise machine, so
`Math::log2` never enters it. Keep `Math.log2`.

### Agreement with the game, per field

Worst |diff| at f32 over the 101 fixture positions:

| field | worst | note |
| --- | --- | --- |
| `ox`, `oy` | **0** | exact |
| `startingMask`, `startingVaultMask` | **0** | exact (booleans) |
| `startingCone` | 1.12e-7 | |
| `wobbleMask` | 5.74e-7 | |
| `wobbleInfluence` | 7.15e-7 | |
| `startingVaultCone` | 8.05e-7 | |
| `wobbleX`, `wobbleY` | 3.81e-6 | `output_scale` = `grid * 0.07` = 12.25 |
| `wx`, `wy` | 1.53e-5 | compounds the above with a coordinate up to 15000 |

The non-zero rows are the port's known `basisNoise` floor - it evaluates in f64
where the game uses f32 - scaled by each field's own `output_scale`. `wobbleX`'s
3.81e-6 is ~3.1e-7 relative, the same order as the ~7.2e-7 documented for
`basisNoise` elsewhere. **Nothing here is Fulgora-specific**, and none of it
will improve until `basisNoise` itself moves to f32.

### The fixture's coordinates must be on the 1/256 grid

`ox` is literally `x + grid/2`, so it can only agree exactly if the port and the
game evaluate the same point. The first capture used ring positions like
`r * cos(a) + 0.5`, which are not multiples of 1/256; Factorio stores a
MapPosition as 1/256-tile fixed point, so the game sampled a **different point**
and `ox` came back out by exactly 1/256 (3.906e-3). That reads as a porting bug
and is not one.

The capture now snaps every coordinate to a quarter tile. `ox`/`oy` going exact
is the alignment check - if they ever stop being exact, suspect the fixture's
coordinates before suspecting the port.

### Two plants confirm the spec discriminates

- **Swapping the `fulgora_wobble_x`/`_y` seed constants** fails 6 tests,
  including both cones and both masks. The x/y asymmetry really does come from
  the seed alone - the two calls are otherwise identical.
- **Dropping the tight cone's `0.25` distortion damping to 1** fails exactly one
  test, `startingCone`, by 4.9e-2 against a 2e-7 bound, at (0.5, 0.25) - right
  at spawn, which is the only place that second disc matters.

### Seed constants

The game hashes a string `seed1` with a standard CRC32, resolved once and
hardcoded the way `nauvisShared.ts` does it:

| string | value |
| --- | --- |
| `fulgora_wobble_x` | 686434221 (0x28EA27AD) |
| `fulgora_wobble_y` | 1609373499 (0x5FED173B) |

`fulgora_wobble_influence` uses a numeric `seed1 = 1`, not a string.
