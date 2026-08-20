/**
 * Capture committed oracle fixtures. Run deliberately (not in CI) when a fixture
 * needs (re)generating; it needs a local Factorio 2.1 install.
 *
 *   node --experimental-strip-types test/oracle/capture.ts
 *
 * It writes JSON ground-truth into test/fixtures/, which the CI-safe specs then
 * validate against pure TS - so the reverse-engineered primitives are checked
 * without anyone needing the game.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The .ts extension is required because this file is executed directly by Node
// (`--experimental-strip-types`), which does no extension resolution; the specs,
// run through Vite, import extensionless. allowImportingTsExtensions permits both.
import {
  type DumpedCliffSettings,
  oracleAvailable,
  type Position,
  type Region,
  sampleCliffEntities,
  sampleCliffEntitiesFull,
  sampleExpression,
  sampleTileNames,
  sampleTileNamesFull,
  type TileSample,
  buildVoronoiExpression,
} from "./oracle.ts";
import { TREE_SPECIES } from "../../src/noise/trees/treeCatalog.ts";
// Only `cliffCatalog.ts` is imported from the cliff port here, and that is a
// constraint rather than a preference: this file is executed by bare Node
// (`--experimental-strip-types`), which does no extension resolution, and
// `cliffConnections.ts` imports its own siblings extensionless. `cliffCatalog`
// has no imports at all, so it is the only one that loads.
//
// The connection predicates are therefore RE-DERIVED inside the destroy-probe
// capture rather than imported. That duplication is made safe by
// `test/cliffDestroyProbe.spec.ts`, which imports the REAL `onChunkBorder` /
// `isCliffConnected` / `connectedSides` and asserts every committed target
// satisfies them - so a drift between the two fails a test rather than
// silently selecting the wrong cliffs.
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../../src/noise/cliffs/cliffCatalog.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** A modest scattered grid: fractional coords, negatives, and far-from-origin points. */
function gridPositions(): Position[] {
  const out: Position[] = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      out.push({ x: gx * 13 - 30 + 0.5, y: gy * 17 - 40 + 0.25 });
    }
  }
  out.push({ x: 1000.5, y: -2000.5 }, { x: 12345.75, y: 6789.125 });
  return out;
}

async function captureBasis(): Promise<void> {
  const seed = 123456;
  const inputScale = 0.125;
  const seed1 = 0;
  const positions = gridPositions();
  const expression = `basis_noise{x = x, y = y, seed0 = map_seed, seed1 = ${seed1}, input_scale = ${inputScale}, output_scale = 1}`;

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const values = await sampleExpression(expression, positions, { workDir, seed });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. basis_noise routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts",
      expression,
      seed0: seed,
      seed1,
      inputScale,
      points: positions.map((p, i) => ({ x: p.x, y: p.y, v: values[i] })),
    };
    const out = join(FIXTURES, "oracle-basis.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** multioctave_noise ground truth across octaves / persistence / scales / seeds. */
async function captureMultioctave(): Promise<void> {
  const seed = 123456;
  const positions = gridPositions();
  // Vary every lever, including non-power-of-2 persistence (exercises the
  // fastapprox log2/exp2 in the RMS normalization) and multiple seed1s.
  const configs = [
    { octaves: 1, persistence: 0.5, inputScale: 0.125, outputScale: 1, seed1: 137 },
    { octaves: 2, persistence: 0.5, inputScale: 0.125, outputScale: 1, seed1: 137 },
    { octaves: 3, persistence: 0.5, inputScale: 0.125, outputScale: 2, seed1: 137 },
    { octaves: 4, persistence: 0.9, inputScale: 0.15, outputScale: 1, seed1: 137 },
    { octaves: 5, persistence: 0.7, inputScale: 0.08, outputScale: 3, seed1: 42 },
    { octaves: 6, persistence: 0.65, inputScale: 0.2, outputScale: 1, seed1: 5 },
    { octaves: 4, persistence: 0.45, inputScale: 0.05, outputScale: 1, seed1: 999 },
  ];
  const cases = [];
  for (const c of configs) {
    const expression = `multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = ${c.seed1}, octaves = ${c.octaves}, persistence = ${c.persistence}, input_scale = ${c.inputScale}, output_scale = ${c.outputScale}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, positions, { workDir, seed });
      cases.push({ ...c, values });
      console.log(`  captured octaves=${c.octaves} p=${c.persistence} seed1=${c.seed1}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. multioctave_noise routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts",
    seed0: seed,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-multioctave.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${configs.length} configs x ${positions.length} points)`);
}

/** quick_multioctave_noise ground truth across octaves / multipliers / offset / seeds. */
async function captureQuickMultioctave(): Promise<void> {
  const seed = 123456;
  const positions = gridPositions();
  // Vary octaves, the two per-octave multipliers, offset_x (including the large
  // climate-tree values that exercise the f32 floor), input/output scale and seed1.
  const configs = [
    // octaves=1 pins the base case; offset_x=0 isolates the raw octave.
    { octaves: 1, inputScale: 0.125, outputScale: 1, oosm: 0.6, oism: 0.5, offsetX: 0, seed1: 137 },
    // octave pairing (2*floor(k/2) reseed) first shows up at 3 octaves.
    { octaves: 3, inputScale: 0.125, outputScale: 1, oosm: 0.6, oism: 0.5, offsetX: 0, seed1: 137 },
    // large offset_x (climate-tree scale) -> f32 floor.
    {
      octaves: 4,
      inputScale: 1 / 6,
      outputScale: 2 / 3,
      oosm: 0.7,
      oism: 0.5,
      offsetX: 40000,
      seed1: 42,
    },
    {
      octaves: 5,
      inputScale: 0.1,
      outputScale: 1,
      oosm: 0.65,
      oism: 0.55,
      offsetX: 12000,
      seed1: 5,
    },
    {
      octaves: 6,
      inputScale: 0.08,
      outputScale: 1.5,
      oosm: 0.5,
      oism: 0.5,
      offsetX: 0,
      seed1: 999,
    },
  ];
  const cases = [];
  for (const c of configs) {
    const expression = `quick_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = ${c.seed1}, input_scale = ${c.inputScale}, output_scale = ${c.outputScale}, octaves = ${c.octaves}, octave_output_scale_multiplier = ${c.oosm}, octave_input_scale_multiplier = ${c.oism}, offset_x = ${c.offsetX}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, positions, { workDir, seed });
      cases.push({ ...c, values });
      console.log(
        `  captured octaves=${c.octaves} oism=${c.oism} oosm=${c.oosm} offset=${c.offsetX}`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. quick_multioctave_noise routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts",
    seed0: seed,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-quick-multioctave.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${configs.length} configs x ${positions.length} points)`);
}

/**
 * variable_persistence_multioctave_noise ground truth. This op's `persistence` is a
 * spatially-varying noise EXPRESSION (not a scalar), so the fixture also captures
 * the persistence field itself (route the same expression onto elevation) - the
 * CI-safe spec feeds per-tile p back into the model. A constant persistence would
 * hit a degenerate compile path, so the expression must genuinely vary.
 */
async function captureVariablePersistenceMultioctave(): Promise<void> {
  const seed = 123456;
  const positions = gridPositions();
  // A gentle spatially-varying persistence in (0.1, 0.6). seed1=91 keeps it
  // distinct from the op's own seed1s.
  const persistenceExpr =
    "0.35 + 0.25 * basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 91, input_scale = 0.02, output_scale = 1}";

  // Capture the persistence field once.
  let persistenceField: number[];
  {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      persistenceField = await sampleExpression(persistenceExpr, positions, { workDir, seed });
      console.log("  captured persistence field");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Vary octaves, input/output scale, offset_x (incl. a large climate-scale value
  // that exercises the f32 floor), and seed1 (incl. >= 256 to confirm the shared
  // seed - no per-octave reseed like the quick op).
  const configs = [
    { octaves: 1, inputScale: 1 / 16, outputScale: 1, offsetX: 0, seed1: 7 },
    { octaves: 2, inputScale: 1 / 16, outputScale: 1, offsetX: 0, seed1: 7 },
    { octaves: 3, inputScale: 1 / 8, outputScale: 2, offsetX: 0, seed1: 7 },
    { octaves: 4, inputScale: 1 / 32, outputScale: 1, offsetX: 5000, seed1: 42 },
    { octaves: 5, inputScale: 0.1, outputScale: 1.5, offsetX: 40000, seed1: 5 },
    { octaves: 6, inputScale: 0.08, outputScale: 1, offsetX: 0, seed1: 999 },
    { octaves: 3, inputScale: 1 / 16, outputScale: 1, offsetX: -3, seed1: 256 },
  ];
  const cases = [];
  for (const c of configs) {
    const expression = `variable_persistence_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = ${c.seed1}, input_scale = ${c.inputScale}, output_scale = ${c.outputScale}, offset_x = ${c.offsetX}, octaves = ${c.octaves}, persistence = ${persistenceExpr}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, positions, { workDir, seed });
      cases.push({ ...c, values });
      console.log(`  captured octaves=${c.octaves} offset_x=${c.offsetX} seed1=${c.seed1}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. variable_persistence_multioctave_noise routed onto elevation. persistenceField is the per-tile value of persistenceExpr (also routed onto elevation), fed back into the model by the spec. Regenerate: node --experimental-strip-types test/oracle/capture.ts",
    seed0: seed,
    positions,
    persistenceExpr,
    persistenceField,
    cases,
  };
  const out = join(FIXTURES, "oracle-variable-persistence-multioctave.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${configs.length} configs x ${positions.length} points)`);
}

/**
 * The two multioctave Lua wrappers (`core/prototypes/noise-functions.lua`):
 * `quick_multioctave_noise_persistence` (over the quick op) and
 * `amplitude_corrected_multioctave_noise` (over the variable-persistence op). Both
 * are pure parameter re-mappings - no new RE - captured here as ground truth for
 * the CI-safe port tests. One fixture, two blocks of configs.
 */
async function captureMultioctaveWrappers(): Promise<void> {
  const seed = 123456;
  const positions = gridPositions();

  const quickCfgs = [
    { octaves: 1, inputScale: 1 / 8, outputScale: 1, oism: 0.5, persistence: 0.7, seed1: 14 },
    { octaves: 4, inputScale: 1 / 8, outputScale: 0.8, oism: 0.5, persistence: 0.68, seed1: 14 },
    { octaves: 5, inputScale: 1 / 8, outputScale: 1, oism: 0.5, persistence: 0.75, seed1: 14 },
    { octaves: 3, inputScale: 0.2, outputScale: 2, oism: 0.6, persistence: 0.5, seed1: 42 },
  ];
  const quick = [];
  for (const c of quickCfgs) {
    const expression = `quick_multioctave_noise_persistence{x = x, y = y, seed0 = map_seed, seed1 = ${c.seed1}, input_scale = ${c.inputScale}, output_scale = ${c.outputScale}, octaves = ${c.octaves}, octave_input_scale_multiplier = ${c.oism}, persistence = ${c.persistence}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      quick.push({
        ...c,
        values: await sampleExpression(expression, positions, { workDir, seed }),
      });
      console.log(`  quick_persistence octaves=${c.octaves} seed1=${c.seed1}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const acCfgs = [
    { octaves: 2, inputScale: 1 / 8, offsetX: 1000, persistence: 0.7, amplitude: 0.5, seed1: 1 },
    { octaves: 4, inputScale: 1 / 8, offsetX: 1000, persistence: 0.7, amplitude: 0.5, seed1: 1 },
    { octaves: 6, inputScale: 1 / 16, offsetX: 0, persistence: 0.6, amplitude: 1, seed1: 3 },
    { octaves: 3, inputScale: 0.1, offsetX: 5000, persistence: 0.85, amplitude: 2, seed1: 42 },
  ];
  const amplitudeCorrected = [];
  for (const c of acCfgs) {
    const expression = `amplitude_corrected_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = ${c.seed1}, octaves = ${c.octaves}, input_scale = ${c.inputScale}, offset_x = ${c.offsetX}, persistence = ${c.persistence}, amplitude = ${c.amplitude}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      amplitudeCorrected.push({
        ...c,
        values: await sampleExpression(expression, positions, { workDir, seed }),
      });
      console.log(`  amplitude_corrected octaves=${c.octaves} seed1=${c.seed1}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. The two multioctave Lua wrappers routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts multioctave-wrappers",
    seed0: seed,
    positions,
    quick,
    amplitudeCorrected,
  };
  const out = join(FIXTURES, "oracle-multioctave-wrappers.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

/**
 * The full `elevation_lakes` tree - the first NAMED TREE sampled through the
 * harness. Also captures the two free-var distances (`distance` over
 * starting_positions, and starting_lake_distance capped at 1024) so the CI spec
 * can both drive the EvalCtx assumption and validate distanceFromNearestPoint
 * end-to-end. The grid spans a near-origin band AND far (>1200 tile) points so
 * both `distance` regimes (hypot-driven near spawn, branch2-collapsed far out)
 * are exercised.
 */
async function captureElevationLakes(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  // Near-origin band: the game places real starting lakes here (starting_lake_distance
  // < 1024), so the far-from-spawn empty-lake ctx does NOT reproduce these. Kept to
  // document the fidelity limit and to confirm distance == hypot near spawn; the CI
  // parity test filters these OUT (it asserts only where sld == 1024).
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  // Far rings: large enough radius that starting_lake_distance saturates at 1024
  // (empty-lake ctx is then exact), in many directions. Two radii + fractional
  // offsets keep points off the INTEGER lattice, which is the point - a formula
  // that only fits at integer coordinates should not survive.
  //
  // They are snapped onto the 1/256 MapPosition grid, which is NOT the same thing
  // and was missing until 2026-08-18. `Math.cos` output is not a multiple of
  // 1/256, so the game converted it on the way in and evaluated somewhere the
  // fixture did not record (#186). Seventeen committed fixtures carry ring
  // positions captured that way; `test/captureGrid.ts` recovers them at read
  // time and holds the measurements. New captures do not need recovering.
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  // One deep-field point (stresses the f32 coordinate floor hardest).
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, { workDir, seed });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const elevation = await sample("elevation_lakes");
  console.log("  captured elevation_lakes tree");
  const distance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_positions}",
  );
  console.log("  captured distance (starting_positions)");
  const startingLakeDistance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_lake_positions, maximum_distance = 1024}",
  );
  console.log("  captured starting_lake_distance");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. elevation_lakes (and the two free-var distances) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts elevation-lakes",
    seed0: seed,
    positions,
    elevation,
    distance,
    startingLakeDistance,
  };
  const out = join(FIXTURES, "oracle-elevation-lakes.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * The full `elevation_nauvis` tree (the default Nauvis elevation) routed onto
 * `elevation`, plus the two free-var distances the CI spec needs. Same grid as
 * captureElevationLakes: a near-origin band (where the game places real starting
 * lakes, so starting_lake_distance < 1024) and far rings (>1200 tiles, where it
 * saturates at 1024 and the empty-lake ctx is exact), plus one deep-field point.
 */
async function captureElevationNauvis(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, { workDir, seed });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const elevation = await sample("elevation_nauvis");
  console.log("  captured elevation_nauvis tree");
  const distance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_positions}",
  );
  console.log("  captured distance (starting_positions)");
  const startingLakeDistance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_lake_positions, maximum_distance = 1024}",
  );
  console.log("  captured starting_lake_distance");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. elevation_nauvis (and the two free-var distances) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts elevation-nauvis",
    seed0: seed,
    positions,
    elevation,
    distance,
    startingLakeDistance,
  };
  const out = join(FIXTURES, "oracle-elevation-nauvis.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * The `elevation_nauvis_no_cliff` tree (= `elevation_nauvis_function(added_cliff_elevation
 * = 0)`, the cliffiness field's dependency - see Task 6/`cliff_elevation_nauvis`) routed
 * onto `elevation`, plus the two free-var distances the CI spec needs. Same standard grid
 * as `captureElevationNauvis` (near-origin band where the game places real starting lakes,
 * far rings at r=2200/3300 where starting_lake_distance saturates at 1024, one deep-field
 * point), captured at two seeds so the seam is validated beyond the single default seed.
 */
async function captureElevationNauvisNoCliff(): Promise<void> {
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const seeds = [123456, 777771];
  const cases: {
    seed: number;
    elevation: number[];
    distance: number[];
    startingLakeDistance: number[];
  }[] = [];
  for (const seed of seeds) {
    const sample = async (expression: string): Promise<number[]> => {
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        return await sampleExpression(expression, positions, { workDir, seed });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    };

    const elevation = await sample("elevation_nauvis_no_cliff");
    console.log(`  captured elevation_nauvis_no_cliff tree seed=${seed}`);
    const distance = await sample(
      "distance_from_nearest_point{x = x, y = y, points = starting_positions}",
    );
    console.log(`  captured distance (starting_positions) seed=${seed}`);
    const startingLakeDistance = await sample(
      "distance_from_nearest_point{x = x, y = y, points = starting_lake_positions, maximum_distance = 1024}",
    );
    console.log(`  captured starting_lake_distance seed=${seed}`);
    cases.push({ seed, elevation, distance, startingLakeDistance });
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. elevation_nauvis_no_cliff (= elevation_nauvis_function(added_cliff_elevation = 0), the cliffiness field's dependency) and the two free-var distances, routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts elevation-nauvis-no-cliff",
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-elevation-nauvis-no-cliff.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} seeds)`);
}

/**
 * The full `elevation_island` tree routed onto `elevation`, plus the two free-var
 * distances. Same grid as captureElevationLakes/Nauvis (near-origin band, far rings
 * at r=2200/3300, one deep-field point). elevation_island = elevation_lakes with
 * bias=-1000 and segmentation_multiplier/4.
 */
async function captureElevationIsland(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, { workDir, seed });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const elevation = await sample("elevation_island");
  console.log("  captured elevation_island tree");
  const distance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_positions}",
  );
  console.log("  captured distance (starting_positions)");
  const startingLakeDistance = await sample(
    "distance_from_nearest_point{x = x, y = y, points = starting_lake_positions, maximum_distance = 1024}",
  );
  console.log("  captured starting_lake_distance");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. elevation_island (and the two free-var distances) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts elevation-island",
    seed0: seed,
    positions,
    elevation,
    distance,
    startingLakeDistance,
  };
  const out = join(FIXTURES, "oracle-elevation-island.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * The `temperature` (= `temperature_basic`) climate expression: `clamp(15 + bias +
 * quick_multioctave_noise{...}, -20, 50)`. Routed onto elevation, exactly like
 * `captureElevationLakes` routes `elevation_lakes` - `calculate_tile_properties`
 * just needs SOME property name to key the dump under; the sampled values are
 * whatever `temperature` itself computes. Same standard grid as
 * `captureElevationLakes` (near-origin band, far rings at r=2200/3300, one
 * deep-field point), even though `temperature` has no spawn-distance dependency,
 * for comparability across captures.
 */
async function captureTemperature(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const temperature = await sampleExpression("temperature", positions, { workDir, seed });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. temperature (= temperature_basic) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts temperature",
      seed0: seed,
      positions,
      temperature,
    };
    const out = join(FIXTURES, "oracle-temperature.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The `aux` (= `aux_nauvis`, "terrain type") climate expression: `clamp(0.5 + bias
 * + 0.06*(nauvis_plateaus - 0.4) + quick_multioctave_noise{...}, 0, 1)`. Routed
 * onto elevation, same standard grid as `captureTemperature` (near-origin band,
 * far rings at r=2200/3300, one deep-field point) for comparability across
 * captures. `nauvis_plateaus` is a Nauvis-shared sub-tree (also used by
 * `elevation_nauvis`), so this exercises the shared module at defaults
 * (`control:water:frequency` = 1).
 */
async function captureAux(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const aux = await sampleExpression("aux", positions, { workDir, seed });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. aux (= aux_nauvis) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts aux",
      seed0: seed,
      positions,
      aux,
    };
    const out = join(FIXTURES, "oracle-aux.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Ground truth for all 15 Nauvis tree species probability expressions, plus the
 * two shared fields they build on. Sampled at defaults (control:trees 1/1), so
 * this pins the catalog rows, the crc32 string-seed1 assumption, and the
 * asymmetric_ramps port in one shot.
 *
 * 17 expressions x ~1.7 s per run - this capture is the slow one (~30 s).
 */
async function captureTrees(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  // Near-spawn grid (where the distance term is live) ...
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 17 - 17 + 0.5, y: gy * 19 - 19 + 0.25 });
    }
  }
  // ... plus two far rings, to span several climate biomes.
  for (const r of [800, 2400]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const values: Record<string, number[]> = {};
    for (const name of [
      "tree_small_noise",
      "trees_forest_path_cutout_faded",
      ...TREE_SPECIES.map((s) => s.name),
    ]) {
      values[name] = await sampleExpression(name, positions, { workDir, seed });
      console.log(`  captured ${name}`);
    }
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. The 15 tree species probability expressions plus tree_small_noise and trees_forest_path_cutout_faded, each routed onto elevation, at default control:trees. Regenerate: node --experimental-strip-types test/oracle/capture.ts trees",
      seed0: seed,
      positions,
      values,
    };
    const out = join(FIXTURES, "oracle-trees.seed123456.json");
    await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${out}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The same species at NON-default control:trees levers, so the frequency ->
 * input_scale and size -> `0.2 * control:trees:size` wiring is pinned rather than
 * assumed. Three representative species (one per cap tier) keep this capture short.
 */
async function captureTreesControls(): Promise<void> {
  const seed = 123456;
  const treesFrequency = 3;
  const treesSize = 2;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 23 - 23 + 0.5, y: gy * 29 - 29 + 0.25 });
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    positions.push({
      x: snapToMapPosition(1200 * Math.cos(a) + 0.5),
      y: snapToMapPosition(1200 * Math.sin(a) + 0.25),
    });
  }

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const values: Record<string, number[]> = {};
    for (const name of ["tree_01", "tree_08", "tree_09_red"]) {
      values[name] = await sampleExpression(name, positions, {
        workDir,
        seed,
        mapGenOverrides: {
          autoplace_controls: { trees: { frequency: treesFrequency, size: treesSize } },
        },
      });
    }
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. Three tree species at control:trees frequency=3 size=2. Regenerate: node --experimental-strip-types test/oracle/capture.ts trees-controls",
      seed0: seed,
      treesFrequency,
      treesSize,
      positions,
      values,
    };
    const out = join(FIXTURES, "oracle-trees-controls.seed123456.json");
    await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${out}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The `moisture` (= `moisture_nauvis`) climate expression - the most complex
 * climate tree (a base quick_multioctave_noise term, a starting-area bias
 * blend keyed on `distance_from_nearest_point{points = starting_positions}`,
 * and a forest-path/hills/bridge-billows cutout, all from the shared Nauvis
 * sub-tree). Routed onto elevation, same standard grid as `captureAux`
 * (near-origin band, far rings at r=2200/3300, one deep-field point) for
 * comparability across captures. At the default preset every starting-area
 * lever is at its degenerate value (`slider_to_linear(1, ...) = 0`), so this
 * captures the whole closure at defaults - the starting-area levers
 * themselves are not exercised by this fixture (no UI surfaces them yet).
 */
async function captureMoisture(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const moisture = await sampleExpression("moisture", positions, { workDir, seed });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. moisture (= moisture_nauvis) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts moisture",
      seed0: seed,
      positions,
      moisture,
    };
    const out = join(FIXTURES, "oracle-moisture.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The native `expression_in_range(peak_multiplier, peak_maximum, expr_1..N,
 * from_1..N, to_1..N)` builtin - the one genuine unknown of Milestone 2. Sample
 * three sweeps that recover the 1-D peak/falloff shape (both the bounded (20,1)
 * and the unbounded (5,inf) parametrizations) and the N-D combination rule.
 *
 * Arg order per the game docs: peak_multiplier, peak_maximum, ALL exprs, then ALL
 * range_froms, then ALL range_tos. So 2-D is
 * expression_in_range(pm, pmax, expr1, expr2, from1, from2, to1, to2).
 */
async function captureExpressionInRange(): Promise<void> {
  const seed = 123456;

  const sample = async (expression: string, positions: Position[]): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, { workDir, seed });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  // 1-D sweep: x from -1500..1500 step 25 (y fixed), expr = x/1000 in [-0.5, 0.5].
  // Well inside, exactly on, and well beyond both edges of the range.
  const oneDPositions: Position[] = [];
  for (let x = -1500; x <= 1500; x += 25) oneDPositions.push({ x, y: 0.25 });

  const oneD_20_1_expr = "expression_in_range(20, 1, (x/1000), -0.5, 0.5)";
  const oneD_20_1_values = await sample(oneD_20_1_expr, oneDPositions);
  console.log("  captured oneD_20_1");

  const oneD_5_inf_expr = "expression_in_range(5, inf, (x/1000), -0.5, 0.5)";
  const oneD_5_inf_values = await sample(oneD_5_inf_expr, oneDPositions);
  console.log("  captured oneD_5_inf");

  // 2-D sweep, (20, 1), both dims range [-0.5, 0.5]:
  //   expression_in_range(20, 1, x/1000, y/1000, -0.5, -0.5, 0.5, 0.5)
  // Two families that distinguish min vs product vs sum:
  //  (a) hold x/1000 = 0.2 (intermediate, in range) and sweep y across and beyond
  //      the range. At an in-range intermediate x, min(a,b), a*b and a+b all
  //      predict different curves as b leaves [1-partial..1].
  //  (b) a diagonal x=y sweep (both leave the range together).
  const twoD_expr = "expression_in_range(20, 1, (x/1000), (y/1000), -0.5, -0.5, 0.5, 0.5)";
  const twoDPositions: Position[] = [];
  for (let y = -1000; y <= 1000; y += 25) twoDPositions.push({ x: 200, y }); // (a) hold x=0.2
  for (let d = -1000; d <= 1000; d += 25) twoDPositions.push({ x: d, y: d }); // (b) diagonal
  const twoD_values = await sample(twoD_expr, twoDPositions);
  console.log("  captured twoD");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. Native expression_in_range routed onto elevation. Arg order: peak_multiplier, peak_maximum, all exprs, all froms, all tos. Regenerate: node --experimental-strip-types test/oracle/capture.ts expression-in-range",
    seed0: seed,
    sweeps: {
      oneD_20_1: {
        expression: oneD_20_1_expr,
        peakMultiplier: 20,
        peakMaximum: 1,
        from: -0.5,
        to: 0.5,
        positions: oneDPositions,
        values: oneD_20_1_values,
      },
      oneD_5_inf: {
        expression: oneD_5_inf_expr,
        peakMultiplier: 5,
        peakMaximum: "inf",
        from: -0.5,
        to: 0.5,
        positions: oneDPositions,
        values: oneD_5_inf_values,
      },
      twoD: {
        expression: twoD_expr,
        peakMultiplier: 20,
        peakMaximum: 1,
        froms: [-0.5, -0.5],
        tos: [0.5, 0.5],
        positions: twoDPositions,
        values: twoD_values,
      },
    },
  };
  const out = join(FIXTURES, "oracle-expression-in-range.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

/**
 * Scattered points spread over a WIDE spatial extent, meant to cross many
 * biomes. Tile selection is driven by `aux` and `moisture`, whose
 * `input_scale` (`control:aux:frequency/2048`, `control:moisture:frequency/256`)
 * makes both vary very slowly over space - near the origin the whole area is
 * one or two biomes, so reaching sand (high aux) / red-desert / the fuller
 * dirt range needs points spread over THOUSANDS of tiles.
 *
 * Uses a golden-angle spiral (radius growing linearly from `minR` to `maxR`,
 * angle advancing by the golden angle each step) so `count` points cover both
 * many radii and many directions with no clustering, rather than a grid that
 * would repeat the same few directions. `angleOffset` decorrelates the spiral
 * between seeds so the same relative sample layout doesn't line up with the
 * same terrain features seed to seed.
 */
function scatterPositions(
  count: number,
  minR: number,
  maxR: number,
  angleOffset: number,
): Position[] {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees
  const out: Position[] = [{ x: 0.5, y: 0.25 }]; // one near-origin anchor point
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const r = minR + t * (maxR - minR);
    const angle = angleOffset + i * GOLDEN_ANGLE;
    out.push({ x: r * Math.cos(angle) + 0.5, y: r * Math.sin(angle) + 0.25 });
  }
  return out;
}

/**
 * The `get_tile` tile-name oracle: generates real chunks (a small per-point
 * radius, NOT one giant origin-centered disc - see `buildTileControlLua`) for
 * the DEFAULT preset (no property routing) and dumps
 * `surface.get_tile(x, y).name` at each scattered position, so a later task
 * can check tile-selection argmax exactly (rather than just the noise values
 * `calculate_tile_properties` reports). Widened per the Task 2 review finding:
 * the original 220-tile-radius grid was 86% grass-2/red-desert-0 with zero
 * sand/deepwater - not a meaningful ground truth for resolver validation.
 * Captures three seeds (a single seed's local terrain is biome-poor by luck)
 * spread out to ~4000 tiles, each written to its own fixture file.
 */
async function captureTileNamesForSeed(seed: number, angleOffset: number): Promise<void> {
  const positions = scatterPositions(50, 100, 4000, angleOffset);

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const samples: TileSample[] = await sampleTileNames(positions, { workDir, seed, radius: 1 });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. DEFAULT preset (no property_expression_names routing) - surface.get_tile(x, y).name at each position after real chunk generation. positions are the mod's ECHOED floored get_tile input (not the pre-floor request), so a fractional capture can't silently mismatch. Regenerate: node --experimental-strip-types test/oracle/capture.ts tile-names",
      seed0: seed,
      positions: samples.map((s) => ({ x: s.x, y: s.y })),
      tileNames: samples.map((s) => s.name),
    };
    const out = join(FIXTURES, `oracle-tile-names.seed${seed}.json`);
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    const distinct = new Set(fixture.tileNames).size;
    console.log(
      `wrote ${out} (${positions.length} points, ${distinct} distinct tiles: ${[...new Set(fixture.tileNames)].sort().join(", ")})`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function captureTileNames(): Promise<void> {
  await captureTileNamesForSeed(123456, 0);
  await captureTileNamesForSeed(654321, 1.3);
  await captureTileNamesForSeed(424242, 2.6);
}

/**
 * random_penalty ground truth. It is a BATCH op (seeded from the first position,
 * streamed last->first, source<=0 skips a draw), so each config is ONE batch and
 * the fixture stores the exact ordered position list + the game's output. Sources
 * are simple functions of (x,y) so the spec can recompute source[i] and validate
 * randomPenaltyBatch. Includes odd seeds (even-only masked the quickMultioctave
 * bug last session) and a source=x config to exercise the source<=0 guard.
 */
async function captureRandomPenalty(): Promise<void> {
  const seed = 123456; // map_seed; random_penalty is map_seed-independent, but pin it.
  // A scattered ordered batch: fractional, negatives (x<=0 for the guard), far points.
  const positions: Position[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -3, y: 2 },
    { x: 5.5, y: 7.25 },
    { x: -10, y: -10 },
    { x: 40, y: 13 },
    { x: 0, y: -1 },
    { x: 1000, y: -2000 },
  ];
  // sourceKind: how the spec reconstructs source[i] from the position.
  const configs = [
    { rpSeed: 1, amplitude: 1, sourceExpr: "1", sourceKind: "const1" },
    { rpSeed: 1, amplitude: 2, sourceExpr: "1", sourceKind: "const1" },
    { rpSeed: 7, amplitude: 1, sourceExpr: "1", sourceKind: "const1" }, // odd seed
    { rpSeed: 13, amplitude: 0.5, sourceExpr: "1", sourceKind: "const1" }, // odd seed
    { rpSeed: 1, amplitude: 1, sourceExpr: "x", sourceKind: "x" }, // source<=0 guard
  ];
  const cases = [];
  for (const c of configs) {
    const expression = `random_penalty{x = x, y = y, seed = ${c.rpSeed}, source = ${c.sourceExpr}, amplitude = ${c.amplitude}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, positions, { workDir, seed });
      cases.push({ ...c, values });
      console.log(`  captured rpSeed=${c.rpSeed} amp=${c.amplitude} source=${c.sourceExpr}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via the test/oracle harness. random_penalty routed onto elevation. BATCH op: seeded from positions[0], streamed last->first, source<=0 passes through with no draw. Regenerate: node --experimental-strip-types test/oracle/capture.ts random-penalty",
    seed0: seed,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-random-penalty.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${configs.length} configs x ${positions.length} points)`);
}

