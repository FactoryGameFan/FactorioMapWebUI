"""lldb probe: every cliff the map generator creates, re-orients or destroys, with WHO did it.

Driven by capture.ts beside this file, on the 2.0.77 mac-arm64 binary (build 84539). The
wouldCollide probe (#406) recorded the apply-stage collision test; this one records what
happens to a cliff AFTER it passes that test, which no Lua API and no earlier fixture sees.

The four function-entry breakpoints are set BY NAME, which resolves through the symbol table
before launch. The six mid-function sites (destroyEnd's shrink and self-destroy, and
wouldCollide's verdicts) go through the module's FILE address, the fix for the bare-address
trap in ../vulcanus-cliff-wouldcollide/probe.py. The field offsets are read off the same
binary's disassembly:

- `Cliff::getNeighborPosition` loads the position as `ldp w8, w9, [x0, #0x50]`, two int32 in
  1/256 tile units;
- `Cliff::setCliffOrientation` compares and stores the orientation byte at `[x0, #0x88]`.

They belong to ONE build. capture.ts checks every recorded position lands on the cliff cell
grid, so a wrong offset fails loudly rather than writing plausible numbers.
"""
import json
import struct

import lldb

events = []

# How many frames of the caller chain to keep. The root frame (applyCliffs,
# ResourceEntity::postSetup, a demolisher's trigger) sits three frames deeper for every
# cliff a cascade has passed through, and the first run's 14 frames lost it on a run of
# four; 40 covers the longest chain in either region with room to spare.
DEPTH = 40


def _reg(frame, name):
    return frame.FindRegister(name).GetValueAsUnsigned()


def _cliff(frame):
    process = frame.GetThread().GetProcess()
    this = _reg(frame, "x0")
    err = lldb.SBError()
    pos = process.ReadMemory(this + 0x50, 8, err)
    if not err.Success():
        return this, None, None
    px, py = struct.unpack("<ii", pos)
    o = process.ReadMemory(this + 0x88, 1, err)
    return this, [px, py], (o[0] if err.Success() else None)


def _stack(frame):
    thread = frame.GetThread()
    out = []
    for i in range(1, min(DEPTH, thread.GetNumFrames())):
        f = thread.GetFrameAtIndex(i)
        sym = f.GetSymbol()
        # The symbol carries the class ("Cliff::destroyEnd(CellSide)"); an inlined frame has
        # none of its own, so fall back to lldb's function name for it.
        name = f.GetFunctionName() or hex(f.GetPC())
        if f.IsInlined() or not sym.IsValid():
            out.append("[inlined] " + name)
        else:
            out.append(sym.GetName())
    return out


def _vtable(frame):
    process = frame.GetThread().GetProcess()
    err = lldb.SBError()
    vp = process.ReadMemory(_reg(frame, "x0"), 8, err)
    if not err.Success():
        return None
    vptr = struct.unpack("<Q", vp)[0]
    sym = process.GetTarget().ResolveLoadAddress(vptr).GetSymbol()
    return sym.GetName() if sym.IsValid() else hex(vptr)


def _record(frame, kind, **extra):
    this, pos, orientation = _cliff(frame)
    ev = {
        "kind": kind,
        "tid": frame.GetThread().GetThreadID(),
        "this": this,
        "pos": pos,
        "orientation": orientation,
        "stack": _stack(frame),
    }
    ev.update(extra)
    events.append(ev)


def on_setup(frame, bp_loc, internal_dict):
    _record(frame, "setup")
    return False


def on_on_destroy(frame, bp_loc, internal_dict):
    _record(frame, "onDestroy")
    return False


def on_force_destroy(frame, bp_loc, internal_dict):
    # Entity::forceDestroy is every entity's; keep only cliffs.
    vt = _vtable(frame)
    if vt is not None and "Cliff" in vt:
        _record(frame, "forceDestroy")
    return False


def on_set_orientation(frame, bp_loc, internal_dict):
    new = _reg(frame, "w1") & 0xFF
    this, pos, old = _cliff(frame)
    if old != new:
        _record(frame, "setOrientation", to=new)
    return False


