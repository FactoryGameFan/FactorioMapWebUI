# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Factorio reference material - run `pnpm refs:sync` first

Two local references back every Factorio question in this repo, and both are
git-ignored, so a fresh clone has neither:

|                          |                                        |         |
| ------------------------ | -------------------------------------- | ------- |
| `factorioLuaAPI/`        | Lua API **docs**                       | ~286 MB |
| `~/GitHub/factorio-data` | game **data** Lua (the map-gen source) | ~17 MB  |

**`pnpm refs:sync` creates and pins both** to the version your installed
Factorio binary reports (~6 s from nothing, ~0.5 s when already in sync).
`pnpm refs:sync --check` reports drift without changing anything, and
`pnpm refs:sync 2.1.11` pins to an explicit version instead. If either
directory is missing or a grep turns up empty, run it before concluding
anything is absent.

Why pinned to the binary rather than latest: Steam updates the binary without
asking, so it is the one version you do not control. Fetching "latest" for the
references races that updater and leaves them describing a different game than
the one your fixtures were captured against - which is exactly how
`factorio-data` ended up sitting at 2.1.11 under a 2.1.12 binary.

### The API docs (`factorioLuaAPI/`)

**Before answering any Factorio API question or WebFetching
lua-api.factorio.com / wiki.factorio.com, grep this directory.** It is the
authoritative source for how the map generator, noise expressions, and map-gen
settings work. `pnpm refs:sync` populates it from the official archive at
`https://lua-api.factorio.com/<version>/static/archive.zip`, flattened so the
paths below resolve; `factorioLuaAPI/VERSION` records which version it holds.

Useful entry points:

