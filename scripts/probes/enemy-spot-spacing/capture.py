#!/usr/bin/env python3
"""Reads the game's FULL `enemy_base_probability` (its own named expression, blob terms
included) on Nauvis at 2.1.23, and the same expression text with the spot spacing forced to
45.254833995939045, so the spacing's effect can be read on the whole field.

Usage:
    python3 -I scripts/probes/enemy-spot-spacing/capture.py [<2.1.23 headless install>]

Arms, each its own Factorio process:
  full      - calculate_tile_properties({"enemy_base_probability"}); nothing redefined
  full_45   - the same expression text with
              suggested_minimum_candidate_point_spacing = 45.254833995939045 (control: the
              redefined expression must be faithful, so this arm must match the port at 45.25)
Seeds 123456 and 777771, each forced on a create_surface() surface. Positions: a 128 x 128
grid, 16-tile pitch, over [-1024, 1024). Writes
`test/fixtures/oracle-enemy-base-full.2.1.23.json`.
"""
import json, os, subprocess, sys, tempfile, shutil

ORACLE = os.path.expanduser("~/.cargo/bin/factorio-oracle")
ROOT = sys.argv[1] if len(sys.argv) > 1 else "/home/eric/factorio-headless/2.1.23/factorio"
VERSION = "2.1.23"
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
OUT = os.path.join(REPO, "test", "fixtures", "oracle-enemy-base-full.2.1.23.json")
POS = [(-1024 + 16 * i, -1024 + 16 * j) for j in range(128) for i in range(128)]
SEEDS = [123456, 777771]

FULL_45 = """spot_noise{x = x, y = y,
  density_expression = spot_quantity_expression * max(0, enemy_base_frequency),
  spot_quantity_expression = spot_quantity_expression,
  spot_radius_expression = spot_radius_expression,
  spot_favorability_expression = 1,
  seed0 = map_seed, seed1 = 123, region_size = 512, candidate_point_count = 100,
  hard_region_target_quantity = 0, basement_value = -1000, maximum_spot_basement_radius = 128,
  suggested_minimum_candidate_point_spacing = 45.254833995939045} +
 (blob(1/8, 1) + blob(1/24, 1) + blob(1/64, 2) - 0.5) * spot_radius_expression / 150 *
 (0.1 + 0.9 * clamp(distance / 3000, 0, 1)) - 0.3 + min(0, 20 / starting_area_radius * distance - 20)"""

DATA_45 = """data:extend({ { type = "noise-expression", name = "review_enemy_45",
  expression = [==[%s]==],
  local_expressions = { spot_radius_expression = "max(0, enemy_base_radius)",
                        spot_quantity_expression = "pi/90 * spot_radius_expression ^ 3" },
  local_functions = { blob = { parameters = {"input_scale", "output_scale"},
    expression = "basis_noise{x = x, y = y, seed0 = map_seed, seed1 = 123, input_scale = input_scale, output_scale = output_scale}" } } } })
""" % FULL_45

def control_lua(name, seed):
    ps = ",".join("{x=%d,y=%d}" % p for p in POS)
    return f"""
local ps = {{ {ps} }}
script.on_init(function()
  local s = game.planets["nauvis"].create_surface()
  local mgs = s.map_gen_settings
  mgs.seed = {seed}
  s.map_gen_settings = mgs
  assert(s.map_gen_settings.seed == {seed}, "surface seed did not stick")
  local got = s.calculate_tile_properties({{ "{name}" }}, ps)
  assert(got["{name}"] and #got["{name}"] == #ps, "no values")
  helpers.write_file("oracle-dump.json", helpers.table_to_json({{ seed = {seed}, values = got["{name}"] }}))
  error("DUMPED-OK")
end)
"""

def run(name, data_lua, seed):
    d = tempfile.mkdtemp(prefix="review-enemy-")
    try:
        with open(os.path.join(d, "control.lua"), "w") as f:
            f.write(control_lua(name, seed))
        mod = {"name": "review_enemy_probe", "version": "0.0.1", "dependencies": ["base"],
               "control_lua_file": os.path.join(d, "control.lua")}
        if data_lua:
            mod["data_lua"] = data_lua
        probe = {"mode": "create", "mod": mod, "seed": seed, "timeout_seconds": 600}
        pp = os.path.join(d, "probe.json")
        json.dump(probe, open(pp, "w"))
        work = os.path.join(d, "work")
        r = subprocess.run([ORACLE, "run", "--probe", pp, "--work-dir", work,
                            "--factorio", ROOT, "--version", VERSION], capture_output=True, text=True)
        try:
            build = json.loads(r.stdout).get("provenance", {}).get("buildLine", "")
        except Exception:
            build = ""
        dp = os.path.join(work, "write", "script-output", "oracle-dump.json")
        if not os.path.exists(dp):
            print(name, seed, "NO DUMP", r.stdout[-600:], r.stderr[-1200:], file=sys.stderr)
            return build, None
        return build, json.load(open(dp))["values"]
    finally:
        shutil.rmtree(d, ignore_errors=True)

# The identity COMMENT records. Checked on every run, so a different build or
# platform cannot write a fixture that claims this one.
EXPECTED_BUILD = "Version: 2.1.23 (build 87750, linux64, headless)"

COMMENT = (
    "Ground truth from Factorio 2.1.23 (build 87750, linux64, headless) for the FULL "
    "enemy_base_probability on Nauvis (the game's own named expression: the spot-noise core "
    "plus the blob terms, the starting-area term and the -0.3 offset). Two seeds, 123456 and "
    "777771, each forced onto a create_surface() surface. Positions are a 128 x 128 grid, "
    "x = x0 + pitch * (i % n), y = y0 + pitch * (i // n), in row-major order. `full` is the "
    "game's value at every position. `full45` is the same expression text redefined with "
    "suggested_minimum_candidate_point_spacing = 45.254833995939045; it is stored sparsely as "
    "[index, value] pairs for the positions where it differs from `full`, and equals `full` "
    "everywhere else. Regenerate: python3 -I scripts/probes/enemy-spot-spacing/capture.py "
    "<2.1.23 headless install>"
)


def main():
    cases, builds = [], set()
    for seed in SEEDS:
        arms = {}
        for arm, name, data in [("full", "enemy_base_probability", None),
                                ("full_45", "review_enemy_45", DATA_45)]:
            build, vals = run(name, data, seed)
            assert build == EXPECTED_BUILD, build
            assert vals and len(vals) == len(POS), (arm, seed)
            builds.add(build)
            arms[arm] = vals
            print(arm, seed, "|", build, flush=True)
        full, f45 = arms["full"], arms["full_45"]
        diff = [[i, f45[i]] for i in range(len(POS)) if f45[i] != full[i]]
        print(seed, "full vs full_45 differ at", len(diff), "of", len(POS))
        cases.append({"seed": seed, "full": full, "full45": diff})
    assert len(builds) == 1, builds
    out = {"_comment": COMMENT, "grid": {"x0": -1024, "y0": -1024, "pitch": 16, "n": 128},
           "cases": cases}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
