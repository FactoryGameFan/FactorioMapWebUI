# CI deploys, then retire the paid preview container

Date: 2026-10-22. Status: design, awaiting Eric's approval.

## Why

The live site has two previews. The right-hand box sends the preset to a
Cloudflare Worker (`fmw-preview`), which wakes a container running real
Factorio and returns a PNG. The left **Preview** tab draws the same map in the
browser with the Rust/WASM engine.

The container costs money while it is awake, and the WASM engine is now close
enough to the game that the paid render is not worth keeping. Measured on
`main` at `0294468`: out of 1,048,576 pixels, the WASM terrain differs from the
game's own preview on 1 pixel for Nauvis, 1 for Vulcanus and 20 for Fulgora.

Deploys are by hand today. The main reason was the container: a CI deploy of
the preview Worker would also build and push the Docker image. With the
container out of production, the app is a plain static-assets Worker, and CI
can deploy it on every merge. Issue #435 already records how.

## Two pieces of work, in this order

1. **CI deploys the app** (its own PR, closes #435). Proved with one real
   deploy before step 2 starts.
2. **Retire the preview container from production** (the next PR). It reaches
   the live site through step 1's deploy job, with no hand deploy.
3. **Delete the Cloudflare resources**, after step 2 is live and the Worker's
   traffic has fallen to zero.

Each step ships on its own, so a failure in one never hides in another.

## Goals

- Every push to `main` that passes the gate goes live with no person at a
  terminal.
- The live site makes no outbound calls. The right-hand box is the WASM preview.
- Nothing paid is left on Cloudflare for previews.
- The Docker renderer still works locally, as a tool agents can call.

## Non-goals

- No change to the WASM engine, the codec, or map-string import and export.
- No Gleba or Aquilo client render (that is #454).
- No CI deploy for the preview Worker. It stops being deployed at all.
- No move to the `cf` CLI. Checked 2026-10-22 (`cf` 1.0.0-beta.20,
  `cf migrate --dry-run`): it adds no security here - it authenticates with
  the same API token, and for this repo it hands the deploy to wrangler
  anyway - while adding a second root wrangler copy beside the one
  `@cloudflare/vitest-plugin` pins. Deferred until it adds something; Wrangler
  is maintained for 18 months after `cf`'s beta ends.

## Anti-goals (failure even if it "works")

- A deploy that runs when `static`, `tests`, `rust` or `build` failed, or that
  runs on a pull request.
- An older commit's deploy finishing after a newer one and putting the site back
  on the older commit.
- A secret with more reach than this one deploy needs.
- Deleting a Cloudflare resource before the app has stopped calling it, or
  without Eric confirming that delete.
- Losing the local Docker renderer.

## Step 1: CI deploys the app

### Decided by Eric

- **Trigger: every push to `main`**, plus `workflow_dispatch` for a redeploy.
  Renovate merges go live too. That is accepted: Renovate automerges only
  GitHub Action digest re-pins, and everything else still needs Eric to merge.
- **Order: first, as its own PR**, before the container work.

### Shape

A `deploy` job in `.github/workflows/verify.yml`. It has to live there:
`needs:` only works between jobs in one workflow, and a separate workflow would
need a `workflow_run` trigger, which runs with secrets for PR-triggered runs too
and cannot check `needs.*.result`. It:

- runs only on `push` to `main` and on `workflow_dispatch`, never on
  `pull_request`;
- `needs:` `static`, `tests`, `rust` and `build`, and asserts each
  `needs.*.result == 'success'` explicitly, the same way the `verify` job does.
  A skipped dependency must not let it run;
- builds `dist` on the runner. On a `push` the build stamp is the real commit,
  unlike the synthetic merge SHA on a PR;
- runs `wrangler deploy` from the repo root, reading the root `wrangler.jsonc`,
  with the wrangler pinned in `preview-service/worker` - the same thing
  `deploy:app` runs today:
  `pnpm --filter @fmw/preview-worker exec wrangler deploy --cwd ../..`, in a
  plain `run:` step with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in
  that step's `env`. It adds `--strict` (refuses to override remote settings in
  a non-interactive run), `--message <full sha>` and `--tag <short sha>`, so the
  Cloudflare dashboard names the commit. It does **not** run `pnpm run verify`
  a second time; the `needs:` list is that gate;
- **does not use `cloudflare/wrangler-action`.** That action runs
  `pnpm exec wrangler --version` and, finding no wrangler at the root, runs
  `pnpm add wrangler` there, which fails with `ERR_PNPM_ADDING_TO_ROOT`; pointed
  at `preview-service/worker` it would read the `fmw-preview` config instead.
  A `run:` step also means no third-party action holds the token;
- runs `pnpm run verify:deploy` last, so the job is green only when
  `/version.json` shows the pushed commit.

### Constraints the builder must meet

- **No out-of-order deploys, and no stranded commits.** The workflow's own
  concurrency does not cancel runs on `main` (on purpose, see its comment), so
  two quick merges run side by side. Two obvious guards were rejected by the
  design review:
  - a concurrency group with `cancel-in-progress: false` keeps only ONE pending
    job and a later arrival replaces it, so a slower older run can knock out the
    newest commit's waiting deploy;
  - "skip unless this SHA is the tip of `main`" then leaves the site on an older
    commit with nothing queued to fix it, and does the same whenever the newest
    commit fails the gate.

  **Claude's call:** no deploy concurrency group. Just before `wrangler deploy`,
  the job reads the live `/version.json` and compares it with the run's SHA
  against `main`'s full history (`fetch-depth: 0`, or fetch `main` explicitly):

  | live commit | meaning | job |
  | --- | --- | --- |
  | an ancestor of the run's SHA | the normal case | deploy |
  | on `main`, and a descendant of the run's SHA | a newer merge is already live | skip, with a `::warning::` naming both commits |
  | **not on `main`**, unknown to the checkout, or stamped `-dirty` | someone hand-deployed a branch or a dirty tree | **fail** (Eric decided) |
  | `/version.json` unreadable | cannot tell | fail |

  The third row exists because this repo squash-merges: a PR branch's commits
  never enter `main`'s history. That has happened for real - after #434 the
  live site ran the branch commit `7711ad8`, not `main`'s `e9a2e9f` (#435). A
  plain "deploy if the live commit is an ancestor" rule would then skip every
  later run while showing green. Eric chose a red job over deploying on top of
  it, so a deliberate branch hotfix is never overwritten silently; the fix is a
  redeploy from `main` with the dispatch button. The failure message says so.

  Two runs checking in the same second can still race; that window is
  accepted. The builder checks the one-pending-job rule against GitHub's
  current docs before relying on any of this.
- **`verify:deploy` can race propagation.** It has reported a mismatch on a
  deploy that did land (see memory note "verify-deploy races propagation"). In
  CI it needs a few retries with a short wait before it fails the job. Exit code
  2 ("could not check") is never a pass.
- **The deploy job is not a required check.** It runs only after merge, so
  adding it to ruleset `EJ` would block every PR on a check that cannot run.
- **Pinning and permissions** follow the existing workflow: actions pinned to a
  full SHA with a `# vX.Y.Z` comment, `permissions: contents: read`, no
  `version:` input on `pnpm/action-setup`.
- **Digest re-pins stop automerging (Eric decided, from the security review).**
  The #62 rule in `.github/renovate.json5` automerges GitHub Action digest
  re-pins. Once a merge deploys with the token, that rule would let a moved
  upstream tag (the 2025 `tj-actions/changed-files` attack) reach `main` and
  run with the secret, unread. The same PR removes the automerge exception and
  rewrites its comment to say why. Digest re-pins still arrive as PRs. The
  CLAUDE.md paragraph about that rule and `strict: true` is updated to match.
- **The dispatch button deploys `main` only.** `workflow_dispatch` lets a person
  pick any ref, so the job also checks `github.ref == 'refs/heads/main'`. The
  environment's branch rule below is the real guard; this makes the intent
  plain in the YAML.
- **`.node-version` and the lockfile** stay the single source, as in every
  other job.

### The secret (Eric creates it; Claude cannot)

- **An environment secret, not a repo secret (Eric decided).** This repo is
  public, and a `pull_request` run from a same-repo branch gets repo secrets,
  running whatever workflow that branch contains. Renovate and the Claude app
  both push same-repo branches. So `CLOUDFLARE_API_TOKEN` lives on a GitHub
  environment named `production` whose **deployment branches are set to `main`
  only**; the branch rule is what keeps a PR from naming the environment and
  reading the token. No required reviewers, since Eric chose push-to-deploy. The
  account ID goes on the same environment as a variable,
  `CLOUDFLARE_ACCOUNT_ID`. No environments exist yet; the plan creates this one
  (Claude can with `gh api`, or Eric in Settings) and verifies the branch rule
  by reading it back.
- **A custom, narrow token (Eric decided), not the "Edit Cloudflare Workers"
  template.** That template grants Workers Routes, Scripts, KV and R2 Write,
  Tail Read, Account Settings Read and User Details and Memberships Read - on
  this account that reaches `fmw-preview` and its R2 bucket. Cloudflare's docs
  (Workers authorization, updated 2026-09-15) now let a token carry a Workers
  role **for selected Workers only**, and a routine deploy of an existing
  Worker needs only `Editor` on it. So Eric creates:
  - an **account-owned** token (Cloudflare recommends these for CI that must
    outlive the person who made it; they carry a `cfat_` prefix that secret
    scanners recognise);
  - with **Workers `Editor` on `map-factorygamefan-com` only**, and nothing
    else;
  - with an expiry date one year out. **Claude's call** on the length; a
    reminder to rotate it goes in Eric's Todoist if he wants one.
  No IP filter: GitHub-hosted runners have no fixed addresses.
- **The Custom Domain is the one unknown.** Custom Domains do not support
  per-Worker roles yet, and changing a route or domain needs
  `Zone > Workers Routes > Write` on the zone. A deploy that leaves the domain
  as it is should need only `Editor`. The first real deploy proves which. If it
  fails on the domain, the token gains exactly
  `Zone > Workers Routes > Write` on `factorygamefan.com`, nothing broader.
- **Recovery is `wrangler rollback`**, run by hand with Eric's own login. It
  makes a new deployment of a previous version at once. The app has no
  bindings, so nothing else needs undoing. Gradual deployments are out: without
  version affinity two versions with different hashed files can 404 the page,
  and this Worker has no script to set an affinity cookie.

### Why not Workers Builds

Cloudflare's own Git integration was checked (Workers CI/CD docs, October
2026) and rejected, so it is not proposed again:

