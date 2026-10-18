"""gdb script: record the game's chunk-grid basis_noise kernel, call by call (#451).

Loaded by capture.ts as `gdb -batch -x probe.py --args factorio --create ...`.
It is a breakpoint on

    Noise::noise(float, float, unsigned int, unsigned int, float, float, float,
                 NoiseScratch&, float*) const

in a Linux headless build, which ships its symbol table. For each call whose
input and output scales are one of the probe's cases, it writes one JSON line
with the arguments, the output buffer BEFORE the call and the same buffer
AFTER it returns.

Environment:
    PROBE_OUT     path of the JSONL file to write
    PROBE_MATCH   "scales" (the default) or "octaves"
    PROBE_CASES   "scales": JSON list of [input_scale, output_scale], one per
                  case, and a call is matched to a case by its two scales.
                  "octaves": JSON list of input scales. A multioctave op calls
                  the kernel once per octave with the SAME input scale and a
                  different output scale (the octave's amplitude), step and
                  origin, so only the input scale identifies the case.
    PROBE_CHUNKS  "scales": JSON list of [x0, y0] chunk origins to keep.
                  "octaves": JSON list of world chunk ROWS (y) to keep. An
                  octave's y origin is f32(y * step), so a call is kept when
                  y0 / step is within 1/64 of a listed row. Its x origin also
                  carries the octave's 17.17 shift, so x is not filtered here;
                  capture.ts sorts the calls out.

## What the registers hold - read off the disassembly, NOT the demangled signature

The signature has five integer-class arguments, but the code reads six. Going
by the signature alone puts the output in r8, and the first capture read r8 and
got eight non-zero values in a buffer of 1,024. What 2.1.20's disassembly
(0x251c2b0) actually does:

    rdi  this (the per-seed tables: y table at +0x6, x table at +0x106,
         salt byte at +0x5, gradient pairs at +0x208)
    esi  w, the column count            edx  h, the row count
    rcx  a scratch SIZE                 r8   a scratch POINTER (gradient pairs)
    r9   the output, w*h floats, row-major
    xmm0 x0      xmm1 y0      xmm2 step      xmm3 input_scale
    xmm4 output_scale

and the noise coordinate of column i, row r is, in f32,
`(i * step + x0) * input_scale` and `(r * step + y0) * input_scale`.

**The kernel ADDS into r9** (`addss (%rbx,%rcx,1),%xmm4` then a store back), so
the buffer's contents before the call are part of the answer. A lone
`basis_noise` expression gets a zeroed buffer; a multioctave caller hands every
octave the same buffer. Recording both sides is what lets the fixture say
which.

The same layout holds at 2.1.11 (identical instruction sequence) and 2.0.77
(the same instructions with different register moves), which is why one
script serves every version capture.ts asks for.
"""

import json
import os
import struct

import gdb

OUT = open(os.environ["PROBE_OUT"], "w")
MATCH = os.environ.get("PROBE_MATCH", "scales")
if MATCH == "scales":
    CASES = {struct.unpack("<ff", struct.pack("<ff", *c)) for c in json.loads(os.environ["PROBE_CASES"])}
    CHUNKS = {tuple(c) for c in json.loads(os.environ["PROBE_CHUNKS"])}
elif MATCH == "octaves":
    INPUT_SCALES = {struct.unpack("<f", struct.pack("<f", c))[0] for c in json.loads(os.environ["PROBE_CASES"])}
    ROWS = [float(r) for r in json.loads(os.environ["PROBE_CHUNKS"])]
else:
    raise ValueError(f"PROBE_MATCH must be scales or octaves, not {MATCH!r}")
GRID = "Noise::noise(float, float, unsigned int, unsigned int, float, float, float, NoiseScratch&, float*) const"

hits = {"calls": 0, "kept": 0, "returned": 0}


def xmm(i):
    return float(gdb.parse_and_eval(f"$xmm{i}.v4_float[0]"))


def reg(name):
    return int(gdb.parse_and_eval(f"(unsigned long)${name}"))


def read_bits(addr, n):
    mem = bytes(gdb.selected_inferior().read_memory(addr, 4 * n))
    return list(struct.unpack(f"<{n}I", mem))


class Returned(gdb.FinishBreakpoint):
    """Reads the output buffer once the call that filled it has returned.

    A FinishBreakpoint is bound to the frame and thread it was made in, which
    matters here: map generation runs on worker threads, several of them in
    this kernel at once.
    """

    def __init__(self, rec, addr, n):
        super().__init__(gdb.newest_frame(), internal=True)
        self.silent = True
        self.rec, self.addr, self.n = rec, addr, n

    def stop(self):
        self.rec["after"] = read_bits(self.addr, self.n)
        OUT.write(json.dumps(self.rec) + "\n")
        hits["returned"] += 1
        return False

    def out_of_scope(self):
        # A frame that unwound without returning normally. Never seen; if it
        # ever is, the record goes out without an `after` and capture.ts
        # refuses the run rather than guessing.
        OUT.write(json.dumps(self.rec) + "\n")


class Kernel(gdb.Breakpoint):
    def stop(self):
        hits["calls"] += 1
        scales = (xmm(3), xmm(4))
        x0, y0, step = xmm(0), xmm(1), xmm(2)
        if MATCH == "scales":
            if scales not in CASES or (x0, y0) not in CHUNKS:
                return False
        else:
            if scales[0] not in INPUT_SCALES or step <= 0.0:
                return False
            if not any(abs(y0 / step - row) < 1 / 64 for row in ROWS):
                return False
        w, h = reg("rsi") & 0xFFFFFFFF, reg("rdx") & 0xFFFFFFFF
        out = reg("r9")
        rec = {
            "inputScale": scales[0],
            "outputScale": scales[1],
            "x0": x0,
            "y0": y0,
            "step": step,
            "w": w,
            "h": h,
            # The buffer's address, so capture.ts can chain one chunk's
            # octaves: each adds into the buffer the previous one returned.
            "out": out,
            "before": read_bits(out, w * h),
        }
        hits["kept"] += 1
        Returned(rec, out, w * h)
        return False


gdb.execute("set pagination off")
gdb.execute("set confirm off")
bp = Kernel(f"'{GRID}'")
bp.silent = True
# No gdb-side `condition` on the output scale: one was tried and the run took
# 3m55s against 3m36s without it, with 58,632 of about 69,000 calls still
# reaching Python. Every call stops; most belong to the game's own noise and
# return at the first check in `stop`.
gdb.execute("run")
OUT.write(json.dumps({"summary": hits}) + "\n")
OUT.close()
print(f"probe: wrote {hits}")
