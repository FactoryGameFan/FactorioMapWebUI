import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import TerrainTab from "../src/components/TerrainTab.vue";
import { usePresetsStore } from "../src/store/presets";
import { decodeExchangeString } from "../src/codec/mapExchangeString";

function mountTab() {
  setActivePinia(createPinia());
  return mount(TerrainTab);
}

function headers(wrapper: ReturnType<typeof mount>, tableTest: string): string[] {
  return wrapper
    .find(`[data-test="${tableTest}"]`)
    .findAll("th")
    .map((th) => th.text());
}

describe("TerrainTab", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the coverage table with Scale/Coverage columns and no Richness", () => {
    const wrapper = mountTab();
    const cols = headers(wrapper, "terrain-coverage-table");
    expect(cols).toContain("Scale");
    expect(cols).toContain("Coverage");
    expect(cols).not.toContain("Richness");
  });

  it("shows non-cliff terrain in the coverage table but not cliffs", () => {
    const wrapper = mountTab();
    const coverage = wrapper.find('[data-test="terrain-coverage-table"]');
    expect(coverage.find('[data-test="control-row-water"]').exists()).toBe(true);
    expect(coverage.find('[data-test="control-row-nauvis_cliff"]').exists()).toBe(false);
  });

  it("renders the cliff table with Frequency/Continuity columns", () => {
    const wrapper = mountTab();
    const cols = headers(wrapper, "terrain-cliff-table");
    expect(cols).toContain("Frequency");
    expect(cols).toContain("Continuity");
    expect(cols).not.toContain("Richness");
  });

  it("shows all three cliff controls in the cliff table", () => {
    const wrapper = mountTab();
    const cliff = wrapper.find('[data-test="terrain-cliff-table"]');
    for (const name of ["nauvis_cliff", "gleba_cliff", "fulgora_cliff"]) {
      expect(cliff.find(`[data-test="control-row-${name}"]`).exists()).toBe(true);
    }
  });

  it("renders a live Map type dropdown listing Nauvis, Lakes, Island", () => {
    const wrapper = mountTab();
    const select = wrapper.find('[data-test="map-type"]');
    expect(select.exists()).toBe(true);
    expect((select.element as HTMLSelectElement).disabled).toBe(false);
    const labels = select.findAll("option").map((o) => o.text());
    expect(labels).toEqual(["Nauvis elevation", "Lakes elevation", "Island elevation"]);
  });

  it("defaults the Map type to Nauvis for a preset with no elevation override", () => {
    const wrapper = mountTab();
    const select = wrapper.find('[data-test="map-type"]');
    expect((select.element as HTMLSelectElement).value).toBe("nauvis");
  });

  it("selecting Island drives elevation=elevation_island into the exchange string", async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    const wrapper = mount(TerrainTab);
    const select = wrapper.find('[data-test="map-type"]');
    await select.setValue("island");
    const pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect(pen["elevation"]).toBe("elevation_island");
  });

  it("resetting Map type back to Nauvis removes the elevation key", async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    const wrapper = mount(TerrainTab);
    const select = wrapper.find('[data-test="map-type"]');
    await select.setValue("island");
    let pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect(pen["elevation"]).toBe("elevation_island");
    await select.setValue("nauvis");
    pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect("elevation" in pen).toBe(false);
  });

  it("surfaces an unknown imported elevation value as an extra, selected option", () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    // Simulate an imported preset carrying a modded/unknown elevation expression.
    store.activePreset!.propertyExpressionNames["elevation"] = "elevation_modded_x";
    const wrapper = mount(TerrainTab);
    const select = wrapper.find('[data-test="map-type"]');
    const values = select.findAll("option").map((o) => (o.element as HTMLOptionElement).value);
    expect(values).toEqual(["nauvis", "lakes", "island", "elevation_modded_x"]);
    expect((select.element as HTMLSelectElement).value).toBe("elevation_modded_x");
  });

  it("renders live Moisture and Terrain type rows with enabled Scale and Bias sliders", () => {
    const wrapper = mountTab();
    for (const row of ["terrain-noise-moisture", "terrain-noise-terrain-type"]) {
      const el = wrapper.find(`[data-test="${row}"]`);
      expect(el.exists(), row).toBe(true);
      const sliders = el.findAll('input[type="range"]');
      expect(sliders.length, row).toBe(2);
      expect(
        sliders.every((s) => !(s.element as HTMLInputElement).disabled),
        row,
      ).toBe(true);
    }
  });

  it('gives each climate row an "Appears on" Nauvis icon', () => {
    const wrapper = mountTab();
    const cols = headers(wrapper, "terrain-noise-table");
    expect(cols).toContain("Appears on");
    for (const row of ["terrain-noise-moisture", "terrain-noise-terrain-type"]) {
      const icon = wrapper.find(`[data-test="${row}"] img[data-test="appears-on"]`);
      expect(icon.exists(), row).toBe(true);
      expect(icon.attributes("alt"), row).toBe("Nauvis");
    }
  });

  it("drives Moisture Scale 150% + Bias +0.05 into the exchange string byte-exact", async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    const wrapper = mount(TerrainTab);
    const row = wrapper.find('[data-test="terrain-noise-moisture"]');
    const sliders = row.findAll('input[type="range"]');
    await sliders[0]?.setValue("7"); // Scale notch 7 = 150%
    await sliders[1]?.setValue("11"); // Bias notch 11 = +0.05

    const pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect(pen["control:moisture:frequency"]).toBe("0.666667");
    expect(pen["control:moisture:bias"]).toBe("0.050000");
  });

  it("removes the moisture keys from the exchange string when reset to default notches", async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    const wrapper = mount(TerrainTab);
    const row = wrapper.find('[data-test="terrain-noise-moisture"]');
    const sliders = row.findAll('input[type="range"]');

    // First move both off default so the keys are present...
    await sliders[0]?.setValue("7"); // Scale 150%
    await sliders[1]?.setValue("11"); // Bias +0.05
    let pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect(pen["control:moisture:frequency"]).toBe("0.666667");
    expect(pen["control:moisture:bias"]).toBe("0.050000");

    // ...then reset both to their default notch (Scale 100% = index 5, Bias 0 = index 10).
    await sliders[0]?.setValue("5");
    await sliders[1]?.setValue("10");
    pen = decodeExchangeString(store.activeExchangeString as string).propertyExpressionNames;
    expect("control:moisture:frequency" in pen).toBe(false);
    expect("control:moisture:bias" in pen).toBe(false);
  });

  it("shows an enable checkbox on disable-able coverage rows but not always-on ones", () => {
    const wrapper = mountTab();
    const water = wrapper.find('[data-test="control-row-water"]');
    const volcanism = wrapper.find('[data-test="control-row-vulcanus_volcanism"]');
    expect(water.find('input[type="checkbox"]').exists()).toBe(true);
    expect(volcanism.find('input[type="checkbox"]').exists()).toBe(false);
    expect(volcanism.find(".control-enable").exists()).toBe(true);
  });

  it("shows an info glyph on the Water row with the starting-area title", () => {
    const wrapper = mountTab();
    const info = wrapper.find('[data-test="control-row-water"] [data-test="info"]');
    expect(info.exists()).toBe(true);
    expect(info.attributes("title")).toBe("If disabled: only in starting area");
  });

  it("shows no info glyph on a control without info (trees)", () => {
    const wrapper = mountTab();
    // Without the row anchor this passed when the trees row was missing (test-pruning audit, 2026-11-26).
    expect(wrapper.find('[data-test="control-row-trees"]').exists()).toBe(true);
    const info = wrapper.find('[data-test="control-row-trees"] [data-test="info"]');
    expect(info.exists()).toBe(false);
  });

  it("shows an info glyph on the Moisture row with the grass-versus-desert title", () => {
    const wrapper = mountTab();
    const info = wrapper.find('[data-test="terrain-noise-moisture"] [data-test="info"]');
    expect(info.exists()).toBe(true);
    expect(info.attributes("title")).toBe(
      "Controls the distribution of grass versus desert. A higher bias generates more grass",
    );
  });

  it("shows an info glyph on the Terrain type row with the red-desert-versus-sand title", () => {
    const wrapper = mountTab();
    const info = wrapper.find('[data-test="terrain-noise-terrain-type"] [data-test="info"]');
    expect(info.exists()).toBe(true);
    expect(info.attributes("title")).toBe(
      "Controls the distribution of red desert versus sand. A higher bias generates more red desert.",
    );
  });

  it("unchecking Cliffs drives nauvis_cliff.size to 0 in the exchange string, re-checking restores it", async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const store = usePresetsStore();
    const wrapper = mount(TerrainTab);
    const cb = wrapper.find(
      '[data-test="control-row-nauvis_cliff"] input[type="checkbox"][data-test="control-enable"]',
    );
    expect(cb.exists()).toBe(true);

    await cb.setValue(false);
    let decoded = decodeExchangeString(store.activeExchangeString as string);
    expect(decoded.autoplaceControls["nauvis_cliff"]?.size).toBe(0);

    await cb.setValue(true);
    decoded = decodeExchangeString(store.activeExchangeString as string);
    expect(decoded.autoplaceControls["nauvis_cliff"]?.size).toBe(1);
  });
});
