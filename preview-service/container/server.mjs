import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { renderPreview, RenderError } from "./render.mjs";

// 8080 is what the Worker's container binding expects; the override exists so
// `test/shutdown.test.mjs` can start a real server on a free port.
const PORT = Number(process.env.PORT ?? 8080);
const FACTORIO_BIN = process.env.FACTORIO_BIN ?? "/opt/factorio/bin/x64/factorio";
const PLANETS = new Set(["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"]);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 262144) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/render") {
    try {
      const body = await readJson(req);
      if (!PLANETS.has(body.planet) || typeof body.seed !== "number") {
        res.writeHead(400).end("bad request");
        return;
      }
      const png = await renderPreview(
        {
          mapGenSettings: body.mapGenSettings,
          planet: body.planet,
          seed: body.seed,
          size: body.size ?? 1024,
        },
        { tmpDir: tmpdir(), factorioBin: FACTORIO_BIN },
      );
      res.writeHead(200, { "content-type": "image/png" }).end(png);
    } catch (err) {
      const tail = err instanceof RenderError ? err.stderrTail : String(err);
      console.error("render failed:", tail);
      res.writeHead(500).end("render failed");
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => console.log(`preview container listening on ${PORT}`));

/**
 * **Node runs as PID 1 here, and PID 1 ignores signals it has no handler for.**
 * The Dockerfile's `ENTRYPOINT ["node", "/app/server.mjs"]` is exec form, so
 * there is no shell and no init between PID 1 and this process. Linux gives PID
 * 1 no default signal dispositions, so without the handler below a `SIGTERM` is
 * silently discarded rather than terminating the process.
 *
 * That is not academic: it is what keeps this container awake (#120). When the
 * sleep timer expires, `@cloudflare/containers` calls `stop()`, which sends
 * **SIGTERM and never escalates to SIGKILL** - its own source says so at the
 * `sleepAfter` declaration: "The signal sent to the container by default is a
 * SIGTERM. The container won't get a SIGKILL if this threshold is triggered."
 * So an ignored SIGTERM means the instance is never shut down by the SDK at all
 * and simply lingers until the platform reclaims it, which measured at ~8.5
 * minutes against a configured `sleepAfter` of 20s.
 *
 * `server.close()` stops accepting new connections and waits for in-flight
 * responses, so a render already streaming to the Worker still completes - which
 * matters because the Worker must drain the body for its own inflight counter to
 * decrement (see the `sleepAfter` note in CLAUDE.md).
 */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`);
    server.close(() => process.exit(0));
  });
}
