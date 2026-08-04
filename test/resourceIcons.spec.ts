import { describe, expect, it } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { CONTROL_CATALOG, controlsForCategory } from "../src/model/controlCatalog";
import { RESOURCE_ICONS } from "../src/model/resourceIcons";
import ResourcesTab from "../src/components/ResourcesTab.vue";
import TerrainTab from "../src/components/TerrainTab.vue";

describe("resource icons", () => {
  it("maps every resource control to an icon asset URL", () => {
    // Asserts the SHAPE of the value, not merely that one exists (#144). The
    // whole point of the map is that each entry is a bundled `.png` asset URL,
    // and `toBeTruthy()` was equally happy with `"x"` or `true` - i.e. with a
    // key that would render a broken image.
    for (const name of controlsForCategory("resource")) {
      expect(RESOURCE_ICONS[name], name).toMatch(/\.png($|\?)/);
    }
  });

  it("maps only resource controls (no stray keys)", () => {
    for (const name of Object.keys(RESOURCE_ICONS)) {
      expect(CONTROL_CATALOG[name]?.category, name).toBe("resource");
    }
  });
});

describe("resource icons in rows", () => {
  it("renders an item icon with a src on every resource row", () => {
    setActivePinia(createPinia());
    const wrapper = mount(ResourcesTab);
    const icons = wrapper.findAll('[data-test="resource-icon"]');
    expect(icons.length).toBe(15); // 15 resource controls across all planets
    for (const img of icons) {
      expect(img.attributes("src")).toBeTruthy();
    }
  });

  it("renders no item icons on the Terrain tab", () => {
    setActivePinia(createPinia());
    const wrapper = mount(TerrainTab);
    expect(wrapper.findAll('[data-test="resource-icon"]').length).toBe(0);
  });
});
