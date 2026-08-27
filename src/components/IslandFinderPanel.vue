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
import { instantiateEngineSync, type EngineExports } from "../noise/wasm/engine";
import { loadEngineModule } from "../noise/wasm/load";

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
 * build, Fulgora at defaults (min of 2 runs each), typing **2967702466 into
 * the seed field** - which is a MAP seed, so the map searched was surface
 * seed 1640314180:
 *
 *   radius    512 =  3.1s     28 islands
 *   radius  1,024 =  6.9s    105
 *   radius  2,048 = 15.6s    361
 *   radius  4,096 = 27.2s  1,274
 *   radius  5,000 = 28.0s  1,922
 *   radius 10,000 = 52.5s  7,556
 *
 * **That seed line is the correction, and it matters.** This comment used to
 * say "seed 2967702466" with no qualifier, which reads as a surface seed -
 * that is what `findIslands.spec.ts`, `cellSurvey.spec.ts` and the perf spec
 * all hand straight to `seed0`. Here the value went through the field, and
 * `search()` below calls `surfaceSeedForPlanet` on it. So the table describes
 * a different Fulgora from every fixture and probe in the repo. Measured both
 * ways at radius 1024 (2026-08-16): surface seed 2967702466 returns **89**
 * rows, 1640314180 returns **105** - the table's own number. Two of the three
 * top rectangles that browser session recorded, 142x140 and 120x152, come
 * back from 1640314180 and not from 2967702466.
 *
 * The counts are therefore real and all from one map. The TIMES are not
 * explained: 1640314180 is the more expensive map of the two (1.26x in a Node
 * run), yet 6.9s here sits far below every later browser reading of the
 * cheaper one. Read this column as a shape, not as figures to quote. They also
 * predate #211, which raised `MAX_WINDOW_GROWTHS` 3 -> 4 for +36% render
 * pixels, so every time above understates today's cost.
 *
 * Doubling the radius costs about **2.2x**, not 4x, because the refine pass is
 * capped at `DEFAULT_REFINE_COUNT` candidates however wide the search is - so
 * only the coarse pass scales with area, and it is the cheaper half. That
 * reason is structural rather than a property of one map, which is why the
 * conclusion outlives the seed mix-up even though the seconds do not. The old
 * "about 3s for 2,000 tiles and 60s for 10,000" was wrong in both directions.
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
 * feels broken. The previous 5,000 returned 1,922 rows and took the better
 * part of half a minute, which is both a long wait and far more rows than
 * anyone scans. Radius 1024 returns roughly 90 to 105 rows depending on the
 * map - 89 at surface seed 2967702466, 105 at 1640314180 - which fits on a
 * screen, and it is the cheapest row in the table above. The field still
 * accepts up to RADIUS_MAX for a deliberate wider sweep.
 *
 * `test/islandFinderPanel.spec.ts` pins this value. Nothing pinned it before,
 * so it could drift without a single test noticing.
 */
const DEFAULT_RADIUS = 1024;

/**
 * The engine for stage 1's cell survey, compiled once per panel.
 *
 * Memoised on the promise rather than the instance so two clicks in quick
 * succession share one compile. `loadEngineModule` memoises the module too, so
 * this is a second cheap layer over an already-shared one.
 */
let engineOnce: Promise<EngineExports | undefined> | undefined;
async function surveyEngine(): Promise<EngineExports | undefined> {
  engineOnce ??= (async () => {
    try {
      return instantiateEngineSync(await loadEngineModule());
    } catch {
      // Falls back to the TypeScript survey, which is slower and identical -
      // `test/surveyThroughWasm.spec.ts` asserts the two produce the same
      // island list. Not swallowable once #227 removes that arm.
      return undefined;
    }
  })();
  return engineOnce;
}

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

type CopyState = "idle" | "copied" | "failed";

const GPS_GLYPH: Record<CopyState, string> = { idle: "⧉", copied: "✔", failed: "✗" };

/**
 * Which row last had its position copied, and how that went. One entry rather
 * than a per-row flag: only one row can be the most recent copy, and a map
 * would keep stale ticks alive on rows the user has moved on from.
 */
const gpsCopy = ref<{ key: string; state: Exclude<CopyState, "idle"> } | null>(null);
let gpsTimer: ReturnType<typeof setTimeout> | undefined;

/** Same identity the `v-for` keys on, so the tick follows the row it belongs to. */
const rowKey = (r: IslandResult) => `${r.cellX},${r.cellY}`;

/**
 * Factorio's chat rich-text tag for a map position: pasting `[gps=x,y,surface]`
 * into the in-game chat turns it into a clickable ping, which is how someone
 * actually gets to an island this panel found.
 *
 * The coordinates round exactly as the Position column prints them, so the
 * number on screen and the number on the clipboard can never disagree. Note
 * what that point IS: the Voronoi cell centroid, which `findIslands.ts` records
 * (see `nearestLandPixel`) can sit on ocean for some candidates. A ping is
 * therefore "this island", not "a buildable tile".
 *
 * The surface comes from the `planet` prop rather than a literal, even though
 * `supported` currently gates this whole panel to Fulgora - so widening that
 * gate cannot leave the tag naming the wrong surface.
 */
