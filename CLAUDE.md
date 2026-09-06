# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Factorio reference material and the oracle

Two references back every Factorio question here: the Lua API **docs** and the
game **data** Lua (the map-gen source). Neither is pinned into this repo, and
neither should be. `factorio-oracle refs` reads both at a version without
changing anything - it moves no git HEAD, which matters because the
`~/GitHub/factorio-data` clone is shared by four repos.

**The oracle repo documents itself, so do not restate it here.**
`~/GitHub/factorio-oracle` is the authority, and four repos share it:

Every path in this list is in **that** repo, not this one:

- `~/GitHub/factorio-oracle/README.md` - what it is, every `refs` subcommand,
  and how to write a probe.
- `~/GitHub/factorio-oracle/docs/order-of-attack.md` - factorio-data first, then
  the oracle, then the binary. The binary ships **unstripped**, so `nm` +
  `c++filt` resolve map-gen internals directly; `docs/noise/basis-noise-NOTES.md`
  here is a worked case.
- `~/GitHub/factorio-oracle/docs/method.md` - a control must be able to fail
  while the hypothesis holds; last man standing is not a measurement.
- `~/GitHub/factorio-oracle/docs/gotchas.md` - the facts that each cost a run,
  including the `oracle-dump.json` name contract and `error("DUMPED-OK")`
  exiting non-zero as success.

`docs/factorio-reference-and-oracle.md` in this repo holds the long form of the
sections below, including the full WSL capture recipe.

```bash
# ~/.cargo/bin is on no PATH here, so spell it out.
O=~/.cargo/bin/factorio-oracle
$O refs grep --tag 2.1.14 'vulcanus_cracks_scale'   # search the data Lua
$O refs grep --tag 2.0.77 --tag 2.1.14 'starting_patches'   # ask two at once
$O refs show 2.1.14 core/prototypes/noise-functions.lua
$O refs docs 2.1.14 auxiliary/noise-expressions.html
$O installs list                                     # JSON: version, docDir, dataDir
$O run --probe <probe.json> --work-dir /tmp/w        # then cat /tmp/w/write/script-output/oracle-dump.json
$O provenance check test/fixtures                    # same check as fixtureProvenance.spec.ts
cd ~/GitHub/factorio-oracle && cargo install --path . # after pulling the oracle
```

**The installed binary stays the authority on which version is meant**, and
Steam updates it without asking. Reading "latest" instead races that updater and
describes a different game than your fixtures were captured against. Set
`FACTORIO_BIN` to point at a different install. A second, non-Steam install sits
at `~/GitHub/factorio-oracle/installs/factorio-2.0.77.app`, deliberately outside
every discovery path, so name it explicitly with `--factorio`.

### What matters in the API docs FOR THIS APP

**Read these before answering any Factorio API question or WebFetching
lua-api.factorio.com.** `refs docs <version> <path>` prints one, using the
installed game before the network.

- `auxiliary/noise-expressions.html` - named noise expressions and the
  `control:<name>:frequency|size|richness|bias` constants (`control:moisture:frequency`,
  `control:aux:bias`, `control:temperature:*`). These are the exact keys this
  app's `property_expression_names` codec round-trips.
- `types/MapGenSettings.html`, `types/FrequencySizeRichness.html`,
  `types/AutoplaceControlID.html` - map-gen settings structure and autoplace
  controls.
- `runtime-api.json` and `prototype-api.json` - machine-readable dumps; grep
  these for a signature faster than the HTML.

**The JSON dumps are NOT a superset of the HTML.**
`control:temperature:frequency` is in `noise-expressions.html` and nowhere in
`runtime-api.json`, so search the whole tree:

```bash
grep -rn 'control:temperature' "$(dirname "$($O refs docs 2.1.14 runtime-api.json --which)")"
```

### Game _data_ (prototype Lua) for noise/autoplace RE

The base-game map-gen **source** that the client-side preview ports. Key files,
in rough order of how often they matter here:
`core/prototypes/noise-programs.lua` (most named expressions - elevation,
cliffs, climate, trees), `core/prototypes/noise-functions.lua`
(`resource_autoplace_all_patches`), `base/prototypes/noise-expressions.lua`
(enemy bases, rocks), `base/prototypes/tile/tiles.lua`,
`base/prototypes/entity/trees.lua`, and
`space-age/prototypes/planet/planet-vulcanus-map-gen.lua`.

**Grep for a definition, not a name** - a bare name grep returns every caller
too:

```bash
$O refs grep --tag 2.1.14 'name = "<expression>"'
```

