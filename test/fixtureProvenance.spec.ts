import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * Every oracle fixture must declare which Factorio version its ground truth was
 * captured from.
 *
 * The versions are recorded in `test/fixtures/PROVENANCE.json` rather than
 * inside the fixtures because several fixtures are verbatim copies of the
 * game's own JSON structures - `autoplace-can-be-disabled.dump.json` is a flat
 * dict keyed by control name, and `catalog.spec.ts` asserts its key set matches
 * `CONTROL_CATALOG` exactly. A metadata key added there would be data
 * pollution, and CLAUDE.md holds fixtures to be read-only ground truth.
 *
 * What this guards: a new fixture cannot be committed without stating where it
 * came from, and a deleted one cannot leave a dangling claim behind. It does
 * NOT check the recorded version against the installed binary - that needs a
 * Factorio install, so it lives in `pnpm refs:sync --fixtures` instead, out of
 * the always-on suite.
 */

const DIR = "test/fixtures";
const MANIFEST = `${DIR}/PROVENANCE.json`;

interface Entry {
  factorioVersion: string;
  evidence: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  maxUnknown?: number;
  fixtures: Record<string, Entry>;
  notFixtures?: Record<string, string>;
};

const fixtures = manifest.fixtures;
const notFixtures = manifest.notFixtures ?? {};

/**
 * Every file is named, and nothing is filtered by extension.
 *
 * Until 2026-08-18 this listed `.json` and `.png` only. Ten `.txt` map exchange
 * strings sat in the same directory with no entry and no way to get one, and
 * eight of them are read as ground truth by `decode.spec.ts`, `encode.spec.ts`
 * and `jsonExport.spec.ts` (#240). An allowlist says nothing about what it does
 * not list, which is how those eight went unrecorded for a month. So the walk
 * takes every file, and a file that is deliberately not ground truth is
 * declared in `notFixtures` with a reason. That costs one sentence, which is
 * what `evidence` costs too.
 *
 * Two names are skipped, and both are files no person put here. `.DS_Store`
 * appears in any directory a Finder window has opened. Explorer writes
 * `Thumbs.db` into any folder it has made thumbnails for, and this folder holds
 * `.png` fixtures, so that is a real risk and not a hypothetical one. Demanding
 * an entry for either would fail on the machine that can fix it and pass in CI.
 * A dot-prefixed name is skipped whole, directories included.
 */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const lower = name.toLowerCase();
    if (name.startsWith(".") || lower === "thumbs.db" || lower === "desktop.ini") continue;
    // Joined by hand rather than with `path.join`, so a Windows run and a macOS
    // run produce the same key for the same file. The manifest is committed,
    // and a backslash in it would be a permanent diff. factorio-oracle's
    // independent checker keys this same manifest the same way.
    const key = prefix ? `${prefix}/${name}` : name;
    if (entry.isDirectory()) out.push(...walk(`${dir}/${name}`, key));
    else if (key !== "PROVENANCE.json") out.push(key);
  }
  return out.sort();
}

const onDisk = walk(DIR);

describe("fixture provenance manifest", () => {
  it("names every file in the fixture directory", () => {
    const unnamed = onDisk.filter((f) => !(f in fixtures) && !(f in notFixtures));
    expect(unnamed, "files with no provenance entry and no notFixtures reason").toEqual([]);
  });

  it("has no entries for files that no longer exist", () => {
    const present = new Set(onDisk);
    const named = [...Object.keys(fixtures), ...Object.keys(notFixtures)].sort();
    const dangling = named.filter((f) => !present.has(f));
    expect(dangling, "PROVENANCE.json names with no file on disk").toEqual([]);
  });

  it("names no file as both a fixture and a non-fixture", () => {
    const both = Object.keys(fixtures).filter((f) => f in notFixtures);
    expect(both, "named in fixtures and in notFixtures at once").toEqual([]);
  });

  it("records a well-formed version and evidence for each entry", () => {
    for (const [name, entry] of Object.entries(fixtures)) {
      expect(entry.factorioVersion, `${name}: factorioVersion`).toMatch(
        /^(\d+\.\d+\.\d+|unknown)$/,
      );
      expect(entry.evidence.length, `${name}: evidence must be non-empty`).toBeGreaterThan(0);
    }
  });

  // A reason is the whole point of `notFixtures`. Without one it is a second
  // allowlist, just spelled out file by file.
  it("gives a reason for every non-fixture", () => {
    const unexplained = Object.entries(notFixtures)
      .filter(([, why]) => why.trim().length === 0)
      .map(([name]) => name);
    expect(unexplained, "notFixtures entries with no reason").toEqual([]);
  });

  /**
   * A ratchet, not a correctness bound. `unknown` means nobody wrote the
   * capture version down, which only a re-capture against a known binary can
   * fix. One such fixture exists today
   * (`autoplace-can-be-disabled.dump.json`, committed between the 2.1.9 and
   * 2.1.11 eras).
   *
   * The count must EQUAL `maxUnknown`, changed 2026-08-18. The old bound read
   * "at most 1" for as long as the count read 1, so it could only ever stop the
   * number rising; resolving a fixture left a bound nobody had to lower, and
   * the comment beside it said "lower it when one gets resolved" the whole time
   * (#240). Equality makes the number fall as soon as the work is done.
   */
  it("holds the count of unknown-provenance fixtures at the declared ratchet", () => {
    const unknown = Object.entries(fixtures)
      .filter(([, e]) => e.factorioVersion === "unknown")
      .map(([name]) => name);
    expect(typeof manifest.maxUnknown, "PROVENANCE.json must declare maxUnknown").toBe("number");
    expect(
      unknown.length,
      `unknown-provenance fixtures: ${unknown.join(", ")}. Raising maxUnknown is not the fix - re-capture against a known binary. Lower it when one is resolved.`,
    ).toBe(manifest.maxUnknown);
  });
});
