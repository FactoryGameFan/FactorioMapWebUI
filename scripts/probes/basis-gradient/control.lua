-- Samples basis_noise just off the lattice, so the gradient table can be
-- recovered by inverting the falloff rather than guessed from a formula.
--
-- Two corners contribute at every sample, not one. `d` in the game's kernel is
-- the SQUARED distance, so the corner at (1,0) has d = 0.9922 < 1 and is not
-- selected away. Its term is about 1.2e-4 of the near term, which is 1014x f32
-- epsilon, so an inversion that ignores it recovers 2 of 256 slots rather than
-- 254. Measured 2026-08-18. docs/noise/basis-noise-NOTES.md says this offset
-- "isolates the (I,J) corner"; it does not, and cannot - isolation would need
-- fy^2 > fx and fx^2 > fy at once, which forces fy > 1.
--
-- 16 rows is not arbitrary. `a` and `sigma` are permutations, so one row of 256
-- I values already touches all 256 gradient slots exactly once. Sixteen rows
-- give 16 independent samples per slot, which is what lets disagreement between
-- them fail rather than average away.
--
-- One extra row is sampled beyond those 16, and it is not spare. Along x the
-- far corner is `(i+1) mod 256`, and a whole row covers all 256 i, so that wrap
-- is real. Along y the far corner is row `j+1`, whose true wrap is mod 256 rows,
-- not mod 16. Without row 16 the last row's far corner has to be guessed, and
-- wrapping it to row 0 instead poisons 256 of 4096 equations - enough to drag
-- the recovered y table from 4092 of 4096 samples down to 148. Measured
-- 2026-08-18. The extra row is read for its slot only, never for an equation.
local ROWS = 16
local EPS = 1 / 256

local function sample()
    local surface = game.surfaces[1]

    local along_x = {}
    local along_y = {}
    for j = 0, ROWS do
        for i = 0, 255 do
            along_x[#along_x + 1] = { x = i + EPS, y = j }
            along_y[#along_y + 1] = { x = i, y = j + EPS }
        end
    end

    -- A control that can fail: exactly on a lattice point every corner offset
    -- is zero, so the dot product is zero and the game must return 0. If these
    -- come back non-zero the sampling is not measuring what it thinks it is.
    local on_lattice = {}
    for j = 0, 3 do
        for i = 0, 3 do
            on_lattice[#on_lattice + 1] = { x = i, y = j }
        end
    end

    local function read(positions)
        local props = surface.calculate_tile_properties({ "elevation" }, positions)
        return props.elevation
    end

    helpers.write_file(
        "oracle-dump.json",
        helpers.table_to_json({
            seed0 = 123456,
            seed1 = 0,
            input_scale = 1,
            eps = EPS,
            rows = ROWS,
            along_x = read(along_x),
            along_y = read(along_y),
            on_lattice = read(on_lattice),
        })
    )
    error("DUMPED-OK")
end

script.on_init(sample)
