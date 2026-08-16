<!-- src/components/IslandFinderPanel.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { usePresetsStore } from "../store/presets";
import { useUiStore } from "../store/ui";
import { surfaceSeedForPlanet } from "../model/planetSurfaceSeed";
import { elevationCtxFromPreset } from "../model/elevationPreviewCtx";
import type { Planet } from "../model/planets";
import FButton from "../ui/FButton.vue";
import FNumberInput from "../ui/FNumberInput.vue";
import { createWorkerHost, defaultPoolSize } from "./useElevationPreview";
import { findIslands, type FindOptions, type IslandResult } from "../noise/islands/findIslands";

// `find` is the injection seam, mirroring ElevationPreviewPanel's `renderer`
// prop: it lets the tests drive this component without spinning up Workers,
// which do not exist in the test environment.
const props = defineProps<{
  planet: Planet;
  find?: (opts: FindOptions) => Promise<IslandResult[]>;
}>();
const emit = defineEmits<{ jump: [{ x: number; y: number }] }>();

/**
 * Search cost does NOT grow with the square of the radius, and this comment
 * used to say it did. Measured end to end in Chrome against a production
 * build, seed 2967702466, Fulgora at defaults (min of 2 runs each):
 *
 *   radius    512 =  3.1s     28 islands
 *   radius  1,024 =  6.9s    105
 *   radius  2,048 = 15.6s    361
 *   radius  4,096 = 27.2s  1,274
 *   radius  5,000 = 28.0s  1,922
 *   radius 10,000 = 52.5s  7,556
 *
 * Doubling the radius costs about **2.2x**, not 4x, because the refine pass is
 * capped at `DEFAULT_REFINE_COUNT` candidates however wide the search is - so
 * only the coarse pass scales with area, and it is the cheaper half. The old
 * "about 3s for 2,000 tiles and 60s for 10,000" was wrong in both directions:
 * 2,000 is really ~15.6s, and 10,000 is 52.5s.
 *
 * The bound still matters - 10,000 tiles is most of a minute - but it is a
 * comfort limit, not a cliff. `FNumberInput` has no min/max/step of its own
 * (unlike a raw <input type="number">), so it is enforced here instead; see
 * `clampRadius` for where and why, which is not on every keystroke.
 */
const RADIUS_MIN = 500;
const RADIUS_MAX = 20000;

/**
 * The default decides whether the first thing a new user does feels instant or
 * feels broken. The previous 5,000 took ~28s and returned 1,922 rows, which is
 * both a long wait and far more rows than anyone scans. 1024 takes ~6.9s and
 * returns about 105, which fits on a screen. The field still accepts up to
 * RADIUS_MAX for a deliberate wider sweep.
 *
 * `test/islandFinderPanel.spec.ts` pins this value. Nothing pinned it before,
 * so it could drift without a single test noticing.
 */
const DEFAULT_RADIUS = 1024;

const store = usePresetsStore();
const ui = useUiStore();
const radius = ref(DEFAULT_RADIUS);
const radiusModel = computed({
  get: () => radius.value,
  // Does NOT clamp here. `FNumberInput` commits on the native `change` event,
  // so a setter that clamps on every write forced the field to snap to
  // RADIUS_MIN the moment a partially-typed value (e.g. "5" on the way to
  // "5000") committed mid-edit - the field fighting the user rather than
  // waiting for them to finish. `clampRadius` below enforces the bound
  // instead, on blur and (as the actual guarantee) at the start of a search.
  set: (v: number) => {
    radius.value = v;
  },
});

function clampRadius() {
  radius.value = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, radius.value));
}
const running = ref(false);
const done = ref(0);
const total = ref(0);
const error = ref<string | null>(null);
const results = shallowRef<IslandResult[]>([]);

const supported = computed(() => props.planet === "fulgora");

/**
 * Where the refined rows stop and the coarse ones begin, or -1 if every row is
 * refined.
 *
 * `compareResults` ranks the whole refined GROUP above the unrefined one, so
 * the refined rows are always a contiguous prefix - which is exactly why the
 * per-row `~` marker this replaced carried no information. It was on 1,872 of
 * 1,922 rows in a radius-5,000 search (97%), and all it ever said was "you are
 * past row N". One divider says the same thing once.
 */
const firstCoarseIndex = computed(() => results.value.findIndex((r) => !r.refined));

/** Explicit locale so the rendered digits do not depend on the machine. */
const formatTiles = (n: number) => n.toLocaleString("en-US");

let host: ReturnType<typeof createWorkerHost> | null = null;
let aborter: AbortController | null = null;

function ensureHost() {
  host ??= createWorkerHost();
  return host;
}

