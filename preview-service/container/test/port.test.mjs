import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

/**
 * **The container must ignore an inherited `PORT`, and this took production down
 * once already (2026-08-05).**
 *
 * Our base image is `factoriotools/factorio`, and its own image config sets
 * `PORT=34197` - Factorio's UDP game port. Read straight out of the registry:
 *
 *   ENV: PATH=... PORT=34197 RCON_PORT=27015 SAVES=/factorio/saves ...
 *
 * So a server that resolves its listen port from `process.env.PORT` binds 34197
 * in production. Cloudflare's runtime then waits `TIMEOUT_TO_GET_PORTS_MS`
 * (20s) for something to answer on 8080, gives up with "There has been an
 * internal error connecting to the port", and every render returns 502.
 *
 * That is exactly what shipped: #154 made the port overridable as `PORT` so
 * `shutdown.test.mjs` could bind a free port, and the deploy on 2026-08-05 took
 * the preview service down until the override was renamed to
 * `FMW_CONTAINER_PORT`.
 *
 * **Why the original local check missed it.** It was run as
 * `env -u PORT node server.mjs` - with `PORT` explicitly UNSET, which is the one
 * condition under which an inherited-variable bug cannot appear. A test that
 * clears the variable it is meant to be defending against proves nothing.
 * These two tests therefore SET `PORT` to the base image's own value.
 */

/** Spawn the server and resolve with everything it printed before exiting or listening. */
function runServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const done = (value) => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(
      () => reject(new Error(`server never settled; output was: ${out}`)),
      10_000,
    );
    const onData = (b) => {
      out += String(b);
      if (out.includes("listening") || out.includes("EADDRINUSE")) {
        clearTimeout(timer);
        done(out);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

test("an inherited PORT from the base image does not choose the listen port", async () => {
  // PORT=34197 is what factoriotools/factorio actually sets. FMW_CONTAINER_PORT=0
  // asks for an ephemeral port, so this never contends for a real one.
  const out = await runServer({ PORT: "34197", FMW_CONTAINER_PORT: "0" });

  assert.match(
    out,
    /listening on 0\b/,
    `expected the FMW_CONTAINER_PORT override to win over the inherited PORT; got: ${out}`,
  );
  assert.doesNotMatch(
    out,
    /34197/,
    "server bound the base image's Factorio game port - production would 502 on every render (#120)",
  );
});

test("the default listen port is 8080 even when PORT says otherwise", async () => {
  const out = await runServer({ PORT: "34197" });

  // Either it announced 8080, or it failed to bind 8080 because something else
  // on this machine holds it. Both prove it TARGETED 8080, which is the claim -
  // and neither depends on 8080 being free, so this is stable on a dev box.
  assert.ok(
    /listening on 8080\b/.test(out) || (/EADDRINUSE/.test(out) && /8080/.test(out)),
    `expected the server to target 8080 (the Worker's defaultPort and the Dockerfile's EXPOSE); got: ${out}`,
  );
  assert.doesNotMatch(
    out,
    /listening on 34197\b/,
    "server bound the base image's Factorio game port instead of 8080 (#120)",
  );
});
