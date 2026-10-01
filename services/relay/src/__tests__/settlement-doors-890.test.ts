/**
 * #890 round 9 (cold review C1/C2) — an answer and its settlement are ONE
 * decision, at EVERY door, through every entry state, across a crash.
 *
 * The exhaustive harness. A funded P2P task S (every settlement path writes
 * a row for it, so "exactly one settlement" is observable at every door) is
 * driven, through the REAL relay routes, over:
 *
 *   door      post — the result POST
 *             mcp  — S's MCP presentation answered by W's endpoint
 *             fed  — a federation result from the peer S was forwarded through
 *             sub  — S's receipt embedded in another task's answer (multi-hop)
 *   state     absent       S is gone from the queue
 *             queued       S is unanswered
 *             unclaimed    S answered before the claim existed (no `settling`)
 *             settling     S answered + claimed, its settlement never written
 *                          (a crash between the claim and the settle)
 *             settled      S answered, claimed, settled — one row
 *             legacy_row   S unanswered, but a legacy settlement row (no
 *                          receipt signature) already pays it
 *   receipt   same — the receipt S stands on (state's receipt) arrives again
 *             different — another receipt from W for S
 *   status    the arriving receipt's status (completed | failed; a different
 *             receipt's standing answer has the other status)
 *   crash     none | the door's settlement write fails once (the process
 *             "dies" between claim and settle), then the same receipt is
 *             retried (post/fed: the same door; mcp/sub: W's own POST)
 *
 * Invariants, per cell:
 *   ONE        the poll's answer, the entry's settled claim and the ONE
 *              settlement row (across both settlement tables) name the same
 *              receipt; no answer ⇒ no row a door wrote;
 *   POS        a door that answered 2xx holds the poll's answer;
 *   RETRY      the crashed door's retry settles the answer it claimed;
 *   NO CLAIM   after the next retry of the standing answer, no claimed
 *              answer is left unsettled;
 *   LAW        a frozen answer (claimed, settled, or a settlement row) is
 *              never replaced;
 *   EVICT      the poll after the queue forgets S equals the poll before.
 *
 * RED on b33081286 (C1: the sub-receipt door paid S without writing or
 * claiming it; C2: the federation door's repeat returned before settling).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { createTestRelay, createAgent, JSON_AUTH, AUTH_HEADER } from "./test-helpers.js";
import { recordTaskRoute, cleanupTaskRoutes, TASK_ROUTE_RETENTION_MS } from "../task-routing.js";
import * as taskQueueModule from "../task-queue.js";
import { TaskQueue } from "../task-queue.js";
import { persistReceiptChain } from "../receipts-store.js";

const PORT = 18971;

// ── W's MCP endpoint: answers each presented task from a script ──
const mcpReplies = new Map<string, (relayTaskId: string) => Promise<ExecutionReceipt | null>>();
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        res.setHeader("Content-Type", "application/json");
        let body: {
          method?: string;
          params?: { arguments?: { prompt?: string; relay_task_id?: string } };
        } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body;
        } catch {
          /* /health */
        }
        if (body.method === "tools/call") {
          const build = mcpReplies.get(body.params?.arguments?.prompt ?? "");
          const r = build != null ? await build(body.params?.arguments?.relay_task_id ?? "") : null;
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: r == null ? {} : { content: [{ type: "text", text: JSON.stringify(r) }] },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      })();
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
  q: TaskQueue;
  D: Agent;
  W: Agent;
  peer: { id: string; kp: KeyPair };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      capabilities: ["cap890s"],
    }),
  });
  return { relay, q: new TaskQueue(relay.moteDb.db), D, W, peer: await newPeer(relay) };
}

/** A fresh active peer (federation rate-limits each peer to 30 requests a minute). */
async function newPeer(relay: SyncRelay): Promise<World["peer"]> {
  const peer = { id: `peer-${crypto.randomUUID()}`, kp: await generateKeypair() };
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at)
       VALUES (?, ?, ?, 'peer', 'active', ?)`,
    )
    .run(peer.id, bytesToHex(peer.kp.publicKey), `http://${peer.id}.invalid`, Date.now());
  return peer;
}

