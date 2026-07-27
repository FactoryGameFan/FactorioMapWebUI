import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ElevationPreviewPanel from "../src/components/ElevationPreviewPanel.vue";
import { usePresetsStore } from "../src/store/presets";
import { useUiStore } from "../src/store/ui";
import { writeMapType } from "../src/model/mapType";
import type { ElevationRenderer } from "../src/components/useElevationPreview";
import type { Planet } from "../src/model/planets";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

afterEach(() => vi.restoreAllMocks());

function stubCanvas() {
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    putImageData,
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  return putImageData;
}

function setup(
  mapTypeId: string,
  renderer: ElevationRenderer,
  opts: { dev?: boolean; planet?: Planet } = {},
) {
  localStorage.clear();
  history.replaceState(null, "", "/");
  setActivePinia(createPinia());
  // Dev mode is set explicitly (not left to whatever persisted) so tests cannot
  // leak the flag into each other through localStorage.
  useUiStore().setDevMode(opts.dev ?? true);
  const store = usePresetsStore();
  store.createFromBuiltin("Default", "t");
  store.activePreset!.seed = 123456;
  writeMapType(store.activePreset!.propertyExpressionNames, mapTypeId);
  return mount(ElevationPreviewPanel, { props: { renderer, planet: opts.planet } });
}

/** Emits four 512x512 tiles covering the 1024x1024 preview, then completes. */
function okRenderer(tileOrder: number[][] = TILES): ElevationRenderer {
  return {
    render: vi.fn(async (_req, onTile) => {
      for (const [dx, dy] of tileOrder) {
        onTile({ dx, dy, width: 512, height: 512, buffer: new ArrayBuffer(512 * 512 * 4) });
      }
      return true;
    }),
    dispose: vi.fn(),
  };
}

const TILES = [
  [0, 0],
  [512, 0],
  [0, 512],
  [512, 512],
];

