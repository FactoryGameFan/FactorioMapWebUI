export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}

export async function cacheKey(input: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Bumped when renders already in R2 can no longer be trusted. Each bump changes
// every object key at once, so nothing stored under an older generation is ever
// served again: the next request for each map misses, renders once (one budget
// slot) and is cached under the new key. The old objects stay in the bucket,
// unreachable.
//
// Generation 1 was the key with no generation in it at all. 2 is the version
// guard (#444): before it, during a container rollout the new Worker could reach
// an instance still on the previous image (containers/configuration/rollouts),
// and that render was stored under the NEW FACTORIO_VERSION's key with a one-year
// max-age. The guard stops new ones being written; this retires any that were.
export const CACHE_GENERATION = 2;

// The R2 object key for a preview. The Worker and its tests both build keys
// here, so they cannot disagree about what goes into one.
export async function previewObjectKey(req: object, factorioVersion: string): Promise<string> {
  const key = await cacheKey({ ...req, factorioVersion, cacheGeneration: CACHE_GENERATION });
  return `previews/${key}.png`;
}
