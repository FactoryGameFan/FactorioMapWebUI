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
  fixtures: Record<string, Entry>;
};

const onDisk = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f !== "PROVENANCE.json")
  .sort();

describe("fixture provenance manifest", () => {
  it("covers every fixture on disk", () => {
    const missing = onDisk.filter((f) => !(f in manifest.fixtures));
    expect(missing, "fixtures with no PROVENANCE.json entry").toEqual([]);
  });

  it("has no entries for fixtures that no longer exist", () => {
    const present = new Set(onDisk);
    const dangling = Object.keys(manifest.fixtures).filter((f) => !present.has(f));
    expect(dangling, "PROVENANCE.json entries with no fixture").toEqual([]);
  });

  it("records a well-formed version and evidence for each entry", () => {
    for (const [name, entry] of Object.entries(manifest.fixtures)) {
      expect(entry.factorioVersion, `${name}: factorioVersion`).toMatch(
        /^(\d+\.\d+\.\d+|unknown)$/,
      );
      expect(entry.evidence.length, `${name}: evidence must be non-empty`).toBeGreaterThan(0);
    }
  });

  /**
   * Not a correctness bound - it is a ratchet. `unknown` means nobody wrote the
   * capture version down, which is only fixable by re-capturing against a known
   * binary. One such fixture exists today
   * (`autoplace-can-be-disabled.dump.json`, committed between the 2.1.9 and
   * 2.1.11 eras). Adding more should be a deliberate act, so this fails if the
   * count grows; lower it when one gets resolved.
   */
  it("does not accumulate fixtures of unknown provenance", () => {
    const unknown = Object.entries(manifest.fixtures)
      .filter(([, e]) => e.factorioVersion === "unknown")
      .map(([name]) => name);
    expect(
      unknown.length,
      `unknown-provenance fixtures: ${unknown.join(", ")}`,
    ).toBeLessThanOrEqual(1);
  });
});
