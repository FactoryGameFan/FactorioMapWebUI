# exchange-cliff-bytes

Asks the game how it reads the cliff settings of the committed `water-and-cliffs`
exchange strings (2.1.12 to 2.1.25), so `test/cliffBytes.spec.ts` can grade the
codec's field names against the game instead of against a round-trip, which
cannot see a wrong name.

```bash
python3 scripts/probes/exchange-cliff-bytes/make_probe.py /tmp/w/probe
~/.cargo/bin/factorio-oracle run --probe /tmp/w/probe/probe.json \
  --work-dir /tmp/w/work --factorio <2.1.23 headless install> --version 2.1.23
```

Run it with the 2.1.25 headless build as well (`--version 2.1.25`): that build
reads every committed string, and its dump is
`test/fixtures/map-exchange-parsed.water-and-cliffs.2.1.25-game.dump.json`.

Check the run's `buildLine` first: for the 2.1.23 run it must read
`Version: 2.1.23 (build 87750, linux64, headless)`. The dump is
`/tmp/w/work/write/script-output/oracle-dump.json`.

`test/fixtures/map-exchange-parsed.water-and-cliffs.2.1.23-game.dump.json` holds
that dump under `parsed`, with a `_comment`. A 2.1.23 game refuses the 2.1.24 and
2.1.25 strings (map version higher than the game), so those two entries carry the
error. Re-run with a newer build to fill them in.

Result: the game reads `cliff_smoothing` 1 and `richness` 0.5 from every string
it accepts. Tail bytes 76-79 are `cliff_smoothing`, 80-83 are `richness`, and byte
84 is the `territory_settings.units` count.
