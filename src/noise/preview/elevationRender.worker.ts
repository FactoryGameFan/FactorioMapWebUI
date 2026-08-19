/// <reference lib="webworker" />
import { runRenderRequest, type ElevationRenderRequest } from "./elevationRenderRequest";
import { instantiateEngineSync } from "../wasm/engine";
import type { EngineExports } from "../wasm/engine";

/**
 * The render worker.
 *
 * It handles two message kinds. A `{ kind: "engine" }` message carries a
 * COMPILED `WebAssembly.Module` from the main thread, which this instantiates
 * once and reuses; anything else is a render request.
 *
 * **A render that arrives before the engine message is not a bug.** The two
 * render paths are byte-identical (`test/wasmFulgoraRenderParity.spec.ts`), so a
 * request that lands first simply takes the TypeScript path. That is what makes
 * the whole cutover safe: there is no window in which the worker is wrong, only
 * one in which it is slower.
 *
 * Instantiation is SYNCHRONOUS. `new WebAssembly.Instance(module)` is allowed
 * on an already-compiled module on any thread - the size limit that forbids
 * synchronous COMPILATION on the main thread does not apply - so `onmessage`
 * stays synchronous and message ordering needs no reasoning about pending
 * promises.
 */
export interface EngineMessage {
  readonly kind: "engine";
  readonly module: WebAssembly.Module;
}

let engine: EngineExports | undefined;

/**
 * A user-defined guard rather than an inline `"kind" in data` check.
 *
 * An inline check narrows the positive branch and leaves the negative one as
 * the union, because `ElevationRenderRequest` does not forbid a `kind`
 * property. The guard narrows both.
 */
function isEngineMessage(m: ElevationRenderRequest | EngineMessage): m is EngineMessage {
  return "kind" in m && m.kind === "engine";
}

self.onmessage = (e: MessageEvent<ElevationRenderRequest | EngineMessage>) => {
  const data = e.data;
  if (isEngineMessage(data)) {
    try {
      engine = instantiateEngineSync(data.module);
    } catch {
      // A module that does not speak this bundle's ABI is a deployment
      // problem, and the right response is to keep rendering. Swallowing it
      // here rather than throwing keeps the worker alive; the host has already
      // logged the version mismatch.
      engine = undefined;
    }
    return;
  }
  const result = runRenderRequest(data, engine);
  self.postMessage(result, [result.buffer]);
};
