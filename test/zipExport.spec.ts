import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { decodeExchangeString } from "../src/codec/mapExchangeString";
import { presetFromDecoded } from "../src/model/convert";
import { buildZip } from "../src/io/zipExport";
import fixtures from "./fixtures/builtin-presets.json";

const presets = fixtures.presets as Record<string, string>;

function defaultPreset() {
  return presetFromDecoded("Default", decodeExchangeString(presets["Default"] as string), true);
}

describe("buildZip", () => {
  // `buildZip` writes with `client-zip`; this reads with `jszip`, which is a
  // devDependency kept for exactly this purpose. Reading our own archive with
  // our own writer's library would only prove self-consistency.
  it("bundles the two JSON files and the exchange string", async () => {
    const blob = await buildZip(defaultPreset());
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file("map-gen-settings.json")).not.toBeNull();
    expect(zip.file("map-settings.json")).not.toBeNull();
    const txt = await zip.file("Default.txt")?.async("string");
    expect(txt?.startsWith(">>>")).toBe(true);
  });

  it("round-trips each entry's bytes intact, not merely its name", async () => {
    const preset = defaultPreset();
    const zip = await JSZip.loadAsync(await buildZip(preset));

    // Entry presence says nothing about whether the payload survived the
    // writer. Parse it back and check real fields.
    const gen = JSON.parse((await zip.file("map-gen-settings.json")!.async("string")) as string);
    expect(gen.width).toBe(preset.width);
    expect(gen.height).toBe(preset.height);
    expect(gen.autoplace_controls).toBeTypeOf("object");
    expect(Object.keys(gen.autoplace_controls).length).toBeGreaterThan(0);

    const map = JSON.parse((await zip.file("map-settings.json")!.async("string")) as string);
    expect(map.pollution).toBeTypeOf("object");
    expect(map.enemy_evolution).toBeTypeOf("object");

    // The exchange string must survive verbatim - it is the one artifact in
    // the archive with a byte-exactness invariant behind it.
    const txt = (await zip.file("Default.txt")!.async("string")) as string;
    expect(txt).toBe(presets["Default"]);
  });

  it("names the text entry after the preset", async () => {
    const preset = defaultPreset();
    preset.name = "My Custom Preset";
    const zip = await JSZip.loadAsync(await buildZip(preset));
    expect(zip.file("My Custom Preset.txt")).not.toBeNull();
    expect(Object.keys(zip.files).sort()).toEqual([
      "My Custom Preset.txt",
      "map-gen-settings.json",
      "map-settings.json",
    ]);
  });
});
