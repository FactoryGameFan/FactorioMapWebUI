/**
 * Turn a failed image comparison into something you can look at.
 *
 * `test/previewAgreement.spec.ts` compares a 1024x1024 render against the
 * game's own preview and asserts scalars. When one of those bounds trips, the
 * entire report is `expected 237 to be less than 200`. That says a render
 * moved. It does not say WHERE, BY HOW MUCH PER CHANNEL, or IN WHAT SHAPE - and
 * in this repo the shape has repeatedly been the answer. The Fulgora
 * `Math.round` bug was 35 percentage points of whole-image agreement and was
 * found by asking which pixels were wrong; "the residual is boundary-exclusive"
 * and "the residual is west" are both statements about location. Until now the
 * only way to see any of that was a one-off script, thrown away each time
 * (#252).
 *
 * So on failure - and ONLY on failure - four files land in a gitignored
 * directory that the assertion message names:
 *
 *   test-output/preview-diffs/<spec>/<case>/
 *     game.png            the reference, re-encoded
 *     ours.png            what we rendered
 *     diff-mask.png       where, ignoring magnitude
 *     diff-magnitude.png  how much, false-coloured
 *     stats.json          the numbers, greppable across runs
 *
 * ## Nothing here asserts anything
 *
 * This module changes no bound and relaxes no comparison. `withDiffArtifacts`
 * runs the caller's `expect` calls untouched and re-throws the SAME error
 * object with a line appended to its message. If the assertions pass, not one
 * byte is written and not one pixel is walked - `previewAgreement.spec.ts` is
 * among the heaviest files in the suite, and a green run must stay free.
 *
 * Wrapping the assertions rather than re-testing the bound is deliberate. The
 * obvious alternative, `if (differing >= 200) writeDiffArtifacts(...)`, states
 * every bound twice, and the second copy is free to drift from the first
 * without anything noticing. Catching the thrown `AssertionError` means the
 * artifacts appear exactly when an assertion actually failed, by construction.
 *
 * ## Why diff-magnitude.png is not `delta * 5`
 *
 * M45's FactMapGen writes the same four files (`preview_parity_test.go`), and
 * its amplification is per-channel absolute delta times five, clamped to 255.
 * That curve is wrong for our failure mode in both directions: our interesting
 * differences are 1-count channel deltas, which it renders as RGB(5,5,5) -
 * indistinguishable from black, in the exact case we most need to see - and it
 * saturates at delta 51, so everything above that looks identical.
 *
 * Both questions get their own file instead, because the cost is one more PNG:
 *
 *  - `diff-mask.png` answers "what SHAPE is the residual", which is the
 *    question this repo keeps asking. Any pixel differing at all is magenta,
 *    whatever the magnitude, so a 1-count delta cannot hide.
 *  - `diff-magnitude.png` keeps the magnitude the mask throws away, on a log
 *    ramp lifted off the floor (see `magnitudeColor`) so delta 1 is already 43%
 *    of the way up the palette rather than 0.4% of the way up a linear one.
 *
 * `test/diffArtifacts.spec.ts` pins that: it builds a two-pixel image differing
 * by exactly 1 in one channel and asserts the magnitude image comes back with a
 * channel above 100. The `delta * 5` curve would return 5 there and fail.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { encodePng } from "./oracle/encodePng";

/** Row-major RGB, 3 bytes per pixel - what `decodePng` returns. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** Row-major RGBA, 4 bytes per pixel - what the render request returns. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

/**
 * Either layout. Callers hand over whatever they already have; the conversion
 * happens on the failure path only, so a green run never pays for it.
 */
export type ComparableImage = RgbImage | RgbaImage;

/**
 * The numbers, written to `stats.json` and summarised in the assertion message.
 *
 * `changedPercent` is a share of `comparedPixels`, not of `totalPixels`, so it
 * matches the ratio the spec's own bound is written against. With no `ignore`
 * predicate the two counts are equal and the distinction is moot.
 */
