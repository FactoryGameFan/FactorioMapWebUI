<!-- src/components/ElevationPreviewPanel.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { elevationCtxFromPreset } from "../model/elevationPreviewCtx";
import { PLANET_LABELS, type Planet } from "../model/planets";
import { surfaceSeedForPlanet } from "../model/planetSurfaceSeed";
import { usePresetsStore } from "../store/presets";
import { useUiStore } from "../store/ui";
import FButton from "../ui/FButton.vue";
import FCheckbox from "../ui/FCheckbox.vue";
import { useElevationPreview, type ElevationRenderer } from "./useElevationPreview";

// Fixed view matched to the server --generate-map-preview: 1024 tiles across at
// 1 tile/pixel (the game renders size-1024 previews at 1 meter/pixel), rendered at
// 1024px and centered on world origin (0,0) so the two previews overlay. See
// docs/superpowers/specs/2026-07-19-preview-lineup-design.md.
const PREVIEW_PX = 1024;
const TILES_PER_PIXEL = 1;

const props = defineProps<{ renderer?: ElevationRenderer; planet?: Planet }>();
// In the app no renderer is passed -> build the real worker-backed one (which
// registers its own onBeforeUnmount). Tests inject a fake, so no Worker is made.
const renderer = props.renderer ?? useElevationPreview();
// Single source of truth for "which planet to render" - App.vue's
// selectedPlanet, shared with the server-side PreviewPanel. Defaults to
// "nauvis" so a caller that never passes the prop (e.g. every pre-Task-11
// test) is unaffected.
const planet = computed<Planet>(() => props.planet ?? "nauvis");

const store = usePresetsStore();
const ui = useUiStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const seed = ref<number | null>(null);
const hasRendered = ref(false);
/** Wall-clock ms of the last completed render, or null before/behind a failure. */
const elapsedMs = ref<number | null>(null);

const preview = computed(() =>
  store.activePreset ? elevationCtxFromPreset(store.activePreset) : null,
);
// Whether the CLIENT preview can render the currently-selected planet at all -
// a different axis from the preset's own elevation `mapType` (nauvis/lakes/
// island), which `preview.value.supported` already gates. Vulcanus (Task 11)
// needs none of the preset's Nauvis-specific fields (V1 renders it with
// neutral/default ctx), so it is unconditionally supported regardless of
// `mapType`. Gleba/Fulgora/Aquilo have no client renderer at all (out of scope)
// - without this guard they would silently fall through `runRenderRequest`'s
// dispatch to the Nauvis terrain renderer and render mislabeled Nauvis colors.
const supported = computed(() => {
  if (planet.value === "vulcanus") return true;
  if (planet.value !== "nauvis") return false;
  return preview.value?.supported ?? false;
});
/** The "not available yet" message's subject: the planet when THAT is why
 * client preview is unsupported, else the preset's own map-type label. */
const unsupportedLabel = computed(() =>
  planet.value !== "nauvis" && planet.value !== "vulcanus"
    ? PLANET_LABELS[planet.value]
    : (preview.value?.mapTypeLabel ?? "this map type"),
);

// The terrain render (renderTerrain, Task 11) always evaluates the Nauvis
// climate + tile catalog, regardless of the active preset's actual map type -
// it is only faithful for mapType "nauvis". Enemies and Trees each layer a
// Nauvis-only overlay on top of it, so those toggles gate on
// `nauvisOverlaysAvailable` specifically - which requires BOTH the preset's
// own elevation `mapType` to be "nauvis" AND the selected planet to actually
// be Nauvis (neither has a Vulcanus port - runRenderRequest skips them for
// `planet: "vulcanus"` regardless of `view`, so leaving them enabled there
// would offer a control that silently does nothing).
// Three views gate more broadly, because each has a Vulcanus port:
//   Terrain   -> renderVulcanusTerrain (V1)
//   Resources -> renderVulcanusResources (V2)
//   Cliffs    -> renderVulcanusCliffs (V3)
//   Rocks     -> renderVulcanusRocks (V3)
// so they gate on `terrainAvailable` / `resourcesAvailable` / `cliffsAvailable`
// / `rocksAvailable`, all of which admit Vulcanus as well as
// Nauvis-with-Nauvis-map-type.
// The user's desired view. Defaults to the full composite, which is the closest
// thing to the game's own map preview - and with dev mode off (the default) it
// is the only view a user ever gets, since the toggles are hidden.
const view = ref<
  "elevation" | "terrain" | "resources" | "enemies" | "cliffs" | "trees" | "rocks" | "all"
