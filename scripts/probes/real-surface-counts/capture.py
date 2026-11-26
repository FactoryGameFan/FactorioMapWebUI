#!/usr/bin/env python3
"""Counts the entities the overlays draw, in the same window, in the game's two
pictures of a map: its MAP PREVIEW and a REAL generated surface.

Usage:
    python3 -I scripts/probes/real-surface-counts/capture.py [<2.1.23 headless install>]

For each case (a planet and an origin-centred square window):
  preview - `factorio --generate-map-preview --map-preview-size <window>
            --report-quantities <names>` prints how many of each entity the
            preview queued. The preview never runs the game's `apply` step,
            so it keeps entities that overlap.
  real    - `factorio --create` with a small mod that force-generates every
            chunk the window touches and runs `count_entities_filtered` over
            the window. That is a real surface, `apply` included.
Both use map seed 123456 and default settings. Nauvis is the save's own
surface. Vulcanus and Fulgora are `create_surface()` surfaces with NO seed
forced, so the game derives the surface seed itself; the mod records it and
this script asserts it equals (map seed + crc32(name)) mod 2^32, the seed the
preview and the app use.

Writes `test/fixtures/oracle-entity-counts-preview-vs-real.2.1.23.json`.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zlib

INSTALL = sys.argv[1] if len(sys.argv) > 1 else "/home/eric/factorio-headless/2.1.23/factorio"
FACTORIO = os.path.join(INSTALL, "bin", "x64", "factorio")
READ_DATA = os.path.join(INSTALL, "data")
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
OUT = os.path.join(REPO, "test", "fixtures", "oracle-entity-counts-preview-vs-real.2.1.23.json")
MAP_SEED = 123456

# The identity the fixture's comment records. `factorio --version` must print
# EXPECTED_BUILD, and every run's log must name EXPECTED_LOG.
EXPECTED_BUILD = "Version: 2.1.23 (build 87750, linux64, headless)"
EXPECTED_LOG = "Factorio 2.1.23 (build 87750, linux64, headless, space-age)"

# (planet, window side in tiles, entity names). Each window is
# [-side/2, side/2)^2. The sizes are what the Rust test can afford in a debug
# build: Vulcanus's fields cost about 15 times Nauvis's per tile.
CASES = [
    ("nauvis", 1024, ["biter-spawner", "spitter-spawner", "huge-rock", "big-rock",
                      "big-sand-rock", "crude-oil"]),
    ("vulcanus", 256, ["huge-volcanic-rock", "big-volcanic-rock", "huge-volcanic-rock-hot",
                       "big-volcanic-rock-hot", "sulfuric-acid-geyser"]),
    ("fulgora", 512, ["scrap"]),
]
SPACE_AGE = ["base", "space-age", "elevated-rails", "quality"]

COMMENT = (
    "Ground truth from Factorio 2.1.23 (build 87750, linux64, headless): entity counts in the "
    "game's MAP PREVIEW and on a REAL generated surface, in the same origin-centred window, at "
    "map seed 123456 and default settings. `preview` is --generate-map-preview "
    "--report-quantities (no apply step, so overlapping entities are kept). `real` is "
    "count_entities_filtered after force-generating every chunk the window touches (apply "
    "included). Nauvis is the save's own surface; Vulcanus and Fulgora are unforced "
    "create_surface() surfaces whose game-derived seed is `surfaceSeed` = (map seed + "
    "crc32(name)) mod 2^32. Each window is [-side/2, side/2)^2. Regenerate: python3 -I "
    "scripts/probes/real-surface-counts/capture.py <2.1.23 headless install>"
)


def build_line(log: str) -> str:
    # "   0.000 2026-11-25 19:01:42; Factorio 2.1.23 (build 87750, linux64, headless, space-age)"
    for line in log.splitlines():
        if "; Factorio " in line and "(build " in line:
            return "Factorio " + line.split("; Factorio ", 1)[1].strip()
    return ""


def config(work: str) -> str:
    ini = os.path.join(work, "config.ini")
    with open(ini, "w") as f:
        f.write(f"[path]\nread-data={READ_DATA}\nwrite-data={os.path.join(work, 'write')}\n")
    return ini


def preview(planet: str, side: int, names: list[str]) -> tuple[str, dict]:
    work = tempfile.mkdtemp(prefix="fmw-preview-counts-")
    try:
        args = [FACTORIO, "--config", config(work), "--generate-map-preview",
                os.path.join(work, "preview.png"), "--map-gen-seed", str(MAP_SEED),
                "--map-preview-size", str(side), "--report-quantities", ",".join(names)]
        if planet != "nauvis":
            args += ["--map-preview-planet", planet]
        r = subprocess.run(args, capture_output=True, text=True)
        log = r.stdout + r.stderr
        assert r.returncode == 0, log[-2000:]
        counts = {}
        for line in log.splitlines():
            # "   1.040 biter-spawner: totalEntityCount=253, totalRichness=253, ..."
            parts = line.split()
            if len(parts) >= 3 and parts[1].endswith(":") and "totalEntityCount=" in line:
                counts[parts[1][:-1]] = int(line.split("totalEntityCount=")[1].split(",")[0])
        # The preview reports nothing for an entity it never queued.
        return build_line(log), {n: counts.get(n, 0) for n in names}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def control_lua(planet: str, side: int, names: list[str]) -> str:
    h = side // 2
    names_lua = ", ".join(f'"{n}"' for n in names)
    surface = ("local s = game.surfaces[1]" if planet == "nauvis"
               else f'local s = game.planets["{planet}"].create_surface()')
    return f"""script.on_init(function()
  {surface}
  local chunks = {side} / 32
  for cy = -chunks / 2, chunks / 2 - 1 do
    for cx = -chunks / 2, chunks / 2 - 1 do
      s.request_to_generate_chunks({{x = cx * 32 + 16, y = cy * 32 + 16}}, 0)
    end
  end
  s.force_generate_chunk_requests()
  local counts = {{}}
  for _, name in pairs({{ {names_lua} }}) do
    counts[name] = s.count_entities_filtered{{area = {{{{-{h}, -{h}}}, {{{h}, {h}}}}}, name = name}}
  end
  helpers.write_file("counts.json", helpers.table_to_json({{
    surfaceSeed = s.map_gen_settings.seed, counts = counts }}), false)
  error("DUMPED-OK")
end)
"""


def real(planet: str, side: int, names: list[str]) -> tuple[str, int, dict]:
    work = tempfile.mkdtemp(prefix="fmw-real-counts-")
    try:
        mod = os.path.join(work, "mods", "fmw_real_counts_0.0.1")
        os.makedirs(mod)
        with open(os.path.join(mod, "info.json"), "w") as f:
            json.dump({"name": "fmw_real_counts", "version": "0.0.1", "title": "fmw real counts",
                       "author": "FactorioMapWebUI", "factorio_version": "2.1"}, f)
        with open(os.path.join(mod, "control.lua"), "w") as f:
            f.write(control_lua(planet, side, names))
        enabled = (["base"] if planet == "nauvis" else SPACE_AGE) + ["fmw_real_counts"]
        with open(os.path.join(work, "mods", "mod-list.json"), "w") as f:
            json.dump({"mods": [{"name": m, "enabled": True} for m in enabled]}, f)
        settings = os.path.join(work, "map-gen-settings.json")
        with open(settings, "w") as f:
            json.dump({"seed": MAP_SEED}, f)
        args = [FACTORIO, "--create", os.path.join(work, "write", "probe.zip"),
                "--map-gen-settings", settings, "--map-gen-seed", str(MAP_SEED),
                "--mod-directory", os.path.join(work, "mods"), "--config", config(work)]
        r = subprocess.run(args, capture_output=True, text=True)
        log = r.stdout + r.stderr
        dump = os.path.join(work, "write", "script-output", "counts.json")
        # `error("DUMPED-OK")` ends the run with a non-zero exit; the dump is
        # the success signal, not the exit code.
        assert os.path.exists(dump), log[-2000:]
        with open(dump) as f:
            got = json.load(f)
        return build_line(log), int(got["surfaceSeed"]), {n: int(got["counts"][n]) for n in names}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    version = subprocess.run([FACTORIO, "--version"], capture_output=True, text=True).stdout
    assert version.splitlines()[0] == EXPECTED_BUILD, version
    cases = []
    for planet, side, names in CASES:
        pbuild, pcounts = preview(planet, side, names)
        rbuild, sseed, rcounts = real(planet, side, names)
        assert pbuild == EXPECTED_LOG, pbuild
        assert rbuild == EXPECTED_LOG, rbuild
        want = MAP_SEED if planet == "nauvis" else (MAP_SEED + zlib.crc32(planet.encode())) % 2**32
        assert sseed == want, (planet, sseed, want)
        print(planet, side, "surface seed", sseed, "\n  preview", pcounts, "\n  real   ", rcounts,
              flush=True)
        cases.append({"planet": planet, "side": side, "surfaceSeed": sseed,
                      "preview": pcounts, "real": rcounts})
    out = {"_comment": COMMENT, "mapSeed": MAP_SEED, "cases": cases}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
