/**
 * Regenerate `src/noise/basisGradientTable.ts`.
 *
 * Run with: node --experimental-strip-types scripts/gen-gradient-table.ts
 *
 * The table is COMMITTED rather than derived at load, and that is a
 * correctness control rather than a startup optimisation. Two reasons:
 *
 * 1. **`Math.cos` is not portable in the last bit.** #214 measured V8's
 *    `Math.cos`/`Math.sin` differing from libm on the same inputs (gradient
 *    table checksums `bc9a79394c9e8930` against `bc9a79394c9e8ae3`). A table
 *    derived at load therefore depends on which engine runs the code.
 * 2. **The Rust port has to agree bit for bit.** Rust would derive this table
 *    with libm, so a load-time derivation would put a last-bit disagreement
 *    under every planet on both sides - which is exactly the gate the port
 *    depends on (spec section 7, tier 2).
 *
 * ## The table is now MEASURED, not derived
 *
 * As of 2026-08-18 the values come from `test/fixtures/basis-gradient-table.json`,
 * recovered from the running game by `scripts/recover-gradient-table.ts` from a
 * capture this repo can re-take (`scripts/probes/basis-gradient/`, run through
 * `factorio-oracle`). That took the fixture score from 473 of 512 exact to
 * **512 of 512, worst error 0**. 28 of the 256 slots differ from the formula.
 *
 * The formula is kept below as `formulaTable()`, unused by the emit path, and
 * that is deliberate rather than dead code: it is the only reproducible record
 * of what a derived table scores, and the 384-variant sweep behind it is the
 * reason anyone knows the fold order matters. Read the two together.
 *
 * The formula was not a guess. It was picked by sweeping 384 kernel and
 * table variants against both committed fixtures and scoring by EXACT f32
 * match count, not by an error bound - every value in both fixtures is exactly
 * f32, so a bit-exact port reproduces them exactly and a bound cannot tell
 * "close" from "identical". Results on `basis-noise.seed123456.json`:
 *
 * | table construction                            | exact   | worst   |
 * | --------------------------------------------- | ------- | ------- |
 * | f64 angle, f64 trig, *4.2, narrow (old shape) | 208/512 | 2.682e-7 |
 * | f64 angle, narrowed trig, *f32(4.2)           | 147/512 | 2.533e-7 |
 * | f32 angle, narrowed trig, *f32(4.2)           | 234/512 | 2.384e-7 |
 * | **f32 angle, trig then *4.2, ONE narrowing**  | **473/512** | **1.192e-7** |
 *
 * So the angle is computed in f32 and everything after it rounds once. The
 * remaining 39 points are 1-2 ULP apart bar a few near-zero cancellations,
 * which is consistent with the game's own table coming from a minimax
 * polynomial (`docs/noise/basis-noise-NOTES.md`) rather than from libm. The
 * measured table confirms that reading: it is not the f32-angle formula, and
 * the 39 misses were the game's table all along rather than our arithmetic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TABLE_SIZE = 256;
const GRADIENT_MAGNITUDE = 4.2;
const f = Math.fround;

/**
 * What the formula produces. Kept for the comparison above, never emitted.
 *
 * `test/basisGradientTable.spec.ts` runs the real kernel against this table and
 * scores it, so the 473-versus-512 claim stays reproducible rather than a number
 * in a comment. That file, not a script - it needs `vi.mock`, which is hoisted
 * and file-scoped, so the swap cannot be confined to one test.
 */
export function formulaTable(): { gx: number[]; gy: number[] } {
  /** The f32 angle for slot `h`. Narrowing HERE is what the sweep selected. */
  const angle = (h: number): number => f((2 * Math.PI * h) / TABLE_SIZE);
  return {
    gx: Array.from({ length: TABLE_SIZE }, (_, h) => f(Math.cos(angle(h)) * GRADIENT_MAGNITUDE)),
    gy: Array.from({ length: TABLE_SIZE }, (_, h) => f(Math.sin(angle(h)) * GRADIENT_MAGNITUDE)),
  };
}

const measured = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "test", "fixtures", "basis-gradient-table.json"),
    "utf8",
  ),
) as { gradientX: number[]; gradientY: number[] };

const gx = measured.gradientX;
const gy = measured.gradientY;
if (gx.length !== TABLE_SIZE || gy.length !== TABLE_SIZE) {
  throw new Error(`measured table has ${gx.length}/${gy.length} slots, expected ${TABLE_SIZE}`);
}
for (const v of [...gx, ...gy]) {
  // The recovery narrows every slot before writing. If that ever stops being
  // true the literals below would round and the emitted table would not be the
  // measured one.
  if (f(v) !== v) throw new Error(`measured slot ${v} is not exactly f32`);
}

/**
 * The shortest decimal that narrows back to the same f32.
 *
 * Not cosmetic. A default `${v}` prints the shortest round-trip for the f64,
 * which for these values runs to 17 significant digits - more than f64
 * represents exactly, so `eslint(no-loss-of-precision)` flags it. Every f32
 * needs at most 9, and any f64 within half an f32 ULP narrows to the same f32,
 * so this is exact where it matters: `new Float32Array([...])` stores the
 * identical bits. Asserted per entry below before anything is written.
 */
const shortestF32Literal = (v: number): string => {
  for (let digits = 1; digits <= 17; digits++) {
    const candidate = Number(v.toPrecision(digits));
    if (f(candidate) === v) return String(candidate);
  }
  throw new Error(`no round-tripping literal for ${v}`);
};

const column = (values: number[]): string => {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += 4) {
    lines.push(
      "  " +
        values
          .slice(i, i + 4)
          .map((v) => `${shortestF32Literal(v)},`)
          .join(" "),
    );
  }
  return lines.join("\n");
};

