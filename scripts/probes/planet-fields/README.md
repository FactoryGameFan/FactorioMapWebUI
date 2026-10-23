# planet-fields

Captures Gleba's and Aquilo's tier-1 fields from the game, so Stages 1 and 2
can grade the Rust port by exact f32 match. The fields are `elevation`,
`moisture`, `aux`, `temperature` and every tile score the planet lists.

```bash
node --experimental-strip-types scripts/probes/planet-fields/capture.ts \
  --factoriotools <dir>
```

Run it from the repository root. It takes about 25 seconds. `<dir>` must hold
`gleba-123.json` and `aquilo-123.json` from malte9799/FactorioTools (MIT),
`packages/mapgen/test/fixtures/`, at commit
`e1ac68ee750488d7b8b03574e5747f81c672fce0`. Fetch them as data into an empty
directory, for example:

```bash
curl --fail --location --remote-name \
  https://raw.githubusercontent.com/malte9799/FactorioTools/e1ac68ee750488d7b8b03574e5747f81c672fce0/packages/mapgen/test/fixtures/gleba-123.json
```

The script only parses them as JSON. Nothing of theirs is committed here. It
writes `test/fixtures/oracle-gleba-fields.seed123456.json` and
`test/fixtures/oracle-aquilo-fields.seed123456.json`.

## What it does

1. **Cross-check.** It repeats FactorioTools' own run on 2.1.23 and 2.0.77:
   map seed 123, the planet's surface with its derived seed (checked against
   `123 + crc32(planet)`), their 100 integer positions in one batch, and
   their `t_tile_<name>` = `var('tile:<name>:probability')` expressions. Their
   position generator is copied into the script and checked against the list
   in their files. Every value both sides hold must agree bit for bit on
   2.0.77, or nothing is written.
2. **Scout.** On 2.1.23 it reads 16,384 positions on the 1/256 grid, at the
   forced seed 123456. The positions cycle through squares of half-width 256,
   1,024, 4,096 and 16,384 tiles.
3. **Pick.** It keeps the first 4 scout positions where each tile wins the
   strict argmax, then fills up to 1,024 in scout order.
4. **Capture.** It reads those 1,024 positions as one batch on both installs.
   They must agree bit for bit, and every tile must win at least once.

Each tile score is read two ways in the same run: the property name
`tile:<name>:probability`, and the `var(...)` expression above. They must
agree bit for bit. Values go through Lua as numbers; `-0`, `inf`, `-inf` and
`nan` go as strings, because `table_to_json` loses or garbles them. Any `nan`
stops the run, since Lua cannot show its payload. Every value must be an
exact f32.

## Fixture shape

`positions` is a list of `[x, y]`. `climate` and `tiles` map a name to a list
of f32 bits as 8-digit hex, one per position, in the same order. `winCounts`
counts strict argmax wins per tile. `nativeRouteAnswered` says how many tiles
the `tile:<name>:probability` name answered on each version.

## Result (2026-10-22, 2.1.23 build 87750 and 2.0.77 build 84539)

- **FactorioTools agrees bit for bit.** At their 100 positions, all 44 shared
  Gleba fields and all 13 Aquilo fields match their files on 2.0.77, and on
  2.1.23 too. Their values are `%.9g` decimals packed into f32, which gives
  back an f32 exactly, so this is a real bit comparison. A one-bit change
  planted in a copy of their Gleba file made the script stop and write
  nothing.
- **One gap, cause unknown.** Their Gleba file has no
  `lowland-red-infection` column. Our run gets 100 distinct values for it on
  both versions. A replay of their exact 62-name batch on 2.0.77 also
  returned it, so the game does not drop it for that batch. Why their file
  lacks it is not known. That field is graded only by our own 2.0.77 against
  2.1.23 agreement (see `test/fixtures/PROVENANCE.json`).
- **The two versions agree.** All values at all 1,024 positions are
  bit-identical between 2.1.23 and 2.0.77, for both planets.
- **`tile:<name>:probability` works in 2.0.77 too.** It answered for all 41
  Gleba tiles and all 9 Aquilo tiles on both versions, bit-identical to the
  `var(...)` route.
- **The batch does not change the values.** The scout batch of 16,384 and
  the final batch of 1,024 agree at every shared position.
- **Every tile wins.** Gleba: 4 to 78 wins per tile. Aquilo: 4 to 506 (the
  two oceans take 991 of 1,024).
- **Gleba has exact ties.** 67 of the 1,024 Gleba positions have two or more
  tiles at the same top score, mostly at a clamp value: 1.0 (40 positions)
  or 1.1 (17). For example, `lowland-olive-blubber`,
  `lowland-olive-blubber-3` and `lowland-pale-green` all score 1.0 at
  (184.59765625, 73.78515625). The win counts give these to no tile. Which
  tile the game places there depends on its tie-break rule, which this probe
  does not measure. Aquilo has no ties.
