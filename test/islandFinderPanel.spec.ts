import { describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import IslandFinderPanel from "../src/components/IslandFinderPanel.vue";
import { usePresetsStore } from "../src/store/presets";
import { useUiStore } from "../src/store/ui";
import type { FindOptions, IslandResult } from "../src/noise/islands/findIslands";

function row(over: Partial<IslandResult> = {}): IslandResult {
  return {
    cellX: 1,
    cellY: 2,
    id: 0.8,
    klass: "mesa",
    sampleCount: 40,
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    centroidX: 50,
    centroidY: 60,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    rectTiles: { width: 80, height: 80 },
    landTiles: 9000,
    fullChunks: 7,
    refined: true,
    clipped: false,
    chainId: 0,
    distanceFromSpawn: 78,
    ...over,
  } as IslandResult;
}

/** Same shape as `actionBar.spec.ts`'s stub - `navigator.clipboard` is absent in this environment. */
function stubClipboard(impl: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(impl) },
    configurable: true,
  });
}

function setup(find: (opts: FindOptions) => Promise<IslandResult[]>) {
  setActivePinia(createPinia());
  const store = usePresetsStore();
  store.createFromBuiltin("Default", "t");
  store.activePreset!.seed = 123456;
  return mount(IslandFinderPanel, { props: { planet: "fulgora", find } });
}

