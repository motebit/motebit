/**
 * #890 round 10 — LIVENESS of "an answer and its settlement are ONE decision".
 *
 * Round 9 made the settlement law hold (no settlement on a receipt other than
 * the polled answer, never twice, no credit without a row). These cells pin
 * that the law's money is also REACHED — every claimed answer is eventually
 * settled, and every honest settlement eventually pays:
 *
 *   (1) DEPLOY STRADDLE — an executor-relay entry answered BEFORE the deploy
 *       (no `settling`) whose origin's settlement forward lands AFTER it is
 *       paid once (it adopts the claim for its stored answer), live and after
 *       the queue forgot it (its archived, claimed answer);
 *   (2) SUB-RECEIPT STRAND — a sub-task whose settlement failed inside its
 *       parent's answer is settled by the parent's identical retry (the
 *       nested-only path: never a direct POST of the sub-receipt);
 *   (3) RESTART RECOVERY — a crash between claim and settle is settled once
 *       by the boot sweep, through the door the claim was taken by (local,
 *       federation, sub-receipt); an executor relay redelivers its federation
 *       result to an origin that was down, and the origin settles it once;
 *   (4) PINS — the honest forward credits the executor (M1); the claim guard's
 *       archived-answer branch (M5); the frozen guard's claim-move (M9) and
 *       answered+legacy-row (M10) clauses; a settlement committed before the
 *       process died is marked, never written twice (M2).
 *
 * RED on 46b4fb5b5.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";
import { createTestRelay, createAgent, JSON_AUTH, seedBalance } from "./test-helpers.js";
import { recordTaskRoute } from "../task-routing.js";
import { TaskQueue } from "../task-queue.js";
import { getAccountBalance } from "../accounts.js";

// ── W's MCP endpoint (an ephemeral port): never answers a presentation ──
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Agent {
  id: string;
  device: string;
  kp: KeyPair;
}
interface Peer {
  id: string;
  kp: KeyPair;
  url: string;
}
interface World {
  relay: SyncRelay;
  q: TaskQueue;
  D: Agent;
  W: Agent;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function agent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { id: a.motebitId, device: a.deviceId, kp };
}

async function register(relay: SyncRelay, a: Agent): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: a.id,
      endpoint_url: `http://127.0.0.1:${PORT}/mcp`,
      capabilities: ["cap890l"],
      public_key: bytesToHex(a.kp.publicKey),
    }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

async function world(overrides: Partial<SyncRelayConfig> = {}): Promise<World> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const relay = await createTestRelay({ enableDeviceAuth: false, ...overrides });
  const D = await agent(relay);
  const W = await agent(relay);
  await register(relay, W);
  return { relay, q: new TaskQueue(relay.moteDb.db), D, W };
}

/** Re-open a relay over the same database file (a restart). */
async function restart(w: World, overrides: Partial<SyncRelayConfig>): Promise<World> {
  await w.relay.close();
  const relay = await createTestRelay({ enableDeviceAuth: false, ...overrides });
  return { ...w, relay, q: new TaskQueue(relay.moteDb.db) };
}

/** An active peer relay this relay knows (`url` is its endpoint). */
async function addPeer(relay: SyncRelay, id?: string, publicKeyHex?: string): Promise<Peer> {
  const kp = await generateKeypair();
  const peerId = id ?? `peer-${crypto.randomUUID()}`;
  const url = `http://${peerId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}.test`;
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, peered_at)
       VALUES (?, ?, ?, 'peer', 'active', ?)`,
    )
    .run(peerId, publicKeyHex ?? bytesToHex(kp.publicKey), url, Date.now());
  return { id: peerId, kp, url };
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
    body: JSON.stringify({ prompt, required_capabilities: ["cap890l"], submitted_by: w.D.id }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  await settle(60); // the MCP presentation lands (and is never answered)
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

async function postResult(
  w: World,
  taskId: string,
  r: ExecutionReceipt,
  path = w.D.id,
): Promise<{ code: number; status?: string }> {
  const res = await w.relay.app.request(`/agent/${path}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(r),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  return { code: res.status, ...(body.status != null ? { status: body.status } : {}) };
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
  return res.status;
}

