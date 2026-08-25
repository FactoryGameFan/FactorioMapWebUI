-- Dumps every autoplace control's `can_be_disabled` and `category` straight
-- from the running game. That dict is the ground truth `test/catalog.spec.ts`
-- grades `src/model/controlCatalog.ts` against, key for key.
--
-- ## Why re-capture something that was already right
--
-- `test/fixtures/autoplace-can-be-disabled.dump.json` was the last entry in
-- `test/fixtures/PROVENANCE.json` carrying `factorioVersion: "unknown"` (#295,
-- suggestion 4). It was committed 2026-07-12, between the 2.1.9 and 2.1.11
-- eras, and nobody wrote down which binary produced it.
--
-- `docs/fixture-version-audit.md` sets the rule that made a re-capture the only
-- move available: never promote an `inferred` or `unknown` entry on the
-- strength of a clean data diff, because a diff confirms that a file did not
-- change without establishing what produced the fixture in the first place.
-- Only a fresh capture against a named binary can do that.
--
-- ## Two traps, both cheap to walk into
--
-- `prototypes.autoplace_control` is the 2.x spelling.
-- `game.autoplace_control_prototypes` was 1.x and is simply nil here, which
-- iterates zero times rather than raising - so a wrong spelling produces an
-- empty dump that looks like a successful run.
--
-- And the DLC is what makes the set 28 rather than 6: `calcite`, `scrap`,
-- `gleba_stone` and the rest arrive with `space-age`. The oracle loads whatever
-- a default install loads, so nothing here enables it, but a run that quietly
-- lost it would still write a well-formed dump. Both are asserted below.
local EXPECTED_CONTROLS = 28

local function dump()
    local out = {}
    local count = 0
    for name, proto in pairs(prototypes.autoplace_control) do
        out[name] = {
            can_be_disabled = proto.can_be_disabled,
            category = proto.category,
        }
        count = count + 1
    end

    -- Controls that can fail, in the order they discriminate: an empty dump
    -- first, then the DLC, then the exact size.
    assert(count > 0, "prototypes.autoplace_control iterated zero times")
    assert(out["calcite"] ~= nil, "space-age is not loaded - the dump would be short")
    assert(
        count == EXPECTED_CONTROLS,
        "expected " .. EXPECTED_CONTROLS .. " autoplace controls, got " .. count
    )

    -- The name is the tool's contract, not the game's. `helpers.write_file`
    -- accepts any name and the run reports failure anyway.
    helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
    -- Non-zero exit IS success here: the tool keys `create` off the dump
    -- appearing, not off the exit code.
    error("DUMPED-OK")
end

script.on_init(dump)
