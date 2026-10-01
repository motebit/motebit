/**
 * #890 round 9 — an answer and its settlement are ONE decision.
 *
 *   C1  the answer never changes on eviction: a replacement the queue shows
 *       is the answer the archive shows (relay_receipts is keyed
 *       (motebit_id, task_id), insert-only — the same executor's second
 *       receipt never reaches it);
 *   C2  settlement is performed from the entry's CURRENT receipt, claimed in
 *       the same synchronous turn that answers it — sequentially (failed
 *       settles, a completed arrives) and in the race (a completed arrives
 *       while the failed door is inside its awaits: trust, sub-receipts,
 *       signSettlement), with deterministic injected await points;
 *   FROZEN  a settled answer is never replaced: a different answer is 409
 *       carrying the settled answer; a byte-identical repeat stays 200;
 *   CAP  the queue refuses, at RUNTIME, every write that changes an answer
 *       without the answer capability (Object.assign / spread into `set`,
 *       `update`, raw SQL UPDATE, INSERT OR REPLACE, a forged capability),
 *       and every stale copy that would regress one.
 *
 * Oracles, per run:
 *   ONE   exactly one settlement row for X, on the receipt the poll shows
 *         (`receipt_hash` = the answer's `result_hash`);
 *   POS   a door that answered 2xx holds the poll's answer;
 *   EVICT the poll after the queue forgets X equals the poll before.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation, receipt and envelope signing
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  sign,
  canonicalJson,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";
import { createTestRelay, createAgent, JSON_AUTH, AUTH_HEADER } from "./test-helpers.js";
import { recordTaskRoute } from "../task-routing.js";
import {
  TaskQueue,
  AnswerWriteRefused,
  issueAnswerCapability,
  installSettlementGuards,
} from "../task-queue.js";
import { persistReceiptChain, getArchivedReceiptForKeyOwner } from "../receipts-store.js";
import type { TaskQueueEntry } from "../tasks.js";

const PORT = 18961;
let server: Server;

beforeAll(async () => {
  // W's MCP endpoint: takes the presentation, answers nothing (the doors
  // under test are the result POST and the federation result).
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

interface Agent {
  id: string;
  device: string;
  kp: KeyPair;
}
interface World {
  relay: SyncRelay;
  D: Agent;
  W: Agent;
  peer: { id: string; kp: KeyPair };
}

async function agent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { id: a.motebitId, device: a.deviceId, kp };
}

async function world(): Promise<World> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const relay = await createTestRelay({ enableDeviceAuth: false });
  const D = await agent(relay);
  const W = await agent(relay);
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: W.id,
      endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
      capabilities: ["cap890r9"],
    }),
  });
  const peer = { id: `peer-${crypto.randomUUID()}`, kp: await generateKeypair() };
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at)
       VALUES (?, ?, ?, 'peer', 'active', ?)`,
    )
    .run(peer.id, bytesToHex(peer.kp.publicKey), `http://${peer.id}.invalid`, Date.now());
  return { relay, D, W, peer };
}

/** W's receipt for X; `result_hash` names the receipt, so the settlement row says which one it settled. */
async function receiptBy(
  who: Agent,
  relayTaskId: string,
  status: "completed" | "failed",
): Promise<ExecutionReceipt> {
  const now = Date.now();
  return signExecutionReceipt(
    {
      task_id: relayTaskId,
      relay_task_id: relayTaskId,
      motebit_id: who.id as MotebitId,
      device_id: who.device as DeviceId,
      submitted_at: now - 100,
      completed_at: now,
      status,
      result: `${status} result with enough text to count as real work`,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "p",
      result_hash: `h-${status}-${crypto.randomUUID()}`,
    },
    who.kp.privateKey,
  ) as Promise<ExecutionReceipt>;
}

async function admit(w: World): Promise<string> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: `r9 ${crypto.randomUUID()}`,
      required_capabilities: ["cap890r9"],
      submitted_by: w.D.id,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  await new Promise((r) => setTimeout(r, 60)); // the MCP presentation lands
  // The ranked federated route: W through `peer` too.
  recordTaskRoute(w.relay.moteDb.db, task_id, w.W.id, w.peer.id);
  return task_id;
}

interface DoorOutcome {
  status: number;
  body: { status?: string; receipt?: ExecutionReceipt | null; code?: string };
}

