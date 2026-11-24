# expression-in-range-form

Asks which f32 form of `expression_in_range` the game evaluates (#521).

```bash
node --experimental-strip-types scripts/probes/expression-in-range-form/capture.ts
```

Run it from the repository root. It needs `factorio-oracle` in `~/.cargo/bin`
and the Factorio 2.1.23 headless build. It looks for the build at
`/home/eric/factorio-headless/2.1.23/factorio`, and `FACTORIO_2_1_23` points it
somewhere else. It takes about 10 seconds and writes nothing to the repo.

## What it does

It reads the game's own values at the last differing Nauvis pixel, (229, -19),
and the 8 tiles around it: `aux`, `moisture`, `elevation`, the four grass
tiles' noise layers, and their tile scores. It uses the same settings as the
preview PNG: map seed 123456, the terrain-only mod, and the disableable
controls at size 0.

Then it rebuilds each grass score from the game's own inputs, two ways:

- **edge form:** `min(value - from, to - value)` per dimension. The port used
  this until #521.
- **center form:** `half - |value - center|` per dimension, with `half` and
  `center` worked out from the range first. This is what the 2.1.23 binary's
  `NoiseExpressions::expressionInRange` builds, read with Ghidra.

The two are equal in exact math. Because every input is the game's own, only
the form can make them differ, so the check can fail either way.

## Result (2026-11-24, 2.1.23 build 87750)

| form   | exact of 36 |
| ------ | ----------: |
| center |      **36** |
| edge   |          11 |

The game's inputs at (229, -19) also matched the port's exactly, so the form
was the whole gap. With the center form, the Nauvis terrain preview matches
the game on all 1,048,576 pixels.
