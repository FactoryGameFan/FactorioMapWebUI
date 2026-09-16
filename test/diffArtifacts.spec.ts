import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  artifactPaths,
  magnitudeColor,
  withDiffArtifacts,
  writeDiffArtifacts,
} from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { encodePng } from "./oracle/encodePng";

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
  // This spec calls `writeDiffArtifacts` DIRECTLY, so unlike every real caller
  // it writes on a green run. Without this the suite leaves five populated
  // directories behind and contradicts CLAUDE.md's "a green run writes
  // nothing" - a reader who has just read that line sees them and reasonably
  // concludes something failed.
  afterAll(() => {
    rmSync(artifactPaths(SPEC, "").absoluteDir, { recursive: true, force: true });
  });

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

    // Navy in the MAGNITUDE image too, not black. Black there means "agrees",
    // so an excluded pixel left black makes the image assert agreement over a
    // region the test never looked at - it would have claimed agreement over
    // the 1,189 enemy-base pixels the Nauvis comparison masked until the
    // 2026-09-14 re-capture. That is the confusion `diff-mask.png` exists to
    // remove.
    const magnitude = readPng(absoluteDir, "diff-magnitude.png");
    expect([...magnitude.subarray(3, 6)]).toEqual([0, 0, 80]);
    // The compared-and-agreeing pixel stays black, so the two states remain
    // distinguishable rather than both becoming navy.
    expect([...magnitude.subarray(0, 3)]).toEqual([0, 0, 0]);
  });

  /**
   * The guard on `encodePng`'s own claim.
   *
   * That header says the `decodePng` round-trip makes "a mangled chunk length
   * or a wrong CRC a test failure rather than a corrupt artifact". It was false
   * when written: `decodePng` advanced by `12 + len` and never read the four
   * CRC bytes, so breaking `chunk()` left every test here green while every
   * artifact the feature writes would be rejected by Preview and Chrome - at
   * the one moment somebody is already looking at one because something else
   * broke. `decodePng` verifies now; this keeps that from silently lapsing.
   */
  it("rejects a PNG whose chunk CRC is wrong", () => {
    const good = encodePng(twoPixels([10, 20, 30]), (b) => deflateSync(b));
    expect(() => decodePng(good, (b) => new Uint8Array(inflateSync(b)))).not.toThrow();

    // IHDR is the first chunk: 8-byte signature, 4 length, 4 type, 13 payload,
    // then its CRC. Flip one bit of it.
    const bad = good.slice();
    bad[8 + 4 + 4 + 13] ^= 0xff;
    expect(() => decodePng(bad, (b) => new Uint8Array(inflateSync(b)))).toThrow(/bad CRC in IHDR/);

    // And a corrupted PAYLOAD, which is the failure a length-only check misses.
    const corruptPayload = good.slice();
    corruptPayload[8 + 8] ^= 0xff;
    expect(() => decodePng(corruptPayload, (b) => new Uint8Array(inflateSync(b)))).toThrow(
      /bad CRC/,
    );
  });

  it("rejects a buffer that is shorter than its declared size", () => {
    // `writeDiffArtifacts` already compares the two DECLARED sizes. This is the
    // other half: the declared size against the bytes actually handed over. A
    // short buffer used to be zero-filled, producing an artifact black over the
    // tail of the frame and a changed count near the compared count - a picture
    // of a catastrophic regression that is really a wrong-sized argument.
    expect(() =>
      writeDiffArtifacts({
        spec: SPEC,
        case: "short-buffer",
        game: twoPixels([10, 20, 30]),
        ours: { width: 2, height: 1, rgba: new Uint8ClampedArray(4) },
      }),
    ).toThrow(/rgba buffer too short/);
  });

  it("writes nothing when the assertions pass", () => {
    // Asked for, not rebuilt - see `artifactPaths`. Hand-building it here is
    // what would let this test go vacuously green if the writer moved.
    const { absoluteDir } = artifactPaths(SPEC, "green");
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

  /**
   * #303 finding 1: `() => void` accepts `() => Promise<void>` without
   * complaint, so a future comparison written `async () => { expect(await
   * x()).toBe(y); }` would compile, return a pending promise the `try/catch`
   * never sees throw, pass green, and write no artifacts - the rejection
   * would surface later as an unhandled rejection blamed on a different test.
   * The cast below exists to defeat the type-level guard on purpose, standing
   * in for the `any`-typed or dynamically constructed callback the runtime
   * check is there to catch.
   */
  it("throws synchronously when the assertions callback is async, instead of passing green", () => {
    let settled = false;
    const asyncAssertions = (async () => {
      await Promise.resolve();
      settled = true;
    }) as unknown as () => void;

    expect(() =>
      withDiffArtifacts(
        {
          spec: SPEC,
          case: "async-guard",
          game: twoPixels([1, 2, 3]),
          ours: twoPixels([1, 2, 3]),
        },
        asyncAssertions,
      ),
    ).toThrow(/synchronous/i);

    // A caller bug, not a render diff - nothing belongs on disk for it.
    expect(existsSync(artifactPaths(SPEC, "async-guard").absoluteDir)).toBe(false);
    // The guard fires before the callback's promise has had a chance to
    // settle, proving it does not wait around for it.
    expect(settled).toBe(false);
  });

  /**
   * CodeRabbit review on #426: `isThenable` only checked `typeof value ===
   * "object"`. A function is `typeof "function"`, not `"object"`, so a
   * callback that bypasses `NotThenable` through a cast and returns a
   * function carrying a callable `then` property sailed through undetected,
   * silently defeating the guard the previous test exercises.
   */
  it("throws when the assertions callback returns a function-valued thenable", () => {
    // `no-thenable` exists to catch an ACCIDENTAL thenable; this one is
    // deliberate, standing in for a value an any-typed or cast callback could
    // genuinely return.
    const fakeThenable: { (): void; then?: () => void } = () => {};
    // eslint-disable-next-line unicorn/no-thenable
    fakeThenable.then = () => {};
    const assertions = (() => fakeThenable) as unknown as () => void;

    expect(() =>
      withDiffArtifacts(
        {
          spec: SPEC,
          case: "function-thenable-guard",
          game: twoPixels([1, 2, 3]),
          ours: twoPixels([1, 2, 3]),
        },
        assertions,
      ),
    ).toThrow(/synchronous/i);
  });

  /**
   * #303 finding 2: `artifactPaths` used to join `spec`/`case` straight into a
   * path. `join()` normalises ".." away, so a traversal segment resolved
   * outside `test-output/` and was then deleted recursively with `force:
   * true` - no error, no trace.
   */
  it("rejects a traversal segment in spec or case before building a path", () => {
    expect(() => artifactPaths("..", "case")).toThrow(/unsafe spec/);
    expect(() => artifactPaths(SPEC, "..")).toThrow(/unsafe case/);
    expect(() => artifactPaths(SPEC, "../../etc")).toThrow(/unsafe case/);
    expect(() => artifactPaths(SPEC, "nested/traversal")).toThrow(/unsafe case/);
  });

  /**
   * CodeRabbit review on #426: "." passes SAFE_PATH_SEGMENT and isn't caught
   * by `.includes("..")`, and `caseName` is allowed to be empty, so
   * `artifactPaths(".", "")` used to collapse to `join(ROOT_RELATIVE, ".",
   * "")` = ROOT_RELATIVE itself - the whole preview-diffs root, not one
   * case's subdirectory.
   */
  it("rejects a bare '.' spec or case, which would otherwise collapse to the artifacts root", () => {
    expect(() => artifactPaths(".", "")).toThrow(/unsafe spec/);
    expect(() => artifactPaths(SPEC, ".")).toThrow(/unsafe case/);
  });

  /**
   * `writeDiffArtifacts` calls `artifactPaths` before it calls `rmSync` (see
   * the two calls in that order in the source), so a thrown "unsafe case"
   * error is itself the entire proof `rmSync` was never reached -
   * `rmSync(..., { force: true })` never throws, on a missing path or any
   * other, so this specific message can only come from the guard running
   * first. A direct `vi.spyOn(fs, "rmSync")` was tried and rejected: Vitest
   * refuses it with "Module namespace is not configurable in ESM" for a Node
   * builtin, which is a fact about the module system rather than about this
   * guard.
   *
   * An earlier version of this test also asserted `existsSync` on a
   * hand-built path, meant to show nothing landed on disk. Found vacuous by
   * review (claude[bot] on #426): it checked
   * `artifactPaths(SPEC, "escaped-via-writeDiffArtifacts").absoluteDir` -
   * dropping the leading `"../"` the test actually passes as `case` - so it
   * named a directory neither the guarded code nor the OLD unguarded code
   * ever wrote to, and `existsSync` on it returned `false` unconditionally.
   * Removed rather than fixed, per the file's own warning just above
   * `artifactPaths` about hand-built paths drifting from what is actually
   * written: the throw above is the real assertion.
   */
  it("never calls rmSync when a traversal case name reaches writeDiffArtifacts", () => {
    expect(() =>
      writeDiffArtifacts({
        spec: SPEC,
        case: "../escaped-via-writeDiffArtifacts",
        game: twoPixels([1, 2, 3]),
        ours: twoPixels([1, 2, 3]),
      }),
    ).toThrow(/unsafe case/);
  });
});
