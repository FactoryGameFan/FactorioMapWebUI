<script setup lang="ts">
import { computed } from "vue";
import { type ControlColumn, controlsForCategory } from "../model/controlCatalog";
import { usePresetsStore } from "../store/presets";
import ControlTable from "./ControlTable.vue";
import EnemyValueRow from "./EnemyValueRow.vue";
import FCheckbox from "../ui/FCheckbox.vue";
import FInfo from "../ui/FInfo.vue";
import FPercentSlider from "../ui/FPercentSlider.vue";

const store = usePresetsStore();
const preset = computed(() => store.activePreset);
const evolution = computed(() => preset.value?.mapSettings.enemyEvolution);
const expansion = computed(() => preset.value?.mapSettings.enemyExpansion);
const COLUMNS: ControlColumn[] = [
  { key: "frequency", label: "Frequency" },
  { key: "size", label: "Size" },
];

// Min/max expansion distance are linked: the maximum must always stay greater
// than the minimum. Editing one drags the other so max > min holds, both
// clamped to [1, 20]. Clamping happens only on set, so an untouched import
// keeps its raw stored value (byte-exact) until the user actually edits.
const DIST_MIN = 1;
const DIST_MAX = 20;
const minExpansionDistance = computed({
  get: () => expansion.value?.minExpansionDistance ?? DIST_MIN,
  set: (v: number) => {
    const e = expansion.value;
    if (!e) return;
    const m = Math.min(Math.max(Math.round(v), DIST_MIN), DIST_MAX);
    e.minExpansionDistance = m;
    if (e.maxExpansionDistance <= m) {
      const newMax = Math.min(m + 1, DIST_MAX);
      e.maxExpansionDistance = newMax;
      // m was already at the cap, so pull the minimum back below it.
      if (newMax <= m) e.minExpansionDistance = newMax - 1;
    }
  },
});
const maxExpansionDistance = computed({
  get: () => expansion.value?.maxExpansionDistance ?? DIST_MIN + 1,
  set: (v: number) => {
    const e = expansion.value;
    if (!e) return;
    const m = Math.min(Math.max(Math.round(v), DIST_MIN), DIST_MAX);
    e.maxExpansionDistance = m;
    if (e.minExpansionDistance >= m) {
      const newMin = Math.max(m - 1, DIST_MIN);
      e.minExpansionDistance = newMin;
      // m was already at the floor, so push the maximum back above it.
      if (newMin >= m) e.maxExpansionDistance = newMin + 1;
    }
  },
});

// Evolution factors: the map-gen GUI shows these scaled up from the tiny wire
// floats. Verified against the game (import a known string, read the GUI):
// time & pollution display = wire x 1e7, destroy = wire x 1e5. So the default
// time 0.000004 reads 40, destroy 0.002 reads 200, pollution 0.0000009 reads 9.
// The slider/box work in that display space; the wire stays the raw float, and
// the scale is applied only on set so an untouched import stays byte-exact.
type EvoFactorKey = "timeFactor" | "destroyFactor" | "pollutionFactor";
const EVO_DISPLAY_SCALE: Record<EvoFactorKey, number> = {
  timeFactor: 1e7,
  destroyFactor: 1e5,
  pollutionFactor: 1e7,
};
function evoFactorDisplay(key: EvoFactorKey) {
  const scale = EVO_DISPLAY_SCALE[key];
  return computed({
    // Round away float-multiply noise (e.g. 400.00000000000006) for the box.
    get: () => (evolution.value ? Math.round(evolution.value[key] * scale * 1e4) / 1e4 : 0),
    set: (v: number) => {
      if (evolution.value) evolution.value[key] = v / scale;
    },
  });
}
const timeFactorDisplay = evoFactorDisplay("timeFactor");
const destroyFactorDisplay = evoFactorDisplay("destroyFactor");
const pollutionFactorDisplay = evoFactorDisplay("pollutionFactor");

const TICKS_PER_MINUTE = 3600;

