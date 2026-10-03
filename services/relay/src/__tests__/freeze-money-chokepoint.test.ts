/**
 * The emergency freeze holds at the money chokepoint.
 *
 * The freeze middleware refuses a mutating request at ENTRY. The invariant is
 * stronger: while frozen, NO money-moving write commits — including a request,
 * a loop pass or a recovery replay that was already past the entry check when
 * the freeze landed. For each door that moves money, this harness lands the
 * freeze through the REAL admin route at the await immediately before that
 * door's write, then asserts:
 *
 *   FROZEN   no money row is written and no balance changes;
 *   RESUME   after the real unfreeze route, the same work completes, once.
 *
 * Doors: local receipt (relay custody), P2P audit, federation result, recovery
 * replay, settlement forward, x402 settle, Path 0 withdrawal (at the body read
 * and at the payout claim), batch withdrawal.
 *
 * Background writers whose pass can be in flight when the freeze lands:
 * anchoring cuts (both streams — never an orphan batch, never a leaf in two;
 * each cut one transaction), settlement-forward retries (claimed per send: a
 * freeze during one send stops the rest; exhaustion never strands a forward),
 * task-queue cleanup (a held claim outlives any freeze), horizon truncation
 * (no cert without its deletion), a dispute's round-2 finalize (503, verdict
 * kept, finalized after unfreeze), and the column narrowing that lets record
 * columns commit while money columns are refused.
 *
 * The escrow chokepoint: frozen with the table triggers DROPPED, every
 * `ALLOCATION_MONEY_KINDS` movement is refused by `moveAllocationMoney` itself
 * (and the forward lifecycle's `beginForwardSend`) — RED if the chokepoint's
 * own check is removed, as the doors are RED if the triggers are.
 *
 * Plus the registry: every money-shaped table is either guarded or exempt with
 * a reason, the guards are installed on the booted relay, and no second
 * database connection in the relay bypasses them.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation, receipt and envelope signing
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signExecutionReceipt,
  sign,
  canonicalJson,
  signAdjudicatorVote,
  signDisputeAppeal,
  signDisputeRequest,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type {
  ExecutionReceipt,
  MotebitId,
  DeviceId,
  GuestRail,
  WithdrawalResult,
} from "@motebit/sdk";
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";
import { computeGrossAmount } from "@motebit/market";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  seedX402PaidTask,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { createMotebitDatabase } from "@motebit/persistence";
import { recordTaskRoute } from "../task-routing.js";
import { TaskQueue, UNSETTLED_CLAIM_HOLD_MS } from "../task-queue.js";
import { refundExhaustedForward } from "../index.js";
import { cutAgentSettlementBatch, cutBatch } from "../anchoring.js";
import { advanceRelayHorizon } from "../horizon.js";
import { processSettlementRetries, type RelayIdentity } from "../federation.js";
import { forwardOriginSettlement } from "../federation-callbacks.js";
import {
  ALLOCATION_MONEY_KINDS,
  beginForwardSend,
  forwardOf,
  moveAllocationMoney,
  openAllocation,
  recordInboundFederatedSettlement,
  recordP2pSettlementAudit,
  type AllocationMoneyKind,
  type AllocationMove,
} from "../allocation-escrow.js";
import { EmergencyFrozenError } from "../errors.js";
import { creditAccount, getAccountBalance, toMicro } from "../accounts.js";
import { enqueuePendingWithdrawal, evaluateAndFireRail } from "../batch-withdrawals.js";
import { reconcilePendingX402Settlements } from "../x402-settlements.js";
import {
  FREEZE_EXEMPT_TABLES,
  FREEZE_GUARDED_MONEY_TABLES,
  FREEZE_MONEY_COLUMNS,
  FREEZE_NON_MONEY_COLUMNS,
  freezeGuardedUpdateColumns,
  installedFreezeGuards,
} from "../freeze.js";
import {
  facilitator,
  decodeRequired,
  signPayment,
  fakeChainReader,
} from "./x402-fake-facilitator.js";

// ── The seam: the await right before a settlement door's write ──────────────
// Every settlement door signs its record (async) and then writes it. The hook
// runs inside that await, after the request passed the entry check.
const hook = vi.hoisted(() => ({
  beforeSign: null as null | (() => Promise<void>),
  /** The anchoring cut's await before its batch write (its Merkle build). */
  beforeMerkle: null as null | (() => Promise<void>),
  /**
   * The raw `sign` await — the settlement forward signs its body with it right
   * before the send, after the forward's money already committed.
   */
  beforeRawSign: null as null | (() => Promise<void>),
}));
vi.mock("@motebit/encryption", async (importOriginal) => {
  const m = await importOriginal<typeof import("@motebit/encryption")>();
  const wrap =
    <A extends unknown[], R>(
      f: (...a: A) => Promise<R>,
      slot: "beforeSign" | "beforeRawSign" = "beforeSign",
    ) =>
    async (...a: A): Promise<R> => {
      const before = hook[slot];
      if (before != null) {
        hook[slot] = null;
        await before();
      }
      return f(...a);
    };
  const buildMerkleTree: typeof m.buildMerkleTree = async (...a) => {
    const before = hook.beforeMerkle;
    if (before != null) {
      hook.beforeMerkle = null;
      await before();
    }
    return m.buildMerkleTree(...a);
  };
  return {
    ...m,
    buildMerkleTree,
    signSettlement: wrap(m.signSettlement),
    signFederationSettlement: wrap(m.signFederationSettlement),
    sign: wrap(m.sign, "beforeRawSign"),
  };
});
vi.mock(
  "../x402-facilitator.js",
  async () => (await import("./x402-fake-facilitator.js")).fakeFacilitatorModule,
);

// ── W's MCP endpoint (never answers a presentation) ─────────────────────────
let PORT = 0;
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hook.beforeSign = null;
  hook.beforeMerkle = null;
  hook.beforeRawSign = null;
  facilitator.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  hook.beforeSign = null;
  hook.beforeMerkle = null;
  hook.beforeRawSign = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── The real admin routes ───────────────────────────────────────────────────
async function freeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/freeze", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ reason: "freeze-money-chokepoint" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
async function unfreeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/unfreeze", {
    method: "POST",
    headers: JSON_AUTH,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
/** Land the freeze at the next settlement door's pre-write await. */
function freezeAtNextSign(relay: SyncRelay): { landed: () => boolean } {
  let landed = false;
  hook.beforeSign = async () => {
    await freeze(relay);
    landed = true;
  };
  return { landed: () => landed };
}

// ── Money observation ───────────────────────────────────────────────────────
const MONEY_TABLES = Object.keys(FREEZE_GUARDED_MONEY_TABLES);
/** A digest of every guarded money table (row counts + content). */
function moneySnapshot(relay: SyncRelay): Record<string, string> {
  const db = relay.moteDb.db;
  const out: Record<string, string> = {};
  for (const t of MONEY_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    out[t] = JSON.stringify(rows);
  }
  return out;
}
const balance = (relay: SyncRelay, id: string): number =>
  getAccountBalance(relay.moteDb.db, id)?.balance ?? 0;

