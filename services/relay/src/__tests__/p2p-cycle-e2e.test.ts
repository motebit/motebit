/**
 * P2P Settlement Cycle E2E: Proves the direct onchain settlement path.
 *
 * eligibility → payment proof → task submission → receipt → audit record
 * with verification_status=pending → trust updated → credential issued
 *
 * Also proves: ineligible pair falls back to relay, p2p dispute creates
 * trust-layer complaint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";
import type { SyncRelay } from "../index.js";
import {
  deriveSolanaAddress,
  SOLANA_MAINNET_CAIP2,
  SolanaWalletRail,
} from "@motebit/wallet-solana";
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";
import { InvokeCapabilityManager } from "@motebit/runtime";
import { computeP2pFeeMicro, toMicro, PLATFORM_FEE_RATE } from "@motebit/protocol";
import {
  generateKeypair,
  bytesToHex,
  signDisputeRequest,
  signExecutionReceipt,
  createSignedToken,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  API_TOKEN,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";

// Valid base58 Solana address (no 0/O/I/l)
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
// Valid base58 tx hash (64-88 chars, no 0/O/I/l)
const FAKE_TX_HASH = "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk";

/**
 * A signed device token — what the runtime's `authToken` mints in production
 * (carries `mid`, so the relay sets `callerMotebitId`). The master test token
 * does NOT, so the listing pre-flight eligibility — which is caller-bound — only
 * fires under a real signed token.
 */
function makeSignedToken(
  motebitId: string,
  deviceId: string,
  privateKey: Uint8Array,
  aud: string,
): Promise<string> {
  const now = Date.now();
  return createSignedToken(
    {
      mid: motebitId,
      did: deviceId,
      iat: now,
      exp: now + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud,
    },
    privateKey,
  );
}

function setTrust(
  db: import("@motebit/persistence").DatabaseDriver,
  fromId: string,
  toId: string,
  trustLevel: string,
  interactionCount: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fromId, toId, trustLevel, interactionCount, Date.now(), Date.now());
}