**Version skew here is a real, silent hazard.** `starting_patches` changed
materially between **2.0.77 and 2.1.9** - radius 120 -> 150, `region_size` \*2
-> \*3, spacing 32 -> 48, the `random_penalty` favorability term removed, a new
40-tile `origin_excluder`, and the lake mask switched from a hardcoded
`elevation_lakes` to the planet's own `elevation`. Reading the wrong version's
Lua produces a port that passes its own tests and disagrees with the game.
**Ask both versions at once** rather than trusting a pin, which can only show
one.

**Never guess which file defines an expression.** That change lived in
`core/prototypes/noise-functions.lua`; neither `core/lualib/resource-autoplace.lua`
nor `base/prototypes/entity/resources.lua` moved at all between 2.0.77 and
2.1.12, so guessing by filename would have cleared the resource fixtures
wrongly.

`pnpm refs:sync` reports which reference material is readable at the installed
binary's version (`--check` exits 1 when it is not; `--fixtures` reports which
fixtures predate the binary). It **pins nothing**. It is deliberately not part
of `verify`, which must pass on machines with no Factorio installed.

### Probes: the rule is new probes only

**`test/oracle/` stays.** It is 9,593 lines, it works, and nothing in it gets
rewritten to use the CLI. `sampleExpression()` remains the right tool for
sampling a noise expression, and the local harness is what most of `docs/noise/`
was built with. Adoption happens when someone writes a probe they did not have
before - and especially when it needs something the local harness does not do: a
second Factorio version, a timeout, or provenance recorded for what it captured.

Two worked examples live in this repo. **Read one before writing another** -
both are short and carry their traps in comments beside the code that hit them:

