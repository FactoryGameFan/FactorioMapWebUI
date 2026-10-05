import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

/**
 * **`/render` must say which Factorio produced the PNG.** The Worker caches a
 * render under its own `FACTORIO_VERSION`, and during a container rollout the
 * new Worker can reach instances still on the old image. The
 * `x-factorio-version` header is how it tells the two apart and declines to
 * cache the old game's output under the new game's key.
 *
 * This runs the real server against a stand-in `factorio`: a shell script that
 * answers `--version` and writes a four-byte PNG signature for
 * `--generate-map-preview`. It proves the header is read from the BINARY and
 * reaches the response. It cannot prove the real 2.1.x binary prints what
 * `parseFactorioVersion` expects - that needs the image, which needs Docker;
 * `test/image.integration.test.mjs` checks it there.
 */

async function fakeFactorio(versionLine) {
  const dir = await mkdtemp(join(tmpdir(), "fake-factorio-"));
  const bin = join(dir, "factorio");
  await writeFile(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' '${versionLine}' 'Binary version: 64'`,
      "  exit 0",
      "fi",
      "while [ $# -gt 0 ]; do",
      `  if [ "$1" = "--generate-map-preview" ]; then printf '\\211PNG' > "$2"; fi`,
      "  shift",
      "done",
      "",
    ].join("\n"),
  );
  await chmod(bin, 0o755);
  return bin;
}

/**
 * A free port, found by binding 0 and letting go. The server logs the port it
 * was ASKED for rather than the one it got (port.test.mjs relies on that), so
 * an ephemeral `FMW_CONTAINER_PORT=0` would leave this test unable to find it.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function renderWith(versionLine) {
  const bin = await fakeFactorio(versionLine);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FMW_CONTAINER_PORT: String(port), FACTORIO_BIN: bin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server never reported listening")), 10_000);
      child.stdout.on("data", (b) => {
        if (String(b).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => reject(new Error(`server exited early with ${code}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapGenSettings: {}, planet: "nauvis", seed: 1, size: 256 }),
    });
    return { res, body: new Uint8Array(await res.arrayBuffer()) };
  } finally {
    child.kill("SIGKILL");
  }
}

test("a render carries the version the binary reports", async () => {
  const { res, body } = await renderWith("Version: 9.8.7 (build 1, linux64, headless, expansion)");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-factorio-version"), "9.8.7");
  assert.deepEqual([...body], [0x89, 0x50, 0x4e, 0x47]);
});

test("an unreadable version still renders, without the header", async () => {
  // The Worker reads a missing header as "do not cache", so this must not turn
  // into a failed render - only into an uncached one.
  const { res, body } = await renderWith("this is not a version line");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-factorio-version"), null);
  assert.deepEqual([...body], [0x89, 0x50, 0x4e, 0x47]);
});
