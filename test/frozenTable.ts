import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The table machinery behind the frozen checksum tiers, in one place.
 *
 * Extracted when tier 3 needed the same guards tier 2 already had. Both tiers
 * freeze a `(section, label, field) -> u64` table, both record through the code
 * that asserts it, and both need the partial-run protection that
 * `flushRecording` provides. Two copies of that would have been two places for
 * a guard to rot, and the guards here are the load-bearing part - each one was
 * added after a specific way of writing a wrong table.
 *
 * What differs between tiers is only the file, the environment variable and
 * what a row means. Those are the arguments; everything else is shared.
 *
 * `section` is the grouping key - a planet for tier 2, a render surface for
 * tier 3. It is deliberately not called "planet" here, because tier 3 groups by
 * something else and a name that lies is worse than a general one.
 */
export interface FrozenTable {
  /** True when the tier's environment variable asks for a record run. */
  readonly RECORDING: boolean;
  frozen(this: void, section: string, label: string, field: string): bigint | undefined;
  record(this: void, section: string, label: string, field: string, value: bigint): void;
  frozenNames(this: void): [string, string[]][];
  frozenCount(this: void, section: string): number;
  /**
   * Distinct rows this run has actually looked up, per section.
   *
   * `frozenCount` reads the committed FILE and `expectRecordedRows` only guards
   * a record run, so neither notices a `freeze` call site that was deleted: its
   * row sits in the table un-consulted and every gate stays green. That gap
   * matters most after #227, when the table is the only thing grading.
   */
  consultedCount(this: void, section: string): number;
  expectFrozen(
    this: void,
    section: string,
    label: string,
    name: string,
    wasm: bigint,
    reference?: bigint,
  ): void;
  expectRecordedRows(this: void, section: string, rows: number): void;
  flushRecording(this: void): void;
}

type Table = Record<string, Record<string, string>>;

/**
 * u64 as a zero-padded hex string. JSON has no integer wide enough to hold one
 * of these exactly - `2n ** 64n` is far past `Number.MAX_SAFE_INTEGER`, so a
 * JSON number would silently round and the table would freeze the wrong value.
 */
function toHex(v: bigint): string {
  return `0x${v.toString(16).padStart(16, "0")}`;
}

export function makeFrozenTable(opts: { tablePath: string; envVar: string }): FrozenTable {
  const TABLE_PATH = opts.tablePath;
  const RECORDING = process.env[opts.envVar] === "1";

  function load(): Table {
    if (!existsSync(TABLE_PATH)) return {};
    return JSON.parse(readFileSync(TABLE_PATH, "utf8")) as Table;
  }

  const table: Table = RECORDING ? {} : load();
  const recorded: Table = {};
  const expected = new Map<string, number>();
  const consulted = new Map<string, Set<string>>();
  let dirty = false;

  function frozen(section: string, label: string, field: string): bigint | undefined {
    const hex = table[section]?.[`${label} | ${field}`];
    return hex === undefined ? undefined : BigInt(hex);
  }

  function record(section: string, label: string, field: string, value: bigint): void {
    (recorded[section] ??= {})[`${label} | ${field}`] = toHex(value);
    dirty = true;
  }

  return {
    RECORDING,
    frozen,
    record,

    frozenNames(): [string, string[]][] {
      return Object.entries(table).map(([section, rows]) => [section, Object.keys(rows)]);
    },

    frozenCount(section: string): number {
      return Object.keys(table[section] ?? {}).length;
    },

    consultedCount(section: string): number {
      return consulted.get(section)?.size ?? 0;
    },

    expectFrozen(section, label, name, wasm, reference): void {
      const where = `${label}: ${name}`;
      if (RECORDING) {
        if (reference !== undefined && wasm !== reference) {
          throw new Error(`${where}: refusing to record, arms disagree - ${wasm} vs ${reference}`);
        }
        record(section, label, name, wasm);
        return;
      }
      // Counted BEFORE the lookup, so a row that is consulted and disagrees
      // still counts as covered - this tracks reach, not success.
      let seen = consulted.get(section);
      if (seen === undefined) {
        seen = new Set<string>();
        consulted.set(section, seen);
      }
      seen.add(`${label} | ${name}`);
      const want = frozen(section, label, name);
      if (want === undefined) throw new Error(`${where}: no frozen checksum`);
      if (wasm !== want) throw new Error(`${where}: wasm ${wasm} != frozen ${want}`);
      if (reference !== undefined && reference !== want) {
        throw new Error(`${where}: reference ${reference} != frozen ${want}`);
      }
    },

    expectRecordedRows(section: string, rows: number): void {
      const already = expected.get(section);
      if (already !== undefined) {
        throw new Error(
          `${section}: row total declared twice (${already} then ${rows}) - declare it once, ` +
            `at module scope, as the whole section's total`,
        );
      }
      expected.set(section, rows);
    },

    flushRecording(): void {
      if (!RECORDING || !dirty) return;
      for (const [section, rows] of Object.entries(recorded)) {
        const want = expected.get(section);
        if (want === undefined || Object.keys(rows).length !== want) delete recorded[section];
      }
      if (Object.keys(recorded).length === 0) return;
      const merged: Table = load();
      for (const [section, rows] of Object.entries(recorded)) merged[section] = rows;
      const ordered: Table = {};
      for (const section of Object.keys(merged).sort()) {
        const rows = merged[section] as Record<string, string>;
        const sorted: Record<string, string> = {};
        for (const k of Object.keys(rows).sort()) sorted[k] = rows[k] as string;
        ordered[section] = sorted;
      }
      mkdirSync(dirname(TABLE_PATH), { recursive: true });
      writeFileSync(TABLE_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
    },
  };
}
