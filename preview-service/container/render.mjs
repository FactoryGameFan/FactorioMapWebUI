import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

export class RenderError extends Error {
  constructor(message, stderrTail) {
    super(message);
    this.name = "RenderError";
    this.stderrTail = stderrTail ?? "";
  }
}

export function buildPreviewArgs({ outPath, mgsPath, planet, seed, size }) {
  return [
    "--generate-map-preview",
    outPath,
    "--map-gen-settings",
    mgsPath,
    "--map-preview-planet",
    planet,
    "--map-gen-seed",
    String(seed),
    "--map-preview-size",
    String(size),
  ];
}

// Default spawn wrapper: runs the binary, resolves { code, stderr }.
export function nodeSpawn(bin, args) {
  return {
    async done() {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolve) => {
        const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
        child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
      });
    },
  };
}

export async function renderPreview(req, { spawnFn = nodeSpawn, tmpDir, factorioBin }) {
  const work = await mkdtemp(join(tmpDir, "render-"));
  const mgsPath = join(work, "mgs.json");
  const outPath = join(work, "preview.png");
  try {
    await writeFile(mgsPath, JSON.stringify(req.mapGenSettings));
    const args = buildPreviewArgs({
      outPath,
      mgsPath,
      planet: req.planet,
      seed: req.seed,
      size: req.size,
    });
    const { code, stderr } = await spawnFn(factorioBin, args).done();
    if (code !== 0) {
      throw new RenderError(`factorio exited ${code}`, stderr.slice(-2000));
    }
    return await readFile(outPath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Pulls the release out of `factorio --version`, whose first line reads
 * `Version: 2.1.17 (build 84123, linux64, headless, expansion)`. Anchored to
 * the start of a line and to a capital V on purpose: the same output carries
 * `Binary version: 64` and `Map input version: ...`, and a looser match would
 * report one of those instead. Returns null for anything unrecognised.
 */
export function parseFactorioVersion(stdout) {
  const m = /^Version: (\d+\.\d+\.\d+)\b/m.exec(stdout);
  return m ? m[1] : null;
}

/**
 * Asks the binary which Factorio it is, once, so `/render` can say which game
 * produced each PNG (the `x-factorio-version` response header).
 *
 * **Why the binary and not a variable baked into the image.** The Worker
 * caches renders under its own `FACTORIO_VERSION`, and during a container
 * rollout the new Worker is live while old-image instances are still answering
 * (Cloudflare's rollouts doc: "new Worker code can still reach container
 * instances on the previous image until the rollout finishes"). The header is
 * what lets the Worker refuse to file an old game's render under the new
 * game's key, so it has to come from the thing that rendered. An ENV in the
 * Dockerfile would be a fourth hand-edited copy of the version, and Renovate
 * bumps only the FROM tag; asking the binary needs no copy at all.
 *
 * Never rejects: a binary that cannot be run or prints something unexpected
 * resolves `{ version: null, error }`, the server omits the header, and the
 * Worker then declines to cache - the safe direction.
 */
export function readFactorioVersion(bin, { execFileFn } = {}) {
  return new Promise((resolve) => {
    const run = async () => {
      const exec = execFileFn ?? (await import("node:child_process")).execFile;
      exec(bin, ["--version"], { timeout: 30_000 }, (err, stdout) => {
        if (err) {
          resolve({ version: null, error: err.message });
          return;
        }
        const version = parseFactorioVersion(String(stdout));
        resolve(
          version
            ? { version }
            : {
                version: null,
                error: `unrecognised --version output: ${String(stdout).slice(0, 200)}`,
              },
        );
      });
    };
    run().catch((err) => resolve({ version: null, error: String(err) }));
  });
}
