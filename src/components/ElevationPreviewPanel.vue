<!-- src/components/ElevationPreviewPanel.vue -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { elevationCtxFromPreset } from "../model/elevationPreviewCtx";
import { PLANET_CAPABILITIES, type PreviewView } from "../model/planetCapabilities";
import { PLANET_LABELS, PLANETS, type Planet } from "../model/planets";
import { NAUVIS_MAX_STARTING_POINTS } from "../noise/wasm/request";
import { surfaceSeedForPlanet } from "../model/planetSurfaceSeed";
import { usePresetsStore } from "../store/presets";
import { useUiStore } from "../store/ui";
import FButton from "../ui/FButton.vue";
import FCheckbox from "../ui/FCheckbox.vue";
import FDropdown from "../ui/FDropdown.vue";
import { useElevationPreview, type ElevationRenderer } from "./useElevationPreview";

// Fixed view matched to the server --generate-map-preview: 1024 tiles across at
// 1 tile/pixel (the game renders size-1024 previews at 1 meter/pixel), rendered at
// 1024px and centered on world origin (0,0) so the two previews overlay. See
// docs/superpowers/specs/2026-07-19-preview-lineup-design.md.
const PREVIEW_PX = 1024;
const TILES_PER_PIXEL = 1;

const props = defineProps<{
  renderer?: ElevationRenderer;
  planet?: Planet;
  /**
   * World coordinate the render window is centered on - the island finder's
   * jump-to target (#27). Both default to 0, which reproduces the original
   * "always centered on world origin" behavior exactly (`half` subtracted,
   * nothing else). Optional rather than required so every caller that
   * predates this - the whole app before Task 8, and most of this file's own
   * tests - is unaffected.
   */
  centerX?: number;
  centerY?: number;
}>();
// In the app no renderer is passed -> build the real worker-backed one (which
// registers its own onBeforeUnmount). Tests inject a fake, so no Worker is made.
const emit = defineEmits<{ "update:planet": [value: Planet] }>();
const planetOptions = PLANETS.map((p) => ({ value: p, label: PLANET_LABELS[p] }));
const renderer = props.renderer ?? useElevationPreview();
// Single source of truth for "which planet to render" - App.vue's
// selectedPlanet, chosen with the planet dropdown in this toolbar. Defaults to
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
// Only the Nauvis writer sends `startingPositions` to the engine (Vulcanus and
// Fulgora derive their own spawn), and it refuses more than the ABI cap. So the
// limit is checked here, for Nauvis only, to give a plain message up front.
const startingPointCount = computed(() => preview.value?.ctx.startingPositions.length ?? 0);
const tooManyStartingPoints = computed(
  () =>
    planet.value === "nauvis" &&
    (preview.value?.supported ?? false) &&
    startingPointCount.value > NAUVIS_MAX_STARTING_POINTS,
);
const supported = computed(() => {
  if (planet.value !== "nauvis") return PLANET_CAPABILITIES[planet.value].rendered;
  return (preview.value?.supported ?? false) && !tooManyStartingPoints.value;
});
/** The one "why not" message shown when the preview cannot render. */
const unsupportedMessage = computed(() => {
  if (tooManyStartingPoints.value) {
    return `Previews support up to ${NAUVIS_MAX_STARTING_POINTS} starting points; this preset has ${startingPointCount.value}.`;
  }
  const label =
    planet.value !== "nauvis"
      ? PLANET_LABELS[planet.value]
      : (preview.value?.mapTypeLabel ?? "this map type");
  return `Client preview is not available for ${label} yet.`;
});

