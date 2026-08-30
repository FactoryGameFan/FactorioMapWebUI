/**
 * Order-priority overlay resolver: at a world tile, which resource patch (if any)
 * is drawn. The game places resources in autoplace `order` sequence and a later
 * patch overwrites an earlier one where they overlap; the map preview mirrors that
 * by letting the FIRST resource in order-priority whose `probability >= 0.5` win
 * (M3a solid-footprint - the per-tile stipple roll is deferred to M3.5).
 *
 * Priority = autoplace `order` ("b" before "c"), then `patchSetIndex` (init order)
 * within an order. All six resources share one candidate stream partitioned by
 * `skip_span = 6` / `skip_offset = patchSetIndex` (regular set), so each resource's
 * field is built with those skip params (unlike the pure-regular oracle, which uses
 * span 1). See docs/superpowers/plans/2026-07-19-milestone3a-regular-patches.md T5.
 *
 * M3b adds the starting (near-spawn guaranteed) patches for the four solids: each
 * resource's field is now `makeResourcePatches` = `max(starting, regular)` (solids)
 * or plain regular (oil/uranium, unchanged). The four solids' starting-set stream is
 * partitioned by `skip_span = 4` / `skip_offset = patchSetIndex` (only iron, copper,
 * coal, stone have `hasStartingAreaPlacement`, and they register first, so their
 * starting index equals their regular `patchSetIndex`). The starting favorability
 * couples to the map's `elevation` property (elevation_nauvis on default Nauvis),
 * hence the `segmentationMultiplier`/`waterLevel`/`startingLakePositions` ctx fields.
 */
import type { Point } from "../distanceFromNearestPoint";
import { makeResourcePatches, type ResourcePatches } from "./resourcePatches";
import {
  RESOURCE_CATALOG,
  type ResourceControlLevers,
  type ResourceParams,
} from "./resourceCatalog";

export interface ResourceResolverCtx {
  readonly seed0: number;
  /** Per-resource control levers, keyed by `controlName`; missing => all-default. */
  readonly controls: Record<string, ResourceControlLevers>;
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /** elevation inputs for the starting favorability coupling (solids only). */
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingLakePositions?: readonly Point[];
}

const DEFAULT_LEVERS: ResourceControlLevers = { frequency: 1, size: 1, richness: 1 };

/** The regular set shares one candidate stream across all 6 resources. */
const REGULAR_SKIP_SPAN = 6;
/** The starting set shares one candidate stream across the 4 solids. */
const STARTING_SKIP_SPAN = 4;

const orderRank = (o: "b" | "c"): number => (o === "b" ? 0 : 1);

/**
 * Draw priority between two resources: negative when `a` is drawn in preference to
 * `b` (autoplace `order` "b" before "c", then lower `patchSetIndex`).
 *
 * Exported because `renderResources` needs the *same* rule for a resource this
 * resolver deliberately does not hold - crude oil is painted in its own pass, and
 * whether the threshold pass may overwrite an oil mark is exactly this comparison.
 * Two copies of the rule is how the oil-vs-uranium inversion of #22 item 3 got in.
 */
export function comparePriority(a: ResourceParams, b: ResourceParams): number {
  return orderRank(a.order) - orderRank(b.order) || a.patchSetIndex - b.patchSetIndex;
}

/**
 * The order-priority winner among the resources present (`probability >= 0.5`) at a
 * tile: "b" before "c", then lower `patchSetIndex`. Returns `null` if none present.
 * Pure - the field evaluation lives in {@link makeResourceResolver}.
 */
export function pickWinner(present: readonly ResourceParams[]): ResourceParams | null {
  let best: ResourceParams | null = null;
  for (const p of present) {
    if (best === null || comparePriority(p, best) < 0) best = p;
  }
  return best;
}

/**
 * Build a resolver `(x, y) => ResourceParams | null` over the THRESHOLD catalog
 * resources whose `size` control is > 0, returning the order-priority winner where
 * `probability >= 0.5`.
 *
 * **Crude oil is deliberately absent from the result**, because it is the one
 * `placement: "roll"` resource; `renderResources` paints it separately. A caller
 * that wants "which resource is at this tile, oil included" must consult
 * `makeNauvisOilPlacement` as well. `pickWinner` still ranks oil correctly - it is
 * a pure priority function over whatever it is handed.
 */
export function makeResourceResolver(
  ctx: ResourceResolverCtx,
): (x: number, y: number) => ResourceParams | null {
  const fields: { params: ResourceParams; patches: ResourcePatches }[] = [];
  for (const params of RESOURCE_CATALOG) {
    // Roll resources (crude oil alone) are not thresholded and are not resolved
    // here - `renderResources` paints them from `makeNauvisOilPlacement` in its
    // own pass, because a roll needs the chunk stream and the collision gate that
    // a per-tile pure resolver cannot express. Leaving oil in this loop is what
    // used to paint its whole patch extent as solid ore.
    if (params.placement === "roll") continue;
    const levers = ctx.controls[params.controlName] ?? DEFAULT_LEVERS;
    if (levers.size <= 0) continue; // a disabled resource never appears
    fields.push({
      params,
      patches: makeResourcePatches(params, {
        seed0: ctx.seed0,
        controls: levers,
        startingPositions: ctx.startingPositions,
        segmentationMultiplier: ctx.segmentationMultiplier,
        waterLevel: ctx.waterLevel,
        startingLakePositions: ctx.startingLakePositions,
        regularSkipSpan: REGULAR_SKIP_SPAN,
        regularSkipOffset: params.patchSetIndex,
        startingSkipSpan: STARTING_SKIP_SPAN,
        startingSkipOffset: params.patchSetIndex,
      }),
    });
  }
  // Evaluate in priority order so the first present resource is the winner - no need
  // to build the full `present` list per tile.
  fields.sort((a, b) => comparePriority(a.params, b.params));

  return (x, y) => {
    for (const f of fields) {
      if (f.patches.probability(x, y) >= 0.5) return f.params;
    }
    return null;
  };
}
