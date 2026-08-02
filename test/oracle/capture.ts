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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type TileSample,
} from "./oracle.ts";
import { TREE_SPECIES } from "../../src/noise/trees/treeCatalog.ts";

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
  // offsets keep points off the lattice. These are the parity-tested points.
  for (const r of [2200, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
    positions.push({ x: 1200 * Math.cos(a) + 0.5, y: 1200 * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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
    positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
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

if (!oracleAvailable()) {
  console.error("No Factorio binary found (set FACTORIO_BIN). Cannot capture fixtures.");
  process.exit(1);
}

// Optional CLI filter: names on argv restrict which fixtures regenerate (so a new
// capture need not re-run the others). No args = capture everything.
const only = process.argv.slice(2);
const want = (name: string) => only.length === 0 || only.includes(name);

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

if (want("cliff-entities")) await captureCliffEntities();
if (want("vulcanus-ore-cliff-replication")) await captureVulcanusOreCliffReplication();
if (want("vulcanus-cliff-corner-fields")) await captureVulcanusCliffCornerFields();
if (want("vulcanus-cliff-corner-fields-entity-regions"))
  await captureVulcanusCliffCornerFieldsAtEntityRegions();
if (want("rocks")) await captureRocks();
if (want("vulcanus-cliff-entities")) await captureVulcanusCliffEntities();
if (want("vulcanus-cliff-smoothing")) await captureVulcanusCliffSmoothing();
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
