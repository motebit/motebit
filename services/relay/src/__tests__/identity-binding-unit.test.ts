/**
 * #846 v2 — the binding primitives and the owner guards inside the branded
 * write helpers, each proven on its own.
 *
 * Every route test reaches these through middleware that already refuses a
 * missing credential, and through a binding that already matched the owner —
 * so a guard here could be deleted and no route test would notice. These
 * tests call them directly, with the layer in front removed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";
import { OPERATOR_PRESENTED, type AuthEvent } from "../auth-events.js";
import {
  appendBoundEvent,
  bindCaller,
  bindSocketEntries,
  bindSyncEntries,
  SYNC_PRESENTER_KEY,
  unwrapBound,
  type BoundIdentity,
} from "../identity-binding.js";
import { upsertSyncConversation, upsertSyncMessage } from "../data-sync.js";
import { updateMigrationState } from "../migration.js";

function fakeContext(vars: Record<string, unknown>): Context {
  return {
    get: (k: string) => vars[k],
    req: { path: "/p", method: "POST", header: () => undefined },
  } as unknown as Context;
}

/** A genuine mint: the socket binder with no entries binds the socket's identity. */
const bound = (id: string): BoundIdentity => {
  const b = bindSocketEntries([], id);
  if (b === null) throw new Error("unreachable");
  return b;
};
const idOf = (b: BoundIdentity | null): string | null => (b === null ? null : unwrapBound(b));

describe("bindCaller", () => {
  const record: AuthEvent[] = [];
  const opts = { recordAuthEvent: (e: AuthEvent) => record.push(e), reason: "t" };
  beforeEach(() => {
    record.length = 0;
  });

  it("binds a caller whose verified mid is the path identity", () => {
    expect(unwrapBound(bindCaller(fakeContext({ callerMotebitId: "B" }), "B", opts))).toBe("B");
    expect(record).toEqual([]);
  });

  it("refuses another identity's caller 403 and records the presenter", () => {
    expect(() => bindCaller(fakeContext({ callerMotebitId: "A" }), "B", opts)).toThrow(
      HTTPException,
    );
    expect(record).toEqual([
      expect.objectContaining({ motebitId: "A", reason: "t:not_own_identity" }),
    ]);
  });

  it("refuses 401 when there is no caller AND no operator mark — an unset caller id is never the operator", () => {
    let status = 0;
    try {
      bindCaller(fakeContext({}), "B", opts);
    } catch (err) {
      status = (err as HTTPException).status;
    }
    expect(status).toBe(401);
    expect(record).toEqual([
      expect.objectContaining({ motebitId: null, reason: "t:unauthenticated" }),
    ]);
  });

  it("binds the operator only when the master token was marked", () => {
    expect(
      unwrapBound(bindCaller(fakeContext({ [OPERATOR_PRESENTED as string]: true }), "B", opts)),
    ).toBe("B");
  });
});

describe("bindSocketEntries", () => {
  it("mints only when every entry names the socket's identity", () => {
    expect(idOf(bindSocketEntries([{ motebit_id: "A" }], "A"))).toBe("A");
    expect(bindSocketEntries([{ motebit_id: "A" }, { motebit_id: "B" }], "A")).toBeNull();
    expect(bindSocketEntries([null], "A")).toBeNull();
  });
});

describe("bindSyncEntries (#846 v3)", () => {
  const record: AuthEvent[] = [];
  const rec = (e: AuthEvent) => record.push(e);
  beforeEach(() => {
    record.length = 0;
  });
  const status = (fn: () => unknown): number => {
    try {
      fn();
    } catch (err) {
      return (err as HTTPException).status;
    }
    return 0;
  };

  it("binds when the verified identity is the path identity and every entry names it", () => {
    const c = fakeContext({ [SYNC_PRESENTER_KEY]: "A" });
    expect(unwrapBound(bindSyncEntries(c, [{ motebit_id: "A" }], "A", rec))).toBe("A");
    expect(record).toEqual([]);
  });

  // The #853 shape, one layer down: the middleware verified the token for
  // one identity and the handler hands the binder another. The binder does
  // not trust the two readers to agree — it compares them, and refuses even
  // when every entry names the handler's identity.
  it("refuses 403 when the handler's path identity is not the identity the middleware verified", () => {
    const c = fakeContext({ [SYNC_PRESENTER_KEY]: "X" });
    expect(status(() => bindSyncEntries(c, [{ motebit_id: "V" }], "V", rec))).toBe(403);
    expect(record).toEqual([
      expect.objectContaining({
        motebitId: "X",
        reason: "sync:path_identity_not_verified_identity",
      }),
    ]);
  });

  it("refuses 403 an entry naming another identity, recorded under the presenter", () => {
    const c = fakeContext({ [SYNC_PRESENTER_KEY]: "A" });
    expect(status(() => bindSyncEntries(c, [{ motebit_id: "B" }], "A", rec))).toBe(403);
    expect(record).toEqual([
      expect.objectContaining({ motebitId: "A", reason: "sync:foreign_motebit_id" }),
    ]);
  });

  it("the master token (no presenter) binds to the path identity", () => {
    expect(unwrapBound(bindSyncEntries(fakeContext({}), [{ motebit_id: "B" }], "B", rec))).toBe(
      "B",
    );
  });
});

describe("owner guards inside the branded helpers", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });
  const count = (sql: string, ...a: unknown[]) =>
    (relay.moteDb.db.prepare(sql).get(...a) as { n: number }).n;

  it("upsertSyncConversation writes nothing for an entry that does not name its owner", () => {
    upsertSyncConversation(relay.moteDb.db, bound("A"), {
      conversation_id: "c1",
      motebit_id: "B" as never,
      started_at: 1,
      last_active_at: 2,
      title: null,
      summary: null,
      message_count: 1,
    });
    expect(count("SELECT COUNT(*) AS n FROM sync_conversations WHERE conversation_id = 'c1'")).toBe(
      0,
    );
  });

  it("upsertSyncMessage writes nothing for an entry that does not name its owner", () => {
    upsertSyncMessage(relay.moteDb.db, bound("A"), {
      message_id: "m1",
      conversation_id: "c1",
      motebit_id: "B" as never,
      role: "user",
      content: "",
      tool_calls: null,
      tool_call_id: null,
      created_at: 1,
      token_estimate: 1,
    });
    expect(
      count("SELECT COUNT(*) AS n FROM sync_conversation_messages WHERE message_id = 'm1'"),
    ).toBe(0);
  });

  it("appendBoundEvent refuses an entry that does not name its owner", () => {
    const ok = appendBoundEvent(
      relay.moteDb.db,
      bound("A"),
      {
        event_id: "e1",
        motebit_id: "B" as never,
        timestamp: 1,
        event_type: "memory_formed" as never,
        payload: {},
        version_clock: 1,
        tombstoned: false,
      },
      false,
    );
    expect(ok).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE event_id = 'e1'")).toBe(0);
  });

  it("updateMigrationState never moves another identity's migration", () => {
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_migrations (token_id, motebit_id, state, issued_at, expires_at, token_signature) VALUES ('t-B', 'B', 'initiated', 1, 9999999999999, 's')",
      )
      .run();
    updateMigrationState(relay.moteDb.db, bound("A"), "t-B", "departed");
    expect(
      (
        relay.moteDb.db
          .prepare("SELECT state FROM relay_migrations WHERE token_id = 't-B'")
          .get() as {
          state: string;
        }
      ).state,
    ).toBe("initiated");
  });
});