// Cooldowns are stored as ticks (u32) but shown in minutes. An untouched value
// survives byte-exact (minutes is display-only); only an edit applies the
// round, so a non-whole-minute import shows as a fraction.
const minCooldownMinutes = computed({
  get: () => (expansion.value ? expansion.value.minExpansionCooldown / TICKS_PER_MINUTE : 0),
  set: (v: number) => {
    if (expansion.value) expansion.value.minExpansionCooldown = Math.round(v * TICKS_PER_MINUTE);
  },
});
const maxCooldownMinutes = computed({
  get: () => (expansion.value ? expansion.value.maxExpansionCooldown / TICKS_PER_MINUTE : 0),
  set: (v: number) => {
    if (expansion.value) expansion.value.maxExpansionCooldown = Math.round(v * TICKS_PER_MINUTE);
  },
});

// In-game tooltip text (supplied verbatim from the map-gen GUI).
const INFO = {
  noEnemies:
    'In "no enemies" mode, enemy units will not spawn from spawners, map generation, or items. Inactive enemy spawners will still appear on the map. Note: Enabling this will disable some achievements.',
  peaceful:
    "In peaceful mode, the enemies will not actively attack or expand. Enemies will still attack to defend themselves. Note: Enabling this will disable some achievements.",
  startingArea:
    "The size of the area without enemy bases around the player. Note: Making the area larger will disable some achievements.",
  expansion:
    "This can turn off/on the expansion logic as a whole. Note: Turning expansion off will disable some achievements.",
  minDist:
    "The minimum distance enemies will look to expand from other enemy bases. Note: A value higher than 3 will disable some achievements.",
  maxDist:
    "The maximum distance enemies will look to expand from other enemy bases. Note: A value lower than 5 will disable some achievements.",
  groupSize:
    "How much the evolution factor affects the size of enemy expansion parties. Note: A value lower than 4 will disable some achievements.",
  minCooldown:
    "The minimum time between any expansions being sent out. Note: A value higher than 10 will disable some achievements.",
  maxCooldown:
    "The maximum time between enemy expansions being sent out. Note: A value higher than one hour will disable some achievements.",
  evolution:
    "Controls whether enemy evolution is enabled. Note: Disabled evolution will disable some achievements.",
  time: "Controls how fast evolution increases over time. Note: A value lower than 40 will disable some achievements.",
  destroy:
    "Controls how fast evolution increases due to destroying enemy spawners. Note: A value lower than 200 will disable some achievements.",
  pollution:
    "Controls how fast evolution increases due to producing evolution. Note: A value lower than 9 will disable some achievements.",
};
</script>

