/**
 * #846 v4 — `BoundIdentity` is a runtime capability, so a forged one fails
 * AT THE WRITE, whatever the types say.
 *
 * The #860 review forged a `BoundIdentity` six ways in ordinary TypeScript
 * (F1–F6 below, verbatim shapes), each calling the real
 * `setSubscriptionStatus`; every one compiled and v3's type-flow gate stayed
 * green. Chasing TypeScript escapes cannot win, so v4 stops relying on the
 * type: a `BoundIdentity` is an object carrying an ES private field that only
 * `identity-binding.ts` can construct, and every registered writer reads its
 * owner only through `unwrapBound`, which performs the private-brand check
 * and throws. Each forgery here must THROW and leave the victim's row
 * byte-for-byte unchanged. A positive control writes through a genuine mint,
 * so "unchanged" is never the vacuous result of a writer that cannot write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";
import {
  appendBoundEvent,
  bindSocketEntries,
  BoundIdentity,
  unwrapBound,
} from "../identity-binding.js";
import { setSubscriptionStatus } from "../subscriptions.js";
import {
  upsertSyncConversation,
  upsertSyncMessage,
  upsertSyncPlan,
  upsertSyncPlanStep,
} from "../data-sync.js";
import { updateMigrationState } from "../migration.js";
import { insertApproval } from "../key-rotation.js";
import { insertSubmittedCredential } from "../credentials.js";
import { insertDelegationRevocation } from "../delegation-revocations.js";

const VICTIM = "victim-motebit";

// ── The #860 review's forgeries, in the reviewer's own shapes ────────────

// F1: nested-brand row assertion (the relay's everyday `.get(x) as {...}` style)
function forgeRowCast(db: DatabaseDriver, victim: string): void {
  const row = db.prepare("SELECT ? AS motebit_id").get(victim) as
    { motebit_id: BoundIdentity } | undefined;
  if (row) setSubscriptionStatus(db, row.motebit_id, "active", "cancelled");
}

// F2: type predicate
function isOwner(id: unknown): id is BoundIdentity {
  return typeof id === "string" && id.length > 0;
}
function forgePredicate(db: DatabaseDriver, victim: string): void {
  const v: unknown = victim;
  if (isOwner(v)) setSubscriptionStatus(db, v, "active", "cancelled");
}

// F3: assertion function
function assertOwner(id: unknown): asserts id is BoundIdentity {
  void id;
}
function forgeAsserts(db: DatabaseDriver, victim: string): void {
  const v: unknown = victim;
  assertOwner(v);
  setSubscriptionStatus(db, v, "active", "cancelled");
}

// F4: overload
function asOwner(id: string): BoundIdentity;
function asOwner(id: string): unknown {
  return id;
}
function forgeOverload(db: DatabaseDriver, victim: string): void {
  setSubscriptionStatus(db, asOwner(victim), "active", "cancelled");
}

// F5: destructuring from `any` (JSON.parse) under an annotated container
function forgeDestructure(db: DatabaseDriver, json: string): void {
  const { owner }: { owner: BoundIdentity } = JSON.parse(json);
  setSubscriptionStatus(db, owner, "active", "cancelled");
}

// F6: tuple cast
function forgeTuple(db: DatabaseDriver, victim: string): void {
  const [owner] = [victim] as unknown as [BoundIdentity];
  setSubscriptionStatus(db, owner, "active", "cancelled");
}

// F7: generic object-wrapped (the reviewer's extra)
function box<T>(x: unknown): { v: T } {
  return { v: x as T };
}
function forgeBox(db: DatabaseDriver, victim: string): void {
  setSubscriptionStatus(db, box<BoundIdentity>(victim).v, "active", "cancelled");
}

// F8: the #853 review's `as never`
function forgeNever(db: DatabaseDriver, victim: string): void {
  setSubscriptionStatus(db, victim as never, "active", "cancelled");
}

// ── Runtime forgeries: values that are objects, not strings ──────────────

/** A genuine mint, for the positive control and as the raw material of a proxy. */
function genuine(id: string): BoundIdentity {
  const b = bindSocketEntries([], id);
  if (b === null) throw new Error("unreachable: an empty batch always binds");
  return b;
}

