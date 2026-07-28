<script setup lang="ts">
import { computed, useId } from "vue";
import { PERCENT_SCALE, type StepScale } from "../model/controlScale";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    disabled?: boolean;
    scale?: StepScale;
    /**
     * What this particular slider adjusts, e.g. "Iron ore frequency". Without
     * it every slider falls back to the scale's generic name ("Percentage"),
     * which names the widget rather than the setting - see issue #15.
     */
    label?: string;
  }>(),
  { disabled: false, scale: () => PERCENT_SCALE, label: undefined },
);
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const inputId = useId();

const index = computed(() => props.scale.nearestIndex(props.modelValue));
const label = computed(() => props.scale.format(props.modelValue));

// Fraction (0..1) of the thumb along the track. Drives both the orange fill
// (left edge to the thumb) and the value bubble under the thumb - matching the
// game's map-generator sliders.
const fraction = computed(() => {
  const max = props.scale.count - 1;
  return max > 0 ? index.value / max : 0;
});

// One tick per notch, at its fraction along the track, so the marks line up
// with where the thumb can stop (like the game's notched sliders).
const tickFractions = computed(() => {
  const n = props.scale.count;
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => i / (n - 1));
});

function onInput(event: Event) {
  emit("update:modelValue", props.scale.valueAt(Number((event.target as HTMLInputElement).value)));
}
</script>

<template>
  <span class="f-percent" :style="{ '--frac': fraction }">
    <span class="f-percent-ticks" aria-hidden="true">
      <span
        v-for="(f, i) in tickFractions"
        :key="i"
        class="f-percent-tick"
        :style="{ left: `calc(7px + ${f} * (100% - 14px))` }"
      />
    </span>
    <span class="f-percent-track" aria-hidden="true">
      <span class="f-percent-fill" />
    </span>
    <input
      :id="inputId"
      class="f-percent-slider"
      type="range"
      min="0"
      :max="props.scale.count - 1"
      step="1"
      :value="index"
      :disabled="disabled"
      :aria-valuetext="label"
      :aria-label="props.label ?? props.scale.ariaLabel"
      @input="onInput"
    />
    <span class="f-percent-bubble" aria-hidden="true">{{ label }}</span>
  </span>
</template>

<style scoped>
.f-percent {
  position: relative;
  display: block;
  width: 100%;
  height: 16px;
}

/* Notch ticks sit just above the track. */
.f-percent-ticks {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  pointer-events: none;
}

.f-percent-tick {
  position: absolute;
  bottom: 0;
  width: 1px;
  height: 4px;
  transform: translateX(-50%);
  background: var(--f-edge-light);
}

/* The track holds the orange value fill; it sits behind the transparent-track
   input so the thumb rides on top. */
.f-percent-track {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 6px;
  transform: translateY(-50%);
  background: var(--f-inset);
  box-shadow:
    inset 1px 1px 0 var(--f-edge-dark),
    inset -1px -1px 0 var(--f-edge-light);
  overflow: hidden;
  pointer-events: none;
}

.f-percent-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: calc(7px + var(--frac, 0) * (100% - 14px));
  background: var(--f-orange);
}

.f-percent-slider {
  appearance: none;
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: 14px;
  margin: 0;
  transform: translateY(-50%);
  background: transparent;
}

.f-percent-slider::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--f-orange-bright);
  border: 1px solid #6b4a12;
}

.f-percent-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--f-orange-bright);
  border: 1px solid #6b4a12;
}

/*
 * Value bubble under the thumb. Hidden until the slider is hovered or focused,
 * then it fades in centered on the handle - the number (percentage or bias)
 * shows up "under the cursor" the way the game's sliders do, so no persistent
 * label crowds the (now narrower) columns.
 */
.f-percent-bubble {
  position: absolute;
  top: calc(100% + 4px);
  left: calc(7px + var(--frac, 0) * (100% - 14px));
  transform: translateX(-50%);
  padding: 1px 6px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--f-text);
  background: var(--f-panel-raised);
  border: 1px solid var(--f-edge-dark);
  box-shadow:
    inset 1px 1px 0 var(--f-edge-light),
    inset -1px -1px 0 var(--f-edge-dark);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.08s ease;
  z-index: 5;
}

.f-percent:hover .f-percent-bubble,
.f-percent:focus-within .f-percent-bubble {
  opacity: 1;
}
</style>
