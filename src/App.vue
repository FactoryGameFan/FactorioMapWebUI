<script setup lang="ts">
import { ref } from "vue";
import ActionBar from "./components/ActionBar.vue";
import AdvancedTab from "./components/AdvancedTab.vue";
import ElevationPreviewPanel from "./components/ElevationPreviewPanel.vue";
import EnemyTab from "./components/EnemyTab.vue";
import ImportPanel from "./components/ImportPanel.vue";
import PresetBar from "./components/PresetBar.vue";
import PreviewPanel from "./components/PreviewPanel.vue";
import ResourcesTab from "./components/ResourcesTab.vue";
import TerrainTab from "./components/TerrainTab.vue";
import type { Planet } from "./model/planets";
import FTabs from "./ui/FTabs.vue";

const TABS = ["Resources", "Terrain", "Enemy", "Advanced", "Preview"];
const activeTab = ref("Resources");
const selectedPlanet = ref<Planet>("nauvis");
const showImport = ref(false);
</script>

<template>
  <div class="app">
    <header class="titlebar">
      <span>Map generator</span>
      <a
        class="repo-link"
        href="https://github.com/wormeyman/FactorioMapWebUI"
        target="_blank"
        rel="noopener noreferrer"
        title="View this project on GitHub"
        aria-label="View this project on GitHub"
      >
        <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
          />
        </svg>
      </a>
    </header>
    <PresetBar />
    <ImportPanel v-if="showImport" @close="showImport = false" />
    <div class="body">
      <main class="editor f-bevel-out">
        <FTabs v-model="activeTab" :tabs="TABS" />
        <div class="tab-content">
          <ResourcesTab v-if="activeTab === 'Resources'" />
          <TerrainTab v-else-if="activeTab === 'Terrain'" />
          <EnemyTab v-else-if="activeTab === 'Enemy'" />
          <ElevationPreviewPanel v-else-if="activeTab === 'Preview'" :planet="selectedPlanet" />
          <AdvancedTab v-else />
        </div>
      </main>
      <aside class="preview f-bevel-out">
        <PreviewPanel v-model:planet="selectedPlanet" />
      </aside>
    </div>
    <ActionBar @import-requested="showImport = true" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100vh;
  padding: 8px;
}

.titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
}

.repo-link {
  display: inline-flex;
  align-items: center;
  color: var(--f-text-dim);
}

.repo-link:hover {
  color: var(--f-text);
}

.body {
  display: grid;
  grid-template-columns: minmax(480px, 1fr) minmax(420px, 1fr);
  gap: 8px;
  flex: 1;
}

/*
 * The two columns need 480 + 420 + 8 gap = 908, plus 16 of .app padding = 924 of
 * usable width, and neither minmax floor ever yields - which pinned the whole
 * page at a 1130px layout width on every device, so even a tablet in portrait
 * scrolled sideways. Below the breakpoint they stack instead.
 *
 * 960, not 900: a media query measures the viewport INCLUDING the scrollbar,
 * while the 924 above is usable width EXCLUDING it. With a 15px scrollbar the
 * two-column layout needs ~939 of device width, so a 900 breakpoint left
 * 901-939 rendering two columns in too little room (measured: 30px of overflow
 * at 901). 960 clears it with headroom for wider scrollbars.
 *
 * Editor above the preview panel, in DOM order: the editor is what the user came
 * to use, and the server-preview panel is a large mostly-empty box until Generate
 * is pressed.
 */
@media (max-width: 960px) {
  .body {
    grid-template-columns: 1fr;
  }
}

.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--f-panel);
  padding: 8px;
  /* Grid items default to min-width:auto, so a 1fr column still refuses to shrink
     below its content's min-content width - which is how one wide child could
     otherwise push the whole page wider than the viewport. */
  min-width: 0;

  /* Query container for the control tables (see the @container block in
     factorio.css). The tables live in here, so what actually constrains them is
     this column's width, not the viewport's - and above the 960px breakpoint the
     two are very different: at a 978px viewport this column is only 480px wide.
     Safe to make a containment context: the only absolutely-positioned elements
     under here are the slider internals, each inside its own position:relative
     track, and FInfo tooltips are native title attributes. */
  container-type: inline-size;
  container-name: editor;
}

.tab-content {
  flex: 1;
}

.preview {
  background: var(--f-panel);
  padding: 8px;
  /* See .editor - grid items need this to be allowed to shrink. */
  min-width: 0;
}
</style>
