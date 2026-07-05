import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, SqliteGrantSpendStore, type MotebitDatabase } from "../index.js";
import type { GrantSpendCeiling, MoneyAction } from "@motebit/policy";

const M = 1_000_000;
const T0 = 1_000_000_000;
const CEILING: GrantSpendCeiling = {
  lifetime_limit_micro: 5 * M,
  cumulative_limit_micro: 2 * M,
  window_ms: 1000,
};
const act = (usd: number, counterparty = "payee-1"): MoneyAction => ({
  amount_micro: usd * M,
  counterparty,
});

describe("SqliteGrantSpendStore — persistent blast-radius accumulator", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  it("accumulates across consecutive tryConsume calls and denies at the window cap", async () => {
    const store = moteDb.grantSpendStore;
    const a = await store.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(1),
      nonce: 0,
      now: T0,
    });
    expect(a.allowed).toBe(true);
    const b = await store.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(1),
      nonce: 1,
      now: T0 + 1,
    });
    expect(b.allowed).toBe(true);
    // Third $1 in the same window exceeds cumulative_limit_micro ($2/window).
    const c = await store.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(1),
      nonce: 2,
      now: T0 + 2,
    });
    expect(c.allowed).toBe(false);
    expect(c.denial).toBe("cumulative_exceeded");
  });

  it("SURVIVES a store re-instantiation — the lifetime bound does not re-arm (the whole point)", async () => {
    const first = moteDb.grantSpendStore;
    // Spend $4 of the $5 lifetime across windows.
    await first.tryConsume({ grant_id: "g1", ceiling: CEILING, action: act(2), nonce: 0, now: T0 });
    await first.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(2),
      nonce: 1,
      now: T0 + 1000,
    });

    // A NEW store over the same driver models a process restart against
    // the same DB file. $2 more must exceed the $5 lifetime.
    const reopened = new SqliteGrantSpendStore(moteDb.db);
    const after = await reopened.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(2),
      nonce: 2,
      now: T0 + 2000,
    });
    expect(after.allowed).toBe(false);
    expect(after.denial).toBe("lifetime_exceeded");
    expect(reopened.peek("g1")!.lifetime_spent_micro).toBe(4 * M);
  });

  it("denies a nonce replay and mutates nothing on deny", async () => {
    const store = moteDb.grantSpendStore;
    await store.tryConsume({ grant_id: "g1", ceiling: CEILING, action: act(1), nonce: 5, now: T0 });
    const replay = await store.tryConsume({
      grant_id: "g1",
      ceiling: CEILING,
      action: act(1),
      nonce: 5,
      now: T0 + 1,
    });
    expect(replay.allowed).toBe(false);
    expect(replay.denial).toBe("replay");
    expect(store.peek("g1")!.lifetime_spent_micro).toBe(1 * M);
    expect(store.peek("g1")!.high_water_nonce).toBe(5);
  });

  it("isolates accumulators per grant_id", async () => {
    const store = moteDb.grantSpendStore;
    await store.tryConsume({ grant_id: "g1", ceiling: CEILING, action: act(2), nonce: 0, now: T0 });
    const other = await store.tryConsume({
      grant_id: "g2",
      ceiling: CEILING,
      action: act(2),
      nonce: 0,
      now: T0,
    });
    expect(other.allowed).toBe(true);
    expect(store.peek("g1")!.lifetime_spent_micro).toBe(2 * M);
    expect(store.peek("g2")!.lifetime_spent_micro).toBe(2 * M);
  });

  it("empty ceiling denies ceiling_absent and persists no row", async () => {
    const store = moteDb.grantSpendStore;
    const denied = await store.tryConsume({
      grant_id: "g1",
      ceiling: {},
      action: act(1),
      nonce: 0,
      now: T0,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.denial).toBe("ceiling_absent");
    expect(store.peek("g1")).toBeUndefined();
  });
});
