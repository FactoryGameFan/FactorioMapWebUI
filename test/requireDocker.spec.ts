import { describe, it, expect } from "vite-plus/test";

import {
  buildBox,
  colorEnabled,
  describeFailure,
  describeSuccess,
  paint,
  truncate,
  type Runtime,
} from "../scripts/require-docker.ts";

/** Strip ANSI so a rendered line can be measured and read as plain text. */
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const RUNTIMES: Runtime[] = [
  { name: "OrbStack", start: "orb start", installed: false },
  { name: "Docker Desktop", start: "open -a Docker", installed: false },
];

describe("colorEnabled", () => {
  it("follows the TTY when nothing overrides it", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });

  it("honours NO_COLOR even on a TTY", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("honours FORCE_COLOR off a TTY, but not when set to 0", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
  });
});

describe("paint", () => {
  it("is a no-op when colour is disabled", () => {
    expect(paint("hi", ["red", "bold"], false)).toBe("hi");
  });

  it("wraps and resets when enabled", () => {
    const out = paint("hi", ["red"], true);
    expect(out.startsWith("\x1b[31m")).toBe(true);
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(plain(out)).toBe("hi");
  });
});

describe("buildBox", () => {
  // The border is measured against the PLAIN text; if padding is ever computed
  // on an already-styled string the right edge goes ragged, and only a coloured
  // run would show it. Assert both.
  it("keeps the right border flush, coloured or not", () => {
    for (const enabled of [false, true]) {
      const lines = buildBox("✖  DOCKER IS NOT RUNNING", ["bold", "red"], enabled);
      // Measured in UTF-16 units, the same unit `padEnd` counts in - so this
      // asserts exactly what the renderer did. Every glyph in the box is BMP.
      const widths = lines.map((l) => plain(l).length);
      expect(new Set(widths).size).toBe(1);
      expect(lines).toHaveLength(3);
      expect(plain(lines[1])).toContain("DOCKER IS NOT RUNNING");
    }
  });
});

describe("truncate", () => {
  it("leaves a short string alone but collapses its whitespace", () => {
    expect(truncate("a  b\n c", 40)).toBe("a b c");
  });

  it("clips to the limit, ellipsis included", () => {
    const out = truncate("x".repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("describeFailure", () => {
  it("exits 1 for a stopped daemon and 2 when there is no CLI", () => {
    expect(describeFailure({ status: "no-daemon", detail: "x" }, RUNTIMES, false).code).toBe(1);
    expect(describeFailure({ status: "no-cli", detail: "x" }, RUNTIMES, false).code).toBe(2);
  });

  it("suggests only the installed runtime when one is detected", () => {
    const installed = RUNTIMES.map((r) => ({ ...r, installed: r.name === "OrbStack" }));
    const text = describeFailure({ status: "no-daemon", detail: "x" }, installed, false)
      .lines.map(plain)
      .join("\n");
    expect(text).toContain("orb start");
    expect(text).not.toContain("open -a Docker");
  });

  it("falls back to listing every runtime when none is detected", () => {
    const text = describeFailure({ status: "no-daemon", detail: "x" }, RUNTIMES, false)
      .lines.map(plain)
      .join("\n");
    expect(text).toContain("orb start");
    expect(text).toContain("open -a Docker");
    expect(text).toContain("(not detected)");
  });

  it("clips a long detail so it cannot bury the instructions", () => {
    const long = "Cannot connect to the Docker daemon at unix:///x.sock. ".repeat(5);
    const text = describeFailure({ status: "no-daemon", detail: long }, RUNTIMES, false)
      .lines.map(plain)
      .join("\n");
    expect(text).toContain("Cannot connect to the Docker daemon");
    expect(text).toContain("…");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
  });

  it("says install, not start, when there is no CLI to start", () => {
    const text = describeFailure({ status: "no-cli", detail: "x" }, RUNTIMES, false)
      .lines.map(plain)
      .join("\n");
    expect(text).toContain("INSTALL ONE OF:");
    expect(text).not.toContain("START IT WITH:");
    // Auto-start cannot help when nothing is installed - don't advertise it.
    expect(text).not.toContain("FMW_AUTO_START_DOCKER");
  });

  it("surfaces the underlying detail and the auto-start opt-out", () => {
    const text = describeFailure(
      { status: "no-daemon", detail: "Cannot connect to the Docker daemon" },
      RUNTIMES,
      false,
    )
      .lines.map(plain)
      .join("\n");
    expect(text).toContain("Cannot connect to the Docker daemon");
    expect(text).toContain("FMW_AUTO_START_DOCKER=1");
  });

  it("stays readable with colour stripped - the glyph and words carry it", () => {
    const { lines } = describeFailure({ status: "no-daemon", detail: "x" }, RUNTIMES, true);
    const text = lines.map(plain).join("\n");
    expect(text).toContain("✖");
    expect(text).toContain("DOCKER IS NOT RUNNING");
    expect(text).toContain("START IT WITH:");
  });
});

describe("describeSuccess", () => {
  it("is one quiet line naming the version", () => {
    const line = plain(describeSuccess("29.4.0", true));
    expect(line).toBe("✔ Docker daemon ready (29.4.0)");
  });
});
