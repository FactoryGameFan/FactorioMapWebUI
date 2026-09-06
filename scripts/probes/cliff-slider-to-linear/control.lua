-- Samples `slider_to_linear` straight out of the noise machine, at the ranges
-- the Nauvis cliff gate reads, to settle #324.
--
-- `probe_slider_to_linear` takes the slider value from `x` and picks the range
-- from `y`, so the capture positions ARE the slider positions. See data.lua for
-- why the range is a mask-sum and why the bounds stay literal.
--
-- Every slider here is a multiple of 1/256. Map positions are fixed point, so a
-- position that is not gets snapped without a word (#186), and the captured
-- slider would then not be the slider that was asked for. That is why `s = 1/3`
-- and `s = 2/3` from the issue's table are absent; they are not needed, because
-- the ranges rather than the sliders are what discriminate here.
--
-- All 13 sliders sit inside the GUI's own 1/6 to 6 domain.
local SLIDERS = { 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6 }

-- `y` selects the range. The third is a no-regression arm, not a measurement.
local RANGES = {
    { key = "narrow", y = 0 }, -- (-1, 1), read by the cliff gate's richness lever
    { key = "wide", y = 1 }, -- (-1.7, 1.7), read by its frequency lever
    { key = "fulgora", y = 2 }, -- (-50, 50), `fulgora_grid`'s already-measured range
}

-- CONTROLS, in the sense of an experiment that can fail while the hypothesis
-- holds. `s = 6` makes the ratio exactly 1 on every range, so the result is
-- exactly `hi` whatever the implementation does; `s = 1` makes it exactly 0, so
-- the result is the midpoint. Neither can discriminate the rival forms, which
-- is precisely what makes them free to fail on their own - and if they do, the
-- probe is not sampling what it thinks it is and none of the rest may be read.
--
-- Note `s = 1` is a control on `(-1, 1)` and `(-50, 50)` but a MEASUREMENT on
-- `(-1.7, 1.7)`: the midpoint of a range whose bounds are not representable in
-- f32 is not the same number depending on when you round, so that one cell is
-- the sharpest single point in the capture - exactly 0 against 4.77e-8.

local function sample()
    local surface = game.surfaces[1]

    local function read(y)
        local positions = {}
        for i = 1, #SLIDERS do
            positions[i] = { x = SLIDERS[i], y = y }
        end
        local props = surface.calculate_tile_properties({ "elevation" }, positions)
        return props.elevation
    end

    local out = { sliders = SLIDERS }
    for _, range in pairs(RANGES) do
        out[range.key] = read(range.y)
    end

    helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
    error("DUMPED-OK")
end

script.on_init(sample)