async function postResult(w: World, X: string, r: ExecutionReceipt): Promise<DoorOutcome> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task/${X}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(r),
  });
  let body: DoorOutcome["body"] = {};
  try {
    body = (await res.json()) as DoorOutcome["body"];
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

async function fedResult(w: World, X: string, r: ExecutionReceipt): Promise<DoorOutcome> {
  const payload = { task_id: X, origin_relay: w.peer.id, receipt: r, timestamp: Date.now() };
  const sig = await sign(new TextEncoder().encode(canonicalJson(payload)), w.peer.kp.privateKey);
  const res = await w.relay.app.request("/federation/v1/task/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
  });
  return { status: res.status, body: {} };
}

async function poll(w: World, X: string): Promise<ExecutionReceipt | null> {
  const r = await w.relay.app.request(`/agent/${w.D.id}/task/${X}`, { headers: AUTH_HEADER });
  if (!r.ok) return null;
  return ((await r.json()) as { receipt?: ExecutionReceipt | null }).receipt ?? null;
}

function settlements(w: World, X: string): Array<{ receipt_hash: string; status: string }> {
  return w.relay.moteDb.db
    .prepare("SELECT receipt_hash, status FROM relay_settlements WHERE task_id = ?")
    .all(X) as Array<{ receipt_hash: string; status: string }>;
}

/** Run `fn` as the pre-deploy relay did: without the settlement guards (#890 r9). */
function preDeploy(db: SyncRelay["moteDb"]["db"], fn: () => unknown): void {
  const guards = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE '%_claim_guard' OR name LIKE '%_one_settlement_guard' OR name LIKE '%settlement_credit_guard' OR name LIKE '%settled_frozen_guard')",
    )
    .all() as Array<{ name: string }>;
  for (const g of guards) db.exec(`DROP TRIGGER ${g.name}`);
  try {
    fn();
  } finally {
    installSettlementGuards(db);
  }
}

const tag = (r: ExecutionReceipt | null): string =>
  r == null ? "none" : `${r.status}/${r.result_hash}`;

/** ONE + POS + EVICT for X after its doors ran. */
async function oracles(
  w: World,
  X: string,
  doors: Array<{ name: string; sent: ExecutionReceipt; out: DoorOutcome }>,
): Promise<string[]> {
  const failures: string[] = [];
  const live = await poll(w, X);
  const rows = settlements(w, X);
  if (rows.length !== 1) failures.push(`ONE: ${rows.length} settlement rows for X`);
  else if (live == null || rows[0]!.receipt_hash !== live.result_hash) {
    failures.push(
      `ONE: settled on ${rows[0]!.receipt_hash} (${rows[0]!.status}) but the poll shows ${tag(live)}`,
    );
  }
  for (const d of doors) {
    if (d.out.status < 300 && (live == null || live.signature !== d.sent.signature)) {
      failures.push(
        `POS: the ${d.name} door answered ${d.out.status} ${d.out.body.status ?? ""} but the poll shows ${tag(live)}`,
      );
    }
  }
  w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
  const evicted = await poll(w, X);
  if (tag(evicted) !== tag(live)) {
    failures.push(`EVICT: the answer ${tag(live)} became ${tag(evicted)} once the queue forgot X`);
  }
  return failures;
}

