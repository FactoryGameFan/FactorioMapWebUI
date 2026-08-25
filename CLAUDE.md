# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Commands

Run `vp` (Vite+) **through pnpm** - `pnpm vp <cmd>` - which is what every script
in `package.json` does.

**`npx vp` fails; a bare `vp` does NOT.** This line used to say both forms fail
with `EBADDEVENGINES`, and half of that was wrong (re-measured 2026-08-04). The
project pins pnpm via `devEngines`, so `npx vp check` dies with
`EBADDEVENGINES ... Invalid name "pnpm" does not match "npm"` - but the global
`vp` binary (v0.2.7) is not npm and runs fine: bare `vp check` exits 0 and
reports all 367 files formatted. Prefer `pnpm vp` anyway, because it is the form
the scripts and CI use and so the one that stays verified; just don't expect a
bare `vp` to fail, and don't "fix" a working command on the strength of this
note.

Node **26.7.0** (`.node-version`) is what the repo is developed and verified on.
`engines.node` stays a permissive floor (`>=24.18.0`) rather than matching the
pin - older versions are simply untested, not known-broken.

**`.node-version` is machinery now, not documentation.** That changed when
`.github/workflows/verify.yml` landed: `actions/setup-node` reads the file via
`node-version-file`, so it is what CI actually installs. Nothing _local_ consumes
it still (node comes from Homebrew, no version manager is installed) and
Cloudflare Pages never builds this repo - `deploy:app` uploads an already-built
`dist` - so an edit to it changes the version the gate runs on and nothing else.
Bump it only alongside a local `pnpm run verify` on the new version.

Adding a root dependency needs `pnpm add -w` (or `--workspace-root`); a bare
`pnpm add <pkg>` at the root fails with `ERR_PNPM_ADDING_TO_ROOT`. Prefer
targeted `pnpm add` over `pnpm up` for dependency bumps - see the type-checking
note below for why `pnpm up`'s transitive re-resolution can break `vp check`.
Always follow any `add` with a bare `pnpm install`: `add` relinks only its own
workspace and leaves sibling workspaces' symlinks dangling. Only the full
install prints `Scope: all 3 workspace projects`.