async function receiptBy(
  who: Agent,
  relayTaskId: string,
  status: "completed" | "failed",
  nested: ExecutionReceipt[] = [],
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
      ...(nested.length > 0 ? { delegation_receipts: nested } : {}),
    },
    who.kp.privateKey,
  ) as Promise<ExecutionReceipt>;
}

async function admit(w: World, prompt: string): Promise<string> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ prompt, required_capabilities: ["cap890s"], submitted_by: w.D.id }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  await settle(60); // the MCP presentation lands
  return task_id;
}

/** S becomes a funded P2P task paid to W (every settlement path writes a row). */
function fund(w: World, S: string): void {
  w.q.update(S, (e) => {
    e.settlement_mode = "p2p";
    e.target_agent = w.W.id;
    e.price_snapshot = 1_000_000;
    e.p2p_payment_proof = {
      tx_hash: `tx-${crypto.randomUUID()}`,
      chain: "solana",
      network: "devnet",
      to_address: "worker-address",
      amount_micro: 950_000,
      fee_to_address: "treasury-address",
      fee_amount_micro: 50_000,
    };
  });
}

async function postResult(w: World, taskId: string, r: ExecutionReceipt): Promise<number> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(r),
  });
  return res.status;
}

async function fedResult(w: World, taskId: string, r: ExecutionReceipt): Promise<number> {
  const payload = { task_id: taskId, origin_relay: w.peer.id, receipt: r, timestamp: Date.now() };
  const sig = await sign(new TextEncoder().encode(canonicalJson(payload)), w.peer.kp.privateKey);
  // The master token only bypasses the per-IP limiter (the harness sends far
  // more than 30 results a minute from one address); the door ignores it.
  const res = await w.relay.app.request("/federation/v1/task/result", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
  });
  return res.status;
}

async function poll(w: World, taskId: string): Promise<ExecutionReceipt | null> {
  const r = await w.relay.app.request(`/agent/${w.D.id}/task/${taskId}`, { headers: AUTH_HEADER });
  if (!r.ok) return null;
  return ((await r.json()) as { receipt?: ExecutionReceipt | null }).receipt ?? null;
}

interface Row {
  receipt_signature?: string | null;
  receipt_hash: string;
}
/** Every settlement row naming S, in both settlement tables. */
function rows(w: World, S: string): Row[] {
  const db = w.relay.moteDb.db;
  return [
    ...(db.prepare("SELECT * FROM relay_settlements WHERE task_id = ?").all(S) as Row[]),
    ...(db.prepare("SELECT * FROM relay_federation_settlements WHERE task_id = ?").all(S) as Row[]),
  ];
}
const names = (row: Row, r: ExecutionReceipt): boolean =>
  row.receipt_signature != null
    ? row.receipt_signature === r.signature
    : row.receipt_hash === r.result_hash || row.receipt_hash === r.signature;

/** The entry's claim, as stored. */
function claim(w: World, S: string): { settled: boolean; settling: string | null } | null {
  const row = w.relay.moteDb.db
    .prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?")
    .get(S) as { task_json: string } | undefined;
  if (row == null) return null;
  const e = JSON.parse(row.task_json) as { settled?: boolean; settling?: string };
  return { settled: e.settled === true, settling: e.settling ?? null };
}

const GUARDS =
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE '%_claim_guard' OR name LIKE '%_one_settlement_guard' OR name LIKE '%settlement_credit_guard' OR name LIKE '%settled_frozen_guard')";
/** Run `fn` as the pre-deploy relay did: without the settlement guards. */
function preDeploy(w: World, fn: () => unknown): void {
  const db = w.relay.moteDb.db;
  for (const g of db.prepare(GUARDS).all() as Array<{ name: string }>) {
    db.exec(`DROP TRIGGER ${g.name}`);
  }
  try {
    fn();
  } finally {
    (
      taskQueueModule as { installSettlementGuards?: (d: typeof db) => void }
    ).installSettlementGuards?.(db);
  }
}