// The terrain render (renderTerrain, Task 11) always evaluates the Nauvis
// climate + tile catalog, regardless of the active preset's actual map type -
// it is only faithful for mapType "nauvis". Enemies and Trees each layer a
// Nauvis-only overlay on top of it, so those toggles gate on
// `enemiesAvailable` / `treesAvailable` - which requires BOTH the preset's
// own elevation `mapType` to be "nauvis" AND the selected planet to actually
// be Nauvis (neither has a Vulcanus port - runRenderRequest skips them for
// `planet: "vulcanus"` regardless of `view`, so leaving them enabled there
// would offer a control that silently does nothing).
// Fulgora (Task 11) has a terrain renderer, and the scrap resource overlay
// (see `makeFulgoraScrap`) now renders too - but only through the default
// "all" composite. `resourcesAvailable` below still excludes Fulgora, so it
// joins `terrainAvailable` only and every dev-mode toggle stays off for it,
// matching how runRenderRequest falls back to plain terrain for a view it
// cannot honour. That keeps the dev-mode Resources toggle disabled for
// Fulgora while ordinary users - who only ever see "all" - get scrap painted
// automatically. Deliberately out of scope to wire the toggle up too; see
// `resourcesAvailable`'s comment below.
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
const view = ref<PreviewView>("all");
const nauvisMapType = computed(() => preview.value?.mapType === "nauvis");
// Lakes and Island render elevation only; say so once a render is asked for.
const elevationOnlyNote = computed(() => {
  const info = preview.value;
  if (planet.value !== "nauvis" || !info?.supported || nauvisMapType.value) return null;
  if (seed.value === null && !hasRendered.value) return null;
  return `Full terrain is not available for the ${info.mapTypeLabel} map type yet; showing elevation.`;
});
// Nauvis gates every overlay on the preset's map type. Any other planet reads
// its views from PLANET_CAPABILITIES, so turning a planet on is a table edit.
// A view that is not in the table is a disabled toggle, never terrain: the
// render path refuses it.
const viewAvailable = (v: PreviewView): boolean =>
  planet.value === "nauvis"
    ? nauvisMapType.value
    : PLANET_CAPABILITIES[planet.value].views.includes(v);
const terrainAvailable = computed(() => viewAvailable("terrain"));
const resourcesAvailable = computed(() => viewAvailable("resources"));
const cliffsAvailable = computed(() => viewAvailable("cliffs"));
const rocksAvailable = computed(() => viewAvailable("rocks"));
const enemiesAvailable = computed(() => viewAvailable("enemies"));
const treesAvailable = computed(() => viewAvailable("trees"));
const allAvailable = computed(() => viewAvailable("all"));
const elevationAvailable = computed(() => viewAvailable("elevation") || planet.value === "nauvis");
// What actually renders, in priority order:
//   1. Vulcanus, dev mode on, "terrain"/"resources"/"cliffs"/"rocks"/"all"
//      last picked - honor it (those are the views with a Vulcanus port).
//   1b. Vulcanus otherwise - "all", which on Vulcanus means terrain + cliffs +
//      rocks + resources. Enemies and trees have no Vulcanus port, so "all"
//      composites exactly the four layers that exist.
//   1c. Fulgora, same shape as Vulcanus, and it must return BEFORE the map-type
//      check below for the same reason. Its ported views are "terrain" and
//      "all"; `resourcesAvailable` deliberately excludes Fulgora (see above),
//      so scrap reaches the user only through the "all" composite. Falling
//      through to rule 2 on a Lakes/Island preset returned "elevation", and
//      `runRenderRequest`'s Fulgora branch paints scrap only for "resources"
//      or "all" - so the whole V3 layer vanished on those presets. Measured at
//      256x256 around the origin, seed0 123456: "all" and "resources" paint
//      177 scrap pixels, "elevation" and "terrain" paint 0.
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
const effectiveView = computed<PreviewView>(() => {
  if (planet.value !== "nauvis") {
    // Only views in the planet's table row have a toggle; anything else the
    // user last picked (on Nauvis, say) falls back to the composite.
    if (ui.devMode && PLANET_CAPABILITIES[planet.value].views.includes(view.value)) {
      return view.value;
    }
    return "all";
  }
  if (!nauvisMapType.value) return "elevation";
  return ui.devMode ? view.value : "all";
});

// Each generate() takes the next number. Results from an older number (a render
// that was still in flight when the planet changed) are ignored, so they cannot
// paint over, or reveal, the new planet's box. The real renderer already
// supersedes an older render when a newer one starts, but a planet change starts
// none (renders only happen when asked), so the panel has to drop it itself.
let generation = 0;