async function search() {
  const preset = store.activePreset;
  if (!preset || running.value || !supported.value) return;
  // The one place the bound MUST hold: whatever the field currently shows
  // (possibly never blurred, possibly mid-edit), no out-of-range radius
  // reaches `findIslands`.
  clampRadius();
  running.value = true;
  error.value = null;
  done.value = 0;
  total.value = 0;
  results.value = [];
  aborter = new AbortController();
  try {
    const seed0 = surfaceSeedForPlanet("fulgora", store.previewSeed());
    // The finder must survey and render the SAME map the preview beside it
    // shows, not the default grid - `fulgoraIslandControls` (Islands
    // frequency/size) changes the Voronoi `grid` constant that both the
    // survey step and every render window derive from, so a preset that
    // moves those sliders would otherwise silently analyse a different map.
    // Follows the same read `ElevationPreviewPanel.vue` already uses.
    const islandControls = elevationCtxFromPreset(preset).fulgoraIslandControls;
    const run = props.find ?? findIslands;
    // With `find` injected, `ensureHost()` must never be called - not even to
    // build the `execute` argument - or every test would try to spawn a real
    // Worker, which does not exist in the test environment. Wrapping the call
    // in a closure defers that lookup until `execute` actually runs, which the
    // injected `find` never does.
    results.value = await run({
      ctx: {
        seed0,
        islandsFrequency: islandControls.frequency,
        islandsSize: islandControls.size,
      },
      radius: radius.value,
      concurrency: props.find
        ? 1
        : defaultPoolSize(
            typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
          ),
      execute: (req, slot) => ensureHost().execute(req, slot),
      signal: aborter.signal,
      onProgress: (d, t) => {
        done.value = d;
        total.value = t;
      },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Island search failed.";
  } finally {
    running.value = false;
    aborter = null;
  }
}

function cancel() {
  aborter?.abort();
}

onBeforeUnmount(() => {
  aborter?.abort();
  host?.dispose();
  host = null;
});
</script>

<template>
  <div v-if="supported" class="island-finder">
    <div class="island-toolbar">
      <label class="radius-label">
        Search radius (tiles)
        <FNumberInput
          v-model="radiusModel"
          data-test="island-radius"
          label="Search radius (tiles)"
          @blur="clampRadius"
        />
      </label>
      <FButton data-test="island-search" :disabled="running" @click="search">
        {{ running ? "Searching..." : "Find islands" }}
      </FButton>
      <FButton v-if="running" data-test="island-cancel" variant="danger" @click="cancel">
        Cancel
      </FButton>
      <span v-if="running && total > 0" class="progress" data-test="island-progress">
        {{ done }} / {{ total }}
      </span>
    </div>

    <p class="caveat">
      Chunks are whole 32x32 blocks that are land all the way across - ocean is excluded, cliffs are
      not, since those can be removed. Rectangles are accurate to about 1 tile, because the terrain
      port's own land boundary is only that good. Doubling the radius costs roughly twice the time.
    </p>

    <p v-if="error" class="error" role="alert" data-test="island-error">{{ error }}</p>

    <table v-if="results.length" class="island-table">
      <thead>
        <tr>
          <th>Position</th>
          <th>Rectangle</th>
          <th title="Whole 32x32 chunks that are land all the way across">Chunks</th>
          <th>From spawn</th>
          <!-- Class and Chain are diagnostics, not decisions. `chainId` in
               particular is an arbitrary component index - with ~1,900 islands
               nearly every row carries a unique number, so it reads as noise
               unless you are debugging the chaining itself. -->
          <th v-if="ui.devMode">Class</th>
          <th v-if="ui.devMode">Chain</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="(r, i) in results" :key="`${r.cellX},${r.cellY}`">
          <tr
            v-if="i === firstCoarseIndex"
            class="coarse-divider"
            data-test="island-coarse-divider"
          >
            <td :colspan="ui.devMode ? 6 : 4">
              Below here: measured at coarse resolution, not re-measured.
            </td>
          </tr>
          <tr data-test="island-row" @click="emit('jump', { x: r.centroidX, y: r.centroidY })">
            <td>{{ Math.round(r.centroidX) }}, {{ Math.round(r.centroidY) }}</td>
            <td>
              {{ r.rectTiles.width }} x {{ r.rectTiles.height }}
              <span
                v-if="r.clipped"
                data-test="island-clipped"
                title="Window still touched this island's edge after growing - the true rectangle may be larger"
                >!</span
              >
            </td>
            <td>{{ formatTiles(r.fullChunks) }}</td>
            <td>{{ formatTiles(Math.round(r.distanceFromSpawn)) }}</td>
            <td v-if="ui.devMode">{{ r.klass }}</td>
            <td v-if="ui.devMode">{{ r.chainId }}</td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else-if="!running" class="dim">No islands found yet - run a search.</p>
  </div>
</template>

<style scoped>
.island-finder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.island-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.radius-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
}

.progress {
  font-size: 12px;
  color: var(--f-text-dim);
}

.caveat {
  margin: 0;
  opacity: 0.75;
  font-size: 0.9em;
}

.error {
  color: var(--f-red);
}

[data-test="island-clipped"] {
  color: var(--f-red);
  font-weight: 700;
}

.coarse-divider td {
  border-top: 1px solid var(--f-text-dim);
  color: var(--f-text-dim);
  font-size: 0.9em;
  padding-top: 8px;
  cursor: default;
}

.dim {
  color: var(--f-text-dim);
}

.island-table {
  width: 100%;
  border-collapse: collapse;
}

.island-table th,
.island-table td {
  padding: 4px 8px;
  text-align: left;
}

.island-table tbody tr {
  cursor: pointer;
}

.island-table tbody tr:hover {
  background: var(--f-panel-raised);
}
</style>