# `Cliff::destroyEnd`'s self-destroy after a shrink: the `bl forceDestroy` at +620, reached
# only when an entity in the trimmed box collides with the cliff. x21 is that entity.
DESTROY_END_SELF = 0x100713344
ENTITY_GETAABB = 0x100156CDC  # Entity::getAABB() const, sret BoundingBox


def on_destroy_end_self(frame, bp_loc, internal_dict):
    process = frame.GetThread().GetProcess()
    ent = _reg(frame, "x21")
    err = lldb.SBError()
    vp = process.ReadMemory(ent, 8, err)
    kind = None
    if err.Success():
        vptr = struct.unpack("<Q", vp)[0]
        sym = process.GetTarget().ResolveLoadAddress(vptr).GetSymbol()
        kind = sym.GetName() if sym.IsValid() else hex(vptr)
    box = process.ReadMemory(_reg(frame, "x19") + 0x5C, 20, err)
    extra = {"entity": kind}
    if err.Success():
        extra["cliff_box"] = list(struct.unpack("<iiiiI", box))
    v = frame.EvaluateExpression(
        "struct __BB{int l,t,r,b;unsigned o;}; ((struct __BB(*)(void*))%d)((void*)%d)" % (ENTITY_GETAABB, ent))
    if v.IsValid() and v.GetError().Success():
        extra["entity_aabb"] = [v.GetChildMemberWithName(k).GetValueAsSigned() for k in "ltrb"]
    # x0 is not the cliff here; _record reads x0, so pass the cliff through x19.
    this = _reg(frame, "x19")
    pos = process.ReadMemory(this + 0x50, 8, err)
    o = process.ReadMemory(this + 0x88, 1, err)
    events.append({
        "kind": "destroyEndCollide",
        "tid": frame.GetThread().GetThreadID(),
        "this": this,
        "pos": list(struct.unpack("<ii", pos)),
        "orientation": o[0],
        "stack": _stack(frame),
        **extra,
    })
    return False


# `Cliff::destroyEnd`'s shrink: `strb w8, [x19, #0x88]` at +344. `setCliffOrientation` is
# inlined everywhere that matters and its breakpoint never fires, so trims are read here:
# the byte still holds the old orientation and w8 the new one.
DESTROY_END_TRIM = 0x100713230


def on_destroy_end_trim(frame, bp_loc, internal_dict):
    process = frame.GetThread().GetProcess()
    this = _reg(frame, "x19")
    err = lldb.SBError()
    pos = process.ReadMemory(this + 0x50, 8, err)
    o = process.ReadMemory(this + 0x88, 1, err)
    events.append({
        "kind": "trim",
        "tid": frame.GetThread().GetThreadID(),
        "this": this,
        "pos": list(struct.unpack("<ii", pos)),
        "orientation": o[0],
        "to": _reg(frame, "w8") & 0xFF,
        "stack": _stack(frame),
    })
    return False


# `Surface::wouldCollide(CliffPrototype const&, MapPosition const&, CliffOrientation)`, the
# apply-stage test, at the offsets ../vulcanus-cliff-wouldcollide/probe.py reads. Only the
# position, the tile verdict and the entity verdict are kept: enough to say whether an
# `applyCliffs` kill was the tile half or the entity half, and which entity.
WC_AT_GETAABB = 0x1014B4E20     # x2 -> position, w3 = orientation
WC_AFTER_CHECKTILE = 0x1014B4E4C  # w0 = tile verdict
WC_AFTER_ENTITY = 0x1014B4E98   # x0 = colliding entity or null
WC_AT_RETURN = 0x1014B4EC8      # x19 = result
wc = {}


def on_wc_start(frame, bp_loc, internal_dict):
    global wc
    process = frame.GetThread().GetProcess()
    err = lldb.SBError()
    pos = process.ReadMemory(_reg(frame, "x2"), 8, err)
    wc = {"pos": list(struct.unpack("<ii", pos)) if err.Success() else None,
          "orientation": _reg(frame, "w3") & 0xFF, "proto": _reg(frame, "x1")}
    return False


