import { defineStore } from "pinia";
import { decodeExchangeString, encodeExchangeString } from "../codec/mapExchangeString";
import { getBuiltinPreset } from "../model/builtins";
import { presetFromDecoded, presetToEncodable } from "../model/convert";
import { builtinDefaultsFor, presetDiffersFromSource } from "../model/presetDiff";
import type { Preset } from "../model/types";
import { randomU32 } from "../util/seed";

export const STORAGE_KEY = "factorio-map-webui.presets.v1";

interface PersistedState {
  version: 1;
  userPresets: Preset[];
  activeName: string | null;
}

function loadPersisted(): PersistedState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.userPresets)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function seedState(): { userPresets: Preset[]; activeName: string | null } {
  const first = getBuiltinPreset("Default");
  first.name = "My preset";
  first.builtin = false;
  first.sourceBuiltin = "Default";
  // A new preset from a builtin defaults to a random seed; the baked fixture
  // seed is a capture artifact, not a meaningful choice.
  first.seed = null;
  return { userPresets: [first], activeName: first.name };
}

export const usePresetsStore = defineStore("presets", {
  state: () => {
    const persisted = loadPersisted();
    const base = persisted
      ? { userPresets: persisted.userPresets, activeName: persisted.activeName }
      : seedState();
    // Shared concrete seed for the previews when the active preset's seed is null
    // ("random each new map"), so both preview panels render the same map. Transient
    // (not persisted); see the previewSeed action.
    return { ...base, rolledSeed: null as number | null };
  },

  getters: {
    activePreset(state): Preset | undefined {
      return state.userPresets.find((p) => p.name === state.activeName);
    },

    activeExchangeString(): string | null {
      const active = this.activePreset;
      return active ? encodeExchangeString(presetToEncodable(active)) : null;
    },

    /**
     * Whether the active preset has been edited away from the built-in it came
     * from - i.e. whether Reset would change anything. Drives the Reset
     * button's disabled state. Always false when the origin is unknown (an
     * imported preset, or one saved before `sourceBuiltin` existed).
     */
    activeIsDirty(): boolean {
      return presetDiffersFromSource(this.activePreset);
    },
  },

  actions: {
    /**
     * The concrete seed the previews should render at, shared across both preview
     * panels so they stay in sync. An explicit preset seed always wins; a null-seed
     * ("random each new map") preset gets a sticky random seed, reused across
     * renders and only replaced when `reroll` is true.
     */
    previewSeed(reroll = false): number {
      const explicit = this.activePreset?.seed ?? null;
      if (explicit !== null) return explicit;
      if (reroll || this.rolledSeed === null) this.rolledSeed = randomU32();
      return this.rolledSeed;
    },

    uniqueName(base: string): string {
      const trimmed = base.trim() || "Preset";
      if (!this.userPresets.some((p) => p.name === trimmed)) return trimmed;
      let i = 2;
      while (this.userPresets.some((p) => p.name === `${trimmed} (${i})`)) i++;
      return `${trimmed} (${i})`;
    },

    selectPreset(name: string) {
      if (this.userPresets.some((p) => p.name === name)) {
        this.activeName = name;
      }
    },

    createFromBuiltin(builtinName: string, newName: string) {
      const preset = getBuiltinPreset(builtinName);
      preset.name = this.uniqueName(newName);
      preset.builtin = false;
      preset.sourceBuiltin = builtinName;
      // New presets from a builtin default to a random seed (see seedState).
      preset.seed = null;
      this.userPresets.push(preset);
      this.activeName = preset.name;
      this.saveToStorage();
    },

    /**
     * Overwrite the active preset's values with a built-in's, keeping its name
     * and active status, so every tab's sliders update to match. Follows the
     * same conventions as `createFromBuiltin` (user-owned, random-each-map
     * seed). `getBuiltinPreset` returns a deep clone, so the active preset never
     * shares references with the built-in cache.
     */
    applyBuiltinToActive(builtinName: string) {
      const active = this.activePreset;
      if (!active) return;
      const source = getBuiltinPreset(builtinName);
      source.name = active.name;
      source.builtin = false;
      source.sourceBuiltin = builtinName;
      source.seed = null;
      Object.assign(active, source);
      this.saveToStorage();
    },

    /**
     * Restore the active preset's map-gen values to the built-in it came from,
     * leaving the fields that are the user's rather than the built-in's:
     *
     * - `name`, because Reset restores settings, not identity.
     * - `seed`, which is the deviation from `applyBuiltinToActive` (that one
     *   nulls it). Resetting the sliders must not silently discard the seed the
     *   previews are rendering, and a seed is not part of a built-in's defaults
     *   anyway - `createFromBuiltin` randomizes it precisely because the
     *   fixture's baked seed is a capture artifact.
     * - `builtin` / `sourceBuiltin`, so the preset stays user-owned and keeps
     *   its origin - Reset has to survive the next round of edits.
     *
     * A no-op when nothing is active, or when the origin is unknown or names a
     * built-in this build no longer ships.
     */
    resetActiveToBuiltin() {
      const active = this.activePreset;
      // A deep clone, so the active preset never shares references with the
      // built-in cache and a later edit cannot corrupt the defaults.
      const defaults = builtinDefaultsFor(active);
      if (!active || !defaults) return;
      defaults.name = active.name;
      defaults.seed = active.seed;
      defaults.builtin = false;
      defaults.sourceBuiltin = active.sourceBuiltin;
      Object.assign(active, defaults);
      this.saveToStorage();
    },

    importExchangeString(name: string, exchangeString: string) {
      const decoded = decodeExchangeString(exchangeString);
      const preset = presetFromDecoded(this.uniqueName(name), decoded);
      this.userPresets.push(preset);
      this.activeName = preset.name;
      this.saveToStorage();
    },

    duplicateActive() {
      const active = this.activePreset;
      if (!active) return;
      const copy = structuredClone(toRawPreset(active));
      copy.name = this.uniqueName(`${active.name} (copy)`);
      this.userPresets.push(copy);
      this.activeName = copy.name;
      this.saveToStorage();
    },

    deleteActive() {
      const index = this.userPresets.findIndex((p) => p.name === this.activeName);
      if (index === -1) return;
      this.userPresets.splice(index, 1);
      this.activeName = this.userPresets[0]?.name ?? null;
      this.saveToStorage();
    },

    saveToStorage() {
      const persisted: PersistedState = {
        version: 1,
        userPresets: this.userPresets,
        activeName: this.activeName,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    },
  },
});

/** structuredClone cannot clone Vue reactive proxies; strip via JSON. Presets are JSON-safe by design. */
function toRawPreset(preset: Preset): Preset {
  return JSON.parse(JSON.stringify(preset)) as Preset;
}
