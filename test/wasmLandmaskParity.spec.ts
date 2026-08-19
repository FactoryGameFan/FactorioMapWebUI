import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { compileEngine, instantiateEngine, renderThroughWasm } from "../src/noise/wasm/engine";
import { ABI_VERSION, encodeRenderRequest, MAGIC, REQUEST_BYTES } from "../src/noise/wasm/request";
import { renderFulgoraLandMask } from "../src/noise/preview/renderFulgoraTerrain";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * **Tier 3 of the Rust port's gate: byte-identical RGBA.**
 *
 * Tier 1 grades each port against the game and tier 2 folds field checksums;
 * this compares the thing the app actually ships - the pixels - through the
 * real boundary: encode a request into linear memory, call `render_request`,
 * read the output buffer back.
 *
 * It is the first test that exercises the ABI at all, so it is also where an
 * offset error, a byte-order mistake or a row-stride bug surfaces. Those are
 * exactly the failures a checksum over field values cannot see.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

async function engine(): Promise<Awaited<ReturnType<typeof instantiateEngine>>> {
  return instantiateEngine(await compileEngine(readFileSync(wasmPath)));
}

const SEED0 = surfaceSeedForPlanet("fulgora", 123456);

interface Window {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
  readonly islandsFrequency: number;
  readonly islandsSize: number;
}

/**
 * Windows chosen to move the parameters INDEPENDENTLY, so a bug that reads the
 * wrong offset cannot hide behind another field happening to be equal.
 *
 * A single square window at the origin with default sliders would leave width,
 * height, originX, originY, frequency and size all indistinguishable from each
 * other or from a default.
 */
const WINDOWS: readonly Window[] = [
  {
    label: "origin, 1 tile/px",
    width: 64,
    height: 64,
    originX: -32,
    originY: -32,
    tilesPerPixel: 1,
    islandsFrequency: 1,
    islandsSize: 1,
  },
  {
    label: "non-square, off-origin, 8 tiles/px",
    width: 48,
    height: 27,
    originX: -1536.5,
    originY: 704.25,
    tilesPerPixel: 8,
    islandsFrequency: 1,
    islandsSize: 1,
  },
  {
    label: "both sliders moved",
    width: 40,
    height: 40,
    originX: 613,
    originY: -428,
    tilesPerPixel: 4,
    islandsFrequency: 2,
    islandsSize: 3,
  },
  {
    // The origin here is not arbitrary. The first choice, (-100.5, 250.75), is
    // 693 ocean pixels and 0 land - a perfectly valid parity comparison that
    // exercises none of the land branch. The anti-vacuity test below found
    // that; this one is 73 land against 620 ocean.
    label: "fractional tiles per pixel",
    width: 33,
    height: 21,
    originX: -200.5,
    originY: -140.25,
    tilesPerPixel: 0.5,
    islandsFrequency: 0.5,
    islandsSize: 1,
  },
];

function typescriptPixels(w: Window): Uint8ClampedArray {
  return renderFulgoraLandMask({
    seed0: SEED0,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    ctx: { islandsFrequency: w.islandsFrequency, islandsSize: w.islandsSize },
  }).data;
}

