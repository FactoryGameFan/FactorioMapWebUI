# Factorio reference material and the oracle - the long form

The two `factorio-oracle` sections of `CLAUDE.md`, lifted verbatim at commit
`57d3fb3` on 2026-08-25. They moved because most of their length restated things
the oracle repo now documents itself, and `CLAUDE.md` was over Claude Code's
150k limit.

**Read the oracle repo first.** `~/GitHub/factorio-oracle` is the authority on
everything about the tool, and four repos share it:

- `README.md` - what it is, the `refs` subcommands in full, and how to write a
  probe.
- `docs/order-of-attack.md` - factorio-data first, then the oracle, then the
  binary. Also covers the binary shipping unstripped.
- `docs/method.md` - a control must be able to fail while the hypothesis holds;
  last man standing is not a measurement.
- `docs/gotchas.md` - the facts, each of which cost a run: the
  `oracle-dump.json` name contract, `error("DUMPED-OK")` exiting non-zero as
  success, config-file paths, and the version and seed traps.

**`CLAUDE.md` keeps what is specific to THIS repo**: which API-docs entry points
this app's codec depends on, the map-gen Lua files the preview ports, the
version-skew hazard those files carry, `pnpm refs:sync`, the "new probes only"
rule, and the two worked probe examples in `scripts/probes/`.

What lives here and not there is the long form: the full WSL capture recipe with
its three load-bearing environment variables, and the original wording of each
rule.

Nothing below has been edited. It is a snapshot; `CLAUDE.md` is the current
state.

---

## Factorio reference material - read it with `factorio-oracle refs`

Two references back every Factorio question here: the Lua API **docs** and the
game **data** Lua (the map-gen source). Neither is pinned into this repo any
more, and neither should be.

**`factorio-oracle refs` reads both at a version without changing anything.**
That replaces a 254-line `refs:sync` shell script which used to `git checkout` a
tag inside the shared `~/GitHub/factorio-data` clone and download ~290 MB of API
docs into a `factorioLuaAPI/` directory. Three measurements retired it:

- **The clone is shared by four repos**, so pinning its HEAD to whatever THIS
  repo's binary reports raced every other consumer. `refs grep` and `refs show`
  move no HEAD, which is checked in their own output.
- **`factorioLuaAPI/` duplicated the installed game.** Factorio ships
  `factorio.app/Contents/doc-html` - 330 MB, every entry point below present,
  `control:temperature:frequency` included. The download re-fetched what was
  already on disk.
- **Pinning cannot answer the version-skew question at all**, because it shows
  one version at a time. `refs grep --tag A --tag B` shows both at once.

```bash
# ~/.cargo/bin is on no PATH here, so spell it out.
O=~/.cargo/bin/factorio-oracle
$O refs grep --tag 2.1.14 'vulcanus_cracks_scale'   # search the data Lua
$O refs show 2.1.14 core/prototypes/noise-functions.lua
$O refs docs 2.1.14 auxiliary/noise-expressions.html
$O refs docs 2.1.14 runtime-api.json --which        # where it lives, for a grep
$O installs list                                     # JSON: version, docDir, dataDir
```

`pnpm refs:sync` still exists and is now a thin wrapper
(`scripts/sync-factorio-refs.ts`): it reports what is readable at the installed
binary's version, `--check` exits 1 when that version cannot be read, and
`--fixtures` reports which fixtures predate the binary. It pins nothing.

The binary stays the authority on which version is meant. Steam updates it
without asking, so it is the one version you do not control; reading "latest"
instead races that updater and describes a different game than your fixtures
were captured against.

### The API docs

**Before answering any Factorio API question or WebFetching
lua-api.factorio.com / wiki.factorio.com, read these.** They are the
authoritative source for how the map generator, noise expressions, and map-gen
settings work. `refs docs <version> <path>` prints one; it uses the installed
game before the network, and caches under `~/.cache/factorio-oracle/docs/` only
when you ask for a version the installed game is not.

Useful entry points (the `<path>` argument):