def on_wc_tile(frame, bp_loc, internal_dict):
    wc["tile"] = _reg(frame, "w0") & 0xFFFFFFFF
    return False


def on_wc_entity(frame, bp_loc, internal_dict):
    ent = _reg(frame, "x0")
    if ent:
        process = frame.GetThread().GetProcess()
        err = lldb.SBError()
        vp = process.ReadMemory(ent, 8, err)
        if err.Success():
            vptr = struct.unpack("<Q", vp)[0]
            sym = process.GetTarget().ResolveLoadAddress(vptr).GetSymbol()
            wc["entity"] = sym.GetName() if sym.IsValid() else hex(vptr)
        v = frame.EvaluateExpression(
            "struct __BB{int l,t,r,b;unsigned o;}; ((struct __BB(*)(void*))%d)((void*)%d)" % (ENTITY_GETAABB, ent))
        if v.IsValid() and v.GetError().Success():
            wc["entity_aabb"] = [v.GetChildMemberWithName(k).GetValueAsSigned() for k in "ltrb"]
    return False


def on_wc_return(frame, bp_loc, internal_dict):
    global wc
    wc["result"] = _reg(frame, "x19") & 0xFFFFFFFF
    events.append({"kind": "wouldCollide", "tid": frame.GetThread().GetThreadID(), "this": 0,
                   "stack": [], **wc})
    wc = {}
    return False


BREAKPOINTS = [
    ("Cliff::setup(SetupData const&)", "probe.on_setup"),
    ("Cliff::onDestroy()", "probe.on_on_destroy"),
    ("Entity::forceDestroy()", "probe.on_force_destroy"),
    ("Cliff::setCliffOrientation(CliffOrientation)", "probe.on_set_orientation"),
]


def setup(debugger):
    target = debugger.GetSelectedTarget()
    for name, fn in BREAKPOINTS:
        bp = target.BreakpointCreateByName(name)
        if bp.GetNumLocations() == 0:
            raise RuntimeError("no location for %s" % name)
        bp.SetScriptCallbackFunction(fn)
        bp.SetAutoContinue(True)
    # An address breakpoint must go through the module's file address or it never
    # resolves across the launch (../vulcanus-cliff-wouldcollide/probe.py).
    for addr, fn in [
        (DESTROY_END_SELF, "probe.on_destroy_end_self"),
        (DESTROY_END_TRIM, "probe.on_destroy_end_trim"),
        (WC_AT_GETAABB, "probe.on_wc_start"),
        (WC_AFTER_CHECKTILE, "probe.on_wc_tile"),
        (WC_AFTER_ENTITY, "probe.on_wc_entity"),
        (WC_AT_RETURN, "probe.on_wc_return"),
    ]:
        bp = target.BreakpointCreateBySBAddress(target.ResolveFileAddress(addr))
        bp.SetScriptCallbackFunction(fn)
        bp.SetAutoContinue(True)
    print("probe: %d breakpoints set" % target.GetNumBreakpoints())


def assert_hit(debugger):
    """setup and the destroy paths must have fired, or the capture is not a capture."""
    target = debugger.GetSelectedTarget()
    counts = {}
    for i in range(target.GetNumBreakpoints()):
        bp = target.GetBreakpointAtIndex(i)
        name = (BREAKPOINTS[i][0] if i < len(BREAKPOINTS)
                else ["destroyEnd self-destroy", "destroyEnd trim", "wouldCollide start",
                      "wouldCollide tile", "wouldCollide entity", "wouldCollide return"][i - len(BREAKPOINTS)])
        counts[name] = bp.GetHitCount()
    print("probe: hit counts %s" % json.dumps(counts))
    for name in ("Cliff::setup(SetupData const&)", "Cliff::onDestroy()", "destroyEnd trim",
                 "wouldCollide start", "wouldCollide return"):
        if counts[name] == 0:
            raise RuntimeError("%s was never hit" % name)


def dump(path):
    with open(path, "w") as f:
        json.dump(events, f)
    print("probe: wrote %d events to %s" % (len(events), path))