>("all");
const nauvisMapType = computed(() => preview.value?.mapType === "nauvis");
const nauvisOverlaysAvailable = computed(() => planet.value !== "vulcanus" && nauvisMapType.value);
const terrainAvailable = computed(
  () => nauvisOverlaysAvailable.value || planet.value === "vulcanus",
);
// Resources (V2) and Cliffs (V3) both have Vulcanus ports, so they gate more
// broadly than enemies/trees/rocks: Nauvis-with-Nauvis-map-type, OR Vulcanus.
const resourcesAvailable = computed(
  () => nauvisOverlaysAvailable.value || planet.value === "vulcanus",
);
const cliffsAvailable = computed(
  () => nauvisOverlaysAvailable.value || planet.value === "vulcanus",
);
const rocksAvailable = computed(() => nauvisOverlaysAvailable.value || planet.value === "vulcanus");
// "All" composites whatever the planet has. On Nauvis that is all six overlays;
// on Vulcanus it is terrain + cliffs + rocks + resources, the four ported.
const allAvailable = computed(() => nauvisOverlaysAvailable.value || planet.value === "vulcanus");
// What actually renders, in priority order:
//   1. Vulcanus, dev mode on, "terrain"/"resources"/"cliffs"/"rocks"/"all"
//      last picked - honor it (those are the views with a Vulcanus port).
//   1b. Vulcanus otherwise - "all", which on Vulcanus means terrain + cliffs +
//      rocks + resources. Enemies and trees have no Vulcanus port, so "all"
//      composites exactly the four layers that exist.
//   2. Nauvis planet, off-Nauvis map type (Lakes/Island), always "elevation" -
//      renderTerrain always evaluates the Nauvis climate + tile catalog
//      regardless of the preset's map type, so every non-elevation view would
//      be unfaithful there.
//   3. Nauvis planet, "nauvis" map type, dev mode on: the user's chosen
//      `view` - `view` is component state that outlives the toggles being
//      hidden, so this only applies while the toggles are actually visible to
//      explain it.
//   4. Nauvis planet, "nauvis" map type, dev mode off: always "all" - the
//      toggles are hidden from ordinary users, so `view` could otherwise be
//      stuck on a stale non-composite pick from a prior dev-mode session with
//      no way back.
// Deriving this (instead of the old watch that reset `view`) means a round trip
// through a Lakes preset no longer destroys the chosen view.
const effectiveView = computed(() => {
  if (planet.value === "vulcanus") {
    // Only these have a Vulcanus port; anything else the user last picked on
    // Nauvis (enemies, trees, elevation) falls back to the composite.
    const ported = ["terrain", "resources", "cliffs", "rocks", "all"];
    if (ui.devMode && ported.includes(view.value)) return view.value;
    return "all";
  }
  if (!nauvisMapType.value) return "elevation";
  return ui.devMode ? view.value : "all";
});

