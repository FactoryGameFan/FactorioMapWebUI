import { describe, expect, it } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import IslandFinderPanel from "../src/components/IslandFinderPanel.vue";
import { usePresetsStore } from "../src/store/presets";
import type { FindOptions, IslandResult } from "../src/noise/islands/findIslands";

function row(over: Partial<IslandResult> = {}): IslandResult {
  return {
    cellX: 1,
    cellY: 2,
    id: 0.8,
    klass: "mesa",
    sampleCount: 40,
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    centroidX: 50,
    centroidY: 60,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    rectTiles: { width: 80, height: 80 },
    landTiles: 9000,
    refined: true,
    clipped: false,
    chainId: 0,
    distanceFromSpawn: 78,
    ...over,
  } as IslandResult;
}

function setup(find: (opts: FindOptions) => Promise<IslandResult[]>) {
  setActivePinia(createPinia());
  const store = usePresetsStore();
  store.createFromBuiltin("Default", "t");
  store.activePreset!.seed = 123456;
  return mount(IslandFinderPanel, { props: { planet: "fulgora", find } });
}

describe("IslandFinderPanel", () => {
  it("renders one row per island with its rectangle in TILES, not pixels", async () => {
    const w = setup(async () => [row(), row({ cellX: 9, rectTiles: { width: 40, height: 20 } })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    const rows = w.findAll('[data-test="island-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain("80");
  });

  it("emits jump with the island centroid when a row is clicked", async () => {
    const w = setup(async () => [row({ centroidX: 1234, centroidY: -567 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="island-row"]').trigger("click");
    expect(w.emitted("jump")?.[0]).toEqual([{ x: 1234, y: -567 }]);
  });

  it("marks unrefined rows so a coarse number is never read as measured", async () => {
    const w = setup(async () => [row({ refined: false })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-approx"]').exists()).toBe(true);
  });

  it("marks clipped rows so a truncated rectangle is never read as complete", async () => {
    const w = setup(async () => [row({ clipped: true })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-clipped"]').exists()).toBe(true);
  });

  it("does not mark an unclipped row", async () => {
    const w = setup(async () => [row({ clipped: false })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-clipped"]').exists()).toBe(false);
  });

  it("shows the accuracy caveat without needing a search first", () => {
    const w = setup(async () => []);
    expect(w.text()).toMatch(/1 tile/i);
  });

  it("disables the search button while a search is running", async () => {
    let release: (v: IslandResult[]) => void = () => {};
    const w = setup(() => new Promise((r) => (release = r)));
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeDefined();
    release([]);
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeUndefined();
  });

  it("re-enables the search button after cancel, since findIslands resolves rather than rejects on abort", async () => {
    let release: (v: IslandResult[]) => void = () => {};
    const w = setup(() => new Promise((r) => (release = r)));
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="island-cancel"]').trigger("click");
    // findIslands resolves with whatever partial results it collected before
    // noticing the abort signal - it does NOT reject. A future change that
    // made it reject instead would still leave `running` cleared (a `catch`
    // sets `error` but the `finally` still fires), but the button staying
    // enabled here is what proves this path goes through the same success/
    // partial-completion handling as an ordinary finish, not a bespoke abort
    // branch.
    release([]);
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeUndefined();
    expect(w.find('[data-test="island-cancel"]').exists()).toBe(false);
  });

  it("is inert for a planet other than fulgora", () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    const w = mount(IslandFinderPanel, { props: { planet: "nauvis", find: async () => [] } });
    expect(w.find('[data-test="island-search"]').exists()).toBe(false);
  });

  it("forwards the preset's fulgora_islands slider values into ctx, not just seed0", async () => {
    // `FulgoraCtx.islandsFrequency`/`islandsSize` change the Voronoi grid
    // constant both the survey step and every render window derive from
    // (see elevationPreviewCtx.ts / fulgoraShared.ts). A ctx carrying only
    // seed0 makes the finder survey and render the DEFAULT grid even when
    // the preset moved these sliders - a different map than the preview
    // beside it shows.
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    store.activePreset!.seed = 123456;
    store.activePreset!.autoplaceControls.fulgora_islands = {
      frequency: 1.4,
      size: 0.6,
      richness: 1,
    };
    let seenCtx: { seed0: number; islandsFrequency?: number; islandsSize?: number } | undefined;
    const w = mount(IslandFinderPanel, {
      props: {
        planet: "fulgora",
        find: async (opts: FindOptions) => {
          seenCtx = opts.ctx;
          return [];
        },
      },
    });
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(seenCtx?.islandsFrequency).toBe(1.4);
    expect(seenCtx?.islandsSize).toBe(0.6);
  });

  it("does not clamp the radius field while it is being typed into", async () => {
    const w = setup(async () => []);
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    // `FNumberInput` commits on the native `change` event, not on every
    // keystroke - this is the moment a naive setter used to snap the field
    // to RADIUS_MIN (500) before the rest of a value like "5000" was typed.
    await input.trigger("change");
    expect((input.element as HTMLInputElement).value).toBe("5");
  });

  it("clamps the radius field on blur", async () => {
    const w = setup(async () => []);
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    await input.trigger("change");
    await input.trigger("blur");
    expect((input.element as HTMLInputElement).value).toBe("500");
  });

  it("never passes an out-of-range radius to findIslands, even without a blur first", async () => {
    let seenRadius: number | undefined;
    const w = setup(async (opts) => {
      seenRadius = opts.radius;
      return [];
    });
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    await input.trigger("change");
    // No blur - straight to search. The guarantee has to hold here too.
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(seenRadius).toBe(500);
  });
});