describe("ElevationPreviewPanel", () => {
  it("blits each tile at its own offset even when they arrive out of order", async () => {
    const putImageData = stubCanvas();
    // Tiles land bottom-right first: a panel that tracked "the last offset" or
    // reused one tile object across callbacks would put them in the wrong place.
    const renderer = okRenderer([
      [512, 512],
      [0, 512],
      [512, 0],
      [0, 0],
    ]);
    const w = setup("nauvis", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(putImageData.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [512, 512],
      [0, 512],
      [512, 0],
      [0, 0],
    ]);
    // The elapsed readout is stamped once, after the last tile.
    expect(w.find('[data-test="preview-elapsed"]').exists()).toBe(true);
  });

  it("does not stamp the elapsed readout for a superseded render", async () => {
    stubCanvas();
    const renderer: ElevationRenderer = {
      render: vi.fn(async () => false),
      dispose: vi.fn(),
    };
    const w = setup("nauvis", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="preview-elapsed"]').exists()).toBe(false);
  });

  it("renders a Lakes preset to the canvas on Generate", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("lakes", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({
      seed0: 123456,
      mapType: "lakes",
      view: "elevation",
      width: 1024,
      height: 1024,
      tilesPerPixel: 1,
      originX: -512,
      originY: -512,
    });
    expect(putImageData).toHaveBeenCalledTimes(4);
    expect(w.find('[data-test="preview-seed"]').text()).toContain("123456");
  });

  it("renders a Nauvis preset to the canvas on Generate", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ seed0: 123456, mapType: "nauvis" });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("centers the view on world origin (0,0), not the preset spawn point", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    const store = usePresetsStore();
    store.activePreset!.startingPoints = [{ x: 300, y: -400 }];
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // window recentred on origin ...
    expect(arg).toMatchObject({
      originX: -512,
      originY: -512,
      width: 1024,
      height: 1024,
      tilesPerPixel: 1,
    });
    // ... but the tree still gets the real spawn for its distance-gated terms
    expect(arg.startingPositions).toEqual([{ x: 300, y: -400 }]);
  });

  it("shows a message and does not render for an unsupported map type", async () => {
    const renderer = okRenderer();
    const w = setup("elevation_modded_x", renderer);
    expect(w.find('[data-test="unsupported"]').text()).toContain("elevation_modded_x");
    expect(w.find('[data-test="generate"]').attributes("disabled")).toBeDefined();
    await w.find('[data-test="generate"]').trigger("click");
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("passes view:'terrain' after selecting the Terrain toggle on a Nauvis preset", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-terrain"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-terrain"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "terrain", mapType: "nauvis" });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("passes view:'resources' + resourceControls after selecting the Resources toggle (Nauvis)", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-resources"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-resources"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "resources", mapType: "nauvis" });
    // Every catalog resource has a lever entry (defaults 1/1/1).
    expect(arg.resourceControls["iron-ore"]).toEqual({ frequency: 1, size: 1, richness: 1 });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("passes view:'enemies' + enemyControls after selecting the Enemies toggle (Nauvis)", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-enemies"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-enemies"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "enemies", mapType: "nauvis" });
    expect(arg.enemyControls).toEqual({ frequency: 1, size: 1 });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("passes view:'cliffs' + cliffControls/cliffSettings after selecting the Cliffs toggle (Nauvis)", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-cliffs"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-cliffs"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "cliffs", mapType: "nauvis" });
    expect(arg.cliffControls).toEqual({ frequency: 1, continuity: 1 });
    expect(arg.cliffSettings).toEqual({
      cliffElevation0: 10,
      cliffElevationInterval: 40,
      richness: 1,
    });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("disables the Cliffs toggle off-Nauvis (Lakes/Island)", async () => {
    expect(
      setup("lakes", okRenderer()).find('[data-test="view-cliffs"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      setup("island", okRenderer()).find('[data-test="view-cliffs"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("passes view:'trees' + treeControls after selecting the Trees toggle (Nauvis)", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-trees"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-trees"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "trees", mapType: "nauvis" });
    expect(arg.treeControls).toEqual({ frequency: 1, size: 1 });
  });

  it("disables the Trees toggle on a non-Nauvis map type", async () => {
    stubCanvas();
    const w = setup("lakes", okRenderer());
    expect(w.find('[data-test="view-trees"]').attributes("disabled")).toBeDefined();
  });

  it("passes view:'rocks' + rockControls after selecting the Rocks toggle (Nauvis)", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-rocks"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-rocks"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "rocks", mapType: "nauvis" });
    expect(arg.rockControls).toEqual({ frequency: 1, size: 1 });
  });

  it("disables the Rocks toggle off-Nauvis (Lakes/Island)", async () => {
    expect(
      setup("lakes", okRenderer()).find('[data-test="view-rocks"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      setup("island", okRenderer()).find('[data-test="view-rocks"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("passes view:'all' + all overlay controls after selecting the All toggle (Nauvis)", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    expect(w.find('[data-test="view-all"]').attributes("disabled")).toBeUndefined();

    await w.find('[data-test="view-all"]').trigger("click");
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "all", mapType: "nauvis" });
    // the composite view carries every overlay's controls
    expect(arg.resourceControls["iron-ore"]).toEqual({ frequency: 1, size: 1, richness: 1 });
    expect(arg.enemyControls).toEqual({ frequency: 1, size: 1 });
    expect(arg.cliffControls).toEqual({ frequency: 1, continuity: 1 });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("disables the All toggle off-Nauvis (Lakes/Island)", async () => {
    expect(
      setup("lakes", okRenderer()).find('[data-test="view-all"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      setup("island", okRenderer()).find('[data-test="view-all"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("disables the Enemies toggle off-Nauvis (Lakes/Island)", async () => {
    expect(
      setup("lakes", okRenderer()).find('[data-test="view-enemies"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      setup("island", okRenderer()).find('[data-test="view-enemies"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("disables the Resources toggle off-Nauvis (Lakes/Island)", async () => {
    expect(
      setup("lakes", okRenderer()).find('[data-test="view-resources"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      setup("island", okRenderer()).find('[data-test="view-resources"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("disables the Terrain toggle for a Lakes preset (renderTerrain is Nauvis-only)", async () => {
    const renderer = okRenderer();
    const w = setup("lakes", renderer);
    expect(w.find('[data-test="view-terrain"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="view-elevation"]').attributes("disabled")).toBeUndefined();
  });

  it("disables the Terrain toggle for an Island preset", async () => {
    const renderer = okRenderer();
    const w = setup("island", renderer);
    expect(w.find('[data-test="view-terrain"]').attributes("disabled")).toBeDefined();
  });

  it("defaults to the composite All view on a Nauvis preset with no toggle clicked", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "all", mapType: "nauvis" });
  });

  it("restores the chosen view when a preset switches away from Nauvis and back", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    const store = usePresetsStore();

    await w.find('[data-test="view-terrain"]').trigger("click");
    writeMapType(store.activePreset!.propertyExpressionNames, "lakes");
    await w.vm.$nextTick();
    writeMapType(store.activePreset!.propertyExpressionNames, "nauvis");
    await w.vm.$nextTick();

    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "terrain" });
  });

  it("falls back to Elevation view when switching to a preset whose map type disables Terrain", async () => {
    const putImageData = stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer);
    const store = usePresetsStore();

    await w.find('[data-test="view-terrain"]').trigger("click");
    writeMapType(store.activePreset!.propertyExpressionNames, "lakes");
    await w.vm.$nextTick();
    expect(w.find('[data-test="view-terrain"]').attributes("disabled")).toBeDefined();

    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "elevation", mapType: "lakes" });
    expect(putImageData).toHaveBeenCalledTimes(4);
  });

  it("shows an error when the render rejects", async () => {
    stubCanvas();
    const renderer: ElevationRenderer = {
      render: vi.fn(async () => {
        throw new Error("boom");
      }),
      dispose: vi.fn(),
    };
    const w = setup("lakes", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="preview-error"]').exists()).toBe(true);
  });

  it("hides the view toggles when dev mode is off", () => {
    const w = setup("nauvis", okRenderer(), { dev: false });
    for (const t of [
      "elevation",
      "terrain",
      "resources",
      "enemies",
      "cliffs",
      "trees",
      "rocks",
      "all",
    ]) {
      expect(w.find(`[data-test="view-${t}"]`).exists()).toBe(false);
    }
    expect(w.find('[data-test="generate"]').exists()).toBe(true);
    expect(w.find('[data-test="dev-mode"]').exists()).toBe(true);
  });

  it("still renders the composite view with the toggles hidden (Nauvis)", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer, { dev: false });
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "all", mapType: "nauvis" });
  });

  it("still renders Elevation with the toggles hidden (Lakes)", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("lakes", renderer, { dev: false });
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "elevation", mapType: "lakes" });
  });

  it("reveals the view toggles when the dev-mode checkbox is ticked", async () => {
    const w = setup("nauvis", okRenderer(), { dev: false });
    expect(w.find('[data-test="view-all"]').exists()).toBe(false);

    await w.find('[data-test="dev-mode"] input').setValue(true);

    expect(w.find('[data-test="view-all"]').exists()).toBe(true);
    expect(useUiStore().devMode).toBe(true);
  });

  it("reports the elapsed render time after a render, and nothing before one", async () => {
    stubCanvas();
    const w = setup("nauvis", okRenderer());
    expect(w.find('[data-test="preview-elapsed"]').exists()).toBe(false);

    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    // The clock is real, so assert the shape, not a duration.
    expect(w.find('[data-test="preview-elapsed"]').text()).toMatch(/^\d[\d,]* ms$/);
  });

  it("hides the elapsed readout when dev mode is off", async () => {
    stubCanvas();
    const w = setup("nauvis", okRenderer(), { dev: false });
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="preview-elapsed"]').exists()).toBe(false);
  });

  it("reports no elapsed time when the render fails", async () => {
    stubCanvas();
    const renderer: ElevationRenderer = {
      render: vi.fn(async () => {
        throw new Error("boom");
      }),
      dispose: vi.fn(),
    };
    const w = setup("nauvis", renderer);
    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="preview-elapsed"]').exists()).toBe(false);
  });

  it("always renders the composite view once dev mode is turned back off, even after picking a non-composite toggle", async () => {
    stubCanvas();
    const renderer = okRenderer();
    const w = setup("nauvis", renderer); // dev mode on by default

    await w.find('[data-test="view-elevation"]').trigger("click");
    await w.find('[data-test="dev-mode"] input').setValue(false);

    await w.find('[data-test="generate"]').trigger("click");
    await flushPromises();

    expect(renderer.render).toHaveBeenCalledOnce();
    const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ view: "all", mapType: "nauvis" });
  });

  it("reveals the view toggles when the URL carries ?dev=1, without an explicit setDevMode call", () => {
    localStorage.clear();
    history.replaceState(null, "", "/?dev=1");
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    store.activePreset!.seed = 123456;
    writeMapType(store.activePreset!.propertyExpressionNames, "nauvis");
    const w = mount(ElevationPreviewPanel, { props: { renderer: okRenderer() } });

    try {
      expect(w.find('[data-test="view-all"]').exists()).toBe(true);
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  describe("planet: vulcanus (Task 11 + V2 resources, Task 7)", () => {
    it("passes planet:'vulcanus' and defaults to view:'all' on Generate", async () => {
      const putImageData = stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "vulcanus" });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      expect(renderer.render).toHaveBeenCalledOnce();
      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // "all" on Vulcanus composites the three ported layers: terrain, cliffs
      // (V3) and resources (V2). It was "resources" until cliffs got a port.
      expect(arg).toMatchObject({ planet: "vulcanus", view: "all" });
      expect(putImageData).toHaveBeenCalledTimes(4);
    });

    it("renders Vulcanus at the DERIVED surface seed, not the raw map seed", async () => {
      // A save at map seed 123456 does not generate Vulcanus at 123456 - the
      // planet's `map_seed_offset` shifts it to 1249936247. Passing the raw map
      // seed through renders a world no player will ever land on (measured
      // against a real save: 9.7% tile agreement at the raw seed, 96.6% at the
      // derived one). See `src/model/planetSurfaceSeed.ts`.
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "vulcanus" });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.seed0).toBe(surfaceSeedForPlanet("vulcanus", 123456));
      expect(arg.seed0).toBe(1249936247);
    });

    it("still shows the user's MAP seed in the readout, not the shifted surface seed", async () => {
      stubCanvas();
      const w = setup("nauvis", okRenderer(), { planet: "vulcanus" });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      expect(w.get('[data-test="preview-seed"]').text()).toContain("123456");
    });

    it("passes vulcanusResourceControls on Generate for Vulcanus", async () => {
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "vulcanus" });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.vulcanusResourceControls).toEqual({
        tungstenOre: { frequency: 1, size: 1 },
        vulcanusCoal: { frequency: 1, size: 1 },
        calcite: { frequency: 1, size: 1 },
        sulfuricAcidGeyser: { frequency: 1, size: 1 },
      });
    });

    it("enables the Terrain toggle for Vulcanus even on a non-Nauvis map type", async () => {
      const w = setup("lakes", okRenderer(), { planet: "vulcanus" });
      expect(w.find('[data-test="view-terrain"]').attributes("disabled")).toBeUndefined();
    });

    it("enables the Resources toggle on Vulcanus", async () => {
      const w = setup("nauvis", okRenderer(), { planet: "vulcanus" });
      const btn = w.get('[data-test="view-resources"]');
      expect(btn.attributes("disabled")).toBeUndefined();
    });

    it("selects view:'terrain' on Vulcanus after clicking the Terrain toggle in dev mode", async () => {
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "vulcanus" });

      await w.find('[data-test="view-terrain"]').trigger("click");
      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({ planet: "vulcanus", view: "terrain" });
    });

    it("keeps the Nauvis-only overlay toggles (Enemies/Trees) disabled for Vulcanus", async () => {
      const w = setup("nauvis", okRenderer(), { planet: "vulcanus" });
      for (const t of ["enemies", "trees"]) {
        expect(
          w.find(`[data-test="view-${t}"]`).attributes("disabled"),
          `view-${t} should be disabled for Vulcanus`,
        ).toBeDefined();
      }
    });

    it("enables the Cliffs, Rocks and All toggles for Vulcanus (each has a port)", async () => {
      // Cliffs and rocks gained Vulcanus ports in V3, and "All" is meaningful
      // there now that the planet has more than one overlay to composite.
      // Leaving any of them disabled would hide a control that does real work.
      const w = setup("nauvis", okRenderer(), { planet: "vulcanus" });
      for (const t of ["terrain", "resources", "cliffs", "rocks", "all"]) {
        expect(
          w.find(`[data-test="view-${t}"]`).attributes("disabled"),
          `view-${t} should be enabled for Vulcanus`,
        ).toBeUndefined();
      }
    });

    it("disables the Elevation toggle for Vulcanus", async () => {
      const w = setup("nauvis", okRenderer(), { planet: "vulcanus" });
      expect(w.find('[data-test="view-elevation"]').attributes("disabled")).toBeDefined();
    });

    it("falls back to view:'all' for Vulcanus even after the Elevation toggle was previously clicked", async () => {
      // Elevation is disabled for Vulcanus (so a real user cannot click it), but
      // `view` is shared component state - prove effectiveView overrides a
      // stale unported pick regardless, rather than relying only on the
      // disabled attribute to keep users out.
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "nauvis" });
      await w.find('[data-test="view-elevation"]').trigger("click");
      // vue-test-utils' setProps loses the SFC's inferred prop types here (a
      // pre-existing toolchain quirk, unrelated to this task - `w`'s wrapper
      // type falls back to the generic VNodeProps shape), so this one call is
      // cast through `any` rather than fighting the inference.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (w as any).setProps({ planet: "vulcanus" });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({ planet: "vulcanus", view: "all" });
    });

    it("still resolves effectiveView to 'all' for Vulcanus with dev mode off", async () => {
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer, { planet: "vulcanus", dev: false });

      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();

      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({ planet: "vulcanus", view: "all" });
    });

    it("defaults planet to 'nauvis' when the prop is omitted (existing behavior unchanged)", async () => {
      stubCanvas();
      const renderer = okRenderer();
      const w = setup("nauvis", renderer); // no planet prop
      await w.find('[data-test="generate"]').trigger("click");
      await flushPromises();
      const arg = (renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({ planet: "nauvis", view: "all" });
    });
  });
});
