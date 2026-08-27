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
 * **A render that arrives before the engine message is QUEUED, not served.**
 * That is new in #227 and it reverses the rule this file used to state. While
 * both ports existed a request landing first could simply take the TypeScript
 * path, because the two are byte-identical - there was no window in which the
 * worker was wrong, only one in which it was slower. #227 deletes the
 * TypeScript math, so that fallback stops being a slower right answer and
 * becomes no answer at all. Holding the request costs one module compile of
 * latency, once per page, and is the only option that stays correct.
 *
 * **A module that fails to instantiate is now an ERROR rather than a silent
 * degrade.** It used to set `engine = undefined` and keep rendering on
 * TypeScript, which meant a deployment that shipped a mismatched module looked
 * healthy and merely ran slowly. With nothing to degrade to, the honest
 * response is to fail the requests and say why.
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

/**
 * What the worker posts when it cannot render at all.
 *
 * Carries the request `id` so the host can settle exactly that promise, the
 * way a result does. Without the id a failed engine would strand every pending
 * tile rather than rejecting them.
 */
export interface RenderErrorMessage {
  readonly id: number;
  readonly error: string;
}

let engine: EngineExports | undefined;

/**
 * Set once the engine message has been handled, whether or not it worked.
 *
 * Distinguishes "no engine YET" - queue - from "no engine EVER" - fail. Without
 * it a failed instantiate is indistinguishable from the startup window, and the
 * queue would grow forever while the panel sat on "Rendering...".
 */
let engineSettled = false;

/** Why instantiation failed, for the message the host rejects with. */
let engineError = "";

/** Requests that arrived before the engine did. Drained in arrival order. */
const queued: ElevationRenderRequest[] = [];

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

function serve(req: ElevationRenderRequest): void {
  if (engine === undefined) {
    const message: RenderErrorMessage = { id: req.id, error: engineError };
    self.postMessage(message);
    return;
  }
  const result = runRenderRequest(req, engine);
  self.postMessage(result, [result.buffer]);
}

self.onmessage = (e: MessageEvent<ElevationRenderRequest | EngineMessage>) => {
  const data = e.data;
  if (isEngineMessage(data)) {
    try {
      engine = instantiateEngineSync(data.module);
    } catch (err) {
      engine = undefined;
      engineError = `render engine failed to instantiate: ${String(err)}`;
    }
    engineSettled = true;
    // Drained in arrival order, and the array is emptied BEFORE serving so a
    // re-entrant post cannot see a stale queue.
    for (const req of queued.splice(0)) serve(req);
    return;
  }
  if (!engineSettled) {
    queued.push(data);
    return;
  }
  serve(data);
};
