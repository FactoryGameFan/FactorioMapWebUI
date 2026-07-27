import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import App from "../src/App.vue";
import PresetBar from "../src/components/PresetBar.vue";
import PreviewPanel from "../src/components/PreviewPanel.vue";

/**
 * Regressions for the Lighthouse audit in issue #11. Every assertion here maps
 * to a specific failing audit, so a future change that silently reintroduces
 * one gets caught without needing a browser.
 *
 * CSS is deliberately absent: the two contrast failures cannot be asserted
 * under happy-dom, which applies no scoped stylesheet and computes no colors.
 * Those are verified by re-running Lighthouse against a production build.
 */
describe("accessible names on dropdowns (Lighthouse: select-name)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("labels both preset-bar selects", () => {
    const wrapper = mount(PresetBar);
    for (const test of ["edit-preset-select", "builtin-select"]) {
      const select = wrapper.find(`[data-test="${test}"]`);
      expect(select.exists()).toBe(true);
      expect(select.attributes("aria-label")?.trim()).toBeTruthy();
    }
  });

  it("labels the planet select", () => {
    const wrapper = mount(PreviewPanel, { props: { planet: "nauvis" } });
    const select = wrapper.find('[data-test="planet-select"]');
    expect(select.exists()).toBe(true);
    expect(select.attributes("aria-label")?.trim()).toBeTruthy();
  });

  it("leaves no select in the whole app without an accessible name", () => {
    const wrapper = mount(App);
    const selects = wrapper.findAll("select");
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      const name = select.attributes("aria-label") ?? select.attributes("aria-labelledby");
      expect(name?.trim(), `select[data-test=${select.attributes("data-test")}]`).toBeTruthy();
    }
  });
});

describe("landmarks (Lighthouse: landmark-one-main)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("renders exactly one main landmark", () => {
    const wrapper = mount(App);
    expect(wrapper.findAll("main")).toHaveLength(1);
  });

  it("puts the editor inside it, not the preview aside", () => {
    const wrapper = mount(App);
    const main = wrapper.find("main");
    // The editor column is the page's primary content; the server-preview panel
    // beside it is complementary and stays an <aside>.
    expect(main.classes()).toContain("editor");
    expect(main.find("aside").exists()).toBe(false);
  });
});

describe("document head (Lighthouse: html-has-lang, meta-description)", () => {
  // Vitest runs from the project root, so resolve against cwd rather than
  // import.meta.url, which is not a file: URL under this setup.
  const html = readFileSync(resolve("index.html"), "utf8");

  it("declares a language", () => {
    // An empty lang="" counts as absent to a screen reader, which is what the
    // audit actually failed on - so assert the value, not the attribute.
    const match = /<html[^>]*\slang="([^"]*)"/.exec(html);
    expect(match?.[1]).toBeTruthy();
  });

  it("has a non-empty meta description", () => {
    const match = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html);
    expect(match?.[1]?.trim()).toBeTruthy();
  });
});

describe("crawler files (Lighthouse: robots-txt, llms-txt)", () => {
  const read = (name: string) => readFileSync(resolve("public", name), "utf8");

  it("ships a robots.txt that is not the SPA fallback", () => {
    const txt = read("robots.txt");
    // The audit failed because /robots.txt served index.html, so every line was
    // "Syntax not understood". Any HTML here means the real file went missing
    // and the fallback is back.
    expect(txt).not.toContain("<!doctype html>");
    expect(txt).toMatch(/^User-agent:/m);
    expect(txt).toMatch(/^(Allow|Disallow):/m);
  });

  it("ships an llms.txt with the H1 and links the spec requires", () => {
    const txt = read("llms.txt");
    expect(txt).toMatch(/^# .+/m);
    expect(txt).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/);
  });
});
