import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import fixtures from "./fixtures/builtin-presets.json";
import { STORAGE_KEY, usePresetsStore } from "../src/store/presets";

const presets = fixtures.presets as Record<string, string>;

describe("preset origin (sourceBuiltin)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("records Default as the origin of the first-launch preset", () => {
    const store = usePresetsStore();
    expect(store.activePreset?.sourceBuiltin).toBe("Default");
  });

  it("records the origin of a preset created from a builtin", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Death world", "dw");
    expect(store.activePreset?.sourceBuiltin).toBe("Death world");
  });

  it("re-points the origin when a different builtin is applied to the active preset", () => {
    const store = usePresetsStore();
    store.applyBuiltinToActive("Rail world");
    expect(store.activePreset?.sourceBuiltin).toBe("Rail world");
  });

  it("leaves an imported preset with no origin - a pasted string came from nowhere", () => {
    const store = usePresetsStore();
    store.importExchangeString("imported", presets["Marathon"] as string);
    expect(store.activePreset?.sourceBuiltin).toBeUndefined();
  });

  it("survives a save/reload round trip", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Island", "isle");
    setActivePinia(createPinia());
    expect(usePresetsStore().activePreset?.sourceBuiltin).toBe("Island");
  });
});

describe("activeIsDirty", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("is false for an untouched preset", () => {
    const store = usePresetsStore();
    expect(store.activeIsDirty).toBe(false);
  });

  it("is true once an autoplace control moves, and false again when it moves back", () => {
    const store = usePresetsStore();
    const coal = store.activePreset!.autoplaceControls["coal"]!;
    const original = coal.frequency;
    coal.frequency = 3;
    expect(store.activeIsDirty).toBe(true);
    coal.frequency = original;
    expect(store.activeIsDirty).toBe(false);
  });

  it("is true for a climate override, and false again when the key is deleted", () => {
    const store = usePresetsStore();
    // Climate controls live purely in property_expression_names; snapping a
    // slider back to its default notch DELETES the key rather than writing the
    // default, which is what makes the round trip clean again.
    store.activePreset!.propertyExpressionNames["control:moisture:frequency"] = "2.000000";
    expect(store.activeIsDirty).toBe(true);
    delete store.activePreset!.propertyExpressionNames["control:moisture:frequency"];
    expect(store.activeIsDirty).toBe(false);
  });

  it("ignores property_expression_names key ORDER", () => {
    const store = usePresetsStore();
    // Lakes ships six entries, so a delete-and-reinsert genuinely reorders the
    // dictionary. Content is unchanged, so the preset is not dirty - a plain
    // JSON.stringify comparison would wrongly say it is.
    store.applyBuiltinToActive("Lakes");
    const pen = store.activePreset!.propertyExpressionNames;
    const originalOrder = Object.keys(pen);
    expect(originalOrder.length).toBeGreaterThan(1);

    const entries = Object.entries(pen);
    for (const [key] of entries) delete pen[key];
    for (const [key, value] of [...entries].reverse()) pen[key] = value;

    // The dictionary really is in a different order now...
    expect(Object.keys(pen)).toEqual([...originalOrder].reverse());
    // ...but holds exactly the same content, so nothing was edited.
    expect(store.activeIsDirty).toBe(false);
  });

  it("ignores the seed - it is not part of a builtin's defaults", () => {
    const store = usePresetsStore();
    store.activePreset!.seed = 123456;
    expect(store.activeIsDirty).toBe(false);
  });

  it("ignores the name", () => {
    const store = usePresetsStore();
    store.activePreset!.name = "renamed";
    store.activeName = "renamed";
    expect(store.activeIsDirty).toBe(false);
  });

  it("is true for a nested map-settings edit (Enemy tab)", () => {
    const store = usePresetsStore();
    store.activePreset!.mapSettings.enemyEvolution.timeFactor = 0.00009;
    expect(store.activeIsDirty).toBe(true);
  });

  it("is false for an imported preset - there is no builtin to be dirty against", () => {
    const store = usePresetsStore();
    store.importExchangeString("imported", presets["Marathon"] as string);
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    expect(store.activeIsDirty).toBe(false);
  });

  it("is false when there is no active preset", () => {
    const store = usePresetsStore();
    store.activeName = null;
    expect(store.activeIsDirty).toBe(false);
  });

  it("is false when the recorded origin names a builtin that no longer exists", () => {
    const store = usePresetsStore();
    store.activePreset!.sourceBuiltin = "Nonexistent preset";
    expect(store.activeIsDirty).toBe(false);
  });
});