/** The pre-claim relay's answer: receipt + status, one version step. */
function rawAnswer(w: World, S: string, r: ExecutionReceipt, settling: boolean): void {
  const db = w.relay.moteDb.db;
  db.prepare(
    `UPDATE relay_task_queue SET receipt = ?, status = ?,
       task_json = ${settling ? "json_set(json_set(task_json, '$.task.status', ?), '$.settling', ?)" : "json_set(task_json, '$.task.status', ?)"},
       answer_version = answer_version + 1
     WHERE task_id = ?`,
  ).run(JSON.stringify(r), r.status, r.status, ...(settling ? [r.signature] : []), S);
  persistReceiptChain(db, r);
  if (settling) {
    db.prepare(
      `INSERT INTO relay_task_answers (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
    ).run(S, r.motebit_id, r.status, canonicalJson(r), r.signature, Date.now());
  }
}

/** The settlement write for S fails (the process dies between claim and settle). */
function crash(w: World, S: string, on: boolean): void {
  const db = w.relay.moteDb.db;
  for (const t of ["relay_settlements", "relay_federation_settlements"]) {
    const name = `crash_${t}`;
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    if (on) {
      db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${t} WHEN NEW.task_id = '${S}'
               BEGIN SELECT RAISE(ABORT, 'crash between claim and settle'); END;`);
    }
  }
}

type Door = "post" | "mcp" | "fed" | "sub";
type State = "absent" | "queued" | "unclaimed" | "settling" | "settled" | "legacy_row";
const DOORS: Door[] = ["post", "mcp", "fed", "sub"];
const STATES: State[] = ["absent", "queued", "unclaimed", "settling", "settled", "legacy_row"];

const tag = (r: ExecutionReceipt | null): string =>
  r == null ? "none" : `${r.status}/${r.signature.slice(0, 10)}`;

