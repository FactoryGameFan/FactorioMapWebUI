# Factorio Map WebUI

[![verify](https://github.com/FactoryGameFan/FactorioMapWebUI/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/FactoryGameFan/FactorioMapWebUI/actions/workflows/verify.yml)

A static SPA for authoring and exchanging Factorio 2.1.x map generation presets
(exchange-string codec format `2.1.9.3`). The core editor has no backend -
everything runs in the browser, including the map preview, and the app makes no
outbound calls. A separate local tool can render real Factorio previews for
agents. See [Map preview service](#map-preview-service).

## Status

Phases 0-1c complete and merged. The codec (format 2.1.9.3) does a
**byte-exact** decode/encode round-trip on all 9 built-in presets and the
reference fixtures - the encoder reproduces the game's zlib@9 stream via `pako`
at `{ level: 9, legacyHash: true }`, so re-emitted strings are byte-identical to
the originals.

Decoded and typed on the model:

- **Mid-block:** `autoplace_settings` count + `default_enable_all_autoplace_controls`,
  `seed`, `width`, `height`, `starting_area`, `peaceful_mode`, `no_enemies_mode`.
  Still opaque: `area_to_generate_at_start` and `starting_points` (both are
  byte-identical across the corpus, so cracking them needs new positive
  fixtures).
- **Tail:** the entire MapSettings region (cliffs, pollution, enemy evolution/
  expansion, unit group, path finder, difficulty, asteroids) is fully typed;
  it decodes to zero residual opaque bytes.

Also shipped: a full multi-planet editor over the decoded model, localStorage
presets, exchange-string import, and export of `map-gen-settings.json` +
`map-settings.json` as a downloadable ZIP. `seed` is a single source of truth
for "random each new map" (`null` = random, which encodes to wire 0). The
**Enemy tab** additionally makes MapSettings tail fields editable - enemy
evolution and expansion - with the game's own display scaling (evolution factors
shown scaled up from the tiny wire floats, cooldowns in minutes), linked min/max
expansion distance, and in-game tooltip text on every field.

The app is **deployed and live** as a Cloudflare Worker (static assets) at
[`map.factorygamefan.com`](https://map.factorygamefan.com). The apex
[`factorygamefan.com`](https://factorygamefan.com) is a separate landing page,
**not** the app.

### Client-side map preview

Beyond the codec editor, the app renders map previews **entirely in the
browser** - no server round-trip - with a Rust/WebAssembly port of the game's
noise/autoplace expressions, checked point by point against a headless-Factorio
oracle (`test/oracle/`). The Factorio version it targets is the app's own badge
(see `src/model/factorioTarget.ts`). It covers Nauvis, Vulcanus and Fulgora;
Gleba and Aquilo are not done yet. Shipped so far:

- **Terrain / elevation** (M1-M2): land/water/coastline plus colored Nauvis
  terrain tiles (grass/sand/dirt/desert variants), matching the game's tile
  placement. All three base map types (Nauvis, Lakes, Island) render; Lakes and Island show
  elevation only.
- **Resources** (M3): all six Nauvis resources (iron, copper, coal, stone,
  uranium, crude-oil) as a solid-footprint overlay - both the whole-map
  `regular_patches` and the near-spawn guaranteed `starting_patches`
  (`max(starting, regular)`), responding to the frequency/size/richness sliders
  and excluded from water. Next: M3.5 (per-tile placement stipple).

The two reverse-engineered noise primitives that make this possible (`basis_noise`,
`spot_noise`, plus `random_penalty` and the multioctave family) are documented in
`docs/noise/`. The in-browser preview is now the app's only preview: the old server
preview was retired on 2026-10-22. The headless preview service below remains as
a local tool that agents can use as a cross-check oracle.

Design and phase history live in `docs/superpowers/specs/`,
`docs/superpowers/plans/`, and `docs/noise/` (point-in-time records, not living
docs).

## Development

Built and verified on the Node version in `.node-version`, which is also what
CI installs - read it with `cat .node-version` rather than trusting a number
written here. `engines.node` is a permissive floor of `>=24.18.0` because
older versions are untested rather than known-broken. The project pins pnpm via
`devEngines`, so run `vp` through pnpm - that is the form `package.json` and CI
use. `npx vp` fails with `EBADDEVENGINES`; a bare `vp` does not, it runs fine.

- `pnpm install` - install dependencies
- `pnpm vp dev` - dev server
- `pnpm vp check --fix` - lint + format + type-check of `.ts`
- `pnpm run check:vue` - `vue-tsc --noEmit`, the type-check of `<script setup>`
  bodies in the `.vue` files. Nothing else checks them.
- `pnpm vp test` - test suite (fixture-driven codec tests and UI tests)
- `pnpm vp build` - production build
- `pnpm run verify` - the whole gate: `vp check` + `check:vue` + `vp test` +
  `preview:test`. ~65-90s locally. Needs no Factorio install.

### CI

`.github/workflows/verify.yml` runs the same checks as `pnpm run verify` on every
pull request and every push to `main`. It splits them into jobs (`static`, four
`tests` shards, `rust` and `build`), and each job calls a `package.json` script
or `scripts/verify-rust.sh`, so CI and local cannot disagree about what passing
means. Those check jobs need no secrets. The `deploy` job runs only for `main`
and uses the token from the `production` environment; see Deploy below.

Dependency updates are handled by Renovate (`.github/renovate.json5`), which
encodes this project's deliberate holds rather than proposing them weekly - see
the CI section of `CLAUDE.md` for what is held and why.

## Map preview service

This is a **local tool for agents**. The app does not call it and nothing here
deploys it. The old deployment is still live and is being removed in a follow-up
change. It renders a real Factorio preview PNG so an
agent can compare it with the in-browser preview.

`preview-service/` is a pnpm workspace holding the two backend pieces:

- `worker/` - a Cloudflare Worker: validates the request, computes a cache key,
  serves a cached PNG from R2 on a hit, and on a miss enforces a monthly render
  budget (Durable Object) before calling the container.
- `container/` - a digest-pinned `factoriotools/factorio` image (tag in `preview-service/container/Dockerfile`) plus a thin
  Node HTTP server that shells out to `factorio --generate-map-preview` and
  returns the PNG bytes.

### Run it locally (needs Docker)

`wrangler dev` builds and runs the container through your local Docker daemon and
simulates the R2 and Durable Object bindings, so no Cloudflare account is needed:

- `pnpm localpreview` - alias for `pnpm preview:dev`. Starts the Worker (on
  `:8787`) and its container. Ctrl-C stops them.
- `pnpm preview:worker` - the same Worker + container, without the Docker check
- `pnpm preview:test` - Worker + container unit tests

Then ask for a preview. The body needs `mapGenSettings` (an object), `planet`
(`nauvis`, `vulcanus`, `gleba`, `fulgora` or `aquilo`), `seed` (an integer from
0 to 4294967295) and `size` (must be `1024`). The old app also put
the same seed inside `mapGenSettings`; that is a convention, and the Worker does
not check it:

```bash
curl --silent --show-error --request POST http://localhost:8787/preview \
  --header 'content-type: application/json' \
  --data '{"mapGenSettings":{"seed":12345},"planet":"nauvis","seed":12345,"size":1024}' \
  --output preview.png
```

The container image build and render are also covered by a Docker integration
test: `pnpm --filter @fmw/preview-container test:integration`.

### Deploy

The app is a Worker with static assets on the `wormeyman` **Cloudflare** account -
unrelated to the GitHub org, which moved to `FactoryGameFan` on 2026-08-17 and did
not take the Cloudflare account with it. The app no longer uses the preview
service and nothing deploys it. The old deployment is being removed.

The app deploys itself. Every merge to `main` runs the checks in GitHub Actions,
and the `deploy` job publishes the app once they pass. You can also run the
workflow by hand ("Run workflow" on the Actions tab, from the `main` branch) to
redeploy it.

`pnpm run deploy` is the hand path. It verifies, builds, and publishes the app,
and aborts before `wrangler` if anything fails (`pnpm run verify` is `vp check`,
`check:vue`, `vp test`, `preview:test` and `verify:rust`).

Take care: if you deploy anything other than a clean `main`, the next CI deploy
fails until `main` is redeployed ("Run workflow" from the `main` branch; a
re-run of the failed run does not work).

### Confirm a deploy actually landed

```
pnpm run verify:deploy
```

Fetches `https://map.factorygamefan.com/version.json` with caching bypassed and
compares its commit against your local `HEAD`. Exit 0 means the live site is
running that commit; exit 1 means it is not, and the output says which commit it
IS running; exit 2 means the check could not be made, which is not a pass. Pass a
different origin to check somewhere else - `pnpm run verify:deploy
http://localhost:5199` works against `vp dev`.

The same stamp is in the titlebar (`build <sha>`, with `-dirty` when the build
came from a tree with uncommitted changes) and in `/version.json`, both emitted
from one git read at build time.

Design and the task-by-task plan:
`docs/superpowers/specs/2026-07-10-map-preview-service-design.md` and
`docs/superpowers/plans/2026-07-10-map-preview-service.md`.

## Design

See `docs/superpowers/specs/2026-07-01-factorio-map-webui-design.md`. The
codec is fixture-driven: `test/fixtures/builtin-presets.json` holds all 9
built-in presets captured from Factorio 2.1.9 and is read-only ground truth.

## License

AGPL-3.0-or-later. See [`LICENSE`](LICENSE).

Copyright (C) 2026 Eric J

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for
more details.

The Affero clause is the point, not an accident. Most of this repo is a static
SPA whose code is delivered to every visitor's browser, so plain GPL copyleft
would already reach anyone who forks and hosts the frontend. What it would
_not_ reach is a server-side derivative that renders on the backend and returns
only images - and that is the concrete case this project has met. Section 13
covers it: if you run a modified version and let users interact with it over a
network, those users are owed the source.

Note on scope: the license covers this repository's code. The reverse-engineered
findings it documents - how Factorio's `basis_noise` seeds itself, the
`spot_noise` RNG structure, the planet surface-seed derivation - are facts about
how third-party software behaves, and facts are not copyrightable. Reimplementing
them from these notes is not a derivative work of this code. Factorio itself is
the property of Wube Software; this project is unaffiliated.