describe("resetActiveToBuiltin", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("restores the builtin's values", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Death world", "dw");
    store.activePreset!.autoplaceControls["enemy-base"]!.frequency = 99;
    expect(store.activeIsDirty).toBe(true);

    store.resetActiveToBuiltin();

    expect(store.activePreset?.autoplaceControls["enemy-base"]?.frequency).toBe(2);
    expect(store.activeIsDirty).toBe(false);
  });

  it("keeps the preset's name and its active status", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Rich Resources", "richer");
    store.activePreset!.autoplaceControls["coal"]!.size = 4;

    store.resetActiveToBuiltin();

    expect(store.activeName).toBe("richer");
    expect(store.activePreset?.name).toBe("richer");
  });

  it("keeps the current seed - resetting the sliders must not throw away the map", () => {
    const store = usePresetsStore();
    store.activePreset!.seed = 987654;
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;

    store.resetActiveToBuiltin();

    expect(store.activePreset?.seed).toBe(987654);
  });

  it("keeps a null (random-each-map) seed null", () => {
    const store = usePresetsStore();
    expect(store.activePreset?.seed).toBeNull();
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;

    store.resetActiveToBuiltin();

    expect(store.activePreset?.seed).toBeNull();
  });

  it("keeps the preset user-owned and keeps its origin, so Reset stays available", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Rail world", "rw");
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;

    store.resetActiveToBuiltin();

    expect(store.activePreset?.builtin).toBe(false);
    expect(store.activePreset?.sourceBuiltin).toBe("Rail world");
    // And a second edit-then-reset cycle still works.
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    expect(store.activeIsDirty).toBe(true);
    store.resetActiveToBuiltin();
    expect(store.activeIsDirty).toBe(false);
  });

  it("replaces the whole control set rather than merging overlapping keys", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Lakes", "lk");
    // Lakes carries six property_expression_names entries; an edit that adds a
    // seventh must not survive the reset.
    store.activePreset!.propertyExpressionNames["control:aux:bias"] = "0.500000";

    store.resetActiveToBuiltin();

    expect(store.activePreset?.propertyExpressionNames["control:aux:bias"]).toBeUndefined();
    expect(store.activePreset?.propertyExpressionNames["elevation"]).toBe("elevation_lakes");
  });

  it("does not share references with the builtin cache", () => {
    const store = usePresetsStore();
    store.resetActiveToBuiltin();
    store.activePreset!.autoplaceControls["coal"]!.frequency = 99;
    // If reset handed out the cached builtin itself, this second reset would
    // restore the mutated 99 instead of the real default.
    store.resetActiveToBuiltin();
    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(1);
  });

  it("persists immediately", () => {
    const store = usePresetsStore();
    store.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    store.resetActiveToBuiltin();

    setActivePinia(createPinia());
    expect(usePresetsStore().activePreset?.autoplaceControls["coal"]?.frequency).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("My preset");
  });

  it("is a no-op for an imported preset with no origin", () => {
    const store = usePresetsStore();
    store.importExchangeString("imported", presets["Marathon"] as string);
    store.activePreset!.autoplaceControls["coal"]!.frequency = 7;

    expect(() => store.resetActiveToBuiltin()).not.toThrow();

    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(7);
  });

  it("is a no-op when nothing is active", () => {
    const store = usePresetsStore();
    store.activeName = null;
    expect(() => store.resetActiveToBuiltin()).not.toThrow();
    expect(store.activePreset).toBeUndefined();
  });

  it("is a no-op when the recorded origin names a builtin that no longer exists", () => {
    const store = usePresetsStore();
    store.activePreset!.sourceBuiltin = "Nonexistent preset";
    store.activePreset!.autoplaceControls["coal"]!.frequency = 7;

    expect(() => store.resetActiveToBuiltin()).not.toThrow();

    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(7);
  });
});

describe("presets saved before sourceBuiltin existed", () => {
  beforeEach(() => localStorage.clear());

  it("load, stay clean, and ignore Reset rather than crashing", () => {
    // A v1 payload written by an older build: no sourceBuiltin anywhere. The
    // field is optional precisely so this needs no migration.
    setActivePinia(createPinia());
    const seeded = usePresetsStore();
    seeded.activePreset!.autoplaceControls["coal"]!.frequency = 3;
    seeded.saveToStorage();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as {
      userPresets: { sourceBuiltin?: string }[];
    };
    for (const p of raw.userPresets) delete p.sourceBuiltin;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));

    setActivePinia(createPinia());
    const store = usePresetsStore();

    expect(store.activePreset?.sourceBuiltin).toBeUndefined();
    expect(store.activeIsDirty).toBe(false);
    expect(() => store.resetActiveToBuiltin()).not.toThrow();
    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(3);
  });
});