async function runCell(
  w: World,
  door: Door,
  state: State,
  same: boolean,
  status: "completed" | "failed",
  crashed: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  const db = w.relay.moteDb.db;
  const prompt = `s890 ${crypto.randomUUID()}`;
  let release: (r: ExecutionReceipt | null) => void = () => {};
  const gate = new Promise<ExecutionReceipt | null>((r) => (release = r));
  let mcpDone = false;
  mcpReplies.set(prompt, async () => {
    if (door !== "mcp") return null;
    const r = await gate;
    mcpDone = true;
    return r;
  });
  w.peer = await newPeer(w.relay);
  const S = await admit(w, prompt);
  fund(w, S);
  // The federated route: W through `peer` (the fed door's recorded executor).
  recordTaskRoute(db, S, w.W.id, w.peer.id);

  const standingStatus = same ? status : status === "completed" ? "failed" : "completed";
  const standing = await receiptBy(w.W, S, standingStatus);
  const incoming = same ? standing : await receiptBy(w.W, S, status);

  // ── the state ──
  if (state === "unclaimed") rawAnswer(w, S, standing, false);
  else if (state === "settling") rawAnswer(w, S, standing, true);
  else if (state === "settled") {
    const s = await postResult(w, S, standing);
    if (s !== 200) failures.push(`SETUP: settled state's POST answered ${s}`);
  } else if (state === "legacy_row") {
    preDeploy(w, () =>
      db
        .prepare(
          `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at, settlement_mode)
           VALUES (?, ?, ?, ?, ?, 950000, 50000, 'completed', ?, 'p2p')`,
        )
        .run(crypto.randomUUID(), `p2p-${S}`, S, w.W.id, standing.result_hash, Date.now()),
    );
  } else if (state === "absent") {
    db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(S);
  }
  const before = await poll(w, S);
  const c0 = claim(w, S);
  const frozen =
    c0 != null &&
    (c0.settled || (c0.settling != null && c0.settling !== "") || rows(w, S).length > 0);

  // ── the door, with the settlement write failing when `crashed` ──
  crash(w, S, crashed);
  let reported: number | null = null;
  const deliver = async (): Promise<number | null> => {
    if (door === "post") return postResult(w, S, incoming);
    if (door === "fed") return fedResult(w, S, incoming);
    if (door === "mcp") {
      release(incoming);
      for (let i = 0; i < 50 && !mcpDone; i++) await settle(20);
      await settle(150);
      return null;
    }
    // sub: another task P of W's, whose answer embeds S's receipt.
    mcpReplies.set(`${prompt} parent`, async () => null);
    const P = await admit(w, `${prompt} parent`);
    await postResult(w, P, await receiptBy(w.W, P, "completed", [incoming]));
    return null;
  };
  try {
    reported = await deliver();
  } finally {
    crash(w, S, false);
  }
  if (reported === 429)
    failures.push("HARNESS: the door was rate-limited, the cell tested nothing");
  if (door !== "mcp") release(null);

  // ── RETRY: the crashed door's retry settles what it claimed ──
  if (crashed) {
    const again =
      door === "post" || door === "fed" ? await deliver() : await postResult(w, S, incoming);
    if (again === 429) failures.push("HARNESS: the retry was rate-limited");
    const c = claim(w, S);
    if (c != null && c.settling === incoming.signature && !c.settled) {
      failures.push("RETRY: the retry left the claimed answer unsettled");
    }
  }

  // ── NO CLAIM: the next retry of the standing answer (claimed, or answered
  //    before the claim existed) settles it ──
  const c1 = claim(w, S);
  const live = w.q.get(S)?.receipt;
  if (c1 != null && live != null && !c1.settled) {
    await postResult(w, S, live);
    const c2 = claim(w, S);
    if (c2 != null && !c2.settled) {
      failures.push("NO CLAIM: an answer is left unsettled after its retry");
    }
  }

  // ── ONE ──
  const after = await poll(w, S);
  const rs = rows(w, S);
  if (after == null) {
    const legacyOnly = state === "legacy_row" && rs.length === 1 && names(rs[0]!, standing);
    if (rs.length !== 0 && !legacyOnly) {
      failures.push(`ONE: no answer, but ${rs.length} settlement row(s)`);
    }
  } else {
    if (rs.length !== 1) failures.push(`ONE: ${rs.length} settlement rows for ${tag(after)}`);
    else if (!names(rs[0]!, after))
      failures.push(`ONE: the settlement names another receipt than the poll's ${tag(after)}`);
    const c = claim(w, S);
    if (c != null && (!c.settled || c.settling !== after.signature)) {
      failures.push(
        `ONE: the poll shows ${tag(after)} but the entry is ${c.settled ? "settled" : "unsettled"} on ${c.settling?.slice(0, 10) ?? "nothing"}`,
      );
    }
  }
  // ── POS ──
  if (
    reported != null &&
    reported < 300 &&
    (after == null || after.signature !== incoming.signature)
  ) {
    failures.push(`POS: the ${door} door answered ${reported} but the poll shows ${tag(after)}`);
  }
  // ── LAW: a frozen answer is never replaced ──
  if (frozen && before != null && tag(after) !== tag(before)) {
    failures.push(`LAW: the frozen answer ${tag(before)} became ${tag(after)}`);
  }
  if (frozen && before == null && after != null && !rs.every((r) => names(r, after))) {
    failures.push(`LAW: a task its settlement froze took ${tag(after)}`);
  }
  // ── EXPECT: the law's answer, exactly (a door that did nothing fails here) ──
  const expected: ExecutionReceipt | null =
    state === "absent"
      ? null
      : state === "queued"
        ? incoming
        : state === "unclaimed"
          ? !same && standing.status !== "completed" && incoming.status === "completed"
            ? incoming
            : standing
          : state === "legacy_row"
            ? same
              ? standing
              : null
            : standing;
  if (tag(after) !== tag(expected)) {
    failures.push(`EXPECT: the poll shows ${tag(after)}, the law says ${tag(expected)}`);
  }
  // ── EVICT ──
  db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(S);
  const evicted = await poll(w, S);
  if (tag(evicted) !== tag(after)) {
    failures.push(`EVICT: ${tag(after)} became ${tag(evicted)} once the queue forgot S`);
  }
  mcpReplies.delete(prompt);
  return failures;
}