- `auxiliary/noise-expressions.html` - named noise expressions and the
  `control:<name>:frequency|size|richness|bias` constants (e.g.
  `control:moisture:frequency`, `control:aux:bias`, `control:temperature:*` - the
  exact keys this app's `property_expression_names` codec round-trips).
- `types/MapGenSettings.html`, `types/FrequencySizeRichness.html`,
  `types/AutoplaceControlID.html` - map-gen settings structure and autoplace controls.
- `runtime-api.json` and `prototype-api.json` - machine-readable dumps; grep
  these for a signature/field faster than the HTML.

The JSON dumps are not a superset of the HTML - `control:temperature:frequency`
is in `noise-expressions.html` and nowhere in `runtime-api.json` - so search the
whole tree, not just the JSON. To grep across all of it, get the directory from
`--which` (or `installs list`'s `docDir`) and grep that:

```bash
grep -rn 'control:temperature' "$(dirname "$($O refs docs 2.1.14 runtime-api.json --which)")"
```

Only fall back to WebFetch if something genuinely is not there.

### Game _data_ (prototype Lua) for noise/autoplace RE

For the actual base-game map-gen **source** (the noise expression trees,
autoplace utils, resource prototypes) that the client-side preview ports, read
`wube/factorio-data` through `refs grep` / `refs show` / `refs worktree`. It is
cloned at `~/GitHub/factorio-data` with per-version git tags; the oracle reads
at a tag and leaves HEAD alone, so it is safe to use from several repos at once.

Key files, in rough order of how often they matter here:
`core/prototypes/noise-programs.lua` (most named expressions - elevation,
cliffs, climate, trees), `core/prototypes/noise-functions.lua`
(`resource_autoplace_all_patches`), `base/prototypes/noise-expressions.lua`
(enemy bases, rocks), `base/prototypes/tile/tiles.lua` (tile autoplace),
`base/prototypes/entity/trees.lua`, and
`space-age/prototypes/planet/planet-vulcanus-map-gen.lua`. To locate anything
else, grep for its **definition** rather than guessing the file - a bare name
grep returns every caller too:

```bash
$O refs grep --tag 2.1.14 'name = "<expression>"'
```

**Version skew here is a real, silent hazard, not a formality.**
`starting_patches` changed materially between **2.0.77 and 2.1.9** - radius
120 -> 150, `region_size` \*2 -> \*3, spacing 32 -> 48, the `random_penalty`
favorability term removed, a new 40-tile `origin_excluder`, and the lake mask
switched from a hardcoded `elevation_lakes` to the planet's own `elevation`.
Reading the wrong version's Lua produces a port that passes its own tests and
disagrees with the game.

**Ask both versions at once rather than trusting a pin** - this is the single
biggest reason the pinning script is gone, because it could not do this:

```bash
$O refs grep --tag 2.0.77 --tag 2.1.14 'starting_patches'
```

Each hit is prefixed with its tag, so a difference is visible rather than
inferred, and you never have to remember which version the tree is currently on.

Note where that change lived: `core/prototypes/noise-functions.lua`. Neither
`core/lualib/resource-autoplace.lua` nor `base/prototypes/entity/resources.lua`
moved at all between 2.0.77 and 2.1.12, so guessing by filename would have
cleared the resource fixtures wrongly. `noise-functions.lua` and
`noise-programs.lua` are themselves unchanged across 2.1.9 - 2.1.12.

### The binary is the oracle, and it is not stripped

The Steam build ships **unstripped** - 1,088,238 symbols, a 27.9 MB string
table, and 375,101 STAB debug-map entries - so `nm` + `c++filt` resolve map-gen
internals directly (e.g. `Noise::setSeed(unsigned int, unsigned char)`). That
makes it the fastest oracle for a short generator function; see
`docs/noise/basis-noise-NOTES.md`. It lives at:

```
~/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio
```

Steam keeps it updated, which is fine: `factorio.com/download/archive/` carries
every release from 0.6.4 onward, so reproducing an old measurement means
recording the version, not hoarding installs. Set `FACTORIO_BIN` to point
`refs:sync` and `factorio-oracle` at a different install.

### Automate with the Factorio headless CLI

A lot can be driven from the command line - see
https://wiki.factorio.com/Command_line_parameters (the game's own binary; this
is a wiki page, not in the shipped API docs). Relevant here:

- **Map-gen testing / validation:** `factorio --create <save> --map-gen-settings
<json> --map-gen-seed <n> --mod-directory <dir>` runs headless and exits
  cleanly even alongside a running game if you point an isolated `--config` INI's
  `write-data` at a temp dir. This is how the codec is cross-validated against the
  game's own parse (a dumper mod calls `helpers.parse_map_exchange_string` and
  writes JSON) - the resulting fixture lives at
  `test/fixtures/map-exchange-parsed.default-seed123456.dump.json`.
- **Preview rendering:** `factorio --generate-map-preview` is exactly what
  `preview-service/container/` shells out to.

Prefer the game as an oracle over byte-diffing when settling a codec question.

## Asking the running game - factorio-oracle

The two references above say what the game _ships_. When a question needs what
the game _computes_, run it.

