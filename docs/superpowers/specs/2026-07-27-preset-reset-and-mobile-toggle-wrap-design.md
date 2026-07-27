# Preset Reset button + mobile view-toggle wrap

Date: 2026-07-27
Status: approved, ready for implementation

Two independent UI fixes, plus a browser-verification and Lighthouse pass whose
findings are filed rather than acted on.

## 1. The debug view toggles overflow on mobile

### Problem

With Debug on, `ElevationPreviewPanel.vue` renders eight view buttons
(Elevation, Terrain, Resources, Enemies, Cliffs, Trees, Rocks, All) inside a
`.view-toggle` group. On a phone-width viewport that row runs off the right edge
instead of wrapping.

`.preview-toolbar` already sets `flex-wrap: wrap` (added when Generate was being
pushed out of the panel below ~1420px). That does not help here: `.view-toggle`
is a single flex *item* of the toolbar, and its own `display: flex` has no
`flex-wrap`, so the eight buttons form one unbreakable line. A flex item also
defaults to `min-width: auto`, which refuses to shrink below its content's
intrinsic width - so the group both overflows and pushes the toolbar wider than
the panel.

### Fix

Two properties on `.view-toggle`:

```css
.view-toggle {
  display: flex;
  flex-wrap: wrap;  /* the eight buttons may break across lines */
  min-width: 0;     /* the group may shrink below its content width */
  gap: 4px;
}
```

No JavaScript, no media query, no container query. Consistent with the two
existing wrap fixes in `PresetBar.vue` and `ActionBar.vue`, both of which wrap
unconditionally rather than behind a breakpoint, on the reasoning that wrapping
is inert at widths where the content already fits.

### Verification

CSS is untestable under happy-dom (established in the responsive-layout work),
so this is verified by measurement in a real browser, not by a unit test: at a
390px viewport, assert the toolbar's scrollWidth does not exceed its clientWidth
and that the toggle buttons occupy more than one line. Checked in both Chrome
and Safari, because Chrome's device emulation is Blink pretending to be a phone
and has previously disagreed with real WebKit on layout width questions.

## 2. A Reset button that restores a preset's built-in defaults

### Reference

Factorio's own map generator (see
`docs/screenshots/Screenshot 2026-07-13 at 10.27.52 AM.png`) places a small
dark-red square button with a circular-arrow glyph immediately right of the
preset dropdown. In the screenshot it is dimmed, because nothing has been
changed. We copy the semantics and the red, not the icon-only form.

### Where a preset's "defaults" come from

`Preset` currently has no memory of which built-in it came from.
`createFromBuiltin` and `applyBuiltinToActive` both clone a built-in and then
discard the association. So the model gains one field:

```ts
/**
 * Which built-in this preset's values came from, if any - the target of the
 * Reset button. Set by createFromBuiltin / applyBuiltinToActive / seedState.
 * Absent for presets imported from an exchange string, and for presets already
 * in localStorage from before this field existed; Reset is disabled for those.
 */
sourceBuiltin?: string;
```

Optional on purpose. `PersistedState` is version 1 and stays version 1: an
absent field is a legal, meaningful state ("origin unknown"), so no migration
and no version bump. The field is model-only - `presetToEncodable` never reads
it, so the exchange string is unaffected and byte-exactness is untouched.

`importExchangeString` deliberately does not set it. A string pasted from
elsewhere has no built-in origin, and guessing one would be wrong.

### Store surface

Two additions to `src/store/presets.ts`.

**Getter `activeIsDirty: boolean`** - true when there is an active preset, it
has a `sourceBuiltin`, that name resolves to a real built-in, and the preset
differs from that built-in in any field other than `name`, `seed`, `builtin`,
and `sourceBuiltin`.

Comparison uses a canonical serializer that sorts object keys at every level,
not raw `JSON.stringify`. `propertyExpressionNames` gains and loses keys as
climate sliders move (writing a value that snaps to the default notch *deletes*
the key), so two dictionaries with identical content can differ in insertion
order. Raw stringify would report those as dirty and light up Reset on a preset
that is byte-identical to its built-in.

Encoding both sides to exchange strings and comparing those would also be
canonical, but it runs zlib on every keystroke, on top of the encode
`activeExchangeString` already does. The key-sorted compare is cheap.

**Action `resetActiveToBuiltin()`** - no-op without an active preset or a
resolvable `sourceBuiltin`. Otherwise it takes a fresh `getBuiltinPreset(...)`
clone, overwrites the active preset's values with it, and then restores:

- `name` - the user named this preset; Reset restores settings, not identity.
- `seed` - **the deviation from `applyBuiltinToActive`**, which nulls the seed.
  Resetting the sliders should not silently throw away the seed you are
  rendering at. The seed is not part of "the built-in's defaults" anyway;
  `createFromBuiltin` randomizes it precisely because the fixture's baked seed
  is a capture artifact.
- `builtin: false` and `sourceBuiltin` - the preset stays user-owned and keeps
  its origin, so Reset remains available for the next round of edits.

Then `saveToStorage()`, matching every other mutating action in the store.

### UI

In `PresetBar.vue`, immediately after the Create button:

```
[ New preset ][ Default v ][ Create ][ Reset ]
                             orange     red
```

A `variant="danger"` `FButton` reading `Reset`, `data-test="reset-preset"`,
`:disabled="!store.activeIsDirty"`, and a `title` naming the built-in it would
restore. `FButton`'s existing `danger` variant is already `--f-red` with white
text and already dims at 40% opacity when disabled, so no new styling is
needed.

Disabled rather than hidden, matching the game: a control that greys out teaches
you it exists and what makes it live. A control that vanishes does not.

### Tests

Unit tests in `test/`, no browser needed:

- A freshly created preset is not dirty; Reset is a no-op.
- Moving an autoplace slider makes it dirty.
- Setting a `property_expression_names` climate override makes it dirty, and
  clearing it back to the default notch makes it clean again (this is the case
  raw `JSON.stringify` gets wrong).
- Changing only the seed does **not** make it dirty.
- Changing only the name does **not** make it dirty.
- `resetActiveToBuiltin` restores the autoplace values, preserves name and seed,
  and leaves `builtin: false` with `sourceBuiltin` intact.
- A preset from `importExchangeString` has no `sourceBuiltin`, is never dirty,
  and `resetActiveToBuiltin` leaves it untouched.
- A preset loaded from a pre-field localStorage payload behaves the same.

## 3. Lighthouse

Run against the app and file whatever it reports as a GitHub issue with the
actual category scores and the specific audits that failed. **No performance or
accessibility changes land in this session** - this session is the two UI fixes
above. The issue is the deliverable.

## Out of scope

- Any Lighthouse remediation.
- Reset for imported presets (no origin to reset to; would require diffing
  against a "nearest built-in", which is guesswork).
- Per-tab or per-control reset. This resets the whole preset.