describe("IslandFinderPanel", () => {
  it("renders one row per island with its rectangle in TILES, not pixels", async () => {
    const w = setup(async () => [row(), row({ cellX: 9, rectTiles: { width: 40, height: 20 } })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    const rows = w.findAll('[data-test="island-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain("80");
  });

  it("emits jump with the island centroid when a row is clicked", async () => {
    const w = setup(async () => [row({ centroidX: 1234, centroidY: -567 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="island-row"]').trigger("click");
    expect(w.emitted("jump")?.[0]).toEqual([{ x: 1234, y: -567 }]);
  });

  it("copies a Factorio gps tag whose coordinates match the Position column", async () => {
    // The tag and the printed position must round the same way, or the number
    // you read and the number you paste disagree - which reads as a bug even
    // though both are "right". Fractional inputs are what make that visible;
    // whole numbers would pass under either rounding rule.
    const written: string[] = [];
    stubClipboard(async (t) => {
      written.push(t);
    });
    const w = setup(async () => [row({ centroidX: 1234.6, centroidY: -567.2 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="island-gps"]').trigger("click");
    await flushPromises();

    expect(written).toEqual(["[gps=1235,-567,fulgora]"]);
    expect(w.find('[data-test="island-row"]').findAll("td")[0]!.text()).toContain("1235, -567");
  });

  it("does not jump the preview when the copy button inside a row is clicked", async () => {
    // The whole ROW carries a click handler that emits `jump`. Without
    // `.stop` on the button, one copy would also move the preview - the
    // classic nested-click bug, and invisible in a test that only asserts
    // the clipboard got the right text.
    stubClipboard(async () => {});
    const w = setup(async () => [row()]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="island-gps"]').trigger("click");
    await flushPromises();

    expect(w.emitted("jump")).toBeUndefined();
  });

  it("confirms the copy on the clicked row only, not on every row", async () => {
    stubClipboard(async () => {});
    const w = setup(async () => [row({ cellX: 1 }), row({ cellX: 9 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();

    await w.findAll('[data-test="island-gps"]')[1]!.trigger("click");
    await flushPromises();

    const after = w.findAll('[data-test="island-gps"]');
    expect(after[1]!.attributes("data-state")).toBe("copied");
    expect(after[0]!.attributes("data-state")).toBe("idle");
  });

  it("reports a rejected clipboard write instead of looking like it worked", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const w = setup(async () => [row()]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="island-gps"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="island-gps"]').attributes("data-state")).toBe("failed");
  });

  it("reports a missing Clipboard API as a failure, not a dead button", async () => {
    // Insecure origins have no `navigator.clipboard` at all. That is a
    // different branch from a rejected write, and it is the one that turns a
    // button into a no-op with no feedback.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const w = setup(async () => [row()]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="island-gps"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="island-gps"]').attributes("data-state")).toBe("failed");
  });

  it("gives up on a clipboard write that never settles, instead of sitting silent", async () => {
    // Measured in Chrome: with the document unfocused, `writeText` can leave
    // its promise PENDING rather than rejecting - the button held `idle`
    // through 1.8s of polling with no feedback at all. A `catch` never fires
    // for that, so the only thing that turns it into a visible failure is a
    // timeout. The mid-flight `idle` assertion is what stops this passing
    // for the wrong reason (a copy that failed instantly).
    vi.useFakeTimers();
    try {
      stubClipboard(() => new Promise<void>(() => {}));
      const w = setup(async () => [row()]);
      await w.find('[data-test="island-search"]').trigger("click");
      await flushPromises();

      await w.find('[data-test="island-gps"]').trigger("click");
      await flushPromises();
      expect(w.find('[data-test="island-gps"]').attributes("data-state")).toBe("idle");

      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();
      expect(w.find('[data-test="island-gps"]').attributes("data-state")).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults the radius to 1024", () => {
    // Pinned because nothing pinned it before: the default lived in one `ref`
    // and every radius test set its own value, so it could drift silently.
    // Measured in the browser, the previous 5,000 default returned 1,922 rows
    // against roughly 90 to 105 at 1024 - 89 at surface seed 2967702466, 105
    // at 1640314180. See the panel's own comment for why those two numbers
    // differ and why the browser times beside them should not be quoted.
    const w = setup(async () => []);
    expect((w.find('[data-test="island-radius"]').element as HTMLInputElement).value).toBe("1024");
  });

  it("shows FULL CHUNKS, not the raw land-tile count", async () => {
    // The two are different numbers on purpose - a frilly island carries land
    // tiles in chunks no blueprint can use - so this pins that the column
    // reads `fullChunks` and did not silently go back to `landTiles`. The stub
    // keeps them far apart (7 vs 9,000) so neither can pass for the other.
    const w = setup(async () => [row({ fullChunks: 7, landTiles: 9000 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    const cells = w.find('[data-test="island-row"]').findAll("td");
    expect(cells[2]!.text()).toBe("7");
    expect(w.text()).not.toContain("9,000");
  });

  it("divides refined rows from coarse ones so a coarse number is never read as measured", async () => {
    // This replaces a per-row `~` marker. `compareResults` ranks the whole
    // refined GROUP above the unrefined one, so the refined rows are always a
    // contiguous prefix and the marker only ever said "you are past row N" -
    // on 97% of rows in a real radius-5,000 search. One divider says it once.
    const w = setup(async () => [row(), row({ cellX: 9, refined: false })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    // It must sit BETWEEN the two rows, not merely exist somewhere, so this
    // asserts the DOM sequence rather than mere presence - a divider rendered
    // above the first row or below the last would pass an `exists()` check.
    const seq = [
      ...w.element.querySelectorAll('[data-test="island-row"],[data-test="island-coarse-divider"]'),
    ].map((el) => el.getAttribute("data-test"));
    expect(seq).toEqual(["island-row", "island-coarse-divider", "island-row"]);
  });

  it("shows no divider when every row was refined", async () => {
    const w = setup(async () => [row(), row({ cellX: 9 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-coarse-divider"]').exists()).toBe(false);
  });

  it("hides Class and Chain unless dev mode is on", async () => {
    // The chain id has to be a number no other column can spell. A first
    // version used 77 and failed: the row renders chunks 7 beside distance 78,
    // so the table text contains "778" and a substring check matched inside a
    // number that was never the chain id.
    const CHAIN = 987654;
    const w = setup(async () => [row({ klass: "vault", chainId: CHAIN })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("vault");
    expect(w.text()).not.toContain(String(CHAIN));

    useUiStore().setDevMode(true);
    await w.vm.$nextTick();
    expect(w.text()).toContain("vault");
    expect(w.text()).toContain(String(CHAIN));
  });

  it("marks clipped rows so a truncated rectangle is never read as complete", async () => {
    const w = setup(async () => [row({ clipped: true })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-clipped"]').exists()).toBe(true);
  });

  it("does not mark an unclipped row", async () => {
    const w = setup(async () => [row({ clipped: false })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-clipped"]').exists()).toBe(false);
  });

  it("shows the accuracy caveat without needing a search first", () => {
    const w = setup(async () => []);
    expect(w.text()).toMatch(/1 tile/i);
  });

  it("disables the search button while a search is running", async () => {
    let release: (v: IslandResult[]) => void = () => {};
    const w = setup(() => new Promise((r) => (release = r)));
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeDefined();
    release([]);
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeUndefined();
  });

  it("re-enables the search button after cancel, since findIslands resolves rather than rejects on abort", async () => {
    let release: (v: IslandResult[]) => void = () => {};
    const w = setup(() => new Promise((r) => (release = r)));
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="island-cancel"]').trigger("click");
    // findIslands resolves with whatever partial results it collected before
    // noticing the abort signal - it does NOT reject. A future change that
    // made it reject instead would still leave `running` cleared (a `catch`
    // sets `error` but the `finally` still fires), but the button staying
    // enabled here is what proves this path goes through the same success/
    // partial-completion handling as an ordinary finish, not a bespoke abort
    // branch.
    release([]);
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeUndefined();
    expect(w.find('[data-test="island-cancel"]').exists()).toBe(false);
  });

  it("is inert for a planet other than fulgora", () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    const w = mount(IslandFinderPanel, { props: { planet: "nauvis", find: async () => [] } });
    expect(w.find('[data-test="island-search"]').exists()).toBe(false);
  });

  it("forwards the preset's fulgora_islands slider values into ctx, not just seed0", async () => {
    // `FulgoraCtx.islandsFrequency`/`islandsSize` change the Voronoi grid
    // constant both the survey step and every render window derive from
    // (see elevationPreviewCtx.ts / fulgoraShared.ts). A ctx carrying only
    // seed0 makes the finder survey and render the DEFAULT grid even when
    // the preset moved these sliders - a different map than the preview
    // beside it shows.
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    store.activePreset!.seed = 123456;
    store.activePreset!.autoplaceControls.fulgora_islands = {
      frequency: 1.4,
      size: 0.6,
      richness: 1,
    };
    let seenCtx: { seed0: number; islandsFrequency?: number; islandsSize?: number } | undefined;
    const w = mount(IslandFinderPanel, {
      props: {
        planet: "fulgora",
        find: async (opts: FindOptions) => {
          seenCtx = opts.ctx;
          return [];
        },
      },
    });
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(seenCtx?.islandsFrequency).toBe(1.4);
    expect(seenCtx?.islandsSize).toBe(0.6);
  });

  it("does not clamp the radius field while it is being typed into", async () => {
    const w = setup(async () => []);
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    // `FNumberInput` commits on the native `change` event, not on every
    // keystroke - this is the moment a naive setter used to snap the field
    // to RADIUS_MIN (500) before the rest of a value like "5000" was typed.
    await input.trigger("change");
    expect((input.element as HTMLInputElement).value).toBe("5");
  });

  it("clamps the radius field on blur", async () => {
    const w = setup(async () => []);
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    await input.trigger("change");
    await input.trigger("blur");
    expect((input.element as HTMLInputElement).value).toBe("500");
  });

  it("never passes an out-of-range radius to findIslands, even without a blur first", async () => {
    let seenRadius: number | undefined;
    const w = setup(async (opts) => {
      seenRadius = opts.radius;
      return [];
    });
    const input = w.find('[data-test="island-radius"]');
    (input.element as HTMLInputElement).value = "5";
    await input.trigger("change");
    // No blur - straight to search. The guarantee has to hold here too.
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(seenRadius).toBe(500);
  });
});