type AnyCtor = new (...args: unknown[]) => object;
const Ctor = BoundIdentity as unknown as AnyCtor;

const RUNTIME_FORGERIES: ReadonlyArray<[string, () => BoundIdentity]> = [
  [
    "Object.create(BoundIdentity.prototype)",
    () => Object.create(BoundIdentity.prototype) as BoundIdentity,
  ],
  ["new BoundIdentity(victim) past `private`", () => new Ctor(VICTIM) as BoundIdentity],
  [
    "new BoundIdentity(<a look-alike key>, victim)",
    () => new Ctor(Symbol("identity-binding.mint"), VICTIM) as BoundIdentity,
  ],
  [
    "a subclass calling super with a look-alike key",
    () => {
      class Evil extends Ctor {
        constructor() {
          super(Symbol("identity-binding.mint"), VICTIM);
        }
      }
      return new Evil() as BoundIdentity;
    },
  ],
  [
    "a Proxy over a genuine mint for another identity",
    () =>
      new Proxy(genuine("attacker"), {
        get: (_t, p) => (p === "toString" ? () => VICTIM : undefined),
      }) as BoundIdentity,
  ],
  [
    "a look-alike object with the prototype swapped in",
    () => Object.setPrototypeOf({ id: VICTIM }, BoundIdentity.prototype) as BoundIdentity,
  ],
  ["new String(victim)", () => new String(VICTIM) as unknown as BoundIdentity],
];

describe("a forged BoundIdentity throws at the write and writes nothing (#846 v4)", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;
  const subRow = () =>
    db.prepare("SELECT * FROM relay_subscriptions WHERE motebit_id = ?").get(VICTIM);

  beforeEach(async () => {
    relay = await createTestRelay();
    db = relay.moteDb.db;
    db.prepare(
      "INSERT INTO relay_subscriptions (motebit_id, status, created_at, updated_at) VALUES (?, 'active', 1, 1)",
    ).run(VICTIM);
  });
  afterEach(async () => {
    await relay.close();
  });

  const REVIEW_FORGERIES: ReadonlyArray<[string, () => void]> = [
    ["F1 row cast `.get() as { motebit_id: BoundIdentity }`", () => forgeRowCast(db, VICTIM)],
    ["F2 type predicate `id is BoundIdentity`", () => forgePredicate(db, VICTIM)],
    ["F3 `asserts id is BoundIdentity`", () => forgeAsserts(db, VICTIM)],
    ["F4 overload returning BoundIdentity", () => forgeOverload(db, VICTIM)],
    [
      "F5 destructured from JSON.parse",
      () => forgeDestructure(db, JSON.stringify({ owner: VICTIM })),
    ],
    ["F6 `[victim] as unknown as [BoundIdentity]`", () => forgeTuple(db, VICTIM)],
    ["F7 generic box<BoundIdentity>", () => forgeBox(db, VICTIM)],
    ["F8 `victim as never` (#853)", () => forgeNever(db, VICTIM)],
  ];

  for (const [name, forge] of REVIEW_FORGERIES) {
    it(`${name}: setSubscriptionStatus throws; the victim's row is unchanged`, () => {
      const before = subRow();
      expect(forge).toThrow(/not a BoundIdentity/);
      expect(subRow()).toEqual(before);
      expect((subRow() as { status: string }).status).toBe("active");
    });
  }

  for (const [name, make] of RUNTIME_FORGERIES) {
    it(`${name}: cannot be constructed, or throws at the write; the row is unchanged`, () => {
      const before = subRow();
      expect(() => setSubscriptionStatus(db, make(), "active", "cancelled")).toThrow(TypeError);
      expect(subRow()).toEqual(before);
    });
  }

  it("positive control: a genuine mint for the victim does write (the writer is live)", () => {
    expect(setSubscriptionStatus(db, genuine(VICTIM), "active", "cancelled")).toBe(true);
    expect((subRow() as { status: string }).status).toBe("cancelled");
  });

  it("unwrapBound reads a genuine mint and nothing else", () => {
    expect(unwrapBound(genuine("x"))).toBe("x");
    expect(() => unwrapBound("x" as never)).toThrow(/not a BoundIdentity/);
    expect(() => unwrapBound(null as never)).toThrow(/not a BoundIdentity/);
    // A genuine mint never renders its identity by accident.
    expect(String(genuine("x"))).toBe("[BoundIdentity]");
    expect(JSON.stringify({ o: genuine("x") })).toBe('{"o":"[BoundIdentity]"}');
  });
});

