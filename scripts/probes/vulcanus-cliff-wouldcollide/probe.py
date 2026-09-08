"""lldb probe for Surface::wouldCollide(CliffPrototype const&, MapPosition const&, CliffOrientation)
on the 2.0.77 mac-arm64 binary (build 84539). Driven by capture.ts beside this file.

Addresses come from `nm -n <binary> | c++filt` and from
`lldb -b -o "disassemble --start-address 0x1014b4cc8 --end-address 0x1014b4fa0" <binary>`;
the offsets below are the `bl` sites in that listing. They belong to ONE build - re-derive
them for any other binary rather than trusting them.

Per call it records: the orientation id (w3), the position (x2 -> two int32, 1/256 units),
the box copied to sp+0x10 (four int32, position already added) with its orientation word
at sp+0x20, the AABB getAABB wrote to x29-0x38, checkTileCollisions' return, whether the
bit-57 (transitions) path was taken, collideWithEntity's return and the final result (x19).
"""
import json
import struct

import lldb

BASE = 0x1014b4cc8
AT_GETAABB = 0x1014b4e20        # bl getAABB (plain tile path); box at sp+0x10, pos in x2, orientation in w3
AT_GETAABB_TRANS = 0x1014b4e58  # bl getAABB (transitions path)
AT_CHECKTILE = 0x1014b4e48      # bl checkTileCollisions; x1 = box, x2 = aabb
AFTER_CHECKTILE = 0x1014b4e4c   # w0 = result
AFTER_TRANS = 0x1014b4e70       # w0 = collideBBWithTileWithTransitions result
AFTER_ENTITY = 0x1014b4e98      # x0 = colliding entity or null
AT_RETURN = 0x1014b4ec8         # x19 = result

events = []
current = {}


def _reg(frame, name):
    return frame.FindRegister(name).GetValueAsUnsigned()


def _mem(process, addr, n):
    err = lldb.SBError()
    data = process.ReadMemory(addr, n, err)
    if not err.Success():
        return None
    return data


def _box(process, addr):
    d = _mem(process, addr, 20)
    if d is None:
        return None
    l, t, r, b, o = struct.unpack("<iiiiI", d)
    return {"l": l, "t": t, "r": r, "b": b, "o_lo": o & 0xFFFF, "o_hi": o >> 16}


def _start(frame, process, path):
    global current
    sp = _reg(frame, "sp")
    pos = _mem(process, _reg(frame, "x2"), 8)
    px, py = struct.unpack("<ii", pos) if pos else (None, None)
    current = {
        "tid": frame.GetThread().GetThreadID(),
        "orientation": _reg(frame, "w3") & 0xFF,
        # x1 = the CliffPrototype. Two distinct values per run: cliff-vulcanus
        # and crater-cliff; the fixture writer labels them by which one sits on
        # the 4-tile cell grid.
        "proto": _reg(frame, "x1"),
        "pos": [px, py],
        "box": _box(process, sp + 0x10),
        "path": path,
    }
    return False


def on_getaabb(frame, bp_loc, internal_dict):
    return _start(frame, frame.GetThread().GetProcess(), "tile")


def on_getaabb_trans(frame, bp_loc, internal_dict):
    return _start(frame, frame.GetThread().GetProcess(), "transitions")


def on_checktile(frame, bp_loc, internal_dict):
    process = frame.GetThread().GetProcess()
    current["aabb"] = _box(process, _reg(frame, "x2"))
    return False


def on_after_checktile(frame, bp_loc, internal_dict):
    current["tile_hit"] = _reg(frame, "w0") & 0xFFFFFFFF
    return False


def on_after_trans(frame, bp_loc, internal_dict):
    process = frame.GetThread().GetProcess()
    current["aabb"] = _box(process, _reg(frame, "x29") - 0x38)
    current["tile_hit"] = _reg(frame, "w0") & 0xFFFFFFFF
    return False


ENTITY_GETAABB = 0x100156cdc  # Entity::getAABB() const, sret BoundingBox


def on_after_entity(frame, bp_loc, internal_dict):
    ent = _reg(frame, "x0")
    current["entity_hit"] = ent
    if ent:
        process = frame.GetThread().GetProcess()
        target = process.GetTarget()
        vp = _mem(process, ent, 8)
        if vp is not None:
            vptr = struct.unpack("<Q", vp)[0]
            sym = target.ResolveLoadAddress(vptr).GetSymbol()
            current["entity_vtable"] = sym.GetName() if sym.IsValid() else hex(vptr)
        v = frame.EvaluateExpression(
            "struct __BB{int l,t,r,b;unsigned o;}; ((struct __BB(*)(void*))%d)((void*)%d)" % (ENTITY_GETAABB, ent))
        if v.IsValid() and v.GetError().Success():
            current["entity_aabb"] = {k: v.GetChildMemberWithName(k).GetValueAsSigned() for k in "ltrb"}
        else:
            current["entity_aabb_err"] = str(v.GetError())
    return False


def on_return(frame, bp_loc, internal_dict):
    global current
    current["result"] = _reg(frame, "x19") & 0xFFFFFFFF
    events.append(current)
    current = {}
    return False


def setup(debugger):
    target = debugger.GetSelectedTarget()
    for addr, fn in [
        (AT_GETAABB, "probe.on_getaabb"),
        (AT_GETAABB_TRANS, "probe.on_getaabb_trans"),
        (AT_CHECKTILE, "probe.on_checktile"),
        (AFTER_CHECKTILE, "probe.on_after_checktile"),
        (AFTER_TRANS, "probe.on_after_trans"),
        (AFTER_ENTITY, "probe.on_after_entity"),
        (AT_RETURN, "probe.on_return"),
    ]:
        # A bare address set before launch stays UNRESOLVED (hit count 0 while the
        # by-name control hit 1350 times); resolving through the module's file
        # address ties it to a section and it survives the launch.
        sb = target.ResolveFileAddress(addr)
        bp = target.BreakpointCreateBySBAddress(sb)
        bp.SetScriptCallbackFunction(fn)
        bp.SetAutoContinue(True)
    print("probe: %d breakpoints set" % target.GetNumBreakpoints())


def assert_all_hit(debugger):
    """Every breakpoint must have fired, or the capture is not a capture.

    A bare-address breakpoint created before launch stays UNRESOLVED and reports hit
    count 0 while the process runs to completion; that is how the first run of this
    probe wrote zero events and looked like a quiet map. The transitions-path pair
    (bit 57 of the mask) is allowed to stay at zero - no Vulcanus cliff mask sets it.
    """
    target = debugger.GetSelectedTarget()
    for i in range(target.GetNumBreakpoints()):
        bp = target.GetBreakpointAtIndex(i)
        addr = bp.GetLocationAtIndex(0).GetAddress().GetFileAddress()
        if addr in (AT_GETAABB_TRANS, AFTER_TRANS):
            continue
        if bp.GetHitCount() == 0:
            raise RuntimeError("breakpoint at 0x%x was never hit" % addr)


def dump(path):
    with open(path, "w") as f:
        json.dump(events, f)
    print("probe: wrote %d events to %s" % (len(events), path))
