"""Writes the probe that asks the game how it READS the cliff settings of the
committed `water-and-cliffs` exchange strings.

Usage: python3 make_probe.py <out-dir>

Writes `<out-dir>/probe.json` and `<out-dir>/control.lua`. The control script
holds every `water-and-cliffs` string from `test/fixtures/map-exchange-*.strings.json`
(2.1.12 to 2.1.25) and calls `helpers.parse_map_exchange_string` on each, then
writes `oracle-dump.json` with the game's `cliff_settings` and
`territory_settings` for it. Run it with the 2.1.23 headless build:

    ~/.cargo/bin/factorio-oracle run --probe <out-dir>/probe.json \
      --work-dir <out-dir>/work --factorio <2.1.23 headless install> --version 2.1.23

(the run exits non-zero by design: the script ends with error("DUMPED-OK")).
The dump is at `<out-dir>/work/write/script-output/oracle-dump.json`.
"""

import glob
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CASE = "water-and-cliffs"

out = os.path.abspath(sys.argv[1])
os.makedirs(out, exist_ok=True)

rows = []
for path in sorted(glob.glob(os.path.join(ROOT, "test/fixtures/map-exchange-2.1.*.strings.json"))):
    m = re.search(r"map-exchange-(2\.1\.\d+)\.strings\.json$", path)
    with open(path) as f:
        rows.append((m.group(1), json.load(f)["strings"][CASE]))

# Base64 goes in a Lua long bracket so +, / and = survive verbatim.
cases = ",\n".join(f'  {{"{v}", [==[{s}]==]}}' for v, s in rows)
control = f"""
local cases = {{
{cases}
}}
script.on_init(function()
  local out = {{}}
  for _, c in ipairs(cases) do
    local ok, r = pcall(helpers.parse_map_exchange_string, c[2])
    if ok then
      out[c[1]] = {{
        ok = true,
        cliff_settings = r.map_gen_settings.cliff_settings,
        territory_settings = r.map_gen_settings.territory_settings,
      }}
    else
      out[c[1]] = {{ok = false, err = tostring(r)}}
    end
  end
  helpers.write_file("oracle-dump.json", helpers.table_to_json(out))
  error("DUMPED-OK")
end)
"""
with open(os.path.join(out, "control.lua"), "w") as f:
    f.write(control)

probe = {
    "mode": "create",
    "mod": {
        "name": "exchange_cliff_bytes_probe",
        "version": "0.0.1",
        "dependencies": ["base"],
        "control_lua_file": os.path.join(out, "control.lua"),
    },
    "timeout_seconds": 300,
    "seed": 123456,
}
with open(os.path.join(out, "probe.json"), "w") as f:
    json.dump(probe, f, indent=2)
print(f"wrote {len(rows)} strings to {out}")