describe("#890 r9 C1 — the answer never changes on eviction", () => {
  it("W answers failed, then completed: the poll answers the same before and after the queue forgets X", async () => {
    const w = await world();
    try {
      const X = await admit(w);
      const failed = await receiptBy(w.W, X, "failed");
      const completed = await receiptBy(w.W, X, "completed");
      const a = await postResult(w, X, failed);
      expect(a.status).toBe(200);
      const b = await postResult(w, X, completed);
      const live = await poll(w, X);
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(X);
      const evicted = await poll(w, X);
      expect({ live: tag(live), evicted: tag(evicted), second: b.status }).toEqual({
        live: tag(failed),
        evicted: tag(failed),
        second: 409,
      });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 C2 — settlement is the entry's current answer, claimed with it", () => {
  it("sequential: failed settles (refunded), then completed arrives — refused 409 with the settled answer; one settlement, on the answer", async () => {
    const w = await world();
    try {
      const X = await admit(w);
      const failed = await receiptBy(w.W, X, "failed");
      const completed = await receiptBy(w.W, X, "completed");
      const a = await postResult(w, X, failed);
      const b = await postResult(w, X, completed);
      const failures = await oracles(w, X, [
        { name: "failed POST", sent: failed, out: a },
        { name: "completed POST", sent: completed, out: b },
      ]);
      expect(b.status).toBe(409);
      expect(b.body.receipt?.signature).toBe(failed.signature);
      expect(failures).toEqual([]);
    } finally {
      await w.relay.close();
    }
  });

  for (const second of ["post", "fed"] as const) {
    it(`race ×20: a completed (${second} door) arrives while the failed POST is inside its awaits — one decision, one settlement`, async () => {
      const w = await world();
      try {
        const failures: string[] = [];
        const store = w.relay.moteDb.agentTrustStore;
        const realGetTrust = store.getAgentTrust.bind(store);
        for (let i = 0; i < 20; i++) {
          const X = await admit(w);
          const failed = await receiptBy(w.W, X, "failed");
          const completed = await receiptBy(w.W, X, "completed");
          // The injected await point: the failed door's trust read (reached
          // after its answer is taken, before settlement signing) blocks
          // until the completed door has run to its end.
          let entered!: () => void;
          const inside = new Promise<void>((r) => (entered = r));
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          let armed = true;
          const spy = vi
            .spyOn(store, "getAgentTrust")
            .mockImplementation(async (...args: Parameters<typeof store.getAgentTrust>) => {
              if (armed) {
                armed = false;
                entered();
                await gate;
              }
              return realGetTrust(...args);
            });
          try {
            const pFailed = postResult(w, X, failed);
            // Either the failed door reaches its await point, or it finished
            // without one (then the race is sequential — still judged).
            await Promise.race([inside, pFailed]);
            const b =
              second === "post"
                ? await postResult(w, X, completed)
                : await fedResult(w, X, completed);
            release();
            const a = await pFailed;
            for (const f of await oracles(w, X, [
              { name: "failed POST", sent: failed, out: a },
              { name: `completed ${second}`, sent: completed, out: b },
            ])) {
              failures.push(`#${i}: ${f}`);
            }
          } finally {
            release();
            spy.mockRestore();
          }
        }
        expect(failures).toEqual([]);
      } finally {
        await w.relay.close();
      }
    }, 120_000);
  }
});

describe("#890 r9 an UNSETTLED answer — the only one a completed may replace", () => {
  it("an entry answered failed before the settlement claim existed (no claim, no settlement): W's completed replaces it, is settled once, and the poll answers it after eviction too", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const X = await admit(w);
      const failed = await receiptBy(w.W, X, "failed");
      // The pre-deploy relay's answer: receipt + status written, archived in
      // relay_receipts, never claimed for settlement, never settled (one
      // version step — the queue's triggers refuse any other raw write).
      db.prepare(
        `UPDATE relay_task_queue SET receipt = ?, status = 'failed',
           task_json = json_set(task_json, '$.task.status', 'failed'),
           answer_version = answer_version + 1
         WHERE task_id = ?`,
      ).run(JSON.stringify(failed), X);
      persistReceiptChain(db, failed);
      expect(tag(await poll(w, X))).toBe(tag(failed));
      const completed = await receiptBy(w.W, X, "completed");
      const b = await postResult(w, X, completed);
      expect(b.status).toBe(200);
      expect(await oracles(w, X, [{ name: "completed POST", sent: completed, out: b }])).toEqual(
        [],
      );
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 a legacy answer a settlement row already names is SETTLED", () => {
  it("an entry answered failed before the claim existed, but settled (refunded) then: W's completed is refused 409; one settlement, on the answer", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const X = await admit(w);
      const failed = await receiptBy(w.W, X, "failed");
      db.prepare(
        `UPDATE relay_task_queue SET receipt = ?, status = 'failed',
           task_json = json_set(task_json, '$.task.status', 'failed'),
           answer_version = answer_version + 1
         WHERE task_id = ?`,
      ).run(JSON.stringify(failed), X);
      persistReceiptChain(db, failed);
      // Its settlement ran (the pre-deploy relay did not always mark it, and
      // wrote no receipt signature — its guards did not exist).
      preDeploy(db, () =>
        db
          .prepare(
            `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, 'refunded', ?)`,
          )
          .run(crypto.randomUUID(), crypto.randomUUID(), X, w.D.id, failed.result_hash, Date.now()),
      );
      const completed = await receiptBy(w.W, X, "completed");
      const b = await postResult(w, X, completed);
      expect(b.status).toBe(409);
      expect(await oracles(w, X, [{ name: "completed POST", sent: completed, out: b }])).toEqual(
        [],
      );
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 FROZEN — a settled answer is never replaced", () => {
  it("after W's completed settles: a byte-identical repeat is 200 already_settled; a different answer is 409 carrying the settled one", async () => {
    const w = await world();
    try {
      const X = await admit(w);
      const completed = await receiptBy(w.W, X, "completed");
      expect((await postResult(w, X, completed)).status).toBe(200);
      const again = await postResult(w, X, completed);
      expect({ status: again.status, body: again.body.status }).toEqual({
        status: 200,
        body: "already_settled",
      });
      const other = await postResult(w, X, await receiptBy(w.W, X, "completed"));
      expect(other.status).toBe(409);
      expect(other.body.receipt?.signature).toBe(completed.signature);
      expect(tag(await poll(w, X))).toBe(tag(completed));
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 CAP — only the answer capability writes an answer, and never over a newer one", () => {
  it("a stale copy set after the answer is refused, and the answer stands", async () => {
    const w = await world();
    try {
      const q = new TaskQueue(w.relay.moteDb.db);
      const X = await admit(w);
      const stale = q.get(X)!;
      const completed = await receiptBy(w.W, X, "completed");
      expect((await postResult(w, X, completed)).status).toBe(200);
      expect(() => q.set(X, stale)).toThrow(/stale copy/);
      expect(() => q.update(X, () => {})).not.toThrow(); // a fresh read-modify-write of nothing
      expect(tag(await poll(w, X))).toBe(tag(completed));
    } finally {
      await w.relay.close();
    }
  });

  it("capability-less writers throw: Object.assign, spread into set, update, settled flag, raw SQL UPDATE, INSERT OR REPLACE, a forged capability", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const q = new TaskQueue(db);
      const X = await admit(w);
      const forged = await receiptBy(w.W, X, "failed");
      // Which LAYER refused: the queue's capability guard (AnswerWriteRefused)
      // for every writer through TaskQueue, the table's triggers for raw SQL.
      const threw: Record<string, string> = {};
      const attempt = (name: string, fn: () => unknown): void => {
        try {
          fn();
          threw[name] = "none";
        } catch (err) {
          threw[name] =
            err instanceof AnswerWriteRefused
              ? "queue"
              : err instanceof Error && err.name === "SqliteError"
                ? "table"
                : "other";
        }
      };
      attempt("Object.assign", () => {
        const e = q.get(X)!;
        Object.assign(e, { receipt: forged });
        e.task.status = AgentTaskStatus.Failed;
        q.set(X, e);
      });
      attempt("spread", () => {
        const e = q.get(X)!;
        q.set(X, { ...e, receipt: forged } as TaskQueueEntry);
      });
      attempt("bracket", () => {
        const e = q.get(X)! as unknown as Record<string, unknown>;
        e["receipt"] = forged;
        q.set(X, e as unknown as TaskQueueEntry);
      });
      attempt("terminal status", () => {
        const e = q.get(X)!;
        q.set(X, { ...e, task: { ...e.task, status: AgentTaskStatus.Completed } });
      });
      attempt("update", () =>
        q.update(X, (e) => {
          e.receipt = forged;
        }),
      );
      attempt("settled flag", () => {
        const e = q.get(X)!;
        q.set(X, { ...e, settled: true });
      });
      attempt("SQL UPDATE receipt", () =>
        db
          .prepare("UPDATE relay_task_queue SET receipt = ?, status = 'failed' WHERE task_id = ?")
          .run(JSON.stringify(forged), X),
      );
      attempt("SQL UPDATE settled", () =>
        db
          .prepare(
            "UPDATE relay_task_queue SET task_json = json_set(task_json, '$.settled', json('true')) WHERE task_id = ?",
          )
          .run(X),
      );
      attempt("SQL INSERT OR REPLACE", () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO relay_task_queue (task_id, status, prompt, receipt, created_at, expires_at, task_json)
             SELECT task_id, 'failed', prompt, ?, created_at, expires_at, task_json FROM relay_task_queue WHERE task_id = ?`,
          )
          .run(JSON.stringify(forged), X),
      );
      attempt("forged capability", () =>
        (
          q as unknown as {
            writeAnswer: (
              cap: unknown,
              id: string,
              v: number,
              m: (e: TaskQueueEntry) => void,
            ) => unknown;
          }
        ).writeAnswer({}, X, 0, (e) => {
          e.receipt = forged;
        }),
      );
      attempt("insert answered", () => {
        const e = q.get(X)!;
        const Y = crypto.randomUUID();
        q.set(Y, { ...e, task: { ...e.task, task_id: Y }, answer_version: 0, receipt: forged });
      });
      attempt("SQL INSERT answered", () =>
        db
          .prepare(
            `INSERT INTO relay_task_queue (task_id, status, prompt, receipt, created_at, expires_at, task_json)
             SELECT ?, status, prompt, ?, created_at, expires_at, task_json FROM relay_task_queue WHERE task_id = ?`,
          )
          .run(crypto.randomUUID(), JSON.stringify(forged), X),
      );
      attempt("issue a second capability", () => issueAnswerCapability());
      expect(threw).toEqual({
        "Object.assign": "queue",
        spread: "queue",
        bracket: "queue",
        "terminal status": "queue",
        update: "queue",
        "settled flag": "queue",
        "SQL UPDATE receipt": "table",
        "SQL UPDATE settled": "table",
        "SQL INSERT OR REPLACE": "table",
        "forged capability": "queue",
        "insert answered": "queue",
        "SQL INSERT answered": "table",
        "issue a second capability": "other",
      });
      // Nothing took: X is unanswered, and W's real answer still takes.
      expect(await poll(w, X)).toBeNull();
      const completed = await receiptBy(w.W, X, "completed");
      expect((await postResult(w, X, completed)).status).toBe(200);
      expect(tag(await poll(w, X))).toBe(tag(completed));
      // Positive control: a non-answer write at the current version is fine.
      const e = q.get(X)!;
      expect(() => q.set(X, { ...e, expiresAt: e.expiresAt + 1 })).not.toThrow();
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 the archive answers a key owner only from its OWN admission's executor — answer table and legacy archive alike", () => {
  it("an executor recorded only by a peer's inbound forward never answers; the admission's executor does", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const T = await agent(w.relay); // the executor a peer's forward handed an id to
      const read = (X: string): string | null =>
        getArchivedReceiptForKeyOwner(db, w.D.id, X, Date.now() - 60_000);
      const ownKey = (X: string): void => {
        db.prepare(
          "INSERT INTO relay_idempotency_keys (idempotency_key, motebit_id, status, created_at, task_id) VALUES (?, ?, 'completed', ?, ?)",
        ).run(crypto.randomUUID(), w.D.id, Date.now(), X);
      };
      const answerRow = (X: string, r: ExecutionReceipt): void => {
        db.prepare(
          `INSERT INTO relay_task_answers (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
           VALUES (?, ?, ?, ?, NULL, 1, 2, ?)`,
        ).run(X, r.motebit_id, r.status, JSON.stringify(r), Date.now());
      };
      const out: Record<string, boolean> = {};
      // (a) the answer table
      const A1 = crypto.randomUUID();
      ownKey(A1);
      recordTaskRoute(db, A1, T.id, w.peer.id, "inbound_forward", w.peer.id);
      answerRow(A1, await receiptBy(T, A1, "failed"));
      out["answer table: inbound executor"] = read(A1) != null;
      const A2 = crypto.randomUUID();
      ownKey(A2);
      recordTaskRoute(db, A2, w.W.id);
      answerRow(A2, await receiptBy(w.W, A2, "completed"));
      out["answer table: admission executor"] = read(A2) != null;
      // (b) the legacy audit archive (no answer row)
      const L1 = crypto.randomUUID();
      ownKey(L1);
      recordTaskRoute(db, L1, T.id, w.peer.id, "inbound_forward", w.peer.id);
      persistReceiptChain(db, await receiptBy(T, L1, "failed"));
      out["legacy: inbound executor"] = read(L1) != null;
      const L2 = crypto.randomUUID();
      ownKey(L2);
      recordTaskRoute(db, L2, w.W.id);
      persistReceiptChain(db, await receiptBy(w.W, L2, "completed"));
      out["legacy: admission executor"] = read(L2) != null;
      expect(out).toEqual({
        "answer table: inbound executor": false,
        "answer table: admission executor": true,
        "legacy: inbound executor": false,
        "legacy: admission executor": true,
      });
    } finally {
      await w.relay.close();
    }
  });
});
