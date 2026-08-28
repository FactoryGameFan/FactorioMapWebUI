import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { frozenNames } from "./tier2Frozen";

/**
 * Every `checksum_*` export the module has is frozen somewhere.
 *
 * **This is the anchor the primitive freeze was missing, and its absence is why
 * three exports went uncovered while a guard sat green over them.** That guard
 * compared `frozenCount(planet)` against the spec's own `CASES.length` - both
 * sides sourced from the same array, so it could only catch a case removed
 * without re-recording. It could not catch an export that had no case at all,
 * because nothing enumerated the exports.
 *
 * The three planet specs never had that hole: each asserts its name list
 * against an engine-side count (`vulcanus_field_count()` and friends) before
 * comparing anything. There is no equivalent count for the primitives, so this
 * enumerates `WebAssembly.Module.exports` instead - which is stronger, since it
 * reads what the module actually ships rather than a number the module also
 * has to be told.
 *
 * Concretely, it would have failed on `checksum_basis_noise`, `checksum_voronoi`
 * and `checksum_voronoi_cell_index`, none of which had a frozen row.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

/** Exports that fold through a request rather than arguments, frozen by their planet specs. */
const PLANET_EXPORTS = new Set(["checksum_fulgora", "checksum_vulcanus", "checksum_nauvis"]);

describe("tier-2 freeze coverage", () => {
  it("freezes every checksum export the module ships", async () => {
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    const exported = WebAssembly.Module.exports(module)
      .filter((e) => e.kind === "function" && e.name.startsWith("checksum_"))
      .map((e) => e.name)
      .sort();

    // Anti-vacuity: an empty enumeration would satisfy every assertion below.
    expect(exported.length, "the module must expose checksum exports").toBeGreaterThan(10);
    for (const p of PLANET_EXPORTS) {
      expect(exported, `${p} must exist to be covered`).toContain(p);
    }

    // Every frozen row is named `<export>:<something>` or is a planet field, so
    // the export a row covers is recoverable from the table itself.
    const covered = new Set<string>();
    for (const [planet, names] of frozenNames()) {
      if (planet === "fulgora") covered.add("checksum_fulgora");
      else if (planet === "vulcanus") covered.add("checksum_vulcanus");
      else if (planet === "nauvis") covered.add("checksum_nauvis");
      for (const n of names) {
        const head = n.split("|").pop()?.trim().split(":")[0] ?? "";
        if (head.startsWith("checksum_")) covered.add(head);
      }
    }

    // Planet exports are already in `covered` above, keyed off their tables.
    const missing = exported.filter((e) => !covered.has(e));
    expect(missing, "these checksum exports have no frozen row").toEqual([]);
  }, 120000);
});
