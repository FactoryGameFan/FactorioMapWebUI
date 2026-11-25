"""Reads the game's Nauvis cliff-offset chain and its cliffiness gate at the cliff-lattice
corners where an f64 chain and a per-step f32 chain disagree, plus a spread of ordinary
lattice corners, and writes the fixture the Rust tests grade against.

Usage:
    python3 -I scripts/probes/nauvis-cliff-offset-chain/capture.py <work dir> <2.1.23 headless install>

The work dir gets one `control.lua`, `probe.json` and oracle work folder per case. The
fixture is written to `test/fixtures/oracle-nauvis-cliff-offset-gate.2.1.23.json`.
Needs `~/.cargo/bin/factorio-oracle`. Check each run's `buildLine`: it must read
`Version: 2.1.23 (build 87750, linux64, headless)`.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIXTURE = os.path.join(REPO, "test", "fixtures", "oracle-nauvis-cliff-offset-gate.2.1.23.json")
ORACLE = os.path.expanduser("~/.cargo/bin/factorio-oracle")

# Cliff-lattice indices (i, j): the tile is (4 * i, 4 * j). These are the corners where the
# cliffiness gate (`cliffiness_nauvis`) answers differently on an f64 offset chain and on a
# per-step f32 one. They were found by scanning a 2048 x 2048 lattice (8192 x 8192 tiles)
# per case with both builds of the port. Default water frequency (1) gives 0, 1 and 0 of them
# at seeds 123456, 777771 and 1; water frequency 3 gives 9, 4 and 5.
FLIPS = {
    (123456, 3): [(-123, -845), (135, -629), (-223, 807), (-256, 499), (-637, -834),
                  (-638, 121), (712, -365), (-973, 972), (976, -1020)],
    (777771, 1): [(-559, -420)],
    (777771, 3): [(-362, 721), (439, -528), (-639, -218), (-812, 483)],
    (1, 3): [(274, 200), (-584, -943), (860, 288), (889, -603), (912, -414)],
}
CASES = [(123456, 1), (777771, 1), (1, 1), (123456, 3), (777771, 3), (1, 3)]
SPREAD = [(i, j) for i in (-963, -481, 7, 509, 971) for j in (-977, -467, 13, 523, 953)]
PROPS = ["nauvis_hills_offset_raw_x", "nauvis_hills_offset_raw_y", "nauvis_hills_offset",
         "nauvis_cliff_ringbreak", "cliffiness_nauvis"]
KEYS = ["rawX", "rawY", "hillsOffset", "ringbreak", "cliffiness"]


def run_case(work, factorio, seed, water):
    flips = FLIPS.get((seed, water), [])
    lattice = flips + [q for q in SPREAD if q not in flips]
    pts = [(4 * i, 4 * j) for i, j in lattice]
    d = os.path.join(work, f"probe-{seed}-{water}")
    os.makedirs(d, exist_ok=True)
    control = f"""
local PROPS = helpers.json_to_table([==[{json.dumps(PROPS)}]==])
local PS = helpers.json_to_table([==[{json.dumps([{"x": x, "y": y} for x, y in pts])}]==])
script.on_init(function()
  local s = game.surfaces["nauvis"]
  local r = s.calculate_tile_properties(PROPS, PS)
  helpers.write_file("oracle-dump.json", helpers.table_to_json({{ seed = s.map_gen_settings.seed, water = s.map_gen_settings.autoplace_controls.water and s.map_gen_settings.autoplace_controls.water.frequency, positions = PS, values = r }}))
  error("DUMPED-OK")
end)
"""
    open(os.path.join(d, "control.lua"), "w").write(control)
    mgs = {"autoplace_controls": {"water": {"frequency": water, "size": 1, "richness": 1}}}
    spec = {"mode": "create",
            "mod": {"name": "nauvis_offset_chain_probe", "version": "0.0.1",
                    "dependencies": ["base"], "control_lua_file": os.path.join(d, "control.lua")},
            "seed": seed, "map_gen_settings": mgs, "timeout_seconds": 300}
    open(os.path.join(d, "probe.json"), "w").write(json.dumps(spec, indent=1))
    r = subprocess.run([ORACLE, "run", "--probe", os.path.join(d, "probe.json"),
                        "--work-dir", os.path.join(d, "work"), "--factorio", factorio,
                        "--version", "2.1.23"], capture_output=True, text=True)
    build = json.loads(r.stdout).get("provenance", {}).get("buildLine", "")
    assert "Version: 2.1.23 " in build, build
    dump = json.load(open(os.path.join(d, "work", "write", "script-output", "oracle-dump.json")))
    assert dump["seed"] == seed, dump["seed"]
    assert dump["water"] == water, dump["water"]
    case = {"seed": seed, "waterFrequency": water, "flipCount": len(flips),
            "positions": [{"x": x, "y": y} for x, y in pts]}
    for prop, key in zip(PROPS, KEYS):
        case[key] = dump["values"][prop]
    return case, build


def main():
    work, factorio = sys.argv[1], sys.argv[2]
    cases, builds = [], set()
    for seed, water in CASES:
        case, build = run_case(work, factorio, seed, water)
        cases.append(case)
        builds.add(build)
    assert len(builds) == 1, builds
    comment = (
        "Ground truth from Factorio 2.1.23 (build 87750, linux64, headless) for the Nauvis "
        "cliff-offset chain and its cliffiness gate, at corners of the 4-tile cliff lattice "
        "(tile = 4 * lattice index). Six cases: seeds 123456, 777771 and 1, each at water "
        "frequency 1 (the default) and 3. Each case lists its flip corners first (flipCount "
        "of them): the corners where an f64 offset chain and a per-step f32 chain disagree on "
        "whether cliffiness_nauvis is 0 or 10. They were found by scanning a 2048 x 2048 "
        "lattice per case with both builds of the port. A 5 x 5 spread of ordinary corners "
        "(lattice indices spread over -1000..1000, none a round number) follows. One calculate_tile_properties call per case "
        "read nauvis_hills_offset_raw_x, nauvis_hills_offset_raw_y, nauvis_hills_offset, "
        "nauvis_cliff_ringbreak and cliffiness_nauvis, as rawX, rawY, hillsOffset, ringbreak "
        "and cliffiness. Regenerate: python3 -I scripts/probes/nauvis-cliff-offset-chain/"
        "capture.py <work dir> <2.1.23 headless install>")
    out = {"_comment": comment, "cases": cases}
    with open(FIXTURE, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print("wrote", FIXTURE, "build:", builds.pop())


main()
