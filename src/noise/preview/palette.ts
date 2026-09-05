/**
 * Colours the map preview paints with, kept apart from the renderers so they
 * outlive them. #227 deletes the TypeScript renderers these were declared in;
 * the Rust engine now does the painting and these values are what the surviving
 * parity specs grade its output against.
 *
 * Deliberately an independent copy of the Rust constants rather than a read of
 * them - a spec that imported the engine's own numbers would assert nothing.
 * The mirrors are `crates/fmw-wasm/src/render.rs:156` and `:159` for the
 * elevation pair, and `crates/fmw-noise/src/trees/catalog.rs:69` for the tree
 * colour. Rust stores RGB and writes the alpha separately.
 */

/** RGBA for water (elevation < 0) and land, as [r, g, b, a] byte tuples. */
export const WATER_RGBA: readonly [number, number, number, number] = [40, 90, 150, 255];
export const LAND_RGBA: readonly [number, number, number, number] = [70, 120, 60, 255];

/** `{0.19, 0.39, 0.19}` in 8-bit - utility-constants.lua:201. */
export const TREE_MAP_COLOR: readonly [number, number, number] = [48, 99, 48];

/**
 * Fulgora's two ocean colours, from `space-age/prototypes/tile/tiles-fulgora.lua`.
 * `oil-ocean-shallow` and `-shallow-2` both declare `{74, 42, 43}`, and
 * `oil-ocean-deep` and `-deep-2` both declare `{49*1.15, 31*1.15, 35*1.15}`,
 * which is why a land mask only has to know two triples and never which
 * variant of each. Mirrors `SHALLOW` and `DEEP` in `crates/fmw-wasm/src/render.rs`.
 */
export const FULGORA_SHALLOW_RGB: readonly [number, number, number] = [74, 42, 43];
/**
 * `(56.35, 35.65, 40.25)` TRUNCATED, not rounded. Green is the only channel that
 * can tell the two rules apart: 35.65 rounds to 36 under every rounding rule,
 * and the game's own `--generate-map-preview` PNG
 * (`test/fixtures/oracle-preview-fulgora-terrain.seed123456.png`) shows 35 at
 * every one of the 370,891 deep-ocean pixels sampled. `SCRAP_MAP_COLOR`'s
 * 0.9*255 = 229.5 landing on 229 in the same PNG is the second, independent
 * case. Written as the truncation so the reading stays visible.
 */
export const FULGORA_DEEP_RGB: readonly [number, number, number] = [
  Math.floor(49 * 1.15),
  Math.floor(31 * 1.15),
  Math.floor(35 * 1.15),
];

/**
 * The colours that mean "not land" in a Fulgora terrain render - what
 * `islands/islandMask.ts` reads the engine's pixels against. Derived from the
 * two constants above rather than written out again: a second hardcoded copy
 * would drift the first time a tile colour is corrected, and one already was.
 */
export const FULGORA_OCEAN_RGB: readonly (readonly [number, number, number])[] = [
  FULGORA_SHALLOW_RGB,
  FULGORA_DEEP_RGB,
];