/**
 * Pure-regular resource field ground truth. Probes `resource_autoplace_all_patches`
 * with `has_starting_area_placement = 0` (so all_patches = regular_patches) and
 * `regular_patch_set_count = 1` / `index = 0` (skip_span 1: this resource takes every
 * accepted spot, unpartitioned) - the cleanest ground truth for the regular field.
 * frequency_multiplier / size_multiplier inlined as 1 to drop the control-var
 * dependency. Params inlined (capture.ts can't import extensionless src/). Grid: a
 * near-spawn cluster + a far ring, so the distance fade-in and double-density ramp
 * are both exercised. Seeds: 123456 and an odd one.
 */
async function captureResourceRegular(): Promise<void> {
  interface Probe {
    name: string;
    base_density: number;
    base_spots_per_km2: number;
    candidate_spot_count: number;
    random_spot_size_minimum: number;
    random_spot_size_maximum: number;
    regular_rq_factor: number;
    starting_rq_factor: number;
  }
  // iron (has_starting true in-game) and uranium (false) - a spread of density/rq.
  // has_starting is forced to 0 in the probe for all. Only iron takes both seeds
  // (odd + even) to keep the fixture small; the field code path is identical.
  const probes: Probe[] = [
    {
      name: "iron-ore",
      base_density: 10,
      base_spots_per_km2: 2.5,
      candidate_spot_count: 22,
      random_spot_size_minimum: 0.25,
      random_spot_size_maximum: 2,
      regular_rq_factor: 1.1 / 10,
      starting_rq_factor: 1.5 / 7,
    },
    {
      name: "uranium-ore",
      base_density: 0.9,
      base_spots_per_km2: 1.25,
      candidate_spot_count: 21,
      random_spot_size_minimum: 2,
      random_spot_size_maximum: 4,
      regular_rq_factor: 1.0 / 10,
      starting_rq_factor: 1.0 / 7,
    },
  ];
  const buildExpr = (p: Probe): string =>
    "resource_autoplace_all_patches{" +
    [
      `base_density = ${p.base_density}`,
      `base_spots_per_km2 = ${p.base_spots_per_km2}`,
      `candidate_spot_count = ${p.candidate_spot_count}`,
      `frequency_multiplier = 1`,
      `has_starting_area_placement = 0`,
      `random_spot_size_minimum = ${p.random_spot_size_minimum}`,
      `random_spot_size_maximum = ${p.random_spot_size_maximum}`,
      `regular_blob_amplitude_multiplier = ${1 / 8}`,
      `regular_patch_set_count = 1`,
      `regular_patch_set_index = 0`,
      `regular_rq_factor = ${p.regular_rq_factor}`,
      `seed1 = 100`,
      `size_multiplier = 1`,
      `starting_blob_amplitude_multiplier = ${1 / 8}`,
      `starting_patch_set_count = 1`,
      `starting_patch_set_index = 0`,
      `starting_rq_factor = ${p.starting_rq_factor}`,
    ].join(", ") +
    "}";

  // Cover the WHOLE of region (1,1) - centered on (1024,1024), spanning [512,1536]
  // - at stride 16, so every ~30-tile-radius patch is caught by several points
  // (patches are sparse: only a handful survive the trim per 1024^2 region, so a
  // local window misses them all). This is a high-density, off-spawn region (the
  // distance fade-in is fully ramped), which maximizes patch count. Plus a few
  // near-spawn points to confirm the fade-in floor (basement there).
  const positions: Position[] = [];
  const N = 64;
  const stride = 16;
  const x0 = 512;
  for (let iy = 0; iy < N; iy++)
    for (let ix = 0; ix < N; ix++) positions.push({ x: x0 + ix * stride, y: x0 + iy * stride });
  for (let gy = 0; gy < 3; gy++)
    for (let gx = 0; gx < 3; gx++) positions.push({ x: gx * 60 - 60, y: gy * 60 - 60 });

  const seeds = [123456, 777771];
  const cases = [];
  for (const seed of seeds) {
    for (const p of probes) {
      const expression = buildExpr(p);
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const values = await sampleExpression(expression, positions, { workDir, seed });
        cases.push({ resource: p.name, seed, values });
        console.log(`  captured ${p.name} seed=${seed}`);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11. resource_autoplace_all_patches (has_starting_area_placement=0, regular_patch_set_count=1) routed onto elevation = the pure regular_patches field. frequency/size multipliers = 1. Regenerate: node --experimental-strip-types test/oracle/capture.ts resource-regular",
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-resource-regular.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${cases.length} cases x ${positions.length} points)`);
}

/**
 * Combined starting+regular resource field ground truth. Probes
 * `resource_autoplace_all_patches` with `has_starting_area_placement = 1` (so
 * all_patches = max(starting_patches, regular_patches)) and both
 * `regular_patch_set_count = 1` / `starting_patch_set_count = 1` (index 0: this
 * resource takes every accepted spot in each set, unpartitioned) - the cleanest
 * ground truth for the combined field. frequency_multiplier / size_multiplier
 * inlined as 1 to drop the control-var dependency. Params inlined (capture.ts
 * can't import extensionless src/). Grid: a DENSE near-spawn block (catches the
 * ~20-tile starting patches AND the regular fade-in ring) plus a far ring
 * (regular-only region, keeps the regular branch covered). Seeds: 123456 and an
 * odd one.
 *
 * Routed onto `moisture`, NOT `elevation` (unlike every other capture in this
 * file). `has_starting_area_placement = 1` pulls in `elevation_lakes` (via
 * `startingFavorabilityBaseAt`'s `clamp((elevation_lakes - 1) / 10, ...)` term),
 * and `elevation_lakes` needs the engine's real spawn-lake resolution, which
 * itself runs through the `elevation` property during the very first chunk
 * generation. Overriding `elevation` with THIS expression makes that resolution
 * recurse into itself with no base case - confirmed via a throwaway repro: it
 * SIGSEGVs headless Factorio during "Creating new map", before our mod's
 * `on_init` ever runs (so no stderr, just a silent crash). Routing onto
 * `moisture` instead sidesteps the real elevation pipeline entirely and dumps
 * clean values - verified with a 3-point repro before this full capture.
 */
async function captureResourceStarting(): Promise<void> {
  interface Probe {
    name: string;
    base_density: number;
    base_spots_per_km2: number;
    candidate_spot_count: number;
    random_spot_size_minimum: number;
    random_spot_size_maximum: number;
    regular_rq_factor: number;
    starting_rq_factor: number;
  }
  // iron and copper (both has_starting true in-game; different starting_rq_factor).
  const probes: Probe[] = [
    {
      name: "iron-ore",
      base_density: 10,
      base_spots_per_km2: 2.5,
      candidate_spot_count: 22,
      random_spot_size_minimum: 0.25,
      random_spot_size_maximum: 2,
      regular_rq_factor: 1.1 / 10,
      starting_rq_factor: 1.5 / 7,
    },
    {
      name: "copper-ore",
      base_density: 8,
      base_spots_per_km2: 2.5,
      candidate_spot_count: 22,
      random_spot_size_minimum: 0.25,
      random_spot_size_maximum: 2,
      regular_rq_factor: 1.1 / 10,
      starting_rq_factor: 1.2 / 7,
    },
  ];
  const buildExpr = (p: Probe): string =>
    "resource_autoplace_all_patches{" +
    [
      `base_density = ${p.base_density}`,
      `base_spots_per_km2 = ${p.base_spots_per_km2}`,
      `candidate_spot_count = ${p.candidate_spot_count}`,
      `frequency_multiplier = 1`,
      `has_starting_area_placement = 1`,
      `random_spot_size_minimum = ${p.random_spot_size_minimum}`,
      `random_spot_size_maximum = ${p.random_spot_size_maximum}`,
      `regular_blob_amplitude_multiplier = ${1 / 8}`,
      `regular_patch_set_count = 1`,
      `regular_patch_set_index = 0`,
      `regular_rq_factor = ${p.regular_rq_factor}`,
      `seed1 = 100`,
      `size_multiplier = 1`,
      `starting_blob_amplitude_multiplier = ${1 / 8}`,
      `starting_patch_set_count = 1`,
      `starting_patch_set_index = 0`,
      `starting_rq_factor = ${p.starting_rq_factor}`,
    ].join(", ") +
    "}";

  // Dense near-spawn block: +/-240 at stride 8 catches the ~20-tile starting
  // patches AND the regular fade-in ring (120..420). Starting patches live
  // within ~120-240.
  const positions: Position[] = [];
  for (let y = -240; y <= 240; y += 8)
    for (let x = -240; x <= 240; x += 8) positions.push({ x: x + 0.5, y: y + 0.25 });
  // A far ring (regular-only region) so the regular branch stays covered.
  for (const r of [1500, 2500]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }

  const seeds = [123456, 777771];
  const cases = [];
  for (const seed of seeds) {
    for (const p of probes) {
      const expression = buildExpr(p);
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const values = await sampleExpression(expression, positions, {
          workDir,
          seed,
          property: "moisture",
        });
        cases.push({ resource: p.name, seed, values });
        console.log(`  captured ${p.name} seed=${seed}`);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11. resource_autoplace_all_patches (has_starting_area_placement=1, regular_patch_set_count=1, starting_patch_set_count=1) = max(starting_patches, regular_patches), both sets unpartitioned. frequency/size multipliers = 1. Routed onto MOISTURE, not elevation (unlike the other oracle-resource-*.json fixtures): has_starting_area_placement=1 pulls in elevation_lakes, which needs the engine's real spawn-lake resolution, which itself runs through the elevation property during the first chunk generation - overriding elevation with this expression makes that resolution recurse into itself and SIGSEGVs headless Factorio. Routing onto moisture sidesteps that; the values are the same resource_autoplace_all_patches output either way, only the carrier property differs. Regenerate: node --experimental-strip-types test/oracle/capture.ts resource-starting",
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-resource-starting.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${cases.length} cases x ${positions.length} points)`);
}

/**
 * enemy_base_probability ground truth. Dense grid over region (2,2) (centred on
 * (1024,1024), spanning [768,1280], stride 16) catches several spot cones - the
 * region is off-spawn/high-density so a few of the ~15-30 tile cones survive the
 * density trim - plus a near-spawn (+x) profile (basement + starting-area
 * clearing). Two seeds.
 */
async function captureEnemyBase(): Promise<void> {
  const positions: Position[] = [];
  // Dense grid over region (2,2): centred (1024,1024), [768,1280]; stride 16 catches
  // the ~15-30 tile enemy cones (a few survive the density trim per 512^2 region).
  for (let iy = 0; iy < 32; iy++)
    for (let ix = 0; ix < 32; ix++)
      positions.push({ x: 768 + ix * 16 + 0.5, y: 768 + iy * 16 + 0.25 });
  // Near-spawn (+x) profile: basement + starting-area clearing.
  for (const d of [0, 40, 60, 80, 100, 150, 200, 300]) positions.push({ x: d + 0.5, y: 0.25 });
  const seeds = [123456, 777771];
  const cases: { seed: number; values: number[] }[] = [];
  for (const seed of seeds) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression("enemy_base_probability", positions, { workDir, seed });
      cases.push({ seed, values });
      console.log(`  captured enemy-base seed=${seed}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via test/oracle. enemy_base_probability routed onto elevation, default controls (enemy-base freq/size = 1). Regenerate: node --experimental-strip-types test/oracle/capture.ts enemy-base",
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-enemy-base.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} seeds)`);
}

/**
 * cliff_elevation_nauvis ground truth. Grid over [0,512) at stride 16, at the
 * cliff CORNER lattice offset (x on 4s, y on 4s+0.5) so the same fixture doubles
 * as corner-value ground truth for placement (Task 6). Two seeds.
 */
async function captureCliffElevation(): Promise<void> {
  const positions: Position[] = [];
  // Grid over [0,512) stride 16, at the cliff CORNER lattice offset (x on 4s, y on 4s+0.5)
  // so the same fixture doubles as corner-value ground truth for placement.
  for (let iy = 0; iy < 32; iy++)
    for (let ix = 0; ix < 32; ix++) positions.push({ x: ix * 16, y: iy * 16 + 0.5 });
  const seeds = [123456, 777771];
  const cases: { seed: number; values: number[] }[] = [];
  for (const seed of seeds) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression("cliff_elevation_nauvis", positions, { workDir, seed });
      cases.push({ seed, values });
      console.log(`  captured cliff-elevation seed=${seed}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const out = join(FIXTURES, "oracle-cliff-elevation.seed123456.json");
  await writeFile(
    out,
    JSON.stringify(
      {
        _comment:
          "Ground truth from Factorio 2.1.11 via test/oracle. cliff_elevation_nauvis routed onto elevation, default settings. Regenerate: node --experimental-strip-types test/oracle/capture.ts cliff-elevation",
        positions,
        cases,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} seeds)`);
}

/**
 * cliffiness_nauvis ground truth. The core cliff GATE field: `(main_cliffiness >=
 * cliff_cutoff) * 10`, so every value is exactly 0 or 10. Same corner-lattice grid
 * as captureCliffElevation ([0,512) stride 16, x on 4s, y on 4s+0.5) so the two
 * fixtures pair up for placement. Two seeds.
 */
async function captureCliffiness(): Promise<void> {
  const positions: Position[] = [];
  for (let iy = 0; iy < 32; iy++)
    for (let ix = 0; ix < 32; ix++) positions.push({ x: ix * 16, y: iy * 16 + 0.5 });
  const seeds = [123456, 777771];
  const cases: { seed: number; values: number[] }[] = [];
  for (const seed of seeds) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression("cliffiness_nauvis", positions, { workDir, seed });
      cases.push({ seed, values });
      console.log(`  captured cliffiness seed=${seed}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const out = join(FIXTURES, "oracle-cliffiness.seed123456.json");
  await writeFile(
    out,
    JSON.stringify(
      {
        _comment:
          "Ground truth from Factorio 2.1.11 via test/oracle. cliffiness_nauvis routed onto elevation, default settings. This is the exact 0/10 GATE (main_cliffiness >= cliff_cutoff) * 10. Regenerate: node --experimental-strip-types test/oracle/capture.ts cliffiness",
        positions,
        cases,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} seeds)`);
}

/**
 * The Nauvis cliff-ringbreak offset chain. Samples the four named expressions of
 * the domain-warped offset field at a shared grid, at two seeds:
 *   - `nauvis_hills_offset_raw_x` / `nauvis_hills_offset_raw_y`: the two
 *     `basis_noise{seed1 = 'nauvis_offset_x'/'nauvis_offset_y', input_scale =
 *     nauvis_segmentation_multiplier / 500}` warp fields (string basis-noise
 *     seeds, resolved to crc32(name) = 593691028 / 1415852290). Capturing them
 *     directly lets the CI spec re-confirm those seed1 constants.
 *   - `nauvis_hills_offset`: abs of the seed1=900 multioctave field re-evaluated
 *     at the warped coordinate (x + 12*normalize(rawX,rawY), y + 12*normalize(rawY,rawX)).
 *   - `nauvis_cliff_ringbreak`: abs(nauvis_hills - nauvis_hills_offset), the
 *     base_cliffiness input for Task 6.
 * Routed onto elevation, default settings. Grid is the standard scattered grid.
 */
async function captureCliffOffsetRaw(): Promise<void> {
  const positions = gridPositions();
  const seeds = [123456, 777771];
  const cases: {
    seed: number;
    rawX: number[];
    rawY: number[];
    hillsOffset: number[];
    ringbreak: number[];
  }[] = [];
  for (const seed of seeds) {
    const sample = async (expression: string): Promise<number[]> => {
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        return await sampleExpression(expression, positions, { workDir, seed });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    };
    const rawX = await sample("nauvis_hills_offset_raw_x");
    const rawY = await sample("nauvis_hills_offset_raw_y");
    const hillsOffset = await sample("nauvis_hills_offset");
    const ringbreak = await sample("nauvis_cliff_ringbreak");
    cases.push({ seed, rawX, rawY, hillsOffset, ringbreak });
    console.log(`  captured cliff-offset-raw seed=${seed}`);
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 via test/oracle. The Nauvis cliff-ringbreak offset chain (nauvis_hills_offset_raw_x/raw_y, nauvis_hills_offset, nauvis_cliff_ringbreak) routed onto elevation, default settings. raw_x/raw_y are basis_noise with string seed1 'nauvis_offset_x'/'nauvis_offset_y' (= crc32(name) = 593691028 / 1415852290). Regenerate: node --experimental-strip-types test/oracle/capture.ts cliff-offset-raw",
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-cliff-offset-raw.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} seeds)`);
}

/**
 * The end-to-end cliff PLACEMENT ground truth: every real cliff entity the game
 * placed in a region, at the DEFAULT preset, via a chunk-forced
 * `find_entities_filtered{type="cliff"}` dump (see `sampleCliffEntities`). The
 * CI-safe spec runs `makeCliffPlacement(...).placedCells` over the same region
 * and asserts the placed set reproduces >= 85% of these real cliffs (the ~90%
 * from the spike; the residual is the DEFERRED `fixImpossibleCells` + water
 * rejection - see docs/noise/cliffs-NOTES.md). Region `[512,1024)^2` = 16x16
 * chunks: enough cliffs (tens to low hundreds) with bounded generation time. Two
 * seeds. Every dumped position must land on the cliff lattice (x≡2, y≡2.5 mod 4).
 */
async function captureCliffEntities(): Promise<void> {
  const region: Region = { x0: 512, y0: 512, x1: 1024, y1: 1024 };
  const seeds = [123456, 777771];
  const cases: { seed: number; cliffs: Position[] }[] = [];
  for (const seed of seeds) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const cliffs = await sampleCliffEntities(region, { workDir, seed });
      cases.push({ seed, cliffs });
      console.log(`  captured cliff-entities seed=${seed} (${cliffs.length} cliffs)`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Every cliff entity (find_entities_filtered{type='cliff'}) the game placed in the region at the DEFAULT preset, after chunk-forced generation. Positions are cliff cell centers (x mod 4 == 2, y mod 4 == 2.5). Each entry also carries the entity's `orientation` (LuaEntity.cliff_orientation), which makes this a direct end-to-end oracle for CLIFF_CODE_TO_ORIENTATION - see test/cliffOrientationOracle.spec.ts. Re-captured 2026-07-30 at 2.1.12 to add that field; it reproduced the 2.1.11 capture's 282 and 52 positions exactly, in the same order, so Nauvis cliff placement did not move between those versions. The CI spec runs makeCliffPlacement().placedCells over region; it now matches 1.0000 in both directions, not the >= 85% this line used to describe. Regenerate: node --experimental-strip-types test/oracle/capture.ts cliff-entities",
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-cliff-entities.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${cases.length} seeds)`);
}

/**
 * Ground truth for `rock_density` (= `rock_noise - max(0, 1.1 - distance/32)`, a
 * base-game named noise expression). Validating it point-by-point pins the rocks-
 * specific noise (`multioctave_noise{seed1=137, octaves=4, persistence=0.9,
 * input_scale=0.15*control:rocks:frequency}` plus the size/distance terms); the
 * `range_select_base` bands and the multiplier/penalty composition are unit-tested
 * in test/rockField.spec.ts, and moisture/aux are already oracle-validated. Same
 * standard grid as captureAux/captureTemperature (near-spawn band exercises the
 * distance term, far rings span the noise) for comparability.
 */
async function captureRocks(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      positions.push({ x: gx * 11 - 11 + 0.5, y: gy * 13 - 13 + 0.25 });
    }
  }
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const values = await sampleExpression("rock_density", positions, { workDir, seed });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.11 via the test/oracle harness. rock_density (= rock_noise - max(0, 1.1 - distance/32)) routed onto elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts rocks",
      seed0: seed,
      positions,
      values,
    };
    const out = join(FIXTURES, "oracle-rock-density.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The native `multisample(expression, offset_x, offset_y)` builtin - the one
 * genuine unknown feeding Vulcanus's `vulcanus_basalt_lakes_multisample` (Task 9's
 * `vulcanus_elev`). Per the game's own auxiliary docs ("Evaluates the expression
 * in a separate noise program with a larger grid. Sub-grids are copied to the
 * main program.") this is a supersampling primitive; `offset_x`/`offset_y` are
 * documented as "constant 8-bit signed integer" but the real usage only ever
 * passes 0 or 1 (a 2x2 supersample). The inner-expression trick: route the bare
 * `x` and `y` variables (not some derived expression) as the multisample
 * argument, so the returned number IS the exact sampled coordinate - no
 * inversion needed. Sampled independently for x and y, at several base points
 * (fractional, negative, far-from-origin) crossed with a WIDE offset sweep
 * (-2..3, beyond the {0,1} the game actually uses) so a linear offset-per-unit
 * rule is over-determined rather than merely fit to two points, plus a few
 * non-axis-aligned (dx,dy) combos to rule out any cross term between the two
 * axes. `calculate_tile_properties` needs the multisample fix landed in
 * 2.0.67 ("Fixed multisample noise operation not working properly for
 * LuaSurface.calculate_tile_properties()") - confirmed present (game reports
 * 2.1.12, changelog fix is 2.0.67).
 */
async function captureMultisample(): Promise<void> {
  const seed = 123456;
  const positions: Position[] = [
    { x: 0.5, y: 0.25 },
    { x: 10.5, y: -20.25 },
    { x: -5.25, y: 7.75 },
    { x: 100.125, y: -300.875 },
    { x: 1234.5, y: -4321.5 },
  ];
  // (dx, dy) pairs: the real {0,1}x{0,1} usage, an extended axis-aligned sweep
  // (negative + beyond 1, both axes independently) to pin the linear rule, and a
  // few off-axis combos to check for cross terms.
  const offsets: { dx: number; dy: number }[] = [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: 3, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: -2 },
    { dx: 0, dy: 2 },
    { dx: 0, dy: 3 },
    { dx: 2, dy: 3 },
    { dx: -1, dy: 2 },
    { dx: 3, dy: -2 },
  ];

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, { workDir, seed });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const cases: { dx: number; dy: number; sampledX: number[]; sampledY: number[] }[] = [];
  for (const { dx, dy } of offsets) {
    const sampledX = await sample(`multisample(x, ${dx}, ${dy})`);
    const sampledY = await sample(`multisample(y, ${dx}, ${dy})`);
    cases.push({ dx, dy, sampledX, sampledY });
    console.log(`  captured multisample dx=${dx} dy=${dy}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via the test/oracle harness. Native multisample(expression, offset_x, offset_y) routed onto elevation, with the inner expression being the bare x (sampledX) or bare y (sampledY) variable, so the returned number IS the exact world coordinate multisample sampled - no inversion needed. Regenerate: node --experimental-strip-types test/oracle/capture.ts multisample",
    seed0: seed,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-multisample.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${offsets.length} offsets x ${positions.length} points)`);
}

/**
 * Space-Age (Vulcanus) smoke fixture: proves the Space-Age oracle path routes
 * correctly end to end. Samples two exact constants -
 * `vulcanus_starting_area_radius` (`0.7 * 0.75` = 0.525) and `vulcanus_ore_spacing`
 * (128) - plus `vulcanus_temperature` at 4 scattered points, all against a real
 * Vulcanus surface (`game.planets["vulcanus"].create_surface()`, via
 * `{ spaceAge: true, planet: "vulcanus" }`). Needs `space-age` +
 * `elevated-rails` + `quality` alongside `base` in the generated mod-list.
 */