describe("the WASM engine renders Fulgora's land mask byte-identically", () => {
  it("matches the TypeScript renderer on every pixel of every window", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const wasm = renderThroughWasm(e, { seed0: SEED0, ...w });
      const ts = typescriptPixels(w);
      expect(wasm.length, `${w.label}: length`).toBe(ts.length);

      // Report the FIRST differing pixel with its coordinates rather than a
      // count, so a red test points at a place on the map you can sample.
      let firstDiff = -1;
      for (let i = 0; i < ts.length; i++) {
        if (wasm[i] !== ts[i]) {
          firstDiff = i;
          break;
        }
      }
      const px = Math.floor(firstDiff / 4) % w.width;
      const py = Math.floor(firstDiff / 4 / w.width);
      expect(
        firstDiff,
        `${w.label}: first difference at byte ${String(firstDiff)}, pixel (${String(px)}, ${String(py)}), ` +
          `world (${String(w.originX + px * w.tilesPerPixel)}, ${String(w.originY + py * w.tilesPerPixel)})`,
      ).toBe(-1);
    }
  });

  it("the windows are not all the same picture, so agreeing on all four says something", async () => {
    // Anti-vacuity. Four windows that happened to render identically would make
    // the test above one assertion repeated.
    const e = await engine();
    const digests = WINDOWS.map((w) => {
      const px = renderThroughWasm(e, { seed0: SEED0, ...w });
      let h = 0;
      for (const v of px) h = (h * 31 + v) | 0;
      return `${String(px.length)}:${String(h)}`;
    });
    expect(new Set(digests).size).toBe(WINDOWS.length);
  });

  it("every window contains land AND ocean, so a constant image cannot pass", async () => {
    // The stronger anti-vacuity: an all-ocean window would agree between the
    // ports while testing nothing about the elevation chain.
    const e = await engine();
    for (const w of WINDOWS) {
      const px = renderThroughWasm(e, { seed0: SEED0, ...w });
      let land = 0;
      let ocean = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 255) land++;
        else ocean++;
      }
      expect(land, `${w.label}: land pixels`).toBeGreaterThan(0);
      expect(ocean, `${w.label}: ocean pixels`).toBeGreaterThan(0);
    }
  });
});

describe("the request encoding is pinned on both sides", () => {
  it("agrees with the module about the header size and the ABI version", async () => {
    const e = await engine();
    expect(e.request_bytes()).toBe(REQUEST_BYTES);
    expect(e.abi_version()).toBe(ABI_VERSION);
  });

  /**
   * The committed round-trip fixture. Its bytes live in the repository rather
   * than being produced by the writer under test, so a change to either side of
   * the layout goes red instead of silently agreeing with itself.
   */
  it("writes exactly the committed bytes for a known request", async () => {
    const fixture = (await import("./fixtures/wasm-request.v1.json")).default;
    const target = new Uint8Array(REQUEST_BYTES);
    const written = encodeRenderRequest(target, fixture.request);
    expect(written).toBe(REQUEST_BYTES);
    expect(Array.from(target)).toEqual(fixture.bytes);
    expect(fixture.magic).toBe(MAGIC);
    expect(fixture.abiVersion).toBe(ABI_VERSION);
  });

  it("refuses a target buffer too small to hold the header", () => {
    expect(() =>
      encodeRenderRequest(new Uint8Array(REQUEST_BYTES - 1), {
        seed0: 1,
        width: 1,
        height: 1,
        originX: 0,
        originY: 0,
        tilesPerPixel: 1,
        islandsFrequency: 1,
        islandsSize: 1,
      }),
    ).toThrow(/needs 104 bytes/);
  });

  it("reports a bad request by status rather than trapping", async () => {
    // Expected errors must not poison the instance: the same engine has to keep
    // working for every later request in that worker. This sends a deliberately
    // wrong magic, then renders normally through the SAME instance.
    const e = await engine();
    const scratch = new Uint8Array(e.memory.buffer, e.scratch_ptr(), e.scratch_len());
    scratch.fill(0, 0, REQUEST_BYTES);
    expect(e.render_request(REQUEST_BYTES)).toBe(2); // bad magic

    const w = WINDOWS[0] as Window;
    const recovered = renderThroughWasm(e, { seed0: SEED0, ...w });
    expect(recovered.length).toBe(w.width * w.height * 4);
  });

  it("refuses a window larger than the render buffer, by status", async () => {
    const e = await engine();
    const side = 1024;
    expect(() =>
      renderThroughWasm(e, {
        seed0: SEED0,
        width: side + 1,
        height: side,
        originX: 0,
        originY: 0,
        tilesPerPixel: 1,
        islandsFrequency: 1,
        islandsSize: 1,
      }),
    ).toThrow(/output too large/);
  });
});
