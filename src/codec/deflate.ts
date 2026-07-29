import { deflate as pakoDeflate, inflate as pakoInflate } from "pako";

export function inflate(bytes: Uint8Array): Uint8Array {
  return pakoInflate(bytes);
}

/**
 * zlib deflate pinned to level 9 (Z_BEST_COMPRESSION) to match the `78 da`
 * streams Factorio emits, byte-for-byte, on all 9 fixtures.
 *
 * `legacyHash: true` is NOT optional and NOT cosmetic. pako 2.2.0 added a
 * second deflate hash function; pako 3.0.0 made it the default. That newer
 * hash produces valid but DIFFERENT deflate output from canonical madler zlib,
 * so at pako's own defaults this function matches 0 of 9 fixtures. With
 * `legacyHash: true` it matches 9 of 9, identically to `node:zlib` 1.2.12 at
 * level 9. The requirement is madler-zlib-compatible output at level 9 - pako
 * can produce it, but only when asked.
 *
 * `test/deflate.spec.ts` guards both the option and the bytes. Do not drop the
 * option, and do not change the level: byte-identical string export (spec
 * Section 6) depends on both.
 */
export function deflateLevel9(bytes: Uint8Array): Uint8Array {
  return pakoDeflate(bytes, { level: 9, legacyHash: true });
}