- it deploys on push and **cannot wait for GitHub checks**; the only way round
  is a deploy hook that Actions calls, and that hook URL is itself a secret;
- it supports **only user tokens**, and the one it creates holds Workers
  Scripts, KV and R2 edit plus Routes on every zone;
- with preview builds on, it would build Renovate's same-repo branches while
  holding that token;
- its image defaults to pnpm 10.11.1 and does not read `devEngines`, so this
  repo's pnpm 12 would need a `PNPM_VERSION` override kept in sync by hand.

### Docs

- CLAUDE.md: "No secrets, no deploy job" and the "Deploys are gated on `verify`"
  section change to describe the CI deploy, the secret, and why the job is not
  required. The CI table gains the `deploy` row.
- README: how a deploy happens now. `pnpm run deploy` stays as the emergency
  hand path, with a warning that a hand deploy from anything but a clean `main`
  makes the next CI deploy fail until `main` is redeployed.
- The root `wrangler.jsonc` comment says wrangler 4.131.1 caps
  `compatibility_date`; the lockfile has 4.151.1. The comment is corrected and
  the cap re-checked against the installed wrangler (moving the date itself is
  optional and only as far as that wrangler allows).

### Done when

- A merge to `main` deploys, and `verify:deploy` in the job reports that commit.
- A planted failing test on a branch shows the deploy job never runs on the PR,
  and a failed gate on `main` leaves the deploy job skipped or failed, never
  green.
