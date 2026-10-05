import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreviewArgs,
  parseFactorioVersion,
  readFactorioVersion,
  renderPreview,
  RenderError,
} from "../render.mjs";

test("buildPreviewArgs assembles the factorio CLI", () => {
  const args = buildPreviewArgs({
    outPath: "/out/p.png",
    mgsPath: "/in/mgs.json",
    planet: "vulcanus",
    seed: 123456,
    size: 1024,
  });
  assert.deepEqual(args, [
    "--generate-map-preview",
    "/out/p.png",
    "--map-gen-settings",
    "/in/mgs.json",
    "--map-preview-planet",
    "vulcanus",
    "--map-gen-seed",
    "123456",
    "--map-preview-size",
    "1024",
  ]);
});

test("renderPreview writes a unique mgs file and returns PNG bytes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "prev-"));
  const fakeSpawn = (bin, args) => {
    // find the --generate-map-preview output path and write a fake PNG there
    const outPath = args[args.indexOf("--generate-map-preview") + 1];
    return {
      async done() {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return { code: 0, stderr: "" };
      },
    };
  };
  const png = await renderPreview(
    { mapGenSettings: { width: 0 }, planet: "nauvis", seed: 42, size: 1024 },
    { spawnFn: fakeSpawn, tmpDir: tmp, factorioBin: "/opt/factorio/bin/x64/factorio" },
  );
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
});

test("renderPreview throws RenderError with stderr tail on nonzero exit", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "prev-"));
  const fakeSpawn = () => ({
    async done() {
      return { code: 1, stderr: "Error: bad settings\n" };
    },
  });
  await assert.rejects(
    () =>
      renderPreview(
        { mapGenSettings: {}, planet: "nauvis", seed: 1, size: 1024 },
        { spawnFn: fakeSpawn, tmpDir: tmp, factorioBin: "/x" },
      ),
    (err) => err instanceof RenderError && /bad settings/.test(err.stderrTail),
  );
});

test("parseFactorioVersion reads the release, not the binary or map versions", () => {
  // The shape `factorio --version` prints. The other "version" lines are the
  // trap: a case-insensitive or unanchored match would return "64" or a map
  // format version instead of the game release.
  const out = [
    "Version: 2.1.17 (build 84123, linux64, headless, expansion)",
    "Binary version: 64",
    "Map input version: 1.0.0-0",
    "Map output version: 2.1.17-0",
  ].join("\n");
  assert.equal(parseFactorioVersion(out), "2.1.17");
  assert.equal(parseFactorioVersion("Binary version: 64\n"), null);
  assert.equal(parseFactorioVersion(""), null);
});

test("readFactorioVersion resolves null with the reason instead of rejecting", async () => {
  const failing = (_bin, _args, _opts, cb) => cb(new Error("spawn ENOENT"), "", "");
  assert.deepEqual(await readFactorioVersion("/nope", { execFileFn: failing }), {
    version: null,
    error: "spawn ENOENT",
  });

  const garbled = (_bin, _args, _opts, cb) => cb(null, "something else\n", "");
  const r = await readFactorioVersion("/x", { execFileFn: garbled });
  assert.equal(r.version, null);
  assert.match(r.error, /unrecognised --version output/);

  const ok = (_bin, args, _opts, cb) => {
    assert.deepEqual(args, ["--version"]);
    cb(null, "Version: 2.1.17 (build 1, linux64, headless, expansion)\n", "");
  };
  assert.deepEqual(await readFactorioVersion("/x", { execFileFn: ok }), { version: "2.1.17" });
});
