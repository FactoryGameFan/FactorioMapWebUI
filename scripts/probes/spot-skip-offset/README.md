# spot-skip-offset

Asks one question: is `spot_noise` with `skip_span = 1, skip_offset = 1` legal?
Gleba's stone and ore call it that way (`gleba_simple_spot` in
`space-age/prototypes/planet/planet-gleba-map-gen.lua`). Our notes used to say
only offset 0 works with span 1 and anything else crashes the game.

```bash
node --experimental-strip-types scripts/probes/spot-skip-offset/capture.ts
```

Run it from the repository root. It runs Factorio 2.1.23 and 2.0.77 through
`factorio-oracle` (about 20 seconds) and writes
`test/fixtures/oracle-spot-skip-offset.json`. It stops if the two versions
return any different value. The header of `capture.ts` explains the design.

## What it compares

The call is `gleba_simple_spot`'s: seed 1000, `skip_span = 1`, 22 candidates,
spacing 80, `region_size = 400`, quantity `radius^2`, basement -1. The wobble is
left out, and the radius is 30 so a coarse grid hits cones. The surface is Gleba
with its seed forced to 123456 (read back). The 512 positions are a 32 x 16 grid
over 3 x 3 regions.

Each arm is its own Factorio process, so no two arms share a spot cache key.

## Result (2026-10-22, 2.1.23 build 87750 and 2.0.77 build 84539)

- **Offset 1 with span 1 is legal.** The game ran, dumped all 512 values and
  raised no assertion. Both versions agree on every value.
- **Offset 1 is a real, non-degenerate field.** 177 of 512 positions sit above
  zero (on a cone), with 118 distinct values and a peak of 0.8838.
- **It differs from offset 0.** The control has 182 positions on a cone and 120
  distinct values, and the same peak. 14 positions differ, and at none of them
  is offset 1 higher. That matches the binary: with span 1 the game draws 22
  accepted spots and offset 1 keeps indices 1 to 21, so it is the offset 0 field
  with each region's first spot removed.

## Did the game crash?

No, in any arm. The fixture's `diagnostics` lists the arms:

| arm              | what it tried                                           | result           |
| ---------------- | ------------------------------------------------------- | ---------------- |
| `offset1`        | span 1, offset 1                                        | field dumped     |
| `offset0`        | span 1, offset 0 (control)                              | field dumped     |
| `mixedCounts`    | two expressions, same seeds, candidate counts 22 and 23 | dumped, no crash |
| `mixedOffsets`   | two expressions, same seeds and count, offsets 0 and 1  | dumped, no crash |
| `mixedSpans`     | span 1 and span 2 (offset 1) with the same seeds        | dumped, no crash |
| `offset5`        | span 1, offset 5 (past the span)                        | dumped, no crash |
| `offsetsOfSpan4` | four expressions, span 4, offsets 0 to 3                | dumped, no crash |

No log line contained `SpotNoiseCache.cpp`. So this probe did NOT reproduce the
old crash (`SpotNoiseCache.cpp:150: this->candidateSpotCount ==
candidateSpotCount was not true`), even with two counts on one key. The
assertion probably needs a path `calculate_tile_properties` does not take, such
as chunk generation. The search for the line cannot be checked against a real
crash, because none happened.

What this does settle: offset 1 with span 1 does not crash by itself, and the
old note's cause (offset must be below span) is not what the crash was. Offset 5
with span 1 also ran without a crash; its field was not inspected.
