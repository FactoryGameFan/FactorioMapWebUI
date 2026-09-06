-- READ-ONLY COPY. The live text is the inline `data_lua` string in probe.json.
-- factorio-oracle reads `control_lua_file`, but `data_lua` is inline ONLY -
-- there is no `data_lua_file`. Change probe.json first, then mirror it here.
--
-- Grades the two rival `slider_to_linear` implementations (#324) against the
-- game, at the two ranges the Nauvis cliff gate reads.
--
-- `slider_to_linear` is a noise FUNCTION, not a Lua helper
-- (`core/prototypes/noise-functions.lua:10`):
--
--   min + 0.5 * (max - min) * (1 + log2(slider_value) / log2(6))
--
-- so it is inlined into whatever calls it and evaluated by the noise machine.
-- `noise-programs.lua:358` calls it from inside `cliffiness_nauvis`.
--
-- The slider value is `x`, so ONE expression samples the whole function and the
-- capture positions ARE the slider positions. Every position sampled is a
-- multiple of 1/256, because Factorio stores map positions as fixed point and
-- silently snaps anything else (#186) - which is why `s = 1/3` and `s = 2/3`
-- from the issue's table are not sampled. They are not needed: the largest gap
-- between the two forms is at `s = 1.5` on `(-1.7, 1.7)`, which is sampled.
--
-- `y` selects the range, as a mask-sum rather than three runs. The masks are
-- exactly 0 or 1, `0 * finite` is exactly 0 and `0 + w` is exactly `w`, so the
-- selection adds no rounding of its own. The bounds stay LITERAL - computing
-- `-1.7` as `-1 - 0.7` would round the bound itself and contaminate the very
-- thing being measured.
--
-- THREE ranges, and the third is a no-regression control rather than a
-- measurement. `(-1, 1)` and `(-50, 50)` have bounds that are exactly
-- representable in f32, so every candidate implementation agrees on them
-- whatever it does with the bounds; `(-1.7, 1.7)` is the only range in the whole
-- game data whose bounds are not, and it is the one the cliff gate reads.
-- `(-50, 50)` is `fulgora_grid`'s range, already measured against a real
-- surface, so a change that breaks it would be caught here.
data:extend({
  {
    type = "noise-expression",
    name = "probe_slider_to_linear",
    expression = "(1 - (y >= 0.5)) * slider_to_linear(x, -1, 1)"
      .. " + ((y >= 0.5) - (y >= 1.5)) * slider_to_linear(x, -1.7, 1.7)"
      .. " + (y >= 1.5) * slider_to_linear(x, -50, 50)",
  },
})
