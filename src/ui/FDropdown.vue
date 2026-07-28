<script setup lang="ts">
import { useId } from "vue";

withDefaults(
  defineProps<{
    modelValue: string;
    options: { value: string; label: string }[];
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const selectId = useId();

function onChange(event: Event) {
  emit("update:modelValue", (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <select
    :id="selectId"
    class="f-dropdown"
    :value="modelValue"
    :disabled="disabled"
    @change="onChange"
  >
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
.f-dropdown {
  padding: 4px 8px;
  border: none;
  font: inherit;
  font-weight: 700;
  color: var(--f-text);
  background: var(--f-inset);
  box-shadow:
    inset 1px 1px 0 var(--f-edge-dark),
    inset -1px -1px 0 var(--f-edge-light);
}
</style>
