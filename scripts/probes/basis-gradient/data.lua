-- READ-ONLY COPY. The live text is the inline `data_lua` string in probe.json.
--
-- factorio-oracle reads `control_lua` OR `control_lua_file`, but `data_lua` is
-- inline ONLY - there is no `data_lua_file` (src/run.rs:39-139, checked
-- 2026-08-18). So editing this file changes nothing about what the probe runs.
-- It exists because a 14-line Lua program embedded in a JSON string is not
-- reviewable. Change probe.json first, then mirror it here.
--
-- Registers the noise expression the probe samples.
--
-- input_scale = 1 is the whole point: it makes the noise coordinate equal the
-- world coordinate, so a sample at (I + 1/256, J) sits a known tiny distance
-- from the lattice point (I,J) and the falloff is computable in closed form.
-- The existing oracle-basis fixture used 0.125, which does not have that
-- property.
data:extend({
  {
    type = "noise-expression",
    name = "probe_basis",
    expression = "basis_noise{x = x, y = y, seed0 = 123456, seed1 = 0, input_scale = 1, output_scale = 1}",
  },
})
