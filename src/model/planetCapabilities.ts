import type { Planet } from "./planets";

/** The views the preview panel can ask for. */
export type PreviewView =
  | "elevation"
  | "terrain"
  | "resources"
  | "enemies"
  | "cliffs"
  | "trees"
  | "rocks"
  | "all";

export interface PlanetCapability {
  /** false = "Client preview is not available for <label> yet." */
  readonly rendered: boolean;
  /**
   * true = the preview panel renders this planet only in dev mode
   * (`useUiStore().devMode`); with dev mode off it shows the "not available
   * yet" message, as if `rendered` were false. `runRenderRequest` ignores it,
   * since the worker has no dev mode. Absent means false.
   */
  readonly devOnly?: boolean;
  /**
   * The views the preview panel offers as toggles for this planet, in toggle
   * order. A view in neither `views` nor `fallToTerrain` gets no toggle, and
   * the render path may refuse it. It may also still serve it: Fulgora renders
   * `landmask` (for `findIslands`) and `resources` though neither is listed.
   */
  readonly views: readonly PreviewView[];
  /** Views that render this planet's terrain instead (what servedView does today). */
  readonly fallToTerrain: readonly (PreviewView | "landmask")[];
}

/**
 * What each planet's preview renders. One table, read by the renderer and the
 * panel. Setting `rendered: true` is not enough on its own: `runRenderRequest`
 * also needs a dispatch branch for the planet, and throws without one.
 */
export const PLANET_CAPABILITIES: Readonly<Record<Planet, PlanetCapability>> = {
  nauvis: {
    rendered: true,
    views: ["elevation", "terrain", "resources", "enemies", "cliffs", "trees", "rocks", "all"],
    fallToTerrain: ["landmask"],
  },
  vulcanus: {
    rendered: true,
    views: ["terrain", "resources", "cliffs", "rocks", "all"],
    fallToTerrain: ["enemies", "trees", "landmask"],
  },
  fulgora: {
    rendered: true,
    views: ["terrain", "all"],
    fallToTerrain: ["enemies", "cliffs", "trees", "rocks"],
  },
  // Dev mode only (#454): the tiles a real surface holds (argmax plus tile
  // correction), and the entities a real surface places over them: the
  // plants (`trees`), the cliffs, stone and the two stromatolites
  // (`resources`), the two pentapod nests (`enemies`), and all of them.
  gleba: {
    rendered: true,
    devOnly: true,
    views: ["terrain", "trees", "cliffs", "resources", "enemies", "all"],
    fallToTerrain: ["rocks", "landmask"],
  },
  aquilo: {
    rendered: true,
    views: ["terrain", "resources", "rocks", "all"],
    fallToTerrain: ["enemies", "cliffs", "trees", "landmask"],
  },
};
