/**
 * Capture map-exchange strings from a Factorio build, one per settings case.
 *
 * Run deliberately, never in CI - it needs a local Factorio install and it
 * writes committed fixtures:
 *
 *   node --experimental-strip-types scripts/probes/exchange-format/capture.ts 2.1.15
 *
 * ## Why this exists at all
 *
 * The exchange format is versioned and the game moves it without warning. It has
 * broken import three times - 2.1.12, 2.1.14 and 2.1.15 - and each fix needs the
 * same thing: real strings from the new build, proving a byte-exact round-trip.
 * `SUPPORTED_VERSIONS` is a known-good list precisely so an unseen layout is
 * refused rather than decoded on a guess, and the price of that is a capture per
 * version. The first two were run by hand and left only a recipe in a comment.
 *
 * ## The cases are DERIVED from the previous version's fixture, not retyped
 *
 * `test/mapExchangeVersions.spec.ts` says the five 2.1.14 cases "mirror the
 * 2.1.12 fixture setting-for-setting". Retyping five settings tables into Lua
 * makes that a claim. Parsing the previous fixture's own strings with the game's
 * `helpers.parse_map_exchange_string` and feeding the result back as
 * `--map-gen-settings` makes it a mechanism: one source for what a case IS.
 *
 * ## The cases are fed back as a DELTA, and that is the whole trick
 *
 * The obvious shape - parse each old string and feed the WHOLE result back as
 * `--map-gen-settings` - was tried and produces the wrong fixture. Measured on
 * 2.1.15, payload bytes after inflate:
 *
 *   | settings file handed to the game | payload |
 *   | -------------------------------- | ------: |
 *   | none, or `{}`                    |     711 |
 *   | only `peaceful_mode`             |     711 |
 *   | only `starting_area`             |     711 |
 *   | only `cliff_settings`            |     711 |
 *   | two explicit `autoplace_controls`|     749 |
 *   | all 28 `autoplace_controls`      |    1387 |
 *
 * The exchange string writes only the autoplace controls that were EXPLICITLY
 * supplied, and `parse_map_exchange_string` fills all 28 in. So feeding a parse
 * straight back inflates every case to 1387 bytes - which silently destroys the
 * reason there are five cases, since they exist to VARY the layout. All five
 * would become the same length, differing only in fixed-width scalars.
 *
 * Feeding back only the keys that differ from the DEFAULT case reproduces the
 * previous fixture's own shape: 711 for the four scalar cases and ~750 for
 * `controls-off`, against 711/711/750/711/711 committed at 2.1.14.
 *
 * `autoplace_settings` is dropped outright: the game's parse returns `{}` for it
 * where the live surface has it fully populated, so it is lossy in the parse
 * direction and carries no case information.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = join(REPO, "test", "fixtures");
const ORACLE = join(homedir(), ".cargo", "bin", "factorio-oracle");

/**
 * The newest committed strings fixture OLDER than the one being captured.
 *
 * Derived rather than pinned. A hardcoded source version is the same shape of
 * bug as a hardcoded `FACTORIO_TARGET_VERSION`: it would keep working, silently
 * mirroring a version further and further behind, and nothing would fail.
 */
async function sourceVersionFor(target: string): Promise<string> {
  const names = await readdir(FIXTURES);
  const older = names
    .map((n) => /^map-exchange-(\d+\.\d+\.\d+)\.strings\.json$/.exec(n)?.[1])
    .filter((v): v is string => v !== undefined && cmpVersion(v, target) < 0);
  if (older.length === 0) {
    throw new Error(`no committed strings fixture older than ${target} to mirror`);
  }
  return older.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b));
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface StringsFixture {
  readonly _comment: string;
  readonly _factorioVersion: string;
  readonly _exchangeFormatTag: string;
  readonly strings: Record<string, string>;
}

