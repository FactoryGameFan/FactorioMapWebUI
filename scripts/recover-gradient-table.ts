/**
 * Recover `basis_noise`'s gradient table from a capture of the running game.
 *
 * Run with:
 *   node scripts/recover-gradient-table.ts <capture.json> <out.json>
 *
 * This file deliberately imports nothing from `src/`. It produces the table
 * that `src/noise/basisGradientTable.ts` is generated from, so depending on
 * that module would be circular, and labelling the slots by angle rather than
 * by our own seeding reimplementation keeps the result independent of it. The
 * spec cross-checks the two afterwards, which is a control that can fail.
 *
 * ## Why two corners and not one
 *
 * `docs/noise/basis-noise-NOTES.md` says a sample at `(I + 1/256, J)`
 * "isolates the (I,J) corner". It does not. `d` in the game's kernel is the
 * SQUARED distance, so the corner at (1,0) sits at d = 0.9922, inside the
 * falloff's support, and contributes. Measured 2026-08-18: its term is 1.209e-4
 * of the near term, which is 1014x f32 epsilon. An inversion that drops it
 * recovers 2 of 256 slots while looking entirely plausible.
 *
 * Isolation is not merely awkward, it is impossible. Leaving only the (0,0)
 * corner needs `fy^2 >= fx(2-fx)` and `fx^2 >= fy(2-fy)` at once, which give
 * `fy^2 > fx` and `fx^2 > fy`, hence `fy^4 > fy` and `fy > 1`. A scan of the
 * unit cell agrees: every interior point has two or more live corners.
 *
 * ## The three stages
 *
 * 1. **Label.** Invert with one corner, which is good to about four digits -
 *    ample to read the direction index off `atan2`. This is what ties a slot
 *    number to a physical angle, and it needs no seeding tables.
 * 2. **Solve.** Knowing both corners' slots, subtract the far term and iterate.
 *    Seeded from zeros, so no existing table is an input. Converges in two
 *    rounds; further rounds do not move it.
 * 3. **Polish.** Each slot is now within an ULP. Try the neighbours and keep
 *    whichever reproduces the most captured samples. Scored against the probe's
 *    own samples, never against the fixture it will later be tested on.
 */
import { readFileSync, writeFileSync } from "node:fs";

const f = Math.fround;
const SLOTS = 256;
const TAU = Math.PI * 2;

const bits = new Float32Array(1);
const asInt = new Int32Array(bits.buffer);
/** The f32 `steps` ULPs away from `x`, away from zero for negatives. */
function ulpAway(x: number, steps: number): number {
  bits[0] = x;
  asInt[0] += x >= 0 ? steps : -steps;
  return bits[0];
}

type Capture = {
  seed0: number;
  seed1: number;
  eps: number;
  rows: number;
  along_x: number[];
  along_y: number[];
  on_lattice: number[];
};

export type Recovery = {
  gradientX: number[];
  gradientY: number[];
  /** Captured samples the recovered table reproduces exactly, out of `samples`. */
  reproduced: { x: number; y: number; samples: number };
  /** Slot index per lattice point, from `atan2`. Lets a reader re-check stage 1. */
  slotOfLattice: number[];
  worstMagnitudeError: number;
};

