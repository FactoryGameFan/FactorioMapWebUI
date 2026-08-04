import { describe, it, expect, vi } from "vite-plus/test";

/**
 * **These tests fail if `unstubGlobals` or `restoreMocks` is removed from
 * `vite.config.ts`** (#144, adopted from Vitest's "Writing Tests with AI"
 * guidance).
 *
 * Both flags were turned on to close leaks that nothing in the suite could
 * observe, and that is exactly the problem: a guard against an unobservable
 * leak is indistinguishable from a no-op, so removing the flag would be silent.
 * Turning them on changed **no** existing test - `previewPanel.spec.ts` and
 * `previewClient.spec.ts` pass either way, and the two `previewPanel` tests
 * that were inheriting a `URL` stub from the test before them also pass when
 * run alone. The leak was real but not load-bearing.
 *
 * So these two tests are the observation. Each is a PAIR: the first test dirties
 * state, the second asserts the runner cleaned it. They are order-dependent by
 * construction, which is normally a smell and is here the entire mechanism -
 * hence one `describe` per flag, and no other test in this file.
 *
 * Verified to discriminate rather than merely pass: with `unstubGlobals: false`
 * the global probe below PASSES its dirty test and its clean test both, because
 * the stub survives; with the flag on, the clean test fails on an unrestored
 * global. The assertion messages name the flag so a failure points at the config
 * rather than at this file.
 */

/** A spy target owned by this file, so restoring it cannot affect anything else. */
const subject = {
  value(): string {
    return "original";
  },
};

const REAL_FETCH = globalThis.fetch;

describe("unstubGlobals is in effect", () => {
  it("a test may stub a global", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => "stubbed"),
    );
    expect((globalThis.fetch as unknown as () => string)()).toBe("stubbed");
  });

  it("and the NEXT test sees the real global back", () => {
    expect(
      globalThis.fetch,
      "globalThis.fetch is still stubbed from the previous test - `unstubGlobals: true` is missing from vite.config.ts's test block",
    ).toBe(REAL_FETCH);
  });
});

describe("restoreMocks is in effect", () => {
  it("a test may spy on a method without restoring it by hand", () => {
    vi.spyOn(subject, "value").mockReturnValue("spied");
    expect(subject.value()).toBe("spied");
  });

  it("and the NEXT test sees the real method back", () => {
    expect(
      subject.value(),
      "the spy from the previous test survived - `restoreMocks: true` is missing from vite.config.ts's test block",
    ).toBe("original");
  });
});
