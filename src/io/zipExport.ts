import { downloadZip } from "client-zip";
import { encodeExchangeString } from "../codec/mapExchangeString";
import { presetToEncodable } from "../model/convert";
import type { Preset } from "../model/types";
import { toMapGenSettingsJson, toMapSettingsJson } from "./jsonExport";

/**
 * Bundle a preset's two Factorio JSON documents plus its map-exchange string
 * into a single downloadable ZIP `Blob`.
 *
 * The two JSON files are what the game's own CLI consumes - `factorio --create
 * <save> --map-gen-settings <file> --map-settings <file>` - so this is the
 * headless/dedicated-server route for a preset. The `.txt` carries the exchange
 * string for the in-game map-generator dialog.
 *
 * Backed by `client-zip` rather than `jszip`, which is a bundle-size decision:
 * jszip's `browser` field resolves to a 97.6 kB pre-minified *browserify*
 * bundle - an opaque IIFE that cannot be tree-shaken and that carries its own
 * copy of pako 1.x, so the app shipped two pako majors plus readable-stream and
 * setimmediate shims in order to write three short text files. `client-zip` is
 * zero-dependency browser-native ESM.
 *
 * `jszip` remains a devDependency and is *deliberately* still the reader in
 * `test/zipExport.spec.ts`. Checking our own writer with our own reader would
 * be self-consistent rather than correct; an independent, battle-tested reader
 * is the whole point of that test.
 *
 * Entry timestamps default to "now", which is what jszip did too, so the
 * archive is not byte-reproducible across runs. That is fine and always was:
 * byte-exactness is the *exchange string's* invariant, enforced in
 * `src/codec/`. A ZIP is read by whatever unzip tool opens it.
 */
export async function buildZip(preset: Preset): Promise<Blob> {
  return downloadZip([
    {
      name: "map-gen-settings.json",
      input: JSON.stringify(toMapGenSettingsJson(preset), null, 2),
    },
    {
      name: "map-settings.json",
      input: JSON.stringify(toMapSettingsJson(preset), null, 2),
    },
    {
      name: `${preset.name}.txt`,
      input: encodeExchangeString(presetToEncodable(preset)),
    },
  ]).blob();
}