- #435 is closed by the PR.

## Step 2: retire the preview container from production

### Decided by Eric

- **The right-hand box shows the WASM preview.** For Gleba and Aquilo it shows a
  "not available yet" message, as the Preview tab does today.
- **The left tab keeps only the island finder.** Eric is open to calling it
  "Map Tools", for tools he plans to add.
- **The Docker renderer stays for local use.** Eric no longer uses it himself;
  agents do. So the app does not need to reach it.
- **Some Nauvis presets render less than the container drew, and that is
  accepted with clear messages.** The 1/1/20-pixel figures above cover the
  default Nauvis map type only. Measured in the design review:
  - Lakes and Island map types get only the grayscale elevation view
    (`effectiveView` in `ElevationPreviewPanel.vue`, line 171). They keep it,
    with a note in the box that full terrain is not available for that map type
    yet. An issue is filed for Lakes/Island terrain.
  - A map type the app does not recognise already shows "not available"
    (`supported` in `src/model/elevationPreviewCtx.ts`). Unchanged.
  - A preset with more than 8 starting points throws
    `... over the ABI cap of 8` (`src/noise/wasm/request.ts`, line 533). The box
    shows a plain "not supported yet" message instead of that raw error; the
    refusal itself stays, since dropping points would render a wrong map.

### The app

- The right-hand `<aside>` in `App.vue` holds the WASM panel. Its toolbar merges
  both of today's panels: the planet dropdown (it lives in `PreviewPanel.vue`
  now and has to move), the seed readout, Re-roll (today only on the server
  panel, using `store.previewSeed(true)`), the Debug checkbox with its view
  buttons, and Generate.
- Picking an island in the left tab re-centres the right-hand render, as it
  re-centres the tab's render today (`jumpTarget` and the `centerX`/`centerY`
  props, including the rule that a jump does not trigger a first render the
  user never asked for).
