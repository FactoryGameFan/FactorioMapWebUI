import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { compileEngine, instantiateEngine, renderThroughWasm } from "../src/noise/wasm/engine";
import { ABI_VERSION, encodeRenderRequest, MAGIC, REQUEST_BYTES } from "../src/noise/wasm/request";
import {
  renderFulgoraLandMask,
  renderFulgoraTerrain,
} from "../src/noise/preview/renderFulgoraTerrain";
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

function typescriptPixels(w: Window, view: "landmask" | "terrain"): Uint8ClampedArray {
  const opts = {
    seed0: SEED0,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    ctx: { islandsFrequency: w.islandsFrequency, islandsSize: w.islandsSize },
  };
  return (view === "landmask" ? renderFulgoraLandMask(opts) : renderFulgoraTerrain(opts)).data;
}

describe("the WASM engine renders Fulgora's land mask byte-identically", () => {
  it.each(["landmask", "terrain"] as const)(
    "matches the TypeScript %s renderer on every pixel of every window",
    async (view) => {
      const e = await engine();
      for (const w of WINDOWS) {
        const wasm = renderThroughWasm(e, { view, seed0: SEED0, ...w });
        const ts = typescriptPixels(w, view);
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
          `${view} ${w.label}: first difference at byte ${String(firstDiff)}, pixel (${String(px)}, ${String(py)}), ` +
            `world (${String(w.originX + px * w.tilesPerPixel)}, ${String(w.originY + py * w.tilesPerPixel)})`,
        ).toBe(-1);
      }
    },
    120000,
  );

  it("the terrain view really is a different picture from the land mask", async () => {
    // Anti-vacuity for the parametrised test above: if the two views rendered
    // the same pixels, running it twice would be running it once.
    const e = await engine();
    const w = WINDOWS[0] as Window;
    const mask = renderThroughWasm(e, { view: "landmask", seed0: SEED0, ...w }).slice();
    const terrain = renderThroughWasm(e, { view: "terrain", seed0: SEED0, ...w });
    expect(Array.from(terrain)).not.toEqual(Array.from(mask));

    // And the terrain view paints more than the three colours the mask has -
    // it is the eight-way land argmax that makes it worth having.
    const colors = new Set<string>();
    for (let i = 0; i < terrain.length; i += 4) {
      colors.add(`${String(terrain[i])},${String(terrain[i + 1])},${String(terrain[i + 2])}`);
    }
    expect(colors.size).toBeGreaterThan(3);
  }, 120000);

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

/**
 * **Tier 3 against the GAME, not against the other port.**
 *
 * The block above proves the two renderers agree pixel for pixel. This asks a
 * different and stronger question: does the WASM render agree with the image
 * Factorio itself produced, from
 * `factorio --generate-map-preview --map-gen-seed 123456`?
 *
 * ## The seed trap, which looks exactly like a broken port
 *
 * That PNG comes from a **MAP** seed. Every `oracle-*.json` fixture in this
 * repository comes from `sampleExpression`, which forces the **SURFACE** seed.
 * The same number means two different worlds depending on which you compare
 * against. For Fulgora at map seed 123456 the surface seed is 2,967,702,466 -
 * and comparing a correct field against the PNG with the raw seed scored 0.5%
 * overlap where the derived seed scored 99.9%. Nothing about the 0.5% run
 * announced itself as a seed problem.
 */
describe("the WASM engine agrees with the game's own preview PNG", () => {
  it("differs on exactly the same pixels the TypeScript renderer does", async () => {
    const png = readFileSync(
      join(import.meta.dirname, "fixtures", "oracle-preview-fulgora-terrain.seed123456.png"),
    );
    const game = decodePng(new Uint8Array(png), (b) => new Uint8Array(inflateSync(b)));
    const SIZE = 1024;
    expect([game.width, game.height]).toEqual([SIZE, SIZE]);

    const e = await engine();
    const wasm = renderThroughWasm(e, {
      view: "terrain",
      // The SURFACE seed. See the block comment - this is the trap.
      seed0: SEED0,
      width: SIZE,
      height: SIZE,
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });

    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = i * 3;
      const o = i * 4;
      if (
        game.rgb[g] !== wasm[o] ||
        game.rgb[g + 1] !== wasm[o + 1] ||
        game.rgb[g + 2] !== wasm[o + 2]
      ) {
        differing++;
      }
    }

    // An EXACT count, not a bound. `test/previewAgreement.spec.ts` bounds the
    // TypeScript's same comparison at < 4% and records the same 34,788; the two
    // renders are byte-identical, so this must be that number and not merely
    // under a bound. If it moves, one of those two facts changed and the test
    // names which.
    //
    // The history of this number is the point, so it is kept:
    //
    //   34,976  before #273
    //   34,977  after  #273 - typing Fulgora's f32 constants took 13 named
    //           fields to bit-exact and moved the IMAGE by one pixel, in the
    //           wrong direction. Still the right change; the image is dominated
    //           by the `mix_*` chain, which #273 could not reach.
    //   34,788  after  #279 - narrowing `starting_spot_at_angle` per operation.
    //           **-189 pixels, and this is the change that reaches the
    //           picture**, because both starting cones feed that same `mix_*`
    //           chain. The comment above this line predicted 34,788 before the
    //           work was done, and the measurement landed on it exactly.
    //
    // So the lesson #273 recorded still stands - bit-exactness on named fields
    // is not the same thing as a better image - but it is not a rule that this
    // class of fix never helps. It depends on whether the field is upstream of
    // what the image is made of.
    // Wrapped for the same reason previewAgreement's comparisons are, and with
    // MORE reason: this is the tighter of the two. An exact `toBe` trips on a
    // one-pixel move, where its twin one file over needs 0.04 of the image to
    // shift - and per CLAUDE.md the frozen-exact assertions are the only ones
    // that can see this class of change at all. Unwrapped, the entire report
    // for the most sensitive image assertion in the suite is
    // `expected 34789 to be 34788`.
    withDiffArtifacts(
      {
        spec: "wasmFulgoraRenderParity",
        case: "fulgora-terrain-vs-game",
        game,
        ours: { width: SIZE, height: SIZE, rgba: wasm },
      },
      () => {
        expect(differing).toBe(34788);
        expect(differing / (SIZE * SIZE)).toBeLessThan(0.04);
      },
    );
  }, 300000);

  it("the surface seed is what makes that comparison work at all", async () => {
    // The anti-vacuity for the seed trap, and it is worth the render: with the
    // MAP seed the same comparison collapses, so a future change that quietly
    // used the wrong one would be caught here rather than looking like a
    // regression in the expressions.
    const png = readFileSync(
      join(import.meta.dirname, "fixtures", "oracle-preview-fulgora-terrain.seed123456.png"),
    );
    const game = decodePng(new Uint8Array(png), (b) => new Uint8Array(inflateSync(b)));
    const SIZE = 256;
    const e = await engine();
    const withMapSeed = renderThroughWasm(e, {
      view: "terrain",
      seed0: 123456,
      width: SIZE,
      height: SIZE,
      originX: -512,
      originY: -512,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });
    let differing = 0;
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const g = (py * 1024 + px) * 3;
        const o = (py * SIZE + px) * 4;
        if (
          game.rgb[g] !== withMapSeed[o] ||
          game.rgb[g + 1] !== withMapSeed[o + 1] ||
          game.rgb[g + 2] !== withMapSeed[o + 2]
        ) {
          differing++;
        }
      }
    }
    // Nowhere near the ~3% the surface seed reaches.
    expect(differing / (SIZE * SIZE)).toBeGreaterThan(0.4);
  }, 300000);
});