[`factorio-oracle`](https://github.com/FactoryGameFan/factorio-oracle) is a
shared Rust CLI that owns discovery, mod scaffolding, launching and reading
results back, so a probe is a JSON document plus a `control.lua` rather than a
rebuilt harness. Four repos share it. It is checked out at
`~/GitHub/factorio-oracle` and installed:

```bash
# ~/.cargo/bin is on no PATH here, so use the full path.
~/.cargo/bin/factorio-oracle installs list
~/.cargo/bin/factorio-oracle run --probe <probe.json> --work-dir /tmp/w
cat /tmp/w/write/script-output/oracle-dump.json

# After pulling the oracle, reinstall:
cd ~/GitHub/factorio-oracle && cargo install --path .
```

### Running captures from WSL against a WINDOWS Factorio

**WSL2 executes the Windows binary directly, so a WSL box with Factorio on a
Windows drive can capture.** A session handoff once recorded the opposite -
"Factorio is a Windows executable and WSL cannot run it" - and planned a
Windows-native Node environment on that basis. Measured, it just runs:

```bash
/mnt/v/factorio-2.1.14/bin/x64/factorio.exe --version
# Version: 2.1.14 (build 87180, win64, full)
```

The only real obstacle is that the harness hands the game **Linux paths**.
`OracleOptions.pathForGame` translates them; `FACTORIO_PATH_STYLE=windows`
selects the `wslpath -w` implementation, so **no capture call site changes**:

```bash
TMPDIR=/mnt/c/Users/<you>/AppData/Local/Temp/fmw \
FACTORIO_BIN=/mnt/v/factorio-2.1.14/bin/x64/factorio.exe \
FACTORIO_DATA_DIR=/mnt/v/factorio-2.1.14/data \
FACTORIO_PATH_STYLE=windows \
node --experimental-strip-types test/oracle/capture.ts <probe>
```

Three things about that command are load-bearing, each found by it failing:

- **`TMPDIR` must be on a Windows-visible drive.** `capture.ts` builds its work
  dir from `os.tmpdir()`, which honours `TMPDIR`, so this needs no code change -
  but the default `/tmp` is inside the WSL filesystem, and Factorio **cannot
  write there**. `wslpath` renders it as `\\wsl.localhost\...` and the run dies
  with no dump and an empty stderr, which is the least helpful failure of the
  three.
- **The translation has to reach `config.ini`, not just the argument vector.**
  `write-data` lives in that file. Translating only argv gives a run that starts
  and then cannot write its output, reported as
  `weakly_canonical: Access is denied`.
- **`FACTORIO_DATA_DIR` is needed because the Windows layout differs.**
  `defaultDataDir` derives `<bin>/../data`, which is right for the macOS bundle
  and wrong for `bin/x64/factorio.exe`, where the data sits two levels up.

Everything here is inert off WSL: `FACTORIO_PATH_STYLE` unset means the
identity, so macOS and native Linux behave exactly as before.

### The rule is new probes only

**`test/oracle/` stays.** It is 9,593 lines, it works, and nothing in it gets
rewritten to use the CLI. Adoption happens when someone writes a probe they did
not have before. `sampleExpression()` remains the right tool for sampling a
noise expression, and the local harness is what most of `docs/noise/` was built
with.

Reach for `factorio-oracle` when the probe is new, and especially when it needs
something the local harness does not do: a second Factorio version, a timeout, or
provenance recorded for what it captured.

### The worked example in this repo

`scripts/probes/basis-gradient/` recovered the `basis_noise` gradient table from
the game (#234). Read it before writing another probe - it is short, and it
carries the traps in comments beside the code that hit them.

Three things it establishes:

- **The dump must be written as `oracle-dump.json`.** That name is the tool's
  contract, not the game's. `helpers.write_file` accepts any name and the run
  reports failure anyway.
- **`error("DUMPED-OK")` makes Factorio exit non-zero, and that is success.**
  The tool keys `create` off the dump appearing, not off the exit code.
- **Run it against two versions when you can.** A second install is named with
  `--factorio`, and the 2.0.77 one sits outside every discovery path on purpose,
  so a bare run finds only the Steam 2.1.14:

  ```bash
  ~/.cargo/bin/factorio-oracle run --probe <probe.json> --work-dir /tmp/w \
    --factorio ~/GitHub/factorio-oracle/installs/factorio-2.0.77.app
  ```

  The gradient table came back byte-identical from 2.0.77 and 2.1.14, which is
  how we know it is a constant of the engine rather than of a version.

### Where the probe-writing knowledge lives

Three documents in the oracle repo, lifted from this repo and
factorio-blueprint-editor with attribution, so a fifth repo does not learn it
again. Read them before writing a probe:

- `~/GitHub/factorio-oracle/docs/order-of-attack.md` - factorio-data first, then
  the oracle, then the binary.
- `~/GitHub/factorio-oracle/docs/method.md` - a control must be able to fail
  while the hypothesis holds; last man standing is not a measurement.
- `~/GitHub/factorio-oracle/docs/gotchas.md` - the facts, each of which cost a
  run.

It also checks this repo's fixture manifest, which is the same check
`test/fixtureProvenance.spec.ts` runs:

```bash
~/.cargo/bin/factorio-oracle provenance check test/fixtures
```

