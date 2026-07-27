import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import PresetBar from "../src/components/PresetBar.vue";
import { usePresetsStore } from "../src/store/presets";
import fixtures from "./fixtures/builtin-presets.json";

const presets = fixtures.presets as Record<string, string>;

// A fresh pinia is not a fresh store: several actions here (createFromBuiltin,
// applyBuiltinToActive, resetActiveToBuiltin) call saveToStorage, and the store
// rehydrates from localStorage on construction. Without this, one test's
// created preset becomes the next test's "first launch" state.
beforeEach(() => localStorage.clear());

describe("PresetBar seed reroll", () => {
  afterEach(() => vi.restoreAllMocks());

  it("assigns a fresh concrete seed on click (which un-checks random-each-map)", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    // Deterministic reroll: Math.random -> 0.5.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const wrapper = mount(PresetBar);

    await wrapper.find('[data-test="seed-reroll"]').trigger("click");

    // 1 + floor(0.5 * 0xffffffff)
    expect(store.activePreset?.seed).toBe(2147483648);
    // "Random each new map" is derived from the seed: a concrete seed un-checks it.
    const checkbox = wrapper.find('[data-test="random-each-map"] input')
      .element as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // The seed input is now editable (not disabled) and shows the value.
    const input = wrapper.find('[data-test="seed-input"]').element as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("2147483648");
  });

  it("checking random-each-map clears the seed to null and disables the input", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const wrapper = mount(PresetBar);
    // Start from a concrete seed so we can watch it clear.
    await wrapper.find('[data-test="seed-reroll"]').trigger("click");
    expect(store.activePreset?.seed).not.toBeNull();

    await wrapper.find('[data-test="random-each-map"] input').setValue(true);

    expect(store.activePreset?.seed).toBeNull();
    const input = wrapper.find('[data-test="seed-input"]').element as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("un-checking random-each-map assigns a concrete seed", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const wrapper = mount(PresetBar);
    // First-launch preset starts random (null seed).
    expect(store.activePreset?.seed).toBeNull();

    await wrapper.find('[data-test="random-each-map"] input').setValue(false);

    expect(store.activePreset?.seed).toBe(2147483648);
  });

  it("produces a u32-range integer seed", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(PresetBar);

    await wrapper.find('[data-test="seed-reroll"]').trigger("click");

    const seed = store.activePreset?.seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(1);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("PresetBar Reset button", () => {
  it("is disabled on an untouched preset and enabled once one is edited", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(PresetBar);
    const reset = () => wrapper.find('[data-test="reset-preset"]').element as HTMLButtonElement;

    expect(reset().disabled).toBe(true);

    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    await wrapper.vm.$nextTick();

    expect(reset().disabled).toBe(false);
  });

  it("restores the builtin defaults on click and disables itself again", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(PresetBar);
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test="reset-preset"]').trigger("click");

    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(1);
    const reset = wrapper.find('[data-test="reset-preset"]').element as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
  });

  it("stays disabled for an imported preset, which has no defaults to restore", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.importExchangeString("imported", presets["Marathon"] as string);
    const wrapper = mount(PresetBar);
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    await wrapper.vm.$nextTick();

    const reset = wrapper.find('[data-test="reset-preset"]').element as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(reset.title).toContain("imported");
  });

  it("names the builtin it would restore in its tooltip", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Death world", "dw");
    const wrapper = mount(PresetBar);
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    await wrapper.vm.$nextTick();

    const reset = wrapper.find('[data-test="reset-preset"]').element as HTMLButtonElement;
    expect(reset.title).toContain("Death world");
  });
});

describe("PresetBar builtin dropdown", () => {
  it("loads the picked builtin's values into the active preset", async () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    const wrapper = mount(PresetBar);
    // First-launch active preset is a Default clone (coal richness 1).
    expect(store.activePreset?.autoplaceControls["coal"]?.richness).toBe(1);

    await wrapper.find('select[data-test="builtin-select"]').setValue("Rich Resources");

    // The same preset stays active; its slider-backing values now match the builtin.
    expect(store.activePreset?.name).toBe("My preset");
    expect(store.activePreset?.autoplaceControls["coal"]?.richness).toBe(2);
  });
});
