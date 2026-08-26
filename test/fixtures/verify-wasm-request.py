"""Independently decode the WASM request bytes and build the v2 round-trip fixture.

This is deliberately NOT the TypeScript writer, and not the Rust reader either.
It is a third implementation, written straight from the layout table in
`crates/fmw-wasm/src/abi.rs`, so a wrong offset, a wrong field order or a wrong
byte order shows up as a disagreement rather than as two halves agreeing with
each other.

What it can and cannot check:

- It CAN check every offset, the endianness, the field order, the eleven
  Vulcanus scalars and both world boxes' edges against the request that produced
  them.
- It CANNOT reproduce the trig VALUES, because those are V8's `Math.sin` after
  an `f32` narrowing and Python's libm is a different implementation - which is
  the whole point of #270 and the reason the trig crosses the boundary as values
  in the first place. So it checks the trig block by a property instead:
  `sin^2 + cos^2 == 1` to within an f32 epsilon for each of the ten pairs, which
  a mis-offset or half-shifted block fails.

Usage: python3 verifyAbi.py <encoder-output.json> <fixture-output.json>
"""

import json
import math
import struct
import sys

MAGIC = 0x52574D46
ABI_VERSION = 2
COMMON_BYTES = 56
FULGORA_PARAMS_BYTES = 48
VULCANUS_PARAMS_BYTES = 312
PLANET = {"fulgora": 0, "vulcanus": 1, "nauvis": 2}
VIEW = {
    "landmask": 0,
    "terrain": 1,
    "scrapFootprint": 2,
    "cliffs": 3,
    "rocks": 4,
    "resources": 5,
    "all": 6,
}

BEARING_NAMES = [
    "spawnAshlands",
    "spawnMountains",
    "spawnBasalts",
    "biomeVolcanoSpot",
    "biomeProtector",
    "resourceTungsten",
    "resourceCoal",
    "resourceCalcite",
    "resourceSulfurFar",
    "resourceSulfurNear",
]


NAUVIS_PARAMS_BYTES = 64
"""Must equal fmw_wasm::abi::NAUVIS_PARAMS_BYTES."""


def u32(b, off):
    return struct.unpack_from("<I", b, off)[0]


def f64(b, off):
    return struct.unpack_from("<d", b, off)[0]


def check(label, got, want):
    if got != want:
        raise AssertionError(f"{label}: decoded {got!r}, request says {want!r}")


def decode_common(b, req, params_bytes):
    check("magic", u32(b, 0), MAGIC)
    check("abiVersion", u32(b, 4), ABI_VERSION)
    check("planet", u32(b, 8), PLANET[req.get("planet", "fulgora")])
    check("view", u32(b, 12), VIEW[req.get("view", "landmask")])
    check("seed0", u32(b, 16), req["seed0"])
    check("width", u32(b, 20), req["width"])
    check("height", u32(b, 24), req["height"])
    check("paramsBytes", u32(b, 28), params_bytes)
    check("originX", f64(b, 32), req["originX"])
    check("originY", f64(b, 40), req["originY"])
    check("tilesPerPixel", f64(b, 48), req["tilesPerPixel"])


def decode_fulgora(b, req):
    if len(b) != COMMON_BYTES + FULGORA_PARAMS_BYTES:
        raise AssertionError(f"fulgora request is {len(b)} bytes, expected 104")
    decode_common(b, req, FULGORA_PARAMS_BYTES)
    p = COMMON_BYTES
    check("islandsFrequency", f64(b, p), req["islandsFrequency"])
    check("islandsSize", f64(b, p + 8), req["islandsSize"])
    trig = {
        "sinStart": f64(b, p + 16),
        "cosStart": f64(b, p + 24),
        "sinVault": f64(b, p + 32),
        "cosVault": f64(b, p + 40),
    }
    for name, (s, c) in [
        ("start", (trig["sinStart"], trig["cosStart"])),
        ("vault", (trig["sinVault"], trig["cosVault"])),
    ]:
        norm = s * s + c * c
        if abs(norm - 1.0) > 1e-6:
            raise AssertionError(f"fulgora {name}: sin^2+cos^2 = {norm}, not 1")
    return trig


