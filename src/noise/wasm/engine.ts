/**
 * Loading the WASM engine, and running one render through it.
 *
 * ## One compile, N instances
 *
 * `WebAssembly.Module` is structured-cloneable, so the main thread compiles the
 * module ONCE and `postMessage`s it to each worker; a worker instantiates once
 * at start and reuses that instance for every request. N workers therefore cost
 * one compile rather than N. {@link compileEngine} and {@link instantiateEngine}
 * are those two halves, kept separate for exactly that reason - a helper that
 * did both would quietly make the pool pay N compiles.
 *
 * ## Where the copy is
 *
 * Reading the output is zero-copy: {@link renderThroughWasm} hands back a
 * `Uint8ClampedArray` VIEW over linear memory. Sending it is not - `postMessage`
 * cannot transfer a view over WebAssembly memory, so a worker must `slice()`
 * once into a fresh `ArrayBuffer` and transfer that. At 1024x1024 that is 4 MB,
 * well under a millisecond against renders measured in seconds.
 *
 * This is written down rather than described as zero-copy because a wrong
 * belief about where a copy happens is exactly the kind of thing that gets
 * repeated. **The view is only valid until the next render** - the buffer is
 * reused - so a caller that keeps one must copy it.
 */
import {
  ABI_VERSION,
  encodeRenderRequest,
  REQUEST_BYTES,
  STATUS,
  type WasmRenderRequest,
} from "./request";

export interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  render_ptr: () => number;
  render_len: () => number;
  request_bytes: () => number;
  abi_version: () => number;
  render_request: (len: number) => number;
  /**
   * Sweep a strided box and write `[cell_id, cell_x, cell_y]` per position.
   *
   * Not a render: it serves the Fulgora island finder, whose stage 1 is 96.3%
   * cell evaluation. See `islands/surveyThroughWasm.ts` for the banding, which
   * exists because a full search is ~20 MB of triples against a 4 MB buffer.
   */
  survey_fulgora_cells: (len: number) => number;
  /** Positions one `survey_fulgora_cells` call can write. */
  survey_max_positions: () => number;
  /**
   * The survey step for this ctx: `grid / 8`, where `grid` moves with
   * `islands_frequency`. Exported so a caller can get it without building the
   * TypeScript stack the survey exists to avoid.
   */
  fulgora_survey_step: (
    seed0: number,
    islandsFrequency: number,
    islandsSize: number,
    sinStart: number,
    cosStart: number,
    sinVault: number,
    cosVault: number,
  ) => number;
}

/** Compile the module. Do this ONCE, on the main thread. */
export async function compileEngine(bytes: BufferSource): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes);
}

/**
 * Instantiate a compiled module, checking that it speaks the ABI this file
 * writes.
 *
 * The check is here rather than at the first render because a version mismatch
 * is a deployment problem, not a request problem: a stale `engine.wasm` beside
 * a new bundle should fail loudly at worker start rather than produce a
 * confusing status code per tile.
 */
export async function instantiateEngine(module: WebAssembly.Module): Promise<EngineExports> {
  return checkAbi((await WebAssembly.instantiate(module, {})).exports as unknown as EngineExports);
}

/**
 * As {@link instantiateEngine}, synchronously.
 *
 * `new WebAssembly.Instance(module)` on an ALREADY-COMPILED module is allowed
 * on any thread - the size limit that forbids synchronous *compilation* on the
 * main thread does not apply to instantiation. That is what lets the render
 * worker's `onmessage` stay synchronous, so message ordering needs no reasoning
 * about a pending promise.
 */
export function instantiateEngineSync(module: WebAssembly.Module): EngineExports {
  return checkAbi(new WebAssembly.Instance(module, {}).exports as unknown as EngineExports);
}

function checkAbi(engine: EngineExports): EngineExports {
  const theirVersion = engine.abi_version();
  if (theirVersion !== ABI_VERSION) {
    throw new Error(
      `engine.wasm speaks ABI v${String(theirVersion)}, this bundle writes v${String(ABI_VERSION)}`,
    );
  }
  const theirBytes = engine.request_bytes();
  if (theirBytes !== REQUEST_BYTES) {
    throw new Error(
      `engine.wasm expects a ${String(theirBytes)}-byte request, this bundle writes ${String(REQUEST_BYTES)}`,
    );
  }
  return engine;
}

/**
 * Run one render.
 *
 * Returns a VIEW over the module's output buffer - see the file header. Throws
 * on a non-zero status, with the status NAMED, because a numeric code in a
 * worker's console is not something anyone decodes twice.
 */
export function renderThroughWasm(
  engine: EngineExports,
  req: WasmRenderRequest,
): Uint8ClampedArray {
  const scratch = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());
  const written = encodeRenderRequest(scratch, req);

  const status = engine.render_request(written);
  if (status !== 0) {
    throw new Error(`WASM render failed: ${STATUS[status] ?? `unknown status ${String(status)}`}`);
  }

  const pixels = req.width * req.height * 4;
  // A fresh view per call: `memory.buffer` is detached and replaced if linear
  // memory ever grows, so a cached view would silently point at nothing.
  return new Uint8ClampedArray(engine.memory.buffer, engine.render_ptr(), pixels);
}