function gpsTag(r: IslandResult): string {
  return `[gps=${Math.round(r.centroidX)},${Math.round(r.centroidY)},${props.planet}]`;
}

function gpsState(r: IslandResult): CopyState {
  return gpsCopy.value?.key === rowKey(r) ? gpsCopy.value.state : "idle";
}

const gpsLiveText = computed(() => {
  if (!gpsCopy.value) return "";
  return gpsCopy.value.state === "copied" ? "Copied map position" : "Copy failed";
});

/**
 * How long to wait for a clipboard write before calling it failed.
 *
 * There is a THIRD failure mode beyond the two ActionBar guards, and it was
 * found in a real browser rather than reasoned about: with the document
 * unfocused, Chrome can leave `writeText`'s promise **pending** instead of
 * rejecting it. Measured on this panel - the button held `idle` through 1.8s
 * of polling, giving no feedback at all. A `catch` cannot see that, so
 * without a race the button just looks broken.
 *
 * 1.5s is chosen to be far longer than a working local write (which settles
 * in well under a frame) while still being under the 2s the confirmation
 * itself stays up. The cost of getting it wrong is mild in one direction
 * only: a slow-but-successful write gets labelled failed, and the text is on
 * the clipboard anyway.
 */
const COPY_TIMEOUT_MS = 1500;

async function writeWithTimeout(text: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_unused, reject) => {
        timer = setTimeout(() => reject(new Error("Clipboard write timed out")), COPY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function copyGps(r: IslandResult) {
  let state: Exclude<CopyState, "idle"> = "copied";
  try {
    // The same two failure modes ActionBar guards: the API is absent entirely
    // on an insecure origin, and the write itself can reject (denied
    // permission, unfocused document). Both have to show feedback, or the
    // button is silently dead and looks like it worked. The third - a write
    // that never settles at all - is what `writeWithTimeout` covers.
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await writeWithTimeout(gpsTag(r));
  } catch {
    state = "failed";
  }
  gpsCopy.value = { key: rowKey(r), state };
  clearTimeout(gpsTimer);
  gpsTimer = setTimeout(() => {
    gpsCopy.value = null;
  }, 2000);
}

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
    // Loaded HERE rather than inside `findIslands`, for the reason
    // `useElevationPreview` records: a fetch inside a function every test
    // constructs makes those tests print pages of `ECONNREFUSED`, because under
    // vitest the module URL points at a dev server that is not running. With
    // `find` injected this is skipped entirely, so an injected test never
    // touches the network.
    //
    // A failure is swallowed and the finder falls back to the TypeScript
    // survey, which still exists. When #227 deletes it this has to become an
    // error, the same way the render worker's did.
    const engine = props.find ? undefined : await surveyEngine();
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
      engine,
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
  clearTimeout(gpsTimer);
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
      <!-- The glyph is aria-hidden so the sentence still reads correctly
           aloud; "the copy icon beside a position" carries the meaning on
           its own, and the icon is only there for sighted matching. -->
      The copy icon <span aria-hidden="true">⧉</span> beside a position copies a
      <code>[gps=...]</code> tag - paste it into Factorio chat for a clickable ping.
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
            <td>
              {{ Math.round(r.centroidX) }}, {{ Math.round(r.centroidY) }}
              <!-- `.stop` is load-bearing: the whole ROW carries a click that
                   emits `jump`, so without it one copy would also move the
                   preview. `test/islandFinderPanel.spec.ts` pins that. -->
              <button
                type="button"
                class="gps-copy"
                data-test="island-gps"
                :data-state="gpsState(r)"
                :title="`Copy ${gpsTag(r)} - paste into Factorio chat for a clickable ping`"
                :aria-label="`Copy map position ${gpsTag(r)}`"
                @click.stop="copyGps(r)"
              >
                {{ GPS_GLYPH[gpsState(r)] }}
              </button>
            </td>
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

    <!-- The tick on the button is a visual-only cue; this is what a screen
         reader hears. Rendered always so the live region already exists when
         its text changes - one injected at copy time may not be announced. -->
    <span class="gps-live" role="status" aria-live="polite" data-test="island-gps-status">
      {{ gpsLiveText }}
    </span>
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

.gps-copy {
  background: none;
  border: none;
  padding: 0 2px;
  margin-left: 4px;
  color: var(--f-text-dim);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.gps-copy:hover,
.gps-copy:focus-visible {
  color: var(--f-text);
}

.gps-copy[data-state="copied"] {
  color: var(--f-green, #5eb663);
}

.gps-copy[data-state="failed"] {
  color: var(--f-red);
}

/* Announced, never shown - the button's own glyph is the visible feedback.
   Not `display: none`, which removes it from the accessibility tree too. */
.gps-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
