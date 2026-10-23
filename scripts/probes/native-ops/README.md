# native-ops

Captures the game's own values for the native noise ops that Gleba and Aquilo
need, so Stage 2 can grade a Rust port bit for bit.

```bash
node --experimental-strip-types scripts/probes/native-ops/capture.ts
```

Run it from the repository root. It takes about 5 seconds. It runs 2.1.23 and
2.0.77, refuses to write on any bit difference, and writes
`test/fixtures/oracle-native-ops.json`. Both installs are passed with
`--factorio` and `--version`, and the script checks the report's `buildLine`.

## What it reads

13 named noise expressions, each sampled through
`calculate_tile_properties` at the same 1,024 positions (x in [-4096, 4096],
y in [-512, 512], all on the 1/256 grid, with `(0, 0)` and both corners forced
in). They do not depend on the planet or the seed, so the surface is plain
Nauvis. Every result is stored as the hex of its f32 (`bits`) and as the
shortest decimal that reads back as the same f32 (`values`).

| group                                   | expressions                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| trig, the whole value                   | `sin(x / 64)`, `cos(x / 64)`, `sin(x * 13.37)`, `cos(y * 0.731)`               |
| terrace, `value = x / 10`, `width = 20` | offset 40 with strength 0.2, 0, 0.5, 0.95; strength 0.2 with offset -7.5 and 0 |
| exponent 0.5 on `abs(x) + 0.001`        | `pow(..., 0.5)`, `(...) ^ 0.5`, `sqrt(...)`                                    |

The game accepted every expression, so none was dropped. `sqrt` exists, and
`terrace{...}` takes a non-constant `value`.

## What it found

- **The two versions agree.** All 13 x 1,024 values are bit-identical between
  2.1.23 and 2.0.77.
- **The three pow spellings are bit-identical** at every position, as the
  disassembly of `Folding::pow` (`0x1540ca0`) predicted: `pow(x, 0.5)`,
  `x ^ 0.5` and `sqrt(x)` give one answer.
- **That answer is an exact f32 sqrt.** `fround(sqrt(fround(fround(|x|) +
  fround(0.001))))` matches 1,024 of 1,024. Do the add in f32 before the root.
- **Terrace matches the disassembled formula at every position**, all six
  rows, 1,024 of 1,024, in plain f32: `t = (v - off) / w`, `f = floor(t)`,
  `frac = t - f`, `up = s < frac ? (frac - s) / (1 - s) : 0`,
  `result = (up + f) * w + off`, with `v = x / 10` also narrowed to f32 and
  `s`, `off`, `w` narrowed constants. Using a reciprocal in place of either
  divide loses matches, so the divides are real divides.
- **The game's trig is not f64 `sin` narrowed to f32.** `fround(Math.sin(fround(arg)))`,
  with the argument built in f32, matches only 964 to 987 of 1,024 per row
  (94% to 96%). The misses are 1 ULP (5.96e-8 near 1). That is all this data
  shows. Why it differs comes from the disassembly, not from here:
  `UnaryOperation<25,sin>::run` at `0x2525620` in the 2.1.23 binary is a
  polynomial with its own range reduction, not a libm call (see the design
  spec, `docs/superpowers/specs/2026-10-22-gleba-and-aquilo-design.md`). A port
  that calls libm would fail about 5% of the time; the fixture's trig rows
  exist to catch that. The `sin(x * 13.37)` row reaches arguments near 55,000,
  which also exercises the range reduction.

These numbers come from a throwaway check, not from a committed spec. Stage 2
owns the grading.