// ── Agents, receipts ────────────────────────────────────────────────────────
interface Agent {
  id: string;
  device: string;
  kp: KeyPair;
}
async function agent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { id: a.motebitId, device: a.deviceId, kp };
}
async function register(relay: SyncRelay, a: Agent, priced = false): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: a.id,
      endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
      capabilities: ["capfz"],
      public_key: bytesToHex(a.kp.publicKey),
    }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  if (priced) {
    const l = await relay.app.request(`/api/v1/agents/${a.id}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["capfz"],
        pricing: [{ capability: "capfz", unit_cost: 1.0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "freeze chokepoint worker",
        pay_to_address: "0x00000000000000000000000000000000000000a1",
      }),
    });
    expect(l.status, await l.clone().text()).toBeLessThan(300);
  }
}
async function receiptBy(who: Agent, taskId: string): Promise<ExecutionReceipt> {
  const now = Date.now();
  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: who.id as MotebitId,
      device_id: who.device as DeviceId,
      submitted_at: now - 100,
      completed_at: now,
      status: "completed",
      result: "completed result with enough text to count as real work",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "p",
      result_hash: `h-${crypto.randomUUID()}`,
    },
    who.kp.privateKey,
  ) as Promise<ExecutionReceipt>;
}

interface World {
  relay: SyncRelay;
  q: TaskQueue;
  D: Agent;
  W: Agent;
}
async function world(overrides: Partial<SyncRelayConfig> = {}, priced = false): Promise<World> {
  const relay = await createTestRelay({ enableDeviceAuth: false, ...overrides });
  const D = await agent(relay);
  const W = await agent(relay);
  await register(relay, W, priced);
  return { relay, q: new TaskQueue(relay.moteDb.db), D, W };
}

async function admit(w: World): Promise<string> {
  const res = await w.relay.app.request(`/agent/${w.D.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: `fz ${crypto.randomUUID()}`,
      required_capabilities: ["capfz"],
      submitted_by: w.D.id,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  await settle(60);
  return task_id;
}
/** S becomes a funded P2P task paid to W (its settlement writes an audit row). */
function fundP2p(w: World, S: string): void {
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
async function postResult(
  w: World,
  taskId: string,
  r: ExecutionReceipt,
  path: string,
): Promise<{ code: number; body: { status?: string; code?: string } }> {
  const res = await w.relay.app.request(`/agent/${path}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(r),
  });
  return {
    code: res.status,
    body: (await res.json().catch(() => ({}))) as { status?: string; code?: string },
  };
}
/** Every settlement row naming S, in both settlement tables. */
function settlementRows(w: World, S: string): unknown[] {
  const db = w.relay.moteDb.db;
  return [
    ...db.prepare("SELECT settlement_id FROM relay_settlements WHERE task_id = ?").all(S),
    ...db
      .prepare("SELECT settlement_id FROM relay_federation_settlements WHERE task_id = ?")
      .all(S),
  ];
}
function claim(w: World, S: string): { settled: boolean; settling: string | null } | null {
  const row = w.relay.moteDb.db
    .prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?")
    .get(S) as { task_json: string } | undefined;
  if (row == null) return null;
  const e = JSON.parse(row.task_json) as { settled?: boolean; settling?: string };
  return { settled: e.settled === true, settling: e.settling ?? null };
}

// ── Federation ──────────────────────────────────────────────────────────────
interface Peer {
  id: string;
  kp: KeyPair;
  url: string;
}
async function addPeer(relay: SyncRelay): Promise<Peer> {
  const kp = await generateKeypair();
  const id = `peer-${crypto.randomUUID()}`;
  const url = `http://${id.toLowerCase()}.test`;
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at)
       VALUES (?, ?, ?, 'peer', 'active', ?)`,
    )
    .run(id, bytesToHex(kp.publicKey), url, Date.now());
  return { id, kp, url };
}
async function signed(peer: Peer, payload: Record<string, unknown>): Promise<string> {
  const sig = await sign(new TextEncoder().encode(canonicalJson(payload)), peer.kp.privateKey);
  return JSON.stringify({ ...payload, signature: bytesToHex(sig) });
}
async function fedResult(w: World, peer: Peer, taskId: string, r: ExecutionReceipt) {
  const payload = { task_id: taskId, origin_relay: peer.id, receipt: r, timestamp: Date.now() };
  const res = await w.relay.app.request("/federation/v1/task/result", {
    method: "POST",
    headers: JSON_AUTH,
    body: await signed(peer, payload),
  });
  return { code: res.status, body: (await res.json().catch(() => ({}))) as { code?: string } };
}
async function inboundForward(w: World, peer: Peer, taskId: string): Promise<void> {
  const payload = {
    task_id: taskId,
    origin_relay: peer.id,
    target_agent: w.W.id,
    task_payload: { prompt: `fwd ${taskId}`, required_capabilities: ["capfz"] },
    timestamp: Date.now(),
  };
  const res = await w.relay.app.request("/federation/v1/task/forward", {
    method: "POST",
    headers: JSON_AUTH,
    body: await signed(peer, payload),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  await settle(40);
}
async function settlementForward(
  w: World,
  peer: Peer,
  taskId: string,
  settlementId: string,
  r: ExecutionReceipt,
) {
  const payload = {
    task_id: taskId,
    settlement_id: settlementId,
    origin_relay: peer.id,
    gross_amount: 1_000_000,
    receipt_hash: r.result_hash,
    timestamp: Date.now(),
  };
  const res = await w.relay.app.request("/federation/v1/settlement/forward", {
    method: "POST",
    headers: JSON_AUTH,
    body: await signed(peer, payload),
  });
  return { code: res.status, body: (await res.json().catch(() => ({}))) as { code?: string } };
}
function routeFetch(routes: Record<string, () => Promise<Response>>): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [base, handler] of Object.entries(routes)) {
      if (url.startsWith(base)) return handler();
    }
    return real(input, init);
  });
}

/** The settlement write for S fails once (a crash between claim and settle). */
function crash(w: World, S: string, on: boolean): void {
  const db = w.relay.moteDb.db;
  for (const t of ["relay_settlements", "relay_federation_settlements"]) {
    const name = `fz_crash_${t}`;
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    if (on) {
      db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${t} WHEN NEW.task_id = '${S}'
               BEGIN SELECT RAISE(ABORT, 'crash between claim and settle'); END;`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════

describe("freeze at the money chokepoint — every door, frozen at the await before its write", () => {
  it("local receipt (relay custody): no settlement, no credit while frozen; the retry settles once after unfreeze", async () => {
    const w = await world({}, true);
    try {
      const S = seedX402PaidTask(w.relay, {
        workerId: w.W.id,
        delegatorId: w.D.id,
        prompt: `fz local ${crypto.randomUUID()}`,
        unitCostUsd: 1.0,
      });
      const R = await receiptBy(w.W, S);
      const before = moneySnapshot(w.relay);
      const f = freezeAtNextSign(w.relay);
      const res = await postResult(w, S, R, w.W.id);
      expect(f.landed(), "the freeze landed at the door's pre-write await").toBe(true);
      expect(res.code, "receipt delivery is never blocked on accounting").toBe(200);
      expect(moneySnapshot(w.relay), "FROZEN: no money row changed").toEqual(before);
      expect(claim(w, S), "the answer stays claimed and unsettled").toEqual({
        settled: false,
        settling: R.signature,
      });

      await unfreeze(w.relay);
      expect((await postResult(w, S, R, w.W.id)).code).toBe(200);
      expect(settlementRows(w, S), "RESUME: one settlement").toHaveLength(1);
      const earned = balance(w.relay, w.W.id);
      expect(earned).toBeGreaterThan(0);
      expect((await postResult(w, S, R, w.W.id)).code).toBe(200);
      expect(settlementRows(w, S), "never twice").toHaveLength(1);
      expect(balance(w.relay, w.W.id)).toBe(earned);
    } finally {
      await w.relay.close();
    }
  });

  it("P2P audit: no audit row while frozen; the retry writes it once after unfreeze", async () => {
    const w = await world();
    try {
      const S = await admit(w);
      fundP2p(w, S);
      const R = await receiptBy(w.W, S);
      const before = moneySnapshot(w.relay);
      const f = freezeAtNextSign(w.relay);
      expect((await postResult(w, S, R, w.D.id)).code).toBe(200);
      expect(f.landed()).toBe(true);
      expect(moneySnapshot(w.relay), "FROZEN: no money row changed").toEqual(before);
      expect(settlementRows(w, S)).toEqual([]);

      await unfreeze(w.relay);
      expect((await postResult(w, S, R, w.D.id)).code).toBe(200);
      expect(settlementRows(w, S), "RESUME: one audit row").toHaveLength(1);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      await postResult(w, S, R, w.D.id);
      expect(settlementRows(w, S), "never twice").toHaveLength(1);
    } finally {
      await w.relay.close();
    }
  });

  it("federation result: no settlement row while frozen; the peer's retry settles once after unfreeze", async () => {
    const w = await world();
    try {
      const peer = await addPeer(w.relay);
      const S = await admit(w);
      fundP2p(w, S);
      recordTaskRoute(w.relay.moteDb.db, S, w.W.id, peer.id);
      const R = await receiptBy(w.W, S);
      const before = moneySnapshot(w.relay);
      const f = freezeAtNextSign(w.relay);
      const frozenRes = await fedResult(w, peer, S, R);
      expect(f.landed()).toBe(true);
      expect(frozenRes.code, "result delivery is never blocked on accounting").toBe(200);
      expect(moneySnapshot(w.relay), "FROZEN: no money row changed").toEqual(before);
      expect(claim(w, S), "the answer stays claimed and unsettled").toEqual({
        settled: false,
        settling: R.signature,
      });

      await unfreeze(w.relay);
      // The recovery pass settles the claim the frozen door left.
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(settlementRows(w, S), "RESUME: one settlement").toHaveLength(1);
      expect((await fedResult(w, peer, S, R)).code).toBe(200);
      expect(settlementRows(w, S), "never twice").toHaveLength(1);
    } finally {
      await w.relay.close();
    }
  });

  it("recovery replay: the pass writes nothing while frozen and leaves the claim; the pass after unfreeze settles once", async () => {
    const w = await world();
    try {
      const S = await admit(w);
      fundP2p(w, S);
      const R = await receiptBy(w.W, S);
      crash(w, S, true);
      expect((await postResult(w, S, R, w.D.id)).code).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });

      const before = moneySnapshot(w.relay);
      const f = freezeAtNextSign(w.relay);
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(f.landed(), "the freeze landed inside the replay").toBe(true);
      expect(moneySnapshot(w.relay), "FROZEN: no money row changed").toEqual(before);
      expect(claim(w, S), "the claim is left as it was").toEqual({
        settled: false,
        settling: R.signature,
      });

      await unfreeze(w.relay);
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(settlementRows(w, S), "RESUME: one settlement").toHaveLength(1);
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(settlementRows(w, S), "never twice").toHaveLength(1);
    } finally {
      await w.relay.close();
    }
  });

  it("settlement forward: no row, no credit while frozen; the origin's retry credits once after unfreeze", async () => {
    const w = await world({
      federation: { endpointUrl: "http://exec-fz.test", displayName: "exec-fz" },
    });
    try {
      const origin = await addPeer(w.relay);
      routeFetch({ [origin.url]: async () => new Response("{}", { status: 200 }) });
      const T = crypto.randomUUID();
      await inboundForward(w, origin, T);
      const R = await receiptBy(w.W, T);
      expect((await postResult(w, T, R, w.W.id)).code).toBe(200);
      const sid = crypto.randomUUID();

      const before = moneySnapshot(w.relay);
      const f = freezeAtNextSign(w.relay);
      const frozenRes = await settlementForward(w, origin, T, sid, R);
      expect(f.landed()).toBe(true);
      expect(frozenRes.code, "the origin is told to retry").toBe(503);
      expect(frozenRes.body.code).toBe("EMERGENCY_FROZEN");
      expect(moneySnapshot(w.relay), "FROZEN: no money row changed").toEqual(before);
      expect(balance(w.relay, w.W.id)).toBe(0);

      await unfreeze(w.relay);
      expect((await settlementForward(w, origin, T, sid, R)).code).toBe(200);
      expect(balance(w.relay, w.W.id), "RESUME: credited once").toBe(950_000);
      expect((await settlementForward(w, origin, T, sid, R)).code).toBe(200);
      expect(balance(w.relay, w.W.id), "never twice").toBe(950_000);
    } finally {
      await w.relay.close();
    }
  });

  it("x402 settle: the payment lands onchain, the freeze lands before its credit — nothing credited while frozen; reconciliation credits once after unfreeze", async () => {
    const w = await world({}, true);
    try {
      const body = { prompt: `fz x402 ${crypto.randomUUID()}`, submitted_by: w.D.id };
      const submit = (key: string, payment?: string) =>
        w.relay.app.request(`/agent/${w.W.id}/task`, {
          method: "POST",
          headers: {
            ...JSON_AUTH,
            "Idempotency-Key": key,
            ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
          },
          body: JSON.stringify(body),
        });
      const challenge = await submit(crypto.randomUUID());
      expect(challenge.status).toBe(402);
      const header = challenge.headers.get("PAYMENT-REQUIRED")!;
      expect(decodeRequired(header)).toBeDefined();
      const pay = signPayment(header, "0xFZ");

      const before = moneySnapshot(w.relay);
      let release!: () => void;
      facilitator.settleAnswerBarrier = new Promise<void>((r) => (release = r));
      const pending = submit(crypto.randomUUID(), pay);
      await vi.waitFor(() => expect(facilitator.settled).toHaveLength(1));
      await freeze(w.relay);
      release();
      const res = await pending;
      // The paid-but-uncredited outcome #907 defined, as the freeze's 503:
      // do NOT pay again, the named pending record is credited after unfreeze.
      expect(res.status, await res.clone().text()).toBe(503);
      const frozenBody = (await res.json()) as { code?: string; x402_settlement?: unknown };
      expect(frozenBody.code).toBe("EMERGENCY_FROZEN");
      expect(frozenBody.x402_settlement, "names the record being reconciled").toBeDefined();
      const after = moneySnapshot(w.relay);
      for (const t of MONEY_TABLES.filter((t) => t !== "relay_x402_settlements")) {
        expect(after[t], `FROZEN: ${t} unchanged`).toEqual(before[t]);
      }
      // The pre-settle intent (written before the freeze) stays pending.
      const records = w.relay.moteDb.db
        .prepare("SELECT status FROM relay_x402_settlements")
        .all() as Array<{ status: string }>;
      expect(records).toEqual([{ status: "pending" }]);
      expect(balance(w.relay, w.D.id)).toBe(0);

      await unfreeze(w.relay);
      const reader = fakeChainReader();
      await reconcilePendingX402Settlements(w.relay.moteDb.db, reader, {
        scan: { expiryConfirmGapMs: 0, recheckBackoffMs: [0, 0, 0] },
      });
      const gross = toMicro(computeGrossAmount(1.0, PLATFORM_FEE_RATE));
      expect(balance(w.relay, w.D.id), "RESUME: credited once").toBe(gross);
      await reconcilePendingX402Settlements(w.relay.moteDb.db, reader);
      expect(balance(w.relay, w.D.id), "never twice").toBe(gross);
    } finally {
      await w.relay.close();
    }
  });

  it("x402 operator resolve: a freeze landing during its chain read refuses the credit — a 503 (never a 200 'read_error'), the record pending; the resolve after unfreeze credits once", async () => {
    const inner = fakeChainReader();
    const gate: { hold: null | (() => Promise<void>) } = { hold: null };
    const reader: typeof inner = Object.assign(Object.create(inner) as typeof inner, {
      async getConfirmedHead() {
        const h = gate.hold;
        if (h != null) {
          gate.hold = null;
          await h();
        }
        return inner.getConfirmedHead();
      },
    });
    const w = await world({ x402ChainReader: reader }, true);
    try {
      const submit = (key: string, payment?: string) =>
        w.relay.app.request(`/agent/${w.W.id}/task`, {
          method: "POST",
          headers: {
            ...JSON_AUTH,
            "Idempotency-Key": key,
            ...(payment != null ? { "PAYMENT-SIGNATURE": payment } : {}),
          },
          body: JSON.stringify({ prompt: `fz x402r ${crypto.randomUUID()}`, submitted_by: w.D.id }),
        });
      const header = (await submit(crypto.randomUUID())).headers.get("PAYMENT-REQUIRED")!;
      const pay = signPayment(header, "0xFZR");
      // The payment lands onchain; the freeze (landed then lifted) left it uncredited.
      let release!: () => void;
      facilitator.settleAnswerBarrier = new Promise<void>((r) => (release = r));
      const paid = submit(crypto.randomUUID(), pay);
      await vi.waitFor(() => expect(facilitator.settled).toHaveLength(1));
      await freeze(w.relay);
      release();
      expect((await paid).status).toBe(503);
      await unfreeze(w.relay);
      const rec = w.relay.moteDb.db
        .prepare("SELECT payer, nonce, status FROM relay_x402_settlements")
        .get() as { payer: string; nonce: string; status: string };
      expect(rec.status).toBe("pending");
      const resolve = () =>
        w.relay.app.request(`/api/v1/admin/x402-settlements/${rec.payer}/${rec.nonce}/resolve`, {
          method: "POST",
          headers: JSON_AUTH,
        });

      gate.hold = () => freeze(w.relay);
      const res = await resolve();
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(balance(w.relay, w.D.id), "FROZEN: not credited").toBe(0);

      await unfreeze(w.relay);
      const ok = await resolve();
      expect(ok.status, await ok.clone().text()).toBe(200);
      const gross = toMicro(computeGrossAmount(1.0, PLATFORM_FEE_RATE));
      expect(balance(w.relay, w.D.id), "RESUME: credited once").toBe(gross);
      expect((await resolve()).status).toBe(200);
      expect(balance(w.relay, w.D.id), "never twice").toBe(gross);
    } finally {
      await w.relay.close();
    }
  });

  it("Path 0 withdrawal: the freeze lands while the request body is read — no debit, no send; the retry pays once after unfreeze", async () => {
    const sendUsdc = vi.fn().mockResolvedValue({
      signature:
        "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k",
      slot: 1,
      confirmed: true,
    });
    const adapter: SolanaRpcAdapter = {
      ownAddress: "RelayTreasuryAddressBase58",
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc,
      sendUsdcBatch: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockResolvedValue(true),
    };
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    try {
      const id = "fz-path0";
      creditAccount(relay.moteDb.db, id, 5_000_000, "deposit", "fz-deposit", "self-deposit");
      const headers = jsonAuthWithIdempotency();
      const payload = JSON.stringify({
        amount: 1.5,
        destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UFZFZ",
      });
      const before = moneySnapshot(relay);

      // The body stream is held open: the request passes the entry check and
      // waits in the handler's body read — the await before the debit.
      let push!: (c: Uint8Array) => void;
      let end!: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (c) => controller.enqueue(c);
          end = () => controller.close();
        },
      });
      const pending = relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit);
      await settle(20);
      await freeze(relay);
      push(new TextEncoder().encode(payload));
      end();
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(moneySnapshot(relay), "FROZEN: no money row changed").toEqual(before);
      expect(sendUsdc, "nothing sent").not.toHaveBeenCalled();

      await unfreeze(relay);
      const retry = await relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(retry.status, await retry.clone().text()).toBe(200);
      expect(sendUsdc, "RESUME: paid once").toHaveBeenCalledTimes(1);
      expect(balance(relay, id)).toBe(3_500_000);
      const again = await relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(again.status).toBe(200);
      expect(sendUsdc, "never twice").toHaveBeenCalledTimes(1);
      expect(balance(relay, id)).toBe(3_500_000);
    } finally {
      await relay.close();
    }
  });

  it("batch withdrawal: the freeze lands during one send — no later row is claimed or sent; the next pass after unfreeze fires each once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const sent: string[] = [];
      let onSend: (() => Promise<void>) | null = null;
      const rail = {
        custody: "relay",
        railType: "protocol",
        supportsDeposit: false,
        supportsWithdraw: true,
        supportsBatch: false,
        name: "fz-serial",
        isAvailable: () => Promise.resolve(true),
        attachProof: () => Promise.resolve(),
        async withdraw(motebitId: string, amount: number): Promise<WithdrawalResult> {
          sent.push(motebitId);
          const h = onSend;
          onSend = null;
          if (h != null) await h();
          return {
            amount,
            currency: "USDC",
            proof: {
              reference: `tx-${motebitId}`,
              railType: "protocol",
              network: "fake",
              confirmedAt: Date.now(),
            },
          };
        },
      } as unknown as GuestRail & Parameters<typeof evaluateAndFireRail>[1];
      for (const id of ["fz-a", "fz-b"]) {
        creditAccount(db, id, 50_000_000, "deposit", `dep-${id}`, "seed");
        enqueuePendingWithdrawal(db, {
          motebitId: id,
          amountMicro: 5_000_000,
          destination: `0xdest-${id}`,
          rail: rail.name,
          source: "sweep",
        });
      }
      const status = (): Record<string, string> =>
        Object.fromEntries(
          (
            db.prepare("SELECT motebit_id, status FROM relay_pending_withdrawals").all() as Array<{
              motebit_id: string;
              status: string;
            }>
          ).map((r) => [r.motebit_id, r.status]),
        );
      const balances = (): number[] => [balance(relay, "fz-a"), balance(relay, "fz-b")];
      const b0 = balances();

      // The first send is in flight when the freeze lands.
      onSend = () => freeze(relay);
      await evaluateAndFireRail(db, rail, {}).catch(() => {});
      expect(sent, "FROZEN: no send after the freeze").toEqual(["fz-a"]);
      expect(status(), "the in-flight payout is recorded; the next row is left pending").toEqual({
        "fz-a": "fired",
        "fz-b": "pending",
      });
      expect(balances(), "FROZEN: no balance changed").toEqual(b0);
      await evaluateAndFireRail(db, rail, {}).catch(() => {});
      expect(sent, "a pass while frozen sends nothing").toEqual(["fz-a"]);
      expect(status()["fz-b"]).toBe("pending");

      await unfreeze(relay);
      await evaluateAndFireRail(db, rail, {});
      expect(sent, "RESUME: each fired once").toEqual(["fz-a", "fz-b"]);
      expect(status()).toEqual({ "fz-a": "fired", "fz-b": "fired" });
      await evaluateAndFireRail(db, rail, {});
      expect(sent, "never twice").toEqual(["fz-a", "fz-b"]);
      expect(balances()).toEqual(b0);
    } finally {
      await relay.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The harness alphabet beyond the request doors: background writers whose
// pass can be in flight when the freeze lands, and every allocation-money
// kind at the escrow chokepoint.

/** The relay's own signing identity (the loops sign with it). */
function relayIdentityOf(relay: SyncRelay): RelayIdentity {
  const row = relay.moteDb.db
    .prepare(
      "SELECT relay_motebit_id, public_key, private_key_hex, did FROM relay_identity LIMIT 1",
    )
    .get() as {
    relay_motebit_id: string;
    public_key: string;
    private_key_hex: string;
    did: string;
  };
  return {
    relayMotebitId: row.relay_motebit_id,
    publicKey: hexToBytes(row.public_key),
    privateKey: hexToBytes(row.private_key_hex),
    publicKeyHex: row.public_key,
    did: row.did,
  };
}

/** Drop this connection's freeze triggers: only the escrow chokepoint's own check is left. */
function dropFreezeTriggers(relay: SyncRelay): void {
  for (const g of installedFreezeGuards(relay.moteDb.db)) {
    relay.moteDb.db.exec(`DROP TRIGGER temp.${g}`);
  }
}

/** An allocation of `locked` held from `payer`'s account, for worker `worker`. */
function heldAllocation(relay: SyncRelay, payer: string, worker: string, locked: number) {
  const db = relay.moteDb.db;
  const allocationId = `alloc-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  creditAccount(db, payer, locked, "deposit", `dep-${allocationId}`, "seed");
  db.transaction(() => {
    openAllocation(db, {
      allocationId,
      taskId,
      worker,
      amountLocked: locked,
      createdAt: Date.now(),
    });
    moveAllocationMoney(db, {
      kind: "hold",
      allocationId,
      amount: locked,
      party: payer,
      description: "seed hold",
    });
  });
  return { allocationId, taskId };
}

/** Seed `n` forwards of held allocations to `peer`, each queued for the retry loop. */
async function queuedForwards(
  relay: SyncRelay,
  peer: Peer,
  n: number,
): Promise<Array<{ taskId: string; settlementId: string; allocationId: string }>> {
  const db = relay.moteDb.db;
  const out: Array<{ taskId: string; settlementId: string; allocationId: string }> = [];
  for (let i = 0; i < n; i++) {
    const { allocationId, taskId } = heldAllocation(
      relay,
      `fwd-payer-${i}`,
      `fwd-worker-${i}`,
      1_000_000,
    );
    const r = await forwardOriginSettlement(db, relayIdentityOf(relay), {
      taskId,
      peerRelayId: peer.id,
      grossAmount: 1_000_000,
      platformFeeRate: 0.05,
      receiptHash: `rh-${taskId}`,
      x402TxHash: null,
      x402Network: null,
      peerFetch: () => Promise.reject(new Error("peer down")),
    });
    expect(r).toBe("queued");
    const row = db
      .prepare("SELECT settlement_id FROM relay_settlement_retries WHERE task_id = ?")
      .get(taskId) as { settlement_id: string };
    out.push({ taskId, settlementId: row.settlement_id, allocationId });
  }
  db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
  return out;
}

describe("freeze — the background writers a pass can carry past the freeze", () => {
  for (const stream of ["agent", "federation"] as const) {
    it(`anchoring cut (${stream}): a freeze landing during the cut leaves no orphan batch and no leaf anchored twice`, async () => {
      const relay = await createTestRelay({ enableDeviceAuth: false });
      try {
        const db = relay.moteDb.db;
        const settlements =
          stream === "agent" ? "relay_settlements" : "relay_federation_settlements";
        const batches = stream === "agent" ? "relay_agent_anchor_batches" : "relay_anchor_batches";
        for (let i = 0; i < 3; i++) {
          const id = crypto.randomUUID();
          const record = canonicalJson({ settlement_id: id, n: i });
          if (stream === "agent") {
            recordP2pSettlementAudit(db, {
              settlement_id: id,
              allocation_id: `p2p-${id}`,
              task_id: `t-${id}`,
              motebit_id: "anchor-worker",
              receipt_hash: "rh",
              amount_settled: 1,
              platform_fee: 0,
              platform_fee_rate: 0.05,
              status: "completed",
              settled_at: 1_000 + i,
              settlement_mode: "p2p",
              signature: "sig",
              record_json: record,
            });
          } else {
            recordInboundFederatedSettlement(
              db,
              {
                settlement_id: id,
                task_id: `t-${id}`,
                upstream_relay_id: "anchor-origin",
                gross_amount: 1,
                fee_amount: 0,
                net_amount: 1,
                fee_rate: 0.05,
                settled_at: 1_000 + i,
                receipt_hash: "rh",
                record_json: record,
              },
              { worker: null, amount: 0, description: "seed" },
            );
          }
        }
        const cut = () =>
          stream === "agent"
            ? cutAgentSettlementBatch(db, relayIdentityOf(relay))
            : cutBatch(db, relayIdentityOf(relay));
        hook.beforeMerkle = () => freeze(relay);
        await cut().catch(() => null);
        const orphanFree = () =>
          db
            .prepare(
              `SELECT b.batch_id, b.leaf_count,
                      (SELECT COUNT(*) FROM ${settlements} s WHERE s.anchor_batch_id = b.batch_id) AS assigned
                 FROM ${batches} b`,
            )
            .all() as Array<{ batch_id: string; leaf_count: number; assigned: number }>;
        for (const b of orphanFree()) {
          expect(b.assigned, "a signed batch owns exactly its leaves").toBe(b.leaf_count);
        }
        await unfreeze(relay);
        await cut();
        await cut();
        const all = orphanFree();
        for (const b of all) expect(b.assigned).toBe(b.leaf_count);
        expect(
          all.reduce((s, b) => s + b.leaf_count, 0),
          "each leaf is in exactly one batch",
        ).toBe(3);
      } finally {
        await relay.close();
      }
    });

    it(`anchoring cut (${stream}) is one transaction: an assignment that fails leaves no batch`, async () => {
      const relay = await createTestRelay({ enableDeviceAuth: false });
      try {
        const db = relay.moteDb.db;
        const settlements =
          stream === "agent" ? "relay_settlements" : "relay_federation_settlements";
        const batches = stream === "agent" ? "relay_agent_anchor_batches" : "relay_anchor_batches";
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        for (const [i, id] of ids.entries()) {
          const record = canonicalJson({ settlement_id: id, n: i });
          if (stream === "agent") {
            recordP2pSettlementAudit(db, {
              settlement_id: id,
              allocation_id: `p2p-${id}`,
              task_id: `t-${id}`,
              motebit_id: "anchor-worker",
              receipt_hash: "rh",
              amount_settled: 1,
              platform_fee: 0,
              platform_fee_rate: 0.05,
              status: "completed",
              settled_at: 1_000 + i,
              settlement_mode: "p2p",
              signature: "sig",
              record_json: record,
            });
          } else {
            recordInboundFederatedSettlement(
              db,
              {
                settlement_id: id,
                task_id: `t-${id}`,
                upstream_relay_id: "anchor-origin",
                gross_amount: 1,
                fee_amount: 0,
                net_amount: 1,
                fee_rate: 0.05,
                settled_at: 1_000 + i,
                receipt_hash: "rh",
                record_json: record,
              },
              { worker: null, amount: 0, description: "seed" },
            );
          }
        }
        db.exec(`CREATE TEMP TRIGGER fz_assign_fail BEFORE UPDATE OF anchor_batch_id ON main.${settlements}
                   WHEN NEW.settlement_id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'assign failed'); END;`);
        await expect(
          stream === "agent"
            ? cutAgentSettlementBatch(db, relayIdentityOf(relay))
            : cutBatch(db, relayIdentityOf(relay)),
        ).rejects.toThrow(/assign failed/);
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${batches}`).get()).toEqual({ n: 0 });
        expect(
          db
            .prepare(`SELECT COUNT(*) AS n FROM ${settlements} WHERE anchor_batch_id IS NOT NULL`)
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        await relay.close();
      }
    });
  }

  it("settlement-forward retries: a freeze landing during one send stops every later send in the pass; after unfreeze each is sent once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const peer = await addPeer(relay);
      const fwds = await queuedForwards(relay, peer, 3);
      const sent: string[] = [];
      let onSend: (() => Promise<void>) | null = () => freeze(relay);
      const peerFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
        sent.push((JSON.parse(init?.body as string) as { task_id: string }).task_id);
        const h = onSend;
        onSend = null;
        if (h != null) await h();
        return new Response("{}", { status: 200 });
      };
      const pass = () =>
        processSettlementRetries(
          db,
          relayIdentityOf(relay),
          undefined,
          undefined,
          peerFetch as never,
        );
      await pass().catch(() => {});
      expect(sent, "FROZEN: nothing sent after the freeze").toHaveLength(1);
      await pass().catch(() => {});
      expect(sent, "a pass while frozen sends nothing").toHaveLength(1);
      const later = fwds.filter((f) => f.taskId !== sent[0]);
      for (const f of later) {
        expect(forwardOf(db, f.settlementId)?.status, "a later forward stays pending").toBe(
          "pending",
        );
      }

      await unfreeze(relay);
      await pass();
      expect([...sent].sort(), "RESUME: each sent").toEqual(
        [sent[0]!, ...later.map((f) => f.taskId)].sort(),
      );
      await pass();
      for (const f of fwds) {
        expect(forwardOf(db, f.settlementId)?.status).toBe("delivered");
        expect(sent.filter((t) => t === f.taskId).length, "never twice").toBe(1);
      }
    } finally {
      await relay.close();
    }
  });

  it("settlement-forward exhaustion: a freeze landing during the last attempt neither fails the retry nor strands the forward; after unfreeze it refunds once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const peer = await addPeer(relay);
      const [fwd] = await queuedForwards(relay, peer, 1);
      db.prepare("UPDATE relay_settlement_retries SET attempts = max_attempts - 1").run();
      const payer = "fwd-payer-0";
      const exhausted = (retry: { retry_id: string; settlement_id: string; task_id: string }) => {
        refundExhaustedForward(db, retry);
      };
      let onSend: (() => Promise<void>) | null = () => freeze(relay);
      const peerFetch = async (): Promise<Response> => {
        const h = onSend;
        onSend = null;
        if (h != null) await h();
        return new Response("down", { status: 500 });
      };
      await processSettlementRetries(
        db,
        relayIdentityOf(relay),
        exhausted,
        undefined,
        peerFetch as never,
      ).catch(() => {});
      const retryRow = () =>
        db
          .prepare("SELECT status FROM relay_settlement_retries WHERE task_id = ?")
          .get(fwd!.taskId) as {
          status: string;
        };
      expect(retryRow().status, "FROZEN: the retry is left as it was").toBe("pending");
      expect(forwardOf(db, fwd!.settlementId)?.status).toBe("pending");
      expect(balance(relay, payer)).toBe(0);

      await unfreeze(relay);
      await processSettlementRetries(
        db,
        relayIdentityOf(relay),
        exhausted,
        undefined,
        peerFetch as never,
      );
      expect(retryRow().status).toBe("failed");
      expect(forwardOf(db, fwd!.settlementId)?.status).toBe("failed");
      expect(balance(relay, payer), "RESUME: refunded once").toBe(1_000_000);
    } finally {
      await relay.close();
    }
  });

  // The forward lifecycle's send claim sits AFTER the body's signing await
  // (`beginForwardSend`), on the first send and on every retry. A freeze that
  // lands inside that await reaches neither peerFetch nor a settlement signer,
  // so only these two tests see each call site: without the claim the send
  // goes out while frozen.
  const recordingPeer = (sent: string[]) => async (_url: string, init?: RequestInit) => {
    sent.push((JSON.parse(init?.body as string) as { task_id: string }).task_id);
    return new Response("{}", { status: 200 });
  };
  const retryRowOf = (relay: SyncRelay, taskId: string) =>
    relay.moteDb.db
      .prepare(
        "SELECT settlement_id, status, attempts FROM relay_settlement_retries WHERE task_id = ?",
      )
      .get(taskId) as { settlement_id: string; status: string; attempts: number };

  it("settlement forward, first send: a freeze landing while the body is signed sends nothing; the retry after unfreeze sends it once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const peer = await addPeer(relay);
      const { taskId } = heldAllocation(relay, "sign-payer", "sign-worker", 1_000_000);
      const sent: string[] = [];
      const peerFetch = recordingPeer(sent);
      hook.beforeRawSign = () => freeze(relay);
      const r = await forwardOriginSettlement(db, relayIdentityOf(relay), {
        taskId,
        peerRelayId: peer.id,
        grossAmount: 1_000_000,
        platformFeeRate: 0.05,
        receiptHash: `rh-${taskId}`,
        x402TxHash: null,
        x402Network: null,
        peerFetch: peerFetch as never,
      });
      expect(hook.beforeRawSign, "the freeze landed during the signing await").toBeNull();
      expect(r, "deferred to the committed retry row").toBe("queued");
      expect(sent, "FROZEN: nothing sent").toHaveLength(0);
      const row = retryRowOf(relay, taskId);
      expect(row.status).toBe("pending");
      expect(forwardOf(db, row.settlement_id)?.status).toBe("pending");

      db.prepare("UPDATE relay_settlement_retries SET next_retry_at = 0").run();
      const pass = () =>
        processSettlementRetries(
          db,
          relayIdentityOf(relay),
          undefined,
          undefined,
          peerFetch as never,
        );
      await pass();
      expect(sent, "a pass while frozen sends nothing").toHaveLength(0);

      await unfreeze(relay);
      await pass();
      expect(sent, "RESUME: sent once").toEqual([taskId]);
      expect(forwardOf(db, row.settlement_id)?.status).toBe("delivered");
      await pass();
      expect(sent, "never twice").toEqual([taskId]);
    } finally {
      await relay.close();
    }
  });

  it("settlement-forward retry: a freeze landing while the retry body is signed sends nothing and leaves the retry as it was; after unfreeze it is sent once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const peer = await addPeer(relay);
      const [fwd] = await queuedForwards(relay, peer, 1);
      const sent: string[] = [];
      const peerFetch = recordingPeer(sent);
      const pass = () =>
        processSettlementRetries(
          db,
          relayIdentityOf(relay),
          undefined,
          undefined,
          peerFetch as never,
        );
      hook.beforeRawSign = () => freeze(relay);
      await pass();
      expect(hook.beforeRawSign, "the freeze landed during the signing await").toBeNull();
      expect(sent, "FROZEN: nothing sent").toHaveLength(0);
      expect(retryRowOf(relay, fwd!.taskId), "the retry is left as it was").toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(forwardOf(db, fwd!.settlementId)?.status).toBe("pending");

      await unfreeze(relay);
      await pass();
      expect(sent, "RESUME: sent once").toEqual([fwd!.taskId]);
      expect(forwardOf(db, fwd!.settlementId)?.status).toBe("delivered");
      await pass();
      expect(sent, "never twice").toEqual([fwd!.taskId]);
    } finally {
      await relay.close();
    }
  });

  it("task-queue cleanup: a freeze longer than expiry + the claim hold never deletes a held settlement claim; after unfreeze it settles once", async () => {
    const w = await world();
    try {
      const db = w.relay.moteDb.db;
      const S = await admit(w);
      fundP2p(w, S);
      const R = await receiptBy(w.W, S);
      crash(w, S, true);
      expect((await postResult(w, S, R, w.D.id)).code).toBe(200);
      crash(w, S, false);
      await freeze(w.relay);
      // The freeze outlasts the entry's expiry by more than the claim hold.
      db.prepare("UPDATE relay_task_queue SET expires_at = ? WHERE task_id = ?").run(
        Date.now() - UNSETTLED_CLAIM_HOLD_MS - 60_000,
        S,
      );
      w.q.cleanup();
      w.q.evict(0);
      expect(claim(w, S), "FROZEN: the held claim survives cleanup").toEqual({
        settled: false,
        settling: R.signature,
      });

      await unfreeze(w.relay);
      w.q.cleanup();
      expect(claim(w, S), "the claim is held past unfreeze for the recovery pass").not.toBeNull();
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(settlementRows(w, S), "RESUME: one settlement").toHaveLength(1);
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(settlementRows(w, S), "never twice").toHaveLength(1);
    } finally {
      await w.relay.close();
    }
  });

  it("Path 0 withdrawal: the freeze lands between the debit and the payout claim — nothing sent, a 503 (never a 200), the amount held pending", async () => {
    let releaseAvail!: () => void;
    const availGate = new Promise<void>((r) => (releaseAvail = r));
    const sendUsdc = vi.fn().mockResolvedValue({ signature: "sig", slot: 1, confirmed: true });
    const adapter: SolanaRpcAdapter = {
      ownAddress: "RelayTreasuryAddressBase58",
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc,
      sendUsdcBatch: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockImplementation(async () => {
        await availGate;
        return true;
      }),
    };
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    try {
      const id = "fz-path0-claim";
      creditAccount(relay.moteDb.db, id, 5_000_000, "deposit", "fz-deposit-2", "self-deposit");
      const headers = jsonAuthWithIdempotency();
      const payload = JSON.stringify({
        amount: 1.5,
        destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UFZFZ",
      });
      const pending = relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers,
        body: payload,
      });
      await vi.waitFor(() => expect(adapter.isReachable).toHaveBeenCalled());
      await freeze(relay);
      releaseAvail();
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(sendUsdc, "nothing sent").not.toHaveBeenCalled();
      const rows = relay.moteDb.db
        .prepare("SELECT status FROM relay_withdrawals WHERE motebit_id = ?")
        .all(id) as Array<{ status: string }>;
      expect(rows, "the withdrawal stands pending, its amount held").toEqual([
        { status: "pending" },
      ]);
      expect(balance(relay, id)).toBe(3_500_000);

      await unfreeze(relay);
      const retry = await relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(retry.status, "the same-key retry is answered, never a 409").toBe(200);
      expect(balance(relay, id), "never debited twice").toBe(3_500_000);
    } finally {
      await relay.close();
    }
  });
  it("Path 0 withdrawal: the freeze lands during the send, which lands and fails on-chain — the refund refused, a 503 (never a 200), the proven outcome recorded; the reconcile after unfreeze refunds once", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((r) => (releaseSend = r));
    const sendUsdc = vi.fn().mockImplementation(async () => {
      await sendGate;
      return {
        signature: "sigLandedFailed",
        slot: 7,
        confirmed: false,
        earlierBroadcastsDead: true,
      };
    });
    const adapter: SolanaRpcAdapter = {
      ownAddress: "RelayTreasuryAddressBase58",
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc,
      sendUsdcBatch: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockResolvedValue(true),
    };
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    try {
      const id = "fz-path0-refund";
      creditAccount(relay.moteDb.db, id, 5_000_000, "deposit", "fz-deposit-3", "self-deposit");
      const pending = relay.app.request(`/api/v1/agents/${id}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({
          amount: 1.5,
          destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UFZFZ",
        }),
      });
      await vi.waitFor(() => expect(sendUsdc).toHaveBeenCalled());
      await freeze(relay);
      releaseSend();
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      const row = relay.moteDb.db
        .prepare(
          "SELECT withdrawal_id, status, failure_reason FROM relay_withdrawals WHERE motebit_id = ?",
        )
        .get(id) as { withdrawal_id: string; status: string; failure_reason: string };
      expect(row.status, "the claimed payout stays processing").toBe("processing");
      expect(row.failure_reason, "the PROVEN outcome, never 'may have landed'").toMatch(
        /refund refused by emergency freeze.*no USDC moved/,
      );
      expect(balance(relay, id), "FROZEN: not refunded").toBe(3_500_000);

      await unfreeze(relay);
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60 * 60 * 1000);
      const rec = await relay.app.request(
        `/api/v1/admin/withdrawals/${row.withdrawal_id}/reconcile`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({
            outcome: "not_paid",
            attestation: "sigLandedFailed landed and failed at slot 7",
          }),
        },
      );
      expect(rec.status, await rec.clone().text()).toBe(200);
      expect(balance(relay, id), "RESUME: refunded once").toBe(5_000_000);
      const again = await relay.app.request(
        `/api/v1/admin/withdrawals/${row.withdrawal_id}/reconcile`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ outcome: "not_paid", attestation: "again" }),
        },
      );
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(balance(relay, id), "never twice").toBe(5_000_000);
    } finally {
      await relay.close();
    }
  });

  it("horizon truncation: a freeze refusing the settlement truncation persists no cert attesting it; after unfreeze it commits once", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const id = crypto.randomUUID();
      recordP2pSettlementAudit(db, {
        settlement_id: id,
        allocation_id: `p2p-${id}`,
        task_id: `t-${id}`,
        motebit_id: "horizon-worker",
        receipt_hash: "rh",
        amount_settled: 1,
        platform_fee: 0,
        platform_fee_rate: 0.05,
        status: "completed",
        settled_at: 1_000,
        settlement_mode: "p2p",
      });
      const certs = () =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM relay_horizon_certs WHERE store_id = 'relay_settlements'",
          )
          .get();
      const rows = () =>
        db.prepare("SELECT COUNT(*) AS n FROM relay_settlements WHERE settlement_id = ?").get(id);
      const ctx = {
        relayIdentity: relayIdentityOf(relay),
        fetchImpl: (() => Promise.reject(new Error("no peers"))) as never,
      };
      await freeze(relay);
      await expect(advanceRelayHorizon(db, "relay_settlements", 2_000, ctx)).rejects.toThrow(
        /EMERGENCY_FROZEN/,
      );
      expect(certs(), "FROZEN: no cert without its truncation").toEqual({ n: 0 });
      expect(rows()).toEqual({ n: 1 });
      await unfreeze(relay);
      await advanceRelayHorizon(db, "relay_settlements", 2_000, ctx);
      expect(certs(), "RESUME: one cert").toEqual({ n: 1 });
      expect(rows()).toEqual({ n: 0 });
    } finally {
      await relay.close();
    }
  });

  it("the settlement guards are column-narrowed: record columns commit while frozen, money columns and money transitions are refused", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const peer = await addPeer(relay);
      const [fwd] = await queuedForwards(relay, peer, 2);
      const id = crypto.randomUUID();
      recordP2pSettlementAudit(db, {
        settlement_id: id,
        allocation_id: `p2p-${id}`,
        task_id: `t-${id}`,
        motebit_id: "narrow-worker",
        receipt_hash: "rh",
        amount_settled: 1,
        platform_fee: 0,
        platform_fee_rate: 0.05,
        status: "completed",
        settled_at: 1_000,
        settlement_mode: "p2p",
      });
      await freeze(relay);
      const run =
        (sql: string, ...a: unknown[]) =>
        () =>
          db.prepare(sql).run(...(a as never[]));
      // Records: commit.
      run("UPDATE relay_settlements SET anchor_batch_id = 'b' WHERE settlement_id = ?", id)();
      run(
        "UPDATE relay_settlements SET payment_verification_status = 'verified', payment_verified_at = 1 WHERE settlement_id = ?",
        id,
      )();
      run(
        "UPDATE relay_federation_settlements SET anchor_batch_id = 'b' WHERE settlement_id = ?",
        fwd!.settlementId,
      )();
      run(
        "UPDATE relay_federation_settlements SET status = 'delivered' WHERE settlement_id = ?",
        fwd!.settlementId,
      )();
      // Money: refused.
      expect(
        run("UPDATE relay_settlements SET amount_settled = 2 WHERE settlement_id = ?", id),
      ).toThrow(/EMERGENCY_FROZEN/);
      expect(
        run("UPDATE relay_settlements SET status = 'refunded' WHERE settlement_id = ?", id),
      ).toThrow(/EMERGENCY_FROZEN/);
      expect(
        run(
          "UPDATE relay_settlements SET anchor_batch_id = 'c', amount_settled = 3 WHERE settlement_id = ?",
          id,
        ),
        "a record change never carries a money change through",
      ).toThrow(/EMERGENCY_FROZEN/);
      const [, other] = (
        db
          .prepare("SELECT settlement_id FROM relay_federation_settlements ORDER BY rowid")
          .all() as Array<{
          settlement_id: string;
        }>
      ).map((r) => r.settlement_id);
      expect(
        run(
          "UPDATE relay_federation_settlements SET status = 'failed' WHERE settlement_id = ?",
          other,
        ),
        "forward_return moves money back to escrow",
      ).toThrow(/EMERGENCY_FROZEN/);
      expect(
        run(
          "UPDATE relay_federation_settlements SET gross_amount = 1 WHERE settlement_id = ?",
          other,
        ),
      ).toThrow(/EMERGENCY_FROZEN/);
      expect(run("DELETE FROM relay_settlements WHERE settlement_id = ?", id)).toThrow(
        /EMERGENCY_FROZEN/,
      );
    } finally {
      await relay.close();
    }
  });
});

describe("freeze at the escrow chokepoint — every allocation-money kind", () => {
  it("frozen, with the table triggers dropped, moveAllocationMoney refuses every kind and writes nothing", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const { allocationId, taskId } = heldAllocation(
        relay,
        "kind-payer",
        "kind-worker",
        1_000_000,
      );
      creditAccount(db, "kind-payer", 1_000_000, "deposit", "kind-extra", "seed");
      const settlementId = `set-${crypto.randomUUID()}`;
      const moves: Record<AllocationMoneyKind, AllocationMove> = {
        hold: { kind: "hold", allocationId, amount: 1_000, party: "kind-payer", description: "k" },
        settlement_fee: {
          kind: "settlement_fee",
          allocationId,
          amount: 50,
          settlement: {
            settlement_id: settlementId,
            allocation_id: allocationId,
            task_id: taskId,
            motebit_id: "kind-worker",
            receipt_hash: "rh",
            amount_settled: 950,
            platform_fee: 50,
            platform_fee_rate: 0.05,
            status: "completed",
            settled_at: Date.now(),
          },
        },
        settlement_credit: {
          kind: "settlement_credit",
          allocationId,
          amount: 950,
          party: "kind-worker",
          settlementId,
          description: "k",
        },
        settlement_release: {
          kind: "settlement_release",
          allocationId,
          amount: 10,
          party: "kind-payer",
          description: "k",
        },
        retry_exhaustion_refund: {
          kind: "retry_exhaustion_refund",
          allocationId,
          amount: 10,
          party: "kind-payer",
          description: "k",
        },
        sweep_refund: {
          kind: "sweep_refund",
          allocationId,
          amount: 10,
          party: "kind-payer",
          description: "k",
        },
        federated_forward: {
          kind: "federated_forward",
          allocationId,
          amount: 10,
          forward: {
            settlement_id: `fwd-${crypto.randomUUID()}`,
            task_id: taskId,
            upstream_relay_id: "self",
            downstream_relay_id: "peer-k",
            gross_amount: 10,
            fee_amount: 0,
            net_amount: 10,
            fee_rate: 0.05,
            settled_at: Date.now(),
            receipt_hash: "rh",
          },
        },
        forward_return: { kind: "forward_return", allocationId, amount: 10, settlementId: "fwd-x" },
        dispute_clawback: {
          kind: "dispute_clawback",
          allocationId,
          amount: 10,
          party: "kind-worker",
          disputeId: "d-k",
          description: "k",
        },
        dispute_worker: {
          kind: "dispute_worker",
          allocationId,
          amount: 10,
          party: "kind-worker",
          disputeId: "d-k",
          description: "k",
        },
        dispute_delegator: {
          kind: "dispute_delegator",
          allocationId,
          amount: 10,
          party: "kind-payer",
          disputeId: "d-k",
          description: "k",
        },
      };
      expect(Object.keys(moves).sort()).toEqual([...ALLOCATION_MONEY_KINDS].sort());
      dropFreezeTriggers(relay);
      await freeze(relay);
      const before = moneySnapshot(relay);
      for (const kind of ALLOCATION_MONEY_KINDS) {
        let caught: unknown = null;
        try {
          db.transaction(() => moveAllocationMoney(db, moves[kind]));
        } catch (err) {
          caught = err;
        }
        expect(caught, `${kind}: refused by the freeze at the chokepoint`).toBeInstanceOf(
          EmergencyFrozenError,
        );
      }
      expect(moneySnapshot(relay), "nothing written").toEqual(before);
      // The forward lifecycle's send claim is refused at the same place.
      expect(() => beginForwardSend(db, "fwd-x")).toThrow(EmergencyFrozenError);
      await unfreeze(relay);
      db.transaction(() => moveAllocationMoney(db, moves.hold));
    } finally {
      await relay.close();
    }
  });
});

describe("freeze — a dispute's round-2 finalize", () => {
  it("round 2: the freeze refuses the fund action at the chokepoint — a 503, the signed verdict kept, finalized once by the first read after unfreeze", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const relayId = relay.relayIdentity.relayMotebitId;
      const W = await agent(relay);
      await register(relay, W);
      const voters = await Promise.all(
        [0, 1, 2].map(async (i) => ({
          id: `relay-voter-fz-${i}`,
          url: `http://voter-fz${i}.test`,
          kp: await generateKeypair(),
        })),
      );
      for (const v of voters) {
        db.prepare(
          `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
           VALUES (?, ?, ?, ?, 'active', 0, 0, 0.5, ?, ?)`,
        ).run(v.id, bytesToHex(v.kp.publicKey), v.url, v.id, Date.now(), Date.now());
      }
      let onRound2: (() => Promise<void>) | null = null;
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const voter = voters.find((v) => url.startsWith(v.url));
        if (voter == null) return real(input, init);
        const body = JSON.parse(init!.body as string) as { dispute_id: string; round: number };
        if (body.round === 2 && onRound2 != null) {
          const h = onRound2;
          onRound2 = null;
          await h();
        }
        const vote = await signAdjudicatorVote(
          {
            dispute_id: body.dispute_id,
            round: body.round,
            peer_id: voter.id,
            vote: "overturned",
            rationale: "fz",
          },
          voter.kp.privateKey,
        );
        return new Response(JSON.stringify(vote), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const S = seedX402PaidTask(relay, {
        workerId: W.id,
        delegatorId: relayId,
        prompt: `fz r2 ${crypto.randomUUID()}`,
        unitCostUsd: 1.0,
      });
      const R = await receiptBy(W, S);
      const posted = await relay.app.request(`/agent/${W.id}/task/${S}/result`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(R),
      });
      expect(posted.status, await posted.clone().text()).toBe(200);
      const disputeId = `dsp-fz-${crypto.randomUUID()}`;
      const filed = await relay.app.request(`/api/v1/allocations/x402-${S}/dispute`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(
          await signDisputeRequest(
            {
              dispute_id: disputeId,
              task_id: S,
              allocation_id: `x402-${S}`,
              filed_by: W.id,
              respondent: relayId,
              category: "quality",
              description: "contested",
              evidence_refs: ["r"],
              filed_at: Date.now(),
            },
            W.kp.privateKey,
          ),
        ),
      });
      expect(filed.status, await filed.clone().text()).toBe(200);
      const resolved = await relay.app.request(`/api/v1/disputes/${disputeId}/resolve`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          resolution: "overturned",
          rationale: "r1",
          fund_action: "refund_to_delegator",
        }),
      });
      expect(resolved.status, await resolved.clone().text()).toBe(200);

      const before = moneySnapshot(relay);
      onRound2 = () => freeze(relay);
      const appealed = await relay.app.request(`/api/v1/disputes/${disputeId}/appeal`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(
          await signDisputeAppeal(
            {
              dispute_id: disputeId,
              appealed_by: W.id,
              reason: "disagree",
              appealed_at: Date.now(),
            },
            W.kp.privateKey,
          ),
        ),
      });
      expect(appealed.status, await appealed.clone().text()).toBe(503);
      expect(((await appealed.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(moneySnapshot(relay), "FROZEN: no money row changed").toEqual(before);
      const state = () =>
        db
          .prepare("SELECT state, fund_refusal FROM relay_disputes WHERE dispute_id = ?")
          .get(disputeId) as {
          state: string;
          fund_refusal: string | null;
        };
      expect(state(), "appealed, with no refusal marker").toEqual({
        state: "appealed",
        fund_refusal: null,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM relay_dispute_resolutions WHERE dispute_id = ? AND round = 2",
          )
          .get(disputeId),
        "the signed round-2 verdict is kept",
      ).toEqual({ n: 1 });

      await unfreeze(relay);
      const read = await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: JSON_AUTH });
      expect(read.status).toBe(200);
      expect(state().state, "RESUME: finalized by the read").toBe("final");
      const afterFinal = moneySnapshot(relay);
      expect(afterFinal.relay_transactions).not.toEqual(before.relay_transactions);
      await relay.app.request(`/api/v1/disputes/${disputeId}`, { headers: JSON_AUTH });
      expect(moneySnapshot(relay), "never twice").toEqual(afterFinal);
    } finally {
      await relay.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/** A table name that looks like money. */
const MONEY_SHAPED =
  /settle|withdraw|transaction|account|deposit|x402|allocation|refund|dispute|treasury|bond|grant|credit(?!ial)|wallet|payout|fee|subscription|ledger|escrow|p2p|payment|balance/;

describe("freeze guards — registry and installation", () => {
  it("every money-shaped table of the booted relay is guarded or exempt with a reason; the guards are installed", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      const unclassified = tables.filter(
        (t) =>
          MONEY_SHAPED.test(t) &&
          !(t in FREEZE_GUARDED_MONEY_TABLES) &&
          !(t in FREEZE_EXEMPT_TABLES),
      );
      expect(
        unclassified,
        "classify each in FREEZE_GUARDED_MONEY_TABLES or FREEZE_EXEMPT_TABLES (services/relay/src/freeze.ts)",
      ).toEqual([]);
      for (const t of Object.keys(FREEZE_GUARDED_MONEY_TABLES)) {
        expect(t in FREEZE_EXEMPT_TABLES, `${t} is both guarded and exempt`).toBe(false);
        expect(tables, `guarded table ${t} exists`).toContain(t);
      }
      for (const [t, reason] of Object.entries(FREEZE_EXEMPT_TABLES)) {
        expect(reason.length, `${t} carries its reason`).toBeGreaterThan(10);
      }
      const guards = installedFreezeGuards(db);
      for (const t of Object.keys(FREEZE_GUARDED_MONEY_TABLES)) {
        expect(
          guards.some((g) => g.startsWith(`freeze_guard_${t}_`)),
          `${t} has a freeze guard`,
        ).toBe(true);
      }
    } finally {
      await relay.close();
    }
  });

  it("a fresh boot guards exactly the declared money columns, and a restart installs the same guards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fz-guards-"));
    const dbPath = join(dir, "relay.db");
    const guardSql = (relay: SyncRelay): Record<string, string> =>
      Object.fromEntries(
        (
          relay.moteDb.db
            .prepare(
              "SELECT name, sql FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'freeze_guard_%'",
            )
            .all() as Array<{ name: string; sql: string }>
        ).map((r) => [r.name, r.sql]),
      );
    try {
      const first = await createTestRelay({ enableDeviceAuth: false, dbPath });
      let firstBoot: Record<string, string>;
      try {
        const db = first.moteDb.db;
        firstBoot = guardSql(first);
        for (const [table, money] of Object.entries(FREEZE_MONEY_COLUMNS)) {
          const live = (
            db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
          ).map((c) => c.name);
          const nonMoney = FREEZE_NON_MONEY_COLUMNS[table] ?? [];
          expect(
            money.filter((c) => nonMoney.includes(c)),
            `${table}: money and non-money overlap`,
          ).toEqual([]);
          expect(
            [...live].sort(),
            `${table}: classify every live column in FREEZE_MONEY_COLUMNS or FREEZE_NON_MONEY_COLUMNS (services/relay/src/freeze.ts)`,
          ).toEqual([...money, ...nonMoney].sort());
          // The installed UPDATE guard compares exactly the declared money columns.
          const sql = firstBoot[`freeze_guard_${table}_update`] ?? "";
          const guarded = [...sql.matchAll(/NEW\.(\w+) IS NOT OLD\.\1/g)].map((m) => m[1]);
          expect([...new Set(guarded)].sort(), `${table}: first-boot guard`).toEqual(
            [...money].sort(),
          );
          expect(freezeGuardedUpdateColumns(db, table).sort()).toEqual([...money].sort());
        }
      } finally {
        await first.close();
      }
      const second = await createTestRelay({ enableDeviceAuth: false, dbPath });
      try {
        expect(guardSql(second), "restart installs the first boot's guards").toEqual(firstBoot);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the guard refuses to install before a declared money column exists (install after every schema mutation)", () => {
    const moteDb = createMotebitDatabase(":memory:");
    try {
      // relay_settlements as it stands before the task queue adds its column.
      const money = FREEZE_MONEY_COLUMNS.relay_settlements!.filter(
        (c) => c !== "receipt_signature",
      );
      const cols = [...money, ...(FREEZE_NON_MONEY_COLUMNS.relay_settlements ?? [])];
      moteDb.db.exec(`CREATE TABLE relay_settlements (${cols.join(", ")})`);
      expect(() => freezeGuardedUpdateColumns(moteDb.db, "relay_settlements")).toThrow(
        /receipt_signature/,
      );
      moteDb.db.exec("ALTER TABLE relay_settlements ADD COLUMN receipt_signature TEXT");
      expect(freezeGuardedUpdateColumns(moteDb.db, "relay_settlements").sort()).toEqual(
        [...FREEZE_MONEY_COLUMNS.relay_settlements!].sort(),
      );
      // An unclassified live column is guarded (fail-closed).
      moteDb.db.exec("ALTER TABLE relay_settlements ADD COLUMN fz_unclassified TEXT");
      expect(freezeGuardedUpdateColumns(moteDb.db, "relay_settlements")).toContain(
        "fz_unclassified",
      );
    } finally {
      moteDb.close();
    }
  });

  it("a frozen relay refuses a direct money write in its own transaction; unfrozen it commits", async () => {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    try {
      const db = relay.moteDb.db;
      await freeze(relay);
      expect(() => creditAccount(db, "fz-direct", 1_000, "deposit", "r1", "x")).toThrow(
        /EMERGENCY_FROZEN/,
      );
      expect(balance(relay, "fz-direct")).toBe(0);
      // An empty account row moves no money: reads that create one still work.
      const read = await relay.app.request("/api/v1/agents/fz-direct/balance", {
        headers: JSON_AUTH,
      });
      expect(read.status).toBeLessThan(500);
      await unfreeze(relay);
      creditAccount(db, "fz-direct", 1_000, "deposit", "r1", "x");
      expect(balance(relay, "fz-direct")).toBe(1_000);
    } finally {
      await relay.close();
    }
  });

  it("no second database connection in the relay bypasses the guards", () => {
    // TEMP triggers live on the connection that installed them. The relay's
    // one connection is opened in index.ts (which installs the guards); cli.ts
    // is the offline operator CLI (relay key backup), never the running relay.
    const ALLOWED: Record<string, string> = {
      "index.ts": "the relay's one connection; installs the freeze guards",
      "cli.ts": "offline operator CLI (relay key backup export/import), not the running relay",
    };
    const dir = join(__dirname, "..");
    const opener =
      /\b(createMotebitDatabase|openMotebitDatabase)\s*\(|new\s+Database\s*\(|from\s+["']better-sqlite3["']|require\(\s*["']better-sqlite3["']\s*\)|\bATTACH\s+DATABASE\b/;
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(join(d, e.name));
        } else if (e.name.endsWith(".ts")) {
          const rel = join(d, e.name).slice(dir.length + 1);
          const src = readFileSync(join(d, e.name), "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*)/.test(l))
            .join("\n");
          if (opener.test(src) && !(rel in ALLOWED)) offenders.push(rel);
        }
      }
    };
    walk(dir);
    expect(offenders, "open the relay database only in index.ts").toEqual([]);
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(index).toMatch(/installFreezeMoneyGuards\(moteDb\.db\)/);
  });
});