const body = `/**
 * The \`basis_noise\` gradient table, with the magnitude folded in.
 *
 * GENERATED by scripts/gen-gradient-table.ts - do not hand-edit. Read that
 * file for why these are committed constants rather than \`Math.cos\` calls at
 * load, and for how the values were measured.
 *
 * These are RECOVERED FROM THE GAME, not computed from a formula. The source is
 * \`test/fixtures/basis-gradient-table.json\`, inverted out of a capture of
 * \`basis_noise\` sampled 1/256 off the lattice
 * (\`scripts/probes/basis-gradient/\`, run through factorio-oracle). The nearest
 * formula, \`f32(cos(f32(2*pi*h/256)) * 4.2)\`, differs in 28 of 256 slots and
 * scores 473 of 512 against \`basis-noise.seed123456.json\` where these score
 * 512 of 512, worst error 0.
 *
 * The 4.2 is the gradient magnitude, measured at 4.19999919 +/- 1.4e-6 across
 * 9216 lattice points; folding it into the table rather than multiplying by it
 * at evaluation time is what the game does, and the fixtures discriminate:
 * folded scores 166/512 exact against 123/512 for a separate multiply, at the
 * same fold order.
 *
 * A \`Float32Array\` rather than a plain array so the element type states the
 * invariant instead of a comment claiming it.
 */
export const GRADIENT_X = new Float32Array([
${column(gx)}
]);

export const GRADIENT_Y = new Float32Array([
${column(gy)}
]);
`;

const out = join(import.meta.dirname, "..", "src", "noise", "basisGradientTable.ts");
writeFileSync(out, body);

/**
 * The same 256 slots, for the Rust port.
 *
 * ONE generator emits both sides, and that is the point rather than a
 * convenience. The tier-2 gate compares the two ports bit for bit, so a table
 * that differed between them would fail as a kernel bug and send someone
 * hunting in the arithmetic. Two generators reading one fixture would agree
 * today - both `Number()` and Rust's `str::parse` are correctly rounded - but
 * "agree today" is the shape of claim this repo keeps having to re-measure. One
 * read of the file cannot disagree with itself.
 *
 * `shortestF32Literal` is what makes emitting a DECIMAL safe here: it returns
 * the shortest decimal that narrows back to the same f32, asserted per entry,
 * and Rust's float-literal parsing is correctly rounded too - so rustc stores
 * the identical bits. No slot is integer-valued (checked: 0 of 512), so every
 * literal carries a `.` or an exponent and is a float literal rather than an
 * integer one.
 */
const rustColumn = (values: number[]): string => {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += 4) {
    lines.push(
      "    " +
        values
          .slice(i, i + 4)
          .map((v) => {
            const lit = shortestF32Literal(v);
            // A literal with neither a point nor an exponent is an INTEGER
            // literal in Rust, and `[f32; 256]` containing one does not compile.
            // Cheap to assert, and it fails at generate time rather than in a
            // cargo error someone has to read backwards.
            if (!/[.e]/.test(lit)) throw new Error(`slot ${v} emits integer literal ${lit}`);
            return `${lit},`;
          })
          .join(" "),
    );
  }
  return lines.join("\n");
};

const rustBody = `//! The \`basis_noise\` gradient table, with the magnitude folded in.
//!
//! GENERATED by scripts/gen-gradient-table.ts - do not hand-edit. The SAME run
//! of that script writes \`src/noise/basisGradientTable.ts\`, from the same read
//! of the same fixture, so the two ports cannot hold different tables.
//!
//! These are RECOVERED FROM THE GAME, not computed from a formula
//! (\`test/fixtures/basis-gradient-table.json\`, inverted out of a capture of
//! \`basis_noise\` sampled 1/256 off the lattice by
//! \`scripts/probes/basis-gradient/\` through factorio-oracle). The nearest
//! formula, \`f32(cos(f32(2*pi*h/256)) * 4.2)\`, differs in 28 of 256 slots and
//! scores 473 of 512 against \`basis-noise.seed123456.json\` where these score
//! 512 of 512, worst error 0.
//!
//! Deriving the table here instead would reintroduce exactly the hazard #214
//! measured: V8's \`Math.cos\` and libm's disagree in the last bit, so a Rust
//! table built from the formula would differ from the TypeScript one under
//! every planet. Reading committed bytes removes that class of bug rather than
//! managing it.

/// Gradient x components, indexed by direction 0..=255.
///
/// \`rustfmt::skip\` so this file is IDEMPOTENT: without it rustfmt re-wraps the
/// array to fill the line width, a regeneration no longer matches what is
/// committed, and \`cargo fmt --check\` fails inside \`verify:rust\` for a file
/// nobody edited. Measured 2026-08-18 - it is how this note came to exist.
#[rustfmt::skip]
pub const GRADIENT_X: [f32; 256] = [
${rustColumn(gx)}
];

/// Gradient y components, indexed by direction 0..=255. See [\`GRADIENT_X\`] for
/// why the formatter is held off.
#[rustfmt::skip]
pub const GRADIENT_Y: [f32; 256] = [
${rustColumn(gy)}
];
`;

const rustOut = join(
  import.meta.dirname,
  "..",
  "crates",
  "fmw-noise",
  "src",
  "basis_gradient_table.rs",
);
writeFileSync(rustOut, rustBody);

console.log(`wrote ${out}`);
console.log(`wrote ${rustOut}`);
console.log(`gx[0]=${gx[0]} gx[64]=${gx[64]} gy[64]=${gy[64]} gx[128]=${gx[128]}`);
