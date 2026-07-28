<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    /** What this slider adjusts, e.g. "Minimum expansion distance". */
    label?: string;
  }>(),
  {
    min: 0,
    max: 6,
    step: 0.05,
    disabled: false,
    label: undefined,
  },
);
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const inputId = useId();

// Fraction (0..1) of the thumb along the track, driving the orange value fill -
// the same yellow bar the game's map-gen sliders (and FPercentSlider) show.
const fraction = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  const f = (props.modelValue - props.min) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
});

function onInput(event: Event) {
  emit("update:modelValue", Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <span class="f-slider" :class="{ disabled }" :style="{ '--frac': fraction }">
    <span class="f-slider-track" aria-hidden="true">
      <span class="f-slider-fill" />
    </span>
    <input
      :id="inputId"
      class="f-slider-input"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @input="onInput"
    />
  </span>
</template>

<style scoped>
.f-slider {
  position: relative;
  display: block;
  width: 100%;
  height: 16px;
}

/* Dim the whole control when its section is disabled. */
.f-slider.disabled {
  opacity: 0.5;
}

/* The track holds the orange value fill; it sits behind the transparent-track
   input so the thumb rides on top. */
.f-slider-track {
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
}

.f-slider-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: calc(7px + var(--frac, 0) * (100% - 14px));
  background: var(--f-orange);
}

.f-slider-input {
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

.f-slider-input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--f-orange-bright);
  border: 1px solid #6b4a12;
}

.f-slider-input::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--f-orange-bright);
  border: 1px solid #6b4a12;
}
</style>