- `scripts/probes/basis-gradient/` recovered the `basis_noise` gradient table
  (#234). It came back byte-identical from 2.0.77 and 2.1.14, which is how we
  know the table is a constant of the engine rather than of a version. **Run a
  probe against two versions when you can.**
- `scripts/probes/exchange-format/capture.ts` captures a new exchange-format
  version, five cases in about 10 seconds. See the codec section for the delta
  trap it encodes.

**Captures can run from WSL against a WINDOWS Factorio** - WSL2 executes the
`.exe` directly. A session handoff once recorded the opposite and planned a
Windows-native Node environment on that basis. `OracleOptions.pathForGame`
translates the Linux paths the harness hands the game, so no call site changes.
Three environment variables are load-bearing and each was found by it failing -
`TMPDIR` on a Windows-visible drive, `FACTORIO_BIN`, and `FACTORIO_DATA_DIR`
(the Windows layout puts data two levels above `bin/x64/`), with
`FACTORIO_PATH_STYLE=windows` selecting the translation. The full recipe and
each failure mode are in `docs/factorio-reference-and-oracle.md`. Everything is
inert off WSL.

### Automate with the Factorio headless CLI

**Ask the binary, not the wiki: `factorio --help` prints every option.** It
ships with the game, so it describes the version you actually have, and it is
ahead of the wiki - it documents `--map-preview-planet`, `--map-gen-seed-max`
and `--exchange-string`, and it says outright that `--map-gen-seed` "will
override seed specified in map gen settings", which is the trap #232 hit.
<https://wiki.factorio.com/Command_line_parameters> is a fallback for prose the
help text does not carry.

```bash
"$HOME/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio" --help
```

Relevant here:

- **Map-gen testing:** `factorio --create <save> --map-gen-settings <json>
--map-gen-seed <n> --mod-directory <dir>` runs headless and exits cleanly even
  alongside a running game, if an isolated `--config` INI points `write-data` at
  a temp dir. This is how the codec is cross-validated against the game's own
  parse; the fixture is
  `test/fixtures/map-exchange-parsed.default-seed123456.dump.json`.
- **Preview rendering:** `factorio --generate-map-preview` is exactly what
  `preview-service/container/` shells out to.

**Prefer the game as an oracle over byte-diffing** when settling a codec
question.

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
`node-version-file`, so it is what CI actually installs. It is read locally too:
the Vite+ shims on `PATH` resolve it per directory, so a bare `node` here runs
the managed build under `~/.vite-plus/js_runtime/node/`, not Homebrew's. That
only holds while `~/.vite-plus/bin` comes first on `PATH`; when something else
wins, the shims are skipped silently and `vp env doctor` marks each tool
`(not vp shim)` while still printing `All checks passed`. Cloudflare Pages never
builds this repo - `deploy:app` uploads an already-built `dist` - so an edit to
it changes the version the gate runs on and nothing else.
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
  `cargo deny check`. This is the `rust` CI job, and it is the
  **largest phase of `verify`**: 112.0s warm on a dev machine, 54% of the gate
  (measured 2026-09-05).

  **This line said "Cheap ... 1.62s cold, 0.84s warm" and was wrong by more
  than a hundredfold.** Those figures cannot have described this script, which
  runs the crate's tests twice - once clean and once under `--features poison`.
  Where the time goes, each phase timed on its own, warm:

  | phase                                                   |      time |
  | ------------------------------------------------------- | --------: |
  | `cargo test --features poison`                          | **82.4s** |
  | `cargo test --locked --workspace`                       |     26.0s |
  | `cargo build --release --target wasm32-unknown-unknown` |      2.8s |
  | `cargo deny check`                                      |      0.6s |
  | `cargo fmt --check` + `cargo clippy`                    |      0.3s |

  **The poison phase's cost is the POISON, not the test count**, and narrowing
  it was measured and REJECTED: filtering to `fixtures::` runs 108 tests
  instead of 452 and still costs **81.3s against 82.4s**. The tests the gate
  requires to go red ARE the expensive ones. What makes them expensive is the
  perturbation itself - those same 108 tests cost **20.8s clean and 81.2s
  poisoned, a 3.9x blowup** - so poisoning every op's return value drives the
  code into much slower paths. Whether that is inherent to perturbing a noise
  graph or a pathology worth fixing has NOT been measured; do not assume
  either.

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
  not before #219 - `rust-toolchain.toml` pins the version and rustup installs
  it on the first cargo command, so a machine with no Rust pays that download
  once before the gate can run at all. **Do not quote that pin here**, read it
  with `grep channel rust-toolchain.toml`. This line named 1.97.1 from #219
  until #316 moved the pin, and then stayed wrong - the same trap the
  `engine.wasm` byte count already carries a warning about, and it cost a
  second machine's setup notes the same error on 2026-08-29.

  **~3m26s on a dev machine** (measured 2026-09-05: 125 test files, 1,168
  tests, all green), and **the COMPOSITION has inverted since it was last
  written down**, which matters more than the total:

  | phase          |       time |   share |
  | -------------- | ---------: | ------: |
  | `verify:rust`  | **112.0s** | **54%** |
  | `vp test`      |  **80.3s** | **39%** |
  | `preview:test` |       8.0s |      4% |
  | `check:vue`    |       3.8s |      2% |
  | `vp check`     |       2.0s |      1% |

  The old note said the Rust phase "adds ~1.6s" and that `vp test` was 88% of
  the gate. Both are dead. #227 and #371 deleted the TypeScript noise math, so
  the test phase fell by more than half while the Rust phase grew - and the one
  phase `verify` caches is now the SECOND largest. On a runner it is no longer one job -
  see the CI section, which shards it. This line has now been wrong THREE times
  and always in the same direction, so treat the number as perishable. It claimed `~9.5s` for a
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
  - **The wall clock is set by the slowest FILE, not by total CPU** - true on
    2026-08-03, then false on 2026-08-10, and **true again now**. This has
    flipped twice, so measure it rather than quoting any of the three states.
    Re-measured 2026-09-05 at 125 files: 208.3s of per-file wall in **80.3s of
    wall clock on 12 cores, with `test/wasmVulcanusRenderParity.spec.ts` alone
    79.8s of that 80.3s**. Two files are 66% of all test time and four are 84%.
    The 2026-08-10 reading (503s spread over ten files above 20s) was correct
    for the tree it measured; #227 and #371 then deleted the TypeScript noise
    math and left the wasm parity specs standing alone. See #119 for the CI
    consequence: the single-file floor is what made N=4 look pointless, and
    once it stopped dominating, N=4 became a 32% cut of the gate.
  - **Switching to `environment: "node"` was measured and REFUTED - the cost
    RELOCATES.** This note used to claim `node` was already the default and
    worth ~3s; `vite.config.ts` sets `happy-dom`, so the claim was wrong twice
    over. On `test/base64.spec.ts`, which touches no DOM at all, the two arms
    are indistinguishable end to end (159/156ms against 154/165ms) because the
    time only moves between two line items:

    | arm                       | environment |    setup |
    | ------------------------- | ----------: | -------: |
    | `happy-dom` (the default) |        83ms |     11ms |
    | `--environment=node`      |     **0ms** | **91ms** |

    `test/setup.ts` constructs its own happy-dom `Window` to install
    `localStorage`, so `node` does not avoid loading happy-dom - it just pays
    for it under `setup` instead. **Reading the `environment` column alone
    shows a fake 20.9s win.** 105 of the 125 spec files need no DOM, so the
    migration is available; it is the payoff that is zero.

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
  are in `docs/bun-deno-evaluation.md`. That work also opened issue #267 -
  vitest's per-module transform costing 3.7x on the noise graph - and **#267 is
  now CLOSED as refuted, by re-running its own A/B** (2026-09-05). Three
  interleaved rounds per arm, 11/11 passing every run: as it ships 20.61 /
  21.27 / 20.82s, pre-bundled 20.83 / 21.06 / 20.95s. **Ratio 0.99x.** The
  162.11s baseline is gone with the code that caused it - #227 and #371 took
  `src/noise/` from 99 modules to 25, and #267 itself predicted this, naming
  the deletion as the thing that removes the tax "from the other side."

  The suite-wide line items moved the same way. Do not budget against the old
  ones:

  | line item   | 2026-08-18 |         2026-09-05 |
  | ----------- | ---------: | -----------------: |
  | tests       |      67.3% | **85.3%** (208.3s) |
  | import      |  **29.8%** |    **3.8%** (9.4s) |
  | environment |       2.1% |       8.5% (20.9s) |
  | transform   |       0.7% |        1.9% (4.6s) |

  `import` is the line the tax landed in, and it has collapsed. On the heaviest
  file, the entire non-test overhead is now **193ms** (import 58ms, transform
  55ms, environment 80ms) out of 77.2s.

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
| `rust`            | `scripts/verify-rust.sh` - ~1m45s-2m50s, added #219                |
| `verify`          | the required check: asserts every job above succeeded              |
| `build`           | `pnpm vp build`, unchanged (issue #61)                             |

**`rust` is NOT a required status check, and its absence from ruleset `EJ` is
deliberate rather than an oversight to fix.** `verify` asserts
`needs.rust.result`, so a red `rust` job turns the required check red anyway -
with no ruleset PUT and no two-step. Every required NAME is a permanent
liability, since renaming or removing one blocks every PR forever on a check
that cannot run, so the aggregator absorbing new phases is the cheaper shape.
Add future phases the same way.

**That `rust` job's cost is a RANGE, not a number, and the detail lives with the
port** - see the Rust/WASM section. Short version: roughly 1m45s to 2m50s, and
it runs `bash scripts/verify-rust.sh` directly rather than through pnpm, which
is the one place the YAML names a command instead of a script.

Sharding measured **9m03s -> 4m36s** when it landed (2026-08-03, N=3, 171 spec
files). The count is **4** now, because the suite grew to 201 files and put N=3
back up to ~8m. `docs/ci-sharding-measurements.md` holds every timing behind
that decision.

**NEVER quote a shard timing from one run.** Three runs over the SAME 218 spec
files gave binding shards of **469s, 294s and 416s** - a 59% spread on identical
test code. Any rebalancing worth doing has to beat that, and a single run cannot
show that it did. Collect several the cheap way: a PR's normal life (open,
amend, push) hands you three runs for free. The first draft of that finding read
"+80s, +21%" off one run, and the next run refuted it.

Three conclusions about the shard count, all measured on CI, none worth
re-deriving:

- **N=4 is the point of diminishing return.** N=5 and N=6 came in at +5s and +8s
  against N=4 - noise - for more runner-minutes. Total CPU is flat across arms;
  an extra job only adds ~28s of checkout and install. Local measurement said
  the opposite and did not transfer: a dev box has 12 cores and a runner has 4,
  so locally the CPU term is absorbed and only the file floor is visible.
- **Balance is the lever, not count, and you cannot balance it on purpose.**
  Vitest shards by sha1 of each spec's path, sorted, then sliced into N
  contiguous chunks. Adding any spec file changes the count and re-slices every
  shard, so names picked to spread today do not stay spread.
- **Splitting the heaviest spec file was REJECTED in #203, and that
  rejection's COST ARGUMENT has since expired.** #203 rested on import being a
  first-order cost - one shard spent 332s importing against 260s running tests
  - with `isolate: true` making each added file re-import the whole 99-module
    noise graph. Re-measured 2026-09-05: import is **9.4s against 208.3s of test
    execution** on a 26-module graph, and the heaviest file's own import line is
    **58ms**. Splitting it costs about 193ms per file added, not a re-import.

  **#203's DURABLE point still stands and is the one to reason from:** adding
  any spec file re-slices every shard, so names picked to spread today do not
  stay spread. A split is therefore a reliable win on a dev machine, where the
  wall is one file, and a lottery on CI. Nothing here says to do it - it says
  the old arithmetic no longer decides it.

**`test/findIslands.spec.ts` WAS the heaviest file, and is not any more.** It
measured 134.6s on the Mac, where the spread is small, and 240.4s before four
of its tests were cut to a small `refineCount` for identical coverage. Then
#371's engine-mandatory change put every render and survey in it through the
engine, and on Menehune, run alone, it went from **386.2s to 48.4s** (measured
2026-09-04, `pnpm vp test test/findIslands.spec.ts` on each side of the
change). One test in that file **cannot** be cheapened by lowering its refine
count and its own comment explains why, so do not "finish the job" that way.

**Re-derived 2026-09-05, and the concentration is the point.** Per-file wall on
this Mac, 125 files, 208.3s of test execution in an 80.3s wall:

| file                                    |  wall | share | cumulative |
| --------------------------------------- | ----: | ----: | ---------: |
| `test/wasmVulcanusRenderParity.spec.ts` | 79.8s | 38.3% |      38.3% |
| `test/wasmNauvisRenderParity.spec.ts`   | 58.1s | 27.9% |      66.2% |
| `test/findIslands.spec.ts`              | 23.8s | 11.4% |      77.7% |
| `test/wasmVulcanusParity.spec.ts`       | 12.7s |  6.1% |      83.8% |

Only 12 files exceed 1s at all. Read it off a verbose run rather than off this
table when it matters - the ranking has changed twice in a month.

**What breaks under load is a per-test TIMEOUT, not the gate wall.** On a
docs-only change an unchanged test hit its 120s budget at 150.5s; the same code
measured 69.6s, 90.1s, 108.8s and 150.5s across four runs, so run-to-run spread
on a 4-core runner is about 40%. That file's budget is 300s now, and the green
re-run measured the same test at 139.7s - above the old ceiling, so it really
was too small. The ceiling is per-test and hand-written, so a shard rebalance
moves which tests sit near one.

**The anti-drift rule holds by a different mechanism than it used to.** The
point of running `verify` verbatim was that there is exactly one definition of
"this repo is consistent". That is now enforced by the workflow naming only
package.json **scripts** - never the underlying commands - and by `verify`,
`verify:static` and `verify:shard` all composing the same `verify:lint`. Do not
inline `vp check` or `vue-tsc` into the YAML; add or edit a script instead.

**Two traps in that file, both of which look like tidying:**

- **The job named `verify` does no work, and must keep that name.** Since the
  sharding, the check by that name only asserts that `static` and the four
  `tests` shards passed. It looks deletable and is not: the ruleset matches
  required checks by **name**, so renaming or removing that job makes the
  required `verify` never appear, which blocks every PR permanently.
- **It asserts `needs.*.result` explicitly rather than relying on `needs:`.** A
  job whose dependency _failed_ is **skipped**, and a skipped required check
  does not block a merge. Deleting those assertions would make a red suite
  mergeable. `if: ${{ !cancelled() }}` rather than `always()` is also
  deliberate: a superseded push should stay cancelled, not become a failure.

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

### CodeRabbit reviews every PR, and it can block one

Added 2026-09-05. It reviews on open and again on **every push**, and it is a
different kind of gate from the CI jobs above - all of the following was
measured on #380 and #381 rather than read off its docs.

- **It runs on defaults.** There is no `.coderabbit.yaml` in the tree; its
  review body reports `Configuration used: Organization UI`, profile `CHILL`.
  So it grades this repo against general conventions, not against the
  invariants in this file - frozen exact counts instead of tolerance bounds,
  "never edit a fixture to make a test pass", byte-exact deflate, and
  `crates/fmw-noise/src/cliffs/connections.rs`, 578 lines that `fmw-wasm` never
  references and whose only consumer is the `#[cfg(test)]` fixtures harness.
  Each of those reads as a defect to a general reviewer and is deliberate here.
- **Its status check cannot block, but its REVIEW can.** The `CodeRabbit`
  context is not in ruleset `EJ`, whose required checks are only `verify` and
  `build`. But it submits `CHANGES_REQUESTED`, and a standing one of those
  blocks the merge even at `required_approving_review_count: 0` -
  `mergeStateStatus` goes `BLOCKED` with every check green.
- **A push dismisses nothing; the RE-REVIEW's verdict replaces the old one.**
  `EJ` sets `dismiss_stale_reviews_on_push: false`, so the push itself clears
  no review - but CodeRabbit reviews again on every push, and an `APPROVED`
  supersedes its own standing `CHANGES_REQUESTED`, leaving `reviewDecision`
  empty and `merge=CLEAN` with no hand dismissal.

  **Do NOT read that as "address every finding and it clears."** Two runs the
  same day, and they disagree: **#383** was approved on a push that took 2 of
  its 3 findings and left the third (an MD018 nit) explicitly undone, while
  **#381**'s equivalent push came back with a SECOND `CHANGES_REQUESTED` -
  raised against the text the fix had just added, not against anything left
  undone. Which verdict arrives is a property of the new diff, and it is not
  predictable from how completely you answered the last round.

  A THIRD outcome exists and it is the one that traps you: on #384's `f9d37c8`
  the `CodeRabbit` check went green with `Review completed` and **no review was
  submitted at all** - no approval, no new findings, nothing. The
  `CHANGES_REQUESTED` from the previous commit therefore stood unopposed, and
  the PR sat `BLOCKED` with every one of its eleven checks passing, fourteen
  minutes after the check had finished. A push cannot clear that, because
  nothing arrives to replace the old verdict.

  So a hand dismissal is the tool for a standing review that nothing is going
  to supersede - whether because you declined its findings or because the
  re-review said nothing. Put the reasoning in the message - it is the only
  record of why:

  ```bash
  gh api --method PUT \
    repos/FactoryGameFan/FactorioMapWebUI/pulls/<n>/reviews/<id>/dismissals \
    --field message='why' --field event=DISMISS
  ```

- **Count its findings from the REVIEW BODY, not from the inline endpoint.**
  The body opens with `Actionable comments posted: N` and then lists all N. On
  #383 that said **3** while `GET /pulls/383/comments` returned **2** - two of
  the three were reported at the same line and only one thread came back. A
  session that counts threads therefore misses findings silently, which is how
  a wrong claim reached `CLAUDE.md` in this very section. Read the body's list,
  then reconcile it against the threads:

  ```bash
  gh api --paginate repos/FactoryGameFan/FactorioMapWebUI/pulls/<n>/reviews \
    --jq '.[] | select(.state=="CHANGES_REQUESTED") | "=== review \(.id)\n\(.body)"'
  ```

  No `head`, because truncating the list is the failure this bullet exists to
  prevent; `--paginate` because reviews page at 30; and the `id` because that
  is what a dismissal needs.

- **It reads the PR description as evidence about the code.** A wrong claim in
  a PR body becomes a finding against correct code, so the body is part of what
  gets reviewed.
- **It runs markdownlint; this repo does not.** MD018 fires on a line starting
  `#339`, reading it as a heading with no space. It is not one: CommonMark
  needs a space after the hash, and GitHub's own renderer returns a `<p>`
  (`gh api markdown --field text=...`, measured). The style appears **14 times**
  across `CLAUDE.md` and the two port docs, and only the ones inside a diff get
  flagged - so taking the fix makes those lines inconsistent with the rest.

**Read its findings; do not assume they are noise.** On #381 its first two were
both real and both mine: an ABI table recording Nauvis as a 376-byte block with
a 432-byte request (it is 512 and 568 - `engine.wasm` answers
`request_bytes() = 568` when asked directly), and a paragraph still claiming
tier 2 and tier 3 "assert BOTH arms" after #227 and #371 deleted every
TypeScript arm. `vp check` passes on both, because neither is a lint error.
The rule from #380 still holds in the other direction: a finding can rest on a
false premise, and showing that it does is a valid answer.

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

**That cap is now `maxUnknown: 0`, so it is a floor as well as a ratchet.** The
last undocumented fixture was `autoplace-can-be-disabled.dump.json`, committed
2026-07-12 with no version recorded; `scripts/probes/autoplace-can-be-disabled`
re-captured it at 2.1.16 and it came back **byte-identical**, 1696 bytes. Keep
that probe rather than treating it as scaffolding - it is the only thing that
makes the claim repeatable, and `docs/fixture-version-audit.md`'s rule is that a
clean data diff can never promote an `unknown` entry. Because the count must
EQUAL the ratchet, a new fixture with no provenance now fails immediately
instead of taking up slack.

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

When an image comparison in `test/wasmFulgoraRenderParity.spec.ts`,
`test/wasmNauvisRenderParity.spec.ts` or `test/wasmVulcanusRenderParity.spec.ts`
fails, `test/diffArtifacts.ts` writes the
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

### The Rust/WASM noise engine (`crates/`) - COMPLETE, phases 1-8

A Cargo workspace at the repository root, landed empty on purpose (#219) so the
gate was proven green on `main` before any port code depended on it. Two crates:
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The design record is
`docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

**Every planet, every view the panel offers, renders through the engine, and
there is no TypeScript fallback left.** #227 deleted the Nauvis and Vulcanus
arms and #371 the Fulgora one.

#### READ `docs/rust-wasm-port.md` BEFORE TOUCHING THE PORT

That file is the long form of this section, in the same relation to it as
`docs/factorio-reference-and-oracle.md` is to the reference section above. It is
**required reading before editing `crates/`, `src/noise/wasm/`, or any tier-1,
tier-2 or tier-3 spec**, and it is a LIVE document - update it when the port
moves.

What is in there and deliberately not here: the three grading tiers and what
each one is blind to; how to read a frozen count, and the four things that
flatter or depress one; the case where the exact-match metric degenerates
entirely; the ABI's per-planet layout; the poison feature; the tier-2/tier-3
freeze tables; the structure conventions to copy for the next layer; and the
single most expensive lesson in the port - **a window must contain the thing it
grades**, which recurred at six separate sites.

`docs/rust-wasm-port-history.md` is the third file and a different thing again:
pure archaeology. Read it when a rule in the live doc is too terse to act on, or
when a frozen count moves and you need to know what moved it last time.

This section keeps only what bites a session that is NOT working on the port.

**Code comments that cite "CLAUDE.md" for a port rule mean that file.** Nine or
so comments under `crates/` and `test/` name rules by phrase - the
discrete-output rule, "a clamp flatters it", "When the exact-match count
degenerates", the no-memo rule, the `p ** octaves` trap, the cliff-lever note -
and every one of those moved to `docs/rust-wasm-port.md` on 2026-09-05. They
were deliberately NOT re-pointed: a comment-only edit in a reachable Rust file
shifts `core::panic::Location` records and so changes `engine.wasm`, which would
mean a rebuild and a fresh committed binary for pure prose. Re-point them the
next time one of those files changes for a real reason.

#### Where the port stands

| phase    | scope                                                                                                                                                                                                                  | state |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1 (#220) | primitives: `taus88`, `fast_approx`, `basis_noise`, the four multioctave ops, `random_penalty`, the spot ops, `distance_from_nearest_point`, `starting_lakes`, `voronoi_noise`                                         | done  |
| 2 (#221) | the `eval` layer - `multisample`, `memo_xy`, `memo_region`, `math`, `ctx`, `primitives` - plus `expressions/vulcanus_seed`                                                                                             | done  |
| 3 (#223) | Fulgora elevation and cells, `starting_spot_at_angle`, `tiles/`, the ABI boundary, and the render cutover                                                                                                              | done  |
| 4 (#224) | the rest of Fulgora: masks, roads, ruins, scrap, the tile catalog and `fulgora_stack`                                                                                                                                  | done  |
| 5 (#225) | Vulcanus end to end - terrain, cliffs, rocks, resources. **Every Vulcanus view the panel offers renders through the engine** (not `elevation` - see below).                                                            | done  |
| 6 (#226) | Nauvis - every expression, the TERRAIN render, all FIVE overlays and the `all` composite. The `elevation` view is ported too, as of #227                                                                               | done  |
| 7 (#227) | delete the ported TypeScript under `src/noise/` - Nauvis and the render fallbacks in #227, then Fulgora and the Vulcanus expressions in #371, which left `src/noise/` holding orchestration, catalogs and the ABI only | done  |
| 8 (#363) | Fulgora's `resources` and `all` composites, so **every planet's DEFAULT view renders through the engine**                                                                                                              | done  |

**Two cases are REFUSED rather than routed anywhere**, and neither is reachable
from the app. A caller-supplied `startingLakePositions` throws
`STARTING_LAKE_POSITIONS_UNSUPPORTED` (#365), because the module derives the
lake list from the seed and the spawn - the game's own rule - so an explicit
list is a WRONG answer rather than a slow one. And a non-Nauvis `planet` with an
elevation view throws `unsupportedPair`, because `mapType` spans the Nauvis
family only.

**Nauvis's cutover has a third guard: the SPAWN.** The Nauvis block carries no
spawn list, so the module fixes it at the origin, and `runRenderRequest` refuses
the engine when `startingPositions` is anything else. That is a correctness
guard rather than a missing optimisation - `startingPositions` reaches
`elevation_nauvis`'s distance term and `moisture`'s starting-area blend.

**A render dispatched before the engine message arrives is QUEUED, and the
handshake must SETTLE.** With no TypeScript to fall back to, a swallowed load
failure means the message never arrives and every tile hangs on "Rendering..."
(#371). `createRenderWorker` posts `{ kind: "engine", error }` on failure and
the host rejects queued requests by id. Do not reintroduce swallowing.

#### `engine.wasm` is a COMMITTED artifact

`scripts/build-wasm.sh` produces it; `verify:rust` rebuilds and compares bytes
rather than regenerating. That is what keeps `vp build` free of any non-JS step
and lets `deploy:app` run on a machine with no Rust at all. **Any change to a
Rust source means rerunning that script and committing the result**, or the gate
fails as "stale".

**Do not quote a byte count for `engine.wasm` from this file.** Every ported op
changes it and it has gone stale twice. Get it with
`shasum -a 256 src/noise/wasm/engine.wasm`.

Three diffs that are NOT behaviour changes, all seen for real: a `cmp -l` count
matching the number of lines you inserted (those are `core::panic::Location`
records); a comment-only edit in a reachable file, which really does make the
gate say "stale"; and a new UNREACHABLE module, measured at 54 bytes in #318.
The build is deterministic, so a diff after an edit is always the edit - prove
no behaviour changed by running the wasm parity specs. **A red
`verify-rust.sh` on a fresh machine is usually neither your diff nor the host**:
`rust-src` bakes local absolute paths into the module, and one RUSTFLAGS remap
fixes it (#299). Byte identity across machines is otherwise measured, not hoped
for (#218). The details are in `docs/rust-wasm-port.md`.

#### Rules that keep the port deterministic

These bite anyone editing an expression, so they stay here rather than in the
companion doc.

- **`f64::max` is NOT `Math.max`.** They differ on NaN and on **signed zero**.
  Every `min`/`max` in a ported expression goes through
  `eval::math::{min2, max2}`, and **the argument order is kept as the TypeScript
  writes it**. Only an order-sensitive raw-bits fold can see this - it is
  invisible to every tolerance and to tier 1. Phase 3 shipped 27 such sites.
- **`fold_f64` folds RAW BITS and must stay order-sensitive.** An XOR fold is
  blind to order and cancels pairs. `the_fold_is_order_sensitive` makes that
  load-bearing.
- **Trig crosses the boundary as VALUES computed in V8**, never computed in the
  module (#270). Nauvis reaches no transcendental today; if a new field does,
  its value gets passed in.
- **No `mul_add` and no fast-math.** `clippy::suboptimal_flops` is explicitly
  allowed so turning `nursery` on later cannot push the port toward FMA. No
  `target-cpu=native`. `simd128` is off, `relaxed_simd` never.
- **A WASM `u64` arrives in JavaScript as a SIGNED BigInt.** No error is raised -
  the number is simply wrong in a way that looks like a broken checksum. Every
  u64 crossing needs `BigInt.asUintN(64, x)`.
- **A frozen raw-bits fold must not contain a NaN.** WASM permits any NaN
  payload, so the fold becomes host-specific.
- **An exact count is not host-portable when a libm call sits inside it.** A
  count of `r.powf(3.0)` mismatches was 3,653 on macOS and 3,651 on the Linux
  runner - green locally three times, red on every CI run (#327). If `pow`,
  `log2`, `exp`, `cbrt`, `sin` or `cos` sits inside the predicate being counted,
  freeze a FRACTION and say why.

#### One open finding, and do not "fix" it inside the port

The port found real defects in shipped TypeScript. **None was fixed inside the
port** - each got an issue and landed as its own graded change, because a
unilateral fix on the Rust side reads as a port bug in tier 2, which is the
whole point of having tier 2. The precision findings are landed (#269, #270,
#273, #279, #290, #293, #309), and #320 with them. ONE remains:

- **#320 - `waterLevel` never reached the Nauvis tile argmax. FIXED.** The
  Rust reproduced it on purpose while `renderTerrain.ts` existed to be
  mirrored; #380 deleted that file, so the pinned zero agreed with nothing.
  Two lessons worth keeping, both in `docs/rust-wasm-port.md`: the fix moved
  exactly ONE frozen row of 73, because every other row is captured at the
  default controls where `waterLevel` IS 0 - a table can be blind to a defect
  it otherwise covers thoroughly. And a near-spawn window reports 0 of 6400
  differing at every water level, which is how it stayed hidden; the new rows
  sweep +/-3000, where 48.1% of pixels move.
- **#324 - a DUPLICATED FUNCTION.** `cliffs/cliffCatalog.ts` carries its own
  plain-f64 `sliderToLinear`; the `eval/math.ts` form rounds every operation to
  f32 and is the one measured against the game. They disagree at 11 of 22
  slider positions, worst 1.4e-7. No committed fixture can grade it.

#### `verify:rust`'s cost is a RANGE

Treat it as roughly **1m45s to 2m50s**, not a number. Three CI runs on
equivalent code came in at 1m44s, 2m48s and 2m49s - the same spread the test
shards show. A single run measures the runner at least as much as the job. Do
not "correct" this to whichever number you last saw; if a change really does
move it, show it with more than one run.

It runs `bash scripts/verify-rust.sh` directly, the one place the CI YAML names
a command instead of a package.json script. That does not reopen the drift rule,
because `verify:rust` _is_ that one line. If it ever grows a second command, the
job must become `pnpm run verify:rust` with the setup steps restored.

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
