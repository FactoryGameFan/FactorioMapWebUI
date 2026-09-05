import { encodeRenderRequest, PLANET, bearingTrig } from "../wasm/request";
import type { WasmRenderRequest } from "../wasm/request";
import type { EngineExports } from "../wasm/engine";

/**
 * The engine-backed half of the island finder's stage 1.
 *
 * `cellSurvey.ts` evaluates one Voronoi cell per swept position, and that is
 * **96.3% of island-finding** measured in Chrome - against 3.7% for the graph,
 * rectangle and chunk work, which is pure JavaScript and stays here. So this is
 * the only part of `islands/` that has to cross into Rust, and it is a
 * correctness requirement rather than an optimisation: #371 deleted the
 * TypeScript chain `makeFulgoraStack` used to run on.
 *
 * ## Why it sweeps in BANDS
 *
 * The module writes `[cell_id, cell_x, cell_y]` as three `f64` per position, so
 * a position costs 24 bytes against a 4 MB output buffer - about 175,000
 * positions per call. The finder searches to radius 20,000 (`RADIUS_MAX`) at a step of
 * `grid / 8`, which is about 3.3 million positions, or 80 MB. So a whole search
 * cannot land in one call.
 *
 * Bands are whole ROWS, never a partial one. A band boundary mid-row would make
 * the caller reassemble a row from two calls, and the row is the unit the
 * accumulator walks.
 *
 * ## Why a callback rather than an array
 *
 * Returning the positions would allocate an 836,000-entry array of triples for
 * a search that discards roughly a third of them immediately (`id` below the
 * ocean threshold). The consumer already has a loop; this hands it one position
 * at a time and keeps the module's buffer as the only large allocation.
 */

/**
 * The free variables Fulgora's shared layer reads.
 *
 * `seed0` is `map_seed` as the noise program sees it - i.e. the FULGORA SURFACE
 * seed, not the user's map seed. Derive it with
 * `surfaceSeedForPlanet("fulgora", mapSeed)` before constructing this.
 *
 * Declared here since #371 deleted `expressions/fulgoraShared.ts`; the port is
 * `crates/fmw-noise/src/expressions/fulgora_shared.rs`, and the ABI carries
 * these three as the Fulgora block's seed and two island sliders.
 */
export interface FulgoraCtx {
  /** `map_seed` on the Fulgora surface. */
  readonly seed0: number;
  /** `control:fulgora_islands:frequency` (wire value). Neutral/default = 1. */
  readonly islandsFrequency?: number;
  /** `control:fulgora_islands:size` (wire value). Neutral/default = 1. */
  readonly islandsSize?: number;
}

/** A strided world box to sweep, matching `cellSurvey`'s own `SearchBox`. */
export interface SurveyBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Three `f64` per position: `cell_id`, `cell_x`, `cell_y`. */
const STRIDE_F64 = 3;

/**
 * Sweep `box` at `step`, calling `onPosition` for every position in order.
 *
 * The order is rows-outer, exactly as `surveyIslands` sweeps, because the
 * accumulator's `points` array carries positions in visit order and a reordered
 * sweep would change `IslandCandidate.points` without changing anything the
 * type system or a count could see.
 *
 * Throws on a non-zero status, with the code named - a survey that silently
 * returned nothing would read as "no islands here", which is a legitimate
 * answer for a real box and so cannot be distinguished from a failure.
 */
export function surveyCellsThroughWasm(
  engine: EngineExports,
  ctx: FulgoraCtx,
  box: SurveyBox,
  step: number,
  onPosition: (x: number, y: number, id: number, cellX: number, cellY: number) => void,
): void {
  // The same inclusive-bound arithmetic `surveyIslands` uses. Computed once
  // here rather than per band, so a band boundary cannot round differently from
  // the whole sweep and drop or duplicate a row.
  const nx = Math.floor((box.x1 - box.x0) / step) + 1;
  const ny = Math.floor((box.y1 - box.y0) / step) + 1;
  if (nx <= 0 || ny <= 0) return;

  const maxPositions = engine.survey_max_positions();
  const rowsPerBand = Math.max(1, Math.floor(maxPositions / nx));
  if (rowsPerBand * nx > maxPositions) {
    // One row alone exceeds the buffer. Reachable only for a box far wider than
    // the finder offers, but a silent overrun would be far worse than a throw.
    throw new Error(`survey row of ${String(nx)} positions exceeds the engine's buffer`);
  }

  const trig = bearingTrig(ctx.seed0);
  const scratch = new Uint8Array(engine.memory.buffer, engine.scratch_ptr(), engine.scratch_len());

  for (let row = 0; row < ny; row += rowsPerBand) {
    const rows = Math.min(rowsPerBand, ny - row);
    const bandY0 = box.y0 + row * step;
    const request = {
      id: 0,
      planet: "fulgora",
      view: "landmask",
      seed0: ctx.seed0,
      width: nx,
      height: rows,
      originX: box.x0,
      originY: bandY0,
      tilesPerPixel: step,
      islandsFrequency: ctx.islandsFrequency ?? 1,
      islandsSize: ctx.islandsSize ?? 1,
      startingPositions: [{ x: 0, y: 0 }],
      waterLevel: 0,
      segmentationMultiplier: 1,
      sinStart: trig.sinStart,
      cosStart: trig.cosStart,
      sinVault: trig.sinVault,
      cosVault: trig.cosVault,
    } as unknown as WasmRenderRequest;
    const written = encodeRenderRequest(scratch, request);

    const status = engine.survey_fulgora_cells(written);
    if (status !== 0) {
      throw new Error(`survey_fulgora_cells returned status ${String(status)}`);
    }

    // A fresh view per band: the module can grow its memory, which detaches any
    // earlier view over the same buffer. Reusing one across bands is the class
    // of bug that shows up only on a large search.
    const out = new Float64Array(engine.memory.buffer, engine.render_ptr(), rows * nx * STRIDE_F64);
    for (let ry = 0; ry < rows; ry++) {
      const y = bandY0 + ry * step;
      for (let px = 0; px < nx; px++) {
        const at = (ry * nx + px) * STRIDE_F64;
        onPosition(box.x0 + px * step, y, out[at], out[at + 1], out[at + 2]);
      }
    }
  }
}

/** Whether `PLANET.fulgora` is what this module surveys - pinned for the reader. */
export const SURVEY_PLANET = PLANET.fulgora;
