<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { BUILTIN_NAMES } from "../model/builtins";
import { usePresetsStore } from "../store/presets";
import FButton from "../ui/FButton.vue";
import FCheckbox from "../ui/FCheckbox.vue";
import FDropdown from "../ui/FDropdown.vue";

const store = usePresetsStore();
const newName = ref("");
const builtinChoice = ref("Default");
const newNameId = useId();
const seedId = useId();

const builtinOptions = BUILTIN_NAMES.map((name) => ({ value: name, label: name }));
const editOptions = computed(() =>
  store.userPresets.map((p) => ({ value: p.name, label: p.name })),
);

// "Random each new map" is a pure view over the seed: a null seed is random.
const randomEachMap = computed({
  get: () => store.activePreset?.seed == null,
  set: (value: boolean) => {
    if (!store.activePreset) return;
    if (value) store.activePreset.seed = null;
    else rerollSeed();
  },
});

// The tooltip names what Reset would restore, since the button itself cannot.
// Mirrors the disabled state's three reasons: nothing edited, no origin to
// reset to, or no preset at all.
const resetTitle = computed(() => {
  const origin = store.activePreset?.sourceBuiltin;
  if (!origin) return "This preset was imported, so it has no built-in defaults to restore";
  if (!store.activeIsDirty) return `Unchanged from the "${origin}" defaults`;
  return `Restore the "${origin}" defaults (keeps this preset's name and seed)`;
});

function create() {
  if (!newName.value.trim()) return;
  store.createFromBuiltin(builtinChoice.value, newName.value);
  newName.value = "";
}

// Picking a built-in loads its values into the active preset, so all sliders
// update to match (the dropdown still seeds what "Create" clones).
function onBuiltinChange(name: string) {
  builtinChoice.value = name;
  store.applyBuiltinToActive(name);
}

function onSeedChange(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  if (store.activePreset) {
    store.activePreset.seed = raw === "" ? null : Number(raw);
  }
}

// Roll a fresh concrete seed in the Factorio u32 range [1, 0xffffffff]. Setting
// a concrete seed makes it non-null, so "random each new map" derives to false.
function rerollSeed() {
  if (!store.activePreset) return;
  store.activePreset.seed = 1 + Math.floor(Math.random() * 0xffffffff);
}
</script>

<template>
  <div class="preset-bar f-bevel-out">
    <span class="field-label">Edit preset</span>
    <!-- The visible "Edit preset" / "New preset" text beside these is a styled
         span, not a <label for>, so each select needs its own accessible name.
         FDropdown's root element IS the <select>, so aria-label falls through. -->
    <FDropdown
      data-test="edit-preset-select"
      aria-label="Edit preset"
      :model-value="store.activeName ?? ''"
      :options="editOptions"
      @update:model-value="store.selectPreset($event)"
    />

    <span class="field-label">New preset</span>
    <!-- A placeholder is the last-resort source for an accessible name, and it
         disappears the moment the field has content, so name these two
         explicitly (issue #15). The seed's placeholder is worse still: "Random"
         names a state, not the field. -->
    <input
      :id="newNameId"
      v-model="newName"
      data-test="new-preset-name"
      class="name-input"
      aria-label="New preset name"
      placeholder="New preset name"
      @keyup.enter="create"
    />
    <FDropdown
      :model-value="builtinChoice"
      data-test="builtin-select"
      aria-label="Base new preset on built-in"
      :options="builtinOptions"
      @update:model-value="onBuiltinChange"
    />
    <FButton data-test="create-preset" variant="tool" @click="create">Create</FButton>
    <FButton
      data-test="reset-preset"
      variant="danger"
      :disabled="!store.activeIsDirty"
      :title="resetTitle"
      @click="store.resetActiveToBuiltin()"
    >
      Reset
    </FButton>

    <span class="spacer" />

    <span class="field-label">Seed</span>
    <input
      :id="seedId"
      data-test="seed-input"
      class="name-input seed"
      type="number"
      aria-label="Seed"
      placeholder="Random"
      :disabled="randomEachMap"
      :value="store.activePreset?.seed ?? ''"
      @change="onSeedChange"
    />
    <FButton
      data-test="seed-reroll"
      variant="tool"
      :disabled="!store.activePreset"
      title="Roll a new random seed"
      @click="rerollSeed"
    >
      New seed
    </FButton>
    <FCheckbox v-model="randomEachMap" data-test="random-each-map" label="Random each new map" />
  </div>
</template>

<style scoped>
.preset-bar {
  display: flex;
  /* Wrap at every width, not behind a media query: without it the bar clips its
     trailing controls (Create, Seed, New seed) on any viewport too narrow to fit
     one line, and it is inert on desktop where they already fit. Same fix as the
     preview toolbar in 4718547. */
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--f-panel);
}

.field-label {
  font-weight: 700;
  color: var(--f-text-dim);
  white-space: nowrap;
}

.name-input {
  padding: 4px 8px;
  border: none;
  font: inherit;
  color: var(--f-text);
  background: var(--f-inset);
  box-shadow:
    inset 1px 1px 0 var(--f-edge-dark),
    inset -1px -1px 0 var(--f-edge-light);
}

.name-input:disabled {
  opacity: 0.4;
}

.name-input.seed {
  /* Wide enough for a full u32 seed (max 4294967295, 10 digits) plus the
     number input's spinner buttons. */
  width: 150px;
}

.spacer {
  flex: 1;
}
</style>
