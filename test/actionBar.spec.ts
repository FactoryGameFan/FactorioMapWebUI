import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import ActionBar from "../src/components/ActionBar.vue";

function stubClipboard(impl: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(impl) },
    configurable: true,
  });
}

describe("ActionBar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an enabled Copy string button when a preset is active", () => {
    setActivePinia(createPinia());
    const wrapper = mount(ActionBar);
    const button = wrapper.find('[data-test="copy-string"]');
    expect(button.exists()).toBe(true);
    expect(button.attributes("disabled")).toBeUndefined();
  });

  it("shows success feedback after copying the exchange string", async () => {
    setActivePinia(createPinia());
    stubClipboard(() => Promise.resolve());
    const wrapper = mount(ActionBar);

    await wrapper.find('[data-test="copy-string"]').trigger("click");
    await flushPromises();

    const status = wrapper.find('[data-test="copy-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toBe("Copied!");
    expect(status.attributes("role")).toBe("status");
  });

  it("shows failure feedback when the clipboard write rejects", async () => {
    setActivePinia(createPinia());
    stubClipboard(() => Promise.reject(new Error("denied")));
    const wrapper = mount(ActionBar);

    await wrapper.find('[data-test="copy-string"]').trigger("click");
    await flushPromises();

    const status = wrapper.find('[data-test="copy-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toBe("Copy failed");
  });

  it("shows no status before any copy attempt", () => {
    setActivePinia(createPinia());
    const wrapper = mount(ActionBar);
    expect(wrapper.find('[data-test="copy-status"]').exists()).toBe(false);
  });

  it("enables Download ZIP and builds a blob URL on click", async () => {
    setActivePinia(createPinia());
    const createObjectURL = vi.fn(() => "blob:stub");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const wrapper = mount(ActionBar);
    const btn = wrapper.find('[data-test="download-zip"]');
    expect(btn.attributes("disabled")).toBeUndefined();

    await btn.trigger("click");
    // buildZip -> JSZip.generateAsync resolves across macrotasks/setImmediate,
    // which flushPromises (microtasks only) does not drain. Poll rather than
    // sleep: a fixed 100 ms wait failed whenever the zip took longer, as on a
    // loaded runner, with nothing wrong (test-pruning audit, 2026-11-26).
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
