/**
 * Which Factorio this build targets, for display in the UI.
 *
 * **Why this is surfaced at all.** The app decodes a versioned binary format, and
 * on 2026-07-28 the fixture audit (#7) found it had been rejecting map-exchange
 * strings copied from the current game: Factorio moved the format tag from
 * `2.1.9.3` to `2.1.12.2` and nothing in the app said which it spoke, so the only
 * symptom a user saw was "unsupported exchange format" with no way to tell
 * whether their game or the app was the odd one out.
 *
 * **It is deliberately NOT hand-maintained in isolation.** A version string typed
 * into a constant and left to rot is the exact shape of the bug above.
 * `test/factorioTarget.spec.ts` ties this to `test/fixtures/PROVENANCE.json`, so
 * capturing a fixture from a newer game fails the build until this is updated
 * with it. The accepted exchange formats are not duplicated here at all - they
 * are read from the codec's own `SUPPORTED_VERSIONS`, which cannot disagree with
 * what the decoder actually does.
 */

/**
 * The newest Factorio version any committed oracle fixture was captured from -
 * i.e. the version this build's ground truth describes.
 *
 * Pinned by `test/factorioTarget.spec.ts` against `PROVENANCE.json`. Bump it in
 * the same commit that lands a fixture from a newer game.
 */
export const FACTORIO_TARGET_VERSION = "2.1.12";