export interface DiffStats {
  readonly spec: string;
  readonly case: string;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  /** Pixels the caller's `ignore` predicate excluded, e.g. the game's enemy bases. */
  readonly ignoredPixels: number;
  readonly comparedPixels: number;
  readonly changedPixels: number;
  readonly changedPercent: number;
  /** Largest single-channel absolute difference anywhere in the compared set. */
  readonly maxChannelDelta: number;
  /** Mean absolute channel difference over every compared channel, changed or not. */
  readonly meanAbsDelta: number;
  readonly legend: string;
}

export interface DiffTarget {
  /** Spec name, used as a directory. No extension, e.g. `previewAgreement`. */
  readonly spec: string;
  /** Case name within the spec, used as a directory, e.g. `nauvis-terrain`. */
  readonly case: string;
  readonly game: ComparableImage;
  readonly ours: ComparableImage;
  /**
   * Pixels the comparison deliberately does not ask about, by linear index.
   * The Nauvis case excludes the game's enemy bases; the Vulcanus one excludes
   * rocks and cliffs. Excluded pixels are drawn navy in the mask so a reader
   * can tell "we agree here" from "we never looked here".
   */
  readonly ignore?: (index: number) => boolean;
}

/** Repo-relative, so the assertion message is short and the path is pasteable. */
const ROOT_RELATIVE = join("test-output", "preview-diffs");
const REPO_ROOT = join(import.meta.dirname, "..");

const MASK_CHANGED: readonly [number, number, number] = [255, 0, 255];
const MASK_IGNORED: readonly [number, number, number] = [0, 0, 80];

/**
 * Viridis stops. Chosen because it is monotone in luminance, so "brighter means
 * a bigger delta" holds even printed in grey, and because it never passes
 * through pure black - which is reserved here for "no difference at all".
 */
const MAGNITUDE_STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/**
 * The floor that makes the low end steep. A delta of 1 enters the palette at
 * 35% rather than at 0, so the smallest difference we can have is immediately
 * visible; the remaining 65% is log-spread over 1..255 so larger deltas still
 * separate from each other.
 */
const MAGNITUDE_FLOOR = 0.35;

const LEGEND =
  "diff-mask.png: magenta = differs, black = agrees, navy = excluded by the test. " +
  "diff-magnitude.png: black = 0, then viridis over log2(1 + maxChannelDelta) " +
  "lifted to start 35% up the ramp, so delta 1 is already clearly visible.";

