import { describe, expect, it } from "vite-plus/test";

import {
  oracleCandidates,
  parseArgs,
  parseInstalls,
  pickInstall,
  USAGE,
} from "../scripts/sync-factorio-refs";

/**
 * The coverage the shell version could not have.
 *
 * `scripts/sync-factorio-refs.sh` was 254 lines with six functions, thirteen
 * conditionals, a `case` for argument parsing, a regex standing in for a JSON
 * parser and 32 lines of Python in a heredoc - and **zero tests**, in a repo
 * with 231 spec files, because none of that is reachable from vitest. Being
 * able to plant a break and watch it fail is the whole method here, and that
 * script could not participate in it.
 *
 * What is deliberately NOT tested: anything that shells out to
 * `factorio-oracle`. Those paths need a real binary and a real Factorio
 * install, which is exactly the dependency `verify` must not acquire - the gate
 * runs on machines with neither. The pure functions below are the parts that
 * can silently be wrong.
 */
describe("parseArgs", () => {
  it("defaults to the report mode with no version", () => {
    expect(parseArgs([])).toEqual({ mode: "report", version: null });
  });

  it("takes a bare argument as the version", () => {
    expect(parseArgs(["2.1.11"])).toEqual({ mode: "report", version: "2.1.11" });
  });

  it("reads --check and --fixtures", () => {
    expect(parseArgs(["--check"]).mode).toBe("check");
    expect(parseArgs(["--fixtures"]).mode).toBe("fixtures");
  });

  it("combines a version with --check, in either order", () => {
    expect(parseArgs(["2.1.11", "--check"])).toEqual({ mode: "check", version: "2.1.11" });
    expect(parseArgs(["--check", "2.1.11"])).toEqual({ mode: "check", version: "2.1.11" });
  });

  it("treats help as its own mode rather than a flag on another", () => {
    expect(parseArgs(["--fixtures", "--help"]).mode).toBe("help");
    expect(parseArgs(["-h"]).mode).toBe("help");
  });

  it("REJECTS an unknown option instead of silently ignoring it", () => {
    // The shell version's `case` fell through to `*)` and treated a typo'd flag
    // as a VERSION, so `--fixture` (singular) would have asked the oracle to
    // read a version literally called "--fixture".
    expect(() => parseArgs(["--fixture"])).toThrow(/unknown option --fixture/);
  });
});

describe("parseInstalls", () => {
  it("reads the oracle's JSON shape", () => {
    const json = JSON.stringify({
      installs: [{ version: "2.1.14", binary: "/games/factorio", docDir: "/games/doc-html" }],
    });
    expect(parseInstalls(json)).toEqual([
      { version: "2.1.14", binary: "/games/factorio", docDir: "/games/doc-html" },
    ]);
  });

  it("accepts an empty list, which is a normal state", () => {
    expect(parseInstalls('{"installs":[]}')).toEqual([]);
  });

  it("throws rather than returning nonsense on an unexpected shape", () => {
    expect(() => parseInstalls("{}")).toThrow(/installs/);
    expect(() => parseInstalls('{"installs":"nope"}')).toThrow(/array/);
    expect(() => parseInstalls("not json")).toThrow();
  });

  it("is a real parser, not the regex it replaces", () => {
    // The shell version ran `grep -oE '\"version\"...'` over base/info.json and
    // took the first version-shaped substring. Given a payload where an
    // unrelated key holds a version-shaped string FIRST, that approach reads the
    // wrong one; a JSON parse cannot.
    const json = '{"installs":[{"binary":"/opt/factorio-2.0.77/bin","version":"2.1.14"}]}';
    expect(parseInstalls(json)[0].version).toBe("2.1.14");
  });
});

describe("pickInstall", () => {
  const a: Parameters<typeof pickInstall>[0][number] = { version: "2.1.14", binary: "/steam/f" };
  const b = { version: "2.0.77", binary: "/opt/old/f" };

  it("returns null when nothing is installed, rather than throwing", () => {
    // `verify` must pass on a machine with no Factorio, so absence is normal
    // and the caller decides whether it is fatal.
    expect(pickInstall([], {})).toBeNull();
  });

  it("takes the first install when FACTORIO_BIN is unset", () => {
    expect(pickInstall([a, b], {})?.version).toBe("2.1.14");
  });

  it("honours FACTORIO_BIN, which is how you select the 2.0.77 oracle", () => {
    expect(pickInstall([a, b], { FACTORIO_BIN: "/opt/old/f" })?.version).toBe("2.0.77");
  });

  it("returns null when FACTORIO_BIN names something absent", () => {
    // Not falling back to the first install: silently reading a DIFFERENT
    // version than the one asked for is the exact skew this repo keeps getting
    // bitten by, so it must be an error rather than a default.
    expect(pickInstall([a, b], { FACTORIO_BIN: "/nowhere" })).toBeNull();
  });

  it("treats an empty FACTORIO_BIN as unset", () => {
    expect(pickInstall([a, b], { FACTORIO_BIN: "" })?.version).toBe("2.1.14");
  });
});

describe("oracleCandidates", () => {
  it("puts FACTORIO_ORACLE_BIN first so an override actually wins", () => {
    expect(oracleCandidates({ FACTORIO_ORACLE_BIN: "/custom/oracle" })[0]).toBe("/custom/oracle");
  });

  it("looks in CARGO_HOME/bin, because ~/.cargo/bin is on no PATH here", () => {
    expect(oracleCandidates({ CARGO_HOME: "/c" })).toContain("/c/bin/factorio-oracle");
  });

  it("still falls back to PATH", () => {
    expect(oracleCandidates({})).toContain("factorio-oracle");
  });

  it("ignores an empty override rather than probing the empty string", () => {
    expect(oracleCandidates({ FACTORIO_ORACLE_BIN: "" })[0]).not.toBe("");
  });
});

describe("USAGE", () => {
  it("teaches the oracle commands that replaced the pinning", () => {
    // The point of the rewrite is that nothing is pinned any more, so the help
    // has to hand over the read-in-place commands or the capability is lost.
    expect(USAGE).toContain("refs grep");
    expect(USAGE).toContain("refs docs");
    expect(USAGE).toContain("--tag A --tag B");
  });

  it("says plainly that nothing is downloaded or checked out", () => {
    expect(USAGE).toMatch(/Nothing is pinned, checked out or downloaded/);
  });
});
