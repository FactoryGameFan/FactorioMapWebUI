import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { bytesToBase64 } from "../src/codec/base64";
import { deflateLevel9 } from "../src/codec/deflate";
import {
  decodeExchangeString,
  encodePayload,
  ExchangeStringError,
} from "../src/codec/mapExchangeString";
import { STORAGE_KEY, usePresetsStore } from "../src/store/presets";
import fixtures from "./fixtures/builtin-presets.json";

const presets = fixtures.presets as Record<string, string>;

/** Re-encode a preset string with its mid-block seed overwritten. */
function withSeed(name: string, seed: number): string {
  const decoded = decodeExchangeString(presets[name] as string);
  const edited = { ...decoded, mid: { ...decoded.mid, seed } };
  return `>>>${bytesToBase64(deflateLevel9(encodePayload(edited)))}<<<`;
}

describe("presets store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('seeds a "My preset" clone of Default on first launch', () => {
    const store = usePresetsStore();
    expect(store.userPresets.map((p) => p.name)).toEqual(["My preset"]);
    expect(store.activePreset?.autoplaceControls["coal"]?.frequency).toBe(1);
    expect(store.activePreset?.builtin).toBe(false);
  });

  it("creates a preset from a builtin and makes it active", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Rich Resources", "richer");
    expect(store.activeName).toBe("richer");
    expect(store.activePreset?.autoplaceControls["coal"]?.richness).toBe(2);
  });

  it("starts the first-launch preset with a random (null) seed", () => {
    const store = usePresetsStore();
    expect(store.activePreset?.seed).toBeNull();
  });

  it("starts a preset created from a builtin with a random (null) seed", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Rich Resources", "richer");
    expect(store.activePreset?.seed).toBeNull();
  });

  it("applies a builtin's values onto the active preset, keeping its name", () => {
    const store = usePresetsStore();
    const originalName = store.activeName;
    store.applyBuiltinToActive("Rich Resources");
    // Same preset stays active; only its values change.
    expect(store.activeName).toBe(originalName);
    expect(store.activePreset?.name).toBe("My preset");
    expect(store.activePreset?.autoplaceControls["coal"]?.richness).toBe(2);
    expect(store.activePreset?.builtin).toBe(false);
    // Follows the create-from-builtin convention: random each new map.
    expect(store.activePreset?.seed).toBeNull();
    // Persisted immediately.
    expect(localStorage.getItem(STORAGE_KEY)).toContain("My preset");
  });

  it("applyBuiltinToActive replaces the whole control set, not just overlapping keys", () => {
    const store = usePresetsStore();
    store.applyBuiltinToActive("Death world");
    expect(store.activePreset?.autoplaceControls["enemy-base"]?.frequency).toBe(2);
    store.applyBuiltinToActive("Default");
    expect(store.activePreset?.autoplaceControls["enemy-base"]?.frequency).toBe(1);
  });

  it("applies a private copy: editing the active preset never mutates the builtin cache", () => {
    const store = usePresetsStore();
    store.applyBuiltinToActive("Death world");
    store.activePreset!.autoplaceControls["enemy-base"]!.frequency = 99;
    // Re-applying the same builtin must restore the real value, proving no shared reference.
    store.applyBuiltinToActive("Death world");
    expect(store.activePreset?.autoplaceControls["enemy-base"]?.frequency).toBe(2);
  });

  it("applyBuiltinToActive is a no-op when nothing is active", () => {
    const store = usePresetsStore();
    store.activeName = null;
    expect(() => store.applyBuiltinToActive("Default")).not.toThrow();
    expect(store.activePreset).toBeUndefined();
  });

  it("keeps the concrete seed when importing a string that carries one", () => {
    const store = usePresetsStore();
    store.importExchangeString("pinned", withSeed("Default", 123456789));
    expect(store.activePreset?.seed).toBe(123456789);
  });

  it("treats an imported wire seed of 0 as random (null)", () => {
    const store = usePresetsStore();
    store.importExchangeString("randomish", withSeed("Default", 0));
    expect(store.activePreset?.seed).toBeNull();
  });

  it("deduplicates preset names", () => {
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "My preset");
    expect(store.activeName).toBe("My preset (2)");
  });

  it("persists on save and restores across a fresh pinia", () => {
    const store = usePresetsStore();
    const coal = store.activePreset?.autoplaceControls["coal"];
    if (coal) coal.frequency = 3;
    store.saveToStorage();

    setActivePinia(createPinia());
    const reloaded = usePresetsStore();
    expect(reloaded.activePreset?.autoplaceControls["coal"]?.frequency).toBe(3);
  });

  it("imports a valid exchange string as a new preset", () => {
    const store = usePresetsStore();
    store.importExchangeString("imported", presets["Marathon"] as string);
    expect(store.activeName).toBe("imported");
    expect(store.activePreset?.formatVersion).toEqual([2, 1, 9, 3]);
  });

  it("propagates ExchangeStringError on invalid import and leaves state unchanged", () => {
    const store = usePresetsStore();
    expect(() => store.importExchangeString("bad", "garbage")).toThrow(ExchangeStringError);
    expect(store.userPresets).toHaveLength(1);
  });

  it("duplicate and delete work and persist", () => {
    const store = usePresetsStore();
    store.duplicateActive();
    expect(store.activeName).toBe("My preset (copy)");
    store.deleteActive();
    expect(store.activeName).toBe("My preset");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string).userPresets).toHaveLength(1);
  });

  it("survives corrupted localStorage by reseeding", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const store = usePresetsStore();
    expect(store.userPresets).toHaveLength(1);
  });

  it("exposes an activeExchangeString that decodes back to the active preset", () => {
    const store = usePresetsStore();
    const active = store.activePreset;
    expect(active).toBeDefined();
    const encoded = store.activeExchangeString;
    expect(encoded).not.toBeNull();
    const decoded = decodeExchangeString(encoded as string);
    expect(Object.keys(decoded.autoplaceControls)).toEqual(
      Object.keys((active as NonNullable<typeof active>).autoplaceControls).sort(),
    );
    expect(decoded.version).toEqual([2, 1, 9, 3]);

    // Values (not just keys) must survive the store's presetToEncodable ->
    // encode -> decode bridge; this is the only test that exercises that path
    // for autoplace scalars. Wire scalars are float32, so compare via fround.
    const coal = (active as NonNullable<typeof active>).autoplaceControls["coal"];
    expect(coal).toBeDefined();
    expect(decoded.autoplaceControls["coal"]).toEqual({
      frequency: Math.fround(coal.frequency),
      size: Math.fround(coal.size),
      richness: Math.fround(coal.richness),
    });
  });

  it("rebuilds cliffSettings from the tail when it loads presets saved with the old wrong labels", () => {
    // Before 2026-11 the codec read smoothing as 0 and put the smoothing float
    // in the richness slot, so saved presets carry those values.
    const store = usePresetsStore();
    const saved = JSON.parse(JSON.stringify(store.activePreset)) as NonNullable<
      typeof store.activePreset
    >;
    saved.cliffSettings = { ...saved.cliffSettings, cliffSmoothing: 0, richness: 3 };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, userPresets: [saved], activeName: saved.name }),
    );

    setActivePinia(createPinia());
    const reloaded = usePresetsStore();
    expect(reloaded.activePreset?.cliffSettings.cliffSmoothing).toBeCloseTo(1, 6);
    expect(reloaded.activePreset?.cliffSettings.richness).toBeCloseTo(1, 6);
  });

  it("exposes typed map width/height on the active preset and persists edits", () => {
    const store = usePresetsStore();
    expect(store.activePreset?.width).toBe(2000000);
    expect(store.activePreset?.height).toBe(2000000);

    const active = store.activePreset;
    if (active) active.height = 128;
    store.saveToStorage();

    setActivePinia(createPinia());
    const reloaded = usePresetsStore();
    expect(reloaded.activePreset?.height).toBe(128);

    // The edited height must survive the encode bridge, not just localStorage.
    const encoded = reloaded.activeExchangeString as string;
    expect(decodeExchangeString(encoded).mid.height).toBe(128);
  });

  it("exposes typed nested mapSettings/cliffSettings views, and the encoded string still carries diffusionRatio", () => {
    const store = usePresetsStore();
    expect(store.activePreset?.mapSettings.pollution.diffusionRatio).toBe(0.02);
    expect(store.activePreset?.cliffSettings.cliffSmoothing).toBeCloseTo(1, 6);

    // Nested views are derived read-only display data; they must not affect
    // the encode bridge, which still rebuilds the tail from opaqueTailB64.
    const encoded = store.activeExchangeString as string;
    const decoded = decodeExchangeString(encoded);
    expect(decoded.tail["pollution.diffusionRatio"]).toBeCloseTo(0.02, 9);
  });
});

describe("presets store previewSeed (shared between preview panels)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("returns the explicit preset seed when one is set", () => {
    const store = usePresetsStore();
    store.activePreset!.seed = 42;
    expect(store.previewSeed()).toBe(42);
    expect(store.previewSeed(true)).toBe(42); // reroll cannot override an explicit seed
    expect(store.rolledSeed).toBeNull(); // and it never rolls one
  });

  it("rolls one sticky random seed for a null-seed preset and reuses it", () => {
    const store = usePresetsStore();
    store.activePreset!.seed = null;
    const first = store.previewSeed();
    expect(typeof first).toBe("number");
    // Repeated calls (e.g. both panels rendering) return the SAME seed - the sync.
    expect(store.previewSeed()).toBe(first);
    expect(store.previewSeed()).toBe(first);
    expect(store.rolledSeed).toBe(first);
  });

  it("re-roll replaces the shared seed", () => {
    const store = usePresetsStore();
    store.activePreset!.seed = null;
    const first = store.previewSeed();
    const rerolled = store.previewSeed(true);
    expect(rerolled).not.toBe(first);
    // ... and the new seed is now the sticky shared one for both panels.
    expect(store.previewSeed()).toBe(rerolled);
  });
});