def decode_nauvis(b, req):
    """Nauvis's block: eight f64 levers, no trig and no world boxes.

    The simplest of the three, and the only structural check available is that
    every field lands at its own offset - there is no unit-norm property to
    lean on and no box to check for inversion. That is fine here and it is
    worth saying WHY, because the Vulcanus block's history is the opposite
    lesson: a property check is not a structural check, and its unit-norm test
    passed a planted swap of two bearings. Eight distinct scalars read back at
    eight distinct offsets cannot be swapped without one of them reading wrong,
    so the per-field check IS the structural check here.
    """
    if len(b) != COMMON_BYTES + NAUVIS_PARAMS_BYTES:
        raise AssertionError(f"nauvis request is {len(b)} bytes, expected 120")
    decode_common(b, req, NAUVIS_PARAMS_BYTES)
    p = COMMON_BYTES
    fields = [
        "waterLevel",
        "segmentationMultiplier",
        "moistureFrequency",
        "moistureBias",
        "auxFrequency",
        "auxBias",
        "startingAreaMoistureSize",
        "startingAreaMoistureFrequency",
    ]
    for i, name in enumerate(fields):
        check(name, f64(b, p + i * 8), req[name])
    # A planted reordering of two levers that happen to hold the SAME value
    # would slip past the loop above, so the fixture's request must not make
    # that possible for more than the defaults it deliberately uses.
    return {"levers": fields}