- `factorioLuaAPI/auxiliary/noise-expressions.html` - named noise expressions and
  the `control:<name>:frequency|size|richness|bias` constants (e.g.
  `control:moisture:frequency`, `control:aux:bias`, `control:temperature:*` - the
  exact keys this app's `property_expression_names` codec round-trips).
- `factorioLuaAPI/types/MapGenSettings.html`, `types/FrequencySizeRichness.html`,
  `types/AutoplaceControlID.html` - map-gen settings structure and autoplace controls.
- `factorioLuaAPI/runtime-api.json` and `prototype-api.json` - machine-readable
  dumps; grep these for a signature/field faster than the HTML.

The JSON dumps are not a superset of the HTML - `control:temperature:frequency`
is in `noise-expressions.html` and nowhere in `runtime-api.json` - so grep the
whole directory, not just the JSON. Only fall back to WebFetch if something
genuinely is not in this mirror.

### Game _data_ (prototype Lua) for noise/autoplace RE - `~/GitHub/factorio-data`

`factorioLuaAPI/` above is the API _docs_. For the actual base-game map-gen
**source** (the noise expression trees, autoplace utils, resource prototypes)
that the client-side preview ports, read `~/GitHub/factorio-data` - a clone of
the official `wube/factorio-data` repo with per-version git tags. `pnpm
refs:sync` clones it if absent and checks out the tag matching the binary,
then verifies `base/info.json` actually reads that version (a checkout is not
proof; `master` may sit a few commits ahead of the newest tag).

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
grep -rlE 'name *= *"<expression>"' ~/GitHub/factorio-data/{core,base,space-age} --include="*.lua"
```

**Version skew here is a real, silent hazard, not a formality.**
`starting_patches` changed materially between **2.0.77 and 2.1.9** - radius
120 -> 150, `region_size` \*2 -> \*3, spacing 32 -> 48, the `random_penalty`
favorability term removed, a new 40-tile `origin_excluder`, and the lake mask
switched from a hardcoded `elevation_lakes` to the planet's own `elevation`.
Reading the wrong version's Lua produces a port that passes its own tests and
disagrees with the game. `pnpm refs:sync --check` before trusting a reading.

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
`refs:sync` at a different install.

### Automate with the Factorio headless CLI

A lot can be driven from the command line - see
https://wiki.factorio.com/Command_line_parameters (the game's own binary; this
is a wiki page, not in the `factorioLuaAPI/` mirror). Relevant here:

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

- `pnpm refs:sync` - pin `factorioLuaAPI/` + `~/GitHub/factorio-data` to the
  installed binary's version (`--check` reports drift only; `--fixtures` reports
  which oracle fixtures predate the binary). Deliberately **not** part of
  `verify`, which must pass on machines with no Factorio installed.
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

- **It is 19s**, of which `scripts/verify-rust.sh` is 2s, the pinned-toolchain
  sync is 10s and cargo-deny is 1s. It is the cheapest job in the workflow.
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
  known-good list (`2.1.9.3`, `2.1.12.2`, `2.1.14.1`), never a range - the
  schemas here are empirical, so accepting an unseen format would decode a
  changed layout into plausible wrong values. A version joins the list only with
  a fixture proving a real string of it round-trips byte-exact
  (`test/mapExchangeVersions.spec.ts`). This has now been a live bug **twice**:
  the app rejected every string from Factorio 2.1.12 until 2026-07-28, and every
  string from 2.1.14 until 2026-08-13. Both were found by a version audit rather
  than by a user, and both times the game had moved under a Steam auto-update.
  The UI advertises the target so the next drift is visible, and
  `test/factorioTarget.spec.ts` fails the build if `FACTORIO_TARGET_VERSION`
  disagrees with the newest fixture provenance - it is what forced the bump when
  the 2.1.14 fixture landed, so do not hand-maintain that constant.

- **The tail schema is VERSION-DEPENDENT as of 2.1.14, and that is new.** It was
  one constant for the format's whole history until `map-settings.lua` gained
  `enemy_expansion.build_base_unit_dispatch_cooldown` (`30 * 60` ticks) between
  2.1.12 and 2.1.14. It serializes in section order, so it lands after
  `max_expansion_cooldown` and **before `unit_group`** - it shifts every section
  after it rather than appending harmlessly at the end. `tailSchemaFor(version)`
  in `src/codec/mapExchangeString.ts` picks the layout, matched on the **exact**
  tag for the same reason `SUPPORTED_VERSIONS` is a list rather than a floor.

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
  broken** in either incident - 2.1.14 still accepts the `2.1.9.3` strings this
  app emits, so only import was affected both times.

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

### The Rust/WASM noise engine (`crates/`) - phases 1-3 expressions landed

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

Part 2 added the boundary: `crates/fmw-wasm/src/abi.rs` (a 104-byte fixed
request header, little-endian, with a magic word, a version word and a reserved
word that is asserted zero), `render.rs`, and `src/noise/wasm/{request,engine}.ts`.
**Tier 3 is byte-identical RGBA** against `renderFulgoraLandMask` across four
windows that vary width, height, origin, tiles-per-pixel and both sliders
independently. `test/fixtures/wasm-request.v1.json` pins the encoding; it is
declared under `notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes were checked by an independent Python decode rather
than by re-running the writer under test.

Errors return a **status code and do not trap**, because a trap would poison the
instance for every later request in that worker; a spec sends a bad magic and
then renders successfully through the same instance.

Still to do in #223: the cutover itself - `elevationRenderRequest` dispatching
`view: "landmask"` on Fulgora to the module, the worker plumbing that compiles
once on the main thread and instantiates per worker, `findIslands.spec.ts`
passing against it, and the in-browser measurement.

**`multioctave_noise(x, y, &params)` REBUILDS its seed tables on every call, and
that cost 20x before it was measured.** `tables_from_seed` runs a PRNG over
three 256-byte permutation tables, and `octave_terms` re-derives the octave
list; Fulgora's chain makes eight such calls per pixel. Hoisting them into a
`Prepared` built once per render - which is exactly what the TypeScript's
`makeMultioctaveNoise` closure has always done - moved a 256x256 landmask render
from **1152.2ms to 50.7ms**, so the port went from **1.15x to 22.71x** against
the TypeScript. Method: warmed, interleaved arms, min of 9, one process; a
single shot right after a build measures the machine (see the E-core note in
#215). Nothing in tiers 1-3 could see this, because the results are identical
either way - only a benchmark can. The wrapper now carries the warning in its
own docs.

Read 22.71x beside the spike's 7.5-13.2x rather than instead of it: the spike
measured the leaf kernel and one composition, this is a whole composed render
where the TypeScript also pays `memoXY` closure overhead per field per pixel.
And **it is a Node measurement, not a browser one** - the browser number the
issue asks for belongs with the cutover, since nothing in the app calls the
module yet.

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
difference** (#270, measured 2026-08-19). Sweeping 600 slider positions,
`sliderToLinear` and the per-operation `sliderRescale` agree between the ports
600/600, and the un-narrowed `eval/sliderRescale.ts` form agrees **599/600** -
one position each at `s = 3.5435` (n=2) and `s = 6.3657` (n=3). Native Rust
agrees with V8 at both points, same 64 bits, so the divergence belongs to the
`log2`/`pow` that `wasm32-unknown-unknown` compiles in. Two consequences:
`cargo test` runs on the host libm and cannot find this class of bug at all, and
the per-operation f32 forms survive **because** they narrow - one f64 ULP is ~29
bits below what an f32 narrowing keeps. The un-narrowed form is therefore not
exported from `fmw-wasm` at all. Anything new that reaches a transcendental
needs a tier-2 sweep, not just a fixture.

**THREE TypeScript findings came out of the port and none was fixed in it.**
All are behaviour changes to shipped fields that pass their own fixtures today,
so each got an issue instead. The port reproduces the TypeScript exactly in
every case - a unilateral "fix" on the Rust side would read as a port bug in
tier 2, which is the whole point of having tier 2.

- **#269** - `basisNoiseExpr` returns an un-narrowed f64 product where the game
  narrows to f32, and none of its five callers narrow either.
- **#270** - the wasm libm question above.
- **#273** - Fulgora's elevation constants are f64 where the game holds them at
  f32. Typing them takes `fulgora_dunes` from **26/101 to 101/101 with worst
  error exactly 0** and `fulgora_rock` from 84/101 to 101/101. The control is
  `fulgora_scrap_medium`: same op family, no added constant, already 101/101 -
  so the whole gap is the literal. `crates/fmw-noise/src/fixtures.rs` carries
  the planted fix as a live test rather than leaving it in the issue, because a
  measurement nobody runs goes stale.

**The Fulgora tier-1 counts are NOT 101/101 and that is deliberate.** Each was
measured against the TypeScript side by side and all 21 agree exactly - same
count, same worst residual - so they describe the port's known distance from the
game, which both implementations share. Freezing them is what makes a change to
any of them a finding. If one moves: read the number, do not adjust it. Up is
worth taking; down is a regression.

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
have drifted apart. **`refs:sync` pins to the local Steam binary and the
container pins to a registry tag; either can move independently**, so check
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
