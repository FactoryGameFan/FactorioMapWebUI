import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import ControlRow from "../src/components/ControlRow.vue";
import type { ControlColumn } from "../src/model/controlCatalog";
import { usePresetsStore } from "../src/store/presets";

const CLIFF_COLUMNS: ControlColumn[] = [
  { key: "frequency", label: "Frequency" },
  { key: "size", label: "Continuity" },
];

function mountRow(name: string) {
  setActivePinia(createPinia());
  localStorage.clear();
  const store = usePresetsStore();
  const wrapper = mount(ControlRow, { props: { name, columns: CLIFF_COLUMNS } });
  return { store, wrapper };
}

describe("ControlRow enable checkbox", () => {
  beforeEach(() => localStorage.clear());

  it("renders an enable checkbox for a disable-able control", () => {
    const { wrapper } = mountRow("nauvis_cliff");
    expect(wrapper.find('input[type="checkbox"][data-test="control-enable"]').exists()).toBe(true);
  });

  it("renders no checkbox but keeps the gutter spacer for an always-on control", () => {
    const { wrapper } = mountRow("vulcanus_volcanism");
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.find(".control-enable").exists()).toBe(true);
  });

  it("unchecking sets size to 0 and disables the row's sliders", async () => {
    const { store, wrapper } = mountRow("nauvis_cliff");
    await wrapper.find('input[type="checkbox"]').setValue(false);
    expect(store.activePreset!.autoplaceControls["nauvis_cliff"]!.size).toBe(0);
    const sliders = wrapper.findAll('input[type="range"]');
    expect(sliders.length).toBe(2);
    expect(sliders.every((s) => (s.element as HTMLInputElement).disabled)).toBe(true);
  });

  it("re-checking restores size to 1 and re-enables the sliders", async () => {
    const { store, wrapper } = mountRow("nauvis_cliff");
    const cb = wrapper.find('input[type="checkbox"]');
    await cb.setValue(false);
    await cb.setValue(true);
    expect(store.activePreset!.autoplaceControls["nauvis_cliff"]!.size).toBe(1);
    const sliders = wrapper.findAll('input[type="range"]');
    // `every` is true on an empty list, so count first (test-pruning audit,
    // 2026-11-26).
    expect(sliders.length).toBe(2);
    expect(sliders.every((s) => !(s.element as HTMLInputElement).disabled)).toBe(true);
  });

  it("never grays an always-on control even when its size is 0", async () => {
    const { store, wrapper } = mountRow("vulcanus_volcanism");
    store.activePreset!.autoplaceControls["vulcanus_volcanism"]!.size = 0;
    await wrapper.vm.$nextTick();
    const sliders = wrapper.findAll('input[type="range"]');
    // `every` is true on an empty list, so a row that dropped its sliders at
    // size 0 passed (test-pruning audit, 2026-11-26).
    expect(sliders.length).toBeGreaterThan(0);
    expect(sliders.every((s) => !(s.element as HTMLInputElement).disabled)).toBe(true);
  });

  it("preserves frequency and richness across a disable then enable", async () => {
    const { store, wrapper } = mountRow("nauvis_cliff");
    const ctrl = store.activePreset!.autoplaceControls["nauvis_cliff"]!;
    ctrl.frequency = 2;
    ctrl.richness = 3;
    const cb = wrapper.find('input[type="checkbox"]');
    await cb.setValue(false);
    await cb.setValue(true);
    expect(ctrl.size).toBe(1);
    expect(ctrl.frequency).toBe(2);
    expect(ctrl.richness).toBe(3);
  });
});
