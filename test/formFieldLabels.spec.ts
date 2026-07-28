import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import App from "../src/App.vue";
import AdvancedTab from "../src/components/AdvancedTab.vue";
import ElevationPreviewPanel from "../src/components/ElevationPreviewPanel.vue";
import EnemyTab from "../src/components/EnemyTab.vue";
import ImportPanel from "../src/components/ImportPanel.vue";
import PresetBar from "../src/components/PresetBar.vue";
import PreviewPanel from "../src/components/PreviewPanel.vue";
import ResourcesTab from "../src/components/ResourcesTab.vue";
import TerrainTab from "../src/components/TerrainTab.vue";

/**
 * Regressions for issue #15. Lighthouse scores this app 100 because every
 * control does have *an* accessible name - the defect was that 45 sliders all
 * had the *same* one ("Percentage"), which no automated audit can see. So the
 * assertions here are about names being **present, distinguishing, and unique**
 * within a screen, not merely non-empty.
 */

/**
 * The accessible name a screen reader would compute, restricted to the sources
 * this app actually uses: aria-label, aria-labelledby, a wrapping <label>, and
 * an associated <label for>. Deliberately does NOT fall back to `placeholder` -
 * that fallback is exactly what hid two unlabelled inputs from axe.
 */
function accessibleName(root: Element, el: Element): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;

  const labelledBy = el.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }

  const wrapping = el.closest("label");
  if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

  const id = el.getAttribute("id");
  if (id) {
    const forLabel = root.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel?.textContent?.trim()) return forLabel.textContent.trim();
  }

  return "";
}

function describeField(el: Element): string {
  const test = el.getAttribute("data-test") ?? "";
  return `${widgetKind(el)}${test ? `[data-test=${test}]` : ""}`;
}

/**
 * Stands in for the ARIA role a screen reader announces alongside the name.
 * It is half of a control's identity: an Enemy-tab row's slider and its number
 * box edit one value and share one name on purpose, and "slider" vs "spin
 * button" is what tells the user which of the two they have landed on.
 */
function widgetKind(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return tag === "input" ? `input[type=${el.getAttribute("type") ?? "text"}]` : tag;
}

const FIELDS = "input, select, textarea";

/** Every screen that renders form fields, mounted the way the app renders it. */
const SCREENS: Record<string, () => ReturnType<typeof mount>> = {
  App: () => mount(App),
  ResourcesTab: () => mount(ResourcesTab),
  TerrainTab: () => mount(TerrainTab),
  EnemyTab: () => mount(EnemyTab),
  AdvancedTab: () => mount(AdvancedTab),
  PresetBar: () => mount(PresetBar),
  ImportPanel: () => mount(ImportPanel),
  PreviewPanel: () => mount(PreviewPanel, { props: { planet: "nauvis" } }),
  ElevationPreviewPanel: () => mount(ElevationPreviewPanel, { props: { planet: "nauvis" } }),
};

describe("form fields: every control has an accessible name", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  for (const [name, mountScreen] of Object.entries(SCREENS)) {
    it(`names every field in ${name}`, () => {
      const root = mountScreen().element as Element;
      const fields = [...root.querySelectorAll(FIELDS)];
      expect(fields.length, `${name} renders no form fields`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(
          accessibleName(root, field),
          `${name} > ${describeField(field)} has no accessible name`,
        ).toBeTruthy();
      }
    });
  }
});

describe("form fields: names distinguish one control from another", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  for (const [name, mountScreen] of Object.entries(SCREENS)) {
    it(`gives every field in ${name} a unique name for its widget kind`, () => {
      const root = mountScreen().element as Element;
      const ids = [...root.querySelectorAll(FIELDS)].map(
        (f) => `${widgetKind(f)}: ${accessibleName(root, f)}`,
      );
      const duplicates = ids.filter((n, i) => ids.indexOf(n) !== i);
      expect([...new Set(duplicates)], `${name} repeats these accessible names`).toEqual([]);
    });
  }

  // The headline symptom: 15 resources x frequency/size/richness, all called
  // "Percentage" before the fix.
  it("names each Resources slider after its resource and its axis", () => {
    const root = mount(ResourcesTab).element as Element;
    const sliders = [...root.querySelectorAll('input[type="range"]')];
    expect(sliders.length).toBe(45);
    const names = sliders.map((s) => accessibleName(root, s));
    expect(names).toContain("Iron ore frequency");
    expect(names).toContain("Iron ore size");
    expect(names).toContain("Iron ore richness");
    expect(names.filter((n) => n === "Percentage")).toEqual([]);
  });

  // Three labels appear on two planets each (Coal, Stone, Crude oil), so the
  // label alone is not unique in the single all-planets table.
  it("distinguishes controls two planets share a label for", () => {
    const root = mount(ResourcesTab).element as Element;
    const names = [...root.querySelectorAll('input[type="range"]')].map((s) =>
      accessibleName(root, s),
    );
    expect(names).toContain("Coal (Nauvis) frequency");
    expect(names).toContain("Coal (Vulcanus) frequency");
  });

  it("names the terrain climate sliders by row and axis", () => {
    const root = mount(TerrainTab).element as Element;
    const names = [...root.querySelectorAll('input[type="range"]')].map((s) =>
      accessibleName(root, s),
    );
    expect(names).toContain("Moisture scale");
    expect(names).toContain("Moisture bias");
    expect(names).toContain("Terrain type scale");
    expect(names).toContain("Terrain type bias");
  });

  it("names the enemy value rows' slider and number box", () => {
    const root = mount(EnemyTab).element as Element;
    const row = root.querySelector('[data-test="enemy-exp-min-dist"]');
    expect(row).toBeTruthy();
    const slider = row?.querySelector('input[type="range"]');
    const box = row?.querySelector('input[type="number"]');
    expect(accessibleName(root, slider!)).toContain("Minimum expansion distance");
    expect(accessibleName(root, box!)).toContain("Minimum expansion distance");
  });
});

describe("form fields: placeholder is never the only name (issue #15 item 2)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("labels the new-preset name and seed inputs explicitly", () => {
    const root = mount(PresetBar).element as Element;
    for (const test of ["new-preset-name", "seed-input"]) {
      const input = root.querySelector(`[data-test="${test}"]`);
      expect(input, test).toBeTruthy();
      expect(input?.getAttribute("aria-label")?.trim(), test).toBeTruthy();
    }
  });

  it("labels the import panel's name input and exchange-string textarea", () => {
    const root = mount(ImportPanel).element as Element;
    for (const test of ["import-name", "import-string"]) {
      const field = root.querySelector(`[data-test="${test}"]`);
      expect(field, test).toBeTruthy();
      expect(field?.getAttribute("aria-label")?.trim(), test).toBeTruthy();
    }
  });
});

describe("form fields: id present and unique (issue #15 item 3)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  for (const [name, mountScreen] of Object.entries(SCREENS)) {
    it(`gives every field in ${name} an id`, () => {
      const root = mountScreen().element as Element;
      const fields = [...root.querySelectorAll(FIELDS)];
      for (const field of fields) {
        // Chrome's Issues panel wants an id *or* a name; this app has no form
        // and submits nothing, so id is the one that carries its weight (it is
        // what a <label for> would need).
        expect(field.id, `${name} > ${describeField(field)} has no id`).toBeTruthy();
      }
      const ids = fields.map((f) => f.id);
      expect(new Set(ids).size, `${name} reuses an id`).toBe(ids.length);
    });
  }
});
