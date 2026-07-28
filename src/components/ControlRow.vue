<script setup lang="ts">
import { computed, useId } from "vue";
import { CONTROL_CATALOG, controlRowLabel, type ControlColumn } from "../model/controlCatalog";
import { isEnabled, setEnabled } from "../model/autoplaceEnabled";
import { PLANET_ICONS, PLANET_LABELS } from "../model/planets";
import { RESOURCE_ICONS } from "../model/resourceIcons";
import { usePresetsStore } from "../store/presets";
import FInfo from "../ui/FInfo.vue";
import FPercentSlider from "../ui/FPercentSlider.vue";

const props = defineProps<{ name: string; columns: ControlColumn[] }>();
const store = usePresetsStore();

const entry = computed(() => CONTROL_CATALOG[props.name]);
const control = computed(() => store.activePreset?.autoplaceControls[props.name]);
const icon = computed(() => RESOURCE_ICONS[props.name]);
const enableId = useId();

// Each control in this row gets a name of its own, since the visible row label
// and column header a sighted user reads them from are not part of any of the
// widgets. The row label carries its planet where two planets share one.
const rowLabel = computed(() => controlRowLabel(props.name));
const sliderLabel = (col: ControlColumn) => `${rowLabel.value} ${col.label.toLowerCase()}`;

// Only a disable-able control consults its enabled state; always-on controls
// are always treated as enabled (and never gray) regardless of a stray size.
const enabled = computed(() =>
  entry.value?.canBeDisabled && control.value ? isEnabled(control.value) : true,
);

function onToggle(event: Event) {
  if (control.value) setEnabled(control.value, (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <tr v-if="entry && control" class="control-row" :data-test="`control-row-${name}`">
    <td class="label">
      <span class="control-enable">
        <input
          v-if="entry.canBeDisabled"
          :id="enableId"
          type="checkbox"
          data-test="control-enable"
          :checked="enabled"
          :aria-label="`Enable ${rowLabel}`"
          @change="onToggle"
        />
      </span>
      <img
        v-if="icon"
        data-test="resource-icon"
        class="resource-icon"
        :src="icon"
        alt=""
        width="22"
        height="22"
      />
      {{ entry.label }}
      <FInfo v-if="entry.info" :text="entry.info" />
    </td>
    <td class="appears-on">
      <img
        data-test="appears-on"
        class="planet-icon"
        :src="PLANET_ICONS[entry.planet]"
        :alt="PLANET_LABELS[entry.planet]"
        :title="PLANET_LABELS[entry.planet]"
        width="24"
        height="24"
      />
    </td>
    <td v-for="col in columns" :key="col.key" class="cell">
      <FPercentSlider
        v-model="control[col.key]"
        :label="sliderLabel(col)"
        :disabled="entry.canBeDisabled && !enabled"
      />
    </td>
  </tr>
</template>

<style scoped>
.label {
  font-weight: 700;
  padding: 6px 8px;
}

.resource-icon {
  vertical-align: middle;
  margin-right: 6px;
  image-rendering: pixelated;
}

.control-enable input {
  width: 16px;
  height: 16px;
  accent-color: var(--f-orange);
  cursor: pointer;
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

.cell {
  padding: 6px 8px;
}
</style>