<template>
  <div class="enemy-tab">
    <ControlTable :names="controlsForCategory('enemy')" :columns="COLUMNS" leadLabel="Setting">
      <template #footer-rows>
        <tr v-if="preset" class="mode-row">
          <td colspan="4">
            <FCheckbox
              v-model="preset.noEnemiesMode"
              label="No enemies"
              data-test="no-enemies-mode"
            /><FInfo :text="INFO.noEnemies" />
          </td>
        </tr>
        <tr v-if="preset" class="mode-row">
          <td colspan="4">
            <FCheckbox
              v-model="preset.peacefulMode"
              label="Peaceful mode"
              data-test="peaceful-mode"
            /><FInfo :text="INFO.peaceful" />
          </td>
        </tr>
        <tr v-if="preset" class="starting-area-row">
          <!-- Label spans Setting + Appears on + Frequency; the slider lands in
               the Size column so it aligns with the Size sliders above. -->
          <td colspan="3" class="sa-label">
            Starting area size<FInfo :text="INFO.startingArea" />
          </td>
          <td class="sa-cell">
            <FPercentSlider
              v-model="preset.startingArea"
              label="Starting area size"
              data-test="starting-area"
            />
          </td>
        </tr>
      </template>
    </ControlTable>
    <section v-if="expansion" data-test="enemy-expansion" class="enemy-section">
      <FCheckbox
        v-model="expansion.enabled"
        label="Enemy expansion"
        data-test="enemy-expansion-enable"
      /><FInfo :text="INFO.expansion" />
      <EnemyValueRow
        data-test="enemy-exp-min-dist"
        label="Minimum expansion distance"
        v-model="minExpansionDistance"
        :info="INFO.minDist"
        :min="1"
        :max="20"
        :step="1"
        :disabled="!expansion.enabled"
      />
      <EnemyValueRow
        data-test="enemy-exp-max-dist"
        label="Maximum expansion distance"
        v-model="maxExpansionDistance"
        :info="INFO.maxDist"
        :min="1"
        :max="20"
        :step="1"
        :disabled="!expansion.enabled"
      />
      <EnemyValueRow
        data-test="enemy-exp-group-size"
        label="Evolution group size factor"
        v-model="expansion.evolutionGroupSizeFactor"
        :info="INFO.groupSize"
        :min="1"
        :max="20"
        :step="1"
        :disabled="!expansion.enabled"
      />
      <EnemyValueRow
        data-test="enemy-exp-min-cooldown"
        label="Minimum cooldown (minutes)"
        v-model="minCooldownMinutes"
        :info="INFO.minCooldown"
        :min="1"
        :max="60"
        :step="1"
        :disabled="!expansion.enabled"
      />
      <EnemyValueRow
        data-test="enemy-exp-max-cooldown"
        label="Maximum cooldown (minutes)"
        v-model="maxCooldownMinutes"
        :info="INFO.maxCooldown"
        :min="5"
        :max="180"
        :step="1"
        :disabled="!expansion.enabled"
      />
    </section>
    <section v-if="evolution" data-test="enemy-evolution" class="enemy-section">
      <FCheckbox
        v-model="evolution.enabled"
        label="Evolution"
        data-test="enemy-evolution-enable"
      /><FInfo :text="INFO.evolution" />
      <!-- Values shown in the game's scaled display units (see EVO_DISPLAY_SCALE). -->
      <EnemyValueRow
        data-test="enemy-evo-time"
        label="Time factor"
        v-model="timeFactorDisplay"
        :info="INFO.time"
        :min="0"
        :max="1000"
        :step="50"
        :disabled="!evolution.enabled"
      />
      <EnemyValueRow
        data-test="enemy-evo-destroy"
        label="Destroy factor"
        v-model="destroyFactorDisplay"
        :info="INFO.destroy"
        :min="0"
        :max="1000"
        :step="50"
        :disabled="!evolution.enabled"
      />
      <EnemyValueRow
        data-test="enemy-evo-pollution"
        label="Pollution factor"
        v-model="pollutionFactorDisplay"
        :info="INFO.pollution"
        :min="0"
        :max="1000"
        :step="10"
        :disabled="!evolution.enabled"
      />
    </section>
  </div>
</template>

<style scoped>
/* Shared column geometry: labels ride the flexible 1fr track on the left, the
   slider and number box sit in these fixed columns on the right so every value
   row - and the Starting-area row - aligns. */
.enemy-tab {
  --col-slider: 220px;
  --col-box: 72px;
}

/* Phone: see AdvancedTab - the fixed slider and box columns leave the label track
   nothing at 390px and the row overruns the viewport. Same breakpoint as the
   control tables in factorio.css. */
@media (max-width: 600px) {
  .enemy-tab {
    --col-slider: 96px;
    --col-box: 60px;
  }
}

/* Mode checkboxes + Starting area size ride inside the enemy-bases table (via
   ControlTable's footer-rows slot) so they share its column widths. Match the
   table cells' 6px 8px padding. */
.mode-row td {
  padding: 6px 8px;
}

.sa-label {
  font-weight: 700;
  padding: 6px 8px;
}

.sa-cell {
  padding: 6px 8px;
}

.enemy-section {
  padding: 8px;
}
</style>
