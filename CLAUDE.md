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

## Commands

Run `vp` (Vite+) **through pnpm** - the project pins pnpm via `devEngines`, so a
bare `vp` or `npx vp` from the project root fails with `EBADDEVENGINES`.

Node **26.5.0** (`.node-version`) is what the repo is developed and verified on.
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

**The 24-hour release-age guard is real but invisible to `pnpm config`.**
`pnpm config get minimumReleaseAge` reports `undefined`, which reads like "no
policy here" - it only reports what is _explicitly_ set, and nothing in this
repo or `~/.npmrc` sets it. The value comes from pnpm 11's own defaults table,
`"minimum-release-age": 24 * 60, // 1 day` (read out of pnpm 11.17.0's shipped
code, 2026-07-29). So a package published less than a day ago will not install
without pnpm writing a `minimumReleaseAgeExclude` bypass into
`pnpm-workspace.yaml` - which is the thing to watch for in a diff. Don't
conclude the guard is off because `config get` came back empty, and don't rely
on it silently either: a pnpm 12 could change the default, so if it ever
matters, set it explicitly.

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
- `pnpm run verify` - `vp check` + `check:vue` + `vp test` + `preview:test` in
  one gate. **~65-90s on a dev machine, ~4 minutes on a CI runner**, of which
  the app test suite is ~57s and `check:vue` ~2.5s. The `~9.5s` this line
  claimed for a long time was simply wrong - already wrong by a factor of six
  before `check:vue` existed, because the suite grew to 143 files through the
  Vulcanus and cliff work - and the gap mattered: ~63s is exactly the duration
  at which people start skipping a manual gate, which is half the argument for
  the CI workflow below. Don't budget 10 seconds for this.
- `pnpm refs:sync` - pin `factorioLuaAPI/` + `~/GitHub/factorio-data` to the
  installed binary's version (`--check` reports drift only; `--fixtures` reports
  which oracle fixtures predate the binary). Deliberately **not** part of
  `verify`, which must pass on machines with no Factorio installed.
- `pnpm run deploy` - **verify** + build + `wrangler pages deploy` to Cloudflare Pages
- `pnpm run verify:deploy` - after deploying, confirm the live site is running
  local `HEAD` (see below). Takes an optional origin argument.

### CI (`.github/`) runs the same `verify`, and nothing else

`.github/workflows/verify.yml` runs `pnpm run verify` on every pull request and
every push to `main`. It invokes the script **verbatim** rather than re-listing
its phases as separate steps, so there is exactly one definition of "this repo is
consistent" and CI cannot drift from local. If you change what `verify` means,
CI follows automatically - do not mirror the change into the YAML.

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
  from `verify`: no runner has a Factorio binary. `pnpm vp build` is also absent
  (the build stamp reads git history) - that is a known gap, not an oversight.

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

One interaction is worth knowing before touching that file. The workspace's
release-age guard is a **pnpm default**, not a line in `pnpm-workspace.yaml`, and
pnpm's response to being asked for something too fresh is to write a
`minimumReleaseAgeExclude:` bypass - which is how `vue-tsc@3.3.8` once waived it
silently. `minimumReleaseAge: "3 days"` is therefore declared in the Renovate
config, above pnpm's default, so Renovate can never propose a release pnpm would
want a bypass for. If `minimumReleaseAgeExclude:` appears in a bot PR's diff,
that PR is wrong; fix the age rule, don't commit the bypass.

Renovate is inert until the GitHub App is enabled on the repo. Validate any edit
with `renovate-config-validator` (run it from outside the project root - a bare
`npx` here fails with `EBADDEVENGINES`).

Branch protection on `main` is **not** configured. It is the natural follow-up
now that a check exists, but it is a repository setting rather than a file.

#### `testTimeout` is 30s, deliberately, and retries are not used

Vitest's 5s default was too tight for this suite long before CI existed - 24
individual tests across 10 files carry an explicit `}, 120000)`, which is the
same complaint made 24 times by hand. The first CI run proved the default was the
real problem rather than any one test: on a 4-core runner (~3x slower, 230s vs
71s for the same suite) `elevationRenderRequest.spec.ts`'s `view 'all'` case
needs **9.8s**, and that file has 27 tests and zero annotations. `vite.config.ts`
now sets `testTimeout: 30_000`; the existing 120000 annotations still win over it.

Do **not** reach for `retry` when a heavy render test fails in CI. Nothing here is
nondeterministic - these tests compare pixels against captured game output - so a
retry would only hide a genuine regression. A timeout means slow; read the
duration the reporter prints before assuming a hang.

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
`script-src` must never regain `'unsafe-eval'` and the spec asserts it hasn't.

Preview-service stack (optional feature, needs Docker): **`pnpm localpreview`**
(memorable alias for `pnpm preview:dev`) runs the Worker (`:8787`) + app
(`:5173`) together; `pnpm preview:test` runs its unit tests. Both bind localhost
only - never add `--host`. See README for the full list.

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
- **The exchange format is versioned and it moves.** `SUPPORTED_VERSIONS` is a
  known-good list (`2.1.9.3`, `2.1.12.2`), never a range - the schemas here are
  empirical, so accepting an unseen format would decode a changed layout into
  plausible wrong values. A version joins the list only with a fixture proving a
  real string of it round-trips byte-exact (`test/mapExchangeVersions.spec.ts`).
  This was a live bug: the app rejected every string from Factorio 2.1.12 until
  2026-07-28. The UI now advertises the target so the next drift is visible.
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

### Preview service (`preview-service/`)

A separate pnpm workspace (`worker/` Cloudflare Worker + `container/`
digest-pinned Factorio headless image). Opt-in and the app's only outbound call;
the editor is fully functional offline without it.

`wrangler` is not global - drive it through the workspace:
`pnpm --filter @fmw/preview-worker exec wrangler <cmd>`.

**`worker-configuration.d.ts` is generated and must stay in sync with
`wrangler.jsonc`.** It once drifted silently (the types declared the apex origin
while the config said the `map.` subdomain). Nothing caught that: it is not a
type error, so both `vp check` and the worker tests pass with a wrong value in
it. `wrangler types --check` now gates the worker's `test` and `deploy` scripts,
so `pnpm preview:test` fails loudly on drift.

- Regenerate with
  `pnpm --filter @fmw/preview-worker exec wrangler types && pnpm vp check --fix`.
  The formatter pass is **not optional** - wrangler emits tabs/unwrapped types
  and the repo formats to 2-space/wrapped, so a raw regen shows a whole-file
  whitespace diff that hides the real change.
- Limitation: `--check` compares the **config** against the hash recorded in the
  generated file's header. It catches a changed `wrangler.jsonc`, but it does
  **not** notice hand-edits to the generated file itself. Don't hand-edit it.
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
