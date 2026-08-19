import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * The render worker's message handling, which is the one part of the cutover
 * that neither the parity specs nor the type system can see.
 *
 * It has two branches - an engine handshake and a render - and the interesting
 * claim is about the gap BETWEEN them: a render that arrives before the engine
 * message must still succeed, on the TypeScript path. That is what makes the
 * cutover safe rather than merely tested, so it is asserted rather than
 * described.
 *
 * The worker module reads and writes the global `self`, so this installs a
 * minimal one, imports the module fresh per test, and takes it down again.
 * `vi.stubGlobal` is not used because the module captures `self.onmessage` at
 * import time and `unstubGlobals` would restore the global out from under an
 * already-imported module - the ordering hazard `test/mockLeakGuards.spec.ts`
 * exists to pin.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
const SEED0 = surfaceSeedForPlanet("fulgora", 123456);

interface FakeSelf {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (message: unknown, transfer?: unknown[]) => void;
}

const posted: { message: unknown; transfer: unknown[] | undefined }[] = [];
let fakeSelf: FakeSelf;
const realSelf = (globalThis as { self?: unknown }).self;

function request(id: number): ElevationRenderRequest {
  return {
    id,
    seed0: SEED0,
    width: 12,
    height: 9,
    originX: -48,
    originY: -48,
    tilesPerPixel: 8,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    planet: "fulgora",
    view: "landmask",
  };
}

/** The RGBA of the nth posted reply, failing loudly rather than optional-chaining. */
function pixelsOf(index: number): Uint8ClampedArray {
  const entry = posted[index];
  if (!entry) throw new Error(`no reply posted at index ${String(index)}`);
  return new Uint8ClampedArray((entry.message as { buffer: ArrayBuffer }).buffer);
}

/** Import the worker fresh, so each test gets its own `onmessage` closure. */
async function loadWorker(): Promise<FakeSelf> {
  posted.length = 0;
  fakeSelf = {
    onmessage: null,
    postMessage: (message, transfer) => {
      posted.push({ message, transfer: transfer as unknown[] | undefined });
    },
  };
  (globalThis as { self?: unknown }).self = fakeSelf;
  // `resetModules` rather than a cache-busting query string: Vite refuses a
  // fully dynamic import specifier ("Unknown variable dynamic import"), and the
  // module has to re-execute so each test gets its own `onmessage` closure
  // bound to its own fake `self`.
  vi.resetModules();
  await import("../src/noise/preview/elevationRender.worker");
  return fakeSelf;
}

describe("the render worker's engine handshake", () => {
  beforeEach(() => {
    posted.length = 0;
  });
  afterEach(() => {
    (globalThis as { self?: unknown }).self = realSelf;
  });

  it("renders before the engine arrives, and the pixels are the same after it does", async () => {
    const w = await loadWorker();
    expect(w.onmessage).not.toBeNull();

    // Before: no engine has been handed over, so this must take the TypeScript
    // path rather than fail.
    w.onmessage?.({ data: request(1) });
    expect(posted).toHaveLength(1);
    const before = pixelsOf(0);
    expect(before.length).toBe(12 * 9 * 4);

    // The handshake, then the same request again.
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    w.onmessage?.({ data: { kind: "engine", module } });
    expect(posted, "the engine message must not post a reply").toHaveLength(1);

    w.onmessage?.({ data: request(2) });
    expect(posted).toHaveLength(2);
    const after = pixelsOf(1);

    // The whole safety argument for the cutover, in one assertion.
    expect(Array.from(after)).toEqual(Array.from(before));
  }, 120000);

  it("transfers the buffer rather than copying it across the boundary", async () => {
    const w = await loadWorker();
    w.onmessage?.({ data: request(3) });
    const sent = posted[0];
    if (!sent) throw new Error("the worker posted no reply");
    expect(sent.transfer).toHaveLength(1);
    expect(sent.transfer?.[0]).toBe((sent.message as { buffer: ArrayBuffer }).buffer);
  }, 120000);

  it("survives an engine message it cannot use, and keeps rendering", async () => {
    // A module that does not speak this bundle's ABI is a deployment problem.
    // The worker must stay alive and fall back rather than throwing out of
    // `onmessage`, which would take the whole slot down.
    const w = await loadWorker();
    const notOurEngine = await WebAssembly.compile(
      // The smallest valid module: a header and nothing else. It exports no
      // `abi_version`, so instantiation passes and the ABI check throws.
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(() => {
      w.onmessage?.({ data: { kind: "engine", module: notOurEngine } });
    }).not.toThrow();

    w.onmessage?.({ data: request(4) });
    expect(posted).toHaveLength(1);
    expect(pixelsOf(0).length).toBe(12 * 9 * 4);
  }, 120000);
});
