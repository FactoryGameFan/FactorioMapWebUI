import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vite-plus/test";
import { decodeExchangeString } from "../src/codec/mapExchangeString";
import AdvancedTab from "../src/components/AdvancedTab.vue";
import { usePresetsStore } from "../src/store/presets";

describe("AdvancedTab", () => {
  it("shows the active preset's map width and height", () => {
    setActivePinia(createPinia());
    const wrapper = mount(AdvancedTab);
    expect((wrapper.find('[data-test="map-width"]').element as HTMLInputElement).value).toBe(
      "2000000",
    );
    expect((wrapper.find('[data-test="map-height"]').element as HTMLInputElement).value).toBe(
      "2000000",
    );
  });

  it("writes an edited height back to the active preset", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    const input = wrapper.find('[data-test="map-height"]');
    (input.element as HTMLInputElement).value = "128";
    await input.trigger("change");
    expect(store.activePreset?.height).toBe(128);
  });
});

describe("AdvancedTab map settings", () => {
  it("renders the new setting rows", () => {
    setActivePinia(createPinia());
    const wrapper = mount(AdvancedTab);
    for (const t of [
      "tech-price-multiplier",
      "pollution-enabled",
      "pollution-ageing",
      "pollution-attack-cost",
      "pollution-min-damage-trees",
      "pollution-absorbed-per-tree",
      "pollution-diffusion",
      "asteroid-spawning-rate",
      "spoiling-rate",
    ]) {
      expect(wrapper.find(`[data-test="${t}"]`).exists(), t).toBe(true);
    }
  });

  it("writes an edited technology price multiplier to the exchange string", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    // Price multiplier is a bare FNumberInput: data-test IS the input element.
    const box = wrapper.find('[data-test="tech-price-multiplier"]');
    (box.element as HTMLInputElement).value = "4";
    await box.trigger("change");
    const tail = decodeExchangeString(store.activeExchangeString as string).tail;
    expect(tail["difficulty.technologyPriceMultiplier"]).toBeCloseTo(4, 6);
  });

  it("writes diffusion ratio at the display scale (percent -> wire)", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    const box = wrapper.find('[data-test="pollution-diffusion"] input[type="number"]');
    (box.element as HTMLInputElement).value = "5"; // displayed percent
    await box.trigger("change");
    const tail = decodeExchangeString(store.activeExchangeString as string).tail;
    expect(tail["pollution.diffusionRatio"]).toBeCloseTo(0.05, 6);
  });

  it("writes spoiling rate as the inverse of the wire spoil-time modifier", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    const box = wrapper.find('[data-test="spoiling-rate"] input[type="number"]');
    (box.element as HTMLInputElement).value = "200"; // displayed rate %
    await box.trigger("change");
    const tail = decodeExchangeString(store.activeExchangeString as string).tail;
    // rate 200% -> wire 100/200 = 0.5
    expect(tail["difficulty.spoilTimeModifier"]).toBeCloseTo(0.5, 6);
  });

  it("binds 'Absorbed per damaged tree' to pollutionRestoredPerTreeDamage", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    const box = wrapper.find('[data-test="pollution-absorbed-per-tree"] input[type="number"]');
    (box.element as HTMLInputElement).value = "25";
    await box.trigger("change");
    const tail = decodeExchangeString(store.activeExchangeString as string).tail;
    expect(tail["pollution.pollutionRestoredPerTreeDamage"]).toBe(25);
  });

  it("writes asteroid spawning rate at the percent display scale", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(AdvancedTab);
    const box = wrapper.find('[data-test="asteroid-spawning-rate"] input[type="number"]');
    (box.element as HTMLInputElement).value = "150"; // displayed percent
    await box.trigger("change");
    const tail = decodeExchangeString(store.activeExchangeString as string).tail;
    expect(tail["asteroids.spawningRate"]).toBeCloseTo(1.5, 6);
  });

  it("disables the pollution child rows when pollution is unchecked", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.activePreset!.mapSettings.pollution.enabled = false;
    const wrapper = mount(AdvancedTab);
    const box = wrapper.find('[data-test="pollution-diffusion"] input[type="number"]');
    expect((box.element as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the property-expression dump available in a collapsed details", () => {
    setActivePinia(createPinia());
    const wrapper = mount(AdvancedTab);
    // Checked only that both existed, so a dump moved out of the details, or
    // a details that starts open, passed (test-pruning audit, 2026-11-26).
    expect(wrapper.find('details [data-test="expr-dump"]').exists()).toBe(true);
    expect(wrapper.find("details").attributes("open")).toBeUndefined();
  });
});
