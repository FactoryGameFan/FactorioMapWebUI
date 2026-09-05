/**
 * Fulgora's one resource: scrap.
 *
 * **This module is a table, not an engine.** Scrap's probability expression,
 * its placement roll and its collision box were ported to Rust and live in
 * `crates/fmw-noise/src/expressions/fulgora_scrap.rs` and
 * `crates/fmw-noise/src/resources/fulgora_catalog.rs`; #371 deleted the
 * TypeScript they replaced. What survives here is the map colour, which
 * `test/elevationRenderRequest.spec.ts` grades the engine's pixels against.
 *
 * Deliberately an independent copy of the Rust constant rather than a read of
 * it - a spec that imported the engine's own number would assert nothing.
 */

/**
 * `map_color = {0.9, 0.9, 0.9}` from the prototype, times 255 - and TRUNCATED,
 * since 229.5 lands on 229 in the game's own preview PNG. Confirmed against
 * those pixels: 1098 of 1825 changed pixels are exactly this triple.
 */
export const SCRAP_MAP_COLOR: readonly [number, number, number] = [229, 229, 229];
