# Retire the Paid Preview Container - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live site makes no outbound calls: the right-hand box shows the in-browser WASM preview, and the server preview's code, config and CSP entry are gone, while `preview-service/` keeps working as a local tool for agents.

**Architecture:** `ElevationPreviewPanel.vue` gains the two controls only the server panel had (planet dropdown, Re-roll) plus two clear "not available" messages, and moves into `App.vue`'s right-hand `<aside>`. The left **Preview** tab becomes **Map Tools** and keeps only the island finder. `PreviewPanel.vue`, `src/io/previewClient.ts`, `src/config.ts` and `VITE_PREVIEW_SERVICE_URL` are deleted, and the CSP drops the Worker origin and `blob:`. Scripts that could deploy the paid Worker are removed. The change reaches production through the CI deploy job from PR #483.

**Tech Stack:** Vue 3 `<script setup>` + Pinia, `@vue/test-utils` + `vite-plus/test`, Cloudflare static-assets Worker (`public/_headers`), pnpm scripts.

**Spec:** `docs/superpowers/specs/2026-10-22-ci-deploy-and-container-removal-design.md`, section "Step 2: retire the preview container from production". Step 3 (deleting the Cloudflare resources) is a separate, controller-run plan.

## Global Constraints

- Right-hand box: the WASM preview for Nauvis, Vulcanus and Fulgora; "not available yet" for Gleba and Aquilo, as the Preview tab does today.
- Left tab: renamed **Map Tools** (Claude's call in the spec), island finder only.
- Lakes and Island map types keep the grayscale elevation view, plus a note that full terrain is not available for that map type yet.
- More than 8 starting points (`NAUVIS_MAX_STARTING_POINTS` in `src/noise/wasm/request.ts`): a plain "not supported yet" message instead of the raw `... over the ABI cap of 8` error. The refusal itself stays.
- An island jump re-centres the right-hand render, and never triggers a first render the user did not ask for.
- CSP `connect-src` becomes `'self'` only; `img-src` drops `blob:`. `script-src` (`'wasm-unsafe-eval'`, no `'unsafe-eval'`) is untouched.
- `preview-service/` stays, with its tests in `preview:test` (so `verify` and CI keep it working), the Renovate rule for `factoriotools/factorio`, and `pnpm run types:sync`. The preview Worker's `wrangler.jsonc` keeps its bindings (`wrangler dev` needs them).
- No script may deploy the paid Worker: `preview:deploy` and the worker's own `deploy` script go.
- `pnpm localpreview` starts only the Worker and container on `localhost:8787`; `preview:app` goes. The local Worker stays bound to localhost - never add `--host`.
- `docs/superpowers/plans/` and `specs/` are point-in-time records and are not edited (this plan's spec excepted only if a task finds it wrong).
- No em or en dashes; prose at a 12th-grade level or below.

## Review Focus

1. **Changing the planet from the right-hand box while a jump target is set** must clear the target, as changing it from the old server panel did (App's `watch(selectedPlanet)`). Pinned in Task 2.
2. **A preset with a fixed seed** must not show Re-roll; a null-seed ("random each new map") preset must, and Re-roll must render with a NEW seed. Pinned in Task 1.
3. **An island jump before any render** must neither render nor move the user off Map Tools. Pinned in Task 2.
4. **The dropdown must still offer all five planets**, so Gleba and Aquilo reach the "not available yet" message rather than vanishing. Pinned in Task 1.
5. **A >8-starting-point preset on Vulcanus or Fulgora** must not get the Nauvis message: the cap only applies where the starting points are sent. Pinned in Task 1 (check which planets pass `startingPositions` before writing the condition).

---

### Task 1: The WASM panel gets the server panel's controls and clear messages

**Files:**
- Modify: `src/components/ElevationPreviewPanel.vue`
- Test: `test/elevationPreviewPanel.spec.ts`

**Interfaces:**
- Produces: `ElevationPreviewPanel` emits `"update:planet": [value: Planet]` (so `v-model:planet` works) and renders, in its toolbar:
  - `FDropdown` with `data-test="planet-select"`, `aria-label="Planet to preview"`, options `PLANETS.map((p) => ({ value: p, label: PLANET_LABELS[p] }))` (copy from `PreviewPanel.vue`);
  - `FButton` `data-test="reroll"`, shown only when `store.activePreset?.seed === null`, which renders with `store.previewSeed(true)`;
  - a note `data-test="elevation-only-note"`: `Full terrain is not available for the {label} map type yet; showing elevation.` where `{label}` is the preset's map-type label (the same label `unsupportedLabel` uses for map types), shown only when the planet is Nauvis, the map type is supported but not `nauvis` (Lakes, Island), and a render has been asked for or the canvas is shown;
  - for too many starting points, the existing `data-test="unsupported"` paragraph with the text `Previews support up to 8 starting points; this preset has {n}.` and Generate disabled. Read the cap from `NAUVIS_MAX_STARTING_POINTS`, do not write `8`.
- `generate(reroll = false)` replaces `generate()`; the Generate button still calls it with no argument.

- [ ] **Step 1: Write the failing tests** in `test/elevationPreviewPanel.spec.ts` (reuse `setup`, `okRenderer`, `stubCanvas`):
  - `"offers all five planets in the planet dropdown"`: the `planet-select` options' values equal `["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"]`.
  - `"emits update:planet when a planet is picked"`: choosing `"vulcanus"` makes `w.emitted("update:planet")` equal `[["vulcanus"]]`.
  - `"hides Re-roll when the preset has a fixed seed"`: `setup` sets seed 123456 -> `[data-test="reroll"]` does not exist.
  - `"re-rolls a random-seed preset to a new seed and renders it"`: set `store.activePreset!.seed = null`, click Generate, record `seed0` of call 1; click Re-roll; `render` called twice and call 2's `seed0` differs from call 1's (stub `Math.random` or `crypto.getRandomValues` if `randomU32` needs it to be deterministic - check `src/store/presets.ts`).
  - `"notes that a Lakes preset shows elevation only"`: `setup("lakes", ...)`, click Generate -> `[data-test="elevation-only-note"]` text contains `"Lakes"` and `"elevation"`; for `setup("nauvis", ...)` it does not exist.
  - `"refuses a preset with more than the supported starting points, with a plain message"`: Nauvis, `startingPoints` = 9 points -> `[data-test="unsupported"]` text contains `"up to 8 starting points"` and `"9"`; Generate is disabled; clicking it does not call `render`.
  - `"does not apply the starting-point limit where starting points are not sent"`: same 9 points on whichever planet does not pass `startingPositions` to the engine (Review Focus 5) -> no unsupported message, Generate enabled. If every planet passes them, replace this test with one asserting the message on Vulcanus too, and say so in the report.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vp test test/elevationPreviewPanel.spec.ts`
Expected: FAIL on the seven new tests only.

- [ ] **Step 3: Implement in `ElevationPreviewPanel.vue`.** Fold the starting-point check into the existing `supported` / `unsupportedLabel` logic so there is one "why not" path, and keep the message wording above. Update the comment that calls App's `selectedPlanet` "shared with the server-side PreviewPanel" - the server panel is going away. Keep the layout within the existing toolbar; the planet dropdown goes first, as it did in the server panel.

- [ ] **Step 4: Run and see them pass, with no other test in the file changed**

Run: `pnpm vp test test/elevationPreviewPanel.spec.ts`
Expected: PASS, every test.

- [ ] **Step 5: Type-check the `.vue` body and commit**

Run: `pnpm vp check --fix && pnpm run check:vue` (expect clean), then:
```bash
git add src/components/ElevationPreviewPanel.vue test/elevationPreviewPanel.spec.ts
git commit --message "Give the WASM preview the planet picker, Re-roll and clear limits"
```

### Task 2: Move the WASM preview into the right-hand box and delete the server preview

**Files:**
- Modify: `src/App.vue`
- Delete: `src/components/PreviewPanel.vue`, `src/io/previewClient.ts`, `src/config.ts`, `test/previewPanel.spec.ts`, `test/previewClient.spec.ts`
- Modify: `.env.production` and `.env.example` (remove `VITE_PREVIEW_SERVICE_URL` and its comment; delete the file if nothing else is left in it), `src/vite-env.d.ts` or wherever `VITE_PREVIEW_SERVICE_URL` is typed (find with `grep -rn VITE_PREVIEW_SERVICE_URL`)
- Modify tests: `test/app.spec.ts`, `test/a11y.spec.ts`, `test/formFieldLabels.spec.ts`, and the doc comment of `test/mockLeakGuards.spec.ts` (it names the two deleted specs; its stubs use `globalThis.fetch` directly and do not change)

**Interfaces:**
- Consumes: Task 1's `ElevationPreviewPanel` with `v-model:planet`, `centerX`, `centerY`.
- Produces: `TABS = ["Resources", "Terrain", "Enemy", "Advanced", "Map Tools"]`; the right `<aside class="preview">` holds `<ElevationPreviewPanel v-model:planet="selectedPlanet" :center-x="jumpTarget?.x" :center-y="jumpTarget?.y" />`; the Map Tools tab holds `IslandFinderPanel` and the `jump-target` note only.

- [ ] **Step 1: Write the failing tests** in `test/app.spec.ts`:
  - rename `"offers a Preview tab"` to `"offers a Map Tools tab and no Preview tab"`: tab labels include `"Map Tools"` and not `"Preview"` (match the tab buttons, not page text, since the panel itself may say "preview").
  - `"shows the WASM preview in the right-hand box"`: the `aside` contains `[data-test="preview-canvas"]` and `[data-test="planet-select"]`, and no `[data-test="preview-image"]` (the server panel's image).
  - `"clears the island jump target when the planet changes from the right-hand box"` (Review Focus 1): set a jump via `IslandFinderPanel`'s `jump` event (or `w.vm` as the existing tests do - follow their pattern), then pick another planet in the aside's `planet-select` -> `[data-test="jump-target"]` is gone.
  - `"stays on Map Tools after an island jump and does not render first"` (Review Focus 3): open Map Tools, emit `jump` -> the active tab is still Map Tools and the panel's renderer was not called. If App does not let a test inject a renderer, assert `[data-test="preview-canvas"]` is still hidden and say how in the report.
  In `test/a11y.spec.ts` and `test/formFieldLabels.spec.ts`, remove the `PreviewPanel` mounts; keep every assertion that covers `ElevationPreviewPanel`, and keep the landmark test (`main` has no `aside` inside it).

- [ ] **Step 2: Run and see the new app tests fail**

Run: `pnpm vp test test/app.spec.ts`
Expected: FAIL on the four tests above.

- [ ] **Step 3: Implement.** In `App.vue`: swap the aside's content to `ElevationPreviewPanel` as in Interfaces; rename the tab; make `onIslandJump` set `jumpTarget` only (no tab switch, since the preview is always visible); keep `watch(selectedPlanet, ...)` clearing the target; update the `jumpTarget` doc comment. Delete the files listed above and the env var. Update `.preview-tab` styles only as far as the tab now has one panel.

- [ ] **Step 4: Prove nothing still references the deleted code**

Run: `git grep -nE "\bPreviewPanel\b|\bpreviewClient\b|PREVIEW_SERVICE_URL" -- src test vite.config.ts index.html ':(glob).env*'` and `grep -rn "from \"\.\./config\"\|from \"\./config\"" src test`
Expected: no output. (`\b` matches whole words, so `ElevationPreviewPanel` is not a hit. `PREVIEW_SERVICE_URL` has no word anchors on purpose so it also finds `VITE_PREVIEW_SERVICE_URL`. `git grep` searches tracked files only, so a missing `.env*` file cannot break the command.)

- [ ] **Step 5: Run the affected specs and the static checks**

Run: `pnpm vp test test/app.spec.ts test/a11y.spec.ts test/formFieldLabels.spec.ts test/mockLeakGuards.spec.ts test/elevationPreviewPanel.spec.ts && pnpm vp check --fix && pnpm run check:vue`
Expected: all pass, checks clean.

- [ ] **Step 6: Commit**

```bash
git add -A src test .env.production .env.example
git commit --message "Show the WASM preview in the right-hand box and drop the server preview"
```

### Task 3: CSP and the public description

**Files:**
- Modify: `public/_headers` (the `/*` CSP line and the comments that name the preview Worker, `connect-src`, `img-src blob:`, and the "VERIFIED LIVE" paragraph's "server preview" probe)
- Modify: `public/llms.txt`
- Test: `test/buildStamp.spec.ts` (the CSP `describe` near `script-src`)

- [ ] **Step 1: Write the failing tests** next to the existing `script-src` token tests, reusing their directive parser:
  - `"connect-src allows only the app itself"`: the `connect-src` directive's tokens equal `["'self'"]`.
  - `"img-src no longer allows blob: URLs"`: the `img-src` tokens do not include `blob:`, and do include `'self'` and `data:`.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm vp test test/buildStamp.spec.ts`
Expected: FAIL on the two new tests only.

- [ ] **Step 3: Edit `public/_headers`**: `connect-src 'self'`; `img-src 'self' data:`. Rewrite the comments so they say the app makes no outbound calls (the preview renders in the browser), and that `blob:` was only for the server preview's PNG and was removed with it. Do not touch `script-src`. In the long "VERIFIED LIVE" paragraph, note that its "server preview (so connect-src is right)" probe describes the 2026-08-19 build, and that the CSP must be re-checked live after this deploy.

- [ ] **Step 4: Rewrite `public/llms.txt`**: the preview renders in the browser through a Rust/WebAssembly port of the game's noise expressions (not "TypeScript"); there are no outbound calls; link the repo as `https://github.com/FactoryGameFan/FactorioMapWebUI` (both links).

- [ ] **Step 5: Run and see them pass, then build**

Run: `pnpm vp test test/buildStamp.spec.ts && pnpm vp build`
Expected: PASS; the build prints no warnings.

- [ ] **Step 6: Commit**

```bash
git add public/_headers public/llms.txt test/buildStamp.spec.ts
git commit --message "Drop the preview Worker from the CSP: the app makes no outbound calls"
```

### Task 4: `preview-service/` becomes a local tool, and the docs say so

**Files:**
- Modify: `package.json` (scripts), `preview-service/worker/package.json` (scripts)
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Scripts.**
  - Root `package.json`: delete `preview:app` and `preview:deploy`. `preview:dev` becomes `pnpm run require:docker && pnpm run preview:worker`. Keep `localpreview` (alias of `preview:dev`), `preview:worker`, `preview:test`, `require:docker`. Drop `concurrently` from devDependencies only if nothing else uses it (`grep -rn concurrently package.json`); if dropped, run `pnpm remove -w concurrently` then a bare `pnpm install`.
  - `preview:worker`'s `--var ALLOWED_ORIGIN:http://localhost:5173` stays: a request with no `Origin` header (curl) already passes (`preview-service/worker/src/index.ts:95`), and the value is harmless.
  - `preview-service/worker/package.json`: delete the `deploy` script.

- [ ] **Step 2: Check the scripts still resolve**

Run: `pnpm run preview:test`
Expected: PASS (worker tests including `wrangler types --check`, and the container's `node --test`).

- [ ] **Step 3: README.** The app section no longer mentions a server preview or `VITE_PREVIEW_SERVICE_URL`. The preview-service section says it is a local tool for agents, how to start it (`pnpm localpreview`, needs Docker), and a working command, using long flags:
  ```bash
  curl --silent --show-error --request POST http://localhost:8787/preview \
    --header 'content-type: application/json' \
    --data '<a body the worker accepts>' --output preview.png
  ```
  Build the `--data` body from `preview-service/worker/src/schema.ts` and the request `src/io/previewClient.ts` used to send (read it from `main`, where it still exists: `git show main:src/io/previewClient.ts`). Remove `pnpm preview:deploy` from every list.

- [ ] **Step 4: CLAUDE.md.** Edit only these places (grep for them):
  - the commands line `Preview-service stack (optional feature, needs Docker): **pnpm localpreview** ... runs the Worker (:8787) + app (:5173) together` -> Worker and container only, a local tool for agents, no app;
  - `preview:dev` and `preview:deploy` "are gated on `require:docker`" -> `preview:dev` only;
  - the "### Preview service (`preview-service/`)" section: open it with a short paragraph that the Worker no longer runs in production (date 2026-10-22, this PR) and is kept as a local tool; mark the sizing, `sleepAfter`, SIGTERM and billing-metrics bullets as history from when it was deployed, without deleting them;
  - "The app is live at **`map.factorygamefan.com`** ... the worker's `ALLOWED_ORIGIN` is the `map.` subdomain" and "the app's only outbound call" phrases -> the app makes no outbound calls;
  - the deploy section's emergency command `pnpm build && pnpm --filter @fmw/preview-worker exec wrangler deploy --cwd ../..` stays (it deploys the APP Worker via the root config; say so if the text is ambiguous).

- [ ] **Step 5: Full gate**

Run: `pnpm run verify`
Expected: exit 0 (read the real exit code).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml preview-service/worker/package.json README.md CLAUDE.md
git commit --message "Keep the preview service as a local tool for agents; nothing deploys it"
```

### Task 5: Land it and check it live (controller)

- [ ] **Step 1: Local tool smoke test.** Start Docker Desktop if it is off (`systemctl --user start docker-desktop`, ask Eric first since it boots a VM), run `pnpm localpreview` in the background, send Task 4's README `curl` command, and check the output is a PNG (`file preview.png`). Stop the stack afterwards and remove `preview.png`.
- [ ] **Step 2: PR.** Push, open the PR (body ends with the attribution lines), wait for CI. `deploy` must show **skipped** on the PR. Handle CodeRabbit as CLAUDE.md describes (read the review body, answer every finding, dismiss a standing review with the reason only when nothing will replace it).
- [ ] **Step 3: Merge, then watch the CI deploy** (`gh run watch`), and confirm `pnpm run verify:deploy` reports the merge commit.
- [ ] **Step 4: Live CSP.** `curl --silent --head https://map.factorygamefan.com/` shows `connect-src 'self';` and an `img-src` without `blob:`.
- [ ] **Step 5: Browser check.** Ask Eric to open the site, press Generate in the right-hand box on Nauvis, Vulcanus and Fulgora, pick Gleba, and check the browser console shows no CSP violations (the spec's "Done when"). If a browser tool is available in-session, do it with that instead.
- [ ] **Step 6: File the follow-up issue** "Client preview: full terrain for the Lakes and Island map types" (the spec says one is filed), naming `effectiveView` in `ElevationPreviewPanel.vue` and the elevation-only note this plan added.
- [ ] **Step 7: Step 3's clock starts.** Note the merge date; the spec's step 3 waits a few days of near-zero `fmw-preview` traffic before any deletion.