/**
 * The four-part exchange format tag, read out of a string this run just
 * captured.
 *
 * **This used to be `process.env.EXCHANGE_TAG ?? ""`, and nobody ever set it.**
 * The field defaulted to empty silently, so `map-exchange-2.1.15.strings.json`
 * and `map-exchange-2.1.16.strings.json` were both committed carrying `""`
 * where 2.1.14 carried `"2.1.14.1"`. An empty metadata field looks like "not
 * applicable" rather than "the capture forgot", which is why two versions went
 * by without anyone noticing. Deriving it removes the way to get it wrong.
 *
 * Both were backfilled in the same commit that added this function, from their
 * own committed strings, so no fixture carries an empty tag now - and
 * `test/mapExchangeVersions.spec.ts` fails if one ever does again.
 *
 * The tag is the first four `u16` LE of the inflated payload - the same bytes
 * `decodeExchangeString` reads. This does it with `node:zlib` rather than by
 * importing the codec, because the point of the field is to record what the
 * GAME emitted; deriving it through our own decoder would make the fixture
 * agree with the codec by construction, and the tag is one of the things
 * `test/mapExchangeVersions.spec.ts` asserts.
 */
function formatTagOf(exchangeString: string): string {
  const compact = exchangeString.replaceAll(/\s+/g, "");
  if (!compact.startsWith(">>>") || !compact.endsWith("<<<")) {
    throw new Error("captured string is missing its >>> <<< envelope");
  }
  const payload = inflateSync(Buffer.from(compact.slice(3, -3), "base64"));
  if (payload.length < 8) {
    throw new Error(`captured payload too short to hold a version (${payload.length} bytes)`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, 8);
  return [0, 2, 4, 6].map((o) => view.getUint16(o, true)).join(".");
}

/**
 * Run one probe and return its dump.
 *
 * `error("DUMPED-OK")` makes Factorio exit non-zero on a SUCCESSFUL run, and
 * the tool keys success off the dump file appearing rather than off the exit
 * code - so a throw here is expected and the dump read is the real check.
 */
async function probe(
  controlLua: string,
  target: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const probeDir = await mkdtemp(join(tmpdir(), "exchange-probe-"));
  const controlPath = join(probeDir, "control.lua");
  const probePath = join(probeDir, "probe.json");
  await writeFile(controlPath, controlLua);
  await writeFile(
    probePath,
    JSON.stringify(
      {
        mode: "create",
        mod: {
          name: "exchange_format_probe",
          version: "0.0.1",
          dependencies: ["base"],
          control_lua_file: controlPath,
        },
        timeout_seconds: 300,
        ...extra,
      },
      null,
      2,
    ),
  );

  const workDir = await mkdtemp(join(tmpdir(), "exchange-work-"));
  try {
    await run(ORACLE, ["run", "--probe", probePath, "--work-dir", workDir, "--version", target], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // Expected: see the DUMPED-OK note above.
  }
  const dumpPath = join(workDir, "write", "script-output", "oracle-dump.json");
  return JSON.parse(await readFile(dumpPath, "utf8")) as unknown;
}

/**
 * Phase A: read the previous version's cases back out through the game's parser.
 *
 * Base64 goes in a Lua long bracket so `+`, `/` and `=` survive verbatim. `]==]`
 * cannot occur in base64, which has no `]`, so the delimiter is unambiguous.
 * `script.on_init` is registered exactly ONCE - a second registration silently
 * replaces the first with no error, which is the quietest way to lose a capture.
 */
function settingsLua(cases: Record<string, string>): string {
  const entries = Object.entries(cases)
    .map(([label, s]) => `  { label = ${JSON.stringify(label)}, source = [==[${s}]==] },`)
    .join("\n");
  return `-- GENERATED by scripts/probes/exchange-format/capture.ts. Do not edit.
local CASES = {
${entries}
}

script.on_init(function()
  local out = {}
  for _, case in ipairs(CASES) do
    -- That this parse SUCCEEDS on a newer build is the export-direction check:
    -- it says the newer game still reads what the older one wrote, which is the
    -- half that has never broken and should be seen to keep working.
    local parsed = helpers.parse_map_exchange_string(case.source)
    out[#out + 1] = { label = case.label, map_gen_settings = parsed.map_gen_settings }
  end
  helpers.write_file(
    "oracle-dump.json",
    helpers.table_to_json({ version = script.active_mods["base"], cases = out })
  )
  error("DUMPED-OK")
end)
`;
}

/** Phase B: one map created per case, then the string the GAME writes for it. */
const PRODUCE_LUA = `-- GENERATED by scripts/probes/exchange-format/capture.ts. Do not edit.
script.on_init(function()
  local produced = game.get_map_exchange_string()
  helpers.write_file(
    "oracle-dump.json",
    helpers.table_to_json({
      version = script.active_mods["base"],
      produced = produced,
      -- Parsed back by the SAME build, so the fixture can be cross-validated
      -- against the game's own reading rather than only against our re-encode.
      reparsed = helpers.parse_map_exchange_string(produced),
    })
  )
  error("DUMPED-OK")
end)
`;

type Settings = Record<string, unknown>;

/**
 * The keys of `c` that differ from the default case, and nothing else.
 *
 * `autoplace_controls` is narrowed entry by entry rather than taken whole,
 * because supplying all 28 doubles the payload (see the table above) while
 * supplying the two a case actually changes reproduces the previous fixture's
 * own size. `autoplace_settings` is dropped: the game's parse returns `{}` for
 * it where the live surface has it populated, so it is lossy in the parse
 * direction and carries no case information. `seed` is dropped because it goes
 * in as the probe's own seed - `--map-gen-seed` OVERRIDES the settings file, so
 * a case that set only the file would capture at the wrong seed.
 */
function delta(base: Settings, c: Settings): Settings {
  const out: Settings = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of Object.entries(c)) {
    if (k === "autoplace_settings" || k === "seed") continue;
    if (same(base[k], v)) continue;
    if (k === "autoplace_controls") {
      const b = (base[k] ?? {}) as Settings;
      const changed = Object.fromEntries(
        Object.entries(v as Settings).filter(([name, ctl]) => !same(b[name], ctl)),
      );
      if (Object.keys(changed).length > 0) out[k] = changed;
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: capture.ts <version>   e.g. 2.1.15");
    process.exit(2);
  }

  const sourceVersion = await sourceVersionFor(target);
  const source = JSON.parse(
    await readFile(join(FIXTURES, `map-exchange-${sourceVersion}.strings.json`), "utf8"),
  ) as StringsFixture;
  const labels = Object.keys(source.strings);
  console.log(`cases from ${sourceVersion}: ${labels.join(", ")}`);

  console.log("phase A: reading each case's settings back through the game's parser");
  const settingsDump = (await probe(settingsLua(source.strings), target)) as {
    version: string;
    cases: { label: string; map_gen_settings: Record<string, unknown> }[];
  };
  const gameVersion = settingsDump.version;
  console.log(`  game reports base ${gameVersion}`);

  const base = settingsDump.cases[0].map_gen_settings;
  const strings: Record<string, string> = {};
  let firstReparsed: unknown;
  for (const c of settingsDump.cases) {
    const seed = c.map_gen_settings.seed as number;
    const settings = delta(base, c.map_gen_settings);
    const keys = Object.keys(settings);
    console.log(`phase B: ${c.label} (seed ${seed}) settings: ${keys.join(", ") || "(none)"}`);
    const out = (await probe(PRODUCE_LUA, target, {
      ...(keys.length > 0 ? { map_gen_settings: settings } : {}),
      seed,
    })) as { produced: string; reparsed: unknown };
    strings[c.label] = out.produced;
    firstReparsed ??= out.reparsed;
  }

  const tag = formatTagOf(strings[settingsDump.cases[0].label]);
  await writeFile(
    join(FIXTURES, `map-exchange-${gameVersion}.strings.json`),
    `${JSON.stringify(
      {
        _comment:
          `Map-exchange strings produced by Factorio ${gameVersion} via game.get_map_exchange_string(), ` +
          `five cases mirroring map-exchange-${sourceVersion}.strings.json setting-for-setting - each case's ` +
          `map-gen settings are the game's OWN parse of that fixture's string for the same case, fed back ` +
          `as --map-gen-settings, so the mirror is a mechanism rather than a claim. ` +
          `Regenerate: node --experimental-strip-types scripts/probes/exchange-format/capture.ts ${gameVersion}`,
        _factorioVersion: gameVersion,
        _exchangeFormatTag: tag,
        strings,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(FIXTURES, `map-exchange-parsed.${gameVersion}-default.dump.json`),
    `${JSON.stringify(firstReparsed, null, 2)}\n`,
  );
  console.log(`wrote fixtures for ${gameVersion}`);
}

await main();