describe("#890 r9 the settlement harness — door × entry state × receipt × status × crash", () => {
  for (const door of DOORS) {
    it(`${door}: every state, same/different receipt, completed/failed, with and without a crash between claim and settle`, async () => {
      const w = await world();
      const failures: string[] = [];
      let cells = 0;
      try {
        for (const state of STATES) {
          for (const same of [true, false]) {
            for (const status of ["completed", "failed"] as const) {
              for (const crashed of [false, true]) {
                cells++;
                for (const f of await runCell(w, door, state, same, status, crashed)) {
                  failures.push(
                    `${door}/${state}/${same ? "same" : "different"}/${status}/${crashed ? "crash" : "no-crash"}: ${f}`,
                  );
                }
              }
            }
          }
        }
      } finally {
        await w.relay.close();
      }
      // HARNESS_OUT=<file>: every failing cell, one line each (vitest truncates the diff).
      if (process.env.HARNESS_OUT) {
        appendFileSync(process.env.HARNESS_OUT, failures.map((f) => `${f}\n`).join(""));
      }
      expect(cells).toBe(STATES.length * 2 * 2 * 2);
      expect(failures).toEqual([]);
    }, 300_000);
  }
});

describe("#890 r9 C1 — a sub-task paid through its parent's answer is ANSWERED by that receipt", () => {
  it("C pays on R2 through B's answer; C's later failed R1 is refused 409; the poll, the claim and the one row all name R2", async () => {
    const w = await world();
    try {
      const prompt = `c1 ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      mcpReplies.set(`${prompt} parent`, async () => null);
      const S = await admit(w, prompt);
      fund(w, S);
      const P = await admit(w, `${prompt} parent`);
      const R2 = await receiptBy(w.W, S, "completed");
      expect(await postResult(w, P, await receiptBy(w.W, P, "completed", [R2]))).toBe(200);
      const R1 = await receiptBy(w.W, S, "failed");
      expect(await postResult(w, S, R1)).toBe(409);
      const R3 = await receiptBy(w.W, S, "completed");
      expect(await postResult(w, S, R3)).toBe(409);
      expect(await postResult(w, S, R2)).toBe(200); // the standing answer: already settled
      expect(tag(await poll(w, S))).toBe(tag(R2));
      const rs = rows(w, S);
      expect(rs.length).toBe(1);
      expect(names(rs[0]!, R2)).toBe(true);
      expect(claim(w, S)).toEqual({ settled: true, settling: R2.signature });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 C2 — the federation door settles on the peer's retry after a crash", () => {
  it("the fed door claims, the settlement write dies; the peer's identical retry writes the one federation row and its retry row", async () => {
    const w = await world();
    try {
      const prompt = `c2 ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      const S = await admit(w, prompt);
      // A relay-custody federated task: the origin writes a federation
      // settlement and forwards it.
      w.q.update(S, (e) => {
        e.price_snapshot = 1_000_000;
      });
      recordTaskRoute(w.relay.moteDb.db, S, w.W.id, w.peer.id);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      expect(await fedResult(w, S, R)).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      expect(await fedResult(w, S, R)).toBe(200);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      const fed = w.relay.moteDb.db
        .prepare(
          "SELECT settlement_id, receipt_signature FROM relay_federation_settlements WHERE task_id = ?",
        )
        .all(S) as Array<{ settlement_id: string; receipt_signature: string }>;
      expect(fed.map((r) => r.receipt_signature)).toEqual([R.signature]);
      // The forward to the (unreachable) peer failed: its retry row was
      // committed with the settlement row and carries it.
      const retries = w.relay.moteDb.db
        .prepare("SELECT settlement_id, status FROM relay_settlement_retries WHERE task_id = ?")
        .all(S) as Array<{ settlement_id: string; status: string }>;
      expect(retries).toEqual([{ settlement_id: fed[0]!.settlement_id, status: "pending" }]);
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r9 the tables refuse what the claim refuses", () => {
  it("a settlement row for a known task is written only for its claimed receipt, once across both tables; a settlement_credit names a row; a settled answer is frozen", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const prompt = `guard ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      const S = await admit(w, prompt);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      const other = await receiptBy(w.W, S, "completed");
      const insert = (table: string, sig: string | null): string => {
        try {
          if (table === "relay_settlements") {
            db.prepare(
              `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at, receipt_signature)
               VALUES (?, ?, ?, ?, 'h', 1, 0, 'completed', ?, ?)`,
            ).run(crypto.randomUUID(), crypto.randomUUID(), S, w.W.id, Date.now(), sig);
          } else {
            db.prepare(
              `INSERT INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, receipt_signature)
               VALUES (?, ?, ?, NULL, 1, 0, 1, 0.05, ?, 'h', ?)`,
            ).run(crypto.randomUUID(), S, `up-${crypto.randomUUID()}`, Date.now(), sig);
          }
          return "written";
        } catch (err) {
          return /claimed for|settles once/.test(String(err)) ? "refused" : String(err);
        }
      };
      const out: Record<string, string> = {};
      // Unanswered (no claim): refused in both tables, with or without a signature.
      out["unclaimed: settlements, no sig"] = insert("relay_settlements", null);
      out["unclaimed: settlements, R"] = insert("relay_settlements", R.signature);
      out["unclaimed: federation, R"] = insert("relay_federation_settlements", R.signature);
      // Claimed for R (raw answer + claim, as a crash after the claim leaves it).
      rawAnswer(w, S, R, true);
      out["claimed R: settlements, other"] = insert("relay_settlements", other.signature);
      out["claimed R: federation, no sig"] = insert("relay_federation_settlements", null);
      out["claimed R: settlements, R"] = insert("relay_settlements", R.signature);
      out["second row: settlements, R"] = insert("relay_settlements", R.signature);
      out["second row: federation, R"] = insert("relay_federation_settlements", R.signature);
      // A settlement_credit must name a settlement row (or a dispute).
      let credit = "written";
      try {
        db.prepare(
          `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
           VALUES (?, ?, 'settlement_credit', 5, 5, ?, 'x', ?)`,
        ).run(crypto.randomUUID(), w.W.id, `nothing-${crypto.randomUUID()}`, Date.now());
      } catch (err) {
        credit = /names the settlement row/.test(String(err)) ? "refused" : String(err);
      }
      out["settlement_credit naming nothing"] = credit;
      // Frozen: the answer never moves off the receipt the row names.
      let frozen = "moved";
      try {
        db.prepare(
          "UPDATE relay_task_queue SET receipt = ?, answer_version = answer_version + 1 WHERE task_id = ?",
        ).run(JSON.stringify(other), S);
      } catch (err) {
        frozen = /frozen/.test(String(err)) ? "refused" : String(err);
      }
      out["answer moved off the settled receipt"] = frozen;
      expect(out).toEqual({
        "unclaimed: settlements, no sig": "refused",
        "unclaimed: settlements, R": "refused",
        "unclaimed: federation, R": "refused",
        "claimed R: settlements, other": "refused",
        "claimed R: federation, no sig": "refused",
        "claimed R: settlements, R": "written",
        "second row: settlements, R": "refused",
        "second row: federation, R": "refused",
        "settlement_credit naming nothing": "refused",
        "answer moved off the settled receipt": "refused",
      });
    } finally {
      await w.relay.close();
    }
  });

  it("only task-answer.ts calls answerTask and markTaskSettled; every door calls admitReceipt", () => {
    const dir = join(__dirname, "..");
    const offenders: string[] = [];
    const doors: Record<string, number> = {};
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      if (f !== "task-answer.ts" && /\b(answerTask|markTaskSettled)\(/.test(src)) offenders.push(f);
      doors[f] = (src.match(/\badmitReceipt\s*\(/g) ?? []).length;
    }
    expect(offenders).toEqual([]);
    // The result POST + MCP forward (handleReceiptIngestion) and the
    // sub-receipt door in tasks.ts; the federation result door.
    expect({ tasks: doors["tasks.ts"], federation: doors["federation-callbacks.ts"] }).toEqual({
      tasks: 2,
      federation: 1,
    });
  });
});

describe("#890 r9 pinned hunks", () => {
  it("the answers sweep deletes an expired answer and keeps an unsettled claim of a still-queued task", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const old = Date.now() - TASK_ROUTE_RETENTION_MS - 60_000;
      const prompt = `sweep ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      const queued = await admit(w, prompt);
      const gone = crypto.randomUUID();
      const settledQueued = crypto.randomUUID();
      const row = db.prepare(
        `INSERT INTO relay_task_answers (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
         VALUES (?, 'w', 'completed', '{}', 'sig', ?, 1, ?)`,
      );
      row.run(queued, 0, old); // unsettled, task still queued: kept
      row.run(gone, 0, old); // the task left the queue: swept
      row.run(settledQueued, 1, old); // settled: swept
      cleanupTaskRoutes(db, Date.now());
      const left = (
        db
          .prepare("SELECT task_id FROM relay_task_answers WHERE task_id IN (?, ?, ?)")
          .all(queued, gone, settledQueued) as Array<{ task_id: string }>
      ).map((r) => r.task_id);
      expect(left).toEqual([queued]);
    } finally {
      await w.relay.close();
    }
  });

  it("the legacy repeat claims the entry's own receipt; markTaskSettled marks only the claimed receipt", async () => {
    const w = await world();
    try {
      const prompt = `legacy ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      const S = await admit(w, prompt);
      fund(w, S);
      const R = await receiptBy(w.W, S, "failed");
      rawAnswer(w, S, R, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: null });
      // The repeat: claimed for R and settled on R, one row.
      expect(await postResult(w, S, R)).toBe(200);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      expect(rows(w, S).map((r) => r.receipt_signature)).toEqual([R.signature]);
      // markTaskSettled for an unclaimed receipt marks nothing.
      const { markTaskSettled } = await import("../task-answer.js");
      const T = await admit(w, `${prompt} 2`);
      const RT = await receiptBy(w.W, T, "completed");
      rawAnswer(w, T, RT, true);
      markTaskSettled(w.q, T, (await receiptBy(w.W, T, "completed")).signature);
      expect(claim(w, T)).toEqual({ settled: false, settling: RT.signature });
      markTaskSettled(w.q, T, RT.signature);
      expect(claim(w, T)).toEqual({ settled: true, settling: RT.signature });
    } finally {
      await w.relay.close();
    }
  });

  it("the POST repeat of a settled answer is 200 already_settled and writes nothing; the fed P2P door marks the entry settled", async () => {
    const w = await world();
    try {
      const prompt = `repeat ${crypto.randomUUID()}`;
      mcpReplies.set(prompt, async () => null);
      const S = await admit(w, prompt);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      expect(await postResult(w, S, R)).toBe(200);
      const res = await w.relay.app.request(`/agent/${w.D.id}/task/${S}/result`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(R),
      });
      expect(((await res.json()) as { status: string }).status).toBe("already_settled");
      expect(rows(w, S).length).toBe(1);

      const F = await admit(w, `${prompt} fed`);
      fund(w, F);
      recordTaskRoute(w.relay.moteDb.db, F, w.W.id, w.peer.id);
      const RF = await receiptBy(w.W, F, "completed");
      expect(await fedResult(w, F, RF)).toBe(200);
      expect(claim(w, F)).toEqual({ settled: true, settling: RF.signature });
      expect(rows(w, F).map((r) => r.receipt_signature)).toEqual([RF.signature]);
    } finally {
      await w.relay.close();
    }
  });
});
