<script setup lang="ts">
import { useId } from "vue";

defineProps<{ modelValue: boolean; label?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const inputId = useId();

function onChange(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <label class="f-checkbox">
    <input :id="inputId" type="checkbox" :checked="modelValue" @change="onChange" />
    <span v-if="label" class="f-checkbox-label">{{ label }}</span>
  </label>
</template>

<style scoped>
.f-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.f-checkbox input {
  width: 16px;
  height: 16px;
  accent-color: var(--f-orange);
}

.f-checkbox-label {
  font-weight: 700;
}
</style>