/** Black at delta 0, then a lifted log ramp through viridis. */
export function magnitudeColor(delta: number): [number, number, number] {
  if (delta <= 0) return [0, 0, 0];
  // log2(1 + 255) is exactly 8, so delta 255 lands on the last stop.
  const lifted = MAGNITUDE_FLOOR + (1 - MAGNITUDE_FLOOR) * (Math.log2(1 + delta) / 8);
  const t = Math.min(1, Math.max(0, lifted)) * (MAGNITUDE_STOPS.length - 1);
  const i = Math.min(MAGNITUDE_STOPS.length - 2, Math.floor(t));
  const f = t - i;
  const a = MAGNITUDE_STOPS[i];
  const b = MAGNITUDE_STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function toRgb(image: ComparableImage): Uint8Array {
  if ("rgb" in image) return image.rgb;
  const { width, height, rgba } = image;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

/**
 * Write the four files and return where they went.
 *
 * Exported for the smoke test in `test/diffArtifacts.spec.ts`. Specs should
 * call `withDiffArtifacts` instead, so the write cannot happen on a green run.
 */
export function writeDiffArtifacts(target: DiffTarget): {
  /** Repo-relative path, the form that goes in the assertion message. */
  readonly dir: string;
  readonly absoluteDir: string;
  readonly stats: DiffStats;
} {
  const { width, height } = target.game;
  if (target.ours.width !== width || target.ours.height !== height) {
    throw new Error(
      `size mismatch: game ${String(width)}x${String(height)}, ` +
        `ours ${String(target.ours.width)}x${String(target.ours.height)}`,
    );
  }
  const game = toRgb(target.game);
  const ours = toRgb(target.ours);
  const total = width * height;

  const mask = new Uint8Array(total * 3);
  const magnitude = new Uint8Array(total * 3);
  let ignored = 0;
  let changed = 0;
  let maxChannelDelta = 0;
  let sumAbsDelta = 0;

  for (let i = 0; i < total; i++) {
    if (target.ignore?.(i) === true) {
      ignored++;
      mask.set(MASK_IGNORED, i * 3);
      continue;
    }
    const dr = Math.abs(game[i * 3] - ours[i * 3]);
    const dg = Math.abs(game[i * 3 + 1] - ours[i * 3 + 1]);
    const db = Math.abs(game[i * 3 + 2] - ours[i * 3 + 2]);
    sumAbsDelta += dr + dg + db;
    const worst = Math.max(dr, dg, db);
    if (worst > maxChannelDelta) maxChannelDelta = worst;
    if (worst > 0) {
      changed++;
      mask.set(MASK_CHANGED, i * 3);
      magnitude.set(magnitudeColor(worst), i * 3);
    }
  }

  const compared = total - ignored;
  const stats: DiffStats = {
    spec: target.spec,
    case: target.case,
    width,
    height,
    totalPixels: total,
    ignoredPixels: ignored,
    comparedPixels: compared,
    changedPixels: changed,
    changedPercent: compared === 0 ? 0 : (changed / compared) * 100,
    maxChannelDelta,
    meanAbsDelta: compared === 0 ? 0 : sumAbsDelta / (compared * 3),
    legend: LEGEND,
  };

  const dir = join(ROOT_RELATIVE, target.spec, target.case);
  const absoluteDir = join(REPO_ROOT, dir);
  // Cleared first. A stale image left by an earlier run, sitting beside a fresh
  // stats.json, is exactly the trap a diagnostic must not set.
  rmSync(absoluteDir, { recursive: true, force: true });
  mkdirSync(absoluteDir, { recursive: true });

  // Level 3 rather than the default 6: these are four megabyte-scale images on
  // a path that is already reporting a failure, and nobody archives them.
  const png = (rgb: Uint8Array): Uint8Array =>
    encodePng({ width, height, rgb }, (b) => deflateSync(b, { level: 3 }));

  writeFileSync(join(absoluteDir, "game.png"), png(game));
  writeFileSync(join(absoluteDir, "ours.png"), png(ours));
  writeFileSync(join(absoluteDir, "diff-mask.png"), png(mask));
  writeFileSync(join(absoluteDir, "diff-magnitude.png"), png(magnitude));
  writeFileSync(join(absoluteDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);

  return { dir, absoluteDir, stats };
}

/**
 * Run `assertions`. On failure, write the artifacts and re-throw the same error
 * with the directory named in its message.
 *
 * The error object is mutated rather than replaced so vitest keeps the actual
 * and expected values it already computed - the scalar is still the headline,
 * the artifacts are the footnote. If the writer itself throws, the original
 * failure still propagates and the message says the writer failed, because
 * losing a real finding to a broken diagnostic would be the worst outcome here.
 */
export function withDiffArtifacts(target: DiffTarget, assertions: () => void): void {
  try {
    assertions();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    let note: string;
    try {
      const { dir, stats } = writeDiffArtifacts(target);
      note =
        `Diff artifacts: ${dir}\n` +
        `  changed ${String(stats.changedPixels)} of ${String(stats.comparedPixels)} compared ` +
        `pixels (${stats.changedPercent.toFixed(4)}%), ` +
        `maxChannelDelta ${String(stats.maxChannelDelta)}, ` +
        `meanAbsDelta ${stats.meanAbsDelta.toFixed(4)}`;
    } catch (writerError) {
      note = `Diff artifacts NOT written, the writer itself failed: ${String(writerError)}`;
    }
    error.message = `${error.message}\n\n${note}`;
    throw error;
  }
}