- Delete `src/components/PreviewPanel.vue`, `src/io/previewClient.ts`,
  `src/config.ts`, `VITE_PREVIEW_SERVICE_URL` (from `.env.production` and
  `.env.example`), and the tests that only cover them
  (`test/previewPanel.spec.ts`, `test/previewClient.spec.ts`). Other specs that
  mention them (`a11y`, `formFieldLabels`) are updated, not deleted.
  `mockLeakGuards` stubs `globalThis.fetch` directly and does not use the
  preview client; only its doc comment, which names the two deleted specs,
  changes.
- `public/llms.txt` describes the optional server render and the live site
  serves it; it is rewritten to describe the in-browser preview.
- **CSP:** `connect-src` drops the `fmw-preview.wormeyman.workers.dev` origin,
  leaving `'self'`. `img-src` drops `blob:`: only `PreviewPanel.vue` put a blob
  URL in an image (`ActionBar.vue`'s blob URL is a download link, which
  `img-src` does not govern). The `_headers` comments that name the preview
  Worker are updated.
- After the deploy, the CSP is checked on a live response, since a wrong CSP
  fails silently (CLAUDE.md, "The app Worker").

### The local tool

- `preview-service/` stays as it is, with its tests in `preview:test`, so
  `verify` and CI keep it working. The Renovate rule for
  `factoriotools/factorio` and `pnpm run types:sync` stay.
- `pnpm localpreview` starts only the Worker and container on
  `localhost:8787`. `preview:app` goes, since its only job was pointing the app
  at that address.
- `preview:deploy` and the Worker's own `deploy` script are removed, so no
  script builds the paid setup. The preview Worker's `wrangler.jsonc` keeps its
  `containers`, Durable Object and R2 bindings, because `wrangler dev` needs them
  locally.
- `ALLOWED_ORIGIN`: the Worker rejects only an `Origin` header that is present
  and wrong (`preview-service/worker/src/index.ts:95`), so a plain `curl` with
  no `Origin` already gets a render. The README gains that working command. The
  local Worker stays bound to localhost; never add `--host`.
- That same check is why the live Worker is worth deleting: anyone with `curl`
  can spend its 5,000-a-month render budget and keep the container awake today.

### Docs

- CLAUDE.md's preview-service section changes from "deployed, here is what it
  costs" to "a local tool for agents". The billing, `sleepAfter` and SIGTERM
  findings stay as history, marked as no longer live.
- `docs/superpowers/plans/` and `specs/` are point-in-time records and are not
  edited.

### Done when

- The live site shows the WASM preview in the right-hand box for Nauvis,
  Vulcanus and Fulgora, and "not available yet" for Gleba and Aquilo. A Lakes
  preset shows elevation with its note, and a 9-starting-point preset shows the
  plain message, each covered by a component test.
- A live response's CSP has no Worker origin in `connect-src`, and the page
  logs no CSP violations while rendering.
- `pnpm localpreview` still returns a PNG to a `curl` call.
- `pnpm run verify` passes.

## Step 3: delete the Cloudflare resources

After step 2 is live, check the `fmw-preview` Worker's request count. Real
traffic was about 7 renders a day, so a few days near zero is enough. Then
delete in this order, each one confirmed by Eric first, since none can be
undone:

1. `wrangler delete --dry-run` for `fmw-preview`, read before anything goes.
2. The `fmw-preview` Worker. Cloudflare's Delete Worker API deletes the Durable
   Object namespaces a Worker implements along with it, so
   `PreviewContainer` and `RenderBudget` need no deleted-classes migration
   first.
3. The container application `fmw-preview-previewcontainer`. Removing it from
   config does not delete it; `wrangler containers delete <id>` does.
4. Its images in Cloudflare's registry (`wrangler containers images list`,
   then `delete`). This ends any rollback to an old `fmw-preview` version, which
   is the point.
5. The R2 bucket `fmw-preview-cache`: it must be empty first (dashboard
   Settings > Empty Bucket, or a 1-day lifecycle rule), then
   `wrangler r2 bucket delete`.

Then confirm with the `containersUsageAdaptiveGroups` billing data, not with
`wrangler containers list`, that nothing is billed (CLAUDE.md explains why).
Wait at least an hour before reading an empty bucket as zero.

## Left to the builder

- How `verify:deploy` retries in CI.
- How the ancestry check is written (a short script in the repo's language,
  not inline shell logic, per Eric's global rule on shell scripting).
- The toolbar's exact layout in the right-hand box, within the controls listed.
- Whether the left tab is renamed "Map Tools" now. **Claude's call:** rename
  it, since "Preview" would point at the wrong panel once the map moves right.
