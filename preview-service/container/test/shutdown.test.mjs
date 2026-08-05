import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

/**
 * **The container must exit on SIGTERM, and this is not a formality (#120).**
 *
 * The Dockerfile's `ENTRYPOINT ["node", "/app/server.mjs"]` is exec form, so node
 * is PID 1 - and Linux gives PID 1 no default signal dispositions. Without an
 * explicit handler a SIGTERM is silently DISCARDED rather than killing the
 * process.
 *
 * `@cloudflare/containers` stops an idle container by sending SIGTERM and never
 * escalating to SIGKILL (its own source, at the `sleepAfter` declaration: "The
 * container won't get a SIGKILL if this threshold is triggered"). So a container
 * that ignores SIGTERM is never shut down by the SDK at all - it lingers until
 * the platform reclaims it, which is the ~8.5 minute idle tail #120 measured
 * against a configured `sleepAfter` of 20s.
 *
 * This test spawns the real server and sends it a real SIGTERM.
 *
 * **What it can and cannot reproduce, stated because the difference matters.**
 * The spawned child is NOT pid 1, so it keeps the default disposition and dies
 * on SIGTERM even with no handler. Deleting the handler therefore makes this
 * test fail on the **exit-code** assertion - `code: null, signal: SIGTERM`
 * instead of a clean `exit(0)` - not on the timeout. Verified by planting that
 * removal: the test fails in ~34ms rather than waiting 5s.
 *
 * So this guards the handler's PRESENCE and its clean-exit behaviour, which is
 * what regresses in practice. The TIMEOUT arm covers the genuine pid-1 case and
 * cannot fire outside a container; it is kept because a handler that hangs
 * instead of exiting would be caught by nothing else. Confirming the fix in
 * production still means deploying and re-reading the billing buckets.
 */
test("exits promptly on SIGTERM", async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0" },
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

    const exited = new Promise((resolve) =>
      child.on("exit", (code, sig) => resolve({ code, sig })),
    );
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 5_000)),
    ]);

    assert.notEqual(
      result,
      "TIMEOUT",
      "server ignored SIGTERM - as PID 1 in the container it would never be stopped by the SDK, which does not escalate to SIGKILL (#120)",
    );
    assert.equal(result.code, 0, "expected a clean exit(0) from the SIGTERM handler");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
