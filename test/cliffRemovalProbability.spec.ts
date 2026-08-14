import { describe, expect, it } from "vite-plus/test";

import removal from "./fixtures/oracle-vulcanus-cliff-removal-probability.seed123456.json";

/**
 * **The MECHANISM of the ore -> cliff exclusion: `cliff_removal_probability`.**
 *
 * `cliffOreDirection.spec.ts` settled the DIRECTION - resources suppress
 * cliffs, not the reverse - by switching the resources off and regenerating.
 * That is as far as switching something off can go. Removing the ore removes
 * everything about the ore at once, so it can say which way the effect runs and
 * never how.
 *
 * The lever here is a PROTOTYPE field, which is a different kind of lever:
 * every one of the 945 resource entities stays exactly where the control has
 * them, and one property of them changes.
 * `ResourceEntityPrototype::cliff_removal_probability` defaults to **1.0**, and
 * no shipped prototype overrides it - grepped across `base/`, `core/`,
 * `space-age/`, `quality/` and `elevated-rails/`. It is therefore invisible
 * from the data alone and can only be seen by changing it.
 *
 * It cannot be changed the way `autoplace_controls` and `cliff_settings` are,
 * because those are surface settings and this is read at map-gen from the
 * loaded prototype. `OracleOptions.extraDataLua` exists for exactly this, and
 * writes `data-final-fixes.lua` rather than `data.lua`: the probe mod declares
 * no dependencies, so Factorio may load it before `space-age`, at which point
 * `data.raw.resource["tungsten-ore"]` does not exist yet and the override would
 * silently edit nothing.
 *
 * **What this does NOT change: the port.** At 1.0 the removal is
 * unconditional, so `vulcanusOreRejection.ts`'s box-overlap rejection is
 * correct exactly as written and no code moves. What changes is that its header
 * can stop saying the mechanism is unknown, and that the box-overlap SHAPE is
 * explained rather than fitted - a placed resource destroys the cliffs it
 * collides with.
 */

interface Ent {
  x: number;
  y: number;
  name: string;
}
interface Proto {
  type: string;
  layers: string[];
  box?: { lx: number; ly: number; rx: number; ry: number };
  cliff_removal_probability?: number;
  map_grid?: boolean;
}
interface Arm {
  label: string;
  zeroedCliffRemovalProbability: boolean;
  autoplaceControls: Record<string, { frequency: number; size: number; richness: number }> | null;
  effectiveAutoplace: Record<string, { frequency: number; size: number; richness: number }>;
  cliffs: Ent[];
  resources: Ent[];
  protos: Record<string, Proto>;
}

const arms = removal.cases as unknown as Arm[];
const CONTROL = 0;
const ZEROED = 1;
const ORE_OFF = 2;

const vulcanusCliffs = (a: Arm): number =>
  a.cliffs.filter((c) => c.name === "cliff-vulcanus").length;

/**
 * The ten cells `#94` found the game leaves empty however `cliff_elevation` is
 * routed onto them, and `#99` showed fill completely once the ore is switched
 * off. Same list, verbatim, as `cliffOreDirection.spec.ts` - if it drifts, the
 * two specs are no longer talking about the same thing.
 */
const BLOB = [
  "178,138.5",
  "178,142.5",
  "178,146.5",
  "178,150.5",
  "182,138.5",
  "182,142.5",
  "182,146.5",
  "182,150.5",
  "186,138.5",
  "186,142.5",
];
const blobHits = (a: Arm): number => {
  const cells = new Set(
    a.cliffs.filter((c) => c.name === "cliff-vulcanus").map((c) => `${String(c.x)},${String(c.y)}`),
  );
  return BLOB.filter((k) => cells.has(k)).length;
};

describe("the ore -> cliff exclusion is cliff_removal_probability", () => {
  /**
   * The distinguishing arm. The ore is still there - all 945 of it, the same
   * count as the control - and every blob cell gets a cliff anyway. No account
   * in which the exclusion is about the ore's PRESENCE survives this.
   */
  it("zeroing the field restores every blob cell with the ore still in place", () => {
    expect(blobHits(arms[CONTROL])).toBe(0);
    expect(blobHits(arms[ZEROED])).toBe(10);

    // Non-vacuity, both halves. The ore did NOT go away...
    expect(arms[ZEROED].resources.length).toBe(945);
    expect(arms[ZEROED].resources.length).toBe(arms[CONTROL].resources.length);
    // ...and the arm really did run with the field changed, read back off the
    // running game rather than echoed from what was written.
    expect(arms[CONTROL].protos["tungsten-ore"].cliff_removal_probability).toBe(1);
    expect(arms[ZEROED].protos["tungsten-ore"].cliff_removal_probability).toBe(0);
  });

  /**
   * The field accounts for the effect ENTIRELY, not merely for some of it.
   * Zeroing it is indistinguishable from deleting every resource, and the
   * difference from the control is exactly the ten blob cells.
   */
  it("zeroing the field is indistinguishable from having no resources at all", () => {
    expect(vulcanusCliffs(arms[CONTROL])).toBe(335);
    expect(vulcanusCliffs(arms[ZEROED])).toBe(345);
    expect(vulcanusCliffs(arms[ORE_OFF])).toBe(345);
    expect(vulcanusCliffs(arms[ZEROED])).toBe(vulcanusCliffs(arms[ORE_OFF]));
    expect(vulcanusCliffs(arms[ZEROED]) - vulcanusCliffs(arms[CONTROL])).toBe(BLOB.length);

    // The resources-OFF arm is the known control from cliffOreDirection: it
    // reaches the same cliff count by removing the ore rather than by changing
    // it, and its field is untouched.
    expect(arms[ORE_OFF].resources.length).toBe(0);
    expect(arms[ORE_OFF].protos["tungsten-ore"].cliff_removal_probability).toBe(1);
    expect(arms[ORE_OFF].effectiveAutoplace["tungsten_ore"]?.size).toBe(0);
    expect(arms[CONTROL].effectiveAutoplace["tungsten_ore"]?.size).toBe(1);
  });

  /**
   * The default is what makes the ported rejection unconditional, and it is
   * asserted here so that a future Factorio version lowering it - or a mod
   * prototype arriving with a different value - fails loudly instead of
   * silently invalidating `vulcanusOreRejection.ts`'s "always" assumption.
   */
  it("every resource takes the 1.0 default, which is why the port needs no probability", () => {
    for (const name of ["tungsten-ore", "calcite", "coal", "sulfuric-acid-geyser"]) {
      expect(arms[CONTROL].protos[name].cliff_removal_probability).toBe(1);
    }
  });

  /**
   * Recorded here because the same read-back proved it and because it is the
   * reason a rendered map preview cannot count resource entities: `map_grid`
   * draws solid ores as a 2x2-block checkerboard. Only fluid and vent
   * resources opt out, and the geyser is the one in this fixture.
   */
  it("map_grid is on for the solid ores and off for the geyser", () => {
    for (const name of ["tungsten-ore", "calcite", "coal"]) {
      expect(arms[CONTROL].protos[name].map_grid).toBe(true);
    }
    expect(arms[CONTROL].protos["sulfuric-acid-geyser"].map_grid).toBe(false);
  });
});