describe("every registered identity-row writer refuses a forged owner (#846 v4)", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;
  const forged = VICTIM as unknown as BoundIdentity;
  const total = (): number => {
    const tables = [
      "sync_conversations",
      "sync_conversation_messages",
      "sync_plans",
      "sync_plan_steps",
      "relay_migrations",
      "relay_approval_metadata",
      "events",
      "relay_credentials",
      "relay_delegation_revocations",
    ];
    return tables.reduce(
      (n, t) => n + (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      0,
    );
  };

  beforeEach(async () => {
    relay = await createTestRelay();
    db = relay.moteDb.db;
    db.prepare(
      "INSERT INTO relay_migrations (token_id, motebit_id, state, issued_at, expires_at, token_signature) VALUES ('t-v', ?, 'initiated', 1, 9999999999999, 's')",
    ).run(VICTIM);
  });
  afterEach(async () => {
    await relay.close();
  });

  const WRITERS: ReadonlyArray<[string, () => unknown]> = [
    [
      "upsertSyncConversation",
      () =>
        upsertSyncConversation(db, forged, {
          conversation_id: "c1",
          motebit_id: VICTIM as never,
          started_at: 1,
          last_active_at: 2,
          title: null,
          summary: null,
          message_count: 1,
        }),
    ],
    [
      "upsertSyncMessage",
      () =>
        upsertSyncMessage(db, forged, {
          message_id: "m1",
          conversation_id: "c1",
          motebit_id: VICTIM as never,
          role: "user",
          content: "",
          tool_calls: null,
          tool_call_id: null,
          created_at: 1,
          token_estimate: 1,
        }),
    ],
    ["upsertSyncPlan", () => upsertSyncPlan(db, forged, { motebit_id: VICTIM } as never)],
    ["upsertSyncPlanStep", () => upsertSyncPlanStep(db, forged, { motebit_id: VICTIM } as never)],
    ["updateMigrationState", () => updateMigrationState(db, forged, "t-v", "departed")],
    [
      "insertApproval",
      () =>
        insertApproval(db, forged, {
          approvalId: "a1",
          toolName: "t",
          argsHash: "h",
          quorumRequired: 1,
          quorumApprovers: "[]",
          quorumHash: "",
        }),
    ],
    [
      "insertSubmittedCredential",
      () =>
        insertSubmittedCredential(db, forged, {
          credentialId: "urn:uuid:forged",
          issuerDid: "did:key:zIssuer",
          credentialType: "AgentReputationCredential",
          credentialJson: "{}",
        }),
    ],
    [
      "insertDelegationRevocation",
      () =>
        insertDelegationRevocation(db, forged, {
          grant_id: "g1",
          delegator_id: VICTIM,
          delegator_public_key: "00".repeat(32),
          revoked_at: 1,
          suite: "motebit-jcs-ed25519-b64-v1",
          signature: "sig",
        } as never),
    ],
  ];

  for (const [name, write] of WRITERS) {
    it(`${name}: throws on a cast string; nothing is written or changed`, () => {
      const before = total();
      const migration = db.prepare("SELECT * FROM relay_migrations").all();
      expect(write).toThrow(/not a BoundIdentity/);
      expect(total()).toBe(before);
      expect(db.prepare("SELECT * FROM relay_migrations").all()).toEqual(migration);
    });
  }

  it("appendBoundEvent: throws on a cast string; no event is appended", () => {
    const before = total();
    expect(() =>
      appendBoundEvent(
        relay.moteDb.db,
        forged,
        {
          event_id: "e1",
          motebit_id: VICTIM as never,
          timestamp: 1,
          event_type: "memory_formed" as never,
          payload: {},
          version_clock: 1,
          tombstoned: false,
        },
        false,
      ),
    ).toThrow(/not a BoundIdentity/);
    expect(total()).toBe(before);
  });
});
