<script setup lang="ts">
import { ref, useId } from "vue";
import { ExchangeStringError } from "../codec/mapExchangeString";
import { usePresetsStore } from "../store/presets";
import FButton from "../ui/FButton.vue";
import FPanel from "../ui/FPanel.vue";

const store = usePresetsStore();
const emit = defineEmits<{ close: [] }>();

const name = ref("");
const exchangeString = ref("");
const error = ref("");
const nameId = useId();
const stringId = useId();

function doImport() {
  error.value = "";
  try {
    store.importExchangeString(name.value || "Imported preset", exchangeString.value);
    name.value = "";
    exchangeString.value = "";
    emit("close");
  } catch (caught) {
    if (caught instanceof ExchangeStringError) {
      error.value = caught.message;
    } else {
      throw caught;
    }
  }
}
</script>

<template>
  <FPanel title="Import map exchange string">
    <div class="import-form">
      <!-- Named explicitly rather than by placeholder, for the same reason as
           the preset bar's two inputs (issue #15). -->
      <input
        :id="nameId"
        v-model="name"
        data-test="import-name"
        class="name-input"
        aria-label="Preset name"
        placeholder="Preset name"
      />
      <textarea
        :id="stringId"
        v-model="exchangeString"
        data-test="import-string"
        class="string-input"
        rows="5"
        aria-label="Map exchange string"
        placeholder=">>> ... <<<"
      ></textarea>
      <p v-if="error" data-test="import-error" class="error">{{ error }}</p>
      <div class="buttons">
        <FButton @click="emit('close')">Cancel</FButton>
        <FButton data-test="import-confirm" variant="tool" @click="doImport">Import</FButton>
      </div>
    </div>
  </FPanel>
</template>

<style scoped>
.import-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.name-input,
.string-input {
  padding: 4px 8px;
  border: none;
  font: inherit;
  color: var(--f-text);
  background: var(--f-inset);
  box-shadow:
    inset 1px 1px 0 var(--f-edge-dark),
    inset -1px -1px 0 var(--f-edge-light);
}

.string-input {
  resize: vertical;
  font-family: monospace;
}

.error {
  color: var(--f-red);
  margin: 0;
}

.buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
