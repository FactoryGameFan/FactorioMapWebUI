import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { magnitudeColor, withDiffArtifacts, writeDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";

/**
 * The guard on the diagnostic itself.
 *
 * `test/diffArtifacts.ts` runs only when another test is already failing, which
 * is the worst possible time to discover it is broken: a writer that silently
 * produces nothing, or a black image, makes a real failure look clean and sends
 * the next person back to writing a one-off script. Same reasoning as
 * `test/mockLeakGuards.spec.ts` - machinery nothing else observes needs its own
 * observation (#252).
 *
 * The images are two pixels wide so every number below can be worked out by
 * hand, and every assertion reads the files back off disk through `decodePng`
 * rather than trusting the in-memory buffers. That closes the encoder too: a
 * wrong chunk length or CRC fails here instead of producing an artifact a
 * viewer refuses to open at the moment somebody needs it.
 */

const SPEC = "diffArtifactsSmoke";
const FILES = ["game.png", "ours.png", "diff-mask.png", "diff-magnitude.png", "stats.json"];

/** A 2x1 RGB image: pixel 0 is black, pixel 1 is whatever is passed. */
function twoPixels(second: readonly [number, number, number]): {
  width: number;
  height: number;
  rgb: Uint8Array;
} {
  return { width: 2, height: 1, rgb: Uint8Array.from([0, 0, 0, ...second]) };
}

function readStats(absoluteDir: string): Record<string, number> {
  return JSON.parse(readFileSync(join(absoluteDir, "stats.json"), "utf8")) as Record<
    string,
    number
  >;
}

function readPng(absoluteDir: string, name: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(absoluteDir, name)));
  return decodePng(bytes, (b) => new Uint8Array(inflateSync(b))).rgb;
}