**The 24-hour release-age guard is now DECLARED, and setting it explicitly buys
a second guard that the identical default value does not.** `pnpm-workspace.yaml`
carries `minimumReleaseAge: 1440` as of 2026-08-11 (#184), so
`pnpm config get minimumReleaseAge` answers `1440` rather than the `undefined`
it used to - which used to read like "no policy here" while pnpm's own defaults
table (`"minimum-release-age": 24 * 60, // 1 day`) was quietly enforcing one.

1440 minutes _is_ that default, so the number changed nothing. What changed is
that an **explicit** value turns on a whole-lockfile verification pass on every
install. Measured on one tree, pnpm 11.18.0:

| `minimumReleaseAge`    | `pnpm install --frozen-lockfile` prints                 |
| ---------------------- | ------------------------------------------------------- |
| unset (the default)    | nothing - no verification runs at all                   |
| `1440` (= the default) | `✓ Lockfile passes supply-chain policies (399 entries)` |
| `4320` (3 days)        | `✗ Lockfile failed supply-chain policy check`           |

Unset, the age is checked only at **resolution**; a lockfile resolved elsewhere
with the guard bypassed installs here without a murmur. Set, all 399 entries are
re-checked every install.

**Do not raise it above 1440.** That verification is retroactive, and #184
proposed 4320, which failed all seven CI jobs on a single entry:
`@speed-highlight/core@1.2.24`, pulled in transitively by
`wrangler > miniflare > youch` when #169 landed on 2026-08-10 and it was ~1.2
days old - legal under the floor it was resolved under, illegal under 3 days,
for the two days until it aged out. At 1440 that window cannot open, because
pnpm's resolver already refuses anything under 24h, so no lockfile it produces
can fail its own verification. Anything higher re-opens a gap between what the
resolver accepts and what the verifier demands. Two further traps are recorded
in the comment on the setting itself: pnpm's suggested remedy
(`pnpm clean --lockfile && pnpm install`) is a 357-line full re-resolution, i.e.
the `lockFileMaintenance` operation Renovate pins off here; and
`vulnerabilityAlerts.minimumReleaseAge: "25 hours"` in `.github/renovate.json5`
is derived from pnpm's 24h floor and breaks silently if the floor moves.

The longer 3-day soak lives in the Renovate config instead, where it gates what
gets **proposed** rather than re-judging what is already pinned.

On the `minimumReleaseAgeExclude` bypass this file warns about elsewhere: on
11.18.0, non-interactively, pnpm now **hard-fails** with
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` and writes nothing - both for a plain
install and for `pnpm add pkg@<too-fresh>` (measured 2026-08-11). Interactive
TTY behaviour was not tested and the `vue-tsc@3.3.8` bypass was real when it
happened, so keep watching diffs for that block rather than assuming it is
fixed upstream.

- `pnpm install` - install deps
- `pnpm vp dev` - dev server
- `pnpm vp test` - full test suite (Vitest-compatible; tests import from `"vite-plus/test"`)
- `pnpm vp test test/controlScale.spec.ts` - a single test file
- `pnpm vp check --fix` - format + lint + **type-check** of `.ts`, the main
  static-check step (see the type-checking note below). It does **not** see
  inside `.vue` bodies - that is `check:vue`'s job, and the two together are the
  full net.
- `pnpm run check:vue` - `vue-tsc --noEmit`, the type-check of `<script setup>`
  bodies in the 22 `.vue` files (~2.1s). Nothing else checks them.
- `pnpm vp build` - production build

**`vp dev` is exercised by NOTHING - not `verify`, not CI.** The `build` job
covers `vp build`, and the test shards cover `vp test`, but the dev server has
no automated coverage at all, while both `dev` and `preview:app` depend on it.
That gap has teeth on a vite-plus bump specifically: 0.2.8 changed bare `vp dev`
at a monorepo **root** to resolve a target package, with non-interactive runs
listing candidates and exiting 1 rather than serving. This repo is a monorepo
root, so that is a plausible break with a green CI. It did **not** break (checked
by hand on the PR branch: serves normally, no package picker, `/version.json`
answers on the chosen port), but nothing in the gate would have said so. Check it
by hand on any vite-plus bump:

```bash
pnpm vp dev --port 5199 --strictPort   # expect a Local: URL, not a picker or exit 1
```

- `pnpm run verify:lint` - `vp check` + `check:vue`. Exists so CI can run the
  static phases without the app suite; `verify` composes it rather than
  repeating the commands, so there is still one definition of each phase.
- `pnpm run verify:static` - `verify:lint` + `preview:test`. Everything in
  `verify` that is **not** the app suite. This is the `static` CI job.
- `pnpm run verify:shard` - bare `vp test`, for CI's sharded matrix. Takes a
  passthrough arg: `pnpm run verify:shard -- --shard=1/4`. The `--` is
  required.
- `pnpm run verify:rust` - `scripts/verify-rust.sh`: `cargo fmt --check`,
  `clippy -D warnings`, `cargo test`, the zero-shipped-dependencies assertion,
  a byte comparison against the committed `src/noise/wasm/engine.wasm`, and
  `cargo deny check`. This is the `rust` CI job. **Cheap, and that is measured
  rather than assumed: 1.62 / 1.64 / 1.62s over three `cargo clean` runs and
  0.84 / 0.85 / 0.87s warm** - both under `vp check`'s 2.0s, so its position
  last in `verify` costs almost nothing.

  Two things about it that are easy to get wrong:
  - **It probes cargo-deny with `cargo deny --version`, never
    `command -v cargo-deny`.** `cargo install` puts the binary in
    `$CARGO_HOME/bin` and cargo finds its own subcommands there whether or not
    that directory is on `PATH`, so `command -v` reported it missing on a
    machine where `cargo deny check` ran fine - and the step skipped itself
    while printing a green gate. Install it with
    `cargo install cargo-deny --locked --version 0.20.2` (~4 minutes, it builds
    from source; CI downloads a checksum-pinned release binary instead).
  - **`cargo deny` grades the workspace's OWN crates, not only third-party
    ones.** Both crates carry `license = "AGPL-3.0-or-later"` because a
    manifest without it fails as `unlicensed`, and `allow-wildcard-paths` is on
    because a `path` dependency has no version requirement and reads as a
    wildcard. Neither is decoration; deleting either turns the gate red.

- `pnpm run require:docker` - preflight that fails loudly when no container
  runtime is reachable, naming the start command for whichever one you have
  installed (`scripts/require-docker.ts`). `preview:dev` and `preview:deploy`
  run it first, since both build the Factorio image. Deliberately **not** in
  `preview:test` or `verify` - those must keep passing on a runner with no
  Docker at all, which is what makes the CI workflow possible. Auto-start is
  opt-in behind `FMW_AUTO_START_DOCKER=1`.
- `pnpm run verify` - `verify:lint` + `vp test` + `preview:test` +
  `verify:rust` in one gate. **It now needs a Rust toolchain**, which it did
  not before #219 - `rust-toolchain.toml` pins 1.97.1 and rustup installs it on
  the first cargo command, so a machine with no Rust pays that download once
  before the gate can run at all. Nothing else about the gate changed: the
  Rust phase adds ~1.6s cold. **~3m30s cold on a dev machine** (measured
  2026-08-15 at #207:
  3m28s wall, 218 test files, 1,922 tests). On a runner it is no longer one job -
  see the CI section, which shards it. This line has been wrong twice and in the
  same direction, so treat the number as perishable. It claimed `~9.5s` for a
  long time - wrong by a factor of six even before `check:vue` existed, because
  the suite grew through the Vulcanus and cliff work. It was then corrected to
  `~65-90s`, which the island finder (#207) invalidated within two weeks by
  adding one 134.6s spec file. The gap matters both times: a gate people believe
  is instant and is not is a gate they stop running, which is half the argument
  for the CI workflow below. Don't budget seconds for this; budget minutes.

  The test phase runs through **`vp run --cache test`**, not a bare `vp test`.
  Measured 2026-08-02: the four phases are `vp check` 2.0s, `check:vue` 3.0s,
  `vp test` **61.2s**, `preview:test` 3.1s - so one phase is **88%** of the gate
  and it is the only one worth caching. That phase alone goes 62.0s cold to
  **0.6s** warm; the whole gate goes **64.9s to 7.0s**, the remainder being the
  three phases that are not cached.

  The cache is content-keyed, and that was established by trying to break it
  rather than by reading the flag's docs: an edit to a source file misses and
  re-runs; a **planted failing assertion misses and still fails with rc=1**, so
  a hit cannot mask a regression; and a `touch` that changes only the mtime
  still **hits**, which is what proves it hashes contents. Only the most recent
  result is stored, so reverting to a previously-seen tree misses.

  Consequences worth knowing before reading a fast `verify` as a skipped one:

  - **It is a no-op in CI.** Every runner starts cold, so the required `verify`
    check runs in full whatever this flag says.
  - **It pays on `deploy` and almost nowhere else.** `deploy:app` runs `verify`
    immediately after you have probably just run one by hand. The normal
    edit -> verify loop misses every time, by design.
  - **A hit is a replay, not a run.** Legitimate for file content, per the
    probes above. What is NOT established is whether the key covers inputs
    outside the tree - env vars, the node version, or whether a Factorio install
    appeared or vanished (the oracle specs are `it.skipIf(!oracleAvailable())`,
    so their skip status can change with no file changing). If you are chasing
    something environmental rather than something you edited, clear it with
    `vp cache clean`, or call `vp test` directly.

  Changes that were measured and **rejected**, so they don't get retried:
  running the four phases in parallel is only 60.6s against 69.3s serial (13%),
  and it turns a 2s type error into a 61s one because `vp check` no longer runs
  first - it would also need a new script, since a `dependsOn: ["check"]` would
  pull in the `check` script, which is `vp check --fix` and must never run in a
  deploy path. And `maxWorkers` is already at its optimum: 4 -> 74.7s, 8 ->
  61.7s, 11 -> 61.8s against a default of 61.2s, because the extra cores on this
  machine are E-cores.

  Three more, measured 2026-08-03 while sharding CI:

  - **`isolate: false` is not available to this suite.** It fails **66 of 171
    files**. Those same files pass individually with `--no-isolate`, so it is
    cross-file module-state pollution, not a misconfiguration - the field DAG's
    memo caches are module-level. It only bought 7.6% anyway (68.24s -> 63.07s).
  - **`--reporter=blob` + `--merge-reports` does not work here.** Blob writes
    correctly, but `vp test --merge-reports` does not merge, it **re-runs**: a
    57-file shard's blob came back reporting 114 files. Vite+ is not bare vitest
    on this path. That is why the sharded CI job uploads no artifacts.
  - **The wall clock was set by the slowest FILE, not by total CPU** - true on
    2026-08-03 at 171 files (497s of CPU in 68s of wall on 12 cores, with
    `test/previewAgreement.spec.ts` alone 67s of that 68s), and **no longer
    true**. Re-measured 2026-08-10 at 201 files: total per-file wall is 503s and
    previewAgreement is **72.9s of it (14.5%)**, with ten files over 20s. The
    #84 cliff work added the rest. `environment: "node"` by default was worth
    ~3s (only ~30 of 164 spec files touch `document`/`window`) and has not been
    re-measured since. See #119 for the CI consequence: the single-file floor is
    what made N=4 look pointless, and once it stopped dominating, N=4 became a
    32% cut of the gate.

  **A fourth, measured 2026-08-18: bun and deno are refuted, and the premise
  under the question was refuted with them.** The suite is transform **0.7%**,
  so a faster transpiler aims at almost nothing; on identical work plain bun is
  **10% slower** than the node already installed (5.97s against 5.40s) and
  deno's 5.17s is inside noise. Both also enforce their release-age floor at
  resolution only, never on a frozen install from a lockfile - which is exactly
  pnpm's _unset_ default, i.e. the hole `minimumReleaseAge: 1440` exists to
  close - and both exit 0 having installed no `node_modules` for either
  preview-service workspace. Full arm-by-arm numbers, the deno flag-spelling
  trap that produces a false negative, and the one result that would reopen it
  are in `docs/bun-deno-evaluation.md`. What that work DID find is issue #267:
  vitest's per-module transform costs **3.7x** on the noise graph
  (`test/findIslands.spec.ts`, 162.11s against 43.63s pre-bundled, 11 tests
  passing both ways), which is reachable without changing runtime at all.

- `pnpm refs:sync` - report which reference material is readable at the
  installed binary's version (`--check` exits 1 when it is not; `--fixtures`
  reports which oracle fixtures predate the binary). A thin wrapper over
  `factorio-oracle` that **pins nothing** - see the reference section at the top
  of this file. Deliberately **not** part of `verify`, which must pass on
  machines with no Factorio installed, and it now also needs the oracle.
- `pnpm run deploy` - **verify** + build + `wrangler pages deploy` to Cloudflare Pages
- `pnpm run verify:deploy` - after deploying, confirm the live site is running
  local `HEAD` (see below). Takes an optional origin argument.

### CI (`.github/`) runs `verify`'s phases SHARDED, plus the build

`.github/workflows/verify.yml` runs on every pull request and every push to
`main`. Until 2026-08-03 it ran `pnpm run verify` verbatim as one job. It no
longer does, and the note that used to sit here said so emphatically ("do not
mirror the change into the YAML") - if you are here because the YAML does not
match that instruction, the instruction is what changed.

**Why it changed:** the single job measured **9m03s** (PR #116), of which the
test phase is ~95%. A runner is ~3x slower than a dev machine, and only 4 cores,
so the phase that is 88% of the local gate dominates a CI run completely.
Four jobs now run in parallel:

| job               | what                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `static`          | `pnpm run verify:static` - `vp check`, `check:vue`, `preview:test` |
| `tests (1..4, 4)` | `pnpm run verify:shard -- --shard=N/4` - the app suite             |
| `rust`            | `scripts/verify-rust.sh` - **19s**, added #219                     |
| `verify`          | the required check: asserts every job above succeeded              |
| `build`           | `pnpm vp build`, unchanged (issue #61)                             |

**`rust` is NOT a required status check, and its absence from ruleset `EJ` is
deliberate rather than an oversight to fix.** `verify` asserts
`needs.rust.result`, so a red `rust` job turns the required check red anyway -
with no ruleset PUT and no two-step. Every required NAME is a permanent
liability, since renaming or removing one blocks every PR forever on a check
that cannot run, so the aggregator absorbing new phases is the cheaper shape.
Add future phases the same way.

Two more things about that job, both measured on its first run (#230):

- **It WAS 19s and is not any more.** On its first run (#230) it was 19s, of
  which `scripts/verify-rust.sh` was 2s, the pinned-toolchain sync 10s and
  cargo-deny 1s, and it was the cheapest job in the workflow. #225's cliff half
  ended that: `the_apply_stage_beats_the_crossing_stage_on_three_counts_and_
loses_on_none` is 33s in the normal arm and **93s under poison**, taking the
  script alone to **1m50s** locally. Poison is the expensive half because
  `crossing_result` turns every lattice edge into a crossing, so far more cells
  place and the `onDestroy` cascade recurses over a dense set.

  It is kept because it is the ONLY grading of `cliffs::connections`, a
  445-line module on no render path - without it that port would have unit tests
  and no measurement against anything. It is still far under the test shards, so
  it does not move the gate wall; it is simply no longer free. Anyone adding a
  second fixture test of that shape should re-measure this job first.

  **#225's third part re-measured it and did not move it: 110.8s warm against
  the 1m50s above.** That is one run against a figure recorded in another
  session, so read it as "no measurable movement" rather than as a delta. It
  stayed flat because the rock and resource overlays deliberately did NOT get a
  test of that shape - the game's ground truth for the placement roll is a count
  per 512x512 region, ~33s each in a debug build, and that grading lives on the
  TypeScript side instead. See the phase-5 notes below for the reasoning.

  **Treat this job's cost as a RANGE, not a number: roughly 1m45s to 2m50s.**
  Three CI runs on code whose Rust half was equivalent between them came in at
  **1m44s (#310), 2m48s (an earlier run) and 2m49s (#312)** - and #312's run
  landed a second ABOVE the "1m44s to 2m48s" this paragraph first claimed, which
  is the paragraph's own point arriving immediately. Endpoints stated to the
  second invite exactly the chasing this warns against, so the figure is rounded. That is the same spread the
  test shards show (`one-ci-run-measures-the-runner` - identical spec files came
  in anywhere from 294s to 469s), and the honest response is to widen the figure
  rather than to replace it: a single run here measures the runner at least as
  much as the job. Do not "correct" this to whichever number you last saw. If a
  change to the Rust really does move this job, show it with more than one run.

- **It runs `bash scripts/verify-rust.sh` directly**, the one deviation from
  "the YAML names only package.json scripts". That does not reopen the drift
  the rule guards against, because `verify:rust` _is_ that one line, so the
  script file stays the single definition. Going through pnpm would add
  action-setup, setup-node and a full install (~28s) to a job that needs no
  JavaScript. If `verify:rust` ever grows a second command, the job must become
  `pnpm run verify:rust` with the setup steps restored.

Measured result: **9m03s -> 4m36s** at the time (2026-08-03, N=3, 171 spec
files). Do not read that as the current number: the suite has since grown to 201
files, which put N=3 back up to ~8m and is why the shard count moved to 4 - see
the shard table below.

**The anti-drift rule still holds, by a different mechanism.** The point of
"verbatim" was that there is exactly one definition of "this repo is
consistent". That is now enforced by the workflow naming only package.json
**scripts** - never the underlying commands - and by `verify`, `verify:static`
and `verify:shard` all composing the same `verify:lint`. Do not inline
`vp check` or `vue-tsc` into the YAML; add or edit a script instead.

**Two traps in that file, both of which look like tidying:**

- **The job named `verify` does no work, and must keep that name.** Ruleset `EJ`
  requires a status check called `verify`; a required check that never appears
  blocks every PR _forever_, on a check that cannot run. Renaming that job needs
  a ruleset PUT in the same change - see the two-step below.
- **It asserts `needs.*.result` explicitly rather than relying on `needs:`.**
  A job whose dependency _failed_ is **skipped**, and a skipped required check
  does not block a merge. Deleting those assertions would make a red suite
  mergeable. `if: ${{ !cancelled() }}` rather than `always()` is also
  deliberate: a superseded push should stay cancelled, not become a failure.

**Why FOUR shards and not three, and why local measurement said the opposite**
(#119, settled on CI 2026-08-10). This section used to argue for three, on the
grounds that `test/previewAgreement.spec.ts` was 67s of the 68s local suite and
therefore an unsplittable floor no shard count could beat. Local slowest-shard
wall was 55.7s at N=3 against 53.5s at N=4 - inside noise, for 33% more runner
minutes. That measurement was correct and its conclusion did not transfer: a dev
box has 12 cores and a runner has 4, so locally the CPU term is absorbed and only
the file floor is left visible.

One CI run, all four arms concurrently on the same runner pool (18 jobs), so the
comparison is within-run rather than against a different hour:

| N   | test-step walls (s)           | slowest job | runner-s |
| --- | ----------------------------- | ----------- | -------- |
| 3   | 452 / 356 / 102               | 488s        | 995      |
| 4   | 306 / 291 / 291 / 72          | **333s**    | 1071     |
| 5   | 311 / 213 / 174 / 74 / 67     | 343s        | 989      |
| 6   | 314 / 224 / 162 / 140 / 61/51 | 344s        | 1119     |

N=4 is **-155s of gate wall (-32%)** for **+7.6% runner-seconds**, not the +33%
the local numbers implied - total CPU is flat across arms and the only thing an
extra job adds is ~28s of checkout+install. N=5 and N=6 do not improve on N=4
(+5s and +8s, noise), so 4 is the point of diminishing return.

**The floor is no longer that one file, and the old premise expired rather than
being wrong.** The slowest N=6 shard (33 files, 314s) does **not contain**
`previewAgreement.spec.ts` - checked by running that exact shard locally, not
inferred. The suite grew **171 -> 201 spec files** through the #84 cliff work,
and `previewAgreement.spec.ts` is now **72.9s of 503s** of total per-file wall
(14.5%), with **ten** files over 20s (`vulcanusCliffRejectionStage` 52.1s,
`vulcanusStackCache` 47.8s, `cliffOreCascade` 30.1s, `entityDensity` 29.9s,
`vulcanusCliffBands` 28.4s, ...). So "split previewAgreement into its three
tests" is no longer the prerequisite for further sharding gain that #119
assumed; the binding shard is whichever one vitest's hash-split loads with
several heavy files, and **balance**, not count, is the remaining lever. Nobody
should raise N again without re-measuring **on CI** - and note this whole
paragraph has a shelf life, because it is a statement about the suite's current
file-weight distribution.

**Re-measured on CI 2026-08-14, after the Fulgora scrap work (#202).** That
branch added three 1024x1024 comparisons to `previewAgreement.spec.ts`, which
the scrap spec had flagged in advance as a shard-balance risk. The four shard
**jobs** came in at **259 / 351 / 389 / 133 seconds**, so the binding shard is
**389s against the 333s** in the table above - **+56s of gate wall, +17%**.

Two things that measurement settles:

- **The cost of those comparisons is real but modest**, and it was paid
  deliberately: they are what caught a rounding bug that had been wrong in
  shipped Fulgora terrain since V1 (`Math.round` where the game truncates,
  worth 35 percentage points of whole-image agreement).
- **Balance is still the lever, and the spread widened to 3x** - 389s against
  133s on the lightest shard. Raising N does not help: #119 measured N=5 and
  N=6 at +5s and +8s against N=4, inside noise, for more runner-minutes.

**The split this section used to recommend was measured on 2026-08-15 (#203),
and it is NOT the move.** The text here said splitting `previewAgreement.spec.ts`
into separate files "targets that spread directly". Three measurements say
otherwise, and all three are things the file-level timings above cannot show:

- **Hash-sharding does not let you balance anything on purpose.** Vitest shards
  by sha1 of each spec's path, sorted, then sliced into N contiguous chunks.
  Reimplementing that against this run's four logs reproduces **209 of the 210
  file placements** (the one miss is a single file at the shard 3/4 boundary,
  where the slice arithmetic differs by one), so it predicts where a file lands
  but not which side of a boundary a near-boundary file falls. Run it on a
  split into four natural per-planet names and two of the four parts collide in
  the same shard, putting the binding shard around **415s against the 366s it
  was**. Treat that number as a projection, not a measurement - the placements
  are solid, the per-part costs are estimates. The durable point needs neither:
  adding any spec file changes the count and re-slices every shard, so names
  picked to spread today do not stay spread.
- **Import time is a first-order cost, not overhead.** Shard 3 spent **332s
  importing against 260s running tests**. `isolate: true` is required here (see
  above), so each spec file gets a fresh module registry and re-imports the
  whole noise graph. Turning one file into four adds three more of those.
- **The binding shard is not bound by one file.** Shard 1 pairs
  `previewAgreement.spec.ts` (298s) with `vulcanusCliffRejectionStage.spec.ts`
  (205s) - **503s of that shard's 653s sitting on 2 of its 4 workers**. Moving
  one of them elsewhere leaves the other behind.

**And the runner noise is bigger than the effect anyone is trying to tune.**
#202's run and #203's run have the **same 210 spec files**, so vitest hands
them identical shards. The jobs still came in at **259 / 351 / 389 / 133**
against **366 / 273 / 327 / 137** - shard 1 up 41%, shard 3 down 16%, and the
binding shard changed identity from 3 to 1. Any rebalancing worth doing has to
beat that, and a single run cannot show that it did.

**Re-measured on CI 2026-08-15 after the Fulgora island finder (#207) - three
runs over the SAME 218 spec files, and they disagree by more than the effect
anyone would want to read out of them.** #207 and both runs of #208 (docs-only,
so identical spec files and identical shard assignment):

| run               | shards (s)            | binding |
| ----------------- | --------------------- | ------- |
| #207              | 391 / 378 / 469 / 400 | 469     |
| #208 first        | 248 / 269 / 259 / 294 | **294** |
| #208 after a redo | 366 / 281 / 416 / 368 | 416     |

Range **294-469 on identical test code**, a 59% spread, against a recorded 389s
for #202. Two of the three sit above 389 and one sits well below it, so the
finder probably did add gate wall - but the noise is the same size as the thing
being measured, and no honest point estimate comes out of this.

Note how that table was built, because it is the cheapest way to get one: three
runs of the same tests arrived for free from one PR's normal life (open, amend,
push). If a number here matters, collect it that way rather than from whichever
run you happened to look at. The first draft of this very paragraph read
"+80s, +21%" off #207 alone, and the next run refuted it.

That is the #202/#203 lesson arriving a second time, and it should be the
default assumption now: a single CI run here measures the runner as much as the
suite. Do not tune on one.

What IS solid, because it was measured locally where the spread is small:
**`test/findIslands.spec.ts` is the new heaviest file at 134.6s**, taking the
crown from `previewAgreement.spec.ts`. Read that with its history - it was
**240.4s** when the branch's last fix landed, and four of its tests were then
cut to a small `refineCount` for identical coverage. Why it is expensive at all:
the finder re-renders a candidate at a doubled pad whenever its island mask
touches the window border, and refinement pays 16x the pixels of the coarse
pass. One test in that file **cannot** be cheapened the same way and its own
comment explains why, so do not "finish the job" by lowering its refine count.

So the gate wall stays where it is, and the thing that actually broke was a
**timeout, not the wall**. On #203 - a docs-only change - the unchanged
"Vulcanus rock and cliff coverage" test hit its 120s budget at 150.5s. Across
four consecutive runs the same code measured **69.6s, 90.1s, 108.8s and
150.5s**, so run-to-run spread on a 4-core runner is about 40%, and main itself
had passed at 108.8s with 10% to spare. That file's budget is now 300s, with
the table in its own header comment. The green re-run measured that same test
at **139.7s**, which is the row that matters: given room it finishes, and it
finishes above 120s rather than just under, so the old ceiling was genuinely
too small and the new one is not hiding anything. Note what this means for the next heavy
test: the ceiling is per-test and hand-written, so a shard rebalance moves which
tests are near it.

A second job, **`build`**, runs `pnpm vp build` in parallel (issue #61). `verify`
is check + type-check + tests and none of them build, so a change could pass all
three, break the production build, and only surface days later when somebody
deployed. It is a separate job rather than a fourth phase of `verify` because
`deploy` already runs `pnpm build` right after `pnpm run verify` - folding it in
would build twice per deploy and slow the gate people run by hand. It does
**not** enforce zero warnings; the job comment records both routes to that and
why each was rejected.

Conventions that file establishes, and that anything added under `.github/`
should keep:

- **Third-party actions are pinned to a full commit SHA**, with the release named
  in a trailing `# vX.Y.Z` comment. Never a moving tag.
  `helpers:pinGitHubActionDigests` in the Renovate config makes that automatic
  for actions added later, and Renovate updates the SHA and the comment together.
- **`permissions:` is declared explicitly and minimally** (`contents: read`). Do
  not fall back on the default token scope.
- **No `version:` input on `pnpm/action-setup`.** v6+ reads
  `devEngines.packageManager` from `package.json`, so the pnpm pin lives in one
  place. It must run _before_ `setup-node`, because `cache: pnpm` resolves the
  store path by invoking pnpm.
- **No secrets, no deploy job.** Cloudflare Pages does not build this repo, so CI
  is a check only. `pnpm refs:sync` is absent for the same reason it is absent
  from `verify`: no runner has a Factorio binary.
- **The `build` job's default shallow checkout is correct, and that was
  measured.** #61 assumed the build stamp needed deeper history; it does not.
  `scripts/buildStamp.ts` runs `rev-parse HEAD`, `rev-parse --short HEAD` and
  `status --porcelain` - it reads git **state**, not history. On a
  `pull_request` event the checkout lands on the merge commit, so that job's
  stamp is a synthetic SHA; harmless only because CI never deploys its artifact.

`preview:test` needs **no Docker** on a runner, which was confirmed rather than
assumed: the worker tests are pool-workers (`workerd` arrives from npm) and the
container tests are `node --test` against `render.mjs`.

**Renovate, not Dependabot** - `.github/renovate.json5`. The reason is that this
project's dependency decisions are _holds_ with reasoning behind them, and
Dependabot's `ignore` entries cannot express them; Renovate's `packageRules` +
`prBodyNotes` can, so the reasoning arrives attached to the proposal. `typescript`
is disabled outright, `pako` carries a 14-day age and a pointer at the
byte-exactness invariant, `wrangler` + `@cloudflare/vitest-pool-workers` are
grouped because pool-workers hard-pins wrangler, and the `brace-expansion`
override and `engines.node` floor are both marked as deliberate rather than stale.

**The worker's `vitest` is coupled to `vite-plus`, and Renovate does NOT know
it** (measured 2026-08-25). Renovate lists "Update dependency vitest to v4.1.11"
as its own item, and taking it alone leaves `pnpm peers check` reporting an
unmet `@vitest/browser-preview`: vite-plus pins the whole `@vitest/*` family at
its own version (0.2.9 carries 4.1.10, 0.3.0 carries 4.1.11), so the worker's
`vitest` has to move **with** vite-plus rather than ahead of it. The gate cannot
see this - `pnpm run verify` passed with the split - so check `pnpm peers check`
after any bump that touches either.

**`pnpm outdated`'s "latest" is a trap for `wrangler`.** pool-workers pins it
EXACTLY (`0.21.3` -> `wrangler = 4.123.0`, `0.22.0` -> `4.124.0`), so taking the
newest wrangler splits the tree into two copies - which matters because
`wrangler types --check` runs the direct copy while the tests run pool-workers'.
Move wrangler to whatever version the pool-workers being installed names, not to
`latest`, and confirm with `grep -oE "^  wrangler@[0-9.]+:" pnpm-lock.yaml`
returning ONE line.

**`enabled: false` disables SECURITY updates too, and `brace-expansion` proved
it.** That rule exists to stop Renovate proposing the 5.x spike, but it also
means no bot PR can ever arrive for the 2.x branch - including a CVE fix. On
2026-08-10 the pin was sitting at 2.1.3 against **GHSA-rgw5-rvv9-x895**
(published 2026-08-03), whose whole subject is _bypassing_ the CVE-2026-14257
mitigation 2.1.3 was pinned for; 2.1.4 had been available since 2026-07-30.
Nothing was going to surface that, because the note in `pnpm-workspace.yaml`
said a red `pnpm audit` line was the expected state - which had been true of the
_previous_ advisory and had since stopped being true. Any package held with
`enabled: false` needs re-checking against the advisory database by hand; read
the comment on the override before concluding a red audit is the known one.

**That group's `prBodyNotes` says to regenerate the worker types BEFORE merging,
and that ordering is the whole point.** It used to say _after_, which this file
flagged as a bug to fix; the config was corrected and the note now reads
correctly - confirmed on 2026-08-10 when #169 hit exactly this. The regen is a
precondition, not a follow-up: `types:check` runs inside `preview:test`, which
runs inside the required `verify` check, so a stale `workerd` stamp means the PR
cannot merge at all. This is not hypothetical - it is why #97 sat red, and why
#169 arrived red a year later with the fix named in its own PR body. The fix is
one script, which exists precisely so the formatter pass cannot be forgotten
(#177):

```bash
pnpm run types:sync
```

One interaction is worth knowing before touching that file. The workspace's
release-age guard is a **pnpm default**, not a line in `pnpm-workspace.yaml`, and
pnpm's response to being asked for something too fresh is to write a
`minimumReleaseAgeExclude:` bypass - which is how `vue-tsc@3.3.8` once waived it
silently. `minimumReleaseAge: "3 days"` is therefore declared in the Renovate
config, above pnpm's default, so Renovate can never propose a release pnpm would
want a bypass for. If `minimumReleaseAgeExclude:` appears in a bot PR's diff,
that PR is wrong; fix the age rule, don't commit the bypass.

**The app is live as of 2026-07-30** - enabled with "Automated PRs", "Require
config file" and "Create onboarding PRs". So Renovate opens real PRs on its own
now; `automerge: false` is what keeps anything from _landing_ unread, and
`dependencyDashboardApproval` is deliberately unset because it would re-impose
scan-only behaviour at the config layer and defeat the app setting.

"Require config file" is the one with teeth: **a config that fails to parse makes
Renovate do nothing at all, silently**, which is indistinguishable from "no
updates available". Validate any edit with `renovate-config-validator` (run it
from outside the project root - a bare `npx` here fails with `EBADDEVENGINES`).

Two settings whose reasoning is not guessable from the outside:

- **`lockFileMaintenance` is pinned off.** It is automated `pnpm up` for the
  lockfile - the one dependency operation measured as harmful here, since
  transitive re-resolution is what triggered the `TS2321` pathology below.
- **`vulnerabilityAlerts.minimumReleaseAge` is `"25 hours"`, not `0`.** Security
  fixes skip the weekly window, but they cannot skip pnpm's 24-hour floor: a
  same-day PR would make pnpm write the `minimumReleaseAgeExclude:` bypass this
  whole section exists to prevent. 25 hours clears pnpm and still drops the wait
  from 3 days to ~1.

### Branch protection is a **ruleset**, and one Renovate rule depends on it

`main` is protected by a repository ruleset named **`EJ`** (2026-07-30, issue
#60), not by classic branch protection. Read it with
`gh api repos/FactoryGameFan/FactorioMapWebUI/rules/branches/main` - the classic
`/branches/main/protection` endpoint returns **404**, which looks exactly like
"unprotected" and is not.

| rule                           |                                      |
| ------------------------------ | ------------------------------------ |
| `pull_request`                 | `required_approving_review_count: 0` |
| `required_status_checks`       | `verify` + `build`, `strict: true`   |
| `deletion`, `non_fast_forward` | blocked                              |
| `bypass_actors`                | **empty** - binds the owner too      |

Three things here are load-bearing and easy to break by "tidying":

- **`verify` is now a gate job that does no work.** Since the CI sharding above,
  the check by that name only asserts that `static` and the four `tests` shards
  passed. It looks deletable and is not: the ruleset matches required checks by
  **name**, so renaming or removing that job makes the required `verify` never
  appear, which blocks every PR permanently.
- **The review count is 0 on purpose.** GitHub does not let you approve your own
  PR, so `1` would make `main` unmergeable by its only maintainer - a lockout
  that looks like correct hardening until the first PR.
- **`strict: true` is what makes the Renovate automerge rule safe.** With strict
  checks a PR cannot merge having passed against a different `main` than the one
  it lands on. `.github/renovate.json5` automerges GitHub **Action digest
  re-pins** and only those; if bypass actors are ever added, `verify` dropped, or
  strict turned off, **that rule must be removed in the same change.** It is not
  independently safe, and the config says so at the rule.

**Adding a new required check is a two-step, in this order.** Land the job
first, confirm it ran green on `main`, and only then add its context to the
ruleset. Requiring a check that does not yet exist on `main` blocks the very PR
that introduces it, on a check that cannot run. `build` was added this way on
2026-07-30: merge #64 -> green on `main` -> `PUT /rulesets/20021316`. Send the
**whole** `rules` array in that PUT (fetch it first with
`gh api repos/:owner/:repo/rulesets/20021316`); it replaces rather than merges.

Note the second-order effect of `strict: true`: once a PR merges, every other
open PR is behind and needs **Update branch** before it can merge.

Everything else stays `automerge: false`, because `verify` proves the repo is
consistent, not that a bump is correct - see the pako table above for the year-long
wrong belief that a green suite endorsed.

#### `testTimeout` is 30s, deliberately, and retries are not used

Vitest's 5s default was too tight for this suite long before CI existed. Counted
on `test/*.spec.ts` at #207 (2026-08-15): **94 tests across 31 files** carry an
explicit `}, 120000)`, and **74 tests across 17 files** carry `}, 300000)`. That
is the same complaint made 168 times by hand. The first CI run proved the
default was the real problem rather than any one test: on a 4-core runner (~3x
slower, 230s vs 71s for the same suite) `elevationRenderRequest.spec.ts`'s
`view 'all'` case needs **9.8s**, and that file has 27 tests and zero
annotations. `vite.config.ts` now sets `testTimeout: 30_000`; the existing
annotations still win over it, so raising the global does nothing for any of
those 168 tests.

**Do not trust a hand-maintained count here - this one has now gone stale
twice.** It read "24 across 10" for a year, was corrected to "86 across 29" on
2026-08-15, and was still wrong the same day: the real figures were 89/30 and
66/16 before #207 even landed. Re-count before quoting:

```bash
git grep -c '}, 120000)' -- 'test/*.spec.ts' | awk -F: '{s+=$3} END {print s}'
```

**120000 is not a safe ceiling, and 300s is not one file's exception.** This
paragraph used to say `previewAgreement.spec.ts` took 300s "as of #203" and that
it was the only file moved off 120s. Both halves are wrong. 17 files use 300s,
and the practice long predates #203 - the earliest arrived with the cliff work
in #122. It also named an 85.2s case in `vulcanusCliffRejectionStage.spec.ts` as
the nearest to the edge at 120s; that file carries **zero** 120s annotations and
three 300s ones, so the claim's premise is void. Which test now sits nearest its
own budget has not been re-derived - it needs a fresh per-test read off a CI run,
not a grep. Treat that as an open question, not a settled one, if a shard goes
red on a timeout.

Do **not** reach for `retry` when a heavy render test fails in CI. Nothing here is
nondeterministic - these tests compare pixels against captured game output - so a
retry would only hide a genuine regression. A timeout means slow; read the
duration the reporter prints before assuming a hang.

#### `unstubGlobals` + `restoreMocks` are on, and `test/mockLeakGuards.spec.ts` is why they stay on

Both are set in `vite.config.ts` (and, inertly, in the worker's config) as of
#144. `vi.restoreAllMocks()` - which a few files call in an `afterEach` - undoes
`vi.spyOn` spies and does **not** undo `vi.stubGlobal`, so before this a stubbed
global leaked into every later test in the same file.

**The leak was real but nothing depended on it**, which is the part worth
knowing: turning the flags on changed no existing test, and the two
`previewPanel.spec.ts` tests that were inheriting a `URL` stub pass alone too. So
the suite cannot tell whether these flags are set, and deleting them would be
silent. `test/mockLeakGuards.spec.ts` is the observation that makes them
load-bearing - two dirty/clean test PAIRS, deliberately order-dependent, each
failing with a message naming the missing flag. Both were confirmed to
discriminate by flipping each flag off and watching only its own pair fail.

Two weak-assertion patterns were **checked and cleared**, so don't re-audit them:
`expect(wrapper.find(sel).attributes("disabled")).toBeUndefined()` is not vacuous
on a missing element - `@vue/test-utils` throws `Cannot call attributes on an
empty DOMWrapper` - and `presetReset.spec.ts`'s `activePreset?.x` assertions are
not vacuous either, because a seeded preset makes them discriminate. Both were
settled by planting the failure, not by reading the code.

### Deploys are gated on `verify`

Both deploy paths refuse to ship a broken tree. `deploy:app` runs
`pnpm run verify` first, and the Worker's own `deploy` runs its `test` script
(which itself chains `wrangler types --check`). Verified by planting failures:
a type error and a failing test each stop the chain before `wrangler` is
reached, and a clean tree passes through.

Note `verify` uses plain `vp check`, **not** the `check` script - that one is
`vp check --fix`, and a deploy must never silently rewrite files on its way out.

The app deploy is gated on the whole monorepo, `preview-service` included, so a
Worker test failure will block an app deploy. That coupling is deliberate: it
means "the repo is inconsistent, don't ship." To deploy anyway in an emergency,
run the two steps by hand rather than adding a bypass script:

```bash
pnpm build && pnpm --filter @fmw/preview-worker exec wrangler pages deploy dist \
  --cwd ../.. --project-name factoriomapwebui --branch main --commit-dirty=true
```

The app is live at **`map.factorygamefan.com`**. The apex `factorygamefan.com`
is a separate landing page, not this app; the worker's `ALLOWED_ORIGIN` is the
`map.` subdomain.

### Confirming a deploy landed - `pnpm run verify:deploy`, not grep

**Never confirm a deploy by grepping the live bundle.** That is what was done
before, and it produced a false negative: a grep for a version string returned
zero because the minifier had turned the string into a numeric array, so a
shipped fix looked missing. Matching the hashed `index-<hash>.js` filename by eye
against the build log is the same class of fragile.

Instead the build emits a git-derived stamp to two places from **one** read:

- the titlebar shows `build <short sha>` (`-dirty` when the tree had uncommitted
  changes - a deploy from a dirty tree is exactly when the SHA alone lies), and
- `/version.json` carries the same object, machine-readably.

`scripts/buildStamp.ts` computes it and `buildStampPlugin` feeds both the
`__BUILD_INFO__` define and the emitted asset from the same `BuildInfo`.
`src/model/buildStamp.ts` is a **reader** over that define - do not compute
anything there. Two independently computed stamps that could disagree would be
worse than none, and `test/buildStamp.spec.ts` pins that they don't.

`pnpm run verify:deploy [origin]` fetches that JSON with caching bypassed and
compares the commit against local `HEAD`: 0 = live is your HEAD, 1 = it is not
(and names the commit that IS live), 2 = the check could not be made, which is
**not** a pass. It works against `vp dev` too, because the plugin serves
`/version.json` from a dev middleware as well.

`public/_headers` gives that one path `Cache-Control: no-store`. Its URL is
constant across deploys, unlike the hashed bundles, so without that the edge
would happily answer with the previous deploy's stamp - an authoritative-looking
wrong answer. The rule sets no CSP, so the `/*` policy still applies unchanged;
`script-src` must never regain `'unsafe-eval'` and the spec asserts it hasn't -
by whole TOKEN now, not by substring, because `'wasm-unsafe-eval'` contains the
string `unsafe-eval` (see below).

Preview-service stack (optional feature, needs Docker): **`pnpm localpreview`**
(memorable alias for `pnpm preview:dev`) runs the Worker (`:8787`) + app
(`:5173`) together; `pnpm preview:test` runs its unit tests. Both bind localhost
only - never add `--host`. See README for the full list.

`preview:dev` and `preview:deploy` are gated on `require:docker`, so a stopped
daemon now fails immediately with the start command for your runtime instead of
a wrangler build error several screens deep. `preview:test` is **not** gated -
it needs no Docker at all, which is what lets CI run it.

## Architecture

A static, backend-free SPA (Vue 3 `<script setup>` + Pinia) for authoring
Factorio map-generation presets, plus an optional Cloudflare preview
service in a separate workspace.

### The codec is the core, and byte-exactness is a hard invariant

`src/codec/mapExchangeString.ts` decodes a map-exchange string to a
`DecodedExchange` and re-encodes it. The encoder must reproduce the game's zlib@9
stream **byte-for-byte** - re-emitting a string must equal the original.
Consequences that constrain any change here:

- Deflate goes through **`pako` at `{ level: 9, legacyHash: true }`**, and that
  option is load-bearing - see `src/codec/deflate.ts`. The requirement is
  **madler-zlib-compatible output at level 9**, not any particular package.
  Measured against the 9 fixtures (Node v26.5.0, `process.versions.zlib`
  1.2.12; decode base64 -> inflate -> re-deflate -> compare):

  | candidate                                           | byte-exact |
  | --------------------------------------------------- | ---------- |
  | `node:zlib` `deflateSync({level:9})`                | 9/9        |
  | `pako@3.0.1` `deflate(b,{level:9})` (defaults)      | 0/9        |
  | `pako@3.0.1` `deflate(b,{level:9,legacyHash:true})` | **9/9**    |
  | `pako@2.1.0` `deflate(b,{level:9})`                 | 9/9        |
  | `fflate@0.8.3` `zlibSync(b,{level:9})`              | 0/9        |

  A level-1 deflate matches 0/9, confirming the comparison discriminates.
  fflate genuinely does diverge - it is an independent reimplementation and no
  option fixes it. Inflate is not a constraint at all: pako's `inflate`,
  `node:zlib`, and `DecompressionStream('deflate')` all agree on all 9.

  **Why the old belief ("pako diverges, so a WASM build of zlib is the live
  replacement path") was held, and why it was wrong.** It was a true
  measurement of a false generalisation. pako **2.2.0** (2026-06-22) added an
  alternate, faster deflate hash behind a new `legacyHash` option defaulting to
  `true`; pako **3.0.0** (2026-06-26) flipped that default to `false`. This repo
  adopted `^3.0.0` on 2026-07-01, five days later, and measured pako at its
  defaults - the one configuration that cannot match canonical zlib. The
  divergence was real; "no configuration of pako can match" was never tested.
  Issue #40's premise (zlib-asm is load-bearing) is refuted, and no WASM build
  is needed.

  The new risk is different and worth naming: **`legacyHash` is a pako
  extension, not part of the zlib API**, from a library that has already flipped
  its default once in a major version. `test/deflate.spec.ts` has a dedicated
  block that fails with a message naming the option if it is ever dropped,
  renamed, or re-defaulted. Do not silence it by editing a fixture.

- **The CSP does NOT need `unsafe-eval`, and must not regain it.** Nothing the
  app bundles uses `eval` at all - `pako` is plain ESM. This used to need a
  caveat: the codec was backed by `zlib-asm`, an abandoned (2016) asm.js port
  that shipped three `eval` sites and needed a local `patches/zlib-asm.patch`
  to strip them. That dependency, its patch, and both of its `vite.config.ts`
  build-warning suppressions are gone.

  **It DOES carry `'wasm-unsafe-eval'` as of #222, and that is a different
  token.** It permits WebAssembly compilation and instantiation and nothing
  else - no `eval`, no `new Function`, no inline script - and the Rust noise
  engine cannot start without it: `WebAssembly.compile` throws a CSP error.

  The two names are the trap. The guard in `test/buildStamp.spec.ts` used to
  assert the policy did not CONTAIN the substring `unsafe-eval`, and
  `'wasm-unsafe-eval'` contains it, so that guard would have gone red on the
  correct policy. It now splits `script-src` on whitespace and compares whole
  tokens, asserting both directions: no `'unsafe-eval'`, and `'wasm-unsafe-eval'`
  present. **The second half is not symmetry** - dropping the narrow token does
  not loosen the policy, it breaks the app in production, and that failure
  arrives looking like "the preview stopped working" rather than like a CSP
  change. Both halves were proven by planting them and watching each go red.

- **The exchange format is versioned and it moves.** `SUPPORTED_VERSIONS` is a
  known-good list (`2.1.9.3`, `2.1.12.2`, `2.1.14.1`, `2.1.15.2`, `2.1.16.0`) and
  never a range, because the schemas here are empirical: accepting an unseen
  format would decode a changed layout into plausible wrong values. A version
  joins the list only with a fixture proving a real string of it round-trips
  byte-exact (`test/mapExchangeVersions.spec.ts`). This has now been a live bug
  **four times**: the app rejected every string from Factorio 2.1.12 until
  2026-07-28, from 2.1.14 until 2026-08-13, and from 2.1.15 and 2.1.16 until
  2026-08-24 - **the last two on the same day, because Wube shipped both**. Every
  time the game moved under a Steam auto-update, and every time it was found by a
  version audit rather than by a user. The UI advertises the target so the next
  drift is visible, and `test/factorioTarget.spec.ts` fails the build if
  `FACTORIO_TARGET_VERSION` disagrees with the newest fixture provenance - so do
  not hand-maintain that constant.

  **Read the tag off `factorio --version`, not off the patch number.** The
  binary prints a `Map output version: X.Y.Z-W` line and that maps 1:1 to the
  four-part exchange tag - confirmed on a binary whose tag we already knew
  (2.1.14 prints `2.1.14-1`, and `[2,1,14,1]` is what the list carries), which is
  a control rather than a pattern match. The fourth part is **not monotonic and
  does not track the patch**: `.3`, `.2`, `.1`, `.2`, `.0` across 2.1.9 to
  2.1.16. It FELL to zero at 2.1.16. It cannot be guessed, and one `--version`
  answers "has import broken?" in a second.

  **This machine's Steam tracks the EXPERIMENTAL branch**, which is why two
  format moves arrived within hours of each other. Expect drift here to be more
  frequent than a user on stable would see, and do not read "the game moved
  again already" as a sign something is wrong.

- **Capturing a new version is now a script, not a recipe in a comment.**
  `scripts/probes/exchange-format/capture.ts` does the whole thing through
  `factorio-oracle`, five cases in about 10 seconds:

  ```bash
  node --experimental-strip-types scripts/probes/exchange-format/capture.ts 2.1.16
  ```

  It reads each case's settings back out of the PREVIOUS version's fixture with
  the game's own `helpers.parse_map_exchange_string`, so "the five cases mirror
  the last version's setting-for-setting" is a mechanism instead of a claim. The
  previous version is DERIVED - the newest committed strings fixture older than
  the target - so chaining 2.1.14 -> 2.1.15 -> 2.1.16 needed no edit.

  **The one trap, measured rather than reasoned:** feed a whole parse back as
  `--map-gen-settings` and every case inflates from 711 bytes to 1387, because
  the parse fills in all 28 autoplace controls and the exchange string writes
  every control that was supplied EXPLICITLY. That flattens all five cases to
  the same length and quietly destroys the only reason there are five - they
  exist to VARY the layout. Feeding back only the DELTA against the default case
  reproduces the previous fixture's own sizes exactly, 750-byte `controls-off`
  included. `autoplace_settings` is dropped outright: the game's parse returns
  `{}` for it where the live surface has it fully populated, so it is lossy in
  the parse direction and carries no case information.

- **The tail schema is VERSION-DEPENDENT as of 2.1.14.** It was
  one constant for the format's whole history until `map-settings.lua` gained
  `enemy_expansion.build_base_unit_dispatch_cooldown` (`30 * 60` ticks) between
  2.1.12 and 2.1.14. It serializes in section order, so it lands after
  `max_expansion_cooldown` and **before `unit_group`** - it shifts every section
  after it rather than appending harmlessly at the end. `tailSchemaFor(version)`
  in `src/codec/mapExchangeString.ts` picks the layout, matched on the **exact**
  tag for the same reason `SUPPORTED_VERSIONS` is a list rather than a floor.

  **2.1.15 and 2.1.16 both share that layout rather than getting their own**,
  which is why the constants are named for the FIELD
  (`TAIL_DISPATCH_COOLDOWN_*`) and the selector reads a list of tags. Three
  independent readings per version, none of them "it looked the same":
  `base/prototypes/map-settings.lua` is absent from each tag-to-tag diff
  entirely; all five re-captured cases inflate to the exact byte counts their
  predecessors do; and the game's own parse of each new default string is
  identical across all 186 leaf fields. At 2.1.15 `map-settings.example.json`
  DID change and is a red herring - it was catching up to the 2.1.14 default
  change it had missed. 2.1.16's whole data diff is `info.json` version bumps
  and the changelog.

  The spec covers these with a `describe.each` over a `LAYOUT_HEIRS` table, each
  entry mirrored against the version before it - three near-identical describe
  blocks was the signal to stop pasting. The table is deliberately NOT derived
  from `SUPPORTED_VERSIONS`: that would make the spec agree with the codec by
  construction, and the tag is one of the things being asserted.

  Two consequences worth knowing before touching this:
  - **A wrong schema choice is loud, not subtle** - decoding a 2.1.14 string
    with the older layout over-reads the payload end and throws
    `payload truncated: read of 8 bytes at offset 706 ...`. That is luck, not
    design; a future added field could land somewhere that decodes silently
    wrong instead, so do not treat a clean throw as the expected symptom.
  - **`Preset` must carry `formatVersion` through the bridge.** `convert.ts`
    stores the tail as opaque base64, so `tailToBytes`/`bytesToTail` both take a
    version. Dropping it silently corrupts a 2.1.14 import on export;
    `test/convert.spec.ts` plants exactly that and fails.

  The layout was confirmed against the game's own
  `helpers.parse_map_exchange_string`, not just against our own re-encode: all
  81 tail fields agree, and `opaqueTail` decodes to length 0. **Export was never
  broken** in any of the three incidents - each newer game still accepts the
  `2.1.9.3` strings this app emits, and 2.1.15 parsed all five `2.1.14.1`
  captures during its own capture run, so only import was ever affected.

- `src/codec/fieldSchema.ts` (`readFields`/`writeFields`) drives the typed
  binary layout; `binaryReader`/`binaryWriter`/`crc32`/`base64` are the
  primitives.
- `test/fixtures/builtin-presets.json` (9 presets captured from the game) is
  **read-only ground truth**. Codec tests decode→re-encode each and assert the
  bytes are identical. Never edit a fixture or an expected value to make a test
  pass - a mismatch is a real finding.

### Fixture provenance - every fixture states which version it came from

`test/fixtures/PROVENANCE.json` records, per fixture, the Factorio version its
ground truth was captured from and the **evidence** for that claim. It sits
beside the fixtures rather than inside them because several are verbatim copies
of the game's own JSON (`autoplace-can-be-disabled.dump.json` is a flat dict
keyed by control name, asserted key-for-key in `catalog.spec.ts`), so an added
metadata key would be data pollution.

- `test/fixtureProvenance.spec.ts` runs always, needs no Factorio, and fails if
  a fixture has no entry or an entry has no fixture. **Adding a fixture means
  adding its provenance.**
- `pnpm refs:sync --fixtures` needs a binary and reports which fixtures predate
  it. It is a **report, not a gate** - it always exits 0 and is deliberately not
  in `verify`. A 2.1.11 fixture is not wrong because the binary reached 2.1.12;
  it means that ground truth has not been re-validated, and whether the gap
  matters depends on whether the subsystem changed.
- `evidence` grades confidence: `stated` beats `inferred`, and `unknown` means
  nobody wrote it down. Don't promote an inferred entry without re-capturing.
  The spec caps `unknown` at its current count so the gap can only shrink.

Turning "38 fixtures are old" into "these N need re-capturing" is a separate
audit, **run 2026-07-28 and completed 2026-07-29**:
`docs/fixture-version-audit.md` holds the procedure, the fixture-to-Lua-file
map, the rule for what counts as invalidating, and now its Conclusions. Unlike
`docs/superpowers/specs/`, that one is a live document - update it when it is
re-run.

The answer to "how many need re-capturing" was **zero**, twice over. All the
data-governed fixtures sit on map-gen Lua that is byte-identical 2.1.11 ->
2.1.12, and the ten noise-primitive fixtures - which no data diff can ever
clear, because they are native C++ ops that `factorio-data` only calls - were
re-sampled against the 2.1.12 binary and came back bit-identical on all 2648
values. Two things came out of it that staleness never would have: the live
`2.1.12.2` format-tag bug (the app rejected every string from the current
game), and the fact that only `oracle-basis` had a standing re-sample guard
while the other primitives had none.

This exists because version skew is invisible from inside: the Vulcanus
surface-seed bug passed every internal check for weeks because the fixture and
the code agreed with each other while both disagreed with the game.

### Diff artifacts are NOT fixtures - `test-output/` vs `test/fixtures/`

When an image comparison in `test/previewAgreement.spec.ts` or
`test/wasmFulgoraRenderParity.spec.ts` fails, `test/diffArtifacts.ts` writes the
reference, our render, a magenta mask, a false-coloured magnitude view and a
`stats.json` into `test-output/preview-diffs/<spec>/<case>/`, and the assertion
message names that directory - both repo-relative and absolute, because the
relative form does not resolve from a CI log (#252). A scalar like
`expected 237 to be less than 200` says a render moved without saying where, and
where has repeatedly been the answer here.

Three rules, and the first is the one that matters:

- **They never get committed and never get a `PROVENANCE.json` entry.** A
  fixture is ground truth captured from the game; an artifact is a photograph of
  a failure taken by this repo. `test-output/` is gitignored precisely so the
  two cannot be confused.
- **They are written only when an assertion has already thrown.** A green run
  writes nothing. `withDiffArtifacts` wraps the `expect` calls and re-throws the
  same error rather than re-testing the bound, so no bound is ever stated twice.
  The one caller that writes unconditionally is the smoke spec itself, which
  calls `writeDiffArtifacts` directly and therefore carries an `afterAll` -
  without it a fully green `verify` leaves five populated directories behind and
  makes this very sentence read as a lie.
- **Nothing in there asserts anything, and no bound moved to add it.** The
  artifacts answer "where", after a bound that already exists has failed.

**The exclusion mask must be defined once and passed to both** the counting loop
and the wrapper's `ignore`. Written out twice the copies drift, and then the
artifacts describe a different comparison than the bound that failed - the same
objection that made wrapping the assertions the right shape in the first place.
Excluded pixels are navy in **both** images: left black in `diff-magnitude.png`
they are drawn exactly like pixels that agree, so the picture claims agreement
over a region nothing looked at.

`test/diffArtifacts.spec.ts` is the guard on the writer itself - the machinery
runs only when something else is broken, which is the worst time to find out it
is broken too. It also pins the palette: a 1-count channel delta must come back
clearly visible, not near-black, which is why the amplification is a lifted log
ramp and not the `delta * 5` the prior art uses. (35% is the ramp's FLOOR; delta
1 lands at 43.1%.)

**`decodePng` verifies every chunk CRC, and that is load-bearing rather than
tidy.** `encodePng`'s header claims the round-trip through it turns a wrong CRC
into a test failure. That claim shipped false: the decoder advanced by
`12 + len` and never read the CRC bytes, so breaking the chunk writer left all
seven smoke tests green while every artifact the feature writes would have been
rejected by Preview, Chrome and ImageMagick - discovered at the one moment
somebody is already looking at one because something else broke. The spec now
plants a flipped CRC byte and a corrupted payload so the guard cannot lapse back
into a claim.

### Two representations, bridged by `convert.ts`

The codec speaks `DecodedExchange` (raw wire shape). The app speaks `Preset`
(`src/model/types.ts`). `src/model/convert.ts` maps between them
(`presetFromDecoded` / `presetToEncodable`). `src/model/builtins.ts` decodes the
9 fixtures once and hands out deep clones (`getBuiltinPreset`).

### The store is the reactive spine

`src/store/presets.ts` (Pinia) holds `userPresets: Preset[]` + `activeName`. Two
getters matter: `activePreset`, and `activeExchangeString` (a live re-encode of
the active preset). Editing any control mutates the active `Preset` in place, and
`activeExchangeString` recomputes through Pinia reactivity - that is how edits
flow to the exported string. **Edits are NOT persisted to localStorage until an
action calls `saveToStorage()`** (most control-slider edits don't; they survive
in-session but are lost on reload until a Save). `seed` is the single source of
truth for "random each new map": `null` = random, which encodes to wire `0`.

### Controls: autoplace vs. climate (an important asymmetry)

- **Autoplace controls** (iron, coal, enemy-base, cliffs, ...) have dedicated
  `frequency`/`size`/`richness` floats stored in `Preset.autoplaceControls`.
  `src/model/controlCatalog.ts` is the catalog (labels, planet); `ControlTable` /
  `ControlRow` render them bound to the store.
- **Climate controls** (moisture, aux = "terrain type") have **no** dedicated
  struct - only `frequency` + `bias`, stored purely as `property_expression_names`
  overrides (`control:moisture:frequency`, `control:aux:bias`, ...). Accessed via
  `src/model/climateControls.ts` (`{ freqKey, biasKey }` + read/write helpers).
  Writing a value that snaps to the default notch **deletes** the key (so an
  edited-then-reset preset stays byte-identical to the game's empty dict).
- `src/model/controlScale.ts` holds the slider notch math: geometric
  `PERCENT_STEPS`, and the `StepScale` abstraction (`PERCENT_SCALE` /
  `BIAS_SCALE`) that lets one `FPercentSlider` serve both percent and bias.
  Scale is stored as `frequency = 1/scale`; all wire values are `toFixed(6)`.

### UI

`App.vue` hosts the tabbed editor (Resources / Terrain / Enemy / Advanced).
`src/ui/` is a Factorio-styled component kit (`F*` components + `factorio.css`).
Sliders bind through the store so edits reach `activeExchangeString`.

`src/store/ui.ts` (Pinia `useUiStore`) holds UI-only preferences - currently
just `devMode` - and persists immediately under `fmw.devMode`, unlike the
preset store's Save-gated persistence. Dev mode reveals the preview panel's six
view toggles and the elapsed-ms render readout; it is toggled by the toolbar
"Debug" checkbox and can be seeded from the URL with `?dev=1` (or forced off
with `?dev=0`).

The **Enemy tab** (`src/components/EnemyTab.vue`) is the one tab that edits
MapSettings _tail_ fields (`mapSettings.enemyEvolution` / `enemyExpansion`),
overlaid back onto the tail at encode time by `writeEnemyToTail` - so untouched
imports stay byte-exact (values are converted only on set). Three non-obvious UI
conventions live here:

- **Evolution factors are scaled for display.** The game's map-gen GUI shows
  these tiny wire floats scaled up: time & pollution `display = wire * 1e7`,
  destroy `* 1e5` (so default time `0.000004` reads `40`, destroy `0.002` reads
  `200`, pollution `0.0000009` reads `9`). `EVO_DISPLAY_SCALE` in `EnemyTab.vue`
  holds this; the slider/box work in display space, the wire stays raw. Verified
  against the game by importing strings with known wire values and reading the
  GUI.
- **Cooldowns display in minutes**, stored as ticks (`* 3600`).
- **Min/max expansion distance are linked** (max always > min, both clamped
  `[1,20]`); editing one drags the other.

Field labels carry in-game tooltip text via `FInfo` (an `info` prop on
`EnemyValueRow`, an `info:` entry in `controlCatalog.ts` for the enemy-base
autoplace rows).

### The Rust/WASM noise engine (`crates/`) - phases 1-4 landed, phase 5 in progress

A Cargo workspace at the repository root, landed empty on purpose (#219) so the
gate was proven green on `main` before any port code depended on it. Two crates:
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The design record is
`docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

**Do not read the byte counts in this section as current.** They have gone stale
twice already, because every ported op changes them: 599 bytes at phase 0, 23,363
after `basis_noise` and the multioctave family, 42,952 after the phase-1
primitives. `verify:rust` compares the committed module against a fresh build, so
the gate always knows the right number even when this file does not. Get it with
`shasum -a 256 src/noise/wasm/engine.wasm`, and do not add a new count here
without deciding it is worth maintaining.

**Phase 1 is complete** (#220): `taus88`, `fast_approx`, `basis_noise` and its
gradient table, the four multioctave ops, `random_penalty`, `spot_candidates`,
`spot_selection`, `distance_from_nearest_point`, `starting_lakes` and
`voronoi_noise`.

**Phase 2 is complete** (#221): the `eval` layer - `multisample`, `memo_xy`,
`memo_region`, `math`, `ctx`, `primitives`, plus `expressions/vulcanus_seed`.
Five oracle fixtures joined tier 1 (`oracle-fastpow`, `oracle-multisample`,
`oracle-multisample-grid`, `oracle-seed-vars`, and the `sliderRescaleProbe` in
`oracle-fulgora-elevation`), which also closed a standing gap: `fast_approx`
shipped in phase 1 with **no tier-1 test and no poison hook** of its own.
`eval/f32.ts` has no Rust counterpart on purpose - the narrowing is the type -
and `eval/mod.rs` carries the two-case rule in its place.

**Phase 3's EXPRESSION half and its BOUNDARY are complete; the cutover is
not** (#223). Landed: `expressions/fulgora_shared`, `fulgora_cells`,
`fulgora_elevation`, `starting_spot_at_angle`, and `tiles/` with `water_base`,
`best_probability` and the ocean test the land mask is built on. Tier 1 grades
all 41 named fields against `oracle-fulgora-{shared,cells,elevation}` plus
`oracle-starting-spot`, and the whole chain end to end against
`oracle-fulgora-tiles` - 5,057 tiles the game actually placed. Tier 2 folds all
42 fields at two slider settings. The CSP change (#222) has landed.

Part 2 added the boundary: `crates/fmw-wasm/src/abi.rs`, `render.rs`, and
`src/noise/wasm/{request,engine}.ts`. **Tier 3 is byte-identical RGBA** against
`renderFulgoraLandMask` across four windows that vary width, height, origin,
tiles-per-pixel and both sliders independently.

**The request layout is at ABI v2 and is now per-planet** (#225). v1 was one
fixed 104-byte struct with Fulgora's two island sliders and four trig values
baked into it; v2 is a 56-byte common prefix followed by a block whose length
the prefix declares. v1's `reserved` word became `params_bytes` - what its own
comment said it was for - and its `ReservedNotZero` status became
`BadParamsLength`. A Fulgora request is still exactly 104 bytes; a Vulcanus one
is **368**, most of that being ten `(sin, cos)` pairs against Fulgora's two plus
two world boxes. It has grown twice since - 304 -> 336 for the cliff view's
`cell_query_box`, 336 -> 368 for the overlays' `placement_sweep_box` - and
neither time needed a version bump, which is the split working. Nauvis gets a
third block in phase 6, also with no bump.

`test/fixtures/wasm-request.v2.json` pins the encoding for both planets. It is
declared under `notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes were checked by
`test/fixtures/verify-wasm-request.py` - a third implementation, not the writer
under test - which is committed beside it so a future version is re-verified the
same way rather than regenerated from the encoder.

**That checker was measured MISSING a real defect, which is why it has three
trig checks and not one.** It cannot reproduce the trig VALUES, because those are
V8's `Math.sin` after an f32 narrowing and a second libm is exactly the
disagreement #270 measured. Checking each pair for `sin^2 + cos^2 = 1` catches a
shifted or half-shifted block - and **passed a planted swap of two bearings**,
which is the failure that renders a plausible planet with its biomes rotated. It
now also recovers each angle with `atan2` and checks it against the offset the
game's Lua gives it from the ashlands bearing. Seven planted breaks are caught,
up from four. A property check is not a structural check; this is the cheap way
to find out which one you wrote.

Errors return a **status code and do not trap**, because a trap would poison the
instance for every later request in that worker; a spec sends a bad magic and
then renders successfully through the same instance.

Part 3 is the cutover. `runRenderRequest(req, engine?)` takes an OPTIONAL
engine and dispatches Fulgora's land mask to it when one is supplied - a
parameter rather than module state, so nothing has to be registered or reset
between tests. `createRenderWorker` loads and compiles the module once per page
and posts it to each worker it creates; the worker instantiates synchronously
with `new WebAssembly.Instance(module)`, which is allowed for an
already-compiled module on any thread.

**A render dispatched before the engine message arrives is not a bug**, and that
is what makes the cutover safe rather than merely tested: the two paths are
byte-identical, so an early request takes the TypeScript path and returns the
same pixels. There is no window in which the worker is wrong, only one in which
it is slower - which is also why a failed fetch or compile is swallowed.
`test/renderWorkerEngine.spec.ts` asserts exactly that, comparing the pixels
from before the handshake against the pixels from after it.

**The engine load sits in `createRenderWorker`, not in `createWorkerHost`, and
that is not stylistic.** Every test that exercises the host constructs it with a
fake worker factory, and fetching from the host made those tests print a page of
`ECONNREFUSED` while still passing - under vitest the module URL points at a dev
server that is not running. Loading beside the real `new Worker` means only the
real browser path ever reaches the network.

The in-browser measurement is done - see the speedup table below. #223 is
complete.

**Phase 4 (#224) adds the rest of Fulgora**: `fulgora_masks`, `fulgora_roads`,
`fulgora_ruins`, `fulgora_scrap`, `tiles/fulgora_catalog` with the eight land
formulas and the argmax, and `fulgora_stack` composing the whole graph. Tier 1
grades 26 more named fields plus the scrap probability, and the FULL tile argmax
against the tile the game placed - **4,915 of 5,057**, the same count the
TypeScript reaches. Tier 2 folds 76 fields at two slider settings.

`poison::index_result` is the argmax's own control, and it needed one: under
poison the ocean hook flips every position's answer, so the tile test would have
been red whether or not the argmax had a control at all. `POISONED_TESTS` now
carries FULL test paths rather than bare `fixtures::` names, so a control can
live beside its op.

**Phase 5 (#225) ports Vulcanus, and the planet now RENDERS through the
engine.** Landed: `vulcanus_helpers`, `vulcanus_cracks`, `vulcanus_climate`,
`vulcanus_spawn`, `vulcanus_biomes`, `vulcanus_elevation`, plus
`vulcanus_temperature` on the elevation module; then `vulcanus_resources`,
`tiles/vulcanus_catalog`, `vulcanus_stack`, and the `terrain` render path
behind ABI v2. `vulcanus_shared` needed no port - it is
`starting_spot_at_angle`, done in #279 - and `vulcanus_seed` landed in phase 2.

**Phase 5's second half adds the CLIFF stack, and `cliffs` renders through the
engine too.** `cliffs/{catalog,placement,connections,vulcanus_fields,
vulcanus_ore_rejection}` plus the ore footprint slice of
`resources/vulcanus_catalog`.

**Phase 5's third part finishes Vulcanus: `rocks`, `resources` and `all` render
through the engine, so every view the planet has now does.** New modules:
`placement/roll` (the per-chunk taus88 placement roll and its two gates),
`rocks/{catalog,vulcanus_field,vulcanus_placement}`,
`resources/vulcanus_geyser`, and the rest of `resources/vulcanus_catalog` - map
colours, entry ordering, `sulfuric_acid_geyser_probability`. The routing test in
`test/wasmVulcanusRenderParity.spec.ts` used to assert those three views stayed
on the TypeScript path; it now asserts the opposite, and it is what would have
gone red had they moved ungraded.

**The placement roll is the first ported thing that is not a noise expression**,
and it is graded differently because of it. There is no per-position fixture:
the game's ground truth is `oracle-entity-counts.seed123456.json`, which is a
count per 512x512 region, and scoring one region costs **~33s in a debug
build** - the same order as the cliff connection test that already took
`verify:rust` to 1m50s. So the roll is graded against the game on the
TypeScript side (`test/entityDensity.spec.ts`, three rock regions and three
geyser regions) and the two ports are tied together by tier 3's byte-identity.
Its cargo tests are structural: the reverse-engineered chunk seed word, the
DECREASING tile order (the first draw belongs to tile 1023 - a reversal is
invisible to any density or uniformity check), salt decorrelation, and the
order-dependent collision pass.

**Tier 1 for the rock field is `oracle-vulcanus-rocks.seed123456.json` at 434
positions, and `vulcanus_decorative_knockout` is BIT-EXACT at every one of
them** - worst residual exactly 0, the strongest tier-1 result any Vulcanus
field has. It is a bare two-octave `multioctave_noise` at `output_scale = 1`,
so nothing sits between it and the primitives #290 and #293 fixed. The two
composites above it carry the biome layer's error: `vulcanus_rock_huge` 178 of
434, `vulcanus_rock_big` 205. All three counts were measured on the TypeScript
side too and agree exactly.

Read `density` (412 of 434) with its clamp: **399 of those positions clamp to
exactly 0** and a saturated position is exact for free, so of the 35 nonzero
positions only 13 are exact. Same reading `*_biome_full` versus `*_biome` gets
in the biome layer.

**The TypeScript's own bounds on those three fields are 2e-4 / 5e-4 / 5e-4
against measured worst residuals of 0, 3.7199e-7 and 2.5693e-7** - the first
inert outright, the other two 1,300x wider than the thing they bound. That
side's comment still describes the knockout's residual growing with distance to
1.18e-4, which was true before #290 and #293 narrowed `basis_noise`'s input
scale and is not true now. Recorded rather than fixed there; it belongs to #256
with the other 86.

**ABI v2's Vulcanus block grew again, 280 -> 312, and again with no version
bump.** The new field is a SECOND world box, `placement_sweep_box`, and it is a
second box rather than a reuse of `cell_query_box` because the two halos are
different shapes: the cliff block spans `px - 2 ..= px + 1`, so its halo is
asymmetric and its two directions cross, while a placement mark is a symmetric
3x3 centred on its pixel. `test/fixtures/verify-wasm-request.py` grew six more
planted breaks for it, every one RUN rather than listed - five are caught by
the per-edge value check (the cliff box written into both slots, the two boxes
swapped, a block shifted by one f64, one edge wrong, a stale declared length)
and the sixth is not: a halo one tile wider on the low x side, with the request
edited to agree, passes every value check and is caught only by asserting the
placement halo is symmetric about the pixel box. The no-coinciding-edge check
caught none of the six and is a fixture constraint, which the file now says.

**The measured geyser peak in the TypeScript was wrong, and the two numbers
recorded beside each other did not agree.** `vulcanusResourceCatalog.ts`
recorded the sulfuric-acid geyser's peak probability as **0.0883** at
(2481, -1985) "where `patchy` is 1.217". The expression is
`0.025 * ((patchy > 0) + 2 * patchy)`, which at 1.217 is 0.08585; evaluating the
chain at that exact position at seed 123456 gives `patchy = 1.2172893` and
**0.0858645**. The position and the `patchy` are right and the probability was
not - 0.0883 would need a `patchy` of 1.266. Nothing depends on the difference
(both are two orders of magnitude below calcite's saturated ~1, which is all the
catalog-ordering argument needs), and both sides are corrected.

**Three of the nine TypeScript files in that directory pair were NOT ported, and
each for its own reason.** Read this before "finishing" them:

- `cliffFields.ts` and `rocks/rockField.ts` are NAUVIS. They need
  `nauvis_shared`, `elevation_nauvis`, `aux` and `moisture` - 464 more lines
  that are the core of #226 - and neither reaches a Vulcanus view. They belong
  to phase 6.
- `cliffConnections.ts` WAS ported, and it is the odd one: it has **zero `src/`
  consumers**. `grep -rln` finds it imported by 23 investigation specs and by
  nothing the renderer runs. It models `Cliff::updateConnections` /
  `onDestroy`, which is #84's subject, and it was ported so that investigation
  can be run against the engine rather than only against the TypeScript.

**Tier 3 for Vulcanus** (`test/wasmVulcanusRenderParity.spec.ts`) is
byte-identical against the TypeScript across four windows for `terrain`,
`cliffs`, `rocks` and `all`, and across five more for `resources`, and
**12,423 of 929,686** compared pixels against the game's own 1024x1024 PNG -
98.664%, which is the TypeScript's own number to four decimal places, reached
through a separate path. It is asserted as an EXACT count where
`previewAgreement.spec.ts` uses a 2% bound, because byte-identity means it can
be.

**Tier 2 for Vulcanus landed 2026-08-24 and CLOSED #225's last gate item**
(`test/wasmVulcanusParity.spec.ts` + `checksum_vulcanus`). It folds **74 named
fields** - helpers, spawn, cracks, climate, biomes, elevation, temperature,
resources, the geyser probability, the three tile-support fields,
`cliffiness_basic`, the knockout and the two rock expressions, then the 19 tile
probabilities and the argmax over them - at two slider settings in two windows,
296 comparisons of 676 points each, in **7.0s**.

**The parameters cross as a REQUEST, not as arguments**, and that is worth
copying for Nauvis. Fulgora's `checksum_fulgora` takes its seven parameters in
its signature; Vulcanus needs 31 more `f64` (three sliders, four resource
control pairs, ten bearings), so `checksum_vulcanus(request_len, field)` reads
the request already in the scratch buffer, written by the shipped
`encodeRenderRequest`. The win is not the shorter signature: the module then
builds its stack through the same `render::vulcanus_{ctx,base,biomes,stack}`
helpers the RENDERER uses, so a bearing wired to the wrong layer is INSIDE the
comparison. A private copy of that wiring would be reproduced identically on
both sides and stay invisible. The sweep is the request's own pixel grid, swept
rows-outer exactly as `render_vulcanus` sweeps it, so there is one geometry
convention rather than two.

**The field SELECTOR lives in `fmw-noise`, not in the wasm crate, and copy that
for Nauvis too.** `VulcanusParity` sits beside `VulcanusStack` in
`expressions/vulcanus_stack.rs`; the wasm export builds the stack through the
render helpers and then calls `parity.field(field, x, y)`. The reason is
ownership of test-only API: the selector needs `elevation_fields` and
`temperature`, which NO render path reads, and reaching them from another crate
meant two `pub` methods on a library type that existed solely for a test - and a
`pub` method cannot be `#[cfg(test)]`-gated, because the wasm crate calls it at
build time. Keeping the selector in the same module makes both private again.
The field count moved with it (`VulcanusParity::FIELD_COUNT`), so the count and
the `match` it bounds cannot drift apart.

The move is pure code motion and was checked as such rather than assumed: tier 2
(74 fields) and tier 3 (byte-identical renders) both pass unchanged. It DOES
move `engine.wasm` by 142 bytes, because the selector inlines differently once
it is in the same crate as the layers it reads - which is a reminder that a
wasm diff is not by itself evidence of a behaviour change.

**It found a real divergence on its first run, and the divergence was #309 -
now fixed, see below.**
`basisNoiseExpr` forms its coordinate product in f64 and narrows once
(`primitives.ts:66`); the Rust narrows `x` to f32 first and multiplies two f32s
(`primitives.rs:87`). They agree at every f32-exact coordinate and differ
everywhere else - **32 of the 74 fields** on an off-grid sweep, and one
narrowing takes that to **0 of 74**.

Three blind spots had to line up for that to survive three shipped PRs, and each
is worth more than the bug:

- **No fixture can grade it.** The game snaps every sample to its own 1/256
  MapPosition grid before evaluating (#186), and that grid is a subset of the
  f32-exact grid. At the snapped positions - the points the game actually
  visited - both forms give `hairline_cracks` **61 of 61 exact, worst residual
  exactly 0**.

  **Scoring at the RAW fixture coordinates is a trap that returns a confident
  wrong answer**, and it was walked into while chasing this: it reports 48/61
  for the TypeScript form and 50/61 for the Rust one, which looks like a
  measurement settling the question and is really a comparison at 21 points the
  game never evaluated. `test/captureGrid.ts` exists for exactly this; use
  `snapPosition` before scoring anything against a fixture.

- **Tier 3 cannot see it.** All four of its windows use binary fractions
  (origins `512.5` and `3000.75`, `tilesPerPixel` `0.5`, `1`, `8`), so every
  coordinate is f32-exact and the ports agree by construction.

- **The tile argmax absorbs it.** In the off-grid sweep `resolvedTile` matched at
  all 676 points while 17 of the 19 probabilities behind it diverged. That is the
  same property that made `poison::index_result` necessary, and it is the
  standing answer to "tier 3 is byte-identical, so why build tier 2".

**#309 IS FIXED, and it was settled by measurement rather than by the
internal-consistency argument this file used to record here.** That argument -
both ports' multioctave already narrows (`multioctaveNoise.ts:203`,
`multioctave_noise.rs:137`), the game holds its noise variables at f32 - pointed
the right way but proved nothing, and this section previously said so.

**The measurement came from a fixture already committed, not from a new
capture.** `fulgora_basis` is a multioctave read at Fulgora's DERIVED coordinate
`wx = ox + wobble_x * wobble_mask`, computed in f64 and therefore off the f32
grid at **55 of that fixture's 101 positions**. Scored against the game:

| `sumOctaves` incoming coordinate |       exact | worst residual |
| -------------------------------- | ----------: | -------------- |
| **narrowed** (what shipped)      | **101/101** | exactly 0      |
| un-narrowed (planted)            |      81/101 | 7.0333e-6      |

Twenty positions discriminate, so the game demonstrably narrows the incoming
coordinate, and the Rust form was the right one. `basisNoiseExpr` now narrows
`x` and `y` before the `input_scale` multiply.

**That is also the measurement #191 asked for, in its own words** - "a caller
that passes a derived coordinate" - and Fulgora has satisfied it since it
landed, unnoticed for months. Two lessons, and the second is the transferable
one:

- **Fold the fixtures you already HAVE before capturing more.** The plan here
  was a far-field capture at |x| >= 65536, where the 1/256 grid stops being a
  subset of the f32 grid. It would have worked and it was unnecessary: a
  DERIVED coordinate leaves the f32 grid right next to the origin, so the
  evidence was sitting in `oracle-fulgora-elevation` the whole time.
- **A "no fixture can grade this" claim is about the fixtures you looked at.**
  It was true of every Vulcanus fixture and false of a Fulgora one.

**#191 is two-thirds done and its issue text is stale.** Re-read the code, not
the issue: `quickMultioctaveNoise` ALREADY narrows both coordinates
(`quickMultioctaveNoise.ts:192-193`), so only one of its three ops was
outstanding. `variablePersistenceMultioctaveNoise` narrowed `x` and NOT `y` - in
**both** ports, which is why tier 2 could not see it: the two agreed with each
other while both disagreed with the game. `x` was narrowed only as a side effect
of the `f32(x + offset_x)` add; `y` had no add and so was silently multiplied in
f64. Both ports now narrow it.

The third op, `basisNoise` itself, was deliberately NOT changed. Its disciplined
callers all narrow before calling, so narrowing inside would be a no-op for
them - and its remaining direct callers (`nauvisShared.ts:133-134`,
`startingPatches.ts:185`, `regularPatches.ts:164-165`) are unported NAUVIS
chains where the whole expression is un-narrowed, not just the coordinate.
Planting the internal narrowing leaves all 26 of their specs passing, so no
committed fixture discriminates it. That belongs to #226, scored layer by layer
under the greedy-accept rule, not to a change that cannot grade it.

**The parity windows still sweep ON the f32 grid, and the pin has been
INVERTED.** `the two ports agree off the f32 grid` now asserts **0 of 74**
diverging where the pin froze 32, and reverting `primitives.ts` reproduces
`[ 'hairlineCracks', ...(31) ]` - checked by planting, not assumed. Its
anti-vacuity is not optional and is easy to get wrong: "nothing diverges" is
exactly what a sweep evaluating nothing would report, so the test also asserts
the off-grid window's folds differ from the on-grid window's on all 74 fields.
The windows themselves are kept as they are because they are tuned for FIELD
coverage (the `startingArea` range, all 19 tiles placed), not because the
restriction is still load-bearing.

Two anti-vacuity numbers, both frozen: the two windows differ on **all 74**
fields, and each places **all 19** tiles, so every probability fold is graded
over a window where its tile actually wins somewhere. The second slider setting
moves 50 of the 74; that one stays a floor, because which fields read a slider is
a property of the chain rather than a result.

**Tier 2 has a SHELF LIFE, and #227 is the deadline.** It compares Rust against
TypeScript, and #227 deletes the TypeScript. It can only ever be written while
both exist, so Nauvis's (#226) must be written as each layer lands rather than
at the end.

**The resource overlay has its OWN five windows, and it has to.** Ore patches
are far sparser than rocks: three of the four windows the rest of that file uses
contain no ore at all, so a per-window count over them reads `[0, 0, 53, 0]` and
three quarters of the comparison is vacuous. The five were found by sweeping the
map for ore and then varying width, height, origin and tiles-per-pixel
independently across what was left. Only the fifth carries geysers, which is why
it is there - it is the one window that grades the ROLLED pass, and the one the
resource halo test runs on, since the three thresholded ores paint a single
pixel each and ignore the sweep box entirely.

**The composite's paint ORDER is asserted, not described.** Resources first,
then rocks, then cliffs - so a cliff or a rock crossing an ore patch reads as
the thing that is in the way. Reordering the three passes changes only the
pixels where two of them land, which is 208 of 16,384 in the window that grades
it (2 covered by a rock, 206 by a cliff) - invisible to a whole-image bound, and
frozen exactly.

**The cliff stack's tier 1 is the game's own cliff entities, four columns, both
rejection arms** - and every one of the 24 numbers was measured on the
TypeScript side too and agrees exactly, so they describe the distance BOTH ports
sit from the game:

| arm       | game |     ours | matched | orientation |
| --------- | ---: | -------: | ------: | ----------: |
| lava only | 1569 |     1570 |    1525 |        1492 |
| shipping  | 1569 | **1547** |    1525 |    **1504** |

`orientation` is four bits per cell against `LuaEntity.cliff_orientation` where
position is one, and it is what says the two ports produce the same cell CODES
rather than merely the same positions. The ore rejection removes 23 cells, none
of them a cliff the game kept, and takes wrong orientations **33 -> 21** - which
is exactly the figure `renderVulcanusCliffs.ts` records having measured, reached
through a separate implementation.

**`cliffiness_basic` is exact at all 12,675 captured corners**, with the clamp
saturating at 8,431 of them - read the count with its clamp, the way
`vulcanus_biomes`' three clamped biomes are read.

**The corner fixture's `elevation` column is the TILE channel, and grading
`cliff_elevation` against it is a category error worth 60.6 tiles.** That is
issue #83 - `multisample`'s offsets are in the consuming program's grid units,
so the 4-tile cliff lattice and the 1-tile tile lattice read different values.
Both ports score the same 419 of 12,675 against it, because both read the right
field and the fixture holds the other one. The test now grades the TILE-channel
field (786 of 12,675, worst 4.393e-2, identical on both sides) and asserts the
two grids DISAGREE at 2,519 corners - turning #83 from a comment into a live
assertion. The gap is **sparse and large** rather than a uniform offset, which
is why the wrong channel cost seven points of recall instead of being obvious.

**The cliff pass needed THREE poison hooks, not one.** `crosses_cliff` returns a
tri-state classification a numeric hook cannot reach (`poison::crossing_result`,
which ROTATES rather than negating - negating `0` is `0`, the answer most edges
give, so a sign flip would leave most of the lattice untouched). And
`fixImpossibleCells` has no value to bend at all, only a choice of which edge to
clear, so it gets `poison::sweep_order`. Both have their own test in
`POISONED_TESTS`, because under poison the crossing hook moves every edge in the
lattice and the end-to-end test would be red whether or not the sweep had a
control.

**ABI v2's Vulcanus block has grown twice with NO version bump - 248 -> 280 for
the cliff view, 280 -> 312 for the overlays** - and that is the per-planet split
working rather than a shortcut: the prefix declares its own block length,
`BadParamsLength` refuses a writer that disagrees, and Fulgora's request has not
moved a byte through either. A version bump is for a change to the COMMON
prefix, which every planet reads.

Both new fields are world boxes, and both are **sent rather than derived**,
because each needs the FULL image's geometry - which the prefix does not carry
and only the tiled renderer knows. They are two boxes rather than one because
their halos are different SHAPES: the cliff block spans `px - 2 ..= px + 1`, so
its halo is asymmetric and its two directions CROSS, while a placement mark is a
symmetric 3x3 centred on its pixel.
`test/fixtures/verify-wasm-request.py` grew five planted breaks for the first
box and six for the second, all RUN rather than listed. Every one of the eleven
is caught by the per-edge value check except the last: a halo one tile wider on
the low x side, with the request edited to agree, passes every value check and
is caught only by asserting the placement halo is symmetric about the pixel box.
The structural checks (four distinct edges, not inverted, no edge shared between
the boxes) caught none of them and constrain the FIXTURE, which the file says
rather than claiming credit.

**`vulcanus_stack` is TWO structs, and that is ownership rather than taste.**
`VulcanusBiomes`, `VulcanusElevation` and `VulcanusResources` all borrow the
layers beneath them, so one struct owning the whole graph would be
self-referential. `VulcanusBase` owns everything that owns its data; the biome
layer is a named local because two layers borrow it; `VulcanusStack` holds the
rest. Three lines of construction instead of one, and honest about it.

**Every one of the 20 frozen counts this phase added agrees with the
TypeScript**, measured on both sides against the same fixtures with the same
1/256 capture-grid snap - the same count AND the same worst residual to every
printed digit. The four starting spots are the load-bearing agreement: 1082,
974, 969 and 1049 of 1085 are the only counts `test/vulcanusResources.spec.ts`
freezes rather than bounds, and the port reproduced all four without having seen
them. Tile placement is 374 of 381 at the forced surface seed and 368 at a real
save's, both matching the TypeScript, with the raw map seed scoring 37 as the
control.

Tier 1 grades **24 named fields** across six fixtures. Every count was measured
again on the TypeScript side against the same fixture and all 24 agree, so they
are the distance BOTH ports sit from the game rather than a gap between them.

**Four things this phase measured that are worth more than the counts:**

- **A second, independent fixture pointed at #269, and #269 has since landed.**
  `hairline_cracks` is the shallowest expression in its layer - a bare `plasma`,
  nothing composed on top - so its weakness could not come from the crack file.
  `plasma` subtracts two `basis_noise_expr` results, and that adapter returned
  the un-narrowed f64 product. Fixed in `df3e39e`, and this branch re-scored
  against it:

  | field                | before  | after       | exposed?                      |
  | -------------------- | ------- | ----------- | ----------------------------- |
  | `hairlineCracks`     | 3/61    | **2/61**    | directly, at output scale 0.6 |
  | `floodCracksA`       | 15/61   | 15/61       | no                            |
  | `floodCracksB`       | 40/61   | 40/61       | no                            |
  | `floodPaths`         | 10/61   | 10/61       | no                            |
  | `floodBasaltsFunc`   | 8/61    | **9/61**    | via `hairline_cracks`         |
  | `mountainPlasma`     | 7/38    | **11/38**   | directly, at 125 and 625      |
  | `elev` / `elevation` | 113/434 | **115/434** | directly, at 250 and 150      |

  **Two corrections came out of that, and both are worth more than the counts.**

  First, **exposure is transitive.** `fixtures.rs` predicted the four flood
  fields would not move, on the grounds that eleven of the layer's twelve DIRECT
  `basis_noise_expr` calls sit at power-of-two output scales. Three held.
  `floodBasaltsFunc` did not, because it READS `hairline_cracks` -
  `+ 0.3 * min(0.5, hairline_cracks)`, right there in the layer's own verbatim
  transcription. The three that held are exactly the three that never touch it.
  Count composition, not call sites.

  Second, **`hairlineCracks` went DOWN, 3 to 2.** That is not evidence against
  the fix: the primitive is graded 196/196 against the game at five output
  scales. It is the both-directions movement #273 measured. These chains carry
  other unported narrowings, so correcting one term shifts values slightly and a
  position that happened to land exactly right can stop doing so. A count
  falling by one at 61 positions says the field is still wrong for reasons this
  change does not address.

- **A clamp flatters a count, and here it is measurable.** The three clamped
  biomes score 403, 402 and 408 of 434 against their own unclamped sources at
  128, 107 and 127 - the same quantity, times 2, clamped. Nothing improved
  between them: the clamp saturates at 0 or 1 over most of the map and a
  saturated position is exact for free. Read `*_biome_full` as the port's score
  and `*_biome` as what the consumer needs. Same effect in `starting_area`
  (371 of 410) against the unclamped `ashlands_start` (61) feeding it.
- **The oracle cannot see elevation's `-500` clamp**, and that was checked
  rather than assumed. `vulcanus_elevation` is `max(-500, elev)` and the
  captured `elev` bottoms out at **-58.77**, so the two columns are the same
  field at all 434 positions - 0 of 434 differ - and a port that dropped the
  `max` would score 115 either way. Both are graded anyway; the clamp's real
  test lives in the module, constructing the case the fixture does not.
- **A discrete output scores like one.** `mountain_volcano_spots` at 359 of 434
  is the highest UNCLAMPED count in the Vulcanus port, because it is dominated
  by which single candidate survives per region - a choice a sub-ULP error
  almost never changes. The same property `voronoi_cell_id` has.

**`detailNoise` is the reading to carry out of this phase.** It has the
SMALLEST residual of its three helper fields (7.778e-5) and the FEWEST exact
matches (**1 of 38**), where `mountainPlasma` has 2.815e-3 and 11 of 38. A field
can be uniformly close and almost never right, which is the argument for
counting matches rather than bounding error, stated in one number.

Read elevation's worst residual of 1.332e-1 against its scale before reacting:
the field spans -58 to +1024, so that is ~1.3e-4 relative, the same order as
every layer above it. An absolute bound would need re-tuning per field for
scale alone - a third reason not to use one.

**`vulcanus_biomes` keeps a REAL cache, and it is the only layer that does.**
Every other ported layer evaluates top to bottom into locals, because every read
is at the same `(x, y)`. `raw_spots` is not: it reads selected spots from up to
four neighbouring regions, which is genuine cross-position state. The region
cache is a `RefCell<BTreeMap>` so `eval` can stay `&self` while the density and
favorability closures handed to `select_spots` borrow it. `BTreeMap` rather than
`HashMap` deliberately - nothing iterates it today, but a determinism-critical
port should not carry a container whose iteration order is unspecified.

`volcano_area` is evaluated at every spot candidate and pulls the whole
pre-volcano chain at that candidate; the TypeScript memoizes those and the port
recomputes them. **Nothing on the render path reaches this layer yet**, so it is
correct-first on purpose. If it ever joins a per-pixel render that is the first
measurement to take - `multioctave_noise`'s own docs record what happened last
time a per-call rebuild went unmeasured, which was 20x.

**The mountains pre-volcano split is load-bearing.** `mountain_volcano_spots`
depends on the mountains biome and the mountains biome folds the volcano field
back in; the Lua breaks that with a PRE-volcano stage that `volcano_area` reads.
Collapsing the two is an infinite recursion, which announces itself - reading
`volcano_area` off the POST-volcano raw does not.

**`cliff_elevation` is a separate entry point, not a convenience.**
`multisample`'s offsets are in the CONSUMING program's grid units, so the cliff
generator's 4-tile lattice moves the field 16 tiles for a `dx` of 4 (#83). The
tile and terrain channels pass 1; cliffs pass 4; both go through one code path
with the grid as a parameter.

**Tier 3 now covers both preview PNGs**, which is what #224's gate asks for.
`test/wasmFulgoraRenderParity.spec.ts` renders through the real boundary and
compares against the images Factorio itself produced:

| comparison                                              | result                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| WASM vs TypeScript, landmask AND terrain, four windows  | byte-identical                                                      |
| WASM vs `oracle-preview-fulgora-terrain.png`, 1024x1024 | **34,977** differing pixels (3.34%) - the TypeScript's exact number |
| WASM scrap footprint vs the scrap PNG                   | **1,825** game scrap pixels, **1** outside the footprint            |

The terrain figure is an EXACT count rather than a bound, because the two
renders are byte-identical: it must be that number, not merely under 4%.

The scrap comparison is a SUPERSET on the FOOTPRINT, never equality and never
against a rolled overlay. `map_grid` defaults to true, so the game draws solid
ore as a 2x2 checkerboard at about 0.5 pixels per entity, and a roll paints only
where a draw succeeds - about 40% of the nonzero positions. Diffing rolled
pixels would measure the salt rather than the model.

**And the seed trap has its own test.** The PNGs come from
`--generate-map-preview --map-gen-seed`, a MAP seed, while every `oracle-*.json`
comes from `sampleExpression`, which forces the SURFACE seed. Rendering with the
map seed makes the same comparison collapse from 3% differing to over 40%, and
that is asserted rather than described.

**`multioctave_noise(x, y, &params)` REBUILDS its seed tables on every call, and
that cost 20x before it was measured.** `tables_from_seed` runs a PRNG over
three 256-byte permutation tables, and `octave_terms` re-derives the octave
list; Fulgora's chain makes eight such calls per pixel. Hoisting them into a
`Prepared` built once per render - which is exactly what the TypeScript's
`makeMultioctaveNoise` closure has always done - moved a 256x256 landmask render
from **975.8ms to 50.7ms** in the same harness, a **19.2x** within-arm
improvement. Nothing in tiers 1-3 could see it, because the results are
identical either way; only a benchmark can. The wrapper carries the warning in
its own docs.

**The engine is ~2.46x faster than the TypeScript IN THE BROWSER, and the
"22.71x" #275 published is wrong.** That number came from a benchmark running
inside vitest, where the TYPESCRIPT arm is taxed and the WASM arm is not:

| harness             | TypeScript |        WASM |     ratio |
| ------------------- | ---------: | ----------: | --------: |
| Chrome, dev server  | **246 ms** | **99.7 ms** | **2.46x** |
| Node, inside vitest |    1134 ms |     50.7 ms |     22.4x |

The same TypeScript is **246 ms in the browser and ~1130 ms under vitest**, and
its warm-up trace is flat from the first pass, so that is not a cold JIT - it is
issue **#267**, vitest's per-module transform, which #267 measured at 3.7x on a
different file. **A ratio measured under vitest is not an engine comparison**,
because only one of its two arms pays that tax. Note the WASM arm differs the
other way (50.7 ms in Node against 99.7 ms in Chrome), so neither engine is
uniformly faster - which is the second reason to quote the browser.

Browser method, on the geometry the island finder uses: warmed 12 passes per
arm, interleaved, min of 11, three separate page loads giving **2.46 / 2.47 /
2.46**, plus **2.41x** at 1024x1024 @ 2 tiles/px (3786 ms against 1574 ms).
Byte-identity was re-checked in the browser in the same run.

Read 2.46x beside the spike's 7.5-13.2x rather than instead of it: the spike
measured the leaf kernel and one composition, this is a whole composed render.

**The lesson generalises past this number.** Any A/B where the two arms go
through different amounts of the test harness is measuring the harness. Benchmark
the arms in the environment that ships, or at least confirm the harness treats
them alike.

**No memo in the Rust chain, and that is not a shortcut.** The TypeScript wraps
every field in `memoXY` because it builds a DAG of lazy closures; the Rust
evaluates the chain top to bottom in one pass and keeps intermediates in locals.
That is what the memo achieves, bit-identically (a hit returns the value the
function computed), with no cache and no `&mut` plumbing. It is legitimate only
because every read in that chain is at the SAME `(x, y)` - checked field by
field. A field that read a neighbour would need the cache back.

**`starting_spot_at_angle` takes its trig as an INPUT**, and phase 3 is where
that stopped being optional. It is plain f64 arithmetic with no narrowing, so a
one-ULP `sin` difference lands straight in the result - and #270 measured that
the wasm libm and V8 really do disagree. At **all 13 call sites** the angle and
distance are per-render constants (read, not assumed), so the sine and cosine
are computed once outside the per-pixel path and handed in. Tier 2 passes V8's
values to the module, which makes a libm disagreement impossible rather than
unlikely.

`checksum` holds the tier-2 parity fold; **`fold_f64` folds RAW BITS and must
stay order-sensitive**, because an XOR fold is blind to order and cancels pairs,
so swapping two points or breaking two identically would leave it unchanged.
`the_fold_is_order_sensitive` makes that load-bearing rather than a claim in a
comment, and it was watched failing against a planted XOR fold.

**The wasm libm is NOT the host libm, and only a tier-2 spec can see the
difference** (#270, measured 2026-08-19, **now FIXED**). Sweeping 600 slider
positions, `sliderToLinear` and the per-operation `sliderRescale` agree between
the ports 600/600, and the un-narrowed `eval/sliderRescale.ts` form agreed
**599/600** - one position each at `s = 3.5435` (n=2) and `s = 6.3657` (n=3).
Native Rust agrees with V8 at both points, same 64 bits, so the divergence
belonged to the `log2`/`pow` that `wasm32-unknown-unknown` compiles in. Two
consequences: `cargo test` runs on the host libm and cannot find this class of
bug at all, and the per-operation f32 forms survive **because** they narrow -
one f64 ULP is ~29 bits below what an f32 narrowing keeps. Anything new that
reaches a transcendental needs a tier-2 sweep, not just a fixture.

**It was closed by DELETING the un-narrowed form, not by keeping it out of the
module**, and the reason is that the libm question was the second-worst thing
about it. `slider_rescale` is a **noise-function** in
`core/prototypes/noise-functions.lua:16` - the noise machine evaluates it, per
operation, in f32 - so the oracle already said which form is the game's: the
per-operation one matches all 7 probe points in
`oracle-fulgora-elevation.seed123456.json` and the rounded-once one misses
`s = 0.5` and `s = 5`. It was the form that disagreed with the game, on five
shipped call sites.

`src/noise/eval/sliderRescale.ts` is gone. All five callers -
`vulcanusResources.ts` (x4 at n=2), `vulcanusHelpers.ts` and `vulcanusBiomes.ts`
(x3 at n=3), and **`rocks/rockField.ts`** at n=1.5, which the issue did not list

- read `eval/math.ts` now, and `rockCatalog.ts` re-exports rather than
  re-implements. Three things worth knowing before touching this again:

- **No fixture could see the change, and that is measured rather than lucky.**
  Every fixture and spec feeds these call sites only `size` 0 or 1, and the two
  forms are BIT-IDENTICAL at both. The full gate went 2057 -> 2061 tests passed,
  the +4 being the rewritten `test/sliderRescale.spec.ts` and nothing else.
- **The input space is 12 values, not a range.** `PERCENT_STEPS` is `Math.fround`
  of twelve exact fractions and those are the only settings a user can pick.
  Across them the two forms return a different f64 at **10 of 12** for every `n`,
  and a different f32 at 3 of 12 (n=2), 4 of 12 (n=3), and **0 of 12** (n=1.5).
  So the Nauvis rock change is invisible at f32 granularity at every reachable
  setting; it was taken to remove the second implementation, not to move a pixel.
- **`engine.wasm` is byte-identical across the change** (`cd1a79c1...`, 84,177
  bytes). `slider_rescale_f64` was never exported, so it had already been
  dead-code-eliminated. It survives as `slider_rescale_rounded_once` under
  `#[cfg(test)]`, purely as the control that keeps "the shipped form matches the
  oracle" from being an assertion against nothing.

**THREE TypeScript findings came out of the port and none was fixed IN the
port.** All were behaviour changes to shipped fields that passed their own
fixtures, so each got an issue instead. The port reproduces the TypeScript
exactly in every case - a unilateral "fix" on the Rust side would read as a port
bug in tier 2, which is the whole point of having tier 2. **All three have since
landed as their own changes**, which is the intended path, not an exception:

- **#269 - LANDED.** `basisNoiseExpr` returned an un-narrowed f64 product where
  the game evaluates `f32(f32(output_scale) * basis)`, and none of its five
  callers narrowed either. Settled against the game at 196 positions and five
  output scales (the fixture is #287's): the shipped form scored
  `[196, 28, 6, 96, 1]` and the game's form scores **196 of 196 at every scale**.
  **Narrowing the product is necessary and NOT sufficient** - the `output_scale`
  CONSTANT is held at f32 as well, the same shape as #273, and that is the half
  the issue itself does not say.

  Re-scored on every field that reads it, because a green gate proves nothing
  here (see below): `mountain_plasma` **7 -> 11 of 38**, Vulcanus `elev` and
  `elevation` **114 -> 116 of 434**, and `elevation_lakes` (13/17),
  `elevation_nauvis` (3/17) and both `cliffiness` gates (1024/1024) unmoved.
  Nothing regressed - unlike #273, which moved counts in both directions.

  **A power-of-two `output_scale` is immune** and cannot grade any of this:
  multiplying an f32 by one is a pure exponent shift. Which sites the fix can
  reach is decided by the output scale alone - `cliff_fields` (0.51),
  `nauvis_shared` (0.6), `elevation_lakes` (1.5), `vulcanus_elevation`
  (250, 150) and the `plasma` magnitudes routed into it (125/625, 0.15/0.75)
  are all exposed, while the eleven `plasma` sites the crack layer calls at
  1, 0.5 and 0.25 are blind by construction and did not move.

- **#290 and #293 - BOTH LANDED, together.** The output scale was only a third
  of it. Two more terms were wrong, and neither could be graded without the
  other, so they landed as one change.

  **#290 - the input side.** The game holds `input_scale` at f32 **and**
  narrows the coordinate product:
  `basis_noise(f32(x * f32(input_scale)), ...)`. Graded 196 of 196 at seven
  scales (`test/basisInputScale.spec.ts`) and again at the five real caller
  `(input_scale, output_scale)` pairs (`test/basisCallerScales.spec.ts`), then
  confirmed against the game's OWN leaves at 61 of 61 with **worst residual
  exactly 0**, near field and far.

  **#293 - the scale arguments.** `vulcanus_cracks_scale` is a
  **noise-EXPRESSION, not a Lua number**, so `0.3 * vulcanus_cracks_scale` is an
  f32 multiply inside the noise machine. So is `1 / 50 / scale` inside
  `vulcanus_plasma` and `vulcanus_detail_noise`, and
  `vulcanus_scale_multiplier / scale` inside `vulcanus_biome_noise`. The port
  computed all of them in f64 and narrowed once, which is a different number.

  **Every count improved and not one regressed:**

  | field                | before  | after       |
  | -------------------- | ------- | ----------- |
  | `detailNoise`        | 1/38    | **38/38**   |
  | `mountainPlasma`     | 11/38   | **38/38**   |
  | `hairlineCracks`     | 2/61    | **50/61**   |
  | `floodCracksA`       | 15/61   | **45/61**   |
  | `floodCracksB`       | 40/61   | **43/61**   |
  | `floodPaths`         | 10/61   | **28/61**   |
  | `floodBasaltsFunc`   | 9/61    | **31/61**   |
  | `aux`                | 40/61   | **41/61**   |
  | `moisture`           | 20/61   | **29/61**   |
  | `elev` / `elevation` | 115/434 | **169/434** |
  | `temperature`        | 196/434 | **244/434** |

  **Every number in that "after" column has since been superseded, because all
  of them were scored at UNSNAPPED coordinates.** The table is kept as the
  record of what #290/#293 moved; do not read it as current. See the snap
  section below for the live counts - `hairlineCracks` is 61 of 61.

  `detailNoise` is the one to notice. This file used to hold it up as the
  argument for counting matches rather than bounding error - smallest residual
  of its three helper fields, fewest exact matches, 1 of 38. It is now 38 of 38.
  The bound never moved; the port did.

- **Three tier-1 sweeps scored at coordinates the game never evaluated, and
  fixing it moved 13 frozen counts UP (#295).** `vulcanus_sweep` and the biome
  test read `p.x` raw, where `oracle-vulcanus-cracks` and
  `oracle-vulcanus-climate` record **21 of 61** positions off the 1/256
  `MapPosition` grid and `oracle-vulcanus-biomes` records 22 of 434. The other
  seven tests over off-grid fixtures already snapped - the practice was
  established and these three were simply missed.

  | field                   | raw     | snapped     |
  | ----------------------- | ------- | ----------- |
  | `hairlineCracks`        | 50/61   | **61/61**   |
  | `floodCracksA`          | 45/61   | **55/61**   |
  | `floodCracksB`          | 43/61   | **51/61**   |
  | `floodPaths`            | 28/61   | **34/61**   |
  | `floodBasaltsFunc`      | 31/61   | **37/61**   |
  | `aux`                   | 41/61   | **51/61**   |
  | `moisture`              | 29/61   | **35/61**   |
  | `mountains_raw_volcano` | 163/434 | **174/434** |
  | `mountains_biome_full`  | 128/434 | **135/434** |
  | `ashlands_biome_full`   | 107/434 | **114/434** |
  | `basalts_biome_full`    | 127/434 | **134/434** |
  | `mountains_biome`       | 403/434 | **404/434** |
  | `ashlands_biome`        | 402/434 | **404/434** |

  Two counts did NOT move, and both are readings rather than noise:
  `mountain_volcano_spots` stays 359 because its output is a DISCRETE choice of
  which candidate survives, and a sub-1/256 coordinate shift almost never
  changes that - the same property `voronoi_cell_id` has. `basalts_biome` stays
  408 because it is clamped and saturated over most of the map.

  **This REFUTES what #295 read into `hairlineCracks`.** The issue took it
  scoring 50 against the 2.1.12 capture and 61 against a 2.1.14 one as the game
  changing under the fixture. Measured: the 2.1.12 fixture SNAPPED scores 61
  too, and the two fixtures do not even hold the same positions - the older one
  records 21 of them unsnapped.

  **And the residual version effect is ZERO, not the "at most 2 counts, both
  ways" this paragraph used to claim** (measured 2026-08-25, closing #295). That
  figure came from comparing each capture's score over its OWN 61 positions,
  which is the same mistake one level down: the two captures share only **52**
  of their 61 points, so the comparison was again across two sample sets.

  | field              | 2.1.12 /61 | 2.1.16 /61 | 2.1.12 /52 | 2.1.16 /52 |
  | ------------------ | ---------: | ---------: | ---------: | ---------: |
  | `hairlineCracks`   |         61 |         61 |     **52** |     **52** |
  | `floodCracksA`     |         55 |         54 |     **46** |     **46** |
  | `floodCracksB`     |         51 |         50 |     **45** |     **45** |
  | `floodPaths`       |         34 |         36 |     **28** |     **28** |
  | `floodBasaltsFunc` |         37 |         37 |     **31** |     **31** |

  Restricted to the shared points every field ties, so the whole difference
  lives in the 9 points the captures do not share. Three independent readings,
  any of which could have failed:

  - **Game against game, no port involved.** At all 52 shared points both
    captures record BIT-IDENTICAL values on all five fields, worst delta exactly
    0, with a control (a different field of the same fixture) agreeing 0 of 52.
  - **The data.** Every Lua file behind the chain - `planet-vulcanus-map-gen.lua`,
    `noise-programs.lua`, `noise-functions.lua`,
    `base/prototypes/noise-expressions.lua`, `tiles-vulcanus.lua` - is
    byte-identical 2.1.12 -> 2.1.16.
  - **The mechanism, exactly.** The re-capture's position equals
    `Math.floor(old_raw * 256) / 256` at **61 of 61** and
    `Math.trunc(...)` at **52** - the two disagree on exactly the 9.

  **So a re-capture of an off-grid fixture CANNOT land on the points that
  snapping the old one produces, and that is by design rather than a bug.** A
  capture PRODUCES a grid coordinate with `Math.floor` (`snapToMapPosition` in
  `test/oracle/capture.ts`); `test/captureGrid.ts` RECOVERS one with
  `Math.trunc`, because truncation toward zero is what the game does to a
  coordinate handed to it off the grid. Both are right for their own job, and
  `capture.ts` has said so in a comment the whole time. They differ by one cell
  on a NEGATIVE coordinate, which is why this never showed up near the origin.

  The consequence is the transferable part: **comparing two captures' COUNTS is
  never a version measurement unless you first restrict to the points they
  share.** Compare values at shared positions instead, which needs no port and
  cannot be confounded this way. That comparison is kept as an assertion over
  two committed fixtures, in `test/vulcanusPlasmaDecomposition.spec.ts`.

  **A version difference and a capture-grid difference look identical from
  inside a count, so rule out the grid FIRST** - it is free, where re-capturing
  to test a version hypothesis will confirm that hypothesis whether or not it is
  true. Following #295's own suggested handling here would have produced a
  confident wrong answer.

  And **2.1.14, 2.1.15 and 2.1.16 are ONE oracle** for map-gen: the data Lua is
  byte-identical across them, and a re-capture at 2.1.16 matched 2.1.14 on all
  305 sampled values. So `refs:sync --fixtures` reporting "115 of 118 predate
  the installed binary" overstates staleness by three versions; the real cut is
  95 of 118 older than 2.1.14.

  `the_capture_grid_snap_is_load_bearing_on_the_vulcanus_crack_layer` pins BOTH
  arms, not just the good one - a test asserting only the snapped number would
  pass again if the snap were removed and the counts re-frozen to match, which
  is exactly how this shipped the first time. **There are now THREE of these**;
  `..._on_the_vulcanus_biome_layer` was added 2026-08-25 because the biome half
  of that change landed with neither a dual-arm test nor an off-grid count, so
  its six counts could have been quietly re-frozen downward. It pins all eight
  fields, including the two that DO NOT move - `mountain_volcano_spots` at 359
  and `basalts_biome` at 408 - since pinning those flat is what says the
  discrete-choice and saturated-clamp readings are still true.

  **`test/fixtures/PROVENANCE.json` now carries `maxUnknown: 0`.** The last
  undocumented fixture was `autoplace-can-be-disabled.dump.json`, committed
  2026-07-12 with no version recorded; `scripts/probes/autoplace-can-be-disabled`
  re-captured it at 2.1.16 and it came back **byte-identical**, 1696 bytes.
  Keep that probe rather than treating it as scaffolding - it is the only thing
  that makes the claim repeatable, and `docs/fixture-version-audit.md`'s rule is
  that a clean data diff can never promote an `unknown` entry. Because the count
  must EQUAL the ratchet, 0 is now a floor: a new fixture with no provenance
  fails immediately instead of taking up slack.

- **The technique that solved #293 is worth more than the fix: capture the
  INTERMEDIATES, at the SAME positions.** `basisCallerScales` graded the two
  leaves at 196 positions on a +/-400 grid and got 196 of 196.
  `oracle-vulcanus-cracks` graded the composed field at 61 different positions
  and got 2 of 61. Nothing had measured one position end to end, so "leaves
  right, composition wrong" was an inference across disjoint sample sets.

  Capturing `vulcanus_hairline_cracks` AND both of its leaves together settled
  it in two steps:

  1. **Game against game, with the port removed entirely.**
     `abs(gameLeafA - gameLeafB)` reproduces the game's own `hairline_cracks` at
     only **7 of 61**, worst 5.272e-4. The expression was wrong, and no line of
     our code was involved in showing it.
  2. **Our leaf model against the game's own leaves: 61 of 61, worst exactly 0.**

  Leaves provably exact plus composed field provably wrong localises the fault
  to the ARGUMENTS - which is what sent us to the game's Lua. The oracle harness
  samples named noise expressions by name, so any intermediate the game names
  can be captured this way. `test/vulcanusPlasmaDecomposition.spec.ts` keeps
  both steps as assertions.

  That 5.272e-4 was also the number that breached `vulcanusCracks.spec.ts`'s
  3e-4 bound when #290 was first tried ALONE. Fixing the leaves converged the
  port onto `abs(gameA - gameB)` - the wrong target - which is what made the
  argument error visible at all. A partial fix exposing a deeper one is a
  finding, not a regression.

- **The game's own Lua is on the capture machine**, under
  `<install>/data/space-age/prototypes/planet/`. Read it before inferring a
  formula from residuals. #293 was three hours of numerical archaeology that one
  `grep` of `planet-vulcanus-map-gen.lua` would have shortened, because the
  answer - `vulcanus_cracks_scale` being a noise-expression - is visible in the
  prototype's own `type` field.

- **#270 - FIXED.** The wasm libm question above. Closed by deleting the
  un-narrowed `slider_rescale` and moving all five callers onto the
  per-operation form the oracle says the game uses.
- **#273 - LANDED** (`e723b30`). Fulgora's elevation constants were f64 where
  the game holds them at f32. Typing them took `fulgora_dunes` from **26/101 to
  101/101 with worst error exactly 0** and `fulgora_rock` from 84/101 to
  101/101. The control was `fulgora_scrap_medium`: same op family, no added
  constant, already 101/101 - so the whole gap was the literal.
  `crates/fmw-noise/src/fixtures.rs` carries the planted fix as a live test
  rather than leaving it in the issue, because a measurement nobody runs goes
  stale.

The shape to copy: find it while porting, reproduce it faithfully so tier 2 stays
honest, open an issue, and fix it in a change graded on its own.

**A green `pnpm run verify` cannot see a change of this class - measured, not
assumed (#256).** When #269's fix landed, the full TypeScript suite passed with
**zero failures** even though the model under seven call sites had changed,
because the oracle specs that cover those callers assert combined abs/rel bounds
rather than exact f32 matches. The bounds are wide enough to swallow the whole
difference. The only spec that noticed was `test/basisOutputScale.spec.ts`,
which freezes exact counts on purpose. So when you change an op that shipped
fields read, **re-score those fields exactly before and after** - the gate going
green is not evidence, and #162 is the standing record of a tolerance hiding a
real bug for a year.

**`f64::max` is NOT `Math.max`, and only a raw-bits fold can see the
difference** (found 2026-08-19, #224). They differ two ways: on NaN, where
`f64::max` returns the non-NaN operand and `Math.max` propagates - and on
**signed zero**, where `Math.max(-0, +0)` is `+0` while `f64::max` follows IEEE
754-2019 `maximumNumber`, whose result for two operands that compare equal is
explicitly _either input, non-deterministically_.

That is not theoretical here. Fulgora's `tile_ruin_paving` folded to a different
tier-2 checksum than the TypeScript because both of its `max` arms were zero
with different signs. Phase 3 had shipped 27 such sites and its parity passed
only because those windows never hit the case.

Every `min`/`max` in a ported expression now goes through
`eval::math::{min2, max2}` - and the **argument order is kept as the TypeScript
writes it**, for the same reason. Reach for `f64::min`/`f64::max` in ported
arithmetic and the divergence is invisible to every tolerance and to tier 1; it
takes an order-sensitive fold over raw bits to find.

**The Fulgora tier-1 counts are frozen exact numbers, and 13 of them reached
101/101 when #273 landed.** Each was measured against the TypeScript side by side
and they agree exactly - same count, same worst residual - so they describe the
port's remaining distance from the game, which both implementations share.
Freezing them is what makes a change to any of them a finding. If one moves: read
the number, do not adjust it. Up is worth taking; down is a regression.

**#273 is the worked example of how to move them, and its method is the
transferable part.** Fulgora's chain held f64 literals where the game holds f32,
plus intermediates rounded once at the end rather than per operation. Three
things about how it was settled:

- **Accept only a field that reaches a FULL exact count.** Every candidate was
  applied to the real tree, scored against the oracle fixture, and reverted;
  one was taken only when its own field hit 101/101 at a residual of exactly 0.
  Twelve candidates that merely improved were **rejected and written up**, not
  committed - `fulgoran_dunes_probability` 75 -> 98 and `fulgora_mix_oil`
  48 -> 53 among them. "It got smaller" stays a hypothesis.
- **Measure cumulatively, because the chain is a DAG.** Scored one at a time
  against a fixed baseline, `natural` looks capped at 99/101 and the issue
  predicted exactly that. It reaches **101/101** once `wobble_mask` is fixed,
  because `natural` reads `basis` and `basis` was the second cause. A candidate
  sweep that does not re-baseline after each accept will under-report.
- **The same literal wants opposite fixes in different arities.** Typing the
  three constants in `sprawl_pyramids` REGRESSES it 99 -> 97; narrowing every
  operation takes it to 101/101. A one-term `a OP constant` recovers at the
  comparison's own rounding and a three-term sum does not.

**What #273 did NOT change is the tile argmax** - 4,915 of 5,057 before and
after, same 7 land/ocean and 11 shallow/deep misses, so those really are
boundary-exclusive. **And the whole-image terrain preview went 34,976 -> 34,977
differing pixels of 1,048,576 - one pixel WORSE.** That is the honest number and
it is worth stating plainly: this class of fix buys bit-exactness on named
fields, not visible accuracy, because the image is dominated by the `mix_*`
chain that #273 could not reach. A draft of this paragraph claimed a 25-pixel
improvement, measured on a tree carrying three candidates that were later
dropped for failing the accept rule. Re-measure on the tree you actually ship.

**The whole TypeScript suite stayed GREEN through all of it, and that is the
#162 pathology, not luck.** Every Fulgora assertion on that side is an upper
bound on the worst residual, so improving a residual keeps it under the bound;
89 of 89 Fulgora tests passed before and after. Only the Rust port's frozen
exact counts could see the change, and they named every field that moved.

**`starting_spot_at_angle` was the block, and #279 removed it.** It evaluated in
f64 and is SHARED with Vulcanus, so it could not ride along with a Fulgora-only
change. Narrowing it needs all five of per-operation narrowing, an f32 `pi`, f32
`sin`/`cos`, f32 radius/distance and an f32 angle - **no subset works**, and an
f32 `pi` on its own helps the vault cone and HURTS the main one until the angle
is narrowed too. The last two live at the CALL SITES (`grid / 1.8`,
`seed0 / 360`, `angle + 180`), not in the function.

What it bought, all re-measured on the shipped tree:

- **`starting_spot_at_angle` itself: 88 -> 152 of 152.** The direct oracle test,
  against values the game produced, is now exact at every captured case. That is
  the strongest statement in tier 1 about this expression, and it is what makes
  everything below a consequence rather than a coincidence. The comment on that
  assertion used to explain the 88 away as "the same known port gap the elevation
  chain carries" - it was not a gap in the chain, it was this expression.
- Both Fulgora cones **83/101 and 85/101 -> 101/101 at residual exactly 0**, and
  `fulgora_vault_pyramids` 85 -> 101 and `vault_pyramids_and_start` 77 -> 101
  behind them. **13 frozen counts up, 1 down** (`fulgoran_rock_probability`
  80 -> 79, recorded at the assertion the way #273 recorded its two).
- **The terrain PNG 34,977 -> 34,788 differing pixels of 1,048,576.** #273 moved
  this by one pixel in the wrong direction; this moves it by **189** the right
  way, because the cones feed the `mix_*` chain the image is made of. So "this
  class of fix buys bit-exactness, not a better picture" is not a rule - it
  depends on whether the field is upstream of what the image is made of.
- The scrap footprint's one stray game pixel is gone: `outside` 1 -> **0**.

**On Vulcanus it is a large improvement that a BOUND reported as a regression**,
which is #162 with the sign flipped. Exact f32 matches out of 1085:
`startingTungsten` 614 -> 1082, `startingCoal` 611 -> 974, `startingCalcite`
547 -> 969, `startingSulfur` 618 -> 1049. The only thing that got worse was
calcite's single worst residual, 2.2888e-5 -> 3.0518e-5, tripping a 3e-5 bound.
That outlier sits at `(-2332.9, 2333.7)` where the field's own value is
**-133.94**, so one f32 ULP there is 1.53e-5 and the bound is a TWO-ULP bound at
that magnitude; exactly 2 of 1085 positions exceed it. Those four assertions are
now **frozen exact counts** with the residual kept underneath - a replacement,
not a widening, and proven strictly stronger by planting: un-narrowing the
calcite radius drops the count 969 -> 669 while the residual bound passes
unchanged.

The Vulcanus call-site audit is done (5 resource sites, 3 spawn sites, the three
spawn angles). It took calcite 669 -> 969 and did not move those 2 deep-field
points, which is the far-from-origin f32 coordinate floor the other Vulcanus
specs document rather than anything in the expression.

**#270 did NOT clear this**, and a note here used to imply it might by blaming
the calcite radius on "the un-narrowed `sliderRescale` of #270". The radius is
`(35 / 1.5) * sliderRescale(calcite.size, 2)`, and at the default `size = 1`
**both** forms return exactly 1 - so the value reaching `startingCalcite` in
every fixture never changed. What was un-narrowed there is the `35 / 1.5` and the
multiply, which is #279's own lattice.

**The 12 candidates #279 lists are still unapplied**, and the issue's prediction
about them is NOT confirmed. It expected `moats`, `vaultSpots` and
`spotsPrebanding` to reach 101/101 once the cones moved; measured, they reach
69, 69 and 98. They improved, they did not close. Those candidates are their own
per-operation narrowings and still have to be applied and re-scored one at a
time, under the greedy-accept rule.

**Phase 6 (#226) is IN PROGRESS: the Nauvis EXPRESSION CORE is ported and
gated; the five overlays, the tiles and the render path are not.** Landed:
`nauvis_shared`, `elevation_lakes` (and `elevation_island`, which is that tree
with `bias = -1000` and the segmentation quartered), `elevation_nauvis` (and
`elevation_nauvis_no_cliff`), `nauvis_climate` holding `aux`, `moisture` and
`temperature`, plus `nauvis_stack`. Still unported: `resources/`, `enemies/`,
`trees/`, `rocks/rockField.ts`, `cliffs/cliffFields.ts` and `tiles/` - about
2,750 lines of TypeScript, more than the core was.

Tier 1 grades every captured Nauvis field, snapped onto the 1/256 capture grid
and scored by exact f32 match count. **Every count was measured on the
TypeScript side against the same fixture with the same snap and agrees to every
printed digit**, so they describe the distance BOTH ports sit from the game:

| field                                   | exact    | worst       |
| --------------------------------------- | -------- | ----------- |
| `temperature`                           | 26/26    | **0**       |
| `elevation_lakes`                       | 21/26    | 3.814697e-6 |
| `elevation_island`                      | 19/26    | 1.525879e-5 |
| `moisture`                              | 18/26    | 5.960464e-8 |
| `aux`                                   | 14/26    | 5.960464e-8 |
| `elevation_nauvis`                      | 8/26     | 3.852844e-4 |
| `elevation_nauvis_no_cliff` (two seeds) | 6, 4 /26 | 3.8e-4      |

plus the cliff offset chain at 38 positions and two seeds: `rawX` 30 and 36,
`rawY` 30 and 30, `hillsOffset` 29 and 31, `cliffRingbreak` 29 and 31.

**Read `temperature` beside the rest rather than as an outlier.** It is the
shallowest expression in the port - one `quick_multioctave_noise` and a clamp,
nothing composed beneath it - and it is bit-exact. `aux` and `moisture` are one
`nauvis_plateaus` away from it and land at one f32 ULP. `elevation_nauvis` is
the weakest count in the Nauvis port because it stacks the shared layer, an
amplitude-corrected persistence field and a variable-persistence detail stack,
so it carries every unported narrowing underneath it at once.

**Porting `amplitude_corrected_multioctave_noise` moved a SHIPPED op, and no
fixture in the tree could see the difference.**
`variable_persistence_multioctave_noise` took `persistence` as an **f32**;
the TypeScript multiplies its f32 accumulator by an un-narrowed JavaScript
number. `oracle-variable-persistence-multioctave`'s captured `persistenceField`
is the noise machine's own `0.35 + 0.25 * basis_noise{...}`, so all 38 values
are exactly f32 and both widths score 266/266 with worst 0 - the same shape as
#191 and #309, a narrowing the fixtures agree on because they only ever offer
values already on the grid.

`oracle-multioctave-wrappers`'s amplitude-corrected cases DO discriminate,
because they pass the program constant `0.7` straight in:

| persistence operand                | exact  | worst    |
| ---------------------------------- | ------ | -------- |
| f64 (the TypeScript, and now this) | 81/152 | 1.788e-7 |
| f32 (what shipped here)            | 89/152 | 5.960e-8 |

**The better-scoring form is NOT the one taken.** 89 is an improvement and not
a full exact count, so the greedy-accept rule rejects it as a model change, and
adopting it would put a divergence into every Nauvis elevation value with
nothing to grade it. It is a real finding for #254 - which records the 81/152
as unexplained - naming one term worth 8 points and still 63 short. Neither
form is the game's.

Two harness compensations went with it. `checksum_variable_persistence` crossed
the ABI as an f32, so `test/wasmMultioctaveParity.spec.ts` narrowed its own
value with `Math.fround` first, making the two sides agree by construction on
exactly the term that differed; both are f64 now and two of that spec's cases
(0.62, 0.9) are not f32-exact, so it grades the width instead of hiding it.
And `p ** octaves` is **`powf`, not `powi`** - `powi` disagrees with V8 by one
ULP at 0.7^4, 0.7^6 and 0.7^8, and one ULP there flips the f32 rounding of the
octave gain, which moves every point in the case.

**Tier 2 lands with the layers, not after them** (`test/wasmNauvisParity.spec.ts`

- `checksum_nauvis`, 16 fields x 3 cases). Two departures from the Vulcanus
  shape, both deliberate: the parameters cross as ARGUMENTS rather than as a
  request, because there is no render path yet whose wiring a request would put
  inside the comparison; and no trig crosses at all, because Nauvis reaches no
  transcendental - which is why its signature is narrower than Fulgora's despite
  carrying more controls.

**Its sweep deliberately leaves the f32 grid, and that is load-bearing rather
than decorative.** 1,430 of 1,452 sampled positions have at least one
coordinate off the grid, frozen, with two tier-3-shaped windows asserted at 0
as the control. Planting a pure coordinate narrowing in `hills_offset_raw_x`
leaves tier 1 GREEN and turns tier 2 RED - so it is not a second opinion on
what tier 1 covers, it is the only thing in the gate that can see that class of
change on Nauvis. Every tier-3 window uses a binary origin and step, which is
how #309 survived three shipped PRs.

**`aux.rs` cannot exist**, so the three climate expressions share
`nauvis_climate.rs`. `aux` is a reserved device name on Windows and a file by
that name cannot be checked out there at all. It is the one place the port does
not mirror `src/noise/expressions/` 1:1. `temperature_basic` is not
Nauvis-specific either - Nauvis is just the only planet in this port that
reaches it.

**Adding an UNREACHABLE module moved `engine.wasm` by 54 bytes, and it is not
the panic-location fingerprint.** No section kept its size and the delta was
not a line count; the sufficient explanation is inlining, since a new caller of
`var_pers_eval` and friends changes the cost heuristics for code that DOES
ship. Checked both ways: each source rebuilds to its own hash reproducibly, and
all 55 wasm parity tests including tier 3's byte-identical renders pass. That
is a third fingerprint to hold beside the two below.

**No expression layer in phase 6 carries its own poison hook, and that was
measured rather than skipped.** `nauvis_shared` has one on `cliff_ringbreak`;
deleting it leaves that layer's tier-1 test red anyway at 5 of 30 on `rawX`,
because every field in these chains composes `basis_noise` and inherits its
hook. No test in the crate could give one of them an independent control, so
the later layers do not add hooks just to look symmetrical. All nine phase-6
tier-1 tests are in `POISONED_TESTS` and all nine go red.
`the_cliff_elevation_term_moves_the_tree_...` stays GREEN and should - it is a
relational assertion, so a perturbation applies to both sides and cancels.

- **`src/noise/wasm/engine.wasm` is a COMMITTED artifact.**
  `scripts/build-wasm.sh` produces it; `verify:rust` rebuilds and compares bytes
  rather than regenerating. That is what keeps `vp build` free of any non-JS step
  and lets `deploy:app` run on a machine with no Rust at all. **Any change to a
  Rust source means rerunning that script and committing the result**, or the
  gate fails as "stale".
- **Byte identity across machines is measured, not hoped for** (#218): the same
  source, profile and pinned toolchain give the same bytes and the same sha256 on
  macOS/aarch64 and on an ubuntu x86_64 runner. That is why the gate can use
  `cmp` instead of rebuild-and-retest.
- **A `engine.wasm` diff can be pure LINE NUMBERS, and a DOC COMMENT is enough
  to cause one.** Seen twice while landing #225's cliff half: a 9-line struct
  added to `vulcanus_resources.rs` moved 2 bytes (two `core::panic::Location`
  line numbers for that file's `RefCell` borrow sites, 427 -> 436 and 469 ->
  478), and a **19-line `///` block on its own** in `cliffs/placement.rs` moved
  9 bytes - six Locations in that file, every one shifted by exactly 19. No code
  byte moved either time and every section kept its exact size. So a
  comment-only edit in a reachable file makes `verify-rust.sh` report "stale",
  and that is the gate working rather than a false positive.

  The fingerprint: tiny `cmp -l` count, every changed offset inside the `data`
  section, all section sizes identical, and a `u32` delta equal to the lines you
  inserted. **The trap is alignment** - the record is `{file_ptr, file_len,
line, col}` and it is NOT 4-byte aligned in the data image, so reading a `u32`
  at `offset - (offset % 4)` gave "delta 4864" and looked like a moved string
  table; realigned, the same field is 716 -> 735 and 4864 is just `19 << 8`.
  Locate the record from its file pointer and length, not from alignment. The
  build itself is deterministic - a no-change rebuild reproduces the bytes
  exactly, checked while chasing this - so a diff after an edit is always the
  edit.

- **The `poison` feature is the gate's anti-vacuity control, and it needs ONE
  HOOK PER OP.** It perturbs an op's returned value; `verify:rust` builds with it
  and asserts a **named list** of tier-1 tests goes red. The list is why: while
  every ported op composed `basis_noise`, its single hook reddened everything, so
  a suite-level "did anything fail" check looked sufficient. The five primitives
  added in #220's second batch compose it in none of their paths, and that check
  would have passed with five ports carrying no control at all. Adding an op
  means adding its hook and its test name to `POISONED_TESTS`. That list has
  already earned itself twice: it caught `voronoi_noise`'s `cell_random`
  shipping with no hook on the first run of the gate after the port landed, and
  phase 2 found that `fast_approx` had shipped in phase 1 with no tier-1 test
  and no hook at all. Two of the phase-2 tier-1 tests stay GREEN under poison
  and both should - one reads a fixture and no port code, and the other asserts
  that WRONG models of `^` disagree, which poisoning only strengthens.
  `poison.rs` records why, beside the two earlier ones.

  **A numeric hook does not reach a DISCRETE output**, which phase 3 measured
  rather than assumed: with only the elevation hook live, the end-to-end tile
  test stayed green at 7 and 11 misses out of 5,057, because a one-ULP nudge
  changes which side of a comparison a value falls on essentially never. That is
  the same property that makes `voronoi_cell_id` exact where `pyramid_noise` is
  not. `poison::bool_result` flips the classification instead. Any future op
  whose output is a choice rather than a number needs that hook, not `f64_result`.

- **The determinism rules are what protect that**, and each is written where it
  is enforced: no `mul_add` or fast-math, `clippy::suboptimal_flops` explicitly
  allowed so turning `nursery` on later cannot push the port toward FMA, no
  `target-cpu=native`, `simd128` off (measured at 1.27x on a gather-bound
  kernel - it would change the binary for no gain), and `relaxed_simd` never,
  since its fused multiply-add is non-deterministic across engines by design.
- **A WASM `u64` arrives in JavaScript as a SIGNED BigInt.** `fnv1a64("")` is
  `0xcbf29ce484222325` and JavaScript reads `-0x340d631b7bdddcdb`, its two's
  complement. No error is raised - the number is simply wrong in a way that
  looks like a broken checksum. Every u64 crossing needs
  `BigInt.asUintN(64, x)`; `test/wasmEngine.spec.ts` shows the shape.

### Preview service (`preview-service/`)

A separate pnpm workspace (`worker/` Cloudflare Worker + `container/`
digest-pinned Factorio headless image). Opt-in and the app's only outbound call;
the editor is fully functional offline without it.

**The base image `FROM` carries a TAG as well as a digest, and dropping the tag
is a real bug** (#182, fixed 2026-08-13). With a bare digest, Renovate's docker
manager defaults to `latest` - so it stops tracking the pinned version entirely
and starts offering "digest updates" that are version jumps. That happened: a
proposal reading `update factoriotools/factorio docker digest to fb7a13c` was
Factorio **2.1.14** against a pin that meant 2.1.12, and the only thing between
it and production was the `RUN factorio --version | grep -q` line inside the
image - which runs at **build** time, and nothing in CI builds the image (#183).

The pin is now `factoriotools/factorio:2.1.14@sha256:fb7a13c...`, so Renovate
tracks that tag and a version change can only arrive looking like one.
`preview-service/container/test/dockerfile.test.mjs` runs in `preview:test`
(needs no Docker) and asserts three things: the `FROM` has **both** a tag and a
digest, the tag agrees with the version assertion below it, and - when the
registry is reachable - the digest really is that tag's. The registry check
**skips** on a network error rather than failing, so it cannot redden an offline
machine; a reachable registry that disagrees is a genuine failure.

Two things it deliberately does not do: it does not build the image (that is
`pnpm --filter @fmw/preview-container run test:integration`, which needs Docker
and takes ~17s), and it cannot tell you the container and your local Factorio
have drifted apart. **`refs:sync` reports against the local Steam binary and
the container pins to a registry tag; either can move independently**, so check
which one actually changed before assuming the container is stale.

**The container's sizing is a measured cost decision, not a default** (#116).
Memory bills on **provisioned** size for the whole time an instance is awake, so
`instance_type` is the dominant cost lever - it was `standard-1` (4 GiB) while
production peaked at **603 MiB**, idled at ~205 MiB, and served ~7 requests/day.
It is now `basic` (1 GiB / 4 GB) with `max_instances: 1`. Two things to know
before changing it:

- **`sleepAfter` is load-bearing and fragile.** `@cloudflare/containers` only
  decrements its inflight-request counter when a proxied response body finishes
  piping. Dropping a response without reading it - which the 502 path used to do
  - leaves the counter above zero, `isActivityExpired()` returns false forever,
    and the instance never sleeps. Any new code path that discards a container
    response **must drain it first**; the guard is in
    `preview-service/worker/test/worker.spec.ts`.

  **That drain fix did not, on its own, stop the container being awake 24/7, and
  a note here used to imply it had.** Billing says the instance ran at 100% every
  full day from 2026-07-20 through 2026-08-03 - 95.6, 96.2, 98.2, 96.3, 96.0,
  96.8, 95.6, 97.0, 95.3, 96.1, 95.7, 96.3, 99.0 GiB-hours/day against the 96.0
  a 4 GiB instance bills for a whole day - including the five days _after_ the
  drain fix deployed on 2026-07-29. So the ~$28/month was still being paid; the
  2026-08-03 downsize to `basic` cut it ~4x rather than ending it. The sufficient
  explanation is the SIGTERM bug in the bullet below, which was present
  throughout. Keep the drain guard - the hazard is real - but do not credit it
  with the bill.

- **The container ignored SIGTERM, so it never stopped at all** (#120). Node runs
  as **PID 1** under the Dockerfile's exec-form `ENTRYPOINT`, and Linux gives PID
  1 no default signal dispositions. `@cloudflare/containers` stops an idle
  instance by sending SIGTERM and **never escalating to SIGKILL**, so with no
  handler the stop request was silently discarded and the instance only ever went
  away when a deploy replaced the placement. The handler and its regression test
  live in `preview-service/container/server.mjs` and `test/shutdown.test.mjs`.

- **To check what is actually running, read the billing metrics, not
  `wrangler containers instances`.** That command reported `state: running` with
  an 80-minute-old `created` timestamp during an hour when allocation was zero -
  it describes the placement, not whether you are paying. The
  `containersUsageAdaptiveGroups` GraphQL dataset is the truth, and the
  disk-to-memory ratio identifies the live instance type. Read it in **bytes**
  and the ratio is `1.86` = `standard-1` (4 GiB / 8 GB) and `3.73` = `basic`
  (1 GiB / 4 GB); the **2.0** and **4.0** this note used to quote are those same
  two numbers expressed in the mixed GiB/GB units the dashboard shows.

- **That dataset BACKFILLS, and a bucket that has not landed yet is
  indistinguishable from sleep.** This is not hypothetical: #120 read the
  5-minute buckets ~14 minutes after a test render, found nothing past 22:45Z,
  and published an "~8.5 minute" idle tail. Re-read once settled, that same
  window has **every** bucket present and the placement it woke stayed allocated
  for **29.3 hours straight - 352 of 352 buckets, no gaps** - on a total of
  **5** worker requests. The tail was never 8.5 minutes; there was no tail.
  Wait at least an hour before reading absence as sleep, and confirm with
  `placementId` continuity rather than bucket presence alone.

`wrangler` is not global - drive it through the workspace:
`pnpm --filter @fmw/preview-worker exec wrangler <cmd>`.

**`worker-configuration.d.ts` is generated and must stay in sync with
`wrangler.jsonc`.** It once drifted silently (the types declared the apex origin
while the config said the `map.` subdomain). Nothing caught that: it is not a
type error, so both `vp check` and the worker tests pass with a wrong value in
it. `wrangler types --check` now gates the worker's `test` and `deploy` scripts,
so `pnpm preview:test` fails loudly on drift.

- Regenerate with **`pnpm run types:sync`**, which is
  `wrangler types && vp check --fix` in one step. Use the script rather than the
  bare `wrangler types`: the formatter pass is **not optional** - wrangler emits
  tabs/unwrapped types and the repo formats to 2-space/wrapped, so a raw regen
  shows a whole-file whitespace diff that hides the real change. Measured on
  #169: raw regen = 25,411 lines changed, after the formatter = **1**. Bundling
  them is the whole point of #177; do not "simplify" the script back to one
  command.
- **`--check` compares two things, and the second one surprises people.** It
  checks the config against the hash in the generated file's header, AND the
  **`workerd` version** stamped on the line below it. Both halves were observed
  directly on 2026-08-03:
  - Editing the `containers` block of `wrangler.jsonc` (`instance_type`,
    `max_instances`) regenerated the file with the hash **identical** and
    `--check` passing - so that block is not in the hash at all, and a regen
    after such an edit is a pure whitespace diff.
  - A wrangler-only bump invalidates the file with the hash **unchanged**: PR
    #97's 4.115.0 -> 4.118.0 drags `workerd` 1.20260722.1 -> 1.20260730.1, every
    type body is byte-identical, and `verify` went red on that one line.

  So a wrangler bump that touches no binding still requires a regen. Reading
  this note in its old form ("compares the config against the hash") would rule
  that out, which is exactly the wrong call.

  It still does **not** notice hand-edits to the generated file itself. Don't
  hand-edit it.

- The worker deliberately has **no** `typescript` and **no**
  `@cloudflare/workers-types` devDependency, and ignores wrangler's
  "Install @types/node" advice. See the comment in
  `preview-service/worker/tsconfig.json` before adding any of them back.

## Conventions

- `docs/superpowers/specs/` and `docs/superpowers/plans/` are point-in-time
  design/plan records, **not** living docs - don't treat them as current state.

### Type-checking runs through `vp check`, not `tsc`

`vp check` runs format, lint, **and** type checks. The type-check step is gated
behind `lint.options.typeAware` + `lint.options.typeCheck` in `vite.config.ts` -
both are on. Do not add a `tsc`-based `typecheck` script:

- **`tsc` is not the type-check path**, but not because it crashes any more.
  It used to: bare `./node_modules/.bin/tsc --noEmit` threw `Debug Failure.
False expression: parameter should have errors when reporting errors` - a
  TypeScript 6.0.3 compiler bug, not a type error, triggered by
  `vite.config.ts` alone. **The `vue() as Plugin` cast below fixed that too**,
  and both now exit 0. Still don't add a `tsc`-based `typecheck` script: it
  duplicates what `vp check` already does through tsgolint, and it is one
  transitive-graph shift away from crashing again. Beware also that passing
  globs (`tsc --noEmit 'src/**/*.ts'`) silently ignores `tsconfig.json` and
  reports a misleading "ok".
- **`vp check` does not see inside `.vue` bodies** - it reports no type errors
  inside `<script setup lang="ts">` (measured, not assumed: a planted `TS2322`
  in `src/ui/FInfo.vue` left it printing "Found no warnings, lint errors, or
  type errors in 301 files"). That gap is now covered by `pnpm run check:vue`,
  chained into `verify` - see below. `vp check` alone is still a partial net.
- **`vite.config.ts` sits near TypeScript's comparison-depth limit.** A shift in
  the transitive dependency graph can tip it over, making `vp check` fail with
  `TS2321: Excessive stack depth comparing types ... and 'UserConfig'` - the
  same pathology behind the `tsc` crash, and nothing to do with the file being
  wrong. This is why dependency bumps use targeted `pnpm add` rather than
  `pnpm up`: `pnpm up` re-resolves ~22 surrounding packages and triggered
  exactly this, while installing the same target versions directly did not. If
  it reappears, suspect the transitive graph, not the named package. Two fixes,
  one that works and one that doesn't:
  - **Annotating the config with an explicit type does _not_ help** - the
    augmented `UserConfig` lives in `@voidzero-dev/vite-plus-core`, which is not
    resolvable, and vitest's exported `ViteUserConfig` lacks the
    `staged`/`lint`/`fmt` fields.
  - **Casting the plugin _does_ help** (found 2026-07-23 adopting vp 0.2.6,
    whose tsgolint-7 engine bump - not a transitive shift - re-triggered the
    TS2321). `@vitejs/plugin-vue`'s `vue()` return type references its own
    bundled Vite's `Plugin`; casting it to vite-plus's own `Plugin`
    (`plugins: [vue() as Plugin]`, `type Plugin` imported from `vite-plus`)
    collapses the comparison without suppressing type-checking of the rest of
    the config. See voidzero-dev/vite-plus#2010's comment thread.

    **That one cast is load-bearing for three tools, not one.** Removing it
    (measured 2026-07-29, by deleting it and re-running) reproduces all three
    failures at once: `vp check` fails `TS2321`, and `tsc` **and** `vue-tsc`
    both die on the `Debug Failure` assertion. So `TS2321` in `vp check` and
    the `Debug Failure` crash are one pathology with one fix - don't treat a
    reappearance of either as a separate problem.

- The project stays on `typescript` 6.0.3 as the _editor/LSP_ compiler, and
  **TypeScript 7 is not an upgrade this repo can take** - see below. Note the
  type-_check_ already effectively runs on TS7 semantics via tsgolint, so
  nothing is being given up by staying.

### TypeScript 7: `pnpm outdated`'s `6.0.3 -> 7.0.2` row is misleading

Taking that row literally breaks the toolchain, so it is worth knowing why
before someone bumps it. Re-derived 2026-07-29:

- **TS 7.0 exposes no programmatic API at all.** It is a CLI-only Go binary;
  the API is planned for 7.1. Anything that consumes the compiler
  programmatically - tsserver, `vue-tsc`, typescript-eslint - cannot run on it.
- The official migration is therefore a **dual install**, not a bump:
  `typescript` aliased to `npm:@typescript/typescript6` (the JS API line) plus
  `@typescript/native` aliased to `npm:typescript@^7` (the Go `tsc`).
- `vue-tsc` on a bare `typescript@7` does not degrade, it **hard-crashes**:
  `ERR_PACKAGE_PATH_NOT_EXPORTED: './lib/tsc'` (vuejs/language-tools#6124).
  `vue-tsc@3.3.8` added shim resolution so it works _behind the alias_ - which
  is the one thing 3.3.8 adds over 3.3.7, and it only matters if the alias is
  adopted.
- **And there is nothing to gain.** This repo's `typescript` devDep is purely
  the editor/LSP compiler; the type-check already runs TS7 semantics through
  tsgolint. The dual install would add a second compiler and an alias to buy
  nothing the repo consumes.

Revisit when 7.1 ships a programmatic API. Until then this is a "don't", not a
"blocked on someone else".

### The `.vue` gap is CLOSED - `vue-tsc` adopted 2026-07-29

`pnpm run check:vue` (`vue-tsc --noEmit`) runs in `verify`, between `vp check`
and `vp test`. It is the only thing that type-checks `<script setup lang="ts">`
bodies.

- **The guard is not vacuous, and was proven so before landing.** A planted
  `TS2322` in `src/ui/FInfo.vue` makes `vue-tsc` report
  `src/ui/FInfo.vue(3,7): error TS2322` and `pnpm run verify` exit **2** with
  the test suite never running - while `vp check` on the same tree still
  printed "Found no warnings, lint errors, or type errors in 301 files". If a
  future change makes `check:vue` pass on a planted error, it has been
  neutered.
- Against the real codebase: **22 `.vue` files, 0 errors, ~2.1s**. There was no
  latent breakage behind the gap; this is a guard against regressions, not a
  bug hunt. It ran on the existing `typescript` 6.0.3 - `vue-tsc`'s peer range
  is `>=5.0.0`, so no TS7 work was needed.
- **It needs no separate tsconfig**, and a note here previously said it did.
  That was measured 2026-07-22, one day _before_ the `vue() as Plugin` cast
  landed; the cast fixed `vue-tsc`'s crash along with `vp check`'s `TS2321`.
  Bare `vue-tsc --noEmit` on the root `tsconfig.json` is now clean.

**Why it was not adopted on 2026-07-22, and why that reason expired.** The only
blocker was supply-chain freshness: `vue-tsc@3.3.8` was under an hour old, and
installing it made pnpm silently write a bypass into `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - "@vue/language-core@3.3.8"
  - vue-tsc@3.3.8
```

**Watch for that block appearing in any diff - it means a freshness guard was
waived.** Don't commit one without a deliberate decision. It did not appear
this time: 3.3.8 was 7.3 days old when adopted, so the gate passed on its own
and `pnpm-workspace.yaml` was untouched. The old advice to "pick 3.3.7 instead"
is obsolete - just take the latest once it has aged past the policy.

### Remaining build/test log noise (investigated, left alone)

`pnpm preview:test` prints four lines like

```
Sourcemap for ".../@cloudflare/containers/dist/index.js" points to missing source files
```

This is an **upstream packaging bug**, not a local problem: `@cloudflare/containers`
(0.3.7, the latest) ships `dist/` with maps whose `sources` point at `../src/*.ts`,
but no `src/` is published and the maps carry no `sourcesContent`. Vite emits it
via an unconditional `logger.warnOnce`, so it is not reachable from
`build.rollupOptions.onLog` - that hook only sees the _build_, and this happens in
vite-node during tests. Two workarounds were tried and rejected:

- `test.server.deps.external` for the package - **does not help**, pool-workers
  bundles it regardless (measured; the warnings persist).
- A Vite `customLogger` - would mean adding `vite` as a worker devDependency
  (it is not resolvable there under pnpm isolation, and `vitest/config` does not
  re-export `createLogger`) purely to mute a cosmetic upstream warning. Not worth
  a dependency. Revisit if `@cloudflare/containers` fixes its packaging.

Exactly **one** deliberate suppression now lives in `vite.config.ts`:
`typescript/unbound-method` is off for `test/**/*.spec.ts`, because
`expect(mock.fn).toHaveBeenCalled()` passes an unbound reference by design.

There is **no** `build.rollupOptions.onLog` hook at all any more. It once held
two filters, both existing solely for `zlib-asm`:

- an `[EVAL]` filter, dropped when `patches/zlib-asm.patch` removed the three
  Emscripten `eval` sites; and
- an `fs`/`path` browser-externalization filter for zlib-asm's Node fallback
  imports, matched on the `rolldown:vite-resolve` plugin plus `/zlib-asm/` in
  the importer path.

Replacing `zlib-asm` with `pako` (plain ESM, no `eval`, no Node builtins) made
the second one dead too. Verified by removing it rather than assuming: the
build still prints nothing.

`pnpm vp build` prints no warnings at all, so anything that does appear is new
and worth reading. Do not add a suppression back - a direct `eval` or an
externalized builtin appearing anywhere in the bundle needs to surface.

## Vite+ toolchain reference (generated block)

The block below is **generated by Vite+** and delimited by a pair of HTML
comment markers (grep the file for `VITE PLUS` to see them). Leave those markers
and everything between them alone so the tool can resync the block; put any
local correction outside them, like this paragraph.

The markers are deliberately not reproduced literally in this prose - a
resync that matches on the marker text would otherwise find this sentence
first and rewrite the wrong region.

**Where this repo overrides it:** the checklist says `vp install` / `vp check` /
`vp test`. Use **`pnpm vp <cmd>`** instead - that is what `package.json` and CI
run, so it is the form that stays verified. A bare `vp` does work (see the
Commands section); `npx vp` does not. And prefer `pnpm install` over
`vp install`, because this repo's install discipline is specific: `pnpm add -w`
for root deps, always followed by a bare `pnpm install`, and a 24-hour
release-age guard that must not be bypassed.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
