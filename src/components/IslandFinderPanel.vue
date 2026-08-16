<!-- src/components/IslandFinderPanel.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { usePresetsStore } from "../store/presets";
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

// Search cost grows with the SQUARE of the radius - measured at about 3s for
// 2,000 tiles and 60s for 10,000 - so an unbounded field lets someone start a
// search that never realistically finishes and just reads as a hang.
// `FNumberInput` has no min/max/step of its own (unlike a raw <input
// type="number">), so the bound is enforced here instead - see `clampRadius`
// below for where and why, not on every keystroke.
const RADIUS_MIN = 500;
const RADIUS_MAX = 20000;

const store = usePresetsStore();
const radius = ref(5000);
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
      Rectangles are accurate to about 1 tile - the terrain port's land boundary is itself only that
      good. Doubling the radius costs about four times the time.
    </p>

    <p v-if="error" class="error" role="alert" data-test="island-error">{{ error }}</p>

    <table v-if="results.length" class="island-table">
      <thead>
        <tr>
          <th>Position</th>
          <th>Rectangle</th>
          <th>Land</th>
          <th>Class</th>
          <th>From spawn</th>
          <th>Chain</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in results"
          :key="`${r.cellX},${r.cellY}`"
          data-test="island-row"
          @click="emit('jump', { x: r.centroidX, y: r.centroidY })"
        >
          <td>{{ Math.round(r.centroidX) }}, {{ Math.round(r.centroidY) }}</td>
          <td>
            {{ r.rectTiles.width }} x {{ r.rectTiles.height }}
            <span v-if="!r.refined" data-test="island-approx" title="Coarse estimate, not refined"
              >~</span
            >
            <span
              v-if="r.clipped"
              data-test="island-clipped"
              title="Window still touched this island's edge after growing - the true rectangle may be larger"
              >!</span
            >
          </td>
          <td>{{ r.landTiles }}</td>
          <td>{{ r.klass }}</td>
          <td>{{ Math.round(r.distanceFromSpawn) }}</td>
          <td>{{ r.chainId }}</td>
        </tr>
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