def decode_vulcanus(b, req):
    if len(b) != COMMON_BYTES + VULCANUS_PARAMS_BYTES:
        raise AssertionError(f"vulcanus request is {len(b)} bytes, expected 368")
    decode_common(b, req, VULCANUS_PARAMS_BYTES)
    p = COMMON_BYTES
    check("volcanismFrequency", f64(b, p), req["volcanismFrequency"])
    check("volcanismSize", f64(b, p + 8), req["volcanismSize"])
    check("temperatureBias", f64(b, p + 16), req["temperatureBias"])
    for i, key in enumerate(
        ["tungstenOre", "vulcanusCoal", "calcite", "sulfuricAcidGeyser"]
    ):
        check(f"{key}.frequency", f64(b, p + 24 + i * 16), req[key]["frequency"])
        check(f"{key}.size", f64(b, p + 32 + i * 16), req[key]["size"])

    trig = {}
    seen = []
    for i, name in enumerate(BEARING_NAMES):
        at = p + 88 + i * 16
        s, c = f64(b, at), f64(b, at + 8)
        norm = s * s + c * c
        if abs(norm - 1.0) > 1e-6:
            raise AssertionError(f"{name}: sin^2+cos^2 = {norm}, not 1")
        trig[name] = {"sin": s, "cos": c}
        seen.append((s, c))
    # The volcano-spot disc IS the mountains bearing, so exactly one pair is a
    # legitimate duplicate. Any other repeat means two bearings collapsed.
    if seen[3] != seen[1]:
        raise AssertionError("biomeVolcanoSpot must equal spawnMountains")
    distinct = len(set(seen))
    if distinct != len(seen) - 1:
        raise AssertionError(
            f"{len(seen) - distinct} duplicate bearing pairs, expected exactly 1"
        )

    # The unit-norm property above cannot see two bearings SWAPPED - both pairs
    # are still unit-norm, and a swap is the failure that produces a plausible
    # planet with its biomes rotated. Measured: a planted swap of
    # resourceTungsten and resourceCoal passed every check above.
    #
    # So recover each angle with atan2 and check the RELATIONSHIPS the Lua
    # defines between them. That is independent of the writer - the offsets come
    # from planet-vulcanus-map-gen.lua, not from request.ts - and it pins which
    # slot is which rather than only that each slot holds an angle.
    #
    # atan2 recovers the angle modulo 360 to about 1e-7 degrees, and the f32
    # narrowing at a 3600-degree magnitude costs about 2.4e-4, so 0.01 is loose
    # enough to never fire on rounding and tight enough that the smallest real
    # offset here (10 degrees) is a thousand times the tolerance.
    def degrees_of(name):
        t = trig[name]
        return math.degrees(math.atan2(t["sin"], t["cos"])) % 360.0

    def circular_delta(x, y):
        """Signed shortest distance between two angles, in degrees.

        `(x - y) % 360` is wrong here: a true difference of -1e-13 comes back as
        359.999..., which reads as "not 120 degrees" and flips the inferred
        starting direction. Centring on 180 before the modulo is what makes a
        hair below and a hair above zero both read as zero.
        """
        return abs((x - y + 180.0) % 360.0 - 180.0)

    a = degrees_of("spawnAshlands")
    direction = 1.0 if circular_delta(degrees_of("spawnMountains") - a, 120.0) < 0.01 else -1.0
    expected = {
        "spawnMountains": 120.0 * direction,
        "spawnBasalts": 240.0 * direction,
        "biomeVolcanoSpot": 120.0 * direction,
        "biomeProtector": (120.0 + 180.0) * direction,
        "resourceTungsten": 240.0 * direction - 10.0 * direction,
        "resourceCoal": 15.0 * direction,
        "resourceCalcite": 120.0 * direction - 20.0 * direction,
        "resourceSulfurFar": 120.0 * direction + 10.0 * direction,
        "resourceSulfurNear": 120.0 * direction + 30.0 * direction,
    }
    for name, offset in expected.items():
        got = (degrees_of(name) - a) % 360.0
        want = offset % 360.0
        if circular_delta(got, want) > 0.01:
            raise AssertionError(
                f"{name}: sits {got:.4f} degrees from ashlands, expected {want:.4f}"
            )

    # The cliff cell query box, appended when the `cliffs` view landed.
    #
    # The value check below is what catches a wrong offset, a transposition or a
    # shifted block - all five planted breaks were caught by it. The two
    # structural checks after it are constraints on the FIXTURE rather than
    # break-catchers: they refuse a fixture whose edges repeat or whose box is
    # inverted, because against such a box the value check would stop
    # discriminating. Recorded that way round because "five breaks caught" is
    # true of the value check and would be a false claim about the other two.
    box = req.get("cellQueryBox")
    if box is None:
        raise AssertionError("the vulcanus arm must carry an explicit cellQueryBox")
    edges = [f64(b, p + 248 + i * 8) for i in range(4)]
    for i, key in enumerate(["x0", "y0", "x1", "y1"]):
        check(f"cellQueryBox.{key}", edges[i], box[key])
    if len(set(edges)) != 4:
        raise AssertionError(f"cellQueryBox edges are not all distinct: {edges}")
    if not (edges[0] < edges[2] and edges[1] < edges[3]):
        raise AssertionError(f"cellQueryBox is inverted on an axis: {edges}")
    cell_box = {"x0": edges[0], "y0": edges[1], "x1": edges[2], "y1": edges[3]}

    # The placement sweep box, appended when the rock and resource overlays
    # landed. Same value check, same reasoning.
    sweep_req = req.get("placementSweepBox")
    if sweep_req is None:
        raise AssertionError("the vulcanus arm must carry an explicit placementSweepBox")
    sweep = [f64(b, p + 280 + i * 8) for i in range(4)]
    for i, key in enumerate(["x0", "y0", "x1", "y1"]):
        check(f"placementSweepBox.{key}", sweep[i], sweep_req[key])
    if len(set(sweep)) != 4:
        raise AssertionError(f"placementSweepBox edges are not all distinct: {sweep}")
    if not (sweep[0] < sweep[2] and sweep[1] < sweep[3]):
        raise AssertionError(f"placementSweepBox is inverted on an axis: {sweep}")

    # The two boxes are adjacent, the same size and the same shape, which makes
    # them the pair most likely to be wired to one another. The per-edge value
    # check above already catches every mis-wiring that was planted - the cliff
    # box in both slots, the two swapped, a block shifted by one f64 - so the
    # two checks below are here for the one break it CANNOT catch: a halo of the
    # wrong shape whose request was edited to agree with it. Measured, not
    # assumed.
    # This one caught none of the six planted breaks and is a constraint on the
    # FIXTURE, like the distinctness checks above: it refuses a fixture in which
    # the two boxes have collapsed onto each other, where the value check would
    # stop discriminating between them.
    if any(a == c for a, c in zip(edges, sweep)):
        raise AssertionError(f"a cell-query edge coincides with a sweep edge: {edges} {sweep}")
    px0, py0 = req["originX"], req["originY"]
    px1 = px0 + req["width"] * req["tilesPerPixel"]
    py1 = py0 + req["height"] * req["tilesPerPixel"]
    lo_x, hi_x = px0 - sweep[0], sweep[2] - px1
    lo_y, hi_y = py0 - sweep[1], sweep[3] - py1
    if not (lo_x == hi_x == lo_y == hi_y > 0):
        raise AssertionError(
            f"placementSweepBox is not a symmetric halo: {lo_x}, {hi_x}, {lo_y}, {hi_y}"
        )
    # The cliff halo must be asymmetric on at least one axis. `cliffCellQueryBox`
    # is asymmetric on both, because the block spans `px - 2 ..= px + 1`; this
    # fixture's box happens to be symmetric on x and asymmetric on y, and one
    # axis is all the check needs to keep the two boxes distinguishable by
    # shape.
    if (px0 - edges[0]) == (edges[2] - px1) and (py0 - edges[1]) == (edges[3] - py1):
        raise AssertionError(
            "cellQueryBox is symmetric on both axes - it must not be, or the two "
            "boxes are indistinguishable by shape"
        )
    return trig, cell_box, {"x0": sweep[0], "y0": sweep[1], "x1": sweep[2], "y1": sweep[3]}


