import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Guards the one trap in a factorio-oracle probe directory that no run reports.
 *
 * factorio-oracle reads a probe's control script from either `control_lua`
 * (inline) or `control_lua_file` (a path), but the DATA stage is inline only -
 * there is no `data_lua_file` (factorio-oracle src/run.rs:39-139, read
 * 2026-08-18). So `scripts/probes/basis-gradient/data.lua` is a readable copy
 * of a string inside probe.json, and editing it changes nothing about what the
 * probe runs.
 *
 * That is a silent failure with a long fuse: the next person to re-capture the
 * gradient table would edit the file that reads like source, run the probe, and
 * get a capture of the OLD expression with no error anywhere. A comment saying
 * "mirror your change into probe.json" cannot fail. This can.
 */
const PROBE_DIR = join(import.meta.dirname, "..", "scripts", "probes", "basis-gradient");

const readProbe = (): { mod: { data_lua?: string; control_lua_file?: string } } =>
  JSON.parse(readFileSync(join(PROBE_DIR, "probe.json"), "utf8")) as {
    mod: { data_lua?: string; control_lua_file?: string };
  };

describe("the basis-gradient probe", () => {
  it("keeps data.lua byte-identical to the inline data_lua that actually runs", () => {
    const inline = readProbe().mod.data_lua;
    const onDisk = readFileSync(join(PROBE_DIR, "data.lua"), "utf8");

    expect(inline).toBeDefined();
    // data.lua carries a header saying it is the copy; the shared part is
    // everything from the `data:extend` call onward, which is what Factorio runs.
    const body = (text: string): string => text.slice(text.indexOf("data:extend"));
    expect(body(onDisk)).toBe(body(inline as string));
  });

  it("still registers the expression the recovery inverts, at input_scale 1", () => {
    // Not decoration. The whole recovery depends on input_scale = 1, because it
    // is what makes the noise coordinate equal the world coordinate, so a sample
    // at (I + 1/256, J) sits a known distance from the lattice point and the
    // falloff can be inverted in closed form. At the oracle-basis fixture's 0.125
    // it cannot. If this drifts, the capture stops being invertible and the
    // failure shows up as a wrong table, not as an error.
    const inline = readProbe().mod.data_lua ?? "";
    expect(inline).toContain("input_scale = 1,");
    expect(inline).toContain("seed0 = 123456");
    expect(inline).toContain('name = "probe_basis"');
  });

  it("points control_lua_file at a file that exists", () => {
    // A missing path fails at run time, in a mode that costs a full game launch.
    const rel = readProbe().mod.control_lua_file;
    expect(rel).toBeDefined();
    const abs = join(import.meta.dirname, "..", rel as string);
    expect(() => readFileSync(abs, "utf8")).not.toThrow();
    expect(readFileSync(abs, "utf8")).toContain("DUMPED-OK");
  });
});
