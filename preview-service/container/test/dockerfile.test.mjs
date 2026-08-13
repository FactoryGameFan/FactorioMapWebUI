/**
 * Guards on the Dockerfile's base-image pin.
 *
 * WHY THIS FILE EXISTS (#182, #183). Nothing builds this image until someone
 * deploys: no workflow references docker, and `preview:test` deliberately needs
 * no container runtime so CI can run it at all. So the `RUN factorio --version
 * | grep -q` assertion inside the Dockerfile - the only check that the base
 * image is the Factorio this repo means to render with - runs on nobody's
 * machine during review. A change to the pin passes both required checks and is
 * discovered at deploy time or not at all.
 *
 * These tests are the part of that gap which can be closed without Docker: they
 * read the Dockerfile as text and assert the pin is self-consistent and cannot
 * silently track a moving tag. They do NOT replace building the image.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(here, "..", "Dockerfile");
const text = readFileSync(DOCKERFILE, "utf8");

/** The FROM line, ignoring comments. */
function fromLine() {
  const line = text.split("\n").find((l) => l.startsWith("FROM "));
  assert.ok(line, "no FROM line in the Dockerfile");
  return line;
}

test("the base image is pinned by digest AND carries its version tag", () => {
  // The bug this catches is #182 exactly. With a BARE digest and no tag,
  // Renovate's docker manager defaults to `latest`, so it silently stops
  // tracking the intended version and starts proposing "digest updates" that
  // are version jumps - `fb7a13c` was offered as a digest bump of a 2.1.12 pin
  // and was in fact 2.1.14. The tag is what keeps Renovate on this version.
  const line = fromLine();
  const m = /^FROM\s+(\S+?):(\S+?)@(sha256:[0-9a-f]{64})\s*$/.exec(line);
  assert.ok(
    m,
    `FROM must be "image:tag@sha256:...", with BOTH a tag and a digest.\n` +
      `A bare digest makes Renovate track 'latest' (#182).\n` +
      `Got: ${line}`,
  );
});

test("the FROM tag and the in-build version assertion name the same version", () => {
  // Two places state the intended Factorio version and they are edited by hand.
  // If they drift, the build either fails confusingly or - worse - asserts a
  // version nobody meant. Neither is visible until an image build.
  const [, , tag] = /^FROM\s+(\S+?):(\S+?)@sha256:[0-9a-f]{64}\s*$/.exec(fromLine());

  const asserted = /factorio --version \| grep -q "Version: ([^"]+)"/.exec(text);
  assert.ok(asserted, 'no `factorio --version | grep -q "Version: X"` assertion in the Dockerfile');

  assert.equal(
    asserted[1],
    tag,
    `the FROM tag (${tag}) and the version assertion (${asserted[1]}) disagree - ` +
      `update both together`,
  );
});

/**
 * Resolves the tag's real digest from the registry. Network-dependent, so a
 * network failure SKIPS rather than fails - an offline dev machine must not
 * turn this into a red suite. A reachable registry that disagrees is a real
 * failure: it means the digest is not the tag it claims to be.
 */
test("the pinned digest really is that tag's digest", async (t) => {
  const [, image, tag, digest] = /^FROM\s+(\S+?):(\S+?)@(sha256:[0-9a-f]{64})\s*$/.exec(fromLine());

  let live;
  try {
    const auth = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`,
      { signal: AbortSignal.timeout(15000) },
    );
    const { token } = await auth.json();
    const res = await fetch(`https://registry-1.docker.io/v2/${image}/manifests/${tag}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    live = res.headers.get("docker-content-digest");
    if (!live) throw new Error("registry returned no docker-content-digest header");
  } catch (err) {
    t.skip(`registry unreachable (${err.message}) - digest not verified`);
    return;
  }

  assert.equal(
    live,
    digest,
    `${image}:${tag} now resolves to ${live}, but the Dockerfile pins ${digest}.\n` +
      `Either the publisher re-pushed the tag, or the pin is not the version it claims.`,
  );
});

test("the worker's FACTORIO_VERSION matches the image the container actually runs", () => {
  // A THIRD place names the Factorio version, and it is the one that bites
  // silently. `FACTORIO_VERSION` in the worker's vars goes into the R2 cache
  // key (`cacheKey({...req, factorioVersion})`), so it is what separates
  // renders made by different games.
  //
  // Bumping the image WITHOUT bumping this does not fail anything: previews
  // still render, and the new game's output is simply stored under the old
  // game's key, next to - and indistinguishable from - PNGs the previous image
  // produced. The cache then serves a mix of two Factorio versions forever,
  // because nothing ever invalidates the stale entries.
  //
  // Measured, not hypothetical: this is exactly what happened deploying the
  // 2.1.14 container on 2026-08-13 (#187 follow-up).
  const [, , tag] = /^FROM\s+(\S+?):(\S+?)@sha256:[0-9a-f]{64}\s*$/.exec(fromLine());

  const wranglerPath = join(here, "..", "..", "worker", "wrangler.jsonc");
  const wrangler = readFileSync(wranglerPath, "utf8");
  const declared = /"FACTORIO_VERSION"\s*:\s*"([^"]+)"/.exec(wrangler);
  assert.ok(declared, `no FACTORIO_VERSION in ${wranglerPath}`);

  assert.equal(
    declared[1],
    tag,
    `the container runs Factorio ${tag} but the worker's FACTORIO_VERSION says ` +
      `${declared[1]}.\nThat variable is part of the R2 cache key, so a mismatch ` +
      `mixes two games' renders under one key. Bump it and run \`pnpm run types:sync\`.`,
  );
});
