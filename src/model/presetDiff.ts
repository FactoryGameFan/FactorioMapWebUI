import { BUILTIN_NAMES, getBuiltinPreset } from "./builtins";
import type { Preset } from "./types";

/**
 * Fields that belong to the preset rather than to the built-in it came from.
 * Reset preserves them, so a difference in one of them is not a reason to
 * offer Reset in the first place.
 */
const USER_OWNED_FIELDS = ["name", "seed", "builtin", "sourceBuiltin"] as const;

/**
 * A deep copy with every object's keys in sorted order.
 *
 * Plain `JSON.stringify` preserves insertion order, and
 * `propertyExpressionNames` legitimately reorders during normal editing:
 * writing a climate value that snaps to its default notch DELETES the key
 * (see model/climateControls), and writing a non-default again re-inserts it
 * at the end. Two dictionaries with identical content would then serialize
 * differently, and a preset that exactly matches its built-in would look
 * edited.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

/** Order-independent serialization of everything a built-in actually owns. */
function comparable(preset: Preset): string {
  const values = { ...preset } as Record<string, unknown>;
  for (const field of USER_OWNED_FIELDS) delete values[field];
  return JSON.stringify(canonicalize(values));
}

/**
 * The built-in a preset should Reset to, or `undefined` when there is none -
 * an imported preset, a preset saved before `sourceBuiltin` existed, or a
 * recorded origin naming a built-in this build no longer ships. Returns a deep
 * clone (via `getBuiltinPreset`), so callers can mutate it freely.
 */
export function builtinDefaultsFor(preset: Preset | undefined): Preset | undefined {
  if (!preset?.sourceBuiltin) return undefined;
  if (!BUILTIN_NAMES.includes(preset.sourceBuiltin)) return undefined;
  return getBuiltinPreset(preset.sourceBuiltin);
}

/**
 * Whether a preset's map-gen values differ from the built-in it came from -
 * i.e. whether Reset would do anything. False when the origin is unknown:
 * there is nothing to be different from.
 */
export function presetDiffersFromSource(preset: Preset | undefined): boolean {
  const defaults = builtinDefaultsFor(preset);
  if (!preset || !defaults) return false;
  return comparable(preset) !== comparable(defaults);
}
