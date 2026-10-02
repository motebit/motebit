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
 * replay, settlement forward, x402 settle, Path 0 withdrawal, batch withdrawal.
 *
 * Plus the registry: every money-shaped table is either guarded or exempt with
 * a reason, the guards are installed on the booted relay, and no second
 * database connection in the relay bypasses them.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation, receipt and envelope signing
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  sign,
  canonicalJson,
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
import { recordTaskRoute } from "../task-routing.js";
import { TaskQueue } from "../task-queue.js";
import { creditAccount, getAccountBalance, toMicro } from "../accounts.js";
import { enqueuePendingWithdrawal, evaluateAndFireRail } from "../batch-withdrawals.js";
import { reconcilePendingX402Settlements } from "../x402-settlements.js";
import {
  FREEZE_EXEMPT_TABLES,
  FREEZE_GUARDED_MONEY_TABLES,
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
const hook = vi.hoisted(() => ({ beforeSign: null as null | (() => Promise<void>) }));
vi.mock("@motebit/encryption", async (importOriginal) => {
  const m = await importOriginal<typeof import("@motebit/encryption")>();
  const wrap =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const before = hook.beforeSign;
      if (before != null) {
        hook.beforeSign = null;
        await before();
      }
      return f(...a);
    };
  return {
    ...m,
    signSettlement: wrap(m.signSettlement),
    signFederationSettlement: wrap(m.signFederationSettlement),
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
  facilitator.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  hook.beforeSign = null;
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
      // The paid-but-uncredited outcome #907 defined: do NOT pay again, the
      // pending record is reconciled against the chain.
      expect(res.status, await res.clone().text()).toBe(402);
      expect(((await res.json()) as { code?: string }).code).toBe("TASK_X402_OUTCOME_UNKNOWN");
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
