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
