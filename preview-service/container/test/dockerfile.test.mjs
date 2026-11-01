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
 * Asks the registry what the PINNED digest is: its image config must carry the
 * FROM tag's Factorio version in the publisher's `factorio.version` label and
 * its `VERSION` env. Network-dependent, so a network failure SKIPS rather than
 * fails - an offline dev machine must not turn this into a red suite. A
 * reachable registry that does not know the digest, or that describes a
 * different Factorio, is a real failure: the pin is not the version it claims.
 *
 * It deliberately does NOT ask whether the tag still points at the pin. It used
 * to, and that went red on main and every branch when factoriotools rebuilt the
 * 2.1.23 tag on 2026-10-27 (their auto-update job, run for experimental
 * 2.1.24) with the same Factorio download inside (#502). A rebuilt tag is not a
 * wrong pin; Renovate proposes the new digest on its own schedule.
 */
const REGISTRY_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

test("the pinned digest is an image of the FROM tag's Factorio version", async (t) => {
  const [, image, tag, digest] = /^FROM\s+(\S+?):(\S+?)@(sha256:[0-9a-f]{64})\s*$/.exec(fromLine());

  let unknownDigest = false;
  let config;
  try {
    const auth = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`,
      { signal: AbortSignal.timeout(15000) },
    );
    const { token } = await auth.json();
    const get = (path) =>
      fetch(`https://registry-1.docker.io/v2/${image}/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: REGISTRY_ACCEPT },
        signal: AbortSignal.timeout(15000),
      });

    const top = await get(`manifests/${digest}`);
    if (top.status === 404) {
      unknownDigest = true;
    } else {
      if (!top.ok) throw new Error(`registry returned ${top.status}`);
      let manifest = await top.json();
      if (manifest.manifests) {
        // A multi-platform index: read the platform the container runs on.
        const amd64 = manifest.manifests.find(
          (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
        );
        assert.ok(amd64, `${image}@${digest} is an index with no linux/amd64 image`);
        const sub = await get(`manifests/${amd64.digest}`);
        if (!sub.ok) throw new Error(`registry returned ${sub.status}`);
        manifest = await sub.json();
      }
      const blob = await get(`blobs/${manifest.config.digest}`);
      if (!blob.ok) throw new Error(`registry returned ${blob.status}`);
      config = (await blob.json()).config ?? {};
    }
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    t.skip(`registry unreachable (${err.message}) - digest not verified`);
    return;
  }

  assert.ok(!unknownDigest, `the registry has no ${image}@${digest}: the pin is not a real image`);
  assert.equal(
    config.Labels?.["factorio.version"],
    tag,
    `${image}@${digest} is labelled factorio.version ${String(config.Labels?.["factorio.version"])}, ` +
      `but the FROM tag says ${tag}: the pin is not the version it claims.`,
  );
  assert.ok(
    (config.Env ?? []).includes(`VERSION=${tag}`),
    `${image}@${digest} does not set VERSION=${tag} (env: ${JSON.stringify(config.Env)})`,
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
