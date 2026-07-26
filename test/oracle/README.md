# Noise oracle harness

The authoritative ground truth for the noise reverse-engineering work
(`docs/noise/`, `src/noise/`): it asks the real Factorio 2.1 map generator what a
named noise expression evaluates to, so every reimplemented primitive and every
ported expression tree can be validated against the game itself - not against our
own assumptions.

Until now this harness was rebuilt ad hoc each session. It is committed here so
every later layer of the client-side map preview (see
`docs/noise/client-preview-ROADMAP.md`) has a reproducible check.

## What it does

`sampleExpression(expression, positions, opts)` (in `oracle.ts`):

1. Writes a throwaway mod that registers `expression` as a `noise-expression`
   named `oracle_probe` (data stage).
2. Writes a `--map-gen-settings` JSON that routes
   `property_expression_names.elevation` at the probe, pinning the map seed
   (`seed0`).
3. Writes an isolated `config.ini` (`read-data` -> the game's bundled data,
   `write-data` -> a scratch dir), so it never touches the real install.
4. Runs `factorio --create ... --mod-directory ... --config ...` headless. On map
   creation the mod's `on_init` samples the routed property with
   `LuaSurface.calculate_tile_properties({"elevation"}, positions)`, writes the
   values as JSON, and `error("DUMPED-OK")`s to exit (~1.7 s total).
5. Reads `write-data/script-output/oracle-dump.json` back and returns the values,
   aligned with `positions`.

The mid-level builders (`buildDataLua`, `buildControlLua`, `buildMapGenSettings`,
`buildFactorioArgs`, `parseDump`, ...) are pure and unit-tested without Factorio;
`sampleExpression` wires them to disk and an injectable `spawnFn`.

## Gotchas baked in (each once cost a run)

- `calculate_tile_properties(property_names, positions)` - **property names come
  first**. The HTML docs and `runtime-api.json` list `positions` first and are
  wrong; the `order` field is authoritative.
- Mods for 2.1.x must declare `"factorio_version": "2.1"` or the game skips them.
- The expression is embedded in a Lua long bracket (`[==[ ... ]==]`) so braces,
  quotes and `var('...')` survive verbatim.
- `MapPosition` is 1/256 fixed-point: a world offset below `1/256` rounds to zero.
  Choose probe offsets accordingly (see `basis-noise-NOTES.md`).
- The intentional `error("DUMPED-OK")` makes Factorio exit non-zero; that is
  success, not failure. The harness keys off the dump file existing, not the code.
- **The Space-Age paths force the planet's surface seed to the map seed, which no
  real save does.** A planet generates at `mapSeed + crc32(planet.name)` (0 only
  for Nauvis), so a forced-seed sample validates the expression port but is blind
  to seed plumbing - and the two disagree completely, not subtly (9.7% tile
  agreement). It cost a session to spot. See `src/model/planetSurfaceSeed.ts` and
  the "Planet surface seeds" section of `docs/noise/vulcanus-resources-NOTES.md`.

## Running

Needs a local Factorio 2.1 install. The binary is found via `FACTORIO_BIN`, else
the macOS Steam default
(`~/Library/Application Support/Steam/.../Factorio.app/Contents/MacOS/factorio`).

```sh
# One-off sample from a script / REPL: import sampleExpression from ./oracle
# Regenerate the committed fixtures (deliberate, not CI):
node --experimental-strip-types test/oracle/capture.ts
```

## Fixture policy

Capture once, commit the JSON, compare in CI **without** Factorio.

- `capture.ts` runs the real game and writes ground-truth JSON into
  `test/fixtures/` (e.g. `oracle-basis.seed123456.json`).
- CI-safe specs read those committed fixtures and assert the pure TS
  reimplementations reproduce them to the noise floor (~2e-6). No install needed.
- A gated spec (`it.skipIf(!oracleAvailable())`) re-runs the live oracle and
  asserts it still reproduces the committed fixture bit-for-bit - so a recipe
  regression or a game update is caught on machines that have Factorio, while CI
  stays green and offline.