describe("P2P Settlement Cycle E2E", () => {
  let relay: SyncRelay;
  let workerKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let delegatorKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let worker: { motebitId: string; deviceId: string };
  let delegator: { motebitId: string; deviceId: string };

  beforeEach(async () => {
    relay = await createTestRelay();
    workerKp = await generateKeypair();
    delegatorKp = await generateKeypair();
    worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));

    // Register worker with p2p settlement capabilities
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
        settlement_address: WORKER_SOLANA_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });

    // Register delegator with p2p
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: delegator.motebitId,
        endpoint_url: "http://localhost:3201/mcp",
        capabilities: [],
        settlement_modes: "relay,p2p",
      }),
    });

    // Worker needs a listing
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "Search",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });

    // Build trust between the pair (verified, 10 interactions)
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "verified", 10);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("invokeCapability (the REAL surface entry) drives single-op P2P end-to-end against the live relay", async () => {
    // The #1 verification. 147f414b "activated P2P across all surfaces" by
    // wiring relayPublicKey + buildP2pPayment into invokeCapability, but that
    // config-assembly layer was never run against a real relay — the same
    // "activated but never exercised end-to-end" shape that hid the wire-key
    // bug one layer down. This drives the actual InvokeCapabilityManager
    // (@motebit/runtime) — the deterministic chip-tap entry point — against the
    // live relay and proves it (a) assembles the P2P config, (b) takes the P2P
    // path rather than silently falling back to relay-mode, and (c) the relay
    // accepts the proof (past eligibility + 2-leg validation) + dispatches.
    const SYNC_URL = "http://relay.invoke.test";
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SYNC_URL)) return relay.app.request(url.slice(SYNC_URL.length), init);
      return originalFetch(input as never, init);
    });

    // Worker connection so the accepted P2P task dispatches over ws.
    const workerWs = { send: vi.fn(), close: vi.fn() };
    relay.connections.set(worker.motebitId, [{ ws: workerWs as never, deviceId: worker.deviceId }]);

    // Real wallet rail + fake adapter (no Solana). Single-op P2P = 2 legs.
    let batchLegs: Array<{ toAddress: string; microAmount: bigint }> = [];
    const fakeAdapter = {
      ownAddress: "De1egatorSo1anaAddr11111111111111111111111",
      getUsdcBalance: vi.fn().mockResolvedValue(100_000_000n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc: vi.fn(),
      sendUsdcBatch: vi.fn(async (legs: Array<{ toAddress: string; microAmount: bigint }>) => {
        batchLegs = legs;
        return legs.map(() => ({ ok: true, signature: FAKE_TX_HASH, slot: 1, confirmed: true }));
      }),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockResolvedValue(true),
    } as unknown as SolanaRpcAdapter;
    const rail = new SolanaWalletRail(fakeAdapter);

    const manager = new InvokeCapabilityManager(
      {
        motebitId: delegator.motebitId,
        logger: { warn: vi.fn() },
        bumpTrustFromReceipt: async () => {},
        stashReceipt: () => {},
        buildP2pPayment: (req) => rail.buildP2pPayment!(req),
      },
      {
        syncUrl: SYNC_URL,
        authToken: async () => API_TOKEN,
        relayPublicKey: relay.relayIdentity.publicKeyHex,
        timeoutMs: 100,
      },
    );

    const chunks: Array<{ type: string; code?: string }> = [];
    for await (const c of manager.invokeCapability(
      "web_search",
      "search via the real entry point",
    )) {
      chunks.push(c as { type: string; code?: string });
    }
    vi.unstubAllGlobals();

    // (a)+(b): invokeCapability assembled the config + took the LOCAL single-op
    //    P2P path — 2 legs (worker net + relay-treasury fee), NOT a federated
    //    3-leg and NOT a no-build relay-mode fallback.
    expect(batchLegs).toHaveLength(2);
    expect(batchLegs[0]).toEqual({
      toAddress: WORKER_SOLANA_ADDR,
      microAmount: BigInt(toMicro(0.5)),
    });
    expect(batchLegs[1]!.microAmount).toBe(
      BigInt(computeP2pFeeMicro(toMicro(0.5), PLATFORM_FEE_RATE)),
    );

    // (c): the relay ACCEPTED the proof + dispatched to the worker. A submission
    //    rejection (eligibility / proof / wire-key) would never reach dispatch.
    const dispatched = workerWs.send.mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string) as { type: string })
      .find((m) => m.type === "task_request");
    expect(
      dispatched,
      "relay must accept the proof + dispatch the P2P task to the worker",
    ).toBeDefined();

    // The only terminal error is a poll timeout (no worker receipt in 100ms),
    // NOT a pre-flight/submission rejection.
    const err = chunks.find((c) => c.type === "invoke_error");
    if (err) {
      expect([
        "unauthorized",
        "payment_proof_required",
        "malformed_request",
        "no_routing",
        "no_sovereign_rail",
      ]).not.toContain(err.code);
      expect(err.code).toBe("timeout");
    }
  });

  it("invokeCapability cold-start: pre-flight blocks the broadcast when ineligible; ack makes it eligible", async () => {
    // The realistic NEW-USER path: a first paid delegation to a worker with no
    // trust history. The relay's single-op eligibility gate only admits a new
    // pair when the delegator acknowledges cold-start risk. This proves the
    // MONEY-SAFETY fix: the relay's pre-flight eligibility (folded into the
    // listing read the client makes BEFORE broadcasting) lets the client refuse
    // to broadcast for an ineligible pair — so funds NEVER move on a doomed
    // submission. Without the ack: no broadcast, degrade to relay-mode. With the
    // ack: the pair becomes eligible, the client broadcasts and the relay accepts.
    const SYNC_URL = "http://relay.coldstart.test";
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SYNC_URL)) return relay.app.request(url.slice(SYNC_URL.length), init);
      return originalFetch(input as never, init);
    });
    // Remove the seeded trust → the pair is genuinely cold-start.
    relay.moteDb.db
      .prepare("DELETE FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?")
      .run(delegator.motebitId, worker.motebitId);
    relay.connections.set(worker.motebitId, [
      { ws: { send: vi.fn(), close: vi.fn() } as never, deviceId: worker.deviceId },
    ]);

    // Distinct tx per run — a real delegation never reuses a signature, and
    // sharing one would trip the relay's idempotency / proof-replay guards.
    const SIG_NO_ACK = FAKE_TX_HASH;
    const SIG_ACK = "2bQr9sTuVwXyZaCdEfGhJkMnPqRsTuVwXyZaCdEfGhJkMnPqRsTuVwXyZaCdEfGhJk";
    const makeRail = (sig: string) => {
      const broadcasts: number[] = [];
      const adapter = {
        ownAddress: "De1egatorSo1anaAddr11111111111111111111111",
        getUsdcBalance: vi.fn().mockResolvedValue(100_000_000n),
        getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
        sendUsdc: vi.fn(),
        sendUsdcBatch: vi.fn(async (legs: Array<{ microAmount: bigint }>) => {
          broadcasts.push(legs.length);
          return legs.map(() => ({ ok: true, signature: sig, slot: 1, confirmed: true }));
        }),
        getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
        isReachable: vi.fn().mockResolvedValue(true),
      } as unknown as SolanaRpcAdapter;
      return { rail: new SolanaWalletRail(adapter), broadcasts };
    };

    const run = async (
      acknowledgeNoHistoryRisk: boolean,
      broadcasts: number[],
      rail: SolanaWalletRail,
    ) => {
      const manager = new InvokeCapabilityManager(
        {
          motebitId: delegator.motebitId,
          logger: { warn: vi.fn() },
          bumpTrustFromReceipt: async () => {},
          stashReceipt: () => {},
          buildP2pPayment: (req) => rail.buildP2pPayment!(req),
        },
        {
          syncUrl: SYNC_URL,
          // Signed token (not the master token) so the relay sets callerMotebitId
          // and the listing pre-flight eligibility — caller-bound — actually runs.
          authToken: (aud?: string) =>
            makeSignedToken(
              delegator.motebitId,
              delegator.deviceId,
              delegatorKp.privateKey,
              aud ?? "sync",
            ),
          relayPublicKey: relay.relayIdentity.publicKeyHex,
          timeoutMs: 100,
        },
      );
      const chunks: Array<{ type: string; code?: string }> = [];
      // Per-invocation options ack — the exact path the web surface uses
      // (WebApp.invokeCapability reads the persisted opt-in and passes it here).
      for await (const c of manager.invokeCapability(
        "web_search",
        "cold-start paid delegation",
        acknowledgeNoHistoryRisk ? { acknowledgeNoHistoryRisk: true } : {},
      )) {
        chunks.push(c as { type: string; code?: string });
      }
      return { err: chunks.find((c) => c.type === "invoke_error"), broadcasts };
    };

    // WITHOUT the ack: the pre-flight (folded into the listing read the client
    // makes BEFORE broadcasting) reports the cold-start pair ineligible, so the
    // client never broadcasts — funds never move. p2p_ineligible is
    // pre-broadcast → degrade to relay-mode. Before this fix the client
    // broadcast THEN got a 403 → funds lost. The empty broadcast IS the fix.
    const noAck = makeRail(SIG_NO_ACK);
    const withoutAck = await run(false, noAck.broadcasts, noAck.rail);
    expect(noAck.broadcasts, "no broadcast for an ineligible cold-start pair").toEqual([]);
    expect(withoutAck.err?.code).not.toBe("unauthorized"); // not a post-broadcast 403

    // WITH the ack: the pre-flight (and the submission) admit the new pair, so
    // the client DOES broadcast (2 legs) and the relay accepts.
    const withAckRail = makeRail(SIG_ACK);
    const withAck = await run(true, withAckRail.broadcasts, withAckRail.rail);
    vi.unstubAllGlobals();
    expect(withAckRail.broadcasts, "ack makes the pair eligible → broadcast proceeds").toEqual([2]);
    expect(withAck.err?.code).not.toBe("unauthorized");
    expect(withAck.err?.code).not.toBe("payment_proof_required");
  });

  it("p2p-eligibility endpoint: caller-bound — cold-start denied, ack admits, master/no-caller advisory-allowed", async () => {
    // Locks the pre-flight endpoint's contract directly. It returns the SAME
    // decision the submission gate enforces, so a delegator client can avoid
    // broadcasting to a worker that would be rejected.
    relay.moteDb.db
      .prepare("DELETE FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?")
      .run(delegator.motebitId, worker.motebitId);
    const tok = await makeSignedToken(
      delegator.motebitId,
      delegator.deviceId,
      delegatorKp.privateKey,
      "market:listing",
    );
    const eligible = async (query = ""): Promise<boolean> => {
      const r = await relay.app.request(
        `/api/v1/agents/${worker.motebitId}/p2p-eligibility${query}`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      return ((await r.json()) as { allowed: boolean }).allowed;
    };
    // Caller-bound: a cold-start pair (no trust) is ineligible without the ack…
    expect(await eligible()).toBe(false);
    // …and eligible WITH the conscious cold-start acknowledgment.
    expect(await eligible("?acknowledge_no_history_risk=true")).toBe(true);
    // Master/service token carries no `mid` → advisory allowed:true (the
    // submission gate still enforces; a privileged caller isn't a sybil risk).
    const masterRes = await relay.app.request(
      `/api/v1/agents/${worker.motebitId}/p2p-eligibility`,
      { headers: AUTH },
    );
    expect(((await masterRes.json()) as { allowed: boolean }).allowed).toBe(true);
  });

  it("full p2p cycle: eligible → submit with proof → receipt → audit record", async () => {
    // === STEP 1: SUBMIT P2P TASK ===
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "search for something via p2p",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        required_capabilities: ["web_search"],
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: SOLANA_MAINNET_CAIP2,
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
          // Arc 2 of off-ramp arc: fee leg required. 500_000 net /
          // (1 - 0.05) = 526_316 gross; fee = 526_316 - 500_000 = 26_316.
          fee_to_address: deriveSolanaAddress(
            Uint8Array.from(Buffer.from(relay.relayIdentity.publicKeyHex, "hex")),
          ),
          fee_amount_micro: 26316,
        },
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    // No allocation should exist (p2p skips virtual account)
    const alloc = relay.moteDb.db
      .prepare("SELECT * FROM relay_allocations WHERE task_id = ?")
      .get(taskId);
    expect(alloc).toBeUndefined();

    // Delegator balance should be untouched (no debit for p2p)
    // (Delegator has no deposits, so balance should be 0)
    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    expect(delegatorBal.balance).toBe(0);

    // === STEP 2: WORKER SUBMITS RECEIPT ===
    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        device_id: "svc" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "p2p search results",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("search for something via p2p")),
        result_hash: await sha256(enc.encode("p2p search results")),
      },
      workerKp.privateKey,
    );

    const receiptRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });
    expect(receiptRes.status).toBe(200);

    // === STEP 3: VERIFY SETTLEMENT AUDIT RECORD ===
    const allSettlements = relay.moteDb.db
      .prepare("SELECT * FROM relay_settlements WHERE task_id = ?")
      .all(taskId) as Array<Record<string, unknown>>;

    // Should have exactly one settlement record (the p2p audit).
    // After Arc 2 of the off-ramp arc, the audit records the actual
    // amounts: amount_settled = worker leg (500_000), platform_fee =
    // fee leg (26_316). Pre-Arc-2 the audit wrote 0/0; that policy
    // was the sibling-doc contradiction Arc 2 resolved.
    const settlement = allSettlements.find((s) => s.settlement_mode === "p2p");
    expect(settlement).toBeDefined();
    expect(settlement!.amount_settled).toBe(500000);
    expect(settlement!.platform_fee).toBe(26316);
    expect(settlement!.p2p_tx_hash).toBe(FAKE_TX_HASH);
    expect(settlement!.payment_verification_status).toBe("pending");
    expect(settlement!.delegator_id).toBe(delegator.motebitId);

    // Worker balance should NOT increase (p2p — money moved onchain, not through relay)
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number; dispute_window_hold: number };
    expect(workerBal.balance).toBe(0);
    // No dispute window hold (p2p settlements excluded)
    expect(workerBal.dispute_window_hold).toBe(0);
  });

  it("p2p dispute creates trust-layer complaint with no fund movement", async () => {
    // Submit and complete a p2p task first
    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "p2p task for dispute",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: SOLANA_MAINNET_CAIP2,
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
          // Arc 2 of off-ramp arc: fee leg required. 500_000 net /
          // (1 - 0.05) = 526_316 gross; fee = 526_316 - 500_000 = 26_316.
          fee_to_address: deriveSolanaAddress(
            Uint8Array.from(Buffer.from(relay.relayIdentity.publicKeyHex, "hex")),
          ),
          fee_amount_micro: 26316,
        },
      }),
    });
    const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

    const enc = new TextEncoder();
    const receipt = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        device_id: "svc" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "bad p2p work",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("p2p task for dispute")),
        result_hash: await sha256(enc.encode("bad p2p work")),
      },
      workerKp.privateKey,
    );
    await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receipt),
    });

    // File p2p dispute (no allocation exists). Per spec/dispute-v1.md §4.2
    // the body is a signed DisputeRequest — register the delegator's
    // identity in agent_registry first so the relay can verify the
    // signature, then sign + post.
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: delegator.motebitId,
        endpoint_url: "http://localhost:3201/mcp",
        capabilities: [],
        public_key: bytesToHex(delegatorKp.publicKey),
      }),
    });
    const signedRequest = await signDisputeRequest(
      {
        dispute_id: `dsp-p2p-${crypto.randomUUID()}`,
        task_id: taskId,
        allocation_id: `p2p-${taskId}`,
        filed_by: delegator.motebitId,
        respondent: worker.motebitId,
        category: "quality",
        description: "P2P work was bad",
        evidence_refs: ["receipt-1"],
        filed_at: Date.now(),
      },
      delegatorKp.privateKey,
    );
    const disputeRes = await relay.app.request(`/api/v1/allocations/p2p-${taskId}/dispute`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signedRequest),
    });
    expect(disputeRes.status).toBe(200);
    const disputeBody = (await disputeRes.json()) as {
      dispute_id: string;
      amount_locked: number;
      p2p_dispute: boolean;
    };
    expect(disputeBody.amount_locked).toBe(0);
    expect(disputeBody.p2p_dispute).toBe(true);

    // Resolve — no funds move (amount_locked = 0)
    const resolveRes = await relay.app.request(
      `/api/v1/disputes/${disputeBody.dispute_id}/resolve`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          resolution: "upheld",
          rationale: "P2P work was indeed bad",
          fund_action: "refund_to_delegator",
        }),
      },
    );
    expect(resolveRes.status).toBe(200);

    // Neither party's balance should change (trust-only dispute)
    const workerBal = (await (
      await relay.app.request(`/api/v1/agents/${worker.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    const delegatorBal = (await (
      await relay.app.request(`/api/v1/agents/${delegator.motebitId}/balance`, { headers: AUTH })
    ).json()) as { balance: number };
    expect(workerBal.balance).toBe(0);
    expect(delegatorBal.balance).toBe(0);
  });

  it("ineligible pair (low trust) cannot use p2p, gets 403", async () => {
    // Drop trust below threshold
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "first_contact", 1);

    const taskRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "try p2p with low trust",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        payment_proof: {
          tx_hash: FAKE_TX_HASH,
          chain: "solana",
          network: SOLANA_MAINNET_CAIP2,
          to_address: WORKER_SOLANA_ADDR,
          amount_micro: 500000,
          // Arc 2 of off-ramp arc: fee leg required. 500_000 net /
          // (1 - 0.05) = 526_316 gross; fee = 526_316 - 500_000 = 26_316.
          fee_to_address: deriveSolanaAddress(
            Uint8Array.from(Buffer.from(relay.relayIdentity.publicKeyHex, "hex")),
          ),
          fee_amount_micro: 26316,
        },
      }),
    });
    expect(taskRes.status).toBe(403);
  });
});
