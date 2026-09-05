/**
 * Fetching and compiling `engine.wasm`, ONCE per page.
 *
 * `WebAssembly.Module` is structured-cloneable, so the main thread compiles the
 * module once and `postMessage`s it to each worker; a worker turns that into an
 * instance synchronously with `new WebAssembly.Instance(module)`. N workers
 * therefore cost one compile rather than N, which is why this is memoised and
 * why nothing here instantiates.
 *
 * **The URL is `new URL("./engine.wasm", import.meta.url)` on purpose.** Vite
 * sees that form statically, emits the file as a hashed asset with the right
 * MIME type, and rewrites the URL - so no plugin, no `?url` suffix, and no
 * copy step in the build.
 */
let compiling: Promise<WebAssembly.Module> | undefined;

/**
 * The compiled engine, compiled at most once for the life of the page.
 *
 * Rejects if the module cannot be fetched or compiled, and the rejection is
 * memoised with the promise. There is no TypeScript renderer to fall back to
 * since #227 and #371, so callers report the failure: the render host posts
 * it to the worker, which fails its requests with it, and the island finder
 * shows it in its panel.
 */
export function loadEngineModule(): Promise<WebAssembly.Module> {
  compiling ??= (async () => {
    const url = new URL("./engine.wasm", import.meta.url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`engine.wasm: ${String(response.status)} ${response.statusText}`);
    }
    // `compileStreaming` where the server sets `application/wasm`, and an
    // ArrayBuffer otherwise. The fallback is not paranoia: a dev server or a
    // static host that serves the file as `application/octet-stream` makes
    // `compileStreaming` reject outright, and the two produce the same module.
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("application/wasm") && typeof WebAssembly.compileStreaming === "function") {
      return WebAssembly.compileStreaming(Promise.resolve(response));
    }
    return WebAssembly.compile(await response.arrayBuffer());
  })();
  return compiling;
}

/** Test seam: forget the memoised compile. Not used by the app. */
export function resetEngineModuleForTests(): void {
  compiling = undefined;
}