/**
 * The scrap half of #224's tier-3 gate.
 *
 * **A SUPERSET assertion, and against the FOOTPRINT rather than a rendered
 * overlay** - both deliberate, and both inherited from
 * `test/previewAgreement.spec.ts`, which asks the same question of the
 * TypeScript.
 *
 * Superset, never equality, because `ResourceEntityPrototype::map_grid` defaults
 * to true: the game draws solid ore as a 2x2-block checkerboard and shows about
 * 0.5 pixels per entity. Requiring equality would bake that 2x under-placement
 * into the renderer.
 *
 * Footprint, not the rolled overlay, because a roll paints only where a random
 * draw succeeds - about 40% of the positions where the probability is nonzero.
 * Diffing rolled pixels against the game's drawn pixels measures the salt, not
 * the model. Whether the model rolls at the right RATE is a separate question
 * with its own gate.
 */
describe("the WASM engine's scrap footprint contains the game's scrap", () => {
  it("covers all but a handful of the pixels the game drew", async () => {
    const SIZE = 1024;
    const load = (name: string) =>
      decodePng(
        new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name))),
        (b) => new Uint8Array(inflateSync(b)),
      );
    const off = load("oracle-preview-fulgora-terrain.seed123456.png");
    const on = load("oracle-preview-fulgora-scrap.seed123456.png");

    const e = await engine();
    const footprint = renderThroughWasm(e, {
      view: "scrapFootprint",
      seed0: SEED0,
      width: SIZE,
      height: SIZE,
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });

    let gameScrap = 0;
    let outside = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = i * 3;
      // A pixel the scrap render changed is a pixel the game drew scrap on.
      if (
        off.rgb[g] === on.rgb[g] &&
        off.rgb[g + 1] === on.rgb[g + 1] &&
        off.rgb[g + 2] === on.rgb[g + 2]
      ) {
        continue;
      }
      gameScrap++;
      if (footprint[i * 4] === 0) outside++;
    }

    // The same numbers `previewAgreement.spec.ts` measures for the TypeScript.
    //
    // `gameScrap` is a property of the PNG pair alone - it counts pixels the
    // game's own two renders differ on - so no change to this port can move it.
    // It is 1825 and must stay 1825; if it ever moves, a fixture changed.
    //
    // **`outside` went 1 -> 0 with #279.** Narrowing `starting_spot_at_angle`
    // moved the starting cones onto the game's own values, and the single game
    // scrap pixel that used to fall outside the model's footprint is now inside
    // it. The footprint is a superset of the game's scrap with nothing left
    // over - which is the strongest form this assertion can take, so it is
    // pinned at 0 rather than at "at most 1".
    expect(gameScrap).toBe(1825);
    expect(outside).toBe(0);
  }, 300000);

  it("the footprint is neither empty nor everything, so the superset is not free", async () => {
    // Anti-vacuity. A view that painted every pixel would contain the game's
    // scrap trivially, and one that painted none would fail loudly - it is the
    // middle that makes the assertion mean something.
    const SIZE = 512;
    const e = await engine();
    const footprint = renderThroughWasm(e, {
      view: "scrapFootprint",
      seed0: SEED0,
      width: SIZE,
      height: SIZE,
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      tilesPerPixel: 1,
      islandsFrequency: 1,
      islandsSize: 1,
    });
    let painted = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (footprint[i * 4] !== 0) painted++;
    const share = painted / (SIZE * SIZE);
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.5);
  }, 300000);
});
