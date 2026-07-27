<script setup lang="ts">
defineProps<{
  variant?: "default" | "confirm" | "danger" | "tool";
  disabled?: boolean;
}>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    class="f-button"
    :class="variant ?? 'default'"
    :disabled="disabled"
    type="button"
    @click="emit('click')"
  >
    <slot />
  </button>
</template>

<style scoped>
.f-button {
  padding: 4px 16px;
  border: none;
  font: inherit;
  font-weight: 700;
  color: #1a1a1a;
  background: var(--f-value-box);
  cursor: pointer;
  box-shadow:
    inset 1px 1px 0 rgb(255 255 255 / 35%),
    inset -1px -1px 0 rgb(0 0 0 / 45%);
}

.f-button.tool {
  background: var(--f-orange);
}

/* No color override: the base #1a1a1a is what the game puts on its green
   buttons, and white here was the WCAG AA failure (3.15:1). See --f-green. */
.f-button.confirm {
  background: var(--f-green);
}

.f-button.danger {
  background: var(--f-red);
  color: #fff;
}

.f-button:not(:disabled):hover {
  filter: brightness(1.15);
}

.f-button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
