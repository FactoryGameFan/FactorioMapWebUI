import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  STARTING_LAKE_POSITIONS_UNSUPPORTED,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * The render worker's message handling, which is the one part of the cutover
 * that neither the parity specs nor the type system can see.
 *
 * It has two branches - an engine handshake and a render - and the interesting
 * claim is about the gap BETWEEN them. That claim INVERTED in #227: a render
 * arriving before the engine used to be served on the TypeScript path, which
 * was safe because the two paths are byte-identical. With the TypeScript math
 * going away it must be QUEUED instead - a fallback to nothing is not a slower
 * right answer, it is no answer - and a module that will not instantiate must
 * fail its requests rather than silently degrading.
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

/** The nth posted reply as an object, failing loudly rather than short-circuiting. */
function replyAt(index: number): { id: number; error?: string } {
  const entry = posted[index];
  if (!entry) throw new Error(`no reply posted at index ${String(index)}`);
  return entry.message as { id: number; error?: string };
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

  it("queues a render that arrives before the engine, then serves it", async () => {
    const w = await loadWorker();
    expect(w.onmessage).not.toBeNull();

    // Before the handshake the worker must answer NOTHING. This is the
    // assertion that inverted in #227 - it used to require a reply here.
    w.onmessage?.({ data: request(1) });
    expect(posted, "a pre-engine render must be held, not served").toHaveLength(0);

    // A second one, so the drain is exercised with more than one entry and its
    // ORDER can be checked.
    w.onmessage?.({ data: request(2) });
    expect(posted).toHaveLength(0);

    const module = await WebAssembly.compile(readFileSync(wasmPath));
    w.onmessage?.({ data: { kind: "engine", module } });

    // Both, in arrival order. Order matters: the host settles by id, so a
    // reordered drain would still resolve the right promises - which is
    // exactly why it needs asserting rather than assuming.
    expect(posted).toHaveLength(2);
    // Indexed without an optional chain: `posted[0]?.message` short-circuits to
    // `undefined` and the cast then throws a TypeError, which fails the test
    // with the wrong message. `replyAt` fails loudly instead, the way
    // `pixelsOf` already does.
    expect(replyAt(0).id).toBe(1);
    expect(replyAt(1).id).toBe(2);
    expect(pixelsOf(0).length).toBe(12 * 9 * 4);

    // And a render after the handshake is served straight through, with the
    // same pixels a queued one got - so queueing delays a request without
    // changing its answer.
    w.onmessage?.({ data: request(3) });
    expect(posted).toHaveLength(3);
    expect(Array.from(pixelsOf(2))).toEqual(Array.from(pixelsOf(0)));
  }, 120000);

  it("transfers the buffer rather than copying it across the boundary", async () => {
    const w = await loadWorker();
    // The handshake first: since #227 a render before it is queued rather than
    // served, so without this there is no reply to inspect.
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    w.onmessage?.({ data: { kind: "engine", module } });
    w.onmessage?.({ data: request(3) });
    const sent = posted[0];
    if (!sent) throw new Error("the worker posted no reply");
    expect(sent.transfer).toHaveLength(1);
    expect(sent.transfer?.[0]).toBe((sent.message as { buffer: ArrayBuffer }).buffer);
  }, 120000);

  it("fails its renders when the engine will not instantiate, rather than degrading", async () => {
    // A module that does not speak this bundle's ABI is a deployment problem.
    // The worker must stay alive - throwing out of `onmessage` would take the
    // whole slot down - but it must now REPORT rather than fall back. With the
    // TypeScript math gone there is nothing to fall back to, and a deployment
    // that shipped a mismatched module used to look healthy and merely slow.
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
    const message = replyAt(0);
    expect(message.id, "the error must carry the id, or the host strands it").toBe(4);
    expect(message.error).toContain("render engine failed to instantiate");
    // No buffer, so nothing is transferred and the host cannot mistake it for
    // a result.
    expect(posted[0]?.transfer).toBeUndefined();
  }, 120000);

  it("fails a request that was already QUEUED when the engine turned out to be bad", async () => {
    // The queue and the failure path cross here, and this is the case that
    // hangs the panel if it is wrong: a request held before the handshake, and
    // a handshake that then fails. Dropping it would leave its promise pending
    // forever, which is the "Rendering..." hang `useElevationPreview` already
    // carries a comment about for a different cause.
    const w = await loadWorker();
    w.onmessage?.({ data: request(7) });
    expect(posted).toHaveLength(0);

    const notOurEngine = await WebAssembly.compile(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    w.onmessage?.({ data: { kind: "engine", module: notOurEngine } });

    expect(posted, "the queued request must be settled, not dropped").toHaveLength(1);
    const message = replyAt(0);
    expect(message.id).toBe(7);
    expect(message.error).toContain("render engine failed to instantiate");
  }, 120000);

  it("fails a queued request when the host reports the engine could not be loaded", async () => {
    // The other way a handshake can fail: not a bad module, but no module at
    // all - a 404 on `engine.wasm`, or a compile error on the main thread.
    // The host used to swallow that on the grounds that the TypeScript path
    // rendered the same pixels; since #227 the worker QUEUES until the
    // handshake, so a swallowed failure held every tile forever. The host now
    // posts the failure, and the worker must settle the queue with it.
    const w = await loadWorker();
    w.onmessage?.({ data: request(8) });
    expect(posted).toHaveLength(0);

    w.onmessage?.({ data: { kind: "engine", error: "engine.wasm: 404 Not Found" } });

    expect(posted, "the queued request must be settled, not dropped").toHaveLength(1);
    expect(replyAt(0).id).toBe(8);
    expect(replyAt(0).error).toContain("render engine failed to load");
    expect(replyAt(0).error).toContain("404");

    // And a later request fails the same way rather than queueing again.
    w.onmessage?.({ data: request(9) });
    expect(posted).toHaveLength(2);
    expect(replyAt(1).id).toBe(9);
  }, 120000);

  it("posts a render failure rather than throwing out of onmessage", async () => {
    // The case that used to take the whole slot down. `serve()` had no `try`, so
    // a throw escaped `onmessage`, fired the worker's `error` event, and the
    // host terminated the worker and rejected EVERY tile it was holding - one
    // bad request failing every good one beside it, under a constant string
    // that named none of them.
    //
    // A `startingLakePositions` override is simply the cheapest way to make
    // `runRenderRequest` throw. The claim here is about the worker, not about
    // that particular refusal.
    const w = await loadWorker();
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    w.onmessage?.({ data: { kind: "engine", module } });

    expect(() => {
      w.onmessage?.({ data: { ...request(11), startingLakePositions: [{ x: 300, y: 300 }] } });
    }, "a failing render must not escape onmessage").not.toThrow();

    expect(posted).toHaveLength(1);
    const message = replyAt(0);
    expect(message.id, "the error must carry the id, or the host strands it").toBe(11);
    expect(message.error, "the REAL cause, not a constant").toBe(
      STARTING_LAKE_POSITIONS_UNSUPPORTED,
    );
    expect(posted[0]?.transfer, "no buffer, so nothing to transfer").toBeUndefined();
  }, 120000);

  it("keeps serving its other requests after one of them fails", async () => {
    // The whole point of catching rather than crashing: the sibling tiles in
    // the same slot are unaffected. Before the wrap the second request never
    // got an answer at all, because the worker was gone by the time it arrived.
    const w = await loadWorker();
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    w.onmessage?.({ data: { kind: "engine", module } });

    w.onmessage?.({ data: { ...request(12), startingLakePositions: [] } });
    w.onmessage?.({ data: request(13) });

    expect(posted).toHaveLength(2);
    expect(replyAt(0).id).toBe(12);
    expect(replyAt(0).error).toBe(STARTING_LAKE_POSITIONS_UNSUPPORTED);
    expect(replyAt(1).id).toBe(13);
    expect(replyAt(1).error, "the good request must be a result, not an error").toBeUndefined();
    expect(pixelsOf(1).length).toBe(12 * 9 * 4);
  }, 120000);
});
