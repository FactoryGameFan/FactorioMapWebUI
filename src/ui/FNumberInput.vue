<script setup lang="ts">
import { useId } from "vue";

defineProps<{
  modelValue: number;
  disabled?: boolean;
  /**
   * What this box edits. Only needed where the box is not already inside a
   * <label> (the Advanced tab's Width/Height/Price multiplier boxes are).
   */
  label?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const inputId = useId();

function onChange(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  const value = Number(raw);
  if (raw !== "" && Number.isFinite(value)) {
    emit("update:modelValue", value);
  }
}
</script>

<template>
  <input
    :id="inputId"
    class="f-number"
    type="number"
    :value="modelValue"
    :disabled="disabled"
    :aria-label="label"
    @change="onChange"
  />
</template>

<style scoped>
.f-number {
  width: 72px;
  /* Let the box shrink when its container is narrower than 72px - on a phone the
     Enemy and Advanced rows narrow their value column, and a fixed width would
     push the row past the viewport. Unconditional because it is a no-op wherever
     there is room. */
  max-width: 100%;
  min-width: 0;
  padding: 3px 6px;
  border: none;
  font: inherit;
  font-weight: 700;
  text-align: center;
  color: #1a1a1a;
  background: var(--f-value-box);
  box-shadow:
    inset 1px 1px 0 rgb(0 0 0 / 40%),
    inset -1px -1px 0 rgb(255 255 255 / 30%);
}

/* Drop the spinner arrows. Chrome, Safari, Edge, Opera: */
.f-number::-webkit-outer-spin-button,
.f-number::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

/* Firefox: */
.f-number[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}
</style>
