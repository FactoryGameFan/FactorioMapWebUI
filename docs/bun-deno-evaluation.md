# Would bun or deno cut the CI gate wall? No - and the premise is refuted

**Status: run and closed.** Measured 2026-08-18 on this Mac (12 cores, node
26.7.0, 229 spec files, 2020 tests). Filed here so the question is not
re-derived. If it is ever revisited, read the last section first - it names the
one result that would change the answer, and it is not an install benchmark.

## The question and the premise under it

The CI gate wall is set by the four `tests` shards. CLAUDE.md's own CI section
says "import time is a first-order cost, not overhead" and records shard 3
spending 332s importing against 260s running tests. So the question was: would a
faster loader - bun or deno - cut that?

The premise is that a faster **transpiler** aims at the largest line item. It
does not.

## Where the time actually goes

Full local suite, 254.87s wall:

| phase       | time     | share      |
| ----------- | -------: | ---------: |
| tests       | 1276.42s |  67.3%     |
| import      |  564.48s |  29.8%     |
| environment |   39.50s |   2.1%     |
| **transform** | **13.37s** | **0.7%** |
| setup       |    2.27s |   0.1%     |

(The per-phase figures sum past the wall clock because workers run in parallel.)

A faster transpiler can only touch that 0.7%. **"Import" is V8 executing module
bodies, not transpiling them** - so the phase that looks like loader work is
actually the noise graph running.

## The runtimes, on identical work

One real `findIslands` pass, `ISLANDS=35` on every arm, seed 2967702466, radius
600, refineCount 3:

| arm                     | engine | time       |
| ----------------------- | ------ | ---------: |
| plain deno              | V8     |      5.17s |
| **plain node**          | **V8** | **5.40s**  |
| vitest, `src` pre-bundled | V8   |      5.46s |
| plain bun               | JSC    |      5.97s |
| bun test                | JSC    |      6.12s |
| deno test               | V8     |      5.31s |
| **vitest as it ships**  | **V8** | **21.86s** |

**bun is 10% slower than the runtime already installed.** Deno's 4% edge is
inside noise. The 4x gap is the harness, not the runtime - that was issue #267.

**The runtime half of this page still stands; the #267 half does NOT.** #267
was re-measured on 2026-09-05 and closed as refuted: its own A/B on
`test/findIslands.spec.ts` now returns **0.99x** over three interleaved rounds
per arm, 11/11 passing each time. The 4x was real and it was a property of a
99-module `src/noise/`; #227 and #371 cut that graph to 25 modules and the tax
went with it. Suite-wide, `import` fell from 29.8% to 3.8%. Do not cite the
21.86s / 5.46s rows above as a live cost - they describe a tree that no longer
exists. See `CLAUDE.md` for the current line items.

## The supply-chain guard is strictly weaker in both, and that was measured

Set a 10-year floor, then run a frozen install against a lockfile where every
pin violates it:

| tool                                     | fresh resolve   | frozen install from lockfile        |
| ---------------------------------------- | --------------- | ----------------------------------- |
| pnpm, explicit `minimumReleaseAge: 1440` | blocked         | **re-verified, every install**      |
| bun `minimumReleaseAge`                  | blocked         | **208 packages installed, exit 0**  |
| deno `--minimum-dependency-age`          | blocked, exit 1 | **installed clean, exit 0**         |

Both implement exactly pnpm's *unset default*: the age is checked at resolution
only. That is precisely the hole #184's explicit `minimumReleaseAge: 1440`
exists to close, so adopting either tool gives that property back up. Deno does
add `trust-policy=no-downgrade`, which pnpm lacks.

**Get deno's flag spelling right or you will publish a false negative.** In
`.npmrc`, a bare integer for `min-release-age` means MINUTES, and `87600h` is
silently ignored - everything installs, which reads as "no guard" when it really
means "no config". The documented forms are `deno.json`
`"minimumDependencyAge": "P3D"`, or `--minimum-dependency-age=<minutes|P3D>`.

## Neither reads `pnpm-workspace.yaml`, and the failure is silent

`package.json` has no `workspaces` field, so `bun install` and `deno install`
both exit 0 having created **no `node_modules` for either preview-service
workspace**. A silent partial install is worse than a loud failure.

Install times, which matter as little as expected: pnpm 6.47s cold / 3.16s warm,
deno 3.72s / 0.19s, bun 1.78s / 0.17s.

## Porting cost, for completeness

All 220 specs import only `describe/it/expect/vi/beforeEach/afterEach` from
`"vite-plus/test"` - one line each, so the import rewrite is trivial. The tail is
the problem: 56 `vi.fn`, 11 `vi.stubGlobal`, 8 `vi.spyOn`, fake timers,
`vi.mock`/`doMock`, 19 specs on `@vue/test-utils`, and the
`unstubGlobals`/`restoreMocks` guards that `test/mockLeakGuards.spec.ts` pins.
bun's own docs still say "Full Jest compatibility is planned". bun has no
`ImageData`, which the render path needs (deno has it natively; it was shimmed
from happy-dom for the measurement). `vp check` and `check:vue` have no
replacement in either, and Deno's own migration guidance says that rung "is
usually not worth it for an existing project".

## What would change the answer

Not an install benchmark, and not a loader benchmark. It would take a
**JSC-versus-V8 result on the noise math itself** - because the suite is 67%
test execution, and that is arithmetic, not module loading.

Note also that the byte-exactness invariant makes an engine swap a risk rather
than a neutral choice: `sin`, `cos`, `log2`, `exp` and `cbrt` already differ by
1 ULP between node, deno and bun, and node differs from deno despite both being
V8. Those agree exactly after `Math.fround`, so an op-boundary comparison
survives, but a composed f64 chain does not have that protection.
