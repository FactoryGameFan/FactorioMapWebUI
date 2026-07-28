import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { FACTORIO_TARGET_VERSION } from "../src/model/factorioTarget";
import { SUPPORTED_VERSIONS } from "../src/codec/mapExchangeString";

interface Manifest {
  fixtures: Record<string, { factorioVersion: string }>;
}

const cmp = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * Keeps the version the UI advertises tied to the ground truth the build
 * actually holds.
 *
 * A hand-typed version string that nobody re-checks is precisely how the app came
 * to reject strings from the current game for three patch releases (#7): the
 * codec spoke `2.1.9.3`, Factorio had moved to `2.1.12.2`, and nothing failed.
 * So this asserts the displayed version IS the newest fixture provenance rather
 * than trusting anyone to remember.
 */
describe("advertised Factorio target", () => {
  it("matches the newest fixture provenance", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "PROVENANCE.json"), "utf8"),
    ) as Manifest;
    const versions = Object.values(manifest.fixtures)
      .map((e) => e.factorioVersion)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    expect(versions.length).toBeGreaterThan(0);
    const newest = versions.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
    expect(
      FACTORIO_TARGET_VERSION,
      "src/model/factorioTarget.ts is stale - bump it in the commit that lands the newer fixture",
    ).toBe(newest);
  });

  it("accepts the exchange format of the version it advertises", () => {
    // The failure this catches: bumping the target to a newer game without
    // teaching the codec that game's format tag - which is the bug of #7 exactly,
    // just in the other order. The tag's first three parts are the game version,
    // so targeting 2.1.12 means an accepted format must start "2.1.12.".
    const accepted = SUPPORTED_VERSIONS.map((v) => v.join("."));
    expect(
      accepted.some((v) => v.startsWith(FACTORIO_TARGET_VERSION + ".")),
      `no accepted exchange format for ${FACTORIO_TARGET_VERSION} (accepted: ${accepted.join(", ")})`,
    ).toBe(true);
  });
});