async function generate() {
  const preset = store.activePreset;
  const info = preview.value;
  if (!preset || !info || !supported.value || loading.value) return;

  // The preset's seed is the MAP seed; a non-Nauvis planet's surface is
  // generated at `mapSeed + map_seed_offset` (see model/planetSurfaceSeed).
  // The readout keeps showing the map seed - that is the number the player
  // typed and the one they would enter in the game.
  const mapSeed = store.previewSeed();
  seed.value = mapSeed;
  const seed0 = surfaceSeedForPlanet(planet.value, mapSeed);

  const half = (PREVIEW_PX * TILES_PER_PIXEL) / 2; // 512

  loading.value = true;
  error.value = null;
  elapsedMs.value = null;
  const startedAt = performance.now();
  try {
    const el = canvas.value;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    // Size and clear up front: tiles arrive one at a time and paint straight
    // into this canvas, so it has to be the right size before the first lands.
    el.width = PREVIEW_PX;
    el.height = PREVIEW_PX;
    g.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);

    const completed = await renderer.render(
      {
        seed0,
        planet: planet.value,
        mapType: info.mapType,
        view: effectiveView.value,
        width: PREVIEW_PX,
        height: PREVIEW_PX,
        originX: -half,
        originY: -half,
        tilesPerPixel: TILES_PER_PIXEL,
        waterLevel: info.ctx.waterLevel,
        segmentationMultiplier: info.ctx.segmentationMultiplier,
        startingPositions: info.ctx.startingPositions,
        moistureFrequency: info.ctx.moistureFrequency,
        moistureBias: info.ctx.moistureBias,
        temperatureFrequency: info.ctx.temperatureFrequency,
        temperatureBias: info.ctx.temperatureBias,
        auxFrequency: info.ctx.auxFrequency,
        auxBias: info.ctx.auxBias,
        startingAreaMoistureSize: info.ctx.startingAreaMoistureSize,
        startingAreaMoistureFrequency: info.ctx.startingAreaMoistureFrequency,
        resourceControls: info.resourceControls,
        vulcanusResourceControls: info.vulcanusResourceControls,
        enemyControls: info.enemyControls,
        cliffControls: info.cliffControls,
        cliffSettings: info.cliffSettings,
        treeControls: info.treeControls,
        rockControls: info.rockControls,
      },
      (tile) => {
        g.putImageData(
          new ImageData(new Uint8ClampedArray(tile.buffer), tile.width, tile.height),
          tile.dx,
          tile.dy,
        );
        // Reveal the canvas as soon as there is anything on it, so the fill-in
        // is visible rather than hidden until the last tile.
        hasRendered.value = true;
      },
    );
    if (completed) {
      // Measured across the whole round trip (dispatch, compute, transfer,
      // blit) - that is the latency a user feels, and what tiling had to move.
      elapsedMs.value = Math.round(performance.now() - startedAt);
    }
  } catch {
    error.value = "Preview failed.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="elevation-preview">
    <div class="preview-toolbar">
      <span v-if="seed !== null" class="seed" data-test="preview-seed">Seed: {{ seed }}</span>
      <span
        v-if="ui.devMode && elapsedMs !== null"
        class="seed"
        data-test="preview-elapsed"
        title="Wall-clock time from render request to canvas blit"
        >{{ elapsedMs.toLocaleString("en-US") }} ms</span
      >
      <div
        v-if="ui.devMode && supported"
        class="view-toggle"
        role="group"
        aria-label="Preview view"
      >
        <FButton
          data-test="view-elevation"
          :variant="effectiveView === 'elevation' ? 'tool' : 'default'"
          :disabled="planet === 'vulcanus'"
          :title="
            planet === 'vulcanus' ? 'Elevation view is not available for Vulcanus yet' : undefined
          "
          @click="view = 'elevation'"
        >
          Elevation
        </FButton>
        <FButton
          data-test="view-terrain"
          :variant="effectiveView === 'terrain' ? 'tool' : 'default'"
          :disabled="!terrainAvailable"
          :title="
            terrainAvailable ? undefined : 'Terrain view is only available for the Nauvis map type'
          "
          @click="view = 'terrain'"
        >
          Terrain
        </FButton>
        <FButton
          data-test="view-resources"
          :variant="effectiveView === 'resources' ? 'tool' : 'default'"
          :disabled="!resourcesAvailable"
          :title="
            resourcesAvailable
              ? undefined
              : 'Resources view is only available for the Nauvis map type'
          "
          @click="view = 'resources'"
        >
          Resources
        </FButton>
        <FButton
          data-test="view-enemies"
          :variant="effectiveView === 'enemies' ? 'tool' : 'default'"
          :disabled="!nauvisOverlaysAvailable"
          :title="
            nauvisOverlaysAvailable
              ? undefined
              : 'Enemies view is only available for the Nauvis map type'
          "
          @click="view = 'enemies'"
        >
          Enemies
        </FButton>
        <FButton
          data-test="view-cliffs"
          :variant="effectiveView === 'cliffs' ? 'tool' : 'default'"
          :disabled="!cliffsAvailable"
          :title="
            cliffsAvailable ? undefined : 'Cliffs view is only available for the Nauvis map type'
          "
          @click="view = 'cliffs'"
        >
          Cliffs
        </FButton>
        <FButton
          data-test="view-trees"
          :variant="effectiveView === 'trees' ? 'tool' : 'default'"
          :disabled="!nauvisOverlaysAvailable"
          :title="
            nauvisOverlaysAvailable
              ? undefined
              : 'Trees view is only available for the Nauvis map type'
          "
          @click="view = 'trees'"
        >
          Trees
        </FButton>
        <FButton
          data-test="view-rocks"
          :variant="effectiveView === 'rocks' ? 'tool' : 'default'"
          :disabled="!rocksAvailable"
          :title="
            rocksAvailable ? undefined : 'Rocks view is only available for the Nauvis map type'
          "
          @click="view = 'rocks'"
        >
          Rocks
        </FButton>
        <FButton
          data-test="view-all"
          :variant="effectiveView === 'all' ? 'tool' : 'default'"
          :disabled="!allAvailable"
          :title="
            allAvailable ? undefined : 'All-layers view is only available for the Nauvis map type'
          "
          @click="view = 'all'"
        >
          All
        </FButton>
      </div>
      <span class="spacer" />
      <FCheckbox
        data-test="dev-mode"
        label="Debug"
        :model-value="ui.devMode"
        @update:model-value="ui.setDevMode($event)"
      />
      <FButton
        data-test="generate"
        variant="confirm"
        :disabled="!supported || loading"
        @click="generate()"
      >
        {{ loading ? "Rendering..." : "Generate" }}
      </FButton>
    </div>
    <div class="preview-stage f-bevel-in">
      <canvas
        v-show="supported && hasRendered && !error"
        ref="canvas"
        data-test="preview-canvas"
        class="preview-canvas f-preview-media"
      />
      <p v-if="!supported" class="dim" data-test="unsupported">
        Client preview is not available for {{ unsupportedLabel }} yet.
      </p>
      <p v-else-if="error" class="error" role="alert" data-test="preview-error">{{ error }}</p>
      <p v-else-if="!hasRendered" class="dim">Click "Generate" to render the map.</p>
    </div>
  </div>
</template>

<style scoped>
.elevation-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  /* In dev mode the row carries the six view toggles as well as the seed, the
     elapsed readout, the Debug checkbox and Generate - about 700px of content,
     more than the panel gets below a ~1420px window. Without wrapping, Generate
     is pushed outside the panel and becomes unclickable. Nothing wraps at widths
     where the row already fits, so the normal (non-dev) toolbar is unaffected. */
  flex-wrap: wrap;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.view-toggle {
  display: flex;
  /* The toolbar above already wraps, but that does not help these eight buttons:
     the group is a single flex ITEM of the toolbar, so without its own wrap the
     buttons form one unbreakable line and run off the right edge on a phone.
     `min-width: 0` is the other half - a flex item defaults to `min-width: auto`
     and refuses to shrink below its content's intrinsic width, which is what
     pushed the group past the panel in the first place. */
  flex-wrap: wrap;
  min-width: 0;
  gap: 4px;
}
.seed {
  font-size: 12px;
  color: var(--f-text-dim);
}
.preview-stage {
  flex: 1;
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--f-inset);
  padding: 8px;
}
.error {
  color: var(--f-red);
}
.dim {
  color: var(--f-text-dim);
}
</style>
