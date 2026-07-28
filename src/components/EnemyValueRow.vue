<script setup lang="ts">
import FInfo from "../ui/FInfo.vue";
import FNumberInput from "../ui/FNumberInput.vue";
import FSlider from "../ui/FSlider.vue";

defineProps<{
  label: string;
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  info?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

function set(value: number) {
  emit("update:modelValue", value);
}
</script>

<template>
  <div class="enemy-value-row">
    <span class="label">{{ label }}<FInfo v-if="info" :text="info" /></span>
    <!-- The visible label is a styled span shared by both controls, so each
         takes its own name from it. The role (slider vs spin button) is what
         tells a screen reader user which of the two they are on. -->
    <FSlider
      :model-value="modelValue"
      :label="label"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      @update:model-value="set"
    />
    <FNumberInput
      :model-value="modelValue"
      :label="label"
      :disabled="disabled"
      @update:model-value="set"
    />
  </div>
</template>

<style scoped>
/* Label flush left (the 1fr track); slider + number box flush right, their
   columns fixed so every row - and the standalone Starting-area row, which
   reuses these same --col-* vars - lines up. */
.enemy-value-row {
  display: grid;
  grid-template-columns: 1fr var(--col-slider, 220px) var(--col-box, 68px);
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.label {
  font-weight: 700;
}
</style>