def main():
    src, dest = sys.argv[1], sys.argv[2]
    d = json.load(open(src))
    fb = bytes(d["fulgora"]["bytes"])
    vb = bytes(d["vulcanus"]["bytes"])
    ftrig = decode_fulgora(fb, d["fulgora"]["request"])
    vtrig, vbox, vsweep = decode_vulcanus(vb, d["vulcanus"]["request"])
    nb = bytes(d["nauvis"]["bytes"])
    nlevers = decode_nauvis(nb, d["nauvis"]["request"])
    print("fulgora: all fields agree, both bearings unit-norm")
    print(
        "vulcanus: all fields agree, ten bearings unit-norm, 1 legitimate duplicate, "
        "both world boxes distinct and non-inverted, placement halo symmetric"
    )
    print("nauvis: all eight levers agree at their own offsets, 120 bytes")

    fixture = {
        "_comment": (
            "The WASM render boundary's request encoding at ABI v2, pinned (#225). NOT Factorio "
            "ground truth - this is our own ABI, so it has no game version, which is why "
            "PROVENANCE.json declares it under notFixtures. It IS read by a spec: "
            "test/wasmFulgoraRenderParity.spec.ts asserts src/noise/wasm/request.ts writes exactly "
            "these bytes. The layout tables are in crates/fmw-wasm/src/abi.rs. v2 replaced v1's "
            "single fixed 104-byte struct with a common 56-byte prefix plus a per-planet block "
            "whose length the prefix declares; a Fulgora request is still exactly 104 bytes, and a "
            "Vulcanus one is 368 - it grew from 304 to 336 when the cliffs view added a cell query "
            "box and from 336 to 368 when the rock and resource overlays added a placement sweep "
            "box, neither time with a version bump, because the prefix declares its own block "
            "length and Fulgora's request has not moved a byte through either. These bytes were checked by an INDEPENDENT Python decoder - a "
            "third implementation written from the layout table, not the TypeScript writer under "
            "test and not the Rust reader - which agreed on every offset and every scalar field. "
            "It deliberately does NOT check the trig VALUES: those are V8's Math.sin after an f32 "
            "narrowing, and Python's libm is a different implementation, which is the whole point "
            "of #270. It checks the trig block three other ways instead: sin^2+cos^2 = 1 for each "
            "pair; exactly one legitimate duplicate pair (the volcano-spot disc sits at the "
            "mountains bearing); and - the one that matters - each bearing's angle recovered with "
            "atan2 and checked against the OFFSET the Lua gives it from the ashlands bearing, "
            "which pins which slot is which. That third check was added because the first two were "
            "measured MISSING a planted swap of two bearings: both pairs are still unit-norm, and "
            "a swap is the failure that renders a plausible planet with its biomes rotated. Seven "
            "planted breaks are now caught - a shifted block, two different bearing swaps, a "
            "sin/cos transposition, an offset sign flip, a wrong declared length and a big-endian "
            "field. The cell query box added five more, all caught by its per-edge value check: a "
            "transposed x0/x1, four identical edges, a block shifted by one f64, a mismatched y0, "
            "and a declared length still saying 248. Two further checks on that box - four "
            "distinct edges, and not inverted on either axis - constrain the FIXTURE rather than "
            "catching a break, because against a degenerate box the value check would stop "
            "discriminating. The placement sweep box added five more planted breaks, each run "
            "rather than listed: the cliff box written into both slots, the two boxes swapped, a "
            "block shifted by one f64, one edge wrong, and a declared length still saying 280. "
            "All five are caught by the per-edge value check. A SIXTH is not, and is why the "
            "halo is also checked for symmetry: a halo one tile wider on the low x side than the "
            "high one, with the request edited to agree, passes every value check - and the "
            "placement halo really is symmetric about the pixel box, where the cliff halo is not, "
            "which is the whole reason there are two boxes rather than one. The no-coinciding-edge "
            "check caught none of the six and is a fixture constraint like the distinctness ones. "
            "Regenerating "
            "these bytes from the encoder would make the fixture agree with itself and prove "
            "nothing; if the layout changes, bump ABI_VERSION on both sides and re-verify the "
            "same way."
        ),
        "magic": MAGIC,
        "abiVersion": ABI_VERSION,
        "commonBytes": COMMON_BYTES,
        "fulgora": {
            "paramsBytes": FULGORA_PARAMS_BYTES,
            "totalBytes": len(fb),
            "request": d["fulgora"]["request"],
            "decoded": {"trig": ftrig},
            "bytes": d["fulgora"]["bytes"],
        },
        "vulcanus": {
            "paramsBytes": VULCANUS_PARAMS_BYTES,
            "totalBytes": len(vb),
            "request": d["vulcanus"]["request"],
            "decoded": {
                "trig": vtrig,
                "cellQueryBox": vbox,
                "placementSweepBox": vsweep,
            },
            "bytes": d["vulcanus"]["bytes"],
        },
        "nauvis": {
            "paramsBytes": NAUVIS_PARAMS_BYTES,
            "totalBytes": len(nb),
            "request": d["nauvis"]["request"],
            "decoded": nlevers,
            "bytes": d["nauvis"]["bytes"],
        },
    }
    with open(dest, "w") as f:
        json.dump(fixture, f, indent=2)
        f.write("\n")
    print(f"wrote {dest}")


main()
