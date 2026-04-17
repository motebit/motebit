/**
 * Fail-closed behavior of SqliteAccountStore's schema-probe path.
 *
 * Before H2, `getUnwithdrawableHold` and `getSweepConfig` wrapped the real
 * query in try/catch and returned 0 / null on any error — DB-locked,
 * schema-drift, anything. That's a fail-OPEN compromise the
 * fail-closed doctrine in the root CLAUDE.md forbids: an unavailable
 * dispute-hold computation must be treated as a refusal, not as "no hold
 * applies."
 *
 * The new shape probes `sqlite_master` for the needed tables. Missing
 * tables → degraded mode (test setups that skip the migration continue
 * to work). Tables present → the real query runs unhedged; any error
 * propagates to the caller so the withdrawal path can reject loudly.
 *
 * These tests isolate the probe/query branches via a mock DatabaseDriver,
 * so the assertion surface is the primitive itself — not the wider
 * `withdrawal-hold.test.ts` harness which covers correctness under the
 * happy-path schema.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseDriver, PreparedStatement } from "@motebit/persistence";
import { SqliteAccountStore, createAccountTables } from "../account-store-sqlite.js";

// ── A minimal scriptable DatabaseDriver mock ─────────────────────────
// `prepare(sql).all/get(...)` returns whatever the script for that SQL
// returns. If no script exists for a given SQL, prepare throws — this
// way a test that forgets to script a query gets a loud failure instead
// of silent undefined.

type QueryReply = { kind: "rows"; rows: unknown[] } | { kind: "throw"; error: Error };

class MockDriver implements DatabaseDriver {
  readonly driverName = "mock";
  private readonly scripts: Array<{ match: RegExp; reply: QueryReply }> = [];

  /** Route any SQL matching `match` to `reply`. Later calls override earlier. */
  script(match: RegExp, reply: QueryReply): this {
    this.scripts.unshift({ match, reply });
    return this;
  }

  exec(): void {
    /* no-op for these tests */
  }

  prepare(sql: string): PreparedStatement {
    const hit = this.scripts.find((s) => s.match.test(sql));
    if (!hit) {
      throw new Error(`MockDriver: no script for SQL:\n${sql}`);
    }
    const reply = hit.reply;
    const exec = (): unknown[] => {
      if (reply.kind === "throw") throw reply.error;
      return reply.rows;
    };
    return {
      run: () => ({ changes: 0 }),
      all: () => exec(),
      get: () => exec()[0],
    };
  }

  pragma(): unknown {
    return null;
  }

  close(): void {
    /* no-op */
  }
}

const TABLES_PRESENT_ROWS = (names: string[]): QueryReply => ({
  kind: "rows",
  rows: names.map((name) => ({ name })),
});

describe("SqliteAccountStore — fail-closed schema probe (H2)", () => {
  describe("getUnwithdrawableHold", () => {
    it("returns 0 when relay_settlements / relay_disputes tables are absent", () => {
      const db = new MockDriver().script(
        /FROM sqlite_master/,
        { kind: "rows", rows: [] }, // no tables found
      );
      const store = new SqliteAccountStore(db);
      expect(store.getUnwithdrawableHold("motebit_x")).toBe(0);
    });

    it("returns 0 when only one of the two required tables is present", () => {
      const db = new MockDriver().script(
        /FROM sqlite_master/,
        TABLES_PRESENT_ROWS(["relay_settlements"]), // missing relay_disputes
      );
      const store = new SqliteAccountStore(db);
      expect(store.getUnwithdrawableHold("motebit_x")).toBe(0);
    });

    it("runs the real query when both tables are present", () => {
      const db = new MockDriver()
        .script(/FROM sqlite_master/, TABLES_PRESENT_ROWS(["relay_settlements", "relay_disputes"]))
        .script(/FROM relay_settlements/, { kind: "rows", rows: [{ total: 42_000 }] });
      const store = new SqliteAccountStore(db);
      expect(store.getUnwithdrawableHold("motebit_x")).toBe(42_000);
    });

    it("propagates SQL errors from the real query — does NOT silently return 0", () => {
      // The whole point of H2: before the fix, this `database is locked`
      // error would be swallowed and the method would return 0, silently
      // bypassing the dispute-window hold. With the fix, it throws.
      const db = new MockDriver()
        .script(/FROM sqlite_master/, TABLES_PRESENT_ROWS(["relay_settlements", "relay_disputes"]))
        .script(/FROM relay_settlements/, {
          kind: "throw",
          error: new Error("SQLITE_BUSY: database is locked"),
        });
      const store = new SqliteAccountStore(db);
      expect(() => store.getUnwithdrawableHold("motebit_x")).toThrow(/SQLITE_BUSY/);
    });
  });

  describe("getSweepConfig", () => {
    it("returns null pair when agent_registry table is absent", () => {
      const db = new MockDriver().script(/FROM sqlite_master/, { kind: "rows", rows: [] });
      const store = new SqliteAccountStore(db);
      expect(store.getSweepConfig("motebit_x")).toEqual({
        sweep_threshold: null,
        settlement_address: null,
      });
    });

    it("returns null pair when the row is missing but the table exists", () => {
      const db = new MockDriver()
        .script(/FROM sqlite_master/, TABLES_PRESENT_ROWS(["agent_registry"]))
        .script(/FROM agent_registry/, { kind: "rows", rows: [] });
      const store = new SqliteAccountStore(db);
      expect(store.getSweepConfig("motebit_x")).toEqual({
        sweep_threshold: null,
        settlement_address: null,
      });
    });

    it("returns the row fields when present", () => {
      const db = new MockDriver()
        .script(/FROM sqlite_master/, TABLES_PRESENT_ROWS(["agent_registry"]))
        .script(/FROM agent_registry/, {
          kind: "rows",
          rows: [{ sweep_threshold: 5_000_000, settlement_address: "0xdead" }],
        });
      const store = new SqliteAccountStore(db);
      expect(store.getSweepConfig("motebit_x")).toEqual({
        sweep_threshold: 5_000_000,
        settlement_address: "0xdead",
      });
    });

    it("propagates SQL errors — does NOT silently return the null pair", () => {
      const db = new MockDriver()
        .script(/FROM sqlite_master/, TABLES_PRESENT_ROWS(["agent_registry"]))
        .script(/FROM agent_registry/, {
          kind: "throw",
          error: new Error("SQLITE_CORRUPT: database disk image is malformed"),
        });
      const store = new SqliteAccountStore(db);
      expect(() => store.getSweepConfig("motebit_x")).toThrow(/SQLITE_CORRUPT/);
    });
  });

  describe("probe uses sqlite_master, not a try/catch", () => {
    it("does NOT catch the probe's own error — a driver-level failure on the probe surfaces", () => {
      // If the DatabaseDriver itself is broken (not just missing a table),
      // that's not a 'minimal test setup' — the caller should see the
      // error. This guards against a regression where someone wraps the
      // probe in try/catch and re-introduces silent fallbacks.
      const db = new MockDriver().script(/FROM sqlite_master/, {
        kind: "throw",
        error: new Error("driver panic"),
      });
      const store = new SqliteAccountStore(db);
      expect(() => store.getUnwithdrawableHold("motebit_x")).toThrow(/driver panic/);
      expect(() => store.getSweepConfig("motebit_x")).toThrow(/driver panic/);
    });
  });

  describe("createAccountTables import is intact (unchanged by H2)", () => {
    it("is still exported and callable", () => {
      expect(typeof createAccountTables).toBe("function");
    });
  });
});
