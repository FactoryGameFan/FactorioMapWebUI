import { describe, expect, it } from "vite-plus/test";

import nativeOps from "./fixtures/oracle-native-ops.json";
import { gameCos, gameSin, roundTiesToEven } from "../src/noise/gameTrig";
import { vulcanusBearingTrig } from "../src/noise/wasm/request";

/**
 * The game's own sin/cos polynomial (#531).
 *
 * The ground truth is `oracle-native-ops.json`: four trig expressions at 1,024
 * positions each, stored as f32 bits. The fixture is graded at tolerance 0.
 */

const f32 = Math.fround;
const view = new DataView(new ArrayBuffer(4));
function bitsOf(x: number): string {
  view.setFloat32(0, x);
  return view.getUint32(0).toString(16).padStart(8, "0");
}

type Row = { name: string; expression: string; bits: string[] };
const rows = nativeOps.expressions as Row[];
const positions = nativeOps.positions as [number, number][];

/** The four trig rows: argument as the game builds it, and which function. */
const TRIG_ROWS: {
  expression: string;
  fn: (a: number) => number;
  arg: (x: number, y: number) => number;
}[] = [
  { expression: "sin(x / 64)", fn: gameSin, arg: (x) => f32(x / 64) },
  { expression: "cos(x / 64)", fn: gameCos, arg: (x) => f32(x / 64) },
  { expression: "sin(x * 13.37)", fn: gameSin, arg: (x) => f32(x * f32(13.37)) },
  { expression: "cos(y * 0.731)", fn: gameCos, arg: (_x, y) => f32(y * f32(0.731)) },
];

describe("the game's sin/cos polynomial", () => {
  it("has the four trig rows in the fixture, 1,024 positions each", () => {
    for (const { expression } of TRIG_ROWS) {
      const row = rows.find((r) => r.expression === expression);
      expect(row, expression).toBeDefined();
      expect(row?.bits.length, expression).toBe(1024);
    }
    expect(positions.length).toBe(1024);
  });

  it("matches all 4,096 fixture rows bit for bit", () => {
    let total = 0;
    for (const { expression, fn, arg } of TRIG_ROWS) {
      const row = rows.find((r) => r.expression === expression)!;
      let exact = 0;
      positions.forEach(([x, y], i) => {
        if (bitsOf(fn(arg(x, y))) === row.bits[i]) exact++;
      });
      expect(exact, expression).toBe(1024);
      total += exact;
    }
    expect(total).toBe(4096);
  });

  it("CONTROL: fround(Math.sin) and fround(Math.cos) FAIL the fixture", () => {
    // The control has to be able to fail while the claim holds. Libm-rounded f32
    // trig matches 964 to 987 of each row's 1,024 (measured 2026-11-25), so a
    // fixture that this passed would not be discriminating anything.
    const libm: Record<string, (a: number) => number> = {
      "sin(x / 64)": (a) => f32(Math.sin(a)),
      "cos(x / 64)": (a) => f32(Math.cos(a)),
      "sin(x * 13.37)": (a) => f32(Math.sin(a)),
      "cos(y * 0.731)": (a) => f32(Math.cos(a)),
    };
    for (const { expression, arg } of TRIG_ROWS) {
      const row = rows.find((r) => r.expression === expression)!;
      let exact = 0;
      positions.forEach(([x, y], i) => {
        if (bitsOf(libm[expression]!(arg(x, y))) === row.bits[i]) exact++;
      });
      expect(exact, expression).toBeLessThan(1024);
      expect(exact, expression).toBeGreaterThan(900);
    }
  });

  it("rounds exact ties to even, where Math.round rounds them up", () => {
    expect(roundTiesToEven(2.5)).toBe(2);
    expect(roundTiesToEven(3.5)).toBe(4);
    expect(roundTiesToEven(-2.5)).toBe(-2);
    expect(roundTiesToEven(-3.5)).toBe(-4);
    expect(roundTiesToEven(0.5)).toBe(0);
    expect(roundTiesToEven(1.5)).toBe(2);
    expect(roundTiesToEven(-0.5)).toBe(0);
    expect(roundTiesToEven(2.4999999999999996)).toBe(2);
    expect(roundTiesToEven(2.5000000000000004)).toBe(3);
    expect(roundTiesToEven(7)).toBe(7);
    // The control: Math.round gets the first one wrong.
    expect(Math.round(2.5)).toBe(3);
  });
});

describe("the bearings sent across the boundary use the game's polynomial", () => {
  it("the basalts bearing at seed 123456 has sine 0x3f5d7890, not libm's 0x3f5d7891", () => {
    // Index 2 is the basalts bearing, in `VulcanusBearing` order.
    const basalts = vulcanusBearingTrig(123456)[2]!;
    expect(bitsOf(basalts.sin)).toBe("3f5d7890");
    expect(bitsOf(basalts.sin)).not.toBe("3f5d7891");
  });
});