async function generate(reroll = false) {
  const preset = store.activePreset;
  const info = preview.value;
  if (!preset || !info || !supported.value || loading.value) return;

  // The preset's seed is the MAP seed; a non-Nauvis planet's surface is
  // generated at `mapSeed + map_seed_offset` (see model/planetSurfaceSeed).
  // The readout keeps showing the map seed - that is the number the player
  // typed and the one they would enter in the game.
  const mapSeed = store.previewSeed(reroll);
  seed.value = mapSeed;
  const seed0 = surfaceSeedForPlanet(planet.value, mapSeed);

  const half = (PREVIEW_PX * TILES_PER_PIXEL) / 2; // 512

  loading.value = true;
  error.value = null;
  elapsedMs.value = null;
  const startedAt = performance.now();
  const mine = ++generation;
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
        // Whole tiles, because the engine takes the game's chunk-grid noise
        // path only on whole-tile coordinates (`terrain_at` in
        // crates/fmw-wasm/src/render.rs); a fractional center sends every
        // pixel down the point path instead.
        originX: Math.round(props.centerX ?? 0) - half,
        originY: Math.round(props.centerY ?? 0) - half,
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
        fulgoraIslandControls: info.fulgoraIslandControls,
        vulcanusVolcanismControls: info.vulcanusVolcanismControls,
      },
      (tile) => {
        if (mine !== generation) return;
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
    if (completed && mine === generation) {
      // Measured across the whole round trip (dispatch, compute, transfer,
      // blit) - that is the latency a user feels, and what tiling had to move.
      elapsedMs.value = Math.round(performance.now() - startedAt);
    }
  } catch (e) {
    // The real cause, not a constant. A bare `catch` here discarded every
    // render failure's message - issue #341 - and produced the same
    // "Preview failed." that the old server-rendered panel produced from the
    // unrelated Docker preview service, which is what made the two hard to
    // tell apart.
    // Same idiom as `IslandFinderPanel.vue`.
    if (mine === generation) error.value = e instanceof Error ? e.message : "Preview failed.";
  } finally {
    if (mine === generation) loading.value = false;
  }
}

// A picture of one planet must not sit under a dropdown that names another.
// Back to the not-rendered state: the box shows its normal prompt or "not
// available" message, and any in-flight render is dropped. The seed readout is
// cleared too - it labels a finished picture, and with none on screen it would
// mislead (the map seed itself is the same on every planet and is shown again by
// the next Generate). Nothing renders until the user asks.
watch(planet, () => {
  generation++;
  loading.value = false;
  hasRendered.value = false;
  error.value = null;
  elapsedMs.value = null;
  seed.value = null;
});

// Re-center on a jump target automatically, but only once the user has
// already asked for a render at least once - a caller that sets centerX/
// centerY before the first Generate click (e.g. mounting straight onto a
// jump target) must not trigger a render the user never asked for.
watch(
  () => [props.centerX, props.centerY],
  () => {
    if (hasRendered.value) void generate();
  },
);
</script>

<template>
  <div class="elevation-preview">
    <div class="preview-toolbar">
      <FDropdown
        data-test="planet-select"
        aria-label="Planet to preview"
        :model-value="planet"
        :options="planetOptions"
        @update:model-value="emit('update:planet', $event as Planet)"
      />
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
          :disabled="!elevationAvailable"
          :title="
            elevationAvailable
              ? undefined
              : `Elevation view is not available for ${PLANET_LABELS[planet]} yet`
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
          :disabled="!enemiesAvailable"
          :title="
            enemiesAvailable ? undefined : 'Enemies view is only available for the Nauvis map type'
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
          :disabled="!treesAvailable"
          :title="
            treesAvailable ? undefined : 'Trees view is only available for the Nauvis map type'
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
        v-if="store.activePreset && store.activePreset.seed === null"
        data-test="reroll"
        variant="tool"
        :disabled="!supported || loading"
        title="Render a new random seed"
        @click="generate(true)"
      >
        Re-roll
      </FButton>
      <FButton
        data-test="generate"
        variant="confirm"
        :disabled="!supported || loading"
        @click="generate()"
      >
        {{ loading ? "Rendering..." : "Generate" }}
      </FButton>
    </div>
    <p v-if="elevationOnlyNote" class="dim note" data-test="elevation-only-note">
      {{ elevationOnlyNote }}
    </p>
    <div class="preview-stage f-bevel-in">
      <canvas
        v-show="supported && hasRendered && !error"
        ref="canvas"
        data-test="preview-canvas"
        class="preview-canvas f-preview-media"
      />
      <p v-if="!supported" class="dim" data-test="unsupported">
        {{ unsupportedMessage }}
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
.note {
  margin: 0;
  font-size: 12px;
}
</style>