describe("image diff artifacts", () => {
  it("counts one changed pixel and writes all five files", () => {
    const { dir, absoluteDir, stats } = writeDiffArtifacts({
      spec: SPEC,
      case: "one-pixel-delta-5",
      game: twoPixels([10, 20, 30]),
      ours: twoPixels([10, 20, 35]),
    });

    expect(dir).toBe(join("test-output", "preview-diffs", SPEC, "one-pixel-delta-5"));
    expect(stats.changedPixels).toBe(1);
    expect(stats.totalPixels).toBe(2);
    expect(stats.comparedPixels).toBe(2);
    expect(stats.maxChannelDelta).toBe(5);
    // One channel of six differs, by 5.
    expect(stats.meanAbsDelta).toBeCloseTo(5 / 6, 10);
    expect(stats.changedPercent).toBe(50);

    for (const name of FILES) {
      expect(existsSync(join(absoluteDir, name)), `${name} was not written`).toBe(true);
    }
    // stats.json on disk must agree with what the writer returned, since that
    // file is the one a later run greps rather than re-deriving.
    expect(readStats(absoluteDir).changedPixels).toBe(1);
    expect(readStats(absoluteDir).maxChannelDelta).toBe(5);
  });

  it("round-trips the two inputs through the PNG encoder unchanged", () => {
    const game = twoPixels([10, 20, 30]);
    const ours = twoPixels([10, 20, 35]);
    const { absoluteDir } = writeDiffArtifacts({
      spec: SPEC,
      case: "round-trip",
      game,
      ours,
    });
    expect([...readPng(absoluteDir, "game.png")]).toEqual([...game.rgb]);
    expect([...readPng(absoluteDir, "ours.png")]).toEqual([...ours.rgb]);
  });

  /**
   * **This is the assertion that rejects the prior art's curve.** M45's
   * `previewImageDiff` amplifies by `delta * 5`, which paints our commonest
   * interesting residual - a 1-count channel delta - as RGB(5,5,5), and that is
   * black on any screen. Our lifted log ramp puts delta 1 at 43% of the way up
   * viridis, which is RGB(40,128,140).
   */
  it("renders a 1-count delta visibly rather than as near-black", () => {
    const { absoluteDir } = writeDiffArtifacts({
      spec: SPEC,
      case: "one-count-delta",
      game: twoPixels([10, 20, 30]),
      ours: twoPixels([10, 20, 31]),
    });
    expect(readStats(absoluteDir).maxChannelDelta).toBe(1);

    const mask = readPng(absoluteDir, "diff-mask.png");
    expect([...mask.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...mask.subarray(3, 6)]).toEqual([255, 0, 255]);

    const magnitude = readPng(absoluteDir, "diff-magnitude.png");
    expect([...magnitude.subarray(0, 3)]).toEqual([0, 0, 0]);
    const lit = Math.max(magnitude[3], magnitude[4], magnitude[5]);
    expect(lit, "a delta of 1 came out too dark to see - check magnitudeColor").toBeGreaterThan(
      100,
    );
  });

  it("keeps larger deltas separable instead of saturating", () => {
    // The `delta * 5` curve clamps at 51, so 51, 128 and 255 are all pure
    // white under it. Ours stays monotone and distinct across that range.
    const brightness = (d: number): number => magnitudeColor(d).reduce((a, b) => a + b, 0);
    expect(magnitudeColor(0)).toEqual([0, 0, 0]);
    expect(brightness(1)).toBeLessThan(brightness(51));
    expect(brightness(51)).toBeLessThan(brightness(128));
    expect(brightness(128)).toBeLessThan(brightness(255));
    expect(magnitudeColor(255)).toEqual([253, 231, 37]);
  });

  it("excludes ignored pixels from every count and paints them navy", () => {
    const { absoluteDir, stats } = writeDiffArtifacts({
      spec: SPEC,
      case: "ignored-pixel",
      game: twoPixels([10, 20, 30]),
      ours: twoPixels([10, 20, 35]),
      // Ignore the one pixel that differs.
      ignore: (i) => i === 1,
    });
    expect(stats.totalPixels).toBe(2);
    expect(stats.ignoredPixels).toBe(1);
    expect(stats.comparedPixels).toBe(1);
    expect(stats.changedPixels).toBe(0);
    expect(stats.maxChannelDelta).toBe(0);
    expect(stats.meanAbsDelta).toBe(0);

    const mask = readPng(absoluteDir, "diff-mask.png");
    expect([...mask.subarray(3, 6)]).toEqual([0, 0, 80]);
  });

  it("writes nothing when the assertions pass", () => {
    const dir = join("test-output", "preview-diffs", SPEC, "green");
    const absoluteDir = join(import.meta.dirname, "..", dir);
    rmSync(absoluteDir, { recursive: true, force: true });

    withDiffArtifacts(
      { spec: SPEC, case: "green", game: twoPixels([1, 2, 3]), ours: twoPixels([9, 9, 9]) },
      () => {
        expect(1).toBe(1);
      },
    );

    // The two images DO differ. Nothing is written anyway, because no assertion
    // failed - that is the whole cost model.
    expect(existsSync(absoluteDir)).toBe(false);
  });

  it("names the artifact directory in the failure message and keeps the original", () => {
    let caught: Error | undefined;
    try {
      withDiffArtifacts(
        { spec: SPEC, case: "red", game: twoPixels([10, 20, 30]), ours: twoPixels([10, 20, 35]) },
        () => {
          expect(237).toBeLessThan(200);
        },
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught, "withDiffArtifacts swallowed the failure").toBeDefined();
    // The scalar is still the headline; the directory is the footnote.
    expect(caught?.message).toContain("237");
    expect(caught?.message).toContain(join("test-output", "preview-diffs", SPEC, "red"));
    expect(caught?.message).toContain("maxChannelDelta 5");
    expect(
      existsSync(
        join(import.meta.dirname, "..", "test-output", "preview-diffs", SPEC, "red", "stats.json"),
      ),
    ).toBe(true);
  });
});
