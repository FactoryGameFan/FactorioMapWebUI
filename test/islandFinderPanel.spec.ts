import { describe, expect, it } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import IslandFinderPanel from "../src/components/IslandFinderPanel.vue";
import { usePresetsStore } from "../src/store/presets";
import type { IslandResult } from "../src/noise/islands/findIslands";

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
    chainId: 0,
    distanceFromSpawn: 78,
    ...over,
  } as IslandResult;
}

function setup(find: () => Promise<IslandResult[]>) {
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

  it("is inert for a planet other than fulgora", () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    const w = mount(IslandFinderPanel, { props: { planet: "nauvis", find: async () => [] } });
    expect(w.find('[data-test="island-search"]').exists()).toBe(false);
  });
});
