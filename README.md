# Factorio Map WebUI

[![verify](https://github.com/wormeyman/FactorioMapWebUI/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/wormeyman/FactorioMapWebUI/actions/workflows/verify.yml)

A static SPA for authoring and exchanging Factorio 2.1.x map generation presets
(exchange-string codec format `2.1.9.3`). The core editor has no backend -
everything runs in the browser. An optional, opt-in map preview service (the app's only outbound call)
renders real Factorio previews via Cloudflare; the editor stays fully functional
offline without it. See [Map preview service](#map-preview-service).

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

The app is **deployed and live** on Cloudflare Pages at
[`map.factorygamefan.com`](https://map.factorygamefan.com), with the map preview
service deployed alongside it. The apex
[`factorygamefan.com`](https://factorygamefan.com) is a separate landing page,
**not** the app - the worker's `ALLOWED_ORIGIN` is the `map.` subdomain.

### Client-side map preview

Beyond the codec editor, the app renders Factorio **2.1.11** map previews
**entirely in the browser** - no server round-trip - by hand-porting the game's
noise/autoplace expressions to TypeScript and validating each one point-by-point
against a headless-Factorio oracle (`test/oracle/`). Shipped so far:

- **Terrain / elevation** (M1-M2): land/water/coastline plus colored Nauvis
  terrain tiles (grass/sand/dirt/desert variants), matching the game's tile
  placement. All three base map types (Nauvis, Lakes, Island) render.
- **Resources** (M3): all six Nauvis resources (iron, copper, coal, stone,
  uranium, crude-oil) as a solid-footprint overlay - both the whole-map
  `regular_patches` and the near-spawn guaranteed `starting_patches`
  (`max(starting, regular)`), responding to the frequency/size/richness sliders
  and excluded from water. Next: M3.5 (per-tile placement stipple).

The two reverse-engineered noise primitives that make this possible (`basis_noise`,
`spot_noise`, plus `random_penalty` and the multioctave family) are documented in
`docs/noise/`. This is an offline/instant alternative to the headless preview
service below; the service remains as a cross-check oracle.

The **map preview service** (`preview-service/`) renders real Factorio previews
server-side: clicking "Generate preview" POSTs the active preset's
`map-gen-settings` to a Cloudflare Worker, which serves a cached PNG from R2 or
renders one with the real Factorio headless engine in a container. It is deployed
and live.

Design and phase history live in `docs/superpowers/specs/`,
`docs/superpowers/plans/`, and `docs/noise/` (point-in-time records, not living
docs).

## Development

Built and verified on Node **26.5.0** (`.node-version`, which is also what CI
installs); `engines.node` is a permissive floor of `>=24.18.0` because older
versions are untested rather than known-broken. The project pins pnpm via
`devEngines`, so run `vp` through pnpm (a bare `vp` or `npx vp` from the project
root fails with `EBADDEVENGINES`).

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

`.github/workflows/verify.yml` runs `pnpm run verify` on every pull request and
every push to `main` - the same command, invoked verbatim, so CI and local cannot
disagree about what passing means. It needs no secrets and does not deploy.

Dependency updates are handled by Renovate (`.github/renovate.json5`), which
encodes this project's deliberate holds rather than proposing them weekly - see
the CI section of `CLAUDE.md` for what is held and why.

## Map preview service

`preview-service/` is a pnpm workspace holding the two backend pieces:

- `worker/` - a Cloudflare Worker: validates the request, computes a cache key,
  serves a cached PNG from R2 on a hit, and on a miss enforces a monthly render
  budget (Durable Object) before calling the container. Returns the PNG through
  the Worker so it stays same-origin with the app.
- `container/` - a digest-pinned `factoriotools/factorio:2.1.12` image plus a thin
  Node HTTP server that shells out to `factorio --generate-map-preview` and
  returns the PNG bytes.

### Run the whole stack locally (needs Docker)

`wrangler dev` builds and runs the container through your local Docker daemon and
simulates the R2 and Durable Object bindings, so no Cloudflare deploy is needed
to develop or test the feature:

- `pnpm localpreview` - alias for `pnpm preview:dev`, below. Use whichever you
  remember.
- `pnpm preview:dev` - runs the Worker (on `:8787`) and the app (on `:5173`)
  together; Ctrl-C tears down both. Wires `ALLOWED_ORIGIN` and
  `VITE_PREVIEW_SERVICE_URL` so the local CORS and service URL match.
- `pnpm preview:worker` - just the Worker + container (`wrangler dev`)
- `pnpm preview:app` - just the app, pointed at the local Worker
- `pnpm preview:test` - Worker + container unit tests
- `pnpm preview:deploy` - `wrangler deploy` the Worker (gated on its tests +
  `wrangler types --check`)

The container image build and render are also covered by a Docker integration
test: `pnpm --filter @fmw/preview-container test:integration`.

### Deploy

The app and preview service are already deployed (Cloudflare Pages +
Workers/Containers on the `wormeyman` account; `pnpm run deploy` verifies,
builds, and publishes the app). Both deploy paths are gated: `pnpm run deploy`
runs `pnpm run verify` (`vp check` + `check:vue` + `vp test` + `preview:test`) first and
aborts before `wrangler` if anything fails. The one-time setup, for reference, needs a Cloudflare account
and Workers Paid ($5/mo, required for Containers):

```
pnpm --filter @fmw/preview-worker exec wrangler r2 bucket create fmw-preview-cache
# fill REPLACE_WITH_APP_ORIGIN in preview-service/worker/wrangler.jsonc, then:
pnpm --filter @fmw/preview-worker exec wrangler types
pnpm preview:deploy
# set VITE_PREVIEW_SERVICE_URL and fill REPLACE_WITH_WORKER_ORIGIN in public/_headers
pnpm vp build
```

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
