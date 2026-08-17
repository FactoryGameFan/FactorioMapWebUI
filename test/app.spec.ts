import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import App from "../src/App.vue";
import fixtures from "./fixtures/builtin-presets.json";

const presetStrings = fixtures.presets as Record<string, string>;

function mountApp() {
  return mount(App, { global: { plugins: [createPinia()] } });
}

describe("App shell", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the title bar, tabs, and preset bar", () => {
    const w = mountApp();
    expect(w.text()).toContain("Map generator");
    for (const tab of ["Resources", "Terrain", "Enemy", "Advanced"]) {
      expect(w.text()).toContain(tab);
    }
    expect(w.text()).toContain("New preset");
  });

  it("links to the GitHub repo from the title bar", () => {
    const w = mountApp();
    const link = w.find("a.repo-link");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("https://github.com/FactoryGameFan/FactorioMapWebUI");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toContain("noopener");
  });

  it("creates a preset from the builtin dropdown via the Create button", async () => {
    const w = mountApp();
    await w.find('input[data-test="new-preset-name"]').setValue("speedrun");
    await w.find('select[data-test="builtin-select"]').setValue("Rail world");
    await w.find('button[data-test="create-preset"]').trigger("click");
    const editSelect = w.find('select[data-test="edit-preset-select"]');
    expect((editSelect.element as HTMLSelectElement).value).toBe("speedrun");
  });

  it('disables the seed input when "Random each new map" is checked', async () => {
    const w = mountApp();
    const seed = w.find('input[data-test="seed-input"]');
    expect((seed.element as HTMLInputElement).disabled).toBe(true);
    await w.find('[data-test="random-each-map"] input').setValue(false);
    expect((seed.element as HTMLInputElement).disabled).toBe(false);
  });

  it("shows resource controls from every planet at once", () => {
    const w = mountApp();
    // One label from each planet - all visible in the single unified table.
    for (const label of [
      "Iron ore", // nauvis
      "Tungsten ore", // vulcanus
      "Scrap", // fulgora
      "Fluorine vent", // aquilo
    ]) {
      expect(w.text()).toContain(label);
    }
  });

  it('gives each control row an "Appears on" planet icon labelled with its planet', () => {
    const w = mountApp();
    expect(w.text()).toContain("Appears on");
    const coalIcon = w.find('[data-test="control-row-coal"] img[data-test="appears-on"]');
    expect(coalIcon.exists()).toBe(true);
    expect(coalIcon.attributes("alt")).toBe("Nauvis");
    const tungstenIcon = w.find(
      '[data-test="control-row-tungsten_ore"] img[data-test="appears-on"]',
    );
    expect(tungstenIcon.attributes("alt")).toBe("Vulcanus");
  });

  it("editing a frequency percentage slider updates the store", async () => {
    const w = mountApp();
    const coalRow = w.find('[data-test="control-row-coal"]');
    // First range input in the row is the Frequency column; index 9 = 300% = 3.
    await coalRow.find('input[type="range"]').setValue("9");
    const stored = JSON.parse(JSON.stringify(w.vm.$pinia.state.value)) as {
      presets: { userPresets: { autoplaceControls: Record<string, { frequency: number }> }[] };
    };
    expect(stored.presets.userPresets[0]?.autoplaceControls["coal"]?.frequency).toBe(3);
  });

  it("duplicate and save buttons work end to end", async () => {
    const w = mountApp();
    await w.find('button[data-test="duplicate"]').trigger("click");
    expect(w.text()).toContain("My preset (copy)");
    await w.find('button[data-test="save"]').trigger("click");
    expect(localStorage.getItem("factorio-map-webui.presets.v1")).toContain("My preset (copy)");
  });

  it("imports an exchange string through the import panel", async () => {
    const w = mountApp();
    await w.find('button[data-test="open-import"]').trigger("click");
    await w.find('[data-test="import-name"]').setValue("from-game");
    await w.find('[data-test="import-string"]').setValue(presetStrings["Marathon"] as string);
    await w.find('button[data-test="import-confirm"]').trigger("click");
    const editSelect = w.find('select[data-test="edit-preset-select"]');
    expect((editSelect.element as HTMLSelectElement).value).toBe("from-game");
  });

  it("shows an error for an invalid import string without crashing", async () => {
    const w = mountApp();
    await w.find('button[data-test="open-import"]').trigger("click");
    await w.find('[data-test="import-name"]').setValue("bad");
    await w.find('[data-test="import-string"]').setValue("not a string");
    await w.find('button[data-test="import-confirm"]').trigger("click");
    expect(w.find('[data-test="import-error"]').text()).toContain("envelope");
  });

  it("offers a Preview tab", () => {
    const w = mountApp();
    expect(w.text()).toContain("Preview");
  });
});
