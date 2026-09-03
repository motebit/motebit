/**
 * The integer-micro-unit invariant, enforced at the STORAGE boundary.
 *
 * The money model is integer micro-units with zero floating-point in the money
 * path (root `CLAUDE.md`). That was enforced in code and nowhere in storage, and
 * the gap is not hypothetical: 2,954 production rows from 2026-03-19 → 03-24
 * hold dollar-denominated values like `0.006315789473684211` in the micro-unit
 * `amount` column — off by roughly 10⁶ (#554).
 *
 * SQLite is why it could be written at all. `amount INTEGER NOT NULL` declares
 * type AFFINITY, not a constraint: SQLite converts a REAL to an integer only
 * when the conversion is lossless and stores it as a REAL otherwise. The column
 * type reads like a guarantee and is not one — which is exactly the shape this
 * repo keeps finding, a declared invariant with no enforcement behind it.
 *
 * Two layers are under test, because they cover different populations:
 *
 *   1. `assertMicroUnits` at every write — covers EXISTING databases, including
 *      production, which cannot gain a CHECK without a full table rebuild.
 *   2. The `CHECK (typeof(...) = 'integer')` constraint — covers NEW databases,
 *      making the state structurally unrepresentable rather than merely guarded.
 *
 * The second test group is the one that matters most: it asserts the storage
 * layer refuses the bad value even when the code guard is bypassed entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMotebitDatabase } from "@motebit/persistence";
import type { DatabaseDriver } from "@motebit/persistence";
import { SqliteAccountStore, createAccountTables } from "../account-store-sqlite.js";
import type { MotebitId } from "@motebit/sdk";

/** The verbatim value from the production rows that motivated this (#554). */
const DOLLARS_IN_A_MICRO_COLUMN = 0.006315789473684211;

const MOTEBIT = "00000000-0000-4000-8000-00000000aaaa" as MotebitId;

let db: DatabaseDriver;
let close: () => void;
let store: SqliteAccountStore;

beforeEach(() => {
  const moteDb = createMotebitDatabase(":memory:");
  db = moteDb.db;
  close = () => moteDb.close();
  createAccountTables(db);
  store = new SqliteAccountStore(db);
});

afterEach(() => {
  close();
});

describe("write-path guard — covers databases that predate the CHECK", () => {
  it("refuses the exact production value that caused #554", () => {
    expect(() => store.credit(MOTEBIT, DOLLARS_IN_A_MICRO_COLUMN, "deposit", null, null)).toThrow(
      /integer micro-unit/,
    );
  });

  it("names the fix in the error, not just the failure", () => {
    // A money-path refusal has to be self-serviceable: the reader needs to know
    // that dollars belong on the other side of `toMicro`, not just that a
    // number was rejected.
    let message = "";
    try {
      store.credit(MOTEBIT, 0.25, "deposit", null, null);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("toMicro(dollars)");
    expect(message).toContain("0.25");
  });

  it.each([
    ["credit", () => store.credit(MOTEBIT, 1.5, "deposit", null, null)],
    ["debit", () => store.debit(MOTEBIT, 1.5, "settlement_debit", null, null)],
  ])("guards %s", (_name, call) => {
    expect(call).toThrow(/integer micro-unit/);
  });

  it("leaves legitimate integer amounts working — including zero and negatives", () => {
    // The guard must not become a behaviour change for the money path itself.
    // Negative amounts are how corrections are expressed; zero is a legal no-op.
    expect(() => store.credit(MOTEBIT, 1_000_000, "deposit", null, null)).not.toThrow();
    expect(() => store.credit(MOTEBIT, 0, "deposit", null, null)).not.toThrow();
    expect(() => store.credit(MOTEBIT, -5, "fee", null, null)).not.toThrow();
    expect(store.getAccount(MOTEBIT)?.balance).toBe(999_995);
  });

  it("refuses NaN and Infinity, which are not integers either", () => {
    expect(() => store.credit(MOTEBIT, Number.NaN, "deposit", null, null)).toThrow();
    expect(() => store.credit(MOTEBIT, Number.POSITIVE_INFINITY, "deposit", null, null)).toThrow();
  });
});

describe("CHECK constraint — makes the state unrepresentable in new databases", () => {
  it("rejects a REAL written directly, with the code guard bypassed entirely", () => {
    // The load-bearing test. This is the write that actually happened in
    // production: SQL straight at the table, no application guard in the way.
    // `INTEGER` affinity alone accepted it; the CHECK is what refuses it.
    expect(() =>
      db
        .prepare(
          `INSERT INTO relay_transactions
             (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("t1", MOTEBIT, "allocation_hold", DOLLARS_IN_A_MICRO_COLUMN, 0, null, null, 1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("rejects a non-integer balance_after too — both money columns are guarded", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO relay_transactions
             (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("t2", MOTEBIT, "allocation_hold", 100, 0.5, null, null, 1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("still accepts a losslessly-integral value, which SQLite stores as an integer", () => {
    // `5.0` is not drift — SQLite converts it to an integer under INTEGER
    // affinity because the conversion is lossless, so `typeof` is 'integer'
    // and the row is genuinely fine. Rejecting it would be false precision.
    expect(() =>
      db
        .prepare(
          `INSERT INTO relay_transactions
             (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("t3", MOTEBIT, "deposit", 5.0, 5.0, null, null, 1),
    ).not.toThrow();
  });
});