export function recover(cap: Capture): Recovery {
  const eps = f(cap.eps);
  // Both corners' coefficients are the same at every lattice point; only which
  // slot they land on varies.
  const dNear = f(eps * eps);
  const tNear = f(1 - dNear);
  const fallNear = f(tNear * f(tNear * tNear));
  const dxFar = f(eps - 1);
  const dFar = f(dxFar * dxFar);
  const tFar = f(1 - dFar);
  const fallFar = f(tFar * f(tFar * tFar));

  // The capture holds one row more than it makes equations from. Along y the
  // far corner is the next row, and the last equation row needs a row beyond
  // itself to look up. Wrapping to row 0 instead is not a small error: it
  // poisons 256 of 4096 equations and takes the y table from 4092 reproduced
  // samples to 148. Measured 2026-08-18.
  const stored = (cap.rows + 1) * SLOTS;
  const n = cap.rows * SLOTS;
  if (cap.along_x.length !== stored || cap.along_y.length !== stored) {
    throw new Error(
      `capture has ${cap.along_x.length} samples, expected ${stored} (${cap.rows} rows plus one for lookup)`,
    );
  }

  // Stage 1: label. One corner is enough to read the angle.
  const slot = new Int32Array(stored);
  for (let k = 0; k < stored; k++) {
    const gx = cap.along_x[k] / (fallNear * eps);
    const gy = cap.along_y[k] / (fallNear * eps);
    slot[k] = ((Math.round((Math.atan2(gy, gx) / TAU) * SLOTS) % SLOTS) + SLOTS) % SLOTS;
  }
  const at = (i: number, j: number) => slot[j * SLOTS + i];

  type Sample = { near: number; far: number; v: number };
  const xs: Sample[] = [];
  const ys: Sample[] = [];
  for (let j = 0; j < cap.rows; j++) {
    for (let i = 0; i < SLOTS; i++) {
      const k = j * SLOTS + i;
      // Along x the far corner is (i+1) mod 256, and a whole row covers all
      // 256 i, so that wrap is the game's own. Along y it is the next row,
      // which is why the capture stores one row more than it solves with.
      xs.push({ near: at(i, j), far: at((i + 1) % SLOTS, j), v: cap.along_x[k] });
      ys.push({ near: at(i, j), far: at(i, j + 1), v: cap.along_y[k] });
    }
  }

  const forward = (near: number, far: number) =>
    f(f(f(eps * near) * fallNear) + f(f(dxFar * far) * fallFar));

  const solve = (samples: Sample[]) => {
    // Stage 2: iterate from zeros.
    let est = new Float32Array(SLOTS);
    for (let round = 0; round < 3; round++) {
      const total = new Float64Array(SLOTS);
      const count = new Int32Array(SLOTS);
      for (const s of samples) {
        total[s.near] += (s.v - fallFar * dxFar * est[s.far]) / (fallNear * eps);
        count[s.near]++;
      }
      const next = new Float32Array(SLOTS);
      for (let g = 0; g < SLOTS; g++) next[g] = f(total[g] / Math.max(count[g], 1));
      est = next;
    }
    // Stage 3: polish, scored on the captured samples themselves.
    const bySlot: Sample[][] = Array.from({ length: SLOTS }, () => []);
    for (const s of samples) bySlot[s.near].push(s);
    let reproduced = 0;
    for (let pass = 0; pass < 4; pass++) {
      reproduced = 0;
      for (let g = 0; g < SLOTS; g++) {
        let best = est[g];
        let bestScore = -1;
        for (let d = -2; d <= 2; d++) {
          const candidate = ulpAway(est[g], d);
          let score = 0;
          for (const s of bySlot[g]) if (forward(candidate, est[s.far]) === s.v) score++;
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        est[g] = best;
        reproduced += bestScore;
      }
    }
    return { est, reproduced };
  };

  const rx = solve(xs);
  const ry = solve(ys);

  let worstMagnitudeError = 0;
  for (let g = 0; g < SLOTS; g++) {
    worstMagnitudeError = Math.max(
      worstMagnitudeError,
      Math.abs(Math.hypot(rx.est[g], ry.est[g]) - 4.2),
    );
  }

  return {
    gradientX: Array.from(rx.est),
    gradientY: Array.from(ry.est),
    reproduced: { x: rx.reproduced, y: ry.reproduced, samples: n },
    slotOfLattice: Array.from(slot),
    worstMagnitudeError,
  };
}

if (process.argv[1]?.endsWith("recover-gradient-table.ts")) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node scripts/recover-gradient-table.ts <capture.json> <out.json>");
    process.exit(2);
  }
  const cap: Capture = JSON.parse(readFileSync(inPath, "utf8"));
  const bad = cap.on_lattice.filter((v) => v !== 0).length;
  if (bad > 0) {
    console.error(`${bad} of ${cap.on_lattice.length} on-lattice samples are not 0.`);
    console.error(
      "The game returns exactly 0 there, so the capture is not measuring what it should.",
    );
    process.exit(1);
  }
  const r = recover(cap);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        _comment:
          "Recovered from a capture of the running game by scripts/recover-gradient-table.ts. " +
          "Not derived from a formula. See that file for why two corners contribute and why " +
          "docs/noise/basis-noise-NOTES.md was wrong about isolation.",
        seed0: cap.seed0,
        seed1: cap.seed1,
        eps: cap.eps,
        reproduced: r.reproduced,
        worstMagnitudeError: r.worstMagnitudeError,
        gradientX: r.gradientX,
        gradientY: r.gradientY,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `reproduced ${r.reproduced.x}/${r.reproduced.samples} x and ${r.reproduced.y}/${r.reproduced.samples} y samples`,
  );
  console.log(`worst |magnitude - 4.2| = ${r.worstMagnitudeError.toExponential(3)}`);
  console.log(`wrote ${outPath}`);
}
