import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import type { EngineExports } from "../src/noise/wasm/engine";

/**
 * A render cache for the tier-3 render specs, so a picture several tests read
 * is drawn once per file rather than once per test.
 *
 * **The key is the WHOLE request, serialized.** Not a label, not the window,
 * not the fields a reader thinks matter. Vulcanus once compared a capture made
 * with the ore levers at size 0 against a render that left them at 1, and
 * nothing noticed for weeks (see `DIFFERING_PX` in
 * `wasmVulcanusRenderParity.spec.ts`). A cache keyed on fewer fields than the
 * request would hand one of those renders out for the other, silently. So
 * every own field goes into the key, at every depth, and the serializer keeps
 * apart the values `JSON.stringify` would merge: `undefined` (which it drops),
 * `-0` (which it prints as `0`), and `NaN` and the infinities (which it prints
 * as `null`). Keys are sorted, because the renderer does not read field order
 * and two spellings of one request should share a picture.
 *
 * **Every read is a fresh copy.** The cache holds one master per request and
 * hands out `slice()`s of it, so a test that writes into its pixels cannot
 * change what the next test reads. At 1024 x 1024 that copy is 4 MB, well
 * under a millisecond against renders measured in seconds.
 *
 * **It fills lazily.** A test filtered to run alone with `-t` still renders
 * everything it reads; nothing depends on another test having run first.
 *
 * A request that throws is not cached, so a refusal is asked again each time.
 * The cache does not key on the engine instance: every instance in a spec
 * comes from the one compiled `engine.wasm`, so the same request gets the same
 * bytes from any of them.
 */
export function createRenderCache(): (
  req: ElevationRenderRequest,
  engine: EngineExports,
) => Uint8ClampedArray {
  const cache = new Map<string, Uint8ClampedArray>();
  return (req, engine) => {
    const key = requestKey(req);
    let master = cache.get(key);
    if (!master) {
      master = new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
      cache.set(key, master);
    }
    return master.slice();
  };
}

/**
 * A canonical string for a render request: every own field at every depth,
 * keys sorted, with `undefined`, `-0`, `NaN` and the infinities each written
 * as its own token rather than merged with a neighbour.
 */
export function requestKey(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value)) return "NaN";
    // `String` keeps Infinity and -Infinity apart and prints every finite
    // double in a form that reads back to the same double.
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "t" : "f";
  if (Array.isArray(value)) return `[${value.map(requestKey).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${requestKey((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  // A function, symbol or bigint has no business in a render request.
  throw new Error(`requestKey: cannot key a ${typeof value}`);
}
