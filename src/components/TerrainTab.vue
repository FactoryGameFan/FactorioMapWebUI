<script setup lang="ts">
import { computed } from "vue";
import { type ControlColumn, controlsForTerrainGroup } from "../model/controlCatalog";
import {
  type ClimateControl,
  MOISTURE,
  TERRAIN_TYPE,
  readBias,
  readScale,
  writeBias,
  writeScale,
} from "../model/climateControls";
import { BIAS_SCALE } from "../model/controlScale";
import { MAP_TYPES, readMapType, writeMapType } from "../model/mapType";
import { PLANET_ICONS, PLANET_LABELS } from "../model/planets";
import { usePresetsStore } from "../store/presets";
import FDropdown from "../ui/FDropdown.vue";
import FInfo from "../ui/FInfo.vue";
import FPercentSlider from "../ui/FPercentSlider.vue";
import ControlTable from "./ControlTable.vue";

const COVERAGE_COLUMNS: ControlColumn[] = [
  { key: "frequency", label: "Scale" },
  { key: "size", label: "Coverage" },
];

const CLIFF_COLUMNS: ControlColumn[] = [
  { key: "frequency", label: "Frequency" },
  { key: "size", label: "Continuity" },
];

const store = usePresetsStore();

// The Map type dropdown selects the elevation noise expression, stored in the
// active preset's property_expression_names. Options bind by MapType.id; an
// imported preset carrying an unknown elevation value is surfaced as an extra,
// preserved option so nothing is silently dropped.
const mapTypeOptions = computed(() => {
  const current = store.activePreset
    ? readMapType(store.activePreset.propertyExpressionNames)
    : MAP_TYPES[0];
  const known = MAP_TYPES.map((m) => ({ value: m.id, label: m.label }));
  const isKnown = MAP_TYPES.some((m) => m.id === current.id);
  return isKnown ? known : [...known, { value: current.id, label: current.label }];
});

const mapType = computed({
  get: () => {
    const pen = store.activePreset?.propertyExpressionNames;
    return pen ? readMapType(pen).id : "nauvis";
  },
  set: (id: string) => {
    const pen = store.activePreset?.propertyExpressionNames;
    if (pen) writeMapType(pen, id);
  },
});

// Scale/Bias sliders bind through the climate accessor to the active preset's
// property_expression_names. Mutating that dict in place flows into
// activeExchangeString via the same reactive path as autoplace ControlRows.
function scaleModel(c: ClimateControl) {
  return computed({
    get: () => {
      const pen = store.activePreset?.propertyExpressionNames;
      return pen ? readScale(pen, c) : 1;
    },
    set: (v: number) => {
      const pen = store.activePreset?.propertyExpressionNames;
      if (pen) writeScale(pen, c, v);
    },
  });
}

function biasModel(c: ClimateControl) {
  return computed({
    get: () => {
      const pen = store.activePreset?.propertyExpressionNames;
      return pen ? readBias(pen, c) : 0;
    },
    set: (v: number) => {
      const pen = store.activePreset?.propertyExpressionNames;
      if (pen) writeBias(pen, c, v);
    },
  });
}

const moistureScale = scaleModel(MOISTURE);
const moistureBias = biasModel(MOISTURE);
const auxScale = scaleModel(TERRAIN_TYPE);
const auxBias = biasModel(TERRAIN_TYPE);
</script>

<template>
  <div class="map-type">
    <!-- A <label> with no `for` and no wrapped control names nothing, so this
         is a styled span plus an aria-label on the select - the same shape as
         the preset bar's fields. The app-wide "every select is named" check
         missed this one because App mounts the Resources tab by default. -->
    <span class="map-type-label">Map type</span>
    <FDropdown
      data-test="map-type"
      v-model="mapType"
      aria-label="Map type"
      :options="mapTypeOptions"
    />
  </div>

  <section data-test="terrain-coverage-table">
    <ControlTable
      :names="controlsForTerrainGroup('coverage')"
      :columns="COVERAGE_COLUMNS"
      lead-label="Setting"
    />
  </section>

  <section data-test="terrain-cliff-table">
    <ControlTable
      :names="controlsForTerrainGroup('cliff')"
      :columns="CLIFF_COLUMNS"
      lead-label="Setting"
    />
  </section>

  <section data-test="terrain-noise-table">
    <table class="control-table">
      <thead>
        <tr>
          <th>Setting</th>
          <th class="appears-on-th">Appears on</th>
          <th>Scale</th>
          <th>Bias</th>
        </tr>
      </thead>
      <tbody>
        <tr data-test="terrain-noise-moisture">
          <td class="label">
            <span class="control-enable" />Moisture<FInfo
              text="Controls the distribution of grass versus desert. A higher bias generates more grass"
            />
          </td>
          <td class="appears-on">
            <img
              data-test="appears-on"
              class="planet-icon"
              :src="PLANET_ICONS.nauvis"
              :alt="PLANET_LABELS.nauvis"
              :title="PLANET_LABELS.nauvis"
              width="24"
              height="24"
            />
          </td>
          <td class="cell"><FPercentSlider v-model="moistureScale" label="Moisture scale" /></td>
          <td class="cell">
            <FPercentSlider v-model="moistureBias" label="Moisture bias" :scale="BIAS_SCALE" />
          </td>
        </tr>
        <tr data-test="terrain-noise-terrain-type">
          <td class="label">
            <span class="control-enable" />Terrain type<FInfo
              text="Controls the distribution of red desert versus sand. A higher bias generates more red desert."
            />
          </td>
          <td class="appears-on">
            <img
              data-test="appears-on"
              class="planet-icon"
              :src="PLANET_ICONS.nauvis"
              :alt="PLANET_LABELS.nauvis"
              :title="PLANET_LABELS.nauvis"
              width="24"
              height="24"
            />
          </td>
          <td class="cell"><FPercentSlider v-model="auxScale" label="Terrain type scale" /></td>
          <td class="cell">
            <FPercentSlider v-model="auxBias" label="Terrain type bias" :scale="BIAS_SCALE" />
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.map-type {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}

.map-type-label {
  font-weight: 700;
  color: var(--f-text-dim);
}

.control-table {
  width: 100%;
  border-collapse: collapse;
}

.control-table th {
  text-align: left;
  padding: 6px 8px;
  color: var(--f-text-dim);
  border-bottom: 1px solid var(--f-edge-dark);
}

.control-table :deep(tr:nth-child(even)) {
  background: rgb(255 255 255 / 3%);
}

.label {
  font-weight: 700;
  padding: 6px 8px;
}

.cell {
  padding: 6px 8px;
}

.control-table th.appears-on-th {
  text-align: center;
}

.appears-on {
  padding: 6px 8px;
  text-align: center;
  white-space: nowrap;
}

.planet-icon {
  display: block;
  margin: 0 auto;
  vertical-align: middle;
}
</style>