/** The origin `peer` forwards task `taskId` to this relay, for W. */
async function inboundForward(w: World, peer: Peer, taskId: string): Promise<void> {
  const payload = {
    task_id: taskId,
    origin_relay: peer.id,
    target_agent: w.W.id,
    task_payload: { prompt: `fwd ${taskId}`, required_capabilities: ["cap890l"] },
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

/** The origin's §7.3 settlement forward for `taskId` (gross 1_000_000). */
async function settlementForward(
  w: World,
  peer: Peer,
  taskId: string,
  settlementId: string,
  r: ExecutionReceipt,
): Promise<number> {
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
  return res.status;
}

/** Every settlement row naming S, in both settlement tables. */
function rows(w: World, S: string): Array<{ receipt_signature: string | null }> {
  const db = w.relay.moteDb.db;
  return [
    ...(db
      .prepare("SELECT receipt_signature FROM relay_settlements WHERE task_id = ?")
      .all(S) as Array<{ receipt_signature: string | null }>),
    ...(db
      .prepare("SELECT receipt_signature FROM relay_federation_settlements WHERE task_id = ?")
      .all(S) as Array<{ receipt_signature: string | null }>),
  ];
}
const sigs = (w: World, S: string): Array<string | null> =>
  rows(w, S).map((r) => r.receipt_signature);

function claim(w: World, S: string): { settled: boolean; settling: string | null } | null {
  const row = w.relay.moteDb.db
    .prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?")
    .get(S) as { task_json: string } | undefined;
  if (row == null) return null;
  const e = JSON.parse(row.task_json) as { settled?: boolean; settling?: string };
  return { settled: e.settled === true, settling: e.settling ?? null };
}

const balance = (w: World, id: string): number =>
  getAccountBalance(w.relay.moteDb.db, id)?.balance ?? 0;

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

/**
 * The pre-deploy relay's answer, exactly as main left it: receipt + terminal
 * status, `settled: true`, NO settlement claim — one version step.
 */
function preDeployAnswer(w: World, S: string, r: ExecutionReceipt): void {
  w.relay.moteDb.db
    .prepare(
      `UPDATE relay_task_queue SET receipt = ?, status = ?,
         task_json = json_set(json_set(task_json, '$.task.status', ?), '$.settled', json('true')),
         answer_version = answer_version + 1
       WHERE task_id = ?`,
    )
    .run(JSON.stringify(r), r.status, r.status, S);
}

/** Route fetches to fake/real peer relays by host; anything else goes out. */
function routeFetch(
  routes: Record<string, (path: string, init?: RequestInit) => Promise<Response>>,
) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [base, handler] of Object.entries(routes)) {
      if (url.startsWith(base)) {
        calls.push(url.slice(base.length));
        return handler(url.slice(base.length), init);
      }
    }
    return real(input, init);
  });
  return calls;
}

const FEDERATED = (name: string): Partial<SyncRelayConfig> => ({
  federation: { endpointUrl: `http://${name}.test`, displayName: name },
});

// ───────────────────────────────────────────────────────────────────────────

