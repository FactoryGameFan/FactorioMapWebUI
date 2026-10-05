import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFactorioVersion } from "../render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const svcDir = join(here, "..");
const fixtures = join(here, "../../../test/fixtures");
const IMAGE = "fmw-preview-test:latest";

function isPng(buf) {
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

test(
  "image builds and renders a valid PNG for Nauvis and a non-Nauvis planet",
  { timeout: 600000 },
  () => {
    execFileSync("docker", ["build", "--platform", "linux/amd64", "-t", IMAGE, svcDir], {
      stdio: "inherit",
    });

    // factorio writes log output to stdout, so `--generate-map-preview /dev/stdout`
    // does not stream a clean PNG. Render to a mounted output dir and read the file
    // instead (this mirrors how server.mjs renders to a temp file at runtime).
    for (const planet of ["nauvis", "vulcanus"]) {
      const outDir = mkdtempSync(join(tmpdir(), "fmw-preview-"));
      chmodSync(outDir, 0o777); // the container's factorio user must be able to write here
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "-v",
          `${fixtures}:/in:ro`,
          "-v",
          `${outDir}:/out`,
          "--entrypoint",
          "/opt/factorio/bin/x64/factorio",
          IMAGE,
          "--generate-map-preview",
          `/out/${planet}.png`,
          "--map-gen-settings",
          "/in/map-gen-settings.default-nauvis.dump.json",
          "--map-preview-planet",
          planet,
          "--map-gen-seed",
          "123456",
          "--map-preview-size",
          "256",
        ],
        { stdio: "inherit" },
      );
      const png = readFileSync(join(outDir, `${planet}.png`));
      assert.ok(isPng(png), `expected a PNG for ${planet}`);
    }

    // server.mjs sends `x-factorio-version` from this same parse of the real
    // binary's output, and the Worker refuses to cache a render without it. A
    // Factorio release that changed the line's shape would leave every render
    // uncached with nothing failing, so check the parse against the binary the
    // image actually ships, and that it agrees with the FROM tag.
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--entrypoint",
        "/opt/factorio/bin/x64/factorio",
        IMAGE,
        "--version",
      ],
      { encoding: "utf8" },
    );
    const dockerfile = readFileSync(join(svcDir, "Dockerfile"), "utf8");
    const [, tag] = /^FROM\s+\S+?:(\S+?)@sha256:/m.exec(dockerfile);
    assert.equal(parseFactorioVersion(out), tag, `unexpected --version output: ${out}`);
  },
);