async function captureVulcanusSmoke(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [
    { x: 0.5, y: 0.25 },
    { x: 100.5, y: -50.25 },
    { x: -300.5, y: 200.25 },
    { x: 1000.5, y: 1000.25 },
  ];

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const startingAreaRadius = await sample("vulcanus_starting_area_radius");
  console.log("  captured vulcanus_starting_area_radius");
  const oreSpacing = await sample("vulcanus_ore_spacing");
  console.log("  captured vulcanus_ore_spacing");
  const temperature = await sample("vulcanus_temperature");
  console.log("  captured vulcanus_temperature");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. vulcanus_starting_area_radius (constant 0.7 * 0.75 = 0.525) and vulcanus_ore_spacing (constant 128), plus vulcanus_temperature at 4 points, all sampled against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Proves the Space-Age oracle routing (spaceAge/planet options) end to end. Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-smoke",
    seed0: seed,
    planet,
    positions,
    startingAreaRadius,
    oreSpacing,
    temperature,
  };
  const out = join(FIXTURES, "oracle-vulcanus-smoke.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

/**
 * The four engine-builtin "seed vars" that drive Vulcanus's biome rotation:
 * `map_seed_normalized`, `map_seed_small` (both pure functions of `seed0`, the
 * `--map-gen-seed`/`mgs.seed` value - documented in the game's own
 * noise-expressions reference as "0-1 normalized value of map_seed" and "16
 * least significant bits from map_seed" respectively, but sampled here across
 * seeds anyway so the exact formula is confirmed against real output, not just
 * taken on faith), and `x_from_start`/`y_from_start` (per-point, `=
 * distance_from_nearest_point_x/_y(x, y, starting_positions)` per
 * `core/prototypes/noise-programs.lua` - a native primitive with no further
 * Lua source, unlike the other two which merely lack a *documented* formula).
 * All four are sampled at ONE fixed point per seed (map_seed_normalized/small
 * do not depend on x/y at all; x_from_start/y_from_start do, but a single
 * point is enough to confirm the `== x, y` finding or its offset), through the
 * Space-Age Vulcanus surface (`{ spaceAge: true, planet: "vulcanus" }`) so the
 * per-call `seed` option drives `mgs.seed` on that freshly-created surface -
 * see {@link buildSpaceAgeControlLua}. 12 seeds, including the brief's
 * required 123456/0/1/2/0xFFFFFFFF, spread across the full 32-bit range so the
 * derived formula is over-determined.
 */
async function captureSeedVars(): Promise<void> {
  const planet = "vulcanus";
  const point: Position = { x: 300.5, y: -700.25 };
  const seeds = [
    123456, 0, 1, 2, 0xffffffff, 42, 654321, 424242, 100000, 0x7fffffff, 3000000000, 999999999,
  ];

  const sampleOne = async (seed: number, expression: string): Promise<number> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, [point], {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
      return values[0];
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const results: {
    seed0: number;
    mapSeedNormalized: number;
    mapSeedSmall: number;
    xFromStart: number;
    yFromStart: number;
  }[] = [];
  for (const seed of seeds) {
    const mapSeedNormalized = await sampleOne(seed, "map_seed_normalized");
    const mapSeedSmall = await sampleOne(seed, "map_seed_small");
    const xFromStart = await sampleOne(seed, "x_from_start");
    const yFromStart = await sampleOne(seed, "y_from_start");
    results.push({ seed0: seed, mapSeedNormalized, mapSeedSmall, xFromStart, yFromStart });
    console.log(
      `  captured seed=${seed}: normalized=${mapSeedNormalized} small=${mapSeedSmall} xFromStart=${xFromStart} yFromStart=${yFromStart}`,
    );
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. map_seed_normalized, map_seed_small, x_from_start, y_from_start, each routed onto elevation on a real Vulcanus surface (game.planets['vulcanus'].create_surface()), sampled at ONE fixed point per seed across 12 seeds spanning the 32-bit range. Regenerate: node --experimental-strip-types test/oracle/capture.ts seed-vars",
    planet,
    point,
    seeds: results,
  };
  const out = join(FIXTURES, "oracle-seed-vars.multi.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${seeds.length} seeds)`);
}

/**
 * `starting_spot_at_angle` ground truth: the radial-placement backbone Vulcanus
 * leans on (Task 3). Samples 4 configs spanning distinct angles (0/45/90/180 -
 * exercising exact and irrational sin/cos), distances, radii, and non-zero
 * x/y distortion, each over the standard scattered grid, against a real
 * Vulcanus surface ({ spaceAge: true, planet: "vulcanus" }) so
 * `x_from_start`/`y_from_start` resolve per Task 2's `== x, y` finding.
 */
/**
 * The noise machine's `^` operator, sampled f32-EXACT - the ground truth for
 * `src/noise/fastApprox.ts`, which had none.
 *
 * **Why this exists (issues #161, #162, #163).** `fastApprox` is consumed by the
 * resource `spot_height` / `blob_amplitude` chain and by the multioctave RMS
 * normalisation, and every fixture over those compares with a TOLERANCE wide
 * enough to hide a 1e-5 shift. That is how a double-accumulation bug survived a
 * year, and it is why neither of the two open questions about the file could be
 * answered from the suite. This probe removes the chain entirely and samples the
 * operator on its own, where an exact comparison is possible.
 *
 * **What `^` compiles to, read from the 2.1.12 binary.** A non-integral exponent
 * becomes `NoiseOperations::BinaryOperation<22, &NoiseOperations::Functions::pow>`,
 * and `Functions::pow` (`0x10176d234`) is a single instruction - an unconditional
 * `b` to `Math::powSafe(float, float)` (`0x102955a88`), which inlines fastapprox
 * `log2` and multiplies by the exponent at single precision (`fmul s0, s0, s1`).
 * An INTEGRAL exponent takes a different path entirely: `powSafe` round-trips it
 * through `fcvtzs`/`scvtf` and, when it survives, uses exponentiation by squaring
 * and never touches fastapprox. Hence the `2` series below - it pins a path our
 * port must NOT route through `fastPow`.
 *
 * **The positions are chosen adversarially, which is the whole point.** A plain
 * grid does not discriminate: 12 evenly spaced points scored 12/12 for both
 * candidate exponents, and only `Math.cbrt` (0/12) failed. Two hand-picked sets
 * are therefore included, each listing positions where two rival implementations
 * are known to differ, so a wrong one cannot score full marks:
 *
 * - `CBRT_EXPONENT_SPLIT` - where `fastPow(x, 1/3)` with a DOUBLE `1/3` differs
 *   from `f32(1/3)`. Measured verdict: the double scores **0/24**, `f32(1/3)`
 *   scores **24/24**. That settled #163 against the game rather than against the
 *   disassembly alone.
 * - `ROUNDING_SPLIT` - where the pre-`9b49ebb` single-rounding `fastApprox`
 *   differs from the per-operation rounding that replaced it. The two disagree on
 *   ~30% of inputs, so these are easy to find and brutal to fail.
 *
 * The arithmetic spread is kept as well, so the fixture is not composed purely of
 * pathological points.
 */
async function captureFastPow(): Promise<void> {
  const seed = 123456;

  /**
   * Positions where a double `1/3` and `f32(1/3)` give different f32 results.
   * Found by sweeping `x = 1.5, 2.5, ...` and keeping the first 24 disagreements;
   * ~3.0% of that range disagrees, so a plain grid usually misses them all.
   */
  const CBRT_EXPONENT_SPLIT = [
    23.5, 47.5, 73.5, 85.5, 114.5, 210.5, 395.5, 573.5, 591.5, 672.5, 674.5, 677.5, 696.5, 752.5,
    879.5, 883.5, 983.5, 1008.5, 1080.5, 1083.5, 1159.5, 1199.5, 1219.5, 1249.5,
  ];

  /** Positions where single-rounding and per-operation-rounding fastapprox differ. */
  const ROUNDING_SPLIT = [
    3.5, 5.5, 6.5, 7.5, 15.5, 20.5, 21.5, 22.5, 25.5, 26.5, 32.5, 38.5, 39.5, 43.5, 45.5, 1.5, 2.5,
    10.5, 12.5, 19.5, 27.5, 28.5, 30.5, 36.5, 37.5, 41.5, 4.5, 8.5, 9.5, 11.5, 13.5, 16.5, 17.5,
    18.5,
  ];

  /** A plain spread across four decades, so the set is not all pathological. */
  const spread: number[] = [];
  for (let k = 0; k < 40; k++) spread.push(1.5 + k * 37);
  for (const m of [211, 1553, 9377]) for (let k = 0; k < 10; k++) spread.push(1.5 + k * m);

  const xs = [...new Set([...CBRT_EXPONENT_SPLIT, ...ROUNDING_SPLIT, ...spread])].sort(
    (a, b) => a - b,
  );
  const positions: Position[] = xs.map((x) => ({ x, y: 0.5 }));

  const EXPONENTS = [
    { label: "1/3", expression: "(1/3)", note: "the shipping cube root - fastCbrt" },
    { label: "0.5", expression: "0.5", note: "non-integral < 1" },
    { label: "2.5", expression: "2.5", note: "non-integral > 1" },
    { label: "2", expression: "2", note: "INTEGRAL - powSafe uses exact squaring, not fastapprox" },
  ];

  const series: { exponent: string; note: string; expression: string; values: number[] }[] = [];
  for (const e of EXPONENTS) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const expression = `x ^ ${e.expression}`;
      const values = await sampleExpression(expression, positions, { workDir, seed });
      series.push({ exponent: e.label, note: e.note, expression, values });
      console.log(`  captured x ^ ${e.label} (${String(positions.length)} positions)`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (build 87038) via the test/oracle harness. The noise " +
      "machine's `^` operator sampled directly, as `x ^ <exponent>` routed onto elevation, so " +
      "fastApprox can be compared f32-EXACT instead of through a tolerance on a downstream " +
      "chain. Non-integral exponents reach Math::powSafe -> fastapprox log2/exp2; the `2` " +
      "series takes powSafe's integral fast path (exponentiation by squaring) and must NOT be " +
      "reproduced with fastPow. Positions are deliberately adversarial - they include points " +
      "where a double 1/3 differs from f32(1/3), and points where single-rounding fastapprox " +
      "differs from per-operation rounding. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts fastpow",
    seed0: seed,
    positions: positions.map((p) => ({ x: p.x, y: p.y })),
    series,
  };
  const out = join(FIXTURES, "oracle-fastpow.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(series.length)} series x ${String(positions.length)})`);
}

async function captureStartingSpotAtAngle(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions = gridPositions();
  const configs = [
    { angle: 90, distance: 170, radius: 350, xDistortion: 0, yDistortion: 0 },
    { angle: 0, distance: 100, radius: 200, xDistortion: 0, yDistortion: 0 },
    { angle: 180, distance: 50, radius: 500, xDistortion: 20, yDistortion: -15 },
    { angle: 45, distance: 300, radius: 400, xDistortion: -10, yDistortion: 30 },
  ];
  const cases = [];
  for (const c of configs) {
    const expression = `starting_spot_at_angle{angle = ${c.angle}, distance = ${c.distance}, radius = ${c.radius}, x_distortion = ${c.xDistortion}, y_distortion = ${c.yDistortion}}`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
      cases.push({ ...c, values });
      console.log(`  captured starting_spot_at_angle angle=${c.angle} distance=${c.distance}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. starting_spot_at_angle routed onto elevation, sampled over the standard scattered grid across 4 angle/distance/radius/distortion configs, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). x_from_start/y_from_start resolve to the raw world (x, y) at this default origin spawn (Task 2 finding). Regenerate: node --experimental-strip-types test/oracle/capture.ts starting-spot",
    seed0: seed,
    planet,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-starting-spot.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${configs.length} configs x ${positions.length} points)`);
}

/**
 * Task 5's three leaf helper closures - `vulcanus_wobble_x`, `mountain_plasma`
 * (= `vulcanus_plasma(102, 2.5, 10, 125, 625)`), and
 * `vulcanus_detail_noise(837, 1/40, 4, 1.25)` - plus `vulcanus_scale_multiplier`
 * (= `slider_rescale(control:vulcanus_volcanism:frequency, 3)`) sampled at the
 * DEFAULT preset (no autoplace_controls override), so the fixture also pins the
 * neutral control default the ctx extension assumes. All routed onto elevation
 * against a real Vulcanus surface ({ spaceAge: true, planet: "vulcanus" }), over
 * the standard scattered grid.
 */
async function captureVulcanusHelpers(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions = gridPositions();

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const wobbleX = await sample("vulcanus_wobble_x");
  console.log("  captured vulcanus_wobble_x");
  const mountainPlasma = await sample("vulcanus_plasma(102, 2.5, 10, 125, 625)");
  console.log("  captured mountain_plasma");
  const detailNoise = await sample("vulcanus_detail_noise(837, 1/40, 4, 1.25)");
  console.log("  captured vulcanus_detail_noise(837, 1/40, 4, 1.25)");
  const scaleMultiplier = await sample("vulcanus_scale_multiplier");
  console.log("  captured vulcanus_scale_multiplier (default control)");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 5's three leaf helper closures (vulcanus_wobble_x, mountain_plasma = vulcanus_plasma(102,2.5,10,125,625), vulcanus_detail_noise(837,1/40,4,1.25)) plus vulcanus_scale_multiplier (= slider_rescale(control:vulcanus_volcanism:frequency, 3), sampled at the DEFAULT preset - no autoplace_controls override - to pin the neutral control value), each routed onto elevation over the standard scattered grid, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-helpers",
    seed0: seed,
    planet,
    positions,
    wobbleX,
    mountainPlasma,
    detailNoise,
    scaleMultiplier,
  };
  const out = join(FIXTURES, "oracle-vulcanus-helpers.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 6's seed-derived radial spawn geometry: `vulcanus_starting_area`,
 * `vulcanus_starting_circle`, and `vulcanus_ashlands_start` (the smallest/most
 * distortion-sensitive of the three `*_start` blobs), each routed onto elevation
 * against a real Vulcanus surface. The grid spans spawn densely (fine step near
 * the origin, where the blobs and the falloff of `starting_circle` actually live)
 * and out to +-800 tiles (coarser step) so the falloff to 0/1 on every side is
 * captured too.
 */
async function captureVulcanusSpawn(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  // Fine grid near spawn (where the blobs and starting_circle falloff live).
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  // Coarser grid spanning out to +-800, so the falloff to 0 (starting_area) /
  // the linear tail (starting_circle) is exercised well beyond the blobs.
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const startingArea = await sample("vulcanus_starting_area");
  console.log("  captured vulcanus_starting_area");
  const startingCircle = await sample("vulcanus_starting_circle");
  console.log("  captured vulcanus_starting_circle");
  const ashlandsStart = await sample("vulcanus_ashlands_start");
  console.log("  captured vulcanus_ashlands_start");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 (Space Age enabled) via the test/oracle harness. Task 6's seed-derived radial spawn geometry: vulcanus_starting_area, vulcanus_starting_circle, and vulcanus_ashlands_start, each routed onto elevation over a grid spanning spawn (fine step -256..256/32 plus a coarser -800..800/160 span), against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-spawn",
    seed0: seed,
    planet,
    positions,
    startingArea,
    startingCircle,
    ashlandsStart,
  };
  const out = join(FIXTURES, "oracle-vulcanus-spawn.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 8's crack/flood helpers - `vulcanus_hairline_cracks`, `vulcanus_flood_cracks_a`,
 * `vulcanus_flood_cracks_b`, `vulcanus_flood_paths`, `vulcanus_flood_basalts_func` -
 * each routed onto elevation over a scattered near+far grid, against a real Vulcanus
 * surface ({ spaceAge: true, planet: "vulcanus" }). These are pure noise (no spawn
 * dependency), so a scattered grid spanning near-origin and deep-field suffices.
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-cracks
 */
async function captureVulcanusCracks(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      positions.push({ x: gx * 13 - 30 + 0.5, y: gy * 17 - 40 + 0.25 });
    }
  }
  for (const r of [500, 1500, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const hairlineCracks = await sample("vulcanus_hairline_cracks");
  console.log("  captured vulcanus_hairline_cracks");
  const floodCracksA = await sample("vulcanus_flood_cracks_a");
  console.log("  captured vulcanus_flood_cracks_a");
  const floodCracksB = await sample("vulcanus_flood_cracks_b");
  console.log("  captured vulcanus_flood_cracks_b");
  const floodPaths = await sample("vulcanus_flood_paths");
  console.log("  captured vulcanus_flood_paths");
  const floodBasaltsFunc = await sample("vulcanus_flood_basalts_func");
  console.log("  captured vulcanus_flood_basalts_func");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 8's crack/flood helpers (vulcanus_hairline_cracks, vulcanus_flood_cracks_a, vulcanus_flood_cracks_b, vulcanus_flood_paths, vulcanus_flood_basalts_func), each routed onto elevation over a scattered near+far grid, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-cracks",
    seed0: seed,
    planet,
    positions,
    hairlineCracks,
    floodCracksA,
    floodCracksB,
    floodPaths,
    floodBasaltsFunc,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cracks.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

async function captureVulcanusResources(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      positions.push({ x: gx * 13 - 30 + 0.5, y: gy * 17 - 40 + 0.25 });
    }
  }
  for (const r of [500, 1500, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  // Fix round 1 (2026-07-24): the original 61 scattered points never landed
  // inside an actual ore/acid region (region > 0 nowhere), so the fixture
  // couldn't discriminate a real spot-selection port from a stub. Ore patches
  // are ~25-30 tiles in radius and sparse, so append a dense scan grid - a
  // 32x32 grid at a 137-tile stride (deliberately incommensurate with the
  // 400/450/1000-tile region_sizes), centered on the origin, offset like the
  // others (+0.5 x, +0.25 y) - to actually hit ore. The original 61 positions
  // are kept, in order, first; the scan grid is appended after them.
  for (let gy = 0; gy < 32; gy++) {
    for (let gx = 0; gx < 32; gx++) {
      positions.push({ x: (gx - 16) * 137 + 0.5, y: (gy - 16) * 137 + 0.25 });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const named: Record<string, string> = {
    basaltsFavorability: "vulcanus_basalts_resource_favorability",
    mountainsFavorability: "vulcanus_mountains_resource_favorability",
    mountainsSulfurFavorability: "vulcanus_mountains_sulfur_favorability",
    ashlandsFavorability: "vulcanus_ashlands_resource_favorability",
    startingTungsten: "vulcanus_starting_tungsten",
    startingCoal: "vulcanus_starting_coal",
    startingCalcite: "vulcanus_starting_calcite",
    startingSulfur: "vulcanus_starting_sulfur",
    tungstenRegion: "vulcanus_tungsten_ore_region",
    coalRegion: "vulcanus_coal_region",
    calciteRegion: "vulcanus_calcite_region",
    sulfuricAcidRegion: "vulcanus_sulfuric_acid_region",
    sulfuricAcidPatches: "vulcanus_sulfuric_acid_patches",
    sulfuricAcidRegionPatchy: "vulcanus_sulfuric_acid_region_patchy",
    metalTile: "vulcanus_metal_tile",
  };

  const captured: Record<string, number[]> = {};
  for (const [key, expression] of Object.entries(named)) {
    captured[key] = await sample(expression);
    console.log(`  captured ${expression}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Vulcanus V2 resource expressions (favorabilities, starting spots, the four regions, the sulfuric-acid patchy chain and vulcanus_metal_tile), each routed onto elevation against a real Vulcanus surface (game.planets['vulcanus'].create_surface()) with default control sliders. positions is two parts, in order: the original 61-point scattered near+far grid (a 6x6 near block plus three 8-point rings at r=500/1500/3300 plus one deep-field point, carrying the favorability/starting-spot coverage and the far-field f32 floor case), then a 1024-point 32x32 dense scan grid at a 137-tile stride centered on the origin (added in a fix round because the original 61 points never landed inside an actual ore/acid region - region > 0 nowhere - so the fixture could not discriminate a real spot-selection port from a stub). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-resources",
    seed0: seed,
    planet,
    positions,
    ...captured,
  };
  const out = join(FIXTURES, "oracle-vulcanus-resources.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 8's biome system + volcano spots: the three clamped biomes
 * (vulcanus_mountains_biome, vulcanus_ashlands_biome, vulcanus_basalts_biome), their
 * unclamped _full variants, mountain_volcano_spots, and vulcanus_mountains_raw_volcano,
 * each routed onto elevation, against a real Vulcanus surface. The grid spans spawn
 * (fine -256..256/32 plus a coarser -800..800/160 span, where starting_area /
 * starting_protector / the starting volcano spot are live) AND far rings at
 * r=1500/3000 (where the biome-noise multiscale and the whole-map volcano spot field
 * dominate). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-biomes
 */
async function captureVulcanusBiomes(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }
  for (const r of [1500, 3000]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const values: Record<string, number[]> = {};
  for (const name of [
    "mountain_volcano_spots",
    "vulcanus_mountains_raw_volcano",
    "vulcanus_mountains_biome_full",
    "vulcanus_ashlands_biome_full",
    "vulcanus_basalts_biome_full",
    "vulcanus_mountains_biome",
    "vulcanus_ashlands_biome",
    "vulcanus_basalts_biome",
  ]) {
    values[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 8's biome system + volcano spots (mountain_volcano_spots, vulcanus_mountains_raw_volcano, the three _full variants, the three clamped biomes), each routed onto elevation over a grid spanning spawn (fine -256..256/32 plus a coarser -800..800/160 span) and far rings at r=1500/3000, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-biomes",
    seed0: seed,
    planet,
    positions,
    values,
  };
  const out = join(FIXTURES, "oracle-vulcanus-biomes.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 7's climate fields, `vulcanus_aux` and `vulcanus_moisture` (`vulcanus_temperature`
 * is deferred to a later task - it depends on `vulcanus_elev`, which does not exist
 * yet). Each routed onto elevation over the same near+far scattered grid used for
 * Task 8's cracks (they consume `vulcanus_flood_paths`/`vulcanus_flood_cracks_a`),
 * against a real Vulcanus surface. Regenerate:
 * node --experimental-strip-types test/oracle/capture.ts vulcanus-climate
 */
async function captureVulcanusClimate(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      positions.push({ x: gx * 13 - 30 + 0.5, y: gy * 17 - 40 + 0.25 });
    }
  }
  for (const r of [500, 1500, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const aux = await sample("vulcanus_aux");
  console.log("  captured vulcanus_aux");
  const moisture = await sample("vulcanus_moisture");
  console.log("  captured vulcanus_moisture");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 7's climate fields (vulcanus_aux, vulcanus_moisture - vulcanus_temperature deferred, depends on vulcanus_elev which doesn't exist yet), each routed onto elevation over a scattered near+far grid, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-climate",
    seed0: seed,
    planet,
    positions,
    aux,
    moisture,
  };
  const out = join(FIXTURES, "oracle-vulcanus-climate.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 9's elevation surface: `vulcanus_elevation` (= `max(-500, vulcanus_elev)`) and
 * the raw `vulcanus_elev` it clamps (temperature reads the RAW value, so both are
 * pinned). Each routed onto elevation, against a real Vulcanus surface. Grid spans
 * spawn (fine -256..256/32 plus a coarser -800..800/160 span, where the biome
 * blend / starting geometry are live) AND far rings at r=1500/3000, matching the
 * biome capture so the two fixtures are directly comparable. Regenerate:
 * node --experimental-strip-types test/oracle/capture.ts vulcanus-elevation
 */
async function captureVulcanusElevation(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }
  for (const r of [1500, 3000]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const elev = await sample("vulcanus_elev");
  console.log("  captured vulcanus_elev");
  const elevation = await sample("vulcanus_elevation");
  console.log("  captured vulcanus_elevation");

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 9's elevation surface: vulcanus_elev (raw, read by temperature) and vulcanus_elevation (= max(-500, vulcanus_elev)), each routed onto elevation over a grid spanning spawn (fine -256..256/32 plus a coarser -800..800/160 span) and far rings at r=1500/3000, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-elevation",
    seed0: seed,
    planet,
    positions,
    elev,
    elevation,
  };
  const out = join(FIXTURES, "oracle-vulcanus-elevation.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Task 9's `vulcanus_temperature` (deferred out of Task 7 until `vulcanus_elev`
 * existed). Depends on the raw elev, moisture, aux, ashlands_biome and
 * mountain_volcano_spots. Same grid as captureVulcanusElevation, against a real
 * Vulcanus surface at the DEFAULT preset (control:temperature:bias = 0). Regenerate:
 * node --experimental-strip-types test/oracle/capture.ts vulcanus-temperature
 */
async function captureVulcanusTemperature(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }
  for (const r of [1500, 3000]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({
        x: snapToMapPosition(r * Math.cos(a) + 0.5),
        y: snapToMapPosition(r * Math.sin(a) + 0.25),
      });
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const temperature = await sampleExpression("vulcanus_temperature", positions, {
      workDir,
      seed,
      spaceAge: true,
      planet,
    });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Task 9's vulcanus_temperature (deferred out of Task 7 until vulcanus_elev existed) routed onto elevation over a grid spanning spawn (fine -256..256/32 plus a coarser -800..800/160 span) and far rings at r=1500/3000, at the DEFAULT preset (control:temperature:bias = 0), against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-temperature",
      seed0: seed,
      planet,
      positions,
      temperature,
    };
    const out = join(FIXTURES, "oracle-vulcanus-temperature.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${out} (${positions.length} points)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The `get_tile` tile-name oracle for VULCANUS (Task 10): the Space-Age sibling of
 * `captureTileNames`. Reuses the same real-chunk-generate path
 * (`sampleTileNames`), but with `{ spaceAge: true, planet: "vulcanus" }` so tiles
 * are read from a real Vulcanus surface (`game.planets["vulcanus"].create_surface()`)
 * instead of Nauvis. A golden-angle spiral from spawn out to ~2600 tiles spans the
 * radial Vulcanus biomes (mountains disc near center, then basalts/ashlands rings),
 * plus a dense near-spawn square grid. Seed 123456. Validates the tile argmax +
 * map_color port. Regenerate: node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-tile-names
 */
/**
 * **A DENSE tile-name capture at the lava boundaries the cliff rejection reads**
 * (issue #84, the lava-perimeter thread).
 *
 * `oracle-vulcanus-tile-names` is a sparse survey - a 64-tile grid plus a
 * golden-angle spiral - and its lava classification is exact on all 381 of its
 * positions. That exactness is real but it cannot settle a SUB-TILE boundary
 * question: its sensitivity was measured by planting scale factors on `lava`'s
 * probability, and `1.02` and `1.2` both still pass. Sparse positions simply do
 * not sit close enough to a boundary in probability space.
 *
 * The negative-space oracle in `vulcanusCliffEntities.spec.ts` says the boundary
 * IS off somewhere: 13 real cliffs the game placed have our lava inside their
 * collision box, and the game ran that same rejection and kept them. The 35
 * distinct tiles responsible are the seeds here, each expanded to a Chebyshev
 * radius-4 neighbourhood so the SHAPE of the disagreement is visible - whether
 * our blob is a uniform tile too fat, fat only on one side, or something else.
 *
 * These are deliberately the hardest positions on the map for the resolver
 * rather than a representative sample, so the agreement rate here is not
 * comparable with the survey's and is not meant to be.
 *
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-lava-boundary
 */
async function captureVulcanusLavaBoundary(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  // The 35 tiles our mask calls lava inside a REAL cliff's collision box,
  // dumped from the placement itself (see the spec that consumes this fixture).
  const seeds: readonly (readonly [number, number])[] = [
    [88, 41],
    [89, 40],
    [89, 41],
    [85, 45],
    [86, 43],
    [86, 44],
    [87, 42],
    [87, 43],
    [87, 44],
    [82, 48],
    [83, 47],
    [83, 48],
    [24, 181],
    [25, 181],
    [4, 187],
    [5, 187],
    [6, 187],
    [7, 187],
    [1637, 1598],
    [1693, 1599],
    [1693, 1600],
    [1694, 1599],
    [1694, 1600],
    [1695, 1600],
    [1696, 1600],
    [1697, 1600],
    [1635, 1599],
    [1636, 1599],
    [1663, 1636],
    [1663, 1637],
    [1521, 1680],
    [-1052, 1016],
    [-1051, 1016],
    [-1051, 1017],
    [-1061, 1029],
  ];
  const RADIUS = 4;
  const seen = new Set<string>();
  const positions: Position[] = [];
  for (const [sx, sy] of seeds)
    for (let dx = -RADIUS; dx <= RADIUS; dx++)
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        const k = `${String(x)},${String(y)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        // Sample the tile's own integer coordinate; `sampleTileNames` echoes the
        // floored `get_tile` input back, so the fixture records what was asked.
        positions.push({ x: x + 0.5, y: y + 0.5 });
      }

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const samples: TileSample[] = await sampleTileNames(positions, {
      workDir,
      seed,
      spaceAge: true,
      planet,
    });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. surface.get_tile(x, y).name on a real Vulcanus surface (game.planets['vulcanus'].create_surface(), seed 123456) after real chunk generation. DENSE: Chebyshev radius-4 neighbourhoods around the 35 tiles our lava mask wrongly places inside a real cliff's collision box, so the boundary error's shape is visible. Deliberately the hardest positions for the resolver, NOT a representative sample - the agreement rate here is not comparable with oracle-vulcanus-tile-names. positions are the mod's ECHOED floored get_tile input. Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-lava-boundary",
      seed0: seed,
      planet,
      seeds: seeds.map(([x, y]) => ({ x, y })),
      radius: RADIUS,
      positions: samples.map((s) => ({ x: s.x, y: s.y })),
      tileNames: samples.map((s) => s.name),
    };
    const out = join(FIXTURES, "oracle-vulcanus-lava-boundary.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    const distinct = [...new Set(fixture.tileNames)].sort();
    console.log(
      `wrote ${out} (${String(positions.length)} points, ${String(distinct.length)} distinct tiles: ${distinct.join(", ")})`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function captureVulcanusTileNames(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  // Dense near-spawn grid (the mountains/volcano biome disc).
  for (let gy = -320; gy <= 320; gy += 64) {
    for (let gx = -320; gx <= 320; gx += 64) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  // Golden-angle spiral out to ~2600 tiles to cross basalts + ashlands rings.
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const count = 260;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const r = 120 + t * (2600 - 120);
    const a = i * GOLDEN_ANGLE;
    positions.push({
      x: snapToMapPosition(r * Math.cos(a) + 0.5),
      y: snapToMapPosition(r * Math.sin(a) + 0.25),
    });
  }

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const samples: TileSample[] = await sampleTileNames(positions, {
      workDir,
      seed,
      radius: 1,
      spaceAge: true,
      planet,
    });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. surface.get_tile(x, y).name on a real Vulcanus surface (game.planets['vulcanus'].create_surface(), seed 123456) after real chunk generation, over a near-spawn grid + a golden-angle spiral to ~2600 tiles spanning the radial biomes. positions are the mod's ECHOED floored get_tile input. Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-tile-names",
      seed0: seed,
      planet,
      positions: samples.map((s) => ({ x: s.x, y: s.y })),
      tileNames: samples.map((s) => s.name),
    };
    const out = join(FIXTURES, "oracle-vulcanus-tile-names.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    const distinct = [...new Set(fixture.tileNames)].sort();
    console.log(
      `wrote ${out} (${positions.length} points, ${distinct.length} distinct tiles: ${distinct.join(", ")})`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Vulcanus cliffs: `cliffiness_basic` (the planet's `cliffiness` property, per
 * `planet-map-gen.lua:13`) plus `cliff_richness`, which that expression reads.
 *
 * `cliff_richness` is captured deliberately rather than assumed. Vulcanus has no
 * cliff autoplace control - `space-age/prototypes/autoplace-controls.lua` defines
 * `gleba_cliff` and `fulgora_cliff` but no Vulcanus equivalent - so the port pins
 * it at 1, and this fixture is what makes that a measurement instead of a
 * reading of the Lua.
 *
 * The planet's other cliff property, `cliff_elevation`, is
 * `cliff_elevation_from_elevation`, whose expression is literally `elevation`.
 * It is NOT sampled here: the harness routes the probe *at* the `elevation`
 * property, so probing it would be circular. It is covered instead by
 * `oracle-vulcanus-elevation.seed123456.json`, since the two are the same field.
 *
 * Grid spans spawn finely and adds far rings, matching the biome capture, since
 * `cliffiness_basic` is a plain 2-octave noise with no distance term and the far
 * points mainly guard against a seeding mistake that only shows up off-origin.
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-cliffs
 */
async function captureVulcanusCliffs(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }
  // Ring coordinates are SNAPPED to 1/256, unlike the biome/resource captures
  // which push raw `r * cos(a)` values. MapPosition is 1/256 fixed point, so the
  // game stores the snapped value either way - but the fixture then records the
  // unsnapped one, and the port evaluates there. Usually that costs ~1e-4 (the
  // offset the V2 notes describe for sulfuricAcidPatches). It can cost far more:
  // captured unsnapped, this fixture's k=9 r=3000 point came out at
  // x = 0.4999999999994489, which sits within 5.5e-13 of a noise lattice
  // boundary. The game's f32 and our f64 land on opposite sides of the floor()
  // there, and the residual jumps from 2.75e-7 (at an exact 0.5) to 3.74e-4 -
  // a knife-edge artifact of the probe position, not of the port. Snapping
  // removes it and lets this spec assert a tight bound everywhere.
  const snap = (v: number): number => Math.round(v * 256) / 256;
  for (const r of [1500, 3000]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({ x: snap(r * Math.cos(a) + 0.5), y: snap(r * Math.sin(a) + 0.25) });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const values: Record<string, number[]> = {};
  for (const name of ["cliffiness_basic", "cliff_richness"]) {
    values[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. Vulcanus's cliffiness property (cliffiness_basic) and the cliff_richness it reads, routed onto elevation over a grid spanning spawn (fine -256..256/32 plus a coarser -800..800/160 span) and far rings at r=1500/3000, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). cliff_elevation is deliberately absent: it resolves to `elevation`, which the probe itself occupies, and is covered by oracle-vulcanus-elevation. Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-cliffs",
    seed0: seed,
    planet,
    positions,
    values,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliffs.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

/**
 * Vulcanus rocks: the two probability expressions its rock ENTITIES use
 * (`vulcanus_rock_huge`, `vulcanus_rock_big` - the `-hot` variants reuse them)
 * and the `vulcanus_decorative_knockout` noise they both read.
 *
 * The four decorative-only siblings (`vulcanus_rock_medium/cluster/small/tiny`)
 * are not captured: the game's map preview charts entities, not decoratives, so
 * the overlay does not use them.
 *
 * Ring coordinates are snapped to 1/256 for the reason documented on
 * `captureVulcanusCliffs` - unsnapped ring positions can land within ~1e-12 of a
 * noise lattice boundary and inflate the residual by three orders of magnitude.
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-rocks
 */
async function captureVulcanusRocks(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = -256; gy <= 256; gy += 32) {
    for (let gx = -256; gx <= 256; gx += 32) {
      positions.push({ x: gx + 0.5, y: gy + 0.25 });
    }
  }
  for (let gy = -800; gy <= 800; gy += 160) {
    for (let gx = -800; gx <= 800; gx += 160) {
      positions.push({ x: gx + 0.125, y: gy + 0.375 });
    }
  }
  const snap = (v: number): number => Math.round(v * 256) / 256;
  for (const r of [1500, 3000]) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      positions.push({ x: snap(r * Math.cos(a) + 0.5), y: snap(r * Math.sin(a) + 0.25) });
    }
  }

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const values: Record<string, number[]> = {};
  for (const name of ["vulcanus_decorative_knockout", "vulcanus_rock_huge", "vulcanus_rock_big"]) {
    values[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via the test/oracle harness. The two probability expressions Vulcanus's rock ENTITIES use (vulcanus_rock_huge, vulcanus_rock_big; the -hot variants reuse them) plus the vulcanus_decorative_knockout noise they read, routed onto elevation over a grid spanning spawn (fine -256..256/32 plus a coarser -800..800/160 span) and far rings at r=1500/3000 snapped to 1/256, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()). Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-rocks",
    seed0: seed,
    planet,
    positions,
    values,
  };
  const out = join(FIXTURES, "oracle-vulcanus-rocks.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}

const VORONOI_DISTANCE_TYPES = ["chebyshev", "manhattan", "euclidean", "minkowski3"] as const;

const VORONOI_OPS = [
  "voronoi_cell_id",
  "voronoi_spot_noise",
  "voronoi_facet_noise",
  "voronoi_pyramid_noise",
] as const;

/**
 * Snap a coordinate to Factorio's `MapPosition` fixed point (1/256 of a tile,
 * FLOORED), which is what the oracle path does to it whether we ask or not.
 *
 * **This is a property of the harness, not of any noise expression, and it is a
 * silent one.** A Lua position handed to `calculate_tile_properties` is
 * converted to a `MapPosition` on the way in, so a sample nominally at
 * `x = 11.166666666666666` is actually taken at `11.1640625` (`= 2858 / 256`).
 * The error is ~4e-3 tiles: far too small to look like a wrong formula, far too
 * large to be f32 noise, and therefore exactly the kind of discrepancy that gets
 * absorbed into a fudged constant instead of being recognised.
 *
 * It bit this capture directly. The brief's grid steps by `grid_size / 6` =
 * 10.666..., which is not representable in 1/256, and fitting `spot_noise`
 * against the NOMINAL positions scored 79/175 with residuals around 4e-5 -
 * wrong, but plausibly-wrong. Snapping first took chebyshev and manhattan to
 * 175/175 with no change to the model at all.
 *
 * Snapping here rather than compensating downstream keeps the fixture honest:
 * its `positions` are then exactly where the game sampled, and nothing that
 * reads it has to know this function exists.
 */
function snapToMapPosition(t: number): number {
  return Math.floor(t * 256) / 256;
}

/*
 * `Math.floor` above, but `test/captureGrid.ts` recovers a recorded coordinate
 * with `Math.trunc`. Both are right, for different jobs.
 *
 * Here the job is to PRODUCE a coordinate that is already a multiple of 1/256.
 * Any rounding does that, and the game's own conversion is then a no-op, so
 * floor and trunc are interchangeable at this end.
 *
 * There the job is to REPRODUCE what the game did to a coordinate that was
 * recorded off the grid. That is one specific conversion - `fcvtzs`, truncation
 * toward zero - and it is measurably not flooring: across the affected fixtures
 * flooring is worse than applying no snap at all in several arrays, while
 * truncation is exact where flooring is not on six of the ten rows that have a
 * negative coordinate, and never the reverse.
 */

/**
 * Positions for the jitter-0 voronoi capture.
 *
 * The first 144 are the brief's grid: `grid_size` 64 stepped by `grid_size / 6`
 * with a 0.5 offset, which keeps every probe off an exact integer boundary where
 * an f32 tie could flip which point wins for reasons that are not the formula.
 *
 * Three groups are APPENDED to it, each answering something that grid cannot:
 *
 * - **Exact cell centres.** At jitter 0 the cell's point IS the centre, so
 *   `voronoi_spot_noise` must read exactly 0 there whatever the normalisation
 *   divisor turns out to be. That is the one sanity check that separates "the
 *   probe samples the cell we think it does" from "the formula is wrong", and
 *   the 0.5-offset grid never lands on a centre, so without these it cannot be
 *   run at all.
 * - **Negative coordinates**, which the grid omits entirely. A cell lookup that
 *   truncates toward zero instead of flooring is invisible for x >= 0 and wrong
 *   for exactly half the map.
 * - **Far-from-origin and off-phase points**, so a formula that happens to fit
 *   near the origin cannot survive by accident.
 */
function voronoiPositions(gridSize: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      out.push({
        x: snapToMapPosition(i * (gridSize / 6) + 0.5),
        y: snapToMapPosition(j * (gridSize / 6) + 0.5),
      });
    }
  }
  const half = gridSize / 2;
  for (const cx of [-2, -1, 0, 1, 2]) {
    for (const cy of [-2, -1, 0, 1, 2]) {
      out.push({ x: cx * gridSize + half, y: cy * gridSize + half });
    }
  }
  out.push(
    { x: -0.5, y: -0.5 },
    { x: -33.25, y: -97.75 },
    { x: 63.5, y: 63.5 },
    { x: 1000.5, y: -2000.25 },
    { x: -777.75, y: 333.125 },
    { x: 12345.75, y: 6789.125 },
  );
  return out;
}

/**
 * The four `voronoi_*` ops x the four `distance_type`s at **jitter 0**, where
 * every point sits at its cell centre and the per-cell RNG is out of the picture
 * entirely - so all four ops reduce to pure geometry and can be fitted in closed
 * form (`voronoi_cell_id` excepted; it is a hash of the cell and needs the RNG
 * whatever the jitter).
 *
 * `spaceAge` is deliberately false: `voronoi_*` are engine builtins
 * (`NativeNoiseFunctions`), not planet-scoped named expressions, so they resolve
 * on the plain Nauvis surface and the DLC load is unnecessary.
 */
async function captureVoronoiJitter0(): Promise<void> {
  const seed = 123456;
  const gridSize = 64;
  const seed1 = 1;
  const jitter = 0;
  const positions = voronoiPositions(gridSize);
  const values: Record<string, number[]> = {};

  for (const op of VORONOI_OPS) {
    for (const distanceType of VORONOI_DISTANCE_TYPES) {
      // **15 series, not 16.** The game's own noise-expression COMPILER rejects
      // this one pair outright - "Voronoi pyramid noise with Minkowski3 distance
      // is not supported" - so there is no ground truth to capture and the run
      // dies before sampling. Measured across all 16 pairs against the 2.1.12
      // binary; the other 15 compile. The API docs agree in a way that is easy
      // to read past: `voronoi_pyramid_noise`'s "Available values for
      // distance_type" list has three entries where every other voronoi op has
      // four. `pyramidNoise` in the port throws for this pair for the same
      // reason.
      if (op === "voronoi_pyramid_noise" && distanceType === "minkowski3") continue;
      const expression = buildVoronoiExpression({
        op,
        x: "x",
        y: "y",
        seed1: String(seed1),
        gridSize,
        distanceType,
        jitter,
      });
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        values[`${op}:${distanceType}`] = await sampleExpression(expression, positions, {
          workDir,
          seed,
        });
        console.log(`  captured ${op}:${distanceType}`);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via the test/oracle harness. The four voronoi_* ops x the " +
      "four distance_type values, each routed onto elevation on the default Nauvis surface, at " +
      "JITTER 0 - where every point sits at its cell centre, so the per-cell RNG does not move any " +
      "point and the ops reduce to pure geometry. Positions are the 12x12 half-offset grid plus " +
      "exact cell centres (spot_noise must read 0 there), negative coordinates, and far-off-origin " +
      "points. Regenerate: node --experimental-strip-types test/oracle/capture.ts voronoi-jitter0",
    seed,
    gridSize,
    jitter,
    seed1,
    positions,
    values,
  };
  const out = join(FIXTURES, "oracle-voronoi-jitter0.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(Object.keys(values).length)} series x ${String(positions.length)} points)`,
  );
}

/**
 * `voronoi_cell_id` at the CENTRE of every cell in a 16x16 cell block, across
 * three `seed0` (the map seed) x three `seed1`.
 *
 * `cell_id` is the per-cell RNG exposed directly as a float, so this is the
 * cheapest possible view of the hash: one value per cell, no geometry, no
 * boundary ambiguity. `distance_type` is irrelevant to it - the jitter-0 fixture
 * asserts all four agree value-for-value - so only `chebyshev` is sampled.
 *
 * Two properties of the position set are deliberate:
 *
 * - **Cell indices span -8..7, not 0..15.** Negative indices are what
 *   distinguish a hash that treats the cell coordinate as a two's-complement
 *   `u32` from one that does anything else, and half the map has them.
 * - **Every position is an exact integer** (`cx * 64 + 32`), so the 1/256
 *   `MapPosition` floor that {@link snapToMapPosition} exists for cannot bite:
 *   the game samples exactly where we asked, including for negative x/y where
 *   floor-vs-truncate would otherwise be live.
 */
async function captureVoronoiCellId(): Promise<void> {
  const gridSize = 64;
  const jitter = 0;
  const cells: { cx: number; cy: number }[] = [];
  for (let cx = -8; cx < 8; cx++) {
    for (let cy = -8; cy < 8; cy++) cells.push({ cx, cy });
  }
  const positions: Position[] = cells.map(({ cx, cy }) => ({
    x: cx * gridSize + gridSize / 2,
    y: cy * gridSize + gridSize / 2,
  }));

  const series: { seed0: number; seed1: number; values: number[] }[] = [];
  for (const seed0 of [123456, 1, 4294967295]) {
    for (const seed1 of [0, 1, 137]) {
      const expression = buildVoronoiExpression({
        op: "voronoi_cell_id",
        x: "x",
        y: "y",
        seed1: String(seed1),
        gridSize,
        distanceType: "chebyshev",
        jitter,
      });
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const values = await sampleExpression(expression, positions, { workDir, seed: seed0 });
        series.push({ seed0, seed1, values });
        console.log(`  captured seed0=${seed0} seed1=${seed1}`);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via the test/oracle harness. voronoi_cell_id routed onto " +
      "elevation on the default Nauvis surface, sampled at the CENTRE of every cell in a 16x16 " +
      "cell block (cell indices -8..7, so negative cell coordinates are covered), for 3 seed0 x 3 " +
      "seed1 at grid_size 64, jitter 0. cell_id is the per-cell RNG as a float, so this is the hash " +
      "with no geometry in the way; distance_type does not enter it (the jitter-0 fixture asserts " +
      "all four agree). Regenerate: node --experimental-strip-types test/oracle/capture.ts voronoi-cellid",
    gridSize,
    jitter,
    cells,
    positions,
    series,
  };
  const out = join(FIXTURES, "oracle-voronoi-cellid.multiseed.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(series.length)} series x ${String(positions.length)} values)`,
  );
}

/**
 * Assert a coordinate is EXACTLY representable as a `MapPosition` (a multiple of
 * 1/256 of a tile), and return it unchanged.
 *
 * This is the alternative taken to {@link snapToMapPosition} for the jittered
 * point capture, and the choice was deliberate. `snapToMapPosition` uses
 * `Math.floor`, and every negative probe committed so far happened to be exactly
 * representable - so floor and truncate-toward-zero are indistinguishable in all
 * existing data, and this capture's lattice would have been the first place the
 * difference could bite.
 *
 * Rather than pick a rounding rule that no fixture can discriminate, or plumb an
 * echo-back of the position the game used (which `sampleTileNames` does, but
 * `calculate_tile_properties` gives no such channel - the mod echoes the
 * positions it was HANDED), the lattice is built entirely from multiples of 1/2
 * a tile. Those are exact in 1/256 whatever their sign, so no rounding rule
 * applies at all and the question is removed rather than answered.
 *
 * This assertion is what keeps that property from silently lapsing: change the
 * spacing to something like `gridSize / 6` and the capture dies here instead of
 * quietly sampling ~4e-3 tiles away from where the fixture claims.
 */
function assertRepresentable(t: number): number {
  if (!Number.isInteger(t * 256)) {
    throw new Error(
      `position ${String(t)} is not a multiple of 1/256 and would be silently ` +
        "floored to a MapPosition by the game - see assertRepresentable",
    );
  }
  return t;
}

/**
 * **R3: where a cell's point actually sits once `jitter > 0`** - the
 * configuration Fulgora uses (0.6, 0.8 and 1.0).
 *
 * Two independent readouts, in one fixture, because they answer different
 * questions and neither alone is enough:
 *
 * **`series` - the inversion lattice.** `voronoi_spot_noise` is a cone whose
 * apex sits ON the point, so its minimum over a lattice recovers the point's
 * position directly, with no model in the loop. The lattice is the 64x64 TILE
 * CENTRES of one whole cell (`cellX`, `cellY`), so it is prediction-free: at
 * jitter 1 the point may be anywhere in the cell, and a lattice placed around a
 * predicted position would only ever confirm the prediction it was built from.
 *
 * `cellIds` is captured alongside at the same positions and is **not
 * redundant.** `spot_noise` is the distance to the nearest point of ANY cell, so
 * a neighbour's point sitting just outside the boundary can own lattice points
 * inside this cell and win the global argmin - at which case the recovered
 * "apex" would be a different cell's point entirely. `voronoi_cell_id` says
 * which point won at each lattice position, so the argmin can be restricted to
 * the positions this cell actually owns. That filter comes from the game, not
 * from the port.
 *
 * **`ops` - the exact-f32 acceptance set.** Locating a point to within half a
 * tile is not acceptance; the bar for this repo is bit-exact agreement. So the
 * jitter-0 fixture's own 15 op x distance_type series are re-captured at each of
 * the three jitters, over the same 175 positions, giving 45 series the port must
 * reproduce exactly.
 *
 * That set is also the **first configuration that can discriminate Task 2's
 * pyramid formulas.** At jitter 0 every cell is a congruent unit square and many
 * different algorithms collapse to identical numbers; with the points scattered
 * they do not. `voronoi_pyramid_noise` is included at all three distance types
 * it supports for exactly that reason.
 */
async function captureVoronoiPoints(): Promise<void> {
  const seed = 123456;
  const gridSize = 64;
  const seed1 = 1;
  const jitters = [0.6, 0.8, 1] as const;
  const latticeDistanceTypes = ["manhattan", "euclidean"] as const;
  // Fulgora's own two ops are manhattan and euclidean, and the load-bearing
  // question is whether they can share one point field, so those are the two the
  // lattice inverts. The cell is an arbitrary interior one; nothing about it is
  // special, and in particular it is NOT one of the two colliding pairs
  // ((0,0)/(-1,-1) and (-1,0)/(0,-1)) whose shared word would make a
  // point-position claim about "this cell" ambiguous.
  const cellX = 3;
  const cellY = 5;

  const lattice: Position[] = [];
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 64; j++) {
      lattice.push({
        x: assertRepresentable(cellX * gridSize + i + 0.5),
        y: assertRepresentable(cellY * gridSize + j + 0.5),
      });
    }
  }

  const series: {
    jitter: number;
    distanceType: string;
    cellX: number;
    cellY: number;
    lattice: Position[];
    values: number[];
    cellIds: number[];
  }[] = [];

  for (const jitter of jitters) {
    for (const distanceType of latticeDistanceTypes) {
      const sample = async (op: (typeof VORONOI_OPS)[number]): Promise<number[]> => {
        const expression = buildVoronoiExpression({
          op,
          x: "x",
          y: "y",
          seed1: String(seed1),
          gridSize,
          distanceType,
          jitter,
        });
        const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
        try {
          return await sampleExpression(expression, lattice, { workDir, seed });
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      };
      const values = await sample("voronoi_spot_noise");
      const cellIds = await sample("voronoi_cell_id");
      series.push({ jitter, distanceType, cellX, cellY, lattice, values, cellIds });
      console.log(`  captured lattice jitter=${String(jitter)} ${distanceType}`);
    }
  }

  const opPositions = voronoiPositions(gridSize);
  const ops: Record<string, number[]> = {};
  for (const jitter of jitters) {
    for (const op of VORONOI_OPS) {
      for (const distanceType of VORONOI_DISTANCE_TYPES) {
        // Same 15-of-16 exclusion as the jitter-0 capture: the game's expression
        // compiler rejects pyramid x minkowski3 outright, so there is no ground
        // truth to take and the run dies before sampling.
        if (op === "voronoi_pyramid_noise" && distanceType === "minkowski3") continue;
        const expression = buildVoronoiExpression({
          op,
          x: "x",
          y: "y",
          seed1: String(seed1),
          gridSize,
          distanceType,
          jitter,
        });
        const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
        try {
          ops[`${op}:${distanceType}:${String(jitter)}`] = await sampleExpression(
            expression,
            opPositions,
            { workDir, seed },
          );
          console.log(`  captured ${op}:${distanceType} jitter=${String(jitter)}`);
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via the test/oracle harness, for JITTERED voronoi point " +
      "placement (jitter 0.6 / 0.8 / 1.0 at grid_size 64, seed0 123456, seed1 1). `series` is the " +
      "inversion lattice: voronoi_spot_noise plus voronoi_cell_id over the 64x64 tile centres of " +
      "cell (3,5), under manhattan and euclidean - spot_noise's cone apex sits ON the point, so its " +
      "minimum over the lattice IS the point, and cell_id says which cell owns each lattice position " +
      "so a neighbour's point cannot be mistaken for this one. `ops` is the exact-f32 acceptance " +
      "set: the same 15 op x distance_type series and 175 positions as the jitter-0 fixture, " +
      "re-captured at each jitter. Every lattice coordinate is a multiple of 1/2 a tile and so is " +
      "exact in the 1/256 MapPosition grid whatever its sign. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts voronoi-points",
    seed,
    seed1,
    gridSize,
    series,
    opPositions,
    ops,
  };
  const out = join(FIXTURES, "oracle-voronoi-points.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(series.length)} lattice series x ${String(lattice.length)} points, ` +
      `${String(Object.keys(ops).length)} op series x ${String(opPositions.length)} points)`,
  );
}

/**
 * **The positions where `VoronoiNoise::getPointsSearchRange()` is OBSERVABLE** -
 * the only fixture in the repo that can tell a 3x3 neighbour search from a 5x5
 * one.
 *
 * The other two voronoi fixtures cannot, and that was measured rather than
 * assumed: forcing the port's search range to 2 for all four distance types
 * passes all 95 voronoi tests, and forcing it to 1 also passes all 95. So 2100
 * committed values are indifferent to a function that Factorio changed the
 * behaviour of in 2.1.7 (forums.factorio.com/130905 - before that the ops missed
 * the true nearest point at high jitter). This fixture exists to end that.
 *
 * **Only `voronoi_pyramid_noise` can discriminate**, and its second loop is why.
 * `spot`/`facet`/`cell_id` reduce to the two smallest point distances, and a
 * ring-2 point is more than a grid unit away on one axis, so it essentially
 * never displaces them. The pyramid's second loop instead minimises the distance
 * to the BISECTOR of the nearest point and each other point - and for euclidean
 * that is `(|f|^2 - |n|^2) / (2 |f - n|)`, which is small whenever `|f| ~= |n|`
 * however far `f`'s cell index is. A ring-2 point only has to be nearly
 * equidistant, not nearer, so the pyramid sees the wider ring where nothing else
 * does.
 *
 * The five configurations below were chosen so that BOTH branches of the
 * function are pinned, in both directions:
 *
 * - **chebyshev at jitter 1** is the `1` branch. The jump table pins chebyshev
 *   at 1 whatever the jitter, and there is a clean proof of why: the own cell's
 *   point has `max(|dx|,|dy|) < 1` while every ring-2 point has `> 1`, so under
 *   L-infinity the nearest point is always in the sample's own cell. The pyramid
 *   still notices the ring, so these positions read the game's ring-1 answer.
 *   **This is exactly Fulgora's `fulgora_road_pyramids` configuration**
 *   (chebyshev, `fulgora_road_jitter = 1`).
 * - **manhattan / euclidean at jitter 1** are the `2` branch.
 * - **manhattan at 0.7 and euclidean at 0.9** are the LOWEST jitters found to
 *   discriminate at all, so they are what bounds each threshold from above
 *   (manhattan's must be below 0.7, euclidean's below 0.9). The thresholds
 *   themselves - 0.5, f32(0.66), 0.75 - cannot be pinned behaviourally: a
 *   ring-1/ring-2 disagreement needs high jitter, and a 4096x4096 tile sweep at
 *   manhattan 0.5 and euclidean 0.66 found zero disagreements. That gap is what
 *   `test/voronoiSearchRange.spec.ts`'s weaker table test covers.
 *
 * Positions are hand-picked from a sweep of the port with the ring forced to 1
 * and to 2, keeping only samples where the two answers differ by more than 2%
 * and thinning by a stride so they are not all one cluster. Picking them from
 * the port is fine and does not beg the question: the port chooses only WHERE to
 * look, and the game alone says which of the two answers is right.
 */
async function captureVoronoiSearchRange(): Promise<void> {
  const seed = 123456;
  const gridSize = 64;
  const seed1 = 1;

  const configs: {
    distanceType: (typeof VORONOI_DISTANCE_TYPES)[number];
    jitter: number;
    expectedRange: 1 | 2;
    positions: Position[];
  }[] = [
    {
      distanceType: "chebyshev",
      jitter: 1,
      expectedRange: 1,
      positions: [
        { x: 1727.5, y: -1017.5 },
        { x: 1726.5, y: -1017.5 },
        { x: 767.5, y: -508.5 },
        { x: 512.5, y: 1280.5 },
        { x: -382.5, y: 1593.5 },
        { x: -1855.5, y: -1578.5 },
        { x: -127.5, y: -639.5 },
        { x: -126.5, y: -637.5 },
      ],
    },
    {
      distanceType: "manhattan",
      jitter: 1,
      expectedRange: 2,
      positions: [
        { x: -833.5, y: -1023.5 },
        { x: -825.5, y: -1022.5 },
        { x: -818.5, y: -1021.5 },
        { x: -812.5, y: -1020.5 },
        { x: -803.5, y: -1019.5 },
        { x: -825.5, y: -1017.5 },
        { x: -813.5, y: -1016.5 },
        { x: -834.5, y: -1012.5 },
        { x: -819.5, y: -1011.5 },
        { x: -824.5, y: -1007.5 },
        { x: -267.5, y: -963.5 },
      ],
    },
    {
      distanceType: "manhattan",
      jitter: 0.7,
      expectedRange: 2,
      positions: [
        { x: -256.5, y: -943.5 },
        { x: -876.5, y: -840.5 },
        { x: -869.5, y: -838.5 },
        { x: -881.5, y: -835.5 },
        { x: -877.5, y: -833.5 },
        { x: -254.5, y: 172.5 },
      ],
    },
    {
      distanceType: "euclidean",
      jitter: 1,
      expectedRange: 2,
      positions: [
        { x: 1471.5, y: -2035.5 },
        { x: -1207.5, y: -1991.5 },
        { x: -1212.5, y: -1987.5 },
        { x: -1139.5, y: -1855.5 },
        { x: 1090.5, y: -1791.5 },
        { x: -1280.5, y: -1743.5 },
        { x: 739.5, y: -1660.5 },
        { x: -1865.5, y: -1471.5 },
        { x: 513.5, y: -1416.5 },
        { x: -1664.5, y: -1382.5 },
        { x: -198.5, y: -1150.5 },
      ],
    },
    {
      distanceType: "euclidean",
      jitter: 0.9,
      expectedRange: 2,
      positions: [{ x: 701.5, y: -835.5 }],
    },
  ];

  const series: {
    distanceType: string;
    jitter: number;
    expectedRange: 1 | 2;
    positions: Position[];
    values: number[];
  }[] = [];

  for (const c of configs) {
    for (const pos of c.positions) {
      assertRepresentable(pos.x);
      assertRepresentable(pos.y);
    }
    const expression = buildVoronoiExpression({
      op: "voronoi_pyramid_noise",
      x: "x",
      y: "y",
      seed1: String(seed1),
      gridSize,
      distanceType: c.distanceType,
      jitter: c.jitter,
    });
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const values = await sampleExpression(expression, c.positions, { workDir, seed });
      series.push({ ...c, values });
      console.log(`  captured ${c.distanceType} jitter=${String(c.jitter)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via the test/oracle harness. voronoi_pyramid_noise at the " +
      "positions where the game's own VoronoiNoise::getPointsSearchRange() is OBSERVABLE - i.e. " +
      "where searching a 3x3 ring of cells and searching a 5x5 ring give different answers. The " +
      "other two voronoi fixtures are indifferent to that function in both directions (forcing the " +
      "port to 1, and to 2, each passes all 95 voronoi tests), and Factorio changed this behaviour " +
      "in 2.1.7 (forums.factorio.com/130905), so without these positions a version skew would be " +
      "silent. chebyshev jitter 1 pins the table's chebyshev entry at 1 - and is Fulgora's " +
      "fulgora_road_pyramids configuration; manhattan/euclidean jitter 1 pin the '> threshold ? 2' " +
      "branch; manhattan 0.7 and euclidean 0.9 are the lowest jitters found to discriminate at all " +
      "and so bound those thresholds from above. Every coordinate is a multiple of 1/2 a tile and " +
      "so exact in the 1/256 MapPosition grid. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts voronoi-search-range",
    seed,
    seed1,
    gridSize,
    series,
  };
  const out = join(FIXTURES, "oracle-voronoi-search-range.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(series.length)} series)`);
}

if (!oracleAvailable()) {
  console.error("No Factorio binary found (set FACTORIO_BIN). Cannot capture fixtures.");
  process.exit(1);
}

/**
 * Fulgora's shared layer: the grid constant, the wobble fields that distort the
 * Voronoi input, the offset/distorted coordinates, and the two starting cones.
 *
 * Positions deliberately span BOTH scales, because these fields disagree at
 * different ones: the starting cones are only non-zero within a couple of grid
 * cells of spawn, while the wobble fields need far-field samples to exercise
 * octaves the near grid never reaches. A near-only capture would let a wrong
 * `input_scale` pass, and a far-only one would never evaluate a cone at all.
 */
/**
 * The position set every Fulgora capture shares, so the fixtures line up
 * index-for-index and a field from one can be compared against a field from
 * another without re-deriving anything.
 *
 * Two scales on purpose. The starting cones are non-zero only within a couple
 * of grid cells of spawn; the wobble octaves are only exercised far out. A
 * near-only capture lets a wrong `input_scale` pass, and a far-only one never
 * evaluates a cone at all.
 *
 * **Every coordinate is a multiple of a quarter tile**, and that is load-bearing
 * rather than tidy. Factorio stores a MapPosition as 1/256-tile fixed point, so
 * a coordinate that is not a multiple of 1/256 is sampled by the game at a
 * DIFFERENT point than the port evaluates. Measured: an unsnapped ring position
 * put `fulgora_ox` - literally `x + grid/2` - out by exactly 1/256, which reads
 * as a porting bug and is not one.
 */
function fulgoraCapturePositions(): Position[] {
  const positions: Position[] = [];
  const q = (v: number): number => Math.round(v * 4) / 4;

  // Near field: a 7x7 sweep across one 175-tile grid cell, offset off the
  // integer lattice so nothing lands on a cell boundary by accident.
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      positions.push({ x: gx * 29 - 87 + 0.5, y: gy * 29 - 87 + 0.25 });
    }
  }
  // Far field: rings well past any starting cone, out to where the Voronoi
  // grid has tiled many times.
  for (const r of [400, 900, 1800, 3300, 7000, 15000]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({ x: q(r * Math.cos(a) + 0.5), y: q(r * Math.sin(a) + 0.25) });
    }
  }
  // A few odds and ends, including the exact origin.
  positions.push({ x: 0, y: 0 });
  positions.push({ x: 87.5, y: -87.5 });
  positions.push({ x: 12345.75, y: 6789.25 });
  positions.push({ x: -4321.25, y: -8765.75 });
  return positions;
}

/** Sample one named expression on a real Fulgora surface. */
async function sampleFulgora(expression: string, positions: readonly Position[], seed: number) {
  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    return await sampleExpression(expression, positions, {
      workDir,
      seed,
      spaceAge: true,
      planet: "fulgora",
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function captureFulgoraShared(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const NAMES = [
    "fulgora_grid",
    "fulgora_wobble_influence",
    "fulgora_wobble_mask",
    "fulgora_wobble_x",
    "fulgora_wobble_y",
    "fulgora_ox",
    "fulgora_oy",
    "fulgora_wx",
    "fulgora_wy",
    "fulgora_starting_cone",
    "fulgora_starting_vault_cone",
    "fulgora_starting_mask",
    "fulgora_starting_vault_mask",
  ] as const;

  const fields: Record<string, number[]> = {};
  for (const name of NAMES) {
    fields[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
      "Fulgora's shared layer (grid, wobble influence/mask/x/y, ox/oy/wx/wy, the two starting " +
      "cones and their masks), each routed onto elevation against a real Fulgora surface " +
      "(game.planets['fulgora'].create_surface()). Positions span one grid cell near spawn AND " +
      "six far-field rings, because the cones are only non-zero near spawn while the wobble " +
      "octaves are only exercised far out. Every coordinate is a multiple of a QUARTER TILE and " +
      "therefore exact in Factorio's 1/256 MapPosition grid - an earlier unsnapped capture put " +
      "fulgora_ox (literally x + grid/2) out by exactly 1/256, which reads as a porting bug and " +
      "is not one. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts fulgora-shared",
    seed0: seed,
    planet,
    positions,
    ...fields,
  };
  const out = join(FIXTURES, "oracle-fulgora-shared.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}

// Optional CLI filter: names on argv restrict which fixtures regenerate (so a new
// capture need not re-run the others). No args = capture everything.

/**
 * #269: does the game narrow `output_scale * basis_noise(...)` to f32, and is
 * narrowing the product enough on its own?
 *
 * `oracle-basis.seed123456.json` cannot answer either question, and the reason
 * is exact rather than incidental: it was captured at `output_scale = 1`.
 * `basis_noise` returns an f32, so multiplying by a POWER OF TWO is a pure
 * exponent shift and can never leave the f32 grid - narrowing that product is
 * the identity, and 0 of 200,000 sampled products differ. Any other output
 * scale can leave the grid. Measured over 90,000 samples at a fixed input
 * scale: output scales 1, 0.5, 0.25, 2, 4 and 64 change 0.00% of products,
 * while 0.6 changes 79.88%, 0.75 and 3 change 56.32%, 150 changes 97.46% and
 * 125 changes 98.38%.
 *
 * The INPUT scale is not the discriminator, which is worth stating because it
 * is the number that looks inexact: holding `output_scale = 1` and sweeping the
 * input scale over 0.125, 0.205, 0.51, 0.6, 1.5 and 0.002 changes 0.00% every
 * time. The input scale decides WHICH noise value you get, never whether the
 * product is representable.
 *
 * So this captures one control and four discriminating output scales:
 *
 * - `1` - a power of two. Every candidate model agrees here by construction, so
 *   if the control is not unanimous the harness is wrong and nothing below
 *   means anything.
 * - `0.6` - `nauvis_shared`'s own output scale.
 * - `0.51` - `cliff_fields`' low-frequency cliffiness.
 * - `0.75` - a two-bit mantissa, the mildest non-power-of-two in the tree.
 * - `125` - `mountain_plasma`'s first term, where nearly every product differs.
 *
 * `input_scale` is held at **0.125** throughout, which is exact in f32, so the
 * sample POINT is unambiguous and the only thing varying between cases is the
 * output scale. That matters: an earlier run at `input_scale = 0.205128205128`
 * had the port disagreeing with the game at 193 of 196 positions even at
 * `output_scale = 1`, where all models coincide - consistent with the game
 * holding `input_scale` at f32 as well, which is a SEPARATE question about the
 * coordinate product and is deliberately not asked here.
 */
async function captureBasisOutputScale(): Promise<void> {
  const seed = 123456;
  const seed1 = 12643;
  const inputScale = 0.125;

  // A scattered grid, deliberately off the integer lattice where basis_noise
  // returns exactly zero and every candidate model agrees for free.
  const positions: Position[] = [];
  for (let i = 0; i < 14; i++) {
    for (let j = 0; j < 14; j++) {
      positions.push({ x: -400.5 + i * 57.25, y: -400.75 + j * 57.5 });
    }
  }

  const cases: { outputScale: number; values: number[] }[] = [];
  for (const outputScale of [1, 0.6, 0.51, 0.75, 125]) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const expression =
        `basis_noise{x = x, y = y, seed0 = map_seed, seed1 = ${seed1}, ` +
        `input_scale = ${inputScale}, output_scale = ${outputScale}}`;
      const values = await sampleExpression(expression, positions, { workDir, seed });
      cases.push({ outputScale, values });
      console.log(`  captured basis-output-scale output_scale=${outputScale}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (build 87180, win64) via the test/oracle harness. The discriminating capture for #269: basis_noise routed onto elevation at a FIXED input_scale of 0.125 (exact in f32, so the sample point is unambiguous) and five output scales - 1 as the control, then 0.6, 0.51, 0.75 and 125. oracle-basis.seed123456.json cannot answer #269 because it was captured at output_scale = 1, a power of two, where narrowing the product is the identity; any non-power-of-two output scale discriminates. Captured from WSL against the Windows install, which needs FACTORIO_PATH_STYLE=windows and a TMPDIR on a Windows-visible drive. Regenerate: node --experimental-strip-types test/oracle/capture.ts basis-output-scale",
    seed0: seed,
    seed1,
    inputScale,
    positions,
    cases,
  };
  const out = join(FIXTURES, "oracle-basis-output-scale.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points, ${cases.length} output scales)`);
}

const only = process.argv.slice(2);
const want = (name: string) => only.length === 0 || only.includes(name);

/**
 * Fulgora's Voronoi layer and the island classification built on it.
 *
 * Also answers an open question from the plan that nothing else can: the
 * Voronoi primitive documents `grid_size` as a 16-bit UNSIGNED INTEGER, but
 * `fulgora_grid` is a genuine float away from the two slider endpoints (see
 * docs/noise/fulgora-elevation-NOTES.md). So does the CALL truncate it?
 *
 * At the default frequency `fulgora_grid` is exactly 175, which cannot
 * discriminate - so the probe passes a FRACTIONAL grid_size literal instead and
 * compares it against the two integers it sits between. Whichever the game
 * agrees with is the answer, and it needs no autoplace-control plumbing (which
 * `sampleExpression` has no way to apply to a planet surface anyway).
 */
async function captureFulgoraCells(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const NAMES = [
    "fulgora_cells",
    "fulgora_pyramids",
    "fulgora_spots",
    "fulgora_spots_inv",
    "fulgora_blanks",
    "fulgora_mesa",
    "fulgora_sprawl",
    "fulgora_vaults",
    "fulgora_vaults_and_starting_vault",
  ] as const;

  const fields: Record<string, number[]> = {};
  for (const name of NAMES) {
    fields[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  // The grid_size truncation probe. 155.65736389160156 is what fulgora_grid
  // really is at islands frequency 2; 155 and 156 are the integers a truncating
  // or rounding call would use. Same seeds/jitter/distance as fulgora_cells so
  // only grid_size varies.
  const FRACTIONAL_GRID = 155.65736389160156;
  const gridProbe: Record<string, number[]> = {};
  for (const [label, gridSize] of [
    ["fractional", String(FRACTIONAL_GRID)],
    ["truncated", "155"],
    ["rounded", "156"],
  ] as const) {
    gridProbe[label] = await sample(
      `voronoi_cell_id{x = fulgora_wx, y = fulgora_wy, seed0 = map_seed, ` +
        `seed1 = 'fulgora_cells', grid_size = ${gridSize}, ` +
        `distance_type = 'manhattan', jitter = 0.6}`,
    );
    console.log(`  captured grid probe: ${label} (grid_size = ${gridSize})`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
      "Fulgora's Voronoi layer (cells / pyramids / spots / spots_inv) and the island " +
      "classification built on it (blanks / mesa / sprawl / vaults / " +
      "vaults_and_starting_vault), against a real Fulgora surface. Positions are IDENTICAL to " +
      "oracle-fulgora-shared.seed123456.json, so the two fixtures line up index-for-index. " +
      "gridSizeProbe answers whether the voronoi call truncates grid_size to a u16: it samples " +
      "voronoi_cell_id at a FRACTIONAL grid_size (155.65736389160156, which is what fulgora_grid " +
      "really is at islands frequency 2) against the two integers it sits between. The default " +
      "grid of exactly 175 cannot discriminate, which is why the probe uses a literal. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts fulgora-cells",
    seed0: seed,
    planet,
    positions,
    ...fields,
    gridSizeProbe: {
      fractionalGridSize: FRACTIONAL_GRID,
      truncatedGridSize: 155,
      roundedGridSize: 156,
      ...gridProbe,
    },
  };
  const out = join(FIXTURES, "oracle-fulgora-cells.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}

/**
 * Fulgora's elevation mix chain - the 20 named expressions between the Voronoi
 * layer and `fulgora_elevation` itself.
 *
 * `fulgora_vault_pyramids_and_start` and `fulgora_pre_elevation` are captured
 * even though they are internal to the chain. They are cheap and they localise
 * a fault: without them, a transcription error in either one only ever shows up
 * blended into `moats` or `elevation`, several steps downstream of its cause.
 *
 * The `sliderRescaleProbe` is here for the same reason the cells fixture
 * carries a `gridSizeProbe`. `fulgora_natural` multiplies by
 * `slider_rescale(control:fulgora_islands:size, 2)`, and at the DEFAULT size
 * slider of 1 that is `2^0 = 1` exactly - so the 101 captured positions cannot
 * say anything about how the game evaluates the function. The probe passes
 * literal slider values instead, and deliberately includes 0.5, 2, 3, 4 and 5:
 * at s = 1 and s = 6 the exponent is exactly 0 and exactly 1, so those two rows
 * are blind by construction and would "confirm" any implementation at all.
 */
async function captureFulgoraElevation(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const NAMES = [
    // The five multioctave sources.
    "fulgora_basis",
    "fulgora_basis_oil",
    "fulgora_rock",
    "fulgora_dunes",
    "fulgora_scrap_medium",
    // The mix chain, in dependency order.
    "fulgora_natural",
    "fulgora_sprawl_pyramids",
    "fulgora_vault_pyramids",
    "fulgora_vault_pyramids_and_start",
    "fulgora_moats",
    "fulgora_mix_pyramids",
    "fulgora_mix_natural",
    "fulgora_mix_moats",
    "fulgora_vault_spots",
    "fulgora_mix_spots",
    "fulgora_oil_mask",
    "fulgora_mix_oil",
    "fulgora_sand_basins",
    "fulgora_pre_elevation",
    "fulgora_elevation",
  ] as const;

  const fields: Record<string, number[]> = {};
  for (const name of NAMES) {
    fields[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  // slider_rescale(s, 2) = 2^(log2(s)/log2(6)*log2(2)). One position is enough -
  // it does not depend on x or y - but the harness samples a list, so take the
  // first value and assert the rest agree.
  const SLIDERS = [0.5, 1, 2, 3, 4, 5, 6] as const;
  const oneProbePosition = positions.slice(0, 3);
  const sliderRescale: Record<string, number> = {};
  for (const s of SLIDERS) {
    const values = await sampleFulgora(`slider_rescale(${String(s)}, 2)`, oneProbePosition, seed);
    const first = values[0] as number;
    if (values.some((v) => v !== first)) {
      throw new Error(`slider_rescale(${String(s)}, 2) varied with position: ${values.join(", ")}`);
    }
    sliderRescale[String(s)] = first;
    console.log(`  captured slider_rescale(${String(s)}, 2) = ${String(first)}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
      "Fulgora's elevation mix chain - the five multioctave sources (basis, basis_oil, rock, " +
      "dunes, scrap_medium) and every named expression from fulgora_natural through " +
      "fulgora_elevation, against a real Fulgora surface. Positions are IDENTICAL to " +
      "oracle-fulgora-shared.seed123456.json and oracle-fulgora-cells.seed123456.json, so all " +
      "three fixtures line up index-for-index. vault_pyramids_and_start and pre_elevation are " +
      "internal to the chain and captured anyway, so a transcription error in either localises " +
      "instead of surfacing blended into elevation. sliderRescaleProbe samples " +
      "slider_rescale(s, 2) at literal slider values because the DEFAULT islands size of 1 " +
      "makes it exactly 1 - the captured positions cannot discriminate any implementation of " +
      "it. Regenerate: node --experimental-strip-types test/oracle/capture.ts fulgora-elevation",
    seed0: seed,
    planet,
    positions,
    ...fields,
    sliderRescaleProbe: sliderRescale,
  };
  const out = join(FIXTURES, "oracle-fulgora-elevation.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}

/**
 * Fulgora's road, structure and ruins layer - everything the eight land tiles
 * read that the elevation chain does not.
 *
 * Positions are `fulgoraCapturePositions()`, identical to the shared, cells and
 * elevation fixtures, so all four line up index for index.
 *
 * Two fields here are captured because the port cannot settle them by reading:
 * `fulgora_pyramids_banding` and `fulgora_spots_banding` are the noise
 * machine's `%` operator, whose behaviour on a negative left operand is not
 * stated anywhere in the docs. The OPERAND is what would settle it -
 * `fulgora_pyramids * 8` for the first, `fulgora_spots_prebanding` (captured
 * directly below) for the second - not either field's post-modulo result. At
 * these 101 positions the operand never goes negative (`fulgora_pyramids * 8`
 * minimum 0.022018, `fulgora_spots_prebanding` minimum 0.70791), so the
 * fixture does not decide the sign convention; see
 * `docs/noise/fulgora-elevation-NOTES.md`'s Task 13 for the wider-map sweep
 * that does.
 */
async function captureFulgoraRuins(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const NAMES = [
    // The masks.
    "fulgora_natural_mask",
    "fulgora_natural_and_mesa_mask",
    "fulgora_artificial_mask",
    // The road and structure layer, in dependency order.
    "fulgora_road_cells",
    "fulgora_road_pyramids",
    "fulgora_pyramids_banding",
    "fulgora_spots_prebanding",
    "fulgora_spots_banding",
    "fulgora_structure_cells",
    "fulgora_structure_subnoise",
    "fulgora_structure_facets",
    "fulgora_road_paving_thin",
    "fulgora_road_paving_2",
    "fulgora_road_paving_2b",
    "fulgora_road_paving_2c",
    "fulgora_road_dust",
    // The ruins layer.
    "fulgora_ruins_walls",
    "fulgora_ruins_paving",
    "fulgora_tile_ruin_paving",
    "fulgora_tile_ruin_walls",
    "fulgora_tile_ruin_conduit",
    "fulgora_tile_ruin_machinery",
  ] as const;

  /**
   * The four land tiles whose `probability_expression` is a COMPOSITE rather
   * than a bare named expression, keyed by the fixture field they become.
   *
   * **Copied verbatim from `tiles-fulgora.lua`** (`fulgoran-dust` line 293,
   * `-dunes` 330, `-sand` 367, `-rock` 404) - do not tidy the spacing, since
   * the point of sampling them is that the GAME parses this exact string.
   *
   * Why these four and not all eight: the other four land tiles
   * (`fulgoran-paving`, `-walls`, `-conduit`, `-machinery`) declare a bare
   * `fulgora_tile_ruin_*` name, which is already captured above as a named
   * expression. These four have no name of their own, so before this they were
   * the only Fulgora expressions in the port with no bound-checked row - the
   * argmax's winner was the only thing standing behind them, and an argmax
   * carrying a 5.5% unexplained residual cannot clear a formula. See
   * `landProbabilitiesFrom` in `src/noise/tiles/fulgoraCatalog.ts` for the
   * transcription these check.
   *
   * `sampleFulgora` registers whatever string it is given as a new
   * `noise-expression` prototype, so an arbitrary composite works exactly the
   * same way a name does - the game does the parsing and the evaluating.
   */
  const COMPOSITE_PROBABILITIES = [
    [
      "fulgoran_dust_probability",
      "fulgora_scrap_medium + max(0, fulgora_natural, 2 * fulgora_mesa * fulgora_pyramids) * 2 - 0.9 + fulgora_rock + fulgora_road_dust * fulgora_sprawl",
    ],
    ["fulgoran_dunes_probability", "1 + fulgora_dunes"],
    ["fulgoran_sand_probability", "1 - fulgora_dunes"],
    ["fulgoran_rock_probability", "0.8 + fulgora_rock * 2 - max(0, fulgora_mix_oil) * 6"],
  ] as const;

  const fields: Record<string, number[]> = {};
  for (const name of NAMES) {
    fields[name] = await sample(name);
    console.log(`  captured ${name}`);
  }
  for (const [key, expression] of COMPOSITE_PROBABILITIES) {
    fields[key] = await sample(expression);
    console.log(`  captured ${key}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
      "Fulgora's mask, road/structure and ruins layer - the 22 named expressions the eight " +
      "land tiles read that the elevation chain does not - plus the four COMPOSITE " +
      "probability_expressions (fulgoran_dust/dunes/sand/rock_probability), sampled as the " +
      "verbatim expression strings from tiles-fulgora.lua because those four tiles declare " +
      "no named expression of their own. Positions are IDENTICAL to " +
      "oracle-fulgora-shared/cells/elevation.seed123456.json, so all four line up " +
      "index-for-index. The intermediate paving stages (2, 2b, 2c) are captured as well as " +
      "the four tile_ruin outputs so a transcription error localises instead of surfacing " +
      "blended. Regenerate: node --experimental-strip-types test/oracle/capture.ts fulgora-ruins",
    seed0: seed,
    planet,
    positions,
    ...fields,
  };
  const out = join(FIXTURES, "oracle-fulgora-ruins.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}

/**
 * Scrap's `probability_expression`, sampled from the game with its
 * `local_expressions` inlined.
 *
 * Every FIELD it reads is already covered by the shared/cells/elevation/ruins
 * fixtures, so this exists to cover the one thing they cannot: the COMPOSITION,
 * including operator precedence and the two `min`s. Positions deliberately span
 * the whole range from zero to the 0.5 cap - a sample that only hit zeros would
 * pass against a stub.
 */
async function captureFulgoraScrap(): Promise<void> {
  const seed = 123456;
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const STRUCT =
    "(fulgora_structure_cells < min(0.1 * control:scrap:frequency, 0.05 + 0.05 * control:scrap:frequency))" +
    " * (1 + fulgora_structure_subnoise)" +
    " * (fulgora_elevation > (fulgora_coastline + 10))" +
    " * fulgora_artificial_mask";
  const VAULT =
    "(fulgora_spots_prebanding < (1.2 + 0.4 * slider_to_linear(control:scrap:size, -1, 1)))" +
    " * fulgora_vaults_and_starting_vault * 10";
  const EXPRS: Record<string, string> = {
    fulgora_scrap_probability: `(control:scrap:size > 0) * (1 - fulgora_starting_mask) * (min(${STRUCT} + ${VAULT}, 0.5) * (1 - fulgora_road_paving_2c))`,
    fulgora_scrap_struct_term: STRUCT,
    fulgora_scrap_vault_term: VAULT,
    scrap_control_frequency: "control:scrap:frequency",
    scrap_control_size: "control:scrap:size",
  };

  const fields: Record<string, number[]> = {};
  for (const [name, expr] of Object.entries(EXPRS)) {
    fields[name] = await sample(expr);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: the " +
      "scrap resource's probability_expression with its local_expressions inlined, plus its two " +
      "additive terms and the three control levers read back, on a real Fulgora surface " +
      "(game.planets['fulgora'].create_surface(), seed FORCED to 123456 - NOT the derived " +
      "mapSeed + crc32('fulgora')). Every FIELD the expression reads is already covered by the " +
      "shared/cells/elevation/ruins fixtures; this covers the COMPOSITION, which nothing else " +
      "does. The control rows are the non-vacuity check: a default surface must report 1 for " +
      "frequency and size, which is what the composition assumes. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts fulgora-scrap",
    seed0: seed,
    planet: "fulgora",
    positions,
    ...fields,
  };
  const out = join(FIXTURES, "oracle-fulgora-scrap.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}

/**
 * Every scrap entity the game actually places in three regions.
 *
 * This is what gates DENSITY, and it is not interchangeable with the preview
 * PNGs: `map_grid` defaults to true, so the preview draws solid ores in a
 * checkerboard of 2x2 tile blocks and shows only ~0.5 pixels per entity. A pixel
 * diff would therefore bake a 2x under-placement into the renderer. Measured on
 * these exact regions: the model's clamped expectation is 0.9836 per real
 * entity, inside Poisson noise at n = 770.
 */
async function captureFulgoraScrapEntities(): Promise<void> {
  const seed = 123456;
  const regions: Region[] = [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
    { x0: 800, y0: -1600, x1: 1056, y1: -1344 },
  ];
  const cases: unknown[] = [];
  for (const region of regions) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "fulgora",
        entityType: "resource",
        alsoResources: true,
        protoNames: ["scrap"],
      });
      cases.push({ region, resources: dump.resources, protos: dump.protos });
      console.log(
        `  [${String(region.x0)},${String(region.y0)}] -> ${String(dump.resources?.length ?? -1)} scrap`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 via test/oracle: every resource entity " +
      "(find_entities_filtered{type='resource'}) the game placed in each region on FULGORA at the " +
      "DEFAULT preset, after chunk-forced generation, on a create_surface() surface whose seed is " +
      "FORCED to `seed`. This is the DENSITY oracle and the preview PNGs cannot replace it: " +
      "ResourceEntityPrototype::map_grid defaults to true, so the game's map preview draws solid " +
      "ores in a 2x2-block checkerboard and shows about 0.5 pixels per entity. `protos` records " +
      "scrap's collision box and map_grid read off the running game. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts fulgora-scrap-entities",
    seed0: seed,
    planet: "fulgora",
    cases,
  };
  const out = join(FIXTURES, "oracle-fulgora-scrap-entities.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}

/**
 * The tile the GAME actually placed on Fulgora - `surface.get_tile(x, y).name`
 * after real chunk generation, which no `sampleExpression` can report.
 *
 * Two samples on purpose, and neither alone is enough:
 *
 * - A contiguous **256x256 block** at stride 4, centred on a coastline. This is
 *   what tests the land/ocean boundary, which is the whole point - a resolver
 *   can be right in the middle of an island and in the middle of the ocean
 *   while getting every shore wrong. The centre was chosen by asking the PORT
 *   for the 256x256 block nearest a 50/50 oil-mask split (it lands at
 *   (-1500, 1000), 0.500), so the game is being asked about the hardest terrain
 *   rather than a convenient patch. That the block really is mixed is then
 *   asserted from the GAME's own names, not from the port's choice.
 * - A **coarse 12000-tile grid** at stride 400. The block spans about 1.5
 *   Voronoi cells, so on its own it exercises only a couple of islands; the
 *   grid crosses many, and its ~74% ocean fraction is close to the map's own.
 *
 * `oil-ocean-shallow` / `-shallow-2` and `oil-ocean-deep` / `-deep-2` are pairs
 * that share a map colour, so the resolver only has to get shallow-versus-deep
 * right, not which variant of each.
 */
async function captureFulgoraTiles(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";

  const BLOCK = { x: -1500, y: 1000, half: 128, stride: 4 };
  const positions: Position[] = [];
  const seen = new Set<string>();
  const push = (x: number, y: number): void => {
    const k = `${String(x)},${String(y)}`;
    if (seen.has(k)) return;
    seen.add(k);
    // Sample the tile's own integer coordinate; `sampleTileNames` echoes the
    // floored `get_tile` input back, so the fixture records what was asked.
    positions.push({ x: x + 0.5, y: y + 0.5 });
  };
  for (let dy = -BLOCK.half; dy < BLOCK.half; dy += BLOCK.stride) {
    for (let dx = -BLOCK.half; dx < BLOCK.half; dx += BLOCK.stride) {
      push(BLOCK.x + dx, BLOCK.y + dy);
    }
  }
  const COARSE = { reach: 6000, stride: 400 };
  for (let y = -COARSE.reach; y <= COARSE.reach; y += COARSE.stride) {
    for (let x = -COARSE.reach; x <= COARSE.reach; x += COARSE.stride) {
      push(x, y);
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
  try {
    const samples: TileSample[] = await sampleTileNames(positions, {
      workDir,
      seed,
      spaceAge: true,
      planet,
    });
    const fixture = {
      _comment:
        "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
        "surface.get_tile(x, y).name on a real Fulgora surface " +
        "(game.planets['fulgora'].create_surface(), seed 123456) after real chunk generation - " +
        "the tile the game actually PLACED, which sampleExpression cannot report. Two samples: " +
        "a contiguous 256x256 block at stride 4 centred on (-1500, 1000), which the port " +
        "identified as the nearest-to-50/50 land/ocean block and which is therefore where the " +
        "coastline is; plus a coarse stride-400 grid out to +/-6000 tiles, because the block " +
        "spans only ~1.5 Voronoi cells while the grid crosses many. positions are the mod's " +
        "ECHOED floored get_tile input. Regenerate: node --experimental-strip-types " +
        "test/oracle/capture.ts fulgora-tiles",
      seed0: seed,
      planet,
      block: BLOCK,
      coarse: COARSE,
      positions: samples.map((s) => ({ x: s.x, y: s.y })),
      tileNames: samples.map((s) => s.name),
    };
    const out = join(FIXTURES, "oracle-fulgora-tiles.seed123456.json");
    await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
    const counts = new Map<string, number>();
    for (const n of fixture.tileNames) counts.set(n, (counts.get(n) ?? 0) + 1);
    console.log(
      `wrote ${out} (${String(positions.length)} points)\n  ` +
        [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}=${String(c)}`)
          .join(", "),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (want("fulgora-shared")) await captureFulgoraShared();
if (want("fulgora-cells")) await captureFulgoraCells();
if (want("fulgora-elevation")) await captureFulgoraElevation();
if (want("fulgora-ruins")) await captureFulgoraRuins();
if (want("fulgora-scrap")) await captureFulgoraScrap();
if (want("fulgora-scrap-entities")) await captureFulgoraScrapEntities();
if (want("fulgora-tiles")) await captureFulgoraTiles();

if (want("basis")) await captureBasis();
if (want("multioctave")) await captureMultioctave();
if (want("quick")) await captureQuickMultioctave();
if (want("variable-persistence")) await captureVariablePersistenceMultioctave();
if (want("multioctave-wrappers")) await captureMultioctaveWrappers();
if (want("elevation-lakes")) await captureElevationLakes();
if (want("elevation-nauvis")) await captureElevationNauvis();
if (want("elevation-nauvis-no-cliff")) await captureElevationNauvisNoCliff();
if (want("elevation-island")) await captureElevationIsland();
if (want("temperature")) await captureTemperature();
if (want("aux")) await captureAux();
if (want("moisture")) await captureMoisture();
if (want("expression-in-range")) await captureExpressionInRange();
if (want("fastpow")) await captureFastPow();
if (want("random-penalty")) await captureRandomPenalty();
if (want("resource-regular")) await captureResourceRegular();
if (want("resource-starting")) await captureResourceStarting();
if (want("tile-names")) await captureTileNames();
if (want("enemy-base")) await captureEnemyBase();
if (want("trees")) await captureTrees();
if (want("trees-controls")) await captureTreesControls();
if (want("cliff-elevation")) await captureCliffElevation();
if (want("cliffiness")) await captureCliffiness();
if (want("cliff-offset-raw")) await captureCliffOffsetRaw();
/**
 * Every ACTUAL Vulcanus cliff entity in three regions - the entity-level ground
 * truth Vulcanus cliffs have never had (issue #18). Nauvis's equivalent
 * (`captureCliffEntities`) validates that port at ~94% tile-for-tile; Vulcanus
 * had only "the noise field matches to 5e-6 and the geometry is the same code",
 * which is an argument rather than a measurement.
 *
 * Regions are the three windows the mark-size work already measured coverage
 * over, so the fixture can settle whether that 34% window is a real cliff field
 * or a painting artefact:
 *
 * | region | measured cliff-pixel coverage at 1 tile/px |
 * | --- | --- |
 * | `[0,0]` | 10.3% |
 * | `[1500,1500]` | 34.2% |
 * | `[-1200,800]` | 11.1% |
 *
 * They are 256x256 rather than the Nauvis capture's 512x512 because the dense
 * one holds several thousand cliffs and chunk generation cost scales with area.
 *
 * Runs on Vulcanus's own surface with the seed FORCED (`spaceAge: true`), which
 * is what every committed Vulcanus fixture does - see `entityCounts.ts`'s header
 * for why that matters and what it commits the comparing spec to.
 */
async function captureVulcanusCliffEntities(): Promise<void> {
  const regions: Region[] = [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
  ];
  const seed = 123456;
  const cases: { region: Region; cliffs: Position[] }[] = [];
  for (const region of regions) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const cliffs = await sampleCliffEntities(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
      });
      cases.push({ region, cliffs });
      console.log(
        `  captured vulcanus cliffs [${String(region.x0)},${String(region.y0)}] (${String(cliffs.length)} cliffs)`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Every cliff entity " +
      "(find_entities_filtered{type='cliff'}) the game placed in each region on VULCANUS at the " +
      "DEFAULT preset, after chunk-forced generation. Positions are cliff cell centers on the " +
      "4-tile grid, and each entry carries the entity's `orientation` " +
      "(LuaEntity.cliff_orientation), added 2026-07-30 - it makes this a direct end-to-end " +
      "oracle for CLIFF_CODE_TO_ORIENTATION (see test/cliffOrientationOracle.spec.ts) and gives " +
      "the true collision box for cliffs the port does NOT place, which is otherwise " +
      "unobtainable. The re-capture reproduced the 2026-07-28 positions exactly. Sampled on a " +
      "create_surface() surface whose seed is FORCED to `seed` (like " +
      "every other Vulcanus oracle fixture), not the derived mapSeed + crc32('vulcanus') - so a " +
      "comparing spec builds its ctx from `seed` directly. Compared against " +
      "makeVulcanusCliffFields + makeCliffPlacementFromFields in " +
      "test/vulcanusCliffEntities.spec.ts. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-entities",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-entities.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}

/**
 * **The `cliff_smoothing` sweep** - the same Vulcanus region captured at several
 * values of `map_gen_settings.cliff_settings.cliff_smoothing` (issue #18).
 *
 * Every other cliff fixture samples the one setting the planet ships with, so
 * the smoothing transform could only ever be tested as a whole. Overriding it
 * turns one data point into a family, and the decisive member is **`s = 0`**:
 * with smoothing off, the cliff elevation IS the raw field, which is measured
 * accurate to a max of 4.8e-2, over a rule that reproduces Nauvis 334/334. So
 * the port must match the game exactly at `s = 0`. If it does, the entire
 * residual is inside the smoothing and the disassembly is the only thing left to
 * read. **If it does NOT, the smoothing is innocent** and 2026-08-01's whole
 * sweep - knots, clamp, anchor, blend, interpolation family - was searching the
 * wrong transform.
 *
 * `[0,0]` is the region deliberately chosen: it is where the port is worst
 * (29.8% wrong orientation against 8.1% and 11.7% elsewhere), so it has the most
 * signal, and it contains zero `crater-cliff`s to exclude.
 *
 * Each case records the `cliffSettings` the surface reported back. That is not
 * bookkeeping: without it, an override that silently failed to apply would look
 * exactly like a setting that does not matter.
 */
async function captureVulcanusCliffSmoothing(): Promise<void> {
  const region: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const seed = 123456;
  const cases: {
    cliffSmoothing: number;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const cliffSmoothing of [0, 0.5, 1]) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: { cliff_smoothing: cliffSmoothing },
      });
      cases.push({ cliffSmoothing, effective: dump.cliffSettings, cliffs: dump.cliffs });
      console.log(
        `  captured vulcanus cliffs smoothing=${String(cliffSmoothing)} ` +
          `(effective ${String(dump.cliffSettings?.cliff_smoothing)}, ${String(dump.cliffs.length)} cliffs)`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Every cliff entity the game placed in " +
      "the Vulcanus region [0,0]-[256,256] at THREE values of " +
      "map_gen_settings.cliff_settings.cliff_smoothing (0, 0.5, 1), with each entity's " +
      "cliff_orientation. Exists for issue #18: every other cliff fixture samples only the " +
      "setting the planet ships with (the prototype default of 1), so the smoothing transform " +
      "could be tested only as a whole. The s=0 case is the discriminating one - with smoothing " +
      "off the cliff elevation is the raw field, which agrees with ours to a max of 4.8e-2 over " +
      "a rule that reproduces Nauvis 334/334, so the port must match the game exactly there. " +
      "`effective` is the cliff_settings the SURFACE reported back after the override, not what " +
      "was written, so an override that failed to apply cannot be mistaken for a setting that " +
      "does not matter. Sampled on a create_surface() surface whose seed is FORCED to `seed`, " +
      "like every other Vulcanus oracle fixture. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-smoothing",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-smoothing.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} smoothing values)`);
}

/**
 * **The cliff rule COLLAPSED, one term at a time** (issue #18).
 *
 * `cliff_settings` holds every constant the placement rule uses, and all of them
 * are settable on the surface - so instead of modelling a term and arguing about
 * it, the term can simply be turned OFF in the game:
 *
 * - `cliff_smoothing = 0` removes the smoothing, leaving the RAW elevation.
 * - `cliff_elevation_interval` set huge leaves a **single contour** at
 *   `cliff_elevation_0`, so there is no band arithmetic left to be wrong about.
 * - `richness = 4` makes `cliffiness_basic`'s `0.5*log2(4) = 1`, so
 *   `clamp(1 + noise, 0, 1) + 0.5` saturates at 1.5 and the `> 0.5` gate is open
 *   essentially everywhere.
 *
 * With all three the rule reduces to **"an edge crosses iff elevation crosses
 * 70"**, which turns the game's own cliffs into a direct readout of
 * `sign(elevation - 70)` at the generator's own sample points. Our raw elevation
 * is known to agree with the game's to a max of 4.8e-2, so any disagreement at a
 * corner further than that from 70 is proof the generator is not reading the
 * field we think it is - which is the "how does the engine store or round it"
 * question, asked as an experiment rather than a disassembly.
 *
 * The arms are cumulative on purpose, so whichever one first fails to reproduce
 * the game names the term that is wrong.
 */
async function captureVulcanusCliffCollapsed(): Promise<void> {
  const region: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const seed = 123456;
  // A single contour: no Vulcanus corner reaches 70 + 1e6.
  const ONE_BAND = 1000000;
  const arms: { label: string; cliffSettings: Record<string, number> }[] = [
    {
      label: "raw elevation, bands, gate (smoothing off only)",
      cliffSettings: { cliff_smoothing: 0 },
    },
    {
      label: "raw elevation, SINGLE contour at 70, gate",
      cliffSettings: { cliff_smoothing: 0, cliff_elevation_interval: ONE_BAND },
    },
    {
      label: "raw elevation, SINGLE contour at 70, NO gate (richness 4)",
      cliffSettings: { cliff_smoothing: 0, cliff_elevation_interval: ONE_BAND, richness: 4 },
    },
    {
      label: "raw elevation, bands, NO gate (richness 4)",
      cliffSettings: { cliff_smoothing: 0, richness: 4 },
    },
  ];
  const cases: {
    label: string;
    settings: Record<string, number>;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: arm.cliffSettings,
      });
      cases.push({
        label: arm.label,
        settings: arm.cliffSettings,
        effective: dump.cliffSettings,
        cliffs: dump.cliffs,
      });
      console.log(
        `  captured ${arm.label} -> ${String(dump.cliffs.length)} cliffs ` +
          `(effective interval=${String(dump.cliffSettings?.cliff_elevation_interval)} ` +
          `richness=${String(dump.cliffSettings?.richness)} ` +
          `smoothing=${String(dump.cliffSettings?.cliff_smoothing)})`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  // THE CONTROL. The same collapse on Nauvis, whose cliff_elevation
  // (`cliff_elevation_nauvis`) contains no `multisample` and which the port
  // already reproduces 334/334. If Nauvis stays exact under the collapsed rule
  // while Vulcanus does not, the rule and the lattice are cleared and the
  // difference is the elevation FIELD, not the placement.
  const nauvisRegion: Region = { x0: 512, y0: 512, x1: 1024, y1: 1024 };
  const nauvisCases: {
    label: string;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  // NB `richness` is deliberately NOT raised here, unlike the Vulcanus arms.
  // It acts in the OPPOSITE direction on Nauvis: `cliffiness_nauvis` is
  // `(main_cliffiness >= cliff_cutoff) * 10` with the cutoff derived from
  // richness, so richness = 4 raises the cutoff until nothing qualifies and the
  // region comes back with ZERO cliffs (measured). Only the interval is
  // collapsed on this arm.
  // A single contour at Nauvis's own `cliff_elevation_0` of 10 is NOT a usable
  // arm: it comes back with zero cliffs (measured), because Nauvis's cliffs sit
  // on the higher bands and almost nothing crosses 10. The arms below instead
  // change the interval to a value that still populates the region, which is
  // what the control actually needs - does our rule track the game's when a
  // cliff SETTING moves? - and a single contour placed where the field lives.
  const nauvisArms: { label: string; cliffSettings?: Record<string, number> }[] = [
    { label: "nauvis baseline (no override)" },
    { label: "nauvis interval 80", cliffSettings: { cliff_elevation_interval: 80 } },
    {
      label: "nauvis SINGLE contour at 50",
      cliffSettings: { cliff_elevation_0: 50, cliff_elevation_interval: ONE_BAND },
    },
  ];
  for (const arm of nauvisArms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(nauvisRegion, {
        workDir,
        seed,
        cliffSettings: arm.cliffSettings,
      });
      nauvisCases.push({ label: arm.label, effective: dump.cliffSettings, cliffs: dump.cliffs });
      console.log(
        `  captured ${arm.label} -> ${String(dump.cliffs.length)} cliffs ` +
          `(effective interval=${String(dump.cliffSettings?.cliff_elevation_interval)} ` +
          `richness=${String(dump.cliffSettings?.richness)})`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    nauvisRegion,
    nauvisCases,
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. The Vulcanus region [0,0]-[256,256] with " +
      "the cliff placement rule COLLAPSED one term at a time through map_gen_settings.cliff_settings " +
      "(issue #18). cliff_smoothing=0 leaves the raw elevation; cliff_elevation_interval=1e6 leaves a " +
      "SINGLE contour at cliff_elevation_0=70, so no band arithmetic remains; richness=4 makes " +
      "cliffiness_basic's 0.5*log2(4)=1 so it saturates at 1.5 and its >0.5 gate is always open. With " +
      "all three the rule is just 'an edge crosses iff elevation crosses 70', making the game's cliffs " +
      "a direct readout of sign(elevation - 70) at the generator's own sample points. `effective` is " +
      "the cliff_settings the SURFACE reported back, so an override that failed to apply cannot be " +
      "mistaken for a term that does not matter. Arms are cumulative so the first one that stops " +
      "reproducing the game names the wrong term. Sampled on a create_surface() surface whose seed is " +
      "FORCED to `seed`, like every other Vulcanus oracle fixture. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts vulcanus-cliff-collapsed",
    seed,
    region,
    cliffElevation0: 70,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-collapsed.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **A level-set sweep that INVERTS the generator's own elevation field** (#18).
 *
 * With the rule collapsed (`cliff_smoothing = 0`, a single contour via
 * `cliff_elevation_interval = 1e6`, the cliffiness gate held open by
 * `richness = 4`), a cell carries a cliff exactly when its corner elevations
 * **straddle** `cliff_elevation_0`. Sweeping that threshold therefore brackets
 * every cell: the set of levels at which a cell is "mixed" is
 * `(min of its corners, max of its corners]`, to the resolution of the step.
 *
 * That converts the game's cliffs into a **measurement of the elevation field
 * the generator actually reads**, which is the one thing no expression sample
 * can give - `calculate_tile_properties` answers for its own channel, and the
 * open question is precisely whether the generator's channel agrees.
 *
 * The quantity to compare is the per-cell corner SPREAD (`max - min`), because
 * that is what the collapsed arm's over-placement implicates: we place 463
 * cliffs where the game places 335, so our 70-contour is ~38% longer, i.e. our
 * field is rougher at the 4-tile scale. If our spreads come out systematically
 * wider than the game's, that is the roughness difference quantified rather
 * than inferred, and it bounds how much smoothing the generator applies.
 *
 * Step 10 over `[20, 200]` is chosen against the field itself: adjacent corners
 * (4 tiles apart) differ by tens of units, so a step of 10 resolves a spread
 * difference well below the effect being measured, and 19 levels keeps the
 * capture near ten minutes.
 */
async function captureVulcanusElevationLevels(): Promise<void> {
  const region: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const seed = 123456;
  const ONE_BAND = 1000000;
  const levels: number[] = [];
  for (let e0 = 20; e0 <= 200; e0 += 10) levels.push(e0);

  const cases: {
    elevation0: number;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const elevation0 of levels) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: {
          cliff_smoothing: 0,
          cliff_elevation_interval: ONE_BAND,
          cliff_elevation_0: elevation0,
          richness: 4,
        },
      });
      cases.push({ elevation0, effective: dump.cliffSettings, cliffs: dump.cliffs });
      console.log(
        `  level ${String(elevation0)} -> ${String(dump.cliffs.length)} cliffs ` +
          `(effective e0=${String(dump.cliffSettings?.cliff_elevation_0)})`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. The Vulcanus region [0,0]-[256,256] " +
      "captured at 19 values of cliff_elevation_0 (20..200 step 10) with the placement rule " +
      "COLLAPSED: cliff_smoothing=0 (raw elevation), cliff_elevation_interval=1e6 (a single " +
      "contour at cliff_elevation_0, no band arithmetic) and richness=4 (cliffiness_basic " +
      "saturates at 1.5 so its >0.5 gate is always open). Under those settings a cell carries a " +
      "cliff exactly when its corner elevations STRADDLE cliff_elevation_0, so the set of levels " +
      "at which a cell appears brackets (min corner, max corner] - i.e. this fixture INVERTS the " +
      "elevation field the generator itself reads, which no expression sample can do because " +
      "calculate_tile_properties answers for a different channel. Exists to measure the per-cell " +
      "corner spread against ours: the collapsed arm shows we place 463 cliffs where the game " +
      "places 335, implying our field is rougher at the 4-tile scale. `effective` is the " +
      "cliff_settings the SURFACE reported back. Sampled on a create_surface() surface whose seed " +
      "is FORCED to `seed`. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-elevation-levels",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-elevation-levels.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} levels)`);
}

/**
 * **Is `multisample` grid-dependent? Asked through the CLIFF GENERATOR** (#18).
 *
 * The level-set sweep narrowed the Vulcanus residual to
 * `120 * vulcanus_basalt_lakes_multisample` - the only `multisample` in the
 * elevation chain, and the only term with no Nauvis counterpart. The primitive's
 * own documentation says it evaluates "in a separate noise program with a larger
 * grid" whose "sub-grids are copied to the main program", i.e. it is explicitly
 * grid-dependent; and `vulcanus-multisample-NOTES.md` established
 * `multisample(e, dx, dy) == e(x + dx, y + dy)` at 150/150 - but measured it
 * only through `calculate_tile_properties`, which is not the channel the cliff
 * generator uses.
 *
 * This asks the primitive the same question through the OTHER channel. Routing
 * a probe onto `cliff_elevation` and collapsing the rule (single contour,
 * smoothing off, gate open) makes the cliff generator a readout: cliffs appear
 * exactly where the routed field crosses `cliff_elevation_0`.
 *
 * With `x` as the field the contour is a vertical line, so the cliffs land in
 * one column of cells - trivially readable, and a shift in the field moves the
 * column. Corners sit 4 tiles apart, so the arms are chosen to make a real shift
 * land a whole column away:
 *
 * - **A `x`** - the baseline, no multisample at all.
 * - **B `multisample(x, 0, 0)`** - must equal A if multisample is the identity
 *   at zero offset in this channel. **If B differs from A, the primitive IS
 *   grid-dependent and that is issue #18.**
 * - **C `multisample(x, 4, 0)`** - the POSITIVE control. A 4-tile shift must
 *   move the column by exactly one cell; if it does not, the experiment cannot
 *   detect a difference and B == A would mean nothing.
 * - **D `multisample(x, 0, 4)`** - the NULL control. Shifting y cannot move a
 *   vertical contour, so D must equal A. Catches an axis mix-up.
 *
 * `cliff_elevation_0 = 71` deliberately avoids a corner landing exactly on the
 * contour, where `crossesCliff`'s strict comparison would drop the crossing.
 */
async function captureMultisampleGrid(): Promise<void> {
  const region: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const seed = 123456;
  const arms: { label: string; expression: string }[] = [
    { label: "A x (baseline, no multisample)", expression: "x" },
    { label: "B multisample(x, 0, 0)", expression: "multisample(x, 0, 0)" },
    { label: "C multisample(x, 4, 0) - positive control", expression: "multisample(x, 4, 0)" },
    { label: "D multisample(x, 0, 4) - null control", expression: "multisample(x, 0, 4)" },
  ];
  const cases: {
    label: string;
    expression: string;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        probeExpression: arm.expression,
        cliffSettings: {
          cliff_smoothing: 0,
          cliff_elevation_interval: 1000000,
          cliff_elevation_0: 71,
          richness: 4,
        },
      });
      const columns = [...new Set(dump.cliffs.map((c) => c.x))].sort((a, b) => a - b);
      cases.push({
        label: arm.label,
        expression: arm.expression,
        effective: dump.cliffSettings,
        cliffs: dump.cliffs,
      });
      console.log(
        `  ${arm.label} -> ${String(dump.cliffs.length)} cliffs, columns x=${columns.join(",")}`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Asks whether `multisample` is " +
      "grid-dependent by reading it through the CLIFF GENERATOR instead of " +
      "calculate_tile_properties (issue #18). A probe expression is routed onto " +
      "property_expression_names.cliff_elevation on a Vulcanus surface with the placement rule " +
      "collapsed (cliff_smoothing=0, cliff_elevation_interval=1e6, cliff_elevation_0=71, " +
      "richness=4), so cliffs appear exactly where the routed field crosses 71. With `x` as the " +
      "field that contour is vertical and the cliffs land in a single column of cells, so a shift " +
      "in the field moves the column. Arms: A `x` baseline; B `multisample(x,0,0)` which must " +
      "equal A unless the primitive is grid-dependent; C `multisample(x,4,0)` the POSITIVE " +
      "control, which must move the column one cell (4 tiles = one corner spacing) or the " +
      "experiment could not detect a difference at all; D `multisample(x,0,4)` the NULL control, " +
      "which cannot move a vertical contour. e0=71 avoids a corner landing exactly on the " +
      "contour, where crossesCliff's strict comparison drops the crossing. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts multisample-grid",
    seed,
    region,
    cliffElevation0: 71,
    cases,
  };
  const out = join(FIXTURES, "oracle-multisample-grid.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * Every ACTUAL Vulcanus RESOURCE entity in the same three regions
 * `captureVulcanusCliffEntities` covers, so the two dumps can be compared
 * directly (issue #24).
 *
 * The question this exists to answer: **the game essentially never puts a cliff
 * on ore** - 8 of 3933 resource entities in `[1500,1500]`, 0.20%, against a
 * ~21.6% independence baseline from the game's own cliff coverage, i.e. about
 * 100x below chance. Something separates them, and it is NOT a collision mask
 * (the cliff mask and the `resource` layer share nothing). Without the game's
 * resource POSITIONS there was no way to tell a terrain anti-correlation from
 * an explicit removal pass, because our own ore placement sits between the two
 * and could be producing the effect by itself.
 *
 * With this fixture the discriminating measurement is one join: for each
 * resource name, what fraction of the GAME's entities of that name fall inside
 * the GAME's cliff cells, versus the same fraction computed from OUR fields. If
 * the game's own rate is ~0 for every resource while ours is not, we are
 * missing an exclusion. If the game's rate varies by resource the way a biome
 * dependency would, it is terrain and #24 belongs to #18.
 *
 * Reuses the cliff probe unchanged - it already takes an `entityType` and dumps
 * `{x, y, name}` per entity - so `type = "resource"` needs no oracle change.
 * Same forced-seed Vulcanus surface as every other Vulcanus fixture.
 */
async function captureVulcanusResourceEntities(): Promise<void> {
  const regions: Region[] = [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
  ];
  const seed = 123456;
  const cases: { region: Region; resources: Position[] }[] = [];
  for (const region of regions) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const resources = await sampleCliffEntities(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        entityType: "resource",
      });
      cases.push({ region, resources });
      const names = new Map<string, number>();
      for (const r of resources) {
        const n = (r as { name?: string }).name ?? "?";
        names.set(n, (names.get(n) ?? 0) + 1);
      }
      console.log(
        `  captured vulcanus resources [${String(region.x0)},${String(region.y0)}] ` +
          `(${String(resources.length)}: ${[...names].map(([n, c]) => `${n}=${String(c)}`).join(", ")})`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Every resource entity " +
      "(find_entities_filtered{type='resource'}) the game placed in each region on VULCANUS at the " +
      "DEFAULT preset, after chunk-forced generation. Regions match " +
      "oracle-vulcanus-cliff-entities.seed123456.json exactly so the two can be joined. Sampled on " +
      "a create_surface() surface whose seed is FORCED to `seed` (like every other Vulcanus oracle " +
      "fixture), not the derived mapSeed + crc32('vulcanus'). Exists to settle issue #24: whether " +
      "the game's ~100x-below-chance cliff/ore separation is a terrain anti-correlation or an " +
      "explicit exclusion. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-resource-entities",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-resource-entities.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}

/**
 * Six MORE 256x256 Vulcanus regions of cliff + resource entities, for the one
 * question the original three could not answer: **does the ore/cliff separation
 * replicate?**
 *
 * Issue #24 rests entirely on `[1500,1500]`, and its "~100x below chance" figure
 * uses a **tile-independence** baseline (`ore tiles x cliff coverage / area`).
 * That baseline is invalid here: the ore in `[0,0]` and `[-1200,800]` is a
 * grand total of TWO connected blobs, so those regions have ~1 independent trial
 * and a shift-null puts their "0 overlap" at P = 0.51 and 0.29 - i.e. no signal
 * at all. Eight extra regions turn one draw into a sample.
 *
 * Region choice is deliberately arbitrary (scattered angles and radii, 700 to
 * 3800 tiles out) and was fixed BEFORE any of them was measured, so it cannot
 * have been steered toward a result. Two of the eight (`[2900,400]`,
 * `[-3200,-2000]`) turned out to hold no resource entities at all; they are kept
 * in the fixture rather than dropped, because dropping the empty draws is
 * exactly how a selection effect gets in.
 *
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-ore-cliff-replication  (~6 min: two headless runs per region, and
 * chunk generation is the cost).
 */
async function captureVulcanusOreCliffReplication(): Promise<void> {
  const S = 256;
  const regions: Region[] = [
    { x0: 700, y0: -1800 },
    { x0: -2400, y0: -600 },
    { x0: 1100, y0: 2600 },
    { x0: -900, y0: -2500 },
    { x0: 2900, y0: 400 },
    { x0: -1700, y0: 1900 },
    { x0: 300, y0: 3400 },
    { x0: -3200, y0: -2000 },
  ].map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x0 + S, y1: r.y0 + S }));
  const seed = 123456;
  const cases: { region: Region; cliffs: Position[]; resources: Position[] }[] = [];
  for (const region of regions) {
    const grab = async (entityType?: string): Promise<Position[]> => {
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const got = await sampleCliffEntities(region, {
          workDir,
          seed,
          spaceAge: true,
          planet: "vulcanus",
          ...(entityType === undefined ? {} : { entityType }),
        });
        // An empty Lua table serialises as `{}`, not `[]` - normalise, or a
        // region with no resources lands in the fixture as an object and every
        // consumer has to know that.
        return Array.isArray(got) ? got : [];
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    };
    const cliffs = await grab();
    const resources = await grab("resource");
    cases.push({ region, cliffs, resources });
    console.log(
      `  [${String(region.x0)},${String(region.y0)}] cliffs=${String(cliffs.length)} resources=${String(resources.length)}`,
    );
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Cliff AND resource entities over SIX " +
      "MORE 256x256 Vulcanus regions than oracle-vulcanus-{cliff,resource}-entities covers, at the " +
      "DEFAULT preset, after chunk-forced generation. Exists to test whether issue #24's ore/cliff " +
      "separation REPLICATES - the issue rests on one region, and its tile-independence chance " +
      "baseline is invalid for fields that come in a handful of blobs. Region list was fixed before " +
      "any region was measured; the two regions that turned out to hold no resources are kept, not " +
      "dropped. Same forced-seed Vulcanus surface as every other Vulcanus fixture (create_surface() " +
      "with the seed FORCED to `seed`, not mapSeed + crc32('vulcanus')). Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts vulcanus-ore-cliff-replication",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-ore-cliff-replication.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}

/**
 * The GAME's own values for the two fields Vulcanus cliff placement reads, at
 * exactly the lattice points the placement pass samples, over the three
 * calcite-dominated regions.
 *
 * Why this fixture exists rather than another whole-field comparison: it lets a
 * CI-safe spec run **our placement rule on the game's own inputs**, which
 * separates a field error from a rule error. That distinction had never been
 * measured for Vulcanus cliffs - #18 has been treated throughout as a field
 * accuracy problem - and the answer is that substituting these values for ours
 * does not move a single cell of 3481 per region.
 *
 * The lattice: BOTH fields at every corner `(i*4, j*4 + 0.5)` of every region.
 * `cliffiness` is genuinely read at every corner. `cliff_elevation` at
 * `cliff_smoothing = 1` is only ever read at the SMOOTHING KNOTS
 * (`smoothingKnots`, in-chunk corner indices 0/4/7) - the unsmoothed term
 * vanishes exactly at s = 1 - so ~5/6 of the elevation samples here are
 * redundant for the CURRENT model. They are captured anyway on purpose: the
 * smoothing model is itself a live suspect for #18's residual, and a fixture
 * that only holds the knots can never test an alternative to it.
 *
 * Regenerate: node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-corner-fields
 */
async function captureVulcanusCliffCornerFields(): Promise<void> {
  const seed = 123456;
  const G = 4;
  const regions: Region[] = [
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: 1100, y0: 2600, x1: 1356, y1: 2856 },
    { x0: -1700, y0: 1900, x1: -1444, y1: 2156 },
  ];
  const key = (a: number, b: number): string => `${String(a)},${String(b)}`;
  const cornerSet = new Set<string>();
  for (const r of regions) {
    const n = (r.x1 - r.x0) / G;
    for (let j = r.y0 / G; j <= r.y0 / G + n; j++)
      for (let i = r.x0 / G; i <= r.x0 / G + n; i++) cornerSet.add(key(i, j));
  }
  const corners = [...cornerSet];
  const toPos = (list: string[]): Position[] =>
    list.map((k) => {
      const [i, j] = k.split(",").map(Number);
      return { x: i * G, y: j * G };
    });

  const sample = async (expression: string, list: string[]): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, toPos(list), {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
  const elevation = await sample("vulcanus_elevation", corners);
  console.log(`  captured vulcanus_elevation at ${String(corners.length)} corners`);
  const cliffiness = await sample("cliffiness_basic", corners);
  console.log(`  captured cliffiness_basic at ${String(corners.length)} corners`);

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age) via test/oracle. The two fields Vulcanus cliff " +
      "placement reads, sampled at the GAME's lattice - the bare (i*4, j*4), no grid_offset - " +
      "over three calcite-dominated 256x256 regions. The prototype's grid_offset {0,0.5} is a " +
      "CENTRE offset (entity-util.lua:305) and crossingsForChunk never reads it; sampling at " +
      "j*4+0.5, as this fixture did before 2026-07-30, costs ~7 points of recall while moving no " +
      "cliff. The superseded capture is kept as oracle-vulcanus-cliff-corner-fields-legacy-y0.5. " +
      "Both fields are sampled at EVERY corner of each region (65x65 per region). An earlier " +
      "version of this comment said vulcanus_elevation was captured only at the cliff_smoothing=1 " +
      "knots; that was never what the code did - the corner set is built from a full nested loop " +
      "over each region and both samples take all of it, which the count confirms (3 x 65 x 65 = " +
      "12675). Corrected 2026-07-30. Exists to separate a FIELD " +
      "error from a RULE error in the Vulcanus cliff port (#18) and in the ore/cliff separation " +
      "(#24): a spec can run makeCliffPlacementFromFields on these values instead of ours. Forced " +
      "surface seed like every other Vulcanus fixture. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts vulcanus-cliff-corner-fields",
    seed,
    planet: "vulcanus",
    grid: G,
    cornerOffsetY: 0,
    regions,
    corners,
    elevation,
    cliffiness,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-corner-fields.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(corners.length)} corners, ${String(regions.length)} regions)`,
  );
}

/**
 * The same two cliff fields, at the three regions
 * `oracle-vulcanus-cliff-entities` covers - which is **not** what
 * {@link captureVulcanusCliffCornerFields} covers.
 *
 * That fixture's regions (`[1500,1500]`, `[1100,2600]`, `[-1700,1900]`) were
 * chosen for issue #24 and are all calcite-dominated. The consequence went
 * unnoticed until the orientation oracle landed (2026-07-30): "substituting the
 * game's own fields moves nothing" had been measured **only where the port is
 * already good**. Scored on orientation, `[1500,1500]` is wrong on 8.1% of
 * shared cells - while `[0,0]`, which no field capture touched at all, is wrong
 * on **29.8%**. A field error there would have been invisible to every
 * substitution run so far.
 *
 * `[1500,1500]` is deliberately kept in both fixtures. It is the only region
 * they share, so re-sampling it here is a free cross-check: the two captures
 * must agree corner for corner, and `test/vulcanusCliffCornerFields.spec.ts`
 * asserts they do. Without that, a mistake in this capture's corner indexing
 * would look exactly like a field error at `[0,0]`.
 *
 * A separate fixture rather than more regions on the existing one, because
 * `test/vulcanusOreCliffSeparation.spec.ts` indexes that one by region and its
 * #24 conclusions are stated per region.
 */
async function captureVulcanusCliffCornerFieldsAtEntityRegions(): Promise<void> {
  const seed = 123456;
  const G = 4;
  // Exactly the regions of oracle-vulcanus-cliff-entities.seed123456.json.
  const regions: Region[] = [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
  ];
  const key = (a: number, b: number): string => `${String(a)},${String(b)}`;
  const cornerSet = new Set<string>();
  for (const r of regions) {
    const n = (r.x1 - r.x0) / G;
    for (let j = r.y0 / G; j <= r.y0 / G + n; j++)
      for (let i = r.x0 / G; i <= r.x0 / G + n; i++) cornerSet.add(key(i, j));
  }
  const corners = [...cornerSet];
  const toPos = (list: string[]): Position[] =>
    list.map((k) => {
      const [i, j] = k.split(",").map(Number);
      return { x: i * G, y: j * G };
    });

  const sample = async (expression: string, list: string[]): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, toPos(list), {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
  const elevation = await sample("vulcanus_elevation", corners);
  console.log(`  captured vulcanus_elevation at ${String(corners.length)} corners`);
  const cliffiness = await sample("cliffiness_basic", corners);
  console.log(`  captured cliffiness_basic at ${String(corners.length)} corners`);

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age) via test/oracle. The two fields Vulcanus " +
      "cliff placement reads (vulcanus_elevation, cliffiness_basic), sampled at the GAME's " +
      "lattice - the bare (i*4, j*4), no grid_offset - at every corner of the THREE REGIONS " +
      "oracle-vulcanus-cliff-entities.seed123456.json covers. Companion to " +
      "oracle-vulcanus-cliff-corner-fields.seed123456.json, whose regions were chosen for issue " +
      "#24 and are all calcite-dominated: the field substitution that cleared the port's fields " +
      "had therefore only ever run where the port is already good (8.1% orientation error at " +
      "[1500,1500]) and never at [0,0], which is wrong on 29.8% of shared cells. [1500,1500] is " +
      "present in BOTH fixtures on purpose - the overlap is a cross-check that this capture's " +
      "corner indexing is right, asserted in test/vulcanusCliffCornerFields.spec.ts. Forced " +
      "surface seed like every other Vulcanus fixture. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-corner-fields-entity-regions",
    seed,
    planet: "vulcanus",
    grid: G,
    cornerOffsetY: 0,
    regions,
    corners,
    elevation,
    cliffiness,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-corner-fields-entity-regions.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(corners.length)} corners, ${String(regions.length)} regions)`,
  );
}

/**
 * **`cliff_smoothing = 0` at the OTHER two entity regions** (#84).
 *
 * `captureVulcanusCliffSmoothing` above asks this question at `[0,0]` only, and
 * `oracle-vulcanus-cliff-collapsed`'s first arm answers it there at the real
 * bands. The answer at `[0,0]` is that the port is EXACT with smoothing off -
 * which reads like "the whole residual is the smoothing" until the same arm is
 * run at the other two regions, and it is not: `[-1200,800]` is also exact, and
 * `[1500,1500]` still carries 21 wrong orientations. **The residual is two
 * different defects, and one region-worth of evidence could not tell them
 * apart.** That is why this capture covers all three rather than the worst one.
 *
 * Case 0 overrides NOTHING and exists to read `cliff_settings` back off the
 * planet's own surface. `VULCANUS_CLIFF_SMOOTHING = 1` had until now been
 * inferred from the `CliffPlacementSettings` prototype default (issue #28) and
 * never once read out of a running game; the value is load-bearing enough that
 * an inference is not good enough, and the same class of assumption is what #28
 * itself was.
 */
async function captureVulcanusCliffSmoothingOffRegions(): Promise<void> {
  const seed = 123456;
  const regions: Region[] = [
    { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
  ];
  const cases: {
    label: string;
    effective: DumpedCliffSettings | undefined;
    region: Region;
    cliffs: Position[];
  }[] = [];

  {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(regions[0], {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
      });
      cases.push({
        label: "planet defaults (nothing overridden)",
        effective: dump.cliffSettings,
        region: regions[0],
        cliffs: dump.cliffs,
      });
      console.log(`  defaults reported back: ${JSON.stringify(dump.cliffSettings)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  for (const region of regions) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: {
          cliff_smoothing: 0,
          cliff_elevation_interval: 120,
          cliff_elevation_0: 70,
          richness: 1,
        },
      });
      cases.push({
        label: `smoothing=0 at [${String(region.x0)},${String(region.y0)}]`,
        effective: dump.cliffSettings,
        region,
        cliffs: dump.cliffs,
      });
      console.log(
        `  smoothing=0 at [${String(region.x0)},${String(region.y0)}] -> ${String(dump.cliffs.length)} cliffs`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age) via test/oracle. Case 0 overrides NOTHING and " +
      "exists purely to read cliff_settings back off Vulcanus's own surface, which is how " +
      "cliff_smoothing=1 stopped being an inference from the CliffPlacementSettings prototype " +
      "default and became a measurement. Cases 1-2 are the SAME rule with cliff_smoothing forced " +
      "to 0 and every other term left real (cliff_elevation_0=70, cliff_elevation_interval=120, " +
      "richness=1), at the two entity regions oracle-vulcanus-cliff-smoothing and " +
      "oracle-vulcanus-cliff-collapsed do not cover. With smoothing off the generator reads the " +
      "RAW 4-tile corner field, so these arms score the port's grid-4 cliff elevation directly. " +
      "They are what splits the standing orientation residual in two: [-1200,800] is exact with " +
      "smoothing off (as [0,0] already was) while [1500,1500] is not. `effective` is the " +
      "cliff_settings the SURFACE reported back, so an override that failed to apply cannot be " +
      "mistaken for one that did nothing. Forced surface seed like every other Vulcanus fixture. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-smoothing-off-regions",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-smoothing-off-regions.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} cases)`);
}

/**
 * **The `cliff_smoothing` STENCIL, measured directly instead of derived** (#84).
 *
 * `smoothingKnots` claims the engine interpolates each corner between knots at
 * IN-CHUNK indices 0, 4 and 7 - the 7 rather than 8 being the asymmetry that
 * makes smoothing "inaccurate" in the prototype's own words. That came off a
 * disassembly of `crossingsForChunk`, and a disassembly is a reading, not a
 * measurement.
 *
 * This measures it. The probe is a DELTA on one corner column (or row):
 *
 *     1 + 1000 * if(1 - abs(x - X0), 1, 0)
 *
 * routed onto `cliff_elevation` with smoothing left at 1, a single contour
 * (`interval = 1e6`) and the cliffiness gate held open (`richness = 4`). The
 * smoothed field is then exactly `1 + 1000 * w(i)`, where `w(i)` is the weight
 * corner `i` gives the knot at `X0/4` and nothing else - every other corner
 * contributes the constant 1. Cliffs appear where that crosses
 * `cliff_elevation_0 = 500`, i.e. where `w` crosses 0.5, so the cliff columns
 * read the stencil off the game directly.
 *
 * **The arms include a corner that is NOT a knot under the model, and its
 * prediction is that the game produces NOTHING AT ALL.** That is the whole point
 * of the design: a stencil test that can only ever confirm weights is much
 * weaker than one with an arm whose predicted output is empty, because an empty
 * result cannot be produced by a stencil that is merely close.
 */
async function captureCliffSmoothingStencil(): Promise<void> {
  const seed = 123456;
  const arms: { label: string; axis: "x" | "y"; index: number; region: Region }[] = [
    {
      label: "column 432 (in-chunk 0, knot)",
      axis: "x",
      index: 432,
      region: { x0: 1700, y0: 1500, x1: 1800, y1: 1600 },
    },
    {
      label: "column 435 (in-chunk 3, NOT a knot)",
      axis: "x",
      index: 435,
      region: { x0: 1700, y0: 1500, x1: 1800, y1: 1600 },
    },
    {
      label: "column 436 (in-chunk 4, knot)",
      axis: "x",
      index: 436,
      region: { x0: 1700, y0: 1500, x1: 1800, y1: 1600 },
    },
    {
      label: "column 439 (in-chunk 7, knot)",
      axis: "x",
      index: 439,
      region: { x0: 1700, y0: 1500, x1: 1800, y1: 1600 },
    },
    {
      label: "row 376 (in-chunk 0, knot)",
      axis: "y",
      index: 376,
      region: { x0: 1500, y0: 1450, x1: 1600, y1: 1560 },
    },
    {
      label: "row 379 (in-chunk 3, NOT a knot)",
      axis: "y",
      index: 379,
      region: { x0: 1500, y0: 1450, x1: 1600, y1: 1560 },
    },
    {
      label: "row 380 (in-chunk 4, knot)",
      axis: "y",
      index: 380,
      region: { x0: 1500, y0: 1450, x1: 1600, y1: 1560 },
    },
    {
      label: "row 383 (in-chunk 7, knot)",
      axis: "y",
      index: 383,
      region: { x0: 1500, y0: 1450, x1: 1600, y1: 1560 },
    },
  ];
  const E0 = 500;
  const cases: {
    label: string;
    axis: "x" | "y";
    index: number;
    region: Region;
    expression: string;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];

  for (const arm of arms) {
    const at = arm.index * 4;
    const expression = `1 + 1000 * if(1 - abs(${arm.axis} - ${String(at)}), 1, 0)`;
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(arm.region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        probeExpression: expression,
        cliffSettings: {
          cliff_smoothing: 1,
          cliff_elevation_interval: 1000000,
          cliff_elevation_0: E0,
          richness: 4,
        },
      });
      cases.push({
        label: arm.label,
        axis: arm.axis,
        index: arm.index,
        region: arm.region,
        expression,
        effective: dump.cliffSettings,
        cliffs: dump.cliffs,
      });
      console.log(`  ${arm.label.padEnd(38)} -> ${String(dump.cliffs.length)} cliffs`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age) via test/oracle. Measures the cliff_smoothing " +
      "STENCIL rather than deriving it. A DELTA probe `1 + 1000 * if(1 - abs(x - X0), 1, 0)` is " +
      "routed onto property_expression_names.cliff_elevation with cliff_smoothing left at 1, " +
      "cliff_elevation_interval=1e6 (a single contour) and richness=4 (the cliffiness gate held " +
      "open). Every corner except column X0/4 carries the constant 1, so the smoothed field is " +
      "exactly 1 + 1000*w(i) where w(i) is the weight corner i gives the knot at X0/4 - the game's " +
      "cliffs at cliff_elevation_0=500 therefore trace the w=0.5 contour of the stencil itself. " +
      "Four column arms and four row arms cover in-chunk indices 0, 3, 4 and 7 on both axes. The " +
      "in-chunk-3 arms are the load-bearing ones: 3 is NOT a knot under `smoothingKnots`, so the " +
      "model predicts the game places NOTHING, and an empty prediction cannot be satisfied by a " +
      "stencil that is merely close. Forced surface seed like every other Vulcanus fixture. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts cliff-smoothing-stencil",
    seed,
    cliffElevation0: E0,
    cases,
  };
  const out = join(FIXTURES, "oracle-cliff-smoothing-stencil.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **The DIRECTION of the cliff/ore exclusion, asked of the game** (#84 item 1,
 * which is really #24).
 *
 * The port puts cliffs on ore and the game essentially does not - 3 of its 1,569
 * against the port's 29. That correlation fits two mechanisms which demand
 * opposite fixes: ore suppresses cliffs, or cliffs suppress ore. `#94` handed the
 * question over unresolved after ruling out lava, every other tile, the
 * cliffiness gate and entity collision.
 *
 * It is settleable by experiment rather than argument, because the resources are
 * a `map_gen_settings` lever like `cliff_settings`: turn them OFF and look. The
 * arms are cumulative in neither direction - they are a 2x2, because each
 * hypothesis needs its own control:
 *
 * - `[1500,1500]` at DEFAULT cliff settings, resources ON then OFF. The
 *   difference IS the suppressed set, with no model of the geometry needed to
 *   obtain it, and this is the region where the exclusion costs the port
 *   accuracy (26 of its 42 surplus cells).
 * - The same region with only `calcite` off and only `sulfuric_acid_geyser` off,
 *   so the suppressed set can be attributed per resource. It is exactly
 *   additive: 27 + 4 = 31.
 * - `[0,0]` with the rule COLLAPSED (single contour at 70, gate forced open,
 *   smoothing off) so a contour is forced through the tungsten blob that #94
 *   named the sharpest open lead, resources ON then OFF.
 *
 * Every arm dumps the resources and the effective autoplace controls **in the
 * same run as the cliffs**. Two runs cannot answer this: "the ore moved" and
 * "the cliffs moved" have to be read off one generated surface, and the
 * non-vacuity check that the ore really did vanish has to come from the arm
 * making the claim.
 *
 * The prototype geometry rides along because the answer turned on it. The ores'
 * collision half-extent is 0.098 and the geyser's is 1.398, which is why a test
 * treating every resource as a point at its tile centre explains the calcite
 * cells and cannot explain the geyser ones.
 */
async function captureVulcanusCliffOreDirection(): Promise<void> {
  const seed = 123456;
  const entityRegion: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const blobRegion: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const ONE_BAND = 1000000;
  // The collapsed rule of `oracle-vulcanus-cliff-collapsed`'s third arm, which is
  // where the blob is reachable at all: at real settings the port places nothing
  // there, so the exclusion is only visible once a contour is forced through it.
  const COLLAPSED = {
    cliff_smoothing: 0,
    cliff_elevation_interval: ONE_BAND,
    cliff_elevation_0: 70,
    richness: 4,
  };
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "tungsten-ore",
    "calcite",
    "coal",
    "sulfuric-acid-geyser",
    "big-volcanic-rock",
    "huge-volcanic-rock",
  ];

  const arms: {
    label: string;
    region: Region;
    cliffSettings?: Record<string, number>;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  }[] = [
    { label: "entity region, resources ON", region: entityRegion },
    { label: "entity region, ALL resources OFF", region: entityRegion, autoplaceControls: ALL_OFF },
    {
      label: "entity region, calcite OFF",
      region: entityRegion,
      autoplaceControls: { calcite: OFF },
    },
    {
      label: "entity region, geyser OFF",
      region: entityRegion,
      autoplaceControls: { sulfuric_acid_geyser: OFF },
    },
    { label: "blob region COLLAPSED, resources ON", region: blobRegion, cliffSettings: COLLAPSED },
    {
      label: "blob region COLLAPSED, ALL resources OFF",
      region: blobRegion,
      cliffSettings: COLLAPSED,
      autoplaceControls: ALL_OFF,
    },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(arm.region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: arm.cliffSettings,
        autoplaceControls: arm.autoplaceControls,
        alsoResources: true,
        protoNames: PROTOS,
      });
      cases.push({
        label: arm.label,
        region: arm.region,
        cliffSettings: arm.cliffSettings ?? null,
        autoplaceControls: arm.autoplaceControls ?? null,
        effectiveCliffSettings: dump.cliffSettings,
        effectiveAutoplace: dump.autoplaceControls,
        cliffs: dump.cliffs,
        resources: dump.resources,
        protos: dump.protos,
      });
      // The probe writes `name` and `orientation` alongside the position, but
      // `CliffDump.cliffs` is typed as the bare `Position` the noise samplers
      // share. Only this progress line needs the name, so it is narrowed here
      // rather than by widening a type six other captures depend on.
      const named = dump.cliffs as unknown as readonly { name: string }[];
      const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
      console.log(
        `  ${arm.label} -> ${String(vulc)} cliff-vulcanus, ` +
          `${String(dump.cliffs.length - vulc)} other cliff, ` +
          `${String(dump.resources?.length ?? -1)} resources`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Settles the DIRECTION of the Vulcanus " +
      "cliff/ore exclusion (#84 item 1, #24) by turning the resources OFF through " +
      "map_gen_settings.autoplace_controls and regenerating - the same trick " +
      "oracle-vulcanus-cliff-collapsed plays on cliff_settings. Arms are NOT cumulative; they are " +
      "paired ON/OFF controls, because 'ore suppresses cliffs' and 'cliffs suppress ore' each need " +
      "their own. Every arm dumps the cliffs, the resources, the prototype collision geometry and " +
      "the autoplace controls the SURFACE read back, all from ONE generated surface, so an override " +
      "that failed to apply cannot be mistaken for a term that does not matter and 'the ore moved' " +
      "and 'the cliffs moved' are never compared across two different worlds. Sampled on a " +
      "create_surface() surface whose seed is FORCED to `seed`, like every other Vulcanus oracle " +
      "fixture. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-ore-direction",
    seed,
    entityRegion,
    blobRegion,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-ore-direction.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **The MECHANISM behind the ore -> cliff exclusion, which every arm before
 * this one could only characterise.**
 *
 * `oracle-vulcanus-cliff-ore-direction` settled the direction by switching the
 * resources OFF. That answers "which way does it run" and cannot answer "how",
 * because removing the ore removes everything about the ore at once. The
 * distinguishing lever is a PROTOTYPE field: leave all 945 resource entities
 * exactly where the control has them and change one property of them.
 *
 * `ResourceEntityPrototype::cliff_removal_probability` defaults to **1.0**, and
 * no shipped prototype overrides it - grepped across `base/`, `core/`,
 * `space-age/`, `quality/` and `elevated-rails/`. So it is invisible from the
 * data alone and can only be seen by changing it.
 *
 * A prototype field cannot be reached by a surface setting the way
 * `autoplace_controls` and `cliff_settings` can: it is read at map-gen from the
 * loaded prototype. That is what {@link OracleOptions.extraDataLua} exists for,
 * and why it writes `data-final-fixes.lua` rather than `data.lua` - this probe
 * mod declares no dependencies, so Factorio may load it before `space-age` and
 * an override written at the data stage would silently edit nothing.
 *
 * Each arm reads the field back off the RUNNING GAME through `protos`, so an
 * override that failed to apply cannot be mistaken for a field that does not
 * matter. That read-back is the whole reason this is an arm rather than a hope.
 */
async function captureVulcanusCliffRemovalProbability(): Promise<void> {
  const seed = 123456;
  const blobRegion: Region = { x0: 0, y0: 0, x1: 256, y1: 256 };
  const ONE_BAND = 1000000;
  // Identical to `vulcanus-cliff-ore-direction`'s blob arms, so the two
  // fixtures are directly comparable rather than nearly comparable.
  const COLLAPSED = {
    cliff_smoothing: 0,
    cliff_elevation_interval: ONE_BAND,
    cliff_elevation_0: 70,
    richness: 4,
  };
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = ["cliff-vulcanus", "tungsten-ore", "calcite", "coal", "sulfuric-acid-geyser"];
  const ZERO_REMOVAL = `
-- Leave every resource exactly where it is and zero ONE prototype field.
for _, proto in pairs(data.raw.resource) do
  proto.cliff_removal_probability = 0
end
`;

  const arms: {
    label: string;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
    extraDataLua?: string;
  }[] = [
    { label: "blob COLLAPSED, resources ON, cliff_removal_probability at its 1.0 default" },
    {
      label: "blob COLLAPSED, resources ON, cliff_removal_probability = 0",
      extraDataLua: ZERO_REMOVAL,
    },
    { label: "blob COLLAPSED, ALL resources OFF", autoplaceControls: ALL_OFF },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(blobRegion, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: COLLAPSED,
        autoplaceControls: arm.autoplaceControls,
        alsoResources: true,
        protoNames: PROTOS,
        extraDataLua: arm.extraDataLua,
      });
      cases.push({
        label: arm.label,
        region: blobRegion,
        cliffSettings: COLLAPSED,
        autoplaceControls: arm.autoplaceControls ?? null,
        zeroedCliffRemovalProbability: arm.extraDataLua !== undefined,
        effectiveCliffSettings: dump.cliffSettings,
        effectiveAutoplace: dump.autoplaceControls,
        cliffs: dump.cliffs,
        resources: dump.resources,
        protos: dump.protos,
      });
      const named = dump.cliffs as unknown as readonly { name: string }[];
      const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
      console.log(
        `  ${arm.label} -> ${String(vulc)} cliff-vulcanus, ` +
          `${String(dump.resources?.length ?? -1)} resources, ` +
          `tungsten cliff_removal_probability=${String(
            dump.protos?.["tungsten-ore"]?.cliff_removal_probability,
          )}`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 via test/oracle. Names the MECHANISM of the Vulcanus " +
      "cliff/ore exclusion (#84, #24), which oracle-vulcanus-cliff-ore-direction could only give " +
      "a direction for. The distinguishing arm leaves every one of the 945 resource entities " +
      "exactly where the control has them and sets ONE prototype field, " +
      "ResourceEntityPrototype::cliff_removal_probability, to 0 - a change no surface setting can " +
      "make, because a prototype field is read at map-gen from the loaded prototype. The cliffs " +
      "come back anyway, and that arm is indistinguishable from the resources-OFF arm. The field " +
      "defaults to 1.0 and no shipped prototype overrides it, which is why the port's " +
      "unconditional box-overlap rejection is correct as written: the BEHAVIOUR does not change, " +
      "the explanation does. Every arm reads the field back off the running game in `protos`, so " +
      "an override that failed to apply cannot be mistaken for a term that does not matter. " +
      "Sampled on a create_surface() surface whose seed is FORCED to `seed`, like every other " +
      "Vulcanus oracle fixture. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-removal-probability",
    seed,
    blobRegion,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-removal-probability.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **Eight more regions, to make the CHUNK-BORDER question decisive** (#84).
 *
 * The unexplained residual is enriched on chunk borders: 9 of 14 on the original
 * three regions (64.3% against a 45.0% base), then 9 of 13 on the four added in
 * #131 (69.2% against 47.2%). The second was a pre-registered test on fresh data
 * and it replicated in direction and magnitude - but at 1.59 sigma alone and
 * ~2.1 combined, it is a lead rather than a result.
 *
 * n is the only thing in the way. **The prediction, recorded here before the
 * capture ran:** if the enrichment is real at ~66%, eight more regions should
 * add roughly 26 unexplained cells with about 17 on a border, taking the
 * combined figure to ~2.9 sigma. If it is noise, the new batch should sit near
 * its own base rate of ~46% and the combined figure should FALL.
 *
 * That is a prediction with a real way to lose, which the first two rounds did
 * not have.
 *
 * Regions are spread away from spawn, from each other, and from the seven
 * already captured. ~2.5s an arm.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-entities-border-batch`
 */
async function captureVulcanusCliffEntitiesBorderBatch(): Promise<void> {
  const seed = 123456;
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "tungsten-ore",
    "calcite",
    "coal",
    "sulfuric-acid-geyser",
  ];
  const mk = (x: number, y: number): Region => ({ x0: x, y0: y, x1: x + 256, y1: y + 256 });
  const regions: { label: string; region: Region }[] = [
    { label: "[2200,-2800]", region: mk(2200, -2800) },
    { label: "[-3400,-900]", region: mk(-3400, -900) },
    { label: "[1200,2600]", region: mk(1200, 2600) },
    { label: "[-1600,3200]", region: mk(-1600, 3200) },
    { label: "[3600,600]", region: mk(3600, 600) },
    { label: "[-900,-3300]", region: mk(-900, -3300) },
    { label: "[2800,2000]", region: mk(2800, 2000) },
    { label: "[-3000,2800]", region: mk(-3000, 2800) },
  ];

  const cases: unknown[] = [];
  for (const r of regions) {
    for (const off of [false, true]) {
      const label = `${r.label}, ${off ? "ALL resources OFF" : "resources ON"}`;
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const dump = await sampleCliffEntitiesFull(r.region, {
          workDir,
          seed,
          spaceAge: true,
          planet: "vulcanus",
          autoplaceControls: off ? ALL_OFF : undefined,
          alsoResources: true,
          protoNames: PROTOS,
        });
        cases.push({
          label,
          region: r.region,
          autoplaceControls: off ? ALL_OFF : null,
          effectiveAutoplace: dump.autoplaceControls,
          effectiveCliffSettings: dump.cliffSettings,
          cliffs: dump.cliffs,
          resources: dump.resources,
        });
        const named = dump.cliffs as unknown as readonly { name: string }[];
        const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
        console.log(`  ${label} -> ${String(vulc)} cliff-vulcanus`);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Eight more Vulcanus cliff-entity regions " +
      "with the paired ON / ALL-resources-OFF ore lever, captured to make the CHUNK-BORDER question " +
      "decisive (#84). The unexplained residual ran 9/14 on a border in the original three regions " +
      "and 9/13 in the four added by #131 - replicated, but 1.59 sigma alone and ~2.1 combined. " +
      "PREDICTION RECORDED BEFORE CAPTURE: if the enrichment is real at ~66%, these should add ~26 " +
      "unexplained cells with ~17 on a border, taking the combined figure to ~2.9 sigma; if it is " +
      "noise, the new batch sits near its own ~46% base rate and the combined figure FALLS. Regions " +
      "are spread away from spawn, from each other, and from the seven already captured. Each arm " +
      "records the autoplace_controls and cliff_settings the SURFACE read back and dumps cliffs and " +
      "resources from one generated surface. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-entities-border-batch",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-entities-border-batch.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **Four MORE cliff-entity regions, with the ore lever, to raise n** (#84).
 *
 * Two things are stuck at a sample size rather than at an idea.
 *
 * The residual's unexplained population is **14 cells**, and every structural
 * test on it - chunk-border status, orientation, distance to the region rim -
 * lands at 1.4 to 1.9 sigma against its base rate. At n = 14 that is what a
 * partition looks like whether or not a cause exists, so another slice of the
 * same fourteen cannot settle anything. More cells can.
 *
 * And the shipped accuracy figure - recall 0.9961, precision 0.9858 - is
 * measured on **three** regions, all chosen years into the investigation for
 * reasons that had nothing to do with sampling. Whether it holds elsewhere on
 * the map has never been asked.
 *
 * Four regions, spread away from spawn and from each other, each with the paired
 * ON / ALL-resources-OFF arms so the ore can be attributed the same way #123 and
 * #126 do. Captures cost about 2.5s each.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-entities-more-regions`
 */
/**
 * EIGHT more Vulcanus cliff-entity regions with the paired ON / ALL-resources-OFF
 * ore lever, captured purely to RAISE N on the west-edge concentration (#84).
 *
 * Every west measurement to date - the z = 3.01 edge split (#150) and the four
 * sweep-order arms (#151) - reuses the SAME 14 regions. Six mechanism hunts have
 * now been spent on a signal whose n has never been raised, and this repo has
 * been burned before by a partition that looked solid at n = 14. These regions
 * are disjoint from all 15 already in use and spread away from spawn and from
 * each other, so they are a genuine out-of-sample arm rather than a resample.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-entities-west-oos`
 */
async function captureVulcanusCliffEntitiesWestOos(): Promise<void> {
  const seed = 123456;
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "tungsten-ore",
    "calcite",
    "coal",
    "sulfuric-acid-geyser",
  ];
  const regions: { label: string; region: Region }[] = [
    { label: "[4200,-2200]", region: { x0: 4200, y0: -2200, x1: 4456, y1: -1944 } },
    { label: "[-4200,-2600]", region: { x0: -4200, y0: -2600, x1: -3944, y1: -2344 } },
    { label: "[2400,3800]", region: { x0: 2400, y0: 3800, x1: 2656, y1: 4056 } },
    { label: "[-1600,-1000]", region: { x0: -1600, y0: -1000, x1: -1344, y1: -744 } },
    { label: "[3400,-3600]", region: { x0: 3400, y0: -3600, x1: 3656, y1: -3344 } },
    { label: "[-3600,2000]", region: { x0: -3600, y0: 2000, x1: -3344, y1: 2256 } },
    { label: "[1000,4200]", region: { x0: 1000, y0: 4200, x1: 1256, y1: 4456 } },
    { label: "[-800,2400]", region: { x0: -800, y0: 2400, x1: -544, y1: 2656 } },
  ];

  const cases: unknown[] = [];
  for (const r of regions) {
    for (const off of [false, true]) {
      const label = `${r.label}, ${off ? "ALL resources OFF" : "resources ON"}`;
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const dump = await sampleCliffEntitiesFull(r.region, {
          workDir,
          seed,
          spaceAge: true,
          planet: "vulcanus",
          autoplaceControls: off ? ALL_OFF : undefined,
          alsoResources: true,
          protoNames: PROTOS,
        });
        cases.push({
          label,
          region: r.region,
          autoplaceControls: off ? ALL_OFF : null,
          effectiveAutoplace: dump.autoplaceControls,
          effectiveCliffSettings: dump.cliffSettings,
          cliffs: dump.cliffs,
          resources: dump.resources,
        });
        const named = dump.cliffs as unknown as readonly { name: string }[];
        const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
        console.log(
          `  ${label} -> ${String(vulc)} cliff-vulcanus, ${String(dump.resources?.length ?? -1)} resources`,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. EIGHT out-of-sample Vulcanus cliff-entity " +
      "regions with the paired ON / ALL-resources-OFF ore lever (#84), captured to raise n on the " +
      "WEST-EDGE concentration of the border residual. Every west measurement to date - the z = 3.01 " +
      "edge split and the four sweep-order arms - reuses the same 14 regions, and six mechanism hunts " +
      "have been spent on a signal whose n was never raised. These eight regions are disjoint from all " +
      "15 already in use and spread away from spawn and from each other, so they are a genuine " +
      "out-of-sample arm rather than a resample. Each arm records the autoplace_controls and " +
      "cliff_settings the SURFACE read back and dumps cliffs and resources from one generated surface, " +
      "so an override that failed to apply cannot be mistaken for a term that does not matter. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-entities-west-oos",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-entities-west-oos.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

async function captureVulcanusCliffEntitiesMoreRegions(): Promise<void> {
  const seed = 123456;
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "tungsten-ore",
    "calcite",
    "coal",
    "sulfuric-acid-geyser",
  ];
  const regions: { label: string; region: Region }[] = [
    { label: "[3000,3000]", region: { x0: 3000, y0: 3000, x1: 3256, y1: 3256 } },
    { label: "[-2000,-2000]", region: { x0: -2000, y0: -2000, x1: -1744, y1: -1744 } },
    { label: "[800,-1500]", region: { x0: 800, y0: -1500, x1: 1056, y1: -1244 } },
    { label: "[-2600,1200]", region: { x0: -2600, y0: 1200, x1: -2344, y1: 1456 } },
  ];

  const cases: unknown[] = [];
  for (const r of regions) {
    for (const off of [false, true]) {
      const label = `${r.label}, ${off ? "ALL resources OFF" : "resources ON"}`;
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const dump = await sampleCliffEntitiesFull(r.region, {
          workDir,
          seed,
          spaceAge: true,
          planet: "vulcanus",
          autoplaceControls: off ? ALL_OFF : undefined,
          alsoResources: true,
          protoNames: PROTOS,
        });
        cases.push({
          label,
          region: r.region,
          autoplaceControls: off ? ALL_OFF : null,
          effectiveAutoplace: dump.autoplaceControls,
          effectiveCliffSettings: dump.cliffSettings,
          cliffs: dump.cliffs,
          resources: dump.resources,
        });
        const named = dump.cliffs as unknown as readonly { name: string }[];
        const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
        console.log(
          `  ${label} -> ${String(vulc)} cliff-vulcanus, ${String(dump.resources?.length ?? -1)} resources`,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Four MORE Vulcanus cliff-entity regions " +
      "with the paired ON / ALL-resources-OFF ore lever (#84), captured to raise n. The residual's " +
      "unexplained population was 14 cells and every structural test on it landed at 1.4-1.9 sigma " +
      "against its base rate, which is what a partition looks like at n=14 whether or not a cause " +
      "exists; and the shipped accuracy figure was measured on three regions chosen for reasons " +
      "unrelated to sampling. Regions are spread away from spawn and from each other. Each arm " +
      "records the autoplace_controls and cliff_settings the SURFACE read back and dumps cliffs and " +
      "resources from one generated surface, so an override that failed to apply cannot be mistaken " +
      "for a term that does not matter. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-entities-more-regions",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-entities-more-regions.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **Does the LEVER itself move cliffs, independently of the ore?** (#84.)
 *
 * By #128 every route from a resource control to a cliff is closed: the cliff
 * FIELD reads `elevation`, whose 47-node expression closure contains no resource
 * region; `Surface::wouldCollide` has exactly two halves; its entity half cannot
 * fire (disjoint masks, and cliffs are placed before entities); and its tile half
 * does not fire (no tile crosses the blocking boundary). Yet switching the
 * resources off returns exactly 31 cliffs.
 *
 * The one route never excluded is that the lever perturbs something structural -
 * a `CompiledMapGenSettings` re-layout, a noise-program index shift - rather than
 * the ore mattering at all. **`richness` is the control that separates them.**
 *
 * `vulcanus_calcite_probability` does not reference richness, and neither does
 * `vulcanus_calcite_region`, so `control:calcite:richness` changes neither where
 * the calcite lands nor the `volcanic_jagged_ground_range` tile it drives. It
 * changes only `vulcanus_calcite_richness`, i.e. how much ore each tile holds -
 * and the compiled settings the generator is handed.
 *
 * So: same entity positions, same tiles, different settings object.
 *
 * - If the cliffs move, the lever is perturbing something structural and "the ore
 *   suppresses cliffs" is the wrong reading of every arm in #84.
 * - If they do not, the effect genuinely tracks ore PRESENCE, and the
 *   impossibility recorded in #128 stands as an impossibility.
 *
 * The arm dumps the resources too, so "positions unchanged" is measured rather
 * than argued from the Lua.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-ore-richness`
 */
async function captureVulcanusCliffOreRichness(): Promise<void> {
  const seed = 123456;
  const region: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const PROTOS = ["cliff-vulcanus", "calcite", "sulfuric-acid-geyser"];
  const arms: {
    label: string;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  }[] = [
    { label: "default" },
    {
      label: "calcite richness x2",
      autoplaceControls: { calcite: { frequency: 1, size: 1, richness: 2 } },
    },
    {
      label: "calcite richness x0.5",
      autoplaceControls: { calcite: { frequency: 1, size: 1, richness: 0.5 } },
    },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        autoplaceControls: arm.autoplaceControls,
        alsoResources: true,
        protoNames: PROTOS,
      });
      cases.push({
        label: arm.label,
        region,
        autoplaceControls: arm.autoplaceControls ?? null,
        effectiveAutoplace: dump.autoplaceControls,
        cliffs: dump.cliffs,
        resources: dump.resources,
      });
      const named = dump.cliffs as unknown as readonly { name: string }[];
      const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
      console.log(
        `  ${arm.label} -> ${String(vulc)} cliff-vulcanus, ${String(dump.resources?.length ?? -1)} resources`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Separates 'the ore suppresses cliffs' " +
      "from 'the autoplace_controls lever perturbs something structural' (#84). By #128 every " +
      "route from a resource control to a cliff is closed - the field reads elevation, whose " +
      "expression closure holds no resource region; Surface::wouldCollide has two halves and " +
      "neither can fire - yet switching the resources off returns 31 cliffs. control:calcite:" +
      "richness is the control that distinguishes the two: it appears in vulcanus_calcite_richness " +
      "only, NOT in vulcanus_calcite_probability (where the ore goes) nor in " +
      "vulcanus_calcite_region (which drives the volcanic_jagged_ground_range tile), so it changes " +
      "the compiled settings while leaving entity positions and tiles alone. If the cliffs move, " +
      "the lever is structural and every ore arm in #84 is misread; if not, the effect tracks ore " +
      "presence. Each arm dumps the resources too, so 'positions unchanged' is measured rather " +
      "than argued. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-ore-richness",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-ore-richness.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **Does a RESOURCE control move TILES, and is any of them cliff-blocking?**
 * (#84.)
 *
 * `autoplace_controls` has been used as an entity-only lever throughout #84 -
 * "switch the ore off and see which cliffs come back". It is not one.
 * `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` defines
 * `vulcanus_calcite_region` in terms of `control:calcite:size` (through
 * `vulcanus_calcite_size = slider_rescale(control:calcite:size, 2)`) and
 * `control:calcite:frequency`, and
 * `space-age/prototypes/tile/tiles-vulcanus.lua` feeds that straight into a TILE
 * range:
 *
 * ```lua
 * name = "volcanic_jagged_ground_range",
 * expression = "5 * min(10, max(vulcanus_calcite_region + 0.2, ...))"
 * ```
 *
 * So the lever moves tiles as well as entities, and the question that decides
 * whether that matters for #84 is whether any moved tile crosses the
 * cliff-BLOCKING boundary - `lava` and `lava-hot`, the only two carrying
 * `tile_collision_masks.lava()`. If none does, the confound is real but inert
 * for cliffs and every ore result stands. If one does, `Surface::wouldCollide`'s
 * TILE half is a live route from the lever to the cliffs, which is exactly what
 * #124 left open after closing the entity half.
 *
 * Our own port answers "none" - but that is our tile model marking its own
 * homework, and #115 only exonerated it over 70 tiles around six cells. This
 * asks the game.
 *
 * **Deliberately model-independent.** A uniform stride-2 grid over the lever's
 * own region rather than the positions our port predicts will change, so the
 * fixture does not encode the very model it exists to check, and stays valid if
 * the port's tile field is later corrected.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-tile-lever`
 */
async function captureVulcanusTileLever(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const STRIDE = 2;
  const OFF = { frequency: 1, size: 0, richness: 1 };

  const positions: { x: number; y: number }[] = [];
  for (let x = region.x0; x < region.x1; x += STRIDE)
    for (let y = region.y0; y < region.y1; y += STRIDE) positions.push({ x: x + 0.5, y: y + 0.5 });

  const arms: {
    label: string;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  }[] = [
    { label: "resources ON" },
    { label: "calcite OFF", autoplaceControls: { calcite: OFF } },
    {
      label: "ALL resources OFF",
      autoplaceControls: {
        tungsten_ore: OFF,
        calcite: OFF,
        vulcanus_coal: OFF,
        sulfuric_acid_geyser: OFF,
      },
    },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleTileNamesFull(positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
        autoplaceControls: arm.autoplaceControls,
      });
      cases.push({
        label: arm.label,
        autoplaceControls: arm.autoplaceControls ?? null,
        effectiveAutoplace: dump.autoplaceControls,
        positions: dump.samples.map((s) => ({ x: s.x, y: s.y })),
        tileNames: dump.samples.map((s) => s.name),
      });
      const distinct = [...new Set(dump.samples.map((s) => s.name))].sort();
      console.log(
        `  ${arm.label} -> ${String(dump.samples.length)} tiles, ${String(distinct.length)} distinct`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 (Space Age enabled) via test/oracle. Does an " +
      "autoplace_controls RESOURCE lever move TILES, and is any moved tile cliff-blocking? (#84.) " +
      "vulcanus_calcite_region depends on control:calcite:size and :frequency, and feeds the tile " +
      "range volcanic_jagged_ground_range, so the lever every ore result in #84 treats as " +
      "entity-only also moves tiles. What decides whether that matters is whether any moved tile " +
      "crosses the cliff-blocking boundary - lava and lava-hot, the only two carrying " +
      "tile_collision_masks.lava(). Three arms over the lever's own region [1500,1500], sampling " +
      "surface.get_tile(x, y).name on a uniform stride-2 grid: resources ON, calcite OFF, ALL " +
      "resources OFF. The grid is uniform rather than the positions our port predicts will change, " +
      "so the fixture does not encode the model it exists to check. Each arm records the " +
      "autoplace_controls the SURFACE read back, so 'no tile moved' cannot be confused with 'the " +
      "override never applied'. positions are the mod's ECHOED floored get_tile input. Regenerate: " +
      "node --experimental-strip-types test/oracle/capture.ts vulcanus-tile-lever",
    seed,
    planet,
    region,
    stride: STRIDE,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-tile-lever.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `wrote ${out} (${String(cases.length)} arms, ${String(positions.length)} points each)`,
  );
}

/**
 * **The ore lever on the OTHER TWO oracle regions - an out-of-sample test**
 * (#84).
 *
 * Everything known about the ore -> cliff rule was measured on `[1500,1500]`,
 * because that is the only region `oracle-vulcanus-cliff-ore-direction` re-runs
 * with the resources off. Three things now rest on that single region: #123's
 * split of the 25 missed destructions into 11 ore and 11 unknown, #125's finding
 * that the `onDestroy` cascade closes 4 of the 10 remainders, and the claim that
 * the box-overlap rule has precision 1.000. A rule characterised on one region
 * and never tested on another is fitted until proven otherwise.
 *
 * This adds the paired ON / ALL-OFF arms for the two regions the entities
 * fixture already covers and the lever never did:
 *
 * - `[0,0]` `{0,0,256,256}` - the same box as the other fixture's `blobRegion`,
 *   but at REAL cliff settings rather than the collapsed rule, so it is a
 *   genuine second sample rather than a re-run of the blob probe.
 * - `[-1200,800]` `{-1200,800,-944,1056}`.
 *
 * It is a SEPARATE fixture rather than two more arms on the existing one so that
 * regenerating it cannot rewrite ground truth that four merged PRs already
 * depend on. Same seed, same protos, same `alsoResources`, so the two are
 * directly comparable.
 *
 * Regenerate: `node --experimental-strip-types test/oracle/capture.ts
 * vulcanus-cliff-ore-direction-regions`
 */
async function captureVulcanusCliffOreDirectionRegions(): Promise<void> {
  const seed = 123456;
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "tungsten-ore",
    "calcite",
    "coal",
    "sulfuric-acid-geyser",
    "big-volcanic-rock",
    "huge-volcanic-rock",
  ];
  const regions: { label: string; region: Region }[] = [
    { label: "[0,0]", region: { x0: 0, y0: 0, x1: 256, y1: 256 } },
    { label: "[-1200,800]", region: { x0: -1200, y0: 800, x1: -944, y1: 1056 } },
  ];

  const cases: unknown[] = [];
  for (const r of regions) {
    for (const off of [false, true]) {
      const label = `${r.label}, ${off ? "ALL resources OFF" : "resources ON"}`;
      const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
      try {
        const dump = await sampleCliffEntitiesFull(r.region, {
          workDir,
          seed,
          spaceAge: true,
          planet: "vulcanus",
          autoplaceControls: off ? ALL_OFF : undefined,
          alsoResources: true,
          protoNames: PROTOS,
        });
        cases.push({
          label,
          region: r.region,
          autoplaceControls: off ? ALL_OFF : null,
          effectiveCliffSettings: dump.cliffSettings,
          effectiveAutoplace: dump.autoplaceControls,
          cliffs: dump.cliffs,
          resources: dump.resources,
          protos: dump.protos,
        });
        const named = dump.cliffs as unknown as readonly { name: string }[];
        const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
        console.log(
          `  ${label} -> ${String(vulc)} cliff-vulcanus, ` +
            `${String(dump.resources?.length ?? -1)} resources`,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. The OUT-OF-SAMPLE arm for the Vulcanus " +
      "cliff/ore exclusion (#84): oracle-vulcanus-cliff-ore-direction only re-runs [1500,1500] " +
      "with the resources off, so every quantity known about the ore rule - the 11/11 split of " +
      "the missed destructions, the onDestroy cascade closing 4 of 10 remainders, and precision " +
      "1.000 - was characterised on one region. These are the paired ON / ALL-OFF arms for the " +
      "two regions the entities fixture covers and the lever never did, at REAL cliff settings. " +
      "Deliberately a separate file: regenerating it cannot rewrite ground truth that merged work " +
      "already depends on. Same seed, protos and alsoResources as the original, so the two are " +
      "directly comparable. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-ore-direction-regions",
    seed,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-ore-direction-regions.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **Is any placed ENTITY what suppresses the non-ore residual at `[1500,1500]`?**
 * (#84.) The lever, not a predicate.
 *
 * Running both sides with the resources switched off leaves 13 wrong
 * orientations and 10 surplus cells that the ore rule cannot reach, and their
 * shape is a SUPPRESSION: the game's code is the port's code with edges removed,
 * and the cells the port over-places are ones the game emits nothing at. #109
 * excluded the field twice over, plus rocks, the cliffiness gate, smoothing and
 * the repair; #108 excluded the stage. The obvious remaining class is the
 * unported half of `Surface::wouldCollide` - an entity standing where the cliff
 * would go.
 *
 * `autoplace_controls` cannot ask that question, because a control only reaches
 * prototypes that name one: the four resources have controls, and the rocks,
 * the chimneys and `crater-cliff` have none. `autoplace_settings.entity` with
 * `treat_missing_as_default = false` switches the whole category off at once, so
 * one arm answers it for every entity there is.
 *
 * The second lever aims at LAVA, and it is the one that pays. Dropping
 * `lava`/`lava-hot` from the tile autoplace leaves the elevation the crossings
 * read untouched (tiles are downstream of it) and takes away the only thing the
 * tile-collision rejection can reject against - so the cells that APPEAR are the
 * game's own answer to "which cliffs does lava suppress", the way
 * `autoplace_controls` gave the ore's answer in #110. Our lava rejection can
 * then be scored for precision and recall against a known set instead of tuned
 * until the totals agree, which is the thing #88 says must not happen to a
 * collision box.
 *
 * Five arms, all over the same `[1500,1500]` entity region:
 *
 * - **resources OFF via controls** - the baseline the residual is measured
 *   against, captured again here so the comparison is within one fixture and one
 *   binary rather than across two.
 * - **the whole `entity` category OFF** - the entity lever. If the cliffs are
 *   unchanged, no entity suppresses them, positively rather than by elimination.
 * - **default (resources ON)** - the shipping world, for the entity list.
 * - **resources OFF + lava tiles OFF** - the lava lever with the ore already out
 *   of the picture, so what moves is lava alone.
 * - **lava tiles OFF only** - the same lever against the shipping world.
 *
 * Every arm dumps EVERY entity in the region with its type, so a null result
 * still says what was standing there; reads `autoplace_settings` back off the
 * surface; and COUNTS the lava tiles in the region it just generated. That last
 * one is what separates "lava suppresses nothing" from "the tile override never
 * applied" - the two are the same observation without it. `cliff-vulcanus` is
 * placed from `cliff_settings`, not from either category, so a lever arm that
 * also emptied the cliffs would be vacuous and says nothing.
 */
async function captureVulcanusCliffSuppressorLevers(): Promise<void> {
  const seed = 123456;
  const region: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const PROTOS = [
    "cliff-vulcanus",
    "crater-cliff",
    "big-volcanic-rock",
    "huge-volcanic-rock",
    "big-volcanic-rock-hot",
    "huge-volcanic-rock-hot",
    "vulcanus-chimney",
    "vulcanus-chimney-faded",
    "vulcanus-chimney-cold",
    "vulcanus-chimney-short",
    "vulcanus-chimney-truncated",
    "ashland-lichen-tree",
    "ashland-lichen-tree-flaming",
  ];

  const LAVA_TILES = ["lava", "lava-hot"];
  const arms: {
    label: string;
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
    disableAutoplaceCategories?: readonly string[];
    excludeFromAutoplaceCategory?: Readonly<Record<string, readonly string[]>>;
    /** Only the two arms the ENTITY lever compares carry the full list. */
    alsoEntities?: boolean;
  }[] = [
    { label: "resources OFF via controls", autoplaceControls: ALL_OFF, alsoEntities: true },
    {
      label: "entity autoplace category OFF",
      disableAutoplaceCategories: ["entity"],
      alsoEntities: true,
    },
    { label: "default, resources ON" },
    {
      label: "resources OFF, LAVA TILES OFF",
      autoplaceControls: ALL_OFF,
      excludeFromAutoplaceCategory: { tile: LAVA_TILES },
    },
    { label: "LAVA TILES OFF only", excludeFromAutoplaceCategory: { tile: LAVA_TILES } },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        autoplaceControls: arm.autoplaceControls,
        disableAutoplaceCategories: arm.disableAutoplaceCategories,
        excludeFromAutoplaceCategory: arm.excludeFromAutoplaceCategory,
        countTileNames: LAVA_TILES,
        alsoResources: true,
        alsoEntities: arm.alsoEntities,
        protoNames: PROTOS,
      });
      cases.push({
        label: arm.label,
        region,
        autoplaceControls: arm.autoplaceControls ?? null,
        disabledCategories: arm.disableAutoplaceCategories ?? null,
        excludedFromCategory: arm.excludeFromAutoplaceCategory ?? null,
        effectiveCliffSettings: dump.cliffSettings,
        effectiveAutoplace: dump.autoplaceControls,
        effectiveAutoplaceSettings: dump.autoplaceSettings,
        tileCounts: dump.tileCounts,
        cliffs: dump.cliffs,
        entities: dump.entities ?? null,
        protos: dump.protos,
      });
      const named = dump.cliffs as unknown as readonly { name: string }[];
      const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
      const nonCliff = (dump.entities ?? []).filter((e) => e.type !== "cliff").length;
      const lava = Object.values(dump.tileCounts ?? {}).reduce((a, b) => a + b, 0);
      console.log(
        `  ${arm.label} -> ${String(vulc)} cliff-vulcanus, ` +
          `${String(dump.cliffs.length - vulc)} other cliff, ` +
          `${String(nonCliff)} non-cliff entities, ${String(lava)} lava tiles`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Asks whether any placed ENTITY suppresses " +
      "the non-ore cliff residual at [1500,1500] (#84), with LEVERS rather than predicates: " +
      "map_gen_settings.autoplace_settings.entity = {treat_missing_as_default = false, settings = {}} " +
      "switches the whole entity autoplace category off, which autoplace_controls cannot do - a " +
      "control only reaches prototypes that name one, so the four resources have one and the rocks, " +
      "chimneys and crater-cliff have none. A second lever drops lava/lava-hot from the TILE " +
      "autoplace, which leaves the elevation the crossings read untouched and takes away the only " +
      "thing the tile-collision rejection can reject against - so the cells that appear are the " +
      "game's own answer to which cliffs lava suppresses, scorable for precision and recall rather " +
      "than tuned to fit. Every arm dumps EVERY entity in the region with its type (so a null " +
      "result still says what was standing there), the prototype collision geometry, the " +
      "autoplace_settings the SURFACE read back, and a COUNT of the lava tiles actually generated " +
      "- the last two are what make an empty entity list or an unmoved cliff evidence rather than " +
      "an unapplied override. cliff-vulcanus comes from cliff_settings, not from either category, " +
      "so a lever arm that also emptied the cliffs would be vacuous. " +
      "Sampled on a create_surface() surface whose seed is FORCED to `seed`, like every other " +
      "Vulcanus oracle fixture. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-suppressor-levers",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-suppressor-levers.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **The grid-4 cliff-elevation channel, read out corner by corner at the bands
 * the placement rule actually consults** (#84).
 *
 * This is the one input to cliff placement that has never had a per-corner
 * oracle. `oracle-vulcanus-cliff-corner-fields-entity-regions` holds the TILE
 * channel - `calculate_tile_properties` evaluates the 1-tile noise program, and
 * `multisample`'s offsets are in the calling program's grid units, so against
 * the grid-4 field the cliff generator reads it differs by **96.09**. Every
 * "the field is exact" claim in the residual work rests on the wrong channel.
 *
 * The readout uses the cliff generator itself, which is the only consumer known
 * to walk the 4-tile lattice. Collapse the rule through `cliff_settings`:
 *
 * - `cliff_smoothing = 0` - the cliff elevation IS the raw grid-4 field, with
 *   no interpolation between knots standing between the field and the cliff.
 * - `cliff_elevation_interval = 1e6` - one contour, at `cliff_elevation_0`, so
 *   `crossesCliff`'s band arithmetic (`boundary = e0 + interval*floor(...)`)
 *   collapses to a single threshold test.
 * - `richness = 4` - `0.5*log2(4) = 1`, so `cliffiness_basic` saturates at 1.5
 *   and its `> 0.5` gate is open EVERYWHERE.
 *
 * Under those three, `crossesCliff(a, b)` reduces to `min(a,b) < e0 <= max(a,b)`
 * with both corners non-negative. So the game places a cliff on an edge exactly
 * when that edge's two corners straddle the level - and the ORIENTATION says
 * which side is the high one. Each run is therefore a **1-bit comparator on
 * every one of the region's 4,225 corners at once**, and the fixture is the
 * game's own answer to "is your grid-4 field above this level here?".
 *
 * **The levels are the real bands, not a uniform sweep**, and that is the whole
 * design. `crossesCliff` only ever compares the field against `70 + 120k`, so
 * the game's bits at those levels are the entire placement-relevant content of
 * the channel: if they match, the port's placement is right whatever the field's
 * exact values are, and no finer sweep can add anything. Per region, the bands
 * its field actually spans (port-side range, so the set is not a guess):
 *
 * | region | grid-4 range | bands crossed |
 * | --- | --- | --- |
 * | `[0,0]` | -53.16 .. 402.44 | 70, 190, 310 |
 * | `[1500,1500]` | -36.38 .. 1226.33 | 70 .. 1150, all ten |
 * | `[-1200,800]` | -54.86 .. 300.06 | 70, 190 |
 *
 * `oracle-vulcanus-elevation-levels` already collapses the rule this way, but
 * only over `[0,0]` and only at 20..200 step 10 - it never reaches a single band
 * above 190, while the residual's wrong cells sit at **670 / 790 / 1030**, in
 * `[1500,1500]`, which that fixture does not cover at all.
 */
async function captureVulcanusCliffBands(): Promise<void> {
  const seed = 123456;
  const ONE_BAND = 1000000;
  // Exactly the regions of oracle-vulcanus-cliff-entities.seed123456.json, so
  // this joins to the entity fixture and to every residual spec built on it.
  const plan: { region: Region; levels: number[] }[] = [
    { region: { x0: 0, y0: 0, x1: 256, y1: 256 }, levels: [70, 190, 310] },
    {
      region: { x0: 1500, y0: 1500, x1: 1756, y1: 1756 },
      levels: [70, 190, 310, 430, 550, 670, 790, 910, 1030, 1150],
    },
    { region: { x0: -1200, y0: 800, x1: -944, y1: 1056 }, levels: [70, 190] },
  ];

  /**
   * **Two ways to hold the cliffiness gate open, because one of them is a
   * MODEL and the other is not.**
   *
   * `richness = 4` works through `cliffiness_basic` itself:
   * `clamp(0.5*log2(4) + qmn, 0, 1) + 0.5`. Comparing against it therefore
   * requires the port to reproduce `qmn` in the region where the DEFAULT-richness
   * field is clamped flat at 0.5 - and that is precisely the population no
   * fixture validates. `oracle-vulcanus-cliff-corner-fields-entity-regions` puts
   * **8,409 of its 12,675 corners** on a clamp, and shifting the richness term by
   * +1 turns exactly those into the ones that decide the gate. So a disagreement
   * under this arm cannot be attributed: it is either the field or `qmn` below
   * the clamp.
   *
   * Routing the `cliffiness` PROPERTY at the constant `1` removes the model
   * entirely - the gate is open at every corner by construction, with no
   * expression of ours in the way - so a disagreement under that arm is the
   * cliff-elevation field and nothing else. Both arms are captured because the
   * pair is the measurement: agreement between them says the richness route was
   * sound, and disagreement localises which input moved.
   */
  const arms = [
    {
      gate: "richness4",
      cliffSettings: { richness: 4 } as Record<string, number>,
      probe: undefined as string | undefined,
    },
    { gate: "constant1", cliffSettings: {}, probe: "1" },
  ];

  const cases: {
    region: Region;
    level: number;
    gate: string;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const arm of arms) {
    for (const { region, levels } of plan) {
      for (const level of levels) {
        const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
        try {
          const dump = await sampleCliffEntitiesFull(region, {
            workDir,
            seed,
            spaceAge: true,
            planet: "vulcanus",
            cliffSettings: {
              cliff_smoothing: 0,
              cliff_elevation_interval: ONE_BAND,
              cliff_elevation_0: level,
              ...arm.cliffSettings,
            },
            probeProperty: arm.probe === undefined ? undefined : "cliffiness",
            probeExpression: arm.probe,
          });
          cases.push({
            region,
            level,
            gate: arm.gate,
            effective: dump.cliffSettings,
            cliffs: dump.cliffs,
          });
          console.log(
            `  ${arm.gate} [${String(region.x0)},${String(region.y0)}] level ${String(level)} -> ` +
              `${String(dump.cliffs.length)} cliffs (effective e0=` +
              `${String(dump.cliffSettings?.cliff_elevation_0)}, ` +
              `interval=${String(dump.cliffSettings?.cliff_elevation_interval)}, ` +
              `smoothing=${String(dump.cliffSettings?.cliff_smoothing)}, ` +
              `richness=${String(dump.cliffSettings?.richness)})`,
          );
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      }
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. THE GRID-4 CLIFF-ELEVATION CHANNEL, " +
      "read out corner by corner - the one input to cliff placement that had no per-corner oracle " +
      "(#84). oracle-vulcanus-cliff-corner-fields-entity-regions holds the TILE channel " +
      "(calculate_tile_properties runs the 1-tile program, and multisample's offsets are in the " +
      "calling program's grid units), which differs from the channel the cliff generator reads by " +
      "96.09. Here the CLIFF GENERATOR is the readout: with cliff_smoothing=0 (the raw field, no " +
      "interpolation), cliff_elevation_interval=1e6 (one contour, so crossesCliff's band " +
      "arithmetic collapses to a single threshold) and richness=4 (cliffiness_basic saturates at " +
      "1.5 so its >0.5 gate is open everywhere) OR the `cliffiness` property routed at the literal " +
      "constant 1, the game places a cliff on an edge exactly when " +
      "its two corners straddle cliff_elevation_0, and the entity's orientation says which side " +
      "is high. Each case is therefore a 1-bit comparator applied to all 4,225 corners of the " +
      "region at once. The levels are the REAL bands (70 + 120k) rather than a uniform sweep, " +
      "because crossesCliff only ever compares the field against those - the bits at the bands " +
      "are the entire placement-relevant content of the channel. Per region the levels span the " +
      "bands that region's field actually crosses. Distinct from " +
      "oracle-vulcanus-elevation-levels, which collapses the rule the same way but covers only " +
      "[0,0] at 20..200 step 10 and so reaches no band above 190, while the residual's wrong " +
      "cells sit at 670/790/1030 in [1500,1500]. `effective` is the cliff_settings the SURFACE " +
      "reported back, so an override that failed to apply cannot be mistaken for one that did " +
      "nothing. Sampled on a create_surface() surface whose seed is FORCED to `seed`, like every " +
      "other Vulcanus oracle fixture. TWO GATE ARMS per case (`gate`): richness4 opens the gate " +
      "through cliffiness_basic itself, so comparing against it needs the port to reproduce qmn " +
      "BELOW the clamp - the 8,409-of-12,675 corner population that no fixture validates, since " +
      "shifting the richness term by +1 turns exactly the clamped corners into the ones that " +
      "decide the gate. constant1 routes the cliffiness PROPERTY at the literal 1, so the gate is " +
      "open by construction with no expression of ours in the way and a disagreement there is the " +
      "cliff-elevation field and nothing else. The pair is the measurement. Regenerate: node " +
      "--experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-bands",
    seed,
    cliffElevation0: 70,
    cliffElevationInterval: 120,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-bands.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} cases)`);
}

/**
 * **The fine level sweep: what IS the game's grid-4 cliff elevation?** (#84)
 *
 * `captureVulcanusCliffBands` established that the port's grid-4 field is exact
 * at `[0,0]` and `[-1200,800]` and wrong at `[1500,1500]`'s HIGH bands, and
 * bounded the disagreement from below (median 18.8, max 69.0 units). It cannot
 * say what the game's value actually is, because it only samples the field at
 * the ten band boundaries.
 *
 * This sweeps `cliff_elevation_0` across `[700, 900]` in steps of 5 with the
 * same collapsed rule and the gate held open by the constant route, which turns
 * the game's cliffs into a **per-corner bracket** on its own field:
 *
 * - A placed cell's code names its crossing edges and their SIGN, so each
 *   crossing edge at level `L` says "this corner >= L, that corner < L" - two
 *   one-sided constraints per edge, in world terms, with no model in between.
 * - Sweeping `L` tightens both sides. For a corner of value `v` and a neighbour
 *   of value `w`, their shared edge crosses for every `L` in `(min, max]`, so a
 *   corner accumulates constraints from every neighbour it out-ranks - and the
 *   binding ones are the levels nearest `v`. At step 5 the bracket closes to 5.
 *
 * **Only POSITIVE observations are used, and that is what makes it sound.** An
 * absent cliff is ambiguous - the lava/ore rejections drop cells, and
 * `fixImpossibleCells` clears edges - so absence is never read as "no crossing".
 * A PRESENT crossing is unambiguous in the other direction: the repair sweep
 * only ever writes `0` (`fixImpossibleCellsSweep`, verified line by line), so it
 * can delete a crossing but never invent one, and the rejections are post-filters
 * that do not touch the edge registers at all. Every bracket here is therefore a
 * constraint the game actually asserted.
 *
 * The range covers L790 and L910, where the disagreement is worst (36/42 and
 * 22/41), and the corners inside it whose cells the port already reproduces are
 * the built-in control: if the reconstruction is sound, THEIR brackets must
 * contain the port's values.
 */
async function captureVulcanusCliffFineSweep(): Promise<void> {
  const seed = 123456;
  const ONE_BAND = 1000000;
  const region: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const levels: number[] = [];
  for (let e0 = 700; e0 <= 900; e0 += 5) levels.push(e0);

  const cases: {
    level: number;
    effective: DumpedCliffSettings | undefined;
    cliffs: Position[];
  }[] = [];
  for (const level of levels) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        cliffSettings: {
          cliff_smoothing: 0,
          cliff_elevation_interval: ONE_BAND,
          cliff_elevation_0: level,
        },
        // The gate as a construction, not a model - see captureVulcanusCliffBands.
        probeProperty: "cliffiness",
        probeExpression: "1",
      });
      cases.push({ level, effective: dump.cliffSettings, cliffs: dump.cliffs });
      console.log(
        `  level ${String(level)} -> ${String(dump.cliffs.length)} cliffs ` +
          `(effective e0=${String(dump.cliffSettings?.cliff_elevation_0)}, ` +
          `smoothing=${String(dump.cliffSettings?.cliff_smoothing)})`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. The Vulcanus region [1500,1500]-" +
      "[1756,1756] at 41 values of cliff_elevation_0 (700..900 step 5) with the placement rule " +
      "COLLAPSED (cliff_smoothing=0, cliff_elevation_interval=1e6) and the cliffiness gate held " +
      "open by routing the cliffiness PROPERTY at the literal 1 - a construction, not a model. " +
      "Under those settings a cliff sits on an edge exactly when its two corners straddle " +
      "cliff_elevation_0, and the entity's orientation names which side is high, so each placed " +
      "cell asserts one-sided constraints on its corners' values. Sweeping the level brackets " +
      "every corner to the step: this fixture MEASURES the grid-4 cliff-elevation field the " +
      "generator reads, which oracle-vulcanus-cliff-bands could only bound from below (median " +
      "18.8, max 69.0 units) because it samples the field only at the ten band boundaries. Use " +
      "POSITIVE observations only - an absent cliff is ambiguous (lava/ore rejections drop cells, " +
      "fixImpossibleCells clears edges) but a PRESENT crossing is not, because the repair sweep " +
      "only ever writes 0 and so can delete a crossing but never invent one. The range covers the " +
      "bands where the port disagrees worst (790, 910). `effective` is the cliff_settings the " +
      "SURFACE reported back. Sampled on a create_surface() surface whose seed is FORCED to " +
      "`seed`. Regenerate: node --experimental-strip-types test/oracle/capture.ts " +
      "vulcanus-cliff-fine-sweep",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-fine-sweep.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} levels)`);
}

/**
 * **Does CHUNK-GENERATION ORDER carry the ore effect? (#84)**
 *
 * The ore moves cliffs - 885 vs 916 `cliff-vulcanus` in `[1500,1500]` - and
 * every route from a resource control to a cliff is closed: the field (both
 * properties), `Surface::wouldCollide`'s entity half and tile half, and a
 * structural perturbation of the settings object. `vulcanus-cliffs-NOTES.md`
 * lists three ideas that no measurement touches, and this is the first: nothing
 * has looked at whether the ore changes **which chunks get generated, or in what
 * sequence**.
 *
 * It is not an idle one. `Surface::getEffectiveTileID` returns **0 for an
 * absent chunk** and `checkTileCollisions` then SKIPS that tile, so whether a
 * neighbouring chunk exists yet is a real input to whether a cliff survives -
 * and `applyCliffs` adds each cliff to the surface before testing the next.
 * Order is a live causal channel on its face; the question is whether the ore
 * can move it.
 *
 * **The hypothesis has two links, and breaking either closes the route.**
 *
 * - **Link A, ore -> order.** Arms 1 and 2, the established resources-ON /
 *   resources-OFF pair from `vulcanus-cliff-ore-direction`, now recording the
 *   generated chunk set and sequence.
 * - **Link B, order -> cliffs.** Arms 3-6, identical settings to 1 and 2,
 *   differing only in the order the SAME chunks are generated in. This is the
 *   sharper of the two: it tests the second link directly, and a negative
 *   closes the route whatever the ore does to the order.
 *
 * **The order perturbation is measured, not assumed.** The first pass at this
 * tried to read generation order from `on_chunk_generated`, and it came back
 * with a ZERO-length sequence in all four arms while 81 chunks generated -
 * Factorio does not dispatch events raised during `on_init`. So the arms are
 * built as TWO blocking drains with a chunk snapshot taken between them, and
 * they split on different axes: `right-half-first` reports 36 chunks at its
 * midpoint, `bottom-half-first` reports a different 36. Those are two
 * demonstrably different generation orders over one identical chunk set, and
 * neither claim rests on how the game drains a queue.
 *
 * **Predictions, registered here before the capture runs:**
 *
 * | comparison | prediction | what a violation means |
 * | --- | --- | --- |
 * | ON vs OFF, chunk SET | identical | the ore changes which chunks exist - the route is OPEN |
 * | x-split vs y-split, mid-run half | **differs** | the perturbation is INERT and arms 3-6 say nothing |
 * | x-split vs y-split, chunk SET | identical | the perturbation changed more than the order; arms void |
 * | across all 3 orders, cliffs | identical | order moves cliffs - a result on its own account |
 * | ON vs OFF, cliffs | **differs** (885/916) | the ore effect is absent here and every arm is off-target |
 * | arm 1 cliffs | 885, as every prior fixture | this capture is not describing the studied world |
 *
 * The bold rows are the non-vacuity arms and they are why this is six runs
 * rather than two. Without the second, "the orders agree on the cliffs" is
 * indistinguishable from an order that never changed; without the fifth, it is
 * a statement about a run in which the thing being explained did not happen.
 *
 * The two levers are CROSSED rather than each tested against the default, so an
 * INTERACTION is visible - the only shape in which a closed Link B could still
 * leave the ore acting through order.
 */
async function captureVulcanusCliffChunkOrder(): Promise<void> {
  const seed = 123456;
  const region: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const OFF = { frequency: 1, size: 0, richness: 1 };
  const ALL_OFF = {
    tungsten_ore: OFF,
    calcite: OFF,
    vulcanus_coal: OFF,
    sulfuric_acid_geyser: OFF,
  };
  const ORDERS = ["forward", "right-half-first", "bottom-half-first"] as const;
  const arms: {
    label: string;
    chunkOrder: (typeof ORDERS)[number];
    autoplaceControls?: Record<string, { frequency: number; size: number; richness: number }>;
  }[] = ORDERS.flatMap((chunkOrder) => [
    { label: `${chunkOrder} order, resources ON`, chunkOrder },
    { label: `${chunkOrder} order, ALL resources OFF`, chunkOrder, autoplaceControls: ALL_OFF },
  ]);

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        autoplaceControls: arm.autoplaceControls,
        alsoResources: true,
        recordChunks: true,
        chunkOrder: arm.chunkOrder,
      });
      cases.push({
        label: arm.label,
        chunkOrder: arm.chunkOrder,
        autoplaceControls: arm.autoplaceControls ?? null,
        effectiveAutoplace: dump.autoplaceControls,
        cliffs: dump.cliffs,
        resourceCount: dump.resources?.length ?? -1,
        chunkSequenceLength: dump.chunkSequence?.length ?? -1,
        chunksAtEnd: dump.chunksAtEnd,
        chunksAfterFirstDrain: dump.chunksAfterFirstDrain,
      });
      const named = dump.cliffs as unknown as readonly { name: string }[];
      const vulc = named.filter((c) => c.name === "cliff-vulcanus").length;
      console.log(
        `  ${arm.label} -> ${String(vulc)} cliff-vulcanus, ` +
          `${String(dump.resources?.length ?? -1)} resources, ` +
          `${String(dump.chunksAtEnd?.length ?? -1)} chunks, ` +
          `mid ${String(dump.chunksAfterFirstDrain?.length ?? -1)}, ` +
          `seq ${String(dump.chunkSequence?.length ?? -1)}`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. Tests whether CHUNK-GENERATION ORDER is " +
      "the missing mechanism behind the Vulcanus ore/cliff effect (#84) - the first of the three " +
      "ideas vulcanus-cliffs-NOTES.md lists as untouched after all five direct routes closed. Two " +
      "levers are CROSSED: resources ON/OFF (the established autoplace_controls arm) against the " +
      "order the SAME chunks are generated in (one blocking drain; or two drains splitting the " +
      "region on x, or on y). Every arm records the generated chunk SET, and the two-drain arms " +
      "also record the half that existed BETWEEN their drains - that snapshot is what proves the " +
      "order really changed, since chunkSequenceLength is 0 everywhere (Factorio dispatches no " +
      "on_chunk_generated for chunks generated during on_init). Cliffs, resource count and chunks " +
      "all come from ONE surface per arm, so 'the order did not move the cliffs' can never be " +
      "confused with 'the order never moved' or with 'the ore effect was absent from this run'. " +
      "Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-cliff-chunk-order",
    seed,
    region,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-chunk-order.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

/**
 * **The RUNTIME DESTROY PROBE (#127, #84).**
 *
 * #127 established that the cliff CONNECTION rules cannot be scored from map
 * generation output at all - not for want of regions, but because the game's
 * output is always connection-consistent, so `updateConnections` never has a
 * droppable end to act on and both readings of its gate predict exactly what
 * the game shows. It named the two kinds of evidence that could settle it: the
 * disassembly, and "a runtime probe that destroys a cliff outside map
 * generation". #134/#135 did the disassembly and showed the probe is SAFE - all
 * four of `Cliff::onDestroy`'s cascade gates hold on the Lua path too. **This is
 * the probe.**
 *
 * A second attempt at scoring it from output was made first and failed, which
 * is worth recording so nobody repeats it: #137's chunk-order lever produces
 * arms where a border chunk is applied with its neighbour chunk PROVABLY
 * ungenerated, which is exactly the gate's input - but on the `[1500,1500]`
 * west seam all five cliffs carrying a west end have a neighbour that
 * `isCliffConnected` ACCEPTS, so there is still nothing to drop. The
 * counterfactual has to be constructed, not found.
 *
 * **`do_cliff_correction` defaults to `false`**, and that is the single fact
 * this capture is designed around. A probe that called a bare `destroy()` would
 * find neighbours unchanged and the null would mean "the flag was off" rather
 * than "the game does not cascade" - vacuous, and indistinguishable from a
 * result. Every target set is therefore run BOTH ways.
 *
 * **Predictions, registered before the capture runs:**
 *
 * | arm | prediction |
 * | --- | --- |
 * | correction ON, connected targets | neighbours' facing ends become `none`; some may cascade away entirely |
 * | correction OFF, same targets | **neighbours completely unchanged** - only the targets vanish |
 * | correction ON, UNCONNECTED targets | nothing but the targets changes - the cascade has nothing to reach |
 * | every arm | `destroyReport[i].found` and `.destroyed` both true for every target |
 *
 * The third row is the control that separates "the cascade ran" from "destroying
 * anything perturbs the region", and the fourth is what stops a missed search
 * box from reading as a destruction.
 *
 * Targets are chosen HERE, in TypeScript, from the committed `[1500,1500]`
 * entity fixture and the port's own `isCliffConnected` - not in Lua - so the
 * selection is auditable and the spec can recompute it. They are spread at least
 * 24 tiles apart so no two cascades can interact, which would otherwise make a
 * per-target prediction untestable.
 */
async function captureVulcanusCliffDestroyProbe(): Promise<void> {
  const seed = 123456;
  const region: Region = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
  const source = JSON.parse(
    await readFile(join(FIXTURES, "oracle-vulcanus-cliff-entities.seed123456.json"), "utf8"),
  ) as { cases: { region: Region; cliffs: { x: number; y: number; orientation: string }[] }[] };
  const base = source.cases.find((c) => c.region.x0 === region.x0 && c.region.y0 === region.y0);
  if (base === undefined) throw new Error("no [1500,1500] case in the cliff-entity fixture");

  const CELL_SIDE_LOCAL = { north: 0, east: 1, south: 2, west: 3, none: 4 };
  const CHUNK_CELLS = 32 / CLIFF_GRID_SIZE;
  const ENDS: readonly (readonly [number, number])[] = CLIFF_ORIENTATION_NAMES.map((name) => {
    const [from, to] = name.split("-to-");
    const side = (t: string): number => CELL_SIDE_LOCAL[t as keyof typeof CELL_SIDE_LOCAL];
    return [side(from), side(to)] as const;
  });
  const oppositeSideLocal = (side: number): number => [2, 3, 0, 1, 4][side] ?? 4;
  const connectedSidesLocal = (o: number): number[] =>
    (ENDS[o] ?? []).filter((s) => s !== CELL_SIDE_LOCAL.none);
  const isConnectedLocal = (side: number, mine: number, theirs: number): boolean => {
    const a = ENDS[mine];
    const b = ENDS[theirs];
    if (a === undefined || b === undefined) return false;
    const opp = oppositeSideLocal(side);
    if (a[0] === side) return b[0] !== opp && b[1] === opp;
    return a[1] === side && b[0] === opp && b[1] !== opp;
  };
  const onBorderLocal = (x: number, y: number): boolean => {
    const cx = (x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
    const cy = (y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
    const ix = ((cx % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
    const iy = ((cy % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
    return ix === 0 || ix === CHUNK_CELLS - 1 || iy === 0 || iy === CHUNK_CELLS - 1;
  };
  const oi = (name: string): number => CLIFF_ORIENTATION_NAMES.indexOf(name);
  const at = new Map(base.cliffs.map((c) => [`${String(c.x)},${String(c.y)}`, c]));
  const SIDE_STEP: readonly (readonly [number, number])[] = [
    [0, -CLIFF_GRID_SIZE],
    [CLIFF_GRID_SIZE, 0],
    [0, CLIFF_GRID_SIZE],
    [-CLIFF_GRID_SIZE, 0],
  ];
  const connectedCount = (c: { x: number; y: number; orientation: string }): number => {
    const mine = oi(c.orientation);
    if (mine < 0) return 0;
    return connectedSidesLocal(mine).filter((side) => {
      const step = SIDE_STEP[side];
      if (step === undefined) return false;
      const n = at.get(`${String(c.x + step[0])},${String(c.y + step[1])}`);
      return n !== undefined && isConnectedLocal(side, mine, oi(n.orientation));
    }).length;
  };
  // **Targets must sit well INSIDE the region, and that is not tidiness.** The
  // first run picked them in scan order, so all eight landed on the region's
  // top edge - and every single prediction mismatch was an edge artifact. A
  // cliff at `y = 1498.5` is in the dump only because `find_entities_filtered`
  // selects on bounding-box overlap, but ITS neighbours at `y = 1494.5` are
  // outside the dump entirely. The game cascades through cliffs the comparison
  // cannot see, so the model "under-destroys" for a reason that has nothing to
  // do with the model. 48 tiles of margin keeps a cascade's neighbourhood
  // inside the captured world.
  const MARGIN = 48;
  const wellInside = (c: { x: number; y: number }): boolean =>
    c.x >= region.x0 + MARGIN &&
    c.x < region.x1 - MARGIN &&
    c.y >= region.y0 + MARGIN &&
    c.y < region.y1 - MARGIN;

  /** Greedily take `n` cliffs matching `pick`, never within 24 tiles of one already taken. */
  const spread = (
    pick: (c: { x: number; y: number; orientation: string }) => boolean,
    n: number,
  ): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (const c of base.cliffs) {
      if (!wellInside(c) || !pick(c)) continue;
      if (out.some((o) => Math.abs(o.x - c.x) < 24 && Math.abs(o.y - c.y) < 24)) continue;
      out.push({ x: c.x, y: c.y });
      if (out.length === n) break;
    }
    return out;
  };

  const borderTargets = spread((c) => onBorderLocal(c.x, c.y) && connectedCount(c) > 0, 8);
  const interiorTargets = spread((c) => !onBorderLocal(c.x, c.y) && connectedCount(c) > 0, 8);
  // **There is no unconnected-target control, and that is a finding rather than
  // an omission.** Exactly ONE cliff of the 885 has no connected neighbour at
  // all, and it sits at the region's corner, outside the margin above - so the
  // arm would ship with zero targets, asserting "nothing changed" vacuously.
  // Its absence is a restatement of the connection-consistency #127 measured
  // across thirteen arms. The correction-OFF arms carry the control role
  // instead: same targets, same world, cascade disabled.
  const loneCount = base.cliffs.filter((c) => connectedCount(c) === 0).length;
  console.log(
    `  targets: ${String(borderTargets.length)} border, ` +
      `${String(interiorTargets.length)} interior ` +
      `(${String(loneCount)} cliffs region-wide have NO connected neighbour)`,
  );

  const arms: { label: string; targets: { x: number; y: number }[]; correction: boolean }[] = [
    { label: "border targets, correction ON", targets: borderTargets, correction: true },
    { label: "border targets, correction OFF", targets: borderTargets, correction: false },
    { label: "interior targets, correction ON", targets: interiorTargets, correction: true },
    { label: "interior targets, correction OFF", targets: interiorTargets, correction: false },
  ];

  const cases: unknown[] = [];
  for (const arm of arms) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "vulcanus",
        destroyPositions: arm.targets,
        cliffCorrection: arm.correction,
      });
      cases.push({
        label: arm.label,
        correction: arm.correction,
        targets: arm.targets,
        cliffsBefore: dump.cliffs,
        cliffsAfter: dump.cliffsAfter,
        destroyReport: dump.destroyReport,
      });
      console.log(
        `  ${arm.label} -> ${String(dump.cliffs.length)} before, ` +
          `${String(dump.cliffsAfter?.length ?? -1)} after, ` +
          `${String((dump.destroyReport ?? []).filter((r) => r.destroyed).length)}/` +
          `${String(arm.targets.length)} destroyed`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.12 via test/oracle. The RUNTIME DESTROY PROBE #127 asked " +
      "for (#84): it builds the world map generation never produces - a cliff run truncated so a " +
      "neighbour's end has nothing to connect to - by destroying selected cliffs through Lua and " +
      "reading every cliff back a second time. #127 showed the connection rules cannot be scored " +
      "from map-generation output at any number of regions, because the game's output is always " +
      "connection-consistent; #135 showed all four of Cliff::onDestroy's cascade gates hold on " +
      "the Lua path, so this probe reproduces map generation's cascade. Every target set is run " +
      "with do_cliff_correction BOTH true and false, because it DEFAULTS TO FALSE and a bare " +
      "destroy() would give an unchanged-neighbours null that reads exactly like a result. " +
      "Targets are chosen in TypeScript from the committed [1500,1500] entity fixture using the " +
      "port's own isCliffConnected, spread 24+ tiles apart so no two cascades interact, and each " +
      "arm dumps whether the cliff was FOUND and whether destroy() returned true, so a missed " +
      "search box can never read as a destruction. Regenerate: node --experimental-strip-types " +
      "test/oracle/capture.ts vulcanus-cliff-destroy-probe",
    seed,
    region,
    unconnectedCliffsRegionWide: loneCount,
    cases,
  };
  const out = join(FIXTURES, "oracle-vulcanus-cliff-destroy-probe.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} arms)`);
}

if (want("voronoi-search-range")) await captureVoronoiSearchRange();
if (want("voronoi-jitter0")) await captureVoronoiJitter0();
if (want("voronoi-cellid")) await captureVoronoiCellId();
if (want("voronoi-points")) await captureVoronoiPoints();
if (want("vulcanus-cliff-destroy-probe")) await captureVulcanusCliffDestroyProbe();
if (want("vulcanus-cliff-chunk-order")) await captureVulcanusCliffChunkOrder();
if (want("vulcanus-cliff-suppressor-levers")) await captureVulcanusCliffSuppressorLevers();
if (want("vulcanus-cliff-bands")) await captureVulcanusCliffBands();
if (want("vulcanus-cliff-fine-sweep")) await captureVulcanusCliffFineSweep();
if (want("cliff-entities")) await captureCliffEntities();
if (want("vulcanus-cliff-ore-direction")) await captureVulcanusCliffOreDirection();
if (want("vulcanus-cliff-removal-probability")) await captureVulcanusCliffRemovalProbability();
if (want("vulcanus-cliff-ore-direction-regions")) await captureVulcanusCliffOreDirectionRegions();
if (want("vulcanus-tile-lever")) await captureVulcanusTileLever();
if (want("vulcanus-cliff-ore-richness")) await captureVulcanusCliffOreRichness();
if (want("vulcanus-cliff-entities-more-regions")) await captureVulcanusCliffEntitiesMoreRegions();
if (want("vulcanus-cliff-entities-west-oos")) await captureVulcanusCliffEntitiesWestOos();
if (want("vulcanus-cliff-entities-border-batch")) await captureVulcanusCliffEntitiesBorderBatch();
if (want("vulcanus-ore-cliff-replication")) await captureVulcanusOreCliffReplication();
if (want("vulcanus-cliff-corner-fields")) await captureVulcanusCliffCornerFields();
if (want("vulcanus-cliff-corner-fields-entity-regions"))
  await captureVulcanusCliffCornerFieldsAtEntityRegions();
if (want("rocks")) await captureRocks();
if (want("vulcanus-cliff-entities")) await captureVulcanusCliffEntities();
if (want("vulcanus-cliff-smoothing")) await captureVulcanusCliffSmoothing();
if (want("vulcanus-cliff-smoothing-off-regions")) await captureVulcanusCliffSmoothingOffRegions();
if (want("cliff-smoothing-stencil")) await captureCliffSmoothingStencil();
if (want("vulcanus-cliff-collapsed")) await captureVulcanusCliffCollapsed();
if (want("vulcanus-elevation-levels")) await captureVulcanusElevationLevels();
if (want("multisample-grid")) await captureMultisampleGrid();
if (want("vulcanus-resource-entities")) await captureVulcanusResourceEntities();
if (want("multisample")) await captureMultisample();
if (want("vulcanus-smoke")) await captureVulcanusSmoke();
if (want("seed-vars")) await captureSeedVars();
if (want("starting-spot")) await captureStartingSpotAtAngle();
if (want("vulcanus-helpers")) await captureVulcanusHelpers();
if (want("vulcanus-spawn")) await captureVulcanusSpawn();
if (want("vulcanus-cracks")) await captureVulcanusCracks();
if (want("vulcanus-resources")) await captureVulcanusResources();
if (want("vulcanus-biomes")) await captureVulcanusBiomes();
if (want("vulcanus-climate")) await captureVulcanusClimate();
if (want("vulcanus-elevation")) await captureVulcanusElevation();
if (want("vulcanus-temperature")) await captureVulcanusTemperature();
if (want("vulcanus-tile-names")) await captureVulcanusTileNames();
if (want("vulcanus-lava-boundary")) await captureVulcanusLavaBoundary();
if (want("vulcanus-cliffs")) await captureVulcanusCliffs();
if (want("vulcanus-rocks")) await captureVulcanusRocks();
if (want("basis-output-scale")) await captureBasisOutputScale();