describe("#890 r10 (1) deploy straddle — a pre-deploy answer is paid by the origin's later forward", () => {
  it("live: the entry adopts the claim for its stored answer; W is credited 950000 once, the row names it", async () => {
    const w = await world(FEDERATED("exec-live"));
    try {
      const origin = await addPeer(w.relay);
      routeFetch({ [origin.url]: async () => new Response("{}", { status: 200 }) });
      const T = crypto.randomUUID();
      await inboundForward(w, origin, T);
      const R = await receiptBy(w.W, T, "completed");
      preDeployAnswer(w, T, R);
      expect(claim(w, T)).toEqual({ settled: true, settling: null });

      const sid = crypto.randomUUID();
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
      expect(sigs(w, T)).toEqual([R.signature]);
      expect(claim(w, T)).toEqual({ settled: true, settling: R.signature });
      // The §7.4 retry of the same forward: no second credit, no second row.
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
      expect(sigs(w, T)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });

  it("evicted: the recovery sweep claims the stored answer (archived with its claim); the forward after eviction pays the archived executor once", async () => {
    const w = await world(FEDERATED("exec-evict"));
    try {
      const origin = await addPeer(w.relay);
      routeFetch({ [origin.url]: async () => new Response("{}", { status: 200 }) });
      const T = crypto.randomUUID();
      await inboundForward(w, origin, T);
      const R = await receiptBy(w.W, T, "completed");
      preDeployAnswer(w, T, R);
      const pass = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(pass.claimed).toContain(T);
      const archived = w.relay.moteDb.db
        .prepare("SELECT executor_id, settling FROM relay_task_answers WHERE task_id = ?")
        .get(T);
      expect(archived).toEqual({ executor_id: w.W.id, settling: R.signature });
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(T);

      const sid = crypto.randomUUID();
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
      expect(sigs(w, T)).toEqual([R.signature]);
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
    } finally {
      await w.relay.close();
    }
  });

  it("a peer's forward never pays an evicted task of this relay's OWN admission from its archive", async () => {
    const w = await world(FEDERATED("exec-own"));
    try {
      const origin = await addPeer(w.relay);
      const S = await admit(w, `own ${crypto.randomUUID()}`);
      const R = await receiptBy(w.W, S, "completed");
      // Claimed for R, its own settlement never written (no row), then forgotten.
      crash(w, S, true);
      expect((await postResult(w, S, R)).code).toBe(200);
      crash(w, S, false);
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(S);
      expect(rows(w, S)).toEqual([]);
      await settlementForward(w, origin, S, crypto.randomUUID(), R);
      expect(balance(w, w.W.id)).toBe(0);
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r10 (4) M1 — the executor relay is credited on an honest forward", () => {
  it("W answers through the executor's door (claimed + settled); the origin's forward credits 950000 once", async () => {
    const w = await world(FEDERATED("exec-honest"));
    try {
      const origin = await addPeer(w.relay);
      const results = routeFetch({
        [origin.url]: async () => new Response("{}", { status: 200 }),
      });
      const T = crypto.randomUUID();
      await inboundForward(w, origin, T);
      const R = await receiptBy(w.W, T, "completed");
      expect((await postResult(w, T, R, w.W.id)).code).toBe(200);
      expect(claim(w, T)).toEqual({ settled: true, settling: R.signature });
      expect(results.filter((p) => p === "/federation/v1/task/result").length).toBe(1);
      const sid = crypto.randomUUID();
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
      expect(await settlementForward(w, origin, T, sid, R)).toBe(200);
      expect(balance(w, w.W.id)).toBe(950_000);
      expect(sigs(w, T)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r10 (2) sub-receipt strand — the parent's identical retry settles a failed nested sub-settlement", () => {
  it("S's settlement fails inside P's answer; re-POSTing P's receipt (never S's) settles S once on R", async () => {
    const w = await world();
    try {
      const prompt = `strand ${crypto.randomUUID()}`;
      const S = await admit(w, prompt);
      fund(w, S);
      const P = await admit(w, `${prompt} parent`);
      const R = await receiptBy(w.W, S, "completed");
      const PR = await receiptBy(w.W, P, "completed", [R]);
      crash(w, S, true);
      expect((await postResult(w, P, PR)).code).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      expect(rows(w, S)).toEqual([]);
      // The parent's identical retry: already settled itself — and it re-walks
      // the stranded sub-claim through the one door routine.
      expect(await postResult(w, P, PR)).toEqual({ code: 200, status: "already_settled" });
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      expect(sigs(w, S)).toEqual([R.signature]);
      // Again: nothing more.
      expect(await postResult(w, P, PR)).toEqual({ code: 200, status: "already_settled" });
      expect(sigs(w, S)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r10 (3) restart recovery — the boot sweep settles a claim a crash left, exactly once", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-890-r10-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("local door: crash between claim and settle, restart; the boot pass settles one row; a later sweep and the retry write nothing", async () => {
    const cfg = { dbPath: join(dir, `local-${crypto.randomUUID()}.db`) };
    let w = await world(cfg);
    try {
      const S = await admit(w, `restart ${crypto.randomUUID()}`);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      expect((await postResult(w, S, R)).code).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      expect(rows(w, S)).toEqual([]);

      w = await restart(w, cfg);
      const boot = await w.relay.settlementRecovery.booted;
      expect(boot?.settled).toEqual([S]);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      expect(sigs(w, S)).toEqual([R.signature]);
      const again = await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(again.replayed).toEqual([]);
      expect(await postResult(w, S, R)).toEqual({ code: 200, status: "already_settled" });
      expect(sigs(w, S)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });

  it("federation door: the claim is replayed through the federation door with its peer — one federation row", async () => {
    const cfg = { dbPath: join(dir, `fed-${crypto.randomUUID()}.db`) };
    let w = await world(cfg);
    try {
      const peer = await addPeer(w.relay);
      const S = await admit(w, `restart-fed ${crypto.randomUUID()}`);
      w.q.update(S, (e) => {
        e.price_snapshot = 1_000_000;
      });
      recordTaskRoute(w.relay.moteDb.db, S, w.W.id, peer.id);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      expect(await fedResult(w, peer, S, R)).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });

      w = await restart(w, cfg);
      const boot = await w.relay.settlementRecovery.booted;
      expect(boot?.settled).toEqual([S]);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      const fed = w.relay.moteDb.db
        .prepare("SELECT receipt_signature FROM relay_federation_settlements WHERE task_id = ?")
        .all(S);
      expect(fed).toEqual([{ receipt_signature: R.signature }]);
      await w.relay.settlementRecovery.sweep({ graceMs: 0 });
      expect(sigs(w, S)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });

  it("sub-receipt door: the boot pass replays the parent's answer, which settles the stranded sub-claim once", async () => {
    const cfg = { dbPath: join(dir, `sub-${crypto.randomUUID()}.db`) };
    let w = await world(cfg);
    try {
      const prompt = `restart-sub ${crypto.randomUUID()}`;
      const S = await admit(w, prompt);
      fund(w, S);
      const P = await admit(w, `${prompt} parent`);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      expect((await postResult(w, P, await receiptBy(w.W, P, "completed", [R]))).code).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });

      w = await restart(w, cfg);
      const boot = await w.relay.settlementRecovery.booted;
      expect(boot?.settled).toEqual([S]);
      expect(sigs(w, S)).toEqual([R.signature]);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
    } finally {
      await w.relay.close();
    }
  });

  it("the periodic pass leaves a fresh claim to its own door (grace); past the grace it settles it", async () => {
    const w = await world();
    try {
      const S = await admit(w, `grace ${crypto.randomUUID()}`);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      await postResult(w, S, R);
      crash(w, S, false);
      expect((await w.relay.settlementRecovery.sweep()).replayed).toEqual([]);
      expect(rows(w, S)).toEqual([]);
      const late = await w.relay.settlementRecovery.sweep({ now: Date.now() + 10 * 60_000 });
      expect(late.settled).toEqual([S]);
      expect(sigs(w, S)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });

  it("a claimed-but-unsettled entry is not expired or evicted out from under the sweep", async () => {
    const w = await world();
    try {
      const S = await admit(w, `held ${crypto.randomUUID()}`);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      await postResult(w, S, R);
      crash(w, S, false);
      const far = Date.now() + 2 * 60 * 60 * 1000;
      w.q.cleanup(far);
      w.q.evict(0);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
    } finally {
      await w.relay.close();
    }
  });
});

describe("#890 r10 (3) the executor relay redelivers its federation result until the origin acknowledges", () => {
  it("origin down, then up: the result is redelivered once and the origin settles it once", async () => {
    // A = the origin (a real relay); B = the executor (the relay under test).
    const A = await world(FEDERATED("relay-origin"));
    const B = await world(FEDERATED("relay-exec"));
    try {
      const aId = A.relay.relayIdentity.relayMotebitId;
      const bId = B.relay.relayIdentity.relayMotebitId;
      // B knows A by a key this test signs A's forward with; A knows B by B's
      // real key (B signs the result it returns).
      const aAtB = await addPeer(B.relay, aId);
      const bAtA = await addPeer(A.relay, bId, B.relay.relayIdentity.publicKeyHex);
      let originDown = true;
      const toA: number[] = [];
      routeFetch({
        [aAtB.url]: async (path, init) => {
          if (originDown) throw new TypeError("fetch failed: origin down");
          const res = await A.relay.app.request(path, {
            method: init?.method ?? "GET",
            headers: init?.headers as Record<string, string>,
            body: init?.body as string,
          });
          if (path === "/federation/v1/task/result") toA.push(res.status);
          return res;
        },
        [bAtA.url]: async (path, init) =>
          B.relay.app.request(path, {
            method: init?.method ?? "GET",
            headers: init?.headers as Record<string, string>,
            body: init?.body as string,
          }),
      });
      // A admitted S and forwarded it to B's W.
      const S = await admit(A, `redeliver ${crypto.randomUUID()}`);
      A.q.update(S, (e) => {
        e.price_snapshot = 1_000_000;
      });
      recordTaskRoute(A.relay.moteDb.db, S, B.W.id, bId);
      await inboundForward(B, aAtB, S);
      // W answers at B; B's one send finds the origin down.
      const R = await receiptBy(B.W, S, "completed");
      expect((await postResult(B, S, R, B.W.id)).code).toBe(200);
      expect(toA).toEqual([]);
      const owed = () =>
        B.relay.moteDb.db
          .prepare("SELECT status, attempts FROM relay_result_deliveries WHERE task_id = ?")
          .get(S) as { status: string; attempts: number } | undefined;
      expect(owed()).toEqual({ status: "pending", attempts: 1 });
      // Still down: the due retry fails, stays owed.
      await B.relay.settlementRecovery.sweep({ graceMs: 0, now: Date.now() + 60 * 60_000 });
      expect(owed()?.status).toBe("pending");
      // Up: redelivered, acknowledged, settled once at the origin.
      originDown = false;
      const up = await B.relay.settlementRecovery.sweep({
        graceMs: 0,
        now: Date.now() + 3 * 60 * 60_000,
      });
      expect(up.delivered).toBe(1);
      expect(toA).toEqual([200]);
      expect(owed()?.status).toBe("delivered");
      expect(claim(A, S)).toEqual({ settled: true, settling: R.signature });
      expect(sigs(A, S)).toEqual([R.signature]);
      // Nothing is owed any more: no further delivery, no second settlement.
      await B.relay.settlementRecovery.sweep({ graceMs: 0, now: Date.now() + 9 * 60 * 60_000 });
      expect(toA).toEqual([200]);
      expect(sigs(A, S)).toEqual([R.signature]);
    } finally {
      await A.relay.close();
      await B.relay.close();
    }
  });
});

describe("#890 r10 (4) pins — the guards' clauses and the door routine's committed-row branch", () => {
  const insertRow = (w: World, S: string, sig: string | null): string => {
    try {
      w.relay.moteDb.db
        .prepare(
          `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at, receipt_signature)
           VALUES (?, ?, ?, ?, 'h', 1, 0, 'completed', ?, ?)`,
        )
        .run(crypto.randomUUID(), crypto.randomUUID(), S, w.W.id, Date.now(), sig);
      return "written";
    } catch (err) {
      return /claimed for|settles once/.test(String(err)) ? "refused" : String(err);
    }
  };

  it("M5: after eviction the claim guard admits only the ARCHIVED answer's claimed receipt", async () => {
    const w = await world();
    try {
      const S = await admit(w, `m5 ${crypto.randomUUID()}`);
      const R = await receiptBy(w.W, S, "completed");
      const other = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      await postResult(w, S, R); // claimed for R, archived, unsettled
      crash(w, S, false);
      w.relay.moteDb.db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(S);
      expect(insertRow(w, S, other.signature)).toBe("refused");
      expect(insertRow(w, S, null)).toBe("refused");
      expect(insertRow(w, S, R.signature)).toBe("written");
    } finally {
      await w.relay.close();
    }
  });

  const moveClaim = (w: World, S: string, to: string): string => {
    try {
      w.relay.moteDb.db
        .prepare(
          `UPDATE relay_task_queue SET task_json = json_set(task_json, '$.settling', ?),
             answer_version = answer_version + 1 WHERE task_id = ?`,
        )
        .run(to, S);
      return "moved";
    } catch (err) {
      return /frozen/.test(String(err)) ? "refused" : String(err);
    }
  };
  const moveAnswer = (w: World, S: string, to: ExecutionReceipt): string => {
    try {
      w.relay.moteDb.db
        .prepare(
          "UPDATE relay_task_queue SET receipt = ?, answer_version = answer_version + 1 WHERE task_id = ?",
        )
        .run(JSON.stringify(to), S);
      return "moved";
    } catch (err) {
      return /frozen/.test(String(err)) ? "refused" : String(err);
    }
  };

  it("M9: a version-stepped raw write cannot move the claim off the receipt a settlement row names", async () => {
    const w = await world();
    try {
      const S = await admit(w, `m9 ${crypto.randomUUID()}`);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      const other = await receiptBy(w.W, S, "completed");
      expect((await postResult(w, S, R)).code).toBe(200);
      expect(sigs(w, S)).toEqual([R.signature]);
      expect(moveClaim(w, S, other.signature)).toBe("refused");
      expect(claim(w, S)?.settling).toBe(R.signature);
    } finally {
      await w.relay.close();
    }
  });

  it("M10: an answered entry a legacy (unsigned) settlement row pays cannot take another receipt", async () => {
    const w = await world();
    try {
      const S = await admit(w, `m10 ${crypto.randomUUID()}`);
      const R = await receiptBy(w.W, S, "completed");
      const other = await receiptBy(w.W, S, "completed");
      preDeployAnswer(w, S, R);
      // The pre-deploy relay's row (no receipt signature), guards off as then.
      const db = w.relay.moteDb.db;
      const guards = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'relay_settlements_%_guard'",
        )
        .all() as Array<{ name: string; sql: string }>;
      for (const g of guards) db.exec(`DROP TRIGGER ${g.name}`);
      db.prepare(
        `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled, platform_fee, status, settled_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 'completed', ?)`,
      ).run(crypto.randomUUID(), crypto.randomUUID(), S, w.W.id, R.result_hash, Date.now());
      for (const g of guards) db.exec(g.sql);
      expect(moveAnswer(w, S, other)).toBe("refused");
      expect(w.q.get(S)?.receipt?.signature).toBe(R.signature);
    } finally {
      await w.relay.close();
    }
  });

  it("M2: the settlement COMMITTED but the process died before marking it — the retry marks it settled and writes nothing", async () => {
    const w = await world();
    try {
      const S = await admit(w, `m2 ${crypto.randomUUID()}`);
      fund(w, S);
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      await postResult(w, S, R); // claimed for R, nothing written
      crash(w, S, false);
      // The row the dead process committed (its write landed; the mark did not).
      expect(insertRow(w, S, R.signature)).toBe("written");
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      expect(await postResult(w, S, R)).toEqual({ code: 200, status: "already_settled" });
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
      expect(sigs(w, S)).toEqual([R.signature]);
    } finally {
      await w.relay.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (5) The recovery loop's own lifecycle (#890 r10 final review): one pass at
// a time and never a queue behind it; the emergency freeze is honoured INSIDE
// a pass (P6); `close()` is bounded against a blackholed origin (P5).
// ───────────────────────────────────────────────────────────────────────────

/** The executor relay under test with `n` federation results owed to a fake origin. */
interface Outbox {
  w: World;
  peer: Peer;
  /** How the origin answers a result delivery: thrown, blackholed, 503, 200. */
  mode: "down" | "hang" | "fail" | "up";
  /** Result deliveries the origin received. */
  results: number;
  /** Blackholed deliveries, released with a 503. */
  hung: Array<() => void>;
  tasks: string[];
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await settle(10);
  }
}

async function outbox(n: number, cfg: Partial<SyncRelayConfig> = {}): Promise<Outbox> {
  const w = await world({ ...FEDERATED("relay-exec"), ...cfg });
  await w.relay.settlementRecovery.booted;
  const peer = await addPeer(w.relay);
  const o: Outbox = { w, peer, mode: "down", results: 0, hung: [], tasks: [] };
  routeFetch({
    [peer.url]: (path, init) => {
      if (path !== "/federation/v1/task/result") {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      o.results++;
      if (o.mode === "down") return Promise.reject(new TypeError("fetch failed: origin down"));
      if (o.mode === "fail") return Promise.resolve(new Response("{}", { status: 503 }));
      if (o.mode === "up") return Promise.resolve(new Response("{}", { status: 200 }));
      // Blackholed: no answer, ever — only the caller's abort ends it.
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
            ),
          { once: true },
        );
        o.hung.push(() => resolve(new Response("{}", { status: 503 })));
      });
    },
  });
  for (let i = 0; i < n; i++) {
    const S = `owed-${crypto.randomUUID()}`;
    await inboundForward(w, peer, S);
    const R = await receiptBy(w.W, S, "completed");
    expect((await postResult(w, S, R, w.W.id)).code).toBe(200);
    o.tasks.push(S);
  }
  await settle(20);
  return o;
}

const release = (o: Outbox): void => {
  o.mode = "fail";
  for (const r of o.hung.splice(0)) r();
};

const owedRows = (w: World, tasks: string[]): Array<{ status: string; attempts: number }> =>
  tasks.map(
    (S) =>
      w.relay.moteDb.db
        .prepare("SELECT status, attempts FROM relay_result_deliveries WHERE task_id = ?")
        .get(S) as { status: string; attempts: number },
  );

/** A relay-custody self-delegated task of W's (a funded hold; settling it credits W). */
async function custodyTask(w: World): Promise<string> {
  const listing = await w.relay.app.request(`/api/v1/agents/${w.W.id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: ["cap890l"],
      pricing: [{ capability: "cap890l", unit_cost: 1.0, currency: "USD", per: "task" }],
      description: "custody",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
  expect(listing.status, await listing.clone().text()).toBe(200);
  seedBalance(w.relay, w.W.id, 10);
  const res = await w.relay.app.request(`/agent/${w.W.id}/task`, {
    method: "POST",
    headers: { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: `custody ${crypto.randomUUID()}`,
      required_capabilities: ["cap890l"],
      submitted_by: w.W.id,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  await settle(60);
  return task_id;
}

const credits = (w: World, id: string): number =>
  (
    w.relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_transactions WHERE motebit_id = ? AND type = 'settlement_credit'",
      )
      .get(id) as { n: number }
  ).n;

async function admin(w: World, op: "freeze" | "unfreeze"): Promise<number> {
  const res = await w.relay.app.request(`/api/v1/admin/${op}`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ reason: "#890 r10 P6" }),
  });
  return res.status;
}

/** Far enough ahead that every owed delivery is due again, whatever its backoff. */
const FAR = (): { graceMs: number; now: number } => ({
  graceMs: 0,
  now: Date.now() + 30 * 24 * 60 * 60_000,
});

describe("#890 r10 (5) the recovery loop — single-flight, freeze inside the pass, bounded close", () => {
  it("single-flight, never chain: sweeps arriving while a pass is in flight join it — no pass is queued behind it", async () => {
    const o = await outbox(1);
    try {
      const sweep = o.w.relay.settlementRecovery.sweep;
      const before = o.results;
      o.mode = "hang";
      const p1 = sweep(FAR());
      await until(() => o.hung.length === 1);
      const joined = [sweep(FAR()), sweep(FAR()), sweep(FAR())];
      release(o);
      const reports = await Promise.all([p1, ...joined]);
      await settle(50);
      // One pass ran: one delivery attempt, every caller got that pass's report.
      expect(o.results - before).toBe(1);
      for (const r of reports) expect(r).toBe(reports[0]);
      // The pass is over: the next sweep is a pass of its own.
      o.mode = "up";
      expect((await sweep(FAR())).delivered).toBe(1);
      expect(o.results - before).toBe(2);
    } finally {
      await o.w.relay.close();
    }
  }, 60_000);

  it("P6 freeze inside the pass: a pass hung on the outbox, a claimed-unsettled relay-custody task, freeze — zero settlement_credit while frozen; unfreeze — settled exactly once", async () => {
    const o = await outbox(1);
    const w = o.w;
    try {
      const sweep = w.relay.settlementRecovery.sweep;
      const S = await custodyTask(w);
      o.mode = "hang";
      const p1 = sweep(FAR());
      await until(() => o.hung.length === 1);
      // While pass 1 hangs on the outbox, W's answer is claimed and its
      // settlement step dies.
      const R = await receiptBy(w.W, S, "completed");
      crash(w, S, true);
      expect((await postResult(w, S, R, w.W.id)).code).toBe(200);
      crash(w, S, false);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      const base = credits(w, w.W.id);
      expect(await admin(w, "freeze")).toBe(200);
      // A sweep arriving now, the hung pass resuming, and a fresh pass — all frozen.
      const p2 = sweep({ graceMs: 0 });
      release(o);
      await Promise.all([p1, p2]);
      await sweep({ graceMs: 0 });
      expect(credits(w, w.W.id) - base).toBe(0);
      expect(rows(w, S)).toEqual([]);
      expect(claim(w, S)).toEqual({ settled: false, settling: R.signature });
      // Unfrozen: the next pass settles it exactly once.
      expect(await admin(w, "unfreeze")).toBe(200);
      expect((await sweep({ graceMs: 0 })).settled).toEqual([S]);
      await sweep({ graceMs: 0 });
      expect(credits(w, w.W.id) - base).toBe(1);
      expect(sigs(w, S)).toEqual([R.signature]);
      expect(claim(w, S)).toEqual({ settled: true, settling: R.signature });
    } finally {
      await w.relay.close();
    }
  }, 60_000);

  it("P5 bounded close(): 3 owed deliveries to a blackholed origin and a pass in flight — close() returns promptly; the aborted delivery stays pending, unburned, and is delivered after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-890-r10-close-"));
    const cfg = { ...FEDERATED("relay-exec"), dbPath: join(dir, "close.db") };
    try {
      const o = await outbox(3, cfg);
      expect(owedRows(o.w, o.tasks)).toEqual(
        o.tasks.map(() => ({ status: "pending", attempts: 1 })),
      );
      o.mode = "hang";
      const pass = o.w.relay.settlementRecovery.sweep(FAR());
      await until(() => o.hung.length === 1);
      const t0 = Date.now();
      await o.w.relay.close();
      const took = Date.now() - t0;
      expect(took).toBeLessThan(3_000);
      // The pass itself was stopped by the close, not left running past it.
      const done = await Promise.race([pass, settle(0).then(() => "running" as const)]);
      expect(done).not.toBe("running");
      expect(done !== "running" ? done.halted : undefined).toBe("closing");
      // Restart: nothing was burned by the abort; every result is delivered once.
      o.mode = "up";
      const relay = await createTestRelay({ enableDeviceAuth: false, ...cfg });
      const w = { ...o.w, relay, q: new TaskQueue(relay.moteDb.db) };
      try {
        await relay.settlementRecovery.booted;
        expect(owedRows(w, o.tasks)).toEqual(
          o.tasks.map(() => ({ status: "pending", attempts: 1 })),
        );
        const before = o.results;
        expect((await relay.settlementRecovery.sweep(FAR())).delivered).toBe(3);
        expect(o.results - before).toBe(3);
        expect(owedRows(w, o.tasks)).toEqual(
          o.tasks.map(() => ({ status: "delivered", attempts: 2 })),
        );
      } finally {
        await relay.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
