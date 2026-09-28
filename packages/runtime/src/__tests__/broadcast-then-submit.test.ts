/**
 * #885 — a payment that may have left the wallet is never followed by a
 * fresh broadcast for the same intent.
 *
 * Relay-mediated P2P delegation broadcasts the delegator's atomic payment
 * (worker leg + fee leg, one tx), then submits the task with that proof.
 * Two windows used to lose the money fact:
 *
 *   1. Broadcast, then `POST /agent/:id/task` fails (503, network). The
 *      result carried no settled payment and nothing was recorded, so the
 *      next hire broadcast again.
 *   2. The builder throws after the transaction landed (lost confirmation).
 *      The throw read as `payment_broadcast_failed` — "no funds moved" —
 *      so the next hire broadcast again.
 *
 * Law: the payment is recorded at broadcast, before the submit; a failed
 * submit is retried with the SAME proof; a submit that never succeeds
 * leaves the payment outstanding (refusing a re-hire in this session and
 * every later one); a builder throw is resolved against the chain, and
 * "unknown" is recorded and never retried.
 *
 * The fakes: a relay stub whose submit answers from a script, a builder
 * that can throw after "landing", and a confirmer that models the chain
 * (exact multi-leg match, own-signature exclusion). The multi-leg matcher
 * itself is tested in @motebit/wallet-solana.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";
import type {
  OutgoingTransferLookup,
  OutgoingTransferQuery,
  SendUsdcArgs,
  SolanaRpcAdapter,
} from "@motebit/wallet-solana";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import {
  InMemoryPaidIntentStore,
  PaidIntentLedger,
  resolveAndSubmitP2pDelegation,
  retrieveDelegationResult,
  selectAndRunDelegation,
  type ConfirmP2pPayment,
  type P2pPaymentConfirmation,
} from "../index";

const RELAY = "https://mock-relay.test";
const ME = "alice-885";
const WORKER = "bob-worker-885";
const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";
const PINNED_HEX = "07".repeat(32);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type SubmitAnswer = "201" | "503" | "throw" | "400" | { gate: Promise<void> };

interface RelayStub {
  submits: Array<{ txHash: string; idempotencyKey: string | null }>;
}

/**
 * The relay: discovery + eligibility + listing answer normally; each POST
 * of a task takes the next scripted answer (the last one repeats); an
 * admitted task delivers its receipt on the first poll.
 */
function relay(script: SubmitAnswer[]): RelayStub {
  const stub: RelayStub = { submits: [] };
  const pricing = [{ capability: "web_search", unit_cost: 0.25 }];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/v1/agents/discover")) {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            settlement_address: WORKER_ADDR,
            settlement_modes: "relay,p2p",
            pricing,
          },
        ],
      });
    }
    if (url.includes("/p2p-eligibility")) return json(200, { allowed: true });
    if (url.includes(`/api/v1/agents/${WORKER}/listing`)) return json(200, { pricing });
    if (method === "POST" && url.endsWith(`/agent/${ME}/task`)) {
      const body = JSON.parse(init!.body as string) as { payment_proof: P2pPaymentProof };
      const headers = init!.headers as Record<string, string>;
      stub.submits.push({
        txHash: body.payment_proof.tx_hash,
        idempotencyKey: headers["Idempotency-Key"] ?? null,
      });
      const answer = script[Math.min(stub.submits.length - 1, script.length - 1)]!;
      if (typeof answer === "object") {
        await answer.gate;
        return json(201, { task_id: `task-${body.payment_proof.tx_hash}` });
      }
      if (answer === "throw") throw new TypeError("fetch failed: ECONNRESET");
      if (answer === "503") return json(503, { error: "Service Unavailable" });
      if (answer === "400") {
        return json(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH", error: "fee mismatch" });
      }
      return json(201, { task_id: `task-${body.payment_proof.tx_hash}` });
    }
    const m = /\/task\/(task-[^/]+)$/.exec(url);
    if (method === "GET" && m) {
      const id = m[1]!;
      return json(200, {
        task: { status: "completed" },
        receipt: {
          task_id: id,
          relay_task_id: id,
          motebit_id: WORKER,
          device_id: "d",
          submitted_at: 1,
          completed_at: 2,
          status: "completed",
          result: `R-${id}`,
          tools_used: [],
          memories_formed: 0,
          prompt_hash: "a".repeat(64),
          result_hash: "b".repeat(64),
          suite: "motebit-jcs-ed25519-b64-v1",
          signature: "s",
        },
      });
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  return stub;
}

/** A chain the fake wallet writes to. A confirmer reads it (read-only). */
interface Chain {
  txs: Array<{ sig: string; legs: Array<{ to: string; amount: number }> }>;
}

let sigN = 0;
function legsOf(req: SovereignP2pPaymentRequest): Array<{ to: string; amount: number }> {
  return [
    { to: req.workerAddress, amount: req.amountMicro },
    { to: req.treasuryAddress, amount: req.feeAmountMicro },
  ];
}
function proofFor(req: SovereignP2pPaymentRequest, sig: string): P2pPaymentProof {
  return {
    tx_hash: sig,
    chain: "solana",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    to_address: req.workerAddress,
    amount_micro: req.amountMicro,
    fee_to_address: req.treasuryAddress,
    fee_amount_micro: req.feeAmountMicro,
  };
}

/**
 * The wallet's builder. `mode` decides each call: `ok` lands and returns;
 * `lost` lands and then throws (the lost confirmation); `dead` throws
 * without landing.
 */
function wallet(chain: Chain, modes: Array<"ok" | "lost" | "dead">) {
  let call = 0;
  return vi.fn(async (req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => {
    const mode = modes[Math.min(call++, modes.length - 1)]!;
    if (mode === "dead") throw new Error("P2P payment broadcast failed (legs: rpc down)");
    const sig = `sig${++sigN}`;
    chain.txs.push({ sig, legs: legsOf(req) });
    if (mode === "lost") {
      throw new Error("P2P payment broadcast failed (legs: was not confirmed in 30.00 seconds)");
    }
    return proofFor(req, sig);
  });
}

/** The chain-reading confirmer: exact multi-leg match, own signatures excluded. */
function confirmer(
  chain: Chain,
  override?: (q: Parameters<ConfirmP2pPayment>[0]) => P2pPaymentConfirmation | null,
) {
  return vi.fn<ConfirmP2pPayment>(async (q) => {
    const forced = override?.(q);
    if (forced != null) return forced;
    const want = legsOf(q.request);
    const exclude = new Set(q.excludeSignatures ?? []);
    const matches = chain.txs.filter(
      (t) =>
        !exclude.has(t.sig) &&
        t.legs.length === want.length &&
        want.every((w) => t.legs.some((l) => l.to === w.to && l.amount === w.amount)),
    );
    if (matches.length === 1)
      return { status: "landed", proof: proofFor(q.request, matches[0]!.sig) };
    if (matches.length > 1) return { status: "unknown", reason: "ambiguous" };
    return { status: "absent" };
  });
}

const noWait = { sleep: vi.fn(async () => {}) };

function hire(
  ledger: PaidIntentLedger,
  build: (r: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>,
  extra: Record<string, unknown> = {},
) {
  return resolveAndSubmitP2pDelegation({
    motebitId: ME,
    syncUrl: RELAY,
    authToken: async () => "t",
    prompt: "research X",
    capability: "web_search",
    relayPublicKeyHex: PINNED_HEX,
    buildP2pPayment: build,
    acknowledgeNoHistoryRisk: true,
    paidIntentLedger: ledger,
    submitRetry: { sleep: noWait.sleep },
    sleep: noWait.sleep,
    logger: { warn: () => {} },
    ...extra,
  });
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.useRealTimers();
});

describe("#885 window 1 — broadcast, then the submit fails", () => {
  it("submit 503 once → the SAME proof is resubmitted, one broadcast, delivered, ledger clean", async () => {
    const r = relay(["503", "201"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["ok"]);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build);
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(r.submits).toHaveLength(2);
    // Same payment, same idempotency key — never a second payment.
    const [a, b] = r.submits;
    expect(b!.txHash).toBe(a!.txHash);
    expect(a!.idempotencyKey).toBe(a!.txHash);
    expect(b!.idempotencyKey).toBe(a!.txHash);
    // Admission handed the broadcast entry to the task; delivery resolved it.
    expect(ledger.outstanding()).toEqual([]);
    expect(ledger.inFlight()).toEqual([]);
  });

  it("the submit throws (network) once → resubmitted with the same proof, delivered", async () => {
    const r = relay(["throw", "201"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["ok"]);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build);
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(new Set(r.submits.map((s) => s.txHash)).size).toBe(1);
    expect(r.submits).toHaveLength(2);
  });

  it("submit failing persistently → one broadcast, 'paid, not admitted', outstanding; re-hire refused in this session AND a new one", async () => {
    const r = relay(["503"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["ok"]);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");

    const first = await hire(ledger, build);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe("payment_not_admitted");
      expect(first.error.settledPayment?.txHash).toBe(chain.txs[0]!.sig);
      expect(first.error.settledPayment?.taskId).toBe(`p2p-unadmitted:${chain.txs[0]!.sig}`);
      expect(first.error.submitError?.code).toBe("unknown");
      expect(first.error.message).toMatch(/no second payment was made/);
    }
    // One attempt + three retries, every one the same proof.
    expect(r.submits).toHaveLength(4);
    expect(new Set(r.submits.map((s) => s.txHash)).size).toBe(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(ledger.outstanding().map((e) => e.taskId)).toEqual([
      `p2p-unadmitted:${chain.txs[0]!.sig}`,
    ]);

    // Same session: refused before the builder runs.
    const again = await hire(ledger, build);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("intent_already_paid");
      expect(again.error.message).toMatch(/never admitted/);
    }
    // A new session on the same store: refused too.
    const next = new PaidIntentLedger(store, ME, "s2");
    const later = await hire(next, build);
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.code).toBe("intent_already_paid");
    expect(build).toHaveBeenCalledTimes(1);
    expect(r.submits).toHaveLength(4);
  });

  it("a 400 rejection after broadcast is not retried, and the payment is still outstanding", async () => {
    const r = relay(["400"]);
    const build = wallet({ txs: [] }, ["ok"]);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("payment_not_admitted");
      expect(result.error.submitError?.code).toBe("malformed_request");
    }
    expect(r.submits).toHaveLength(1);
    expect(ledger.outstandingCount).toBe(1);
  });

  it("the payment is on record BEFORE the submit: a process that dies mid-submit leaves it refusing a re-hire", async () => {
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    relay([{ gate }]);
    const build = wallet({ txs: [] }, ["ok"]);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    const inFlight = hire(ledger, build);
    // Let the hire reach the (blocked) submit.
    for (let i = 0; i < 20 && build.mock.calls.length === 0; i++) await Promise.resolve();
    await new Promise((res) => setTimeout(res, 10));
    expect(build).toHaveBeenCalledTimes(1);
    // Another session reads the store while the submit is still in the air.
    const other = new PaidIntentLedger(store, ME, "s-other");
    expect(other.check(WORKER, "web_search")).toMatchObject({ locked: true, scope: "pair" });
    // ...while the paying session's own in-flight entry locks nothing for it.
    expect(ledger.check(WORKER, "web_search")).toEqual({ locked: false });
    open();
    const done = await inFlight;
    expect(done.ok).toBe(true);
    expect(other.outstanding()).toEqual([]);
  });

  it("selectAndRunDelegation never falls back to relay-mode after 'paid, not admitted'", async () => {
    const r = relay(["503"]);
    const build = wallet({ txs: [] }, ["ok"]);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    vi.useFakeTimers();
    const p = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      prompt: "research X",
      requiredCapabilities: ["web_search"],
      relayPublicKey: PINNED_HEX,
      buildP2pPayment: build,
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: ledger,
      logger: { warn: () => {} },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_not_admitted");
    // Every POST carried the proof — no proofless relay-mode submission.
    expect(r.submits.every((s) => s.txHash.startsWith("sig"))).toBe(true);
    expect(r.submits).toHaveLength(4);
  });
});

describe("#885 window 2 — the builder throws", () => {
  it("throws after landing → confirmed onchain, submitted with THAT tx, one broadcast, delivered", async () => {
    const r = relay(["201"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["lost"]);
    const confirm = confirmer(chain);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(result.ok).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(chain.txs).toHaveLength(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([chain.txs[0]!.sig]);
    if (result.ok) expect(result.settlement?.txHash).toBe(chain.txs[0]!.sig);
  });

  it("status unknown → stop: no submit, no second broadcast, recorded; re-hire refused here and in a new session", async () => {
    const r = relay(["201"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["lost"]);
    const confirm = confirmer(chain, () => ({
      status: "unknown",
      reason: "429 Too Many Requests",
    }));
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");

    const result = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("payment_status_unknown");
      expect(result.error.unconfirmedPayment?.reason).toMatch(/429/);
      expect(result.error.unconfirmedPayment?.ledgerId).toMatch(/^p2p-unconfirmed:/);
      expect(result.error.settledPayment).toBeUndefined();
    }
    expect(r.submits).toHaveLength(0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(ledger.outstandingCount).toBe(1);

    const again = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("intent_already_paid");
    const later = await hire(new PaidIntentLedger(store, ME, "s2"), build, {
      confirmP2pPayment: confirm,
    });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.code).toBe("intent_already_paid");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("no confirmer wired → unknown (fail-closed), recorded, never re-broadcast", async () => {
    relay(["201"]);
    const build = wallet({ txs: [] }, ["lost"]);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_status_unknown");
    const again = await hire(ledger, build);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("intent_already_paid");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("pending, then absent after the landing horizon → payment_broadcast_failed, and a later hire may pay", async () => {
    const r = relay(["201"]);
    const chain: Chain = { txs: [] };
    const build = wallet(chain, ["dead", "ok"]);
    let looks = 0;
    const confirm = confirmer(chain, (q) =>
      looks++ === 0 ? { status: "pending", recheckAtMs: q.failedAtMs + 150_000 } : null,
    );
    const sleep = vi.fn(async () => {});
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build, { confirmP2pPayment: confirm, sleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_broadcast_failed");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(ledger.outstandingCount).toBe(0);
    expect(r.submits).toHaveLength(0);
    // Absence is authoritative: nothing moved, so a new hire may pay.
    const next = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(next.ok).toBe(true);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("still pending when the wait ends → unknown, never read as absent", async () => {
    relay(["201"]);
    const build = wallet({ txs: [] }, ["dead"]);
    const confirm = confirmer({ txs: [] }, (q) => ({
      status: "pending",
      recheckAtMs: q.failedAtMs + 10_000_000,
    }));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_status_unknown");
  });

  it("a 'landed' proof that does not pay the requested legs is unknown, never submitted", async () => {
    const r = relay(["201"]);
    const build = wallet({ txs: [] }, ["dead"]);
    const confirm = confirmer({ txs: [] }, (q) => ({
      status: "landed",
      proof: { ...proofFor(q.request, "sigElsewhere"), to_address: "SomeoneElse" },
    }));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const result = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_status_unknown");
    expect(r.submits).toHaveLength(0);
  });

  it("an earlier payment to the same worker at the same price is excluded — never mistaken for the lost one", async () => {
    relay(["201"]);
    const chain: Chain = { txs: [] };
    // Hire 1 pays and delivers (sig A). Hire 2's build dies WITHOUT landing.
    const build = wallet(chain, ["ok", "dead"]);
    const confirm = confirmer(chain);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const first = await hire(ledger, build, { confirmP2pPayment: confirm });
    expect(first.ok).toBe(true);
    const second = await hire(ledger, build, { confirmP2pPayment: confirm });
    // Without the exclusion, sig A would read as hire 2 having landed.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("payment_broadcast_failed");
    expect(confirm.mock.calls[0]![0].excludeSignatures).toContain(chain.txs[0]!.sig);
  });
});

describe("#885 — a payment with no relay task is answered locally", () => {
  it("retrieveDelegationResult never reads the relay for a p2p-unadmitted / p2p-unconfirmed id", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const base = { motebitId: ME, syncUrl: RELAY, authToken: async () => "t" };
    await expect(
      retrieveDelegationResult({ ...base, taskId: "p2p-unadmitted:sig9" }),
    ).resolves.toEqual({
      status: "not_admitted",
      taskId: "p2p-unadmitted:sig9",
      paymentLanded: true,
    });
    await expect(
      retrieveDelegationResult({ ...base, taskId: "p2p-unconfirmed:abc-def" }),
    ).resolves.toMatchObject({ status: "not_admitted", paymentLanded: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Composition: the runtime's own paid doors reach the REAL rail's multi-leg
// confirmation (docs/doctrine/composition-preserves-enforcement.md). A
// confirmer defined in wallet-solana but never wired would leave every lost
// send as "unknown" — safe, but the landed payment would be stranded.
// ---------------------------------------------------------------------------

describe("#885 composition — the runtime wires the real rail's confirmP2pPayment", () => {
  /** A Solana adapter whose atomic batch LANDS and then throws (lost confirmation). */
  async function lostSendRuntime() {
    const landed: Array<{ sig: string; legs: SendUsdcArgs[] }> = [];
    const sendUsdcBatch = vi.fn(async (items: readonly SendUsdcArgs[]) => {
      landed.push({ sig: `landedSig${landed.length + 1}`, legs: [...items] });
      throw new Error("was not confirmed in 30.00 seconds");
    });
    const adapter: SolanaRpcAdapter = {
      ownAddress: "Delegator1111111111111111111111111111111111",
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc: vi.fn(),
      sendUsdcBatch: sendUsdcBatch as unknown as SolanaRpcAdapter["sendUsdcBatch"],
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockResolvedValue(true),
      findOutgoingTransfer: vi.fn((q: OutgoingTransferQuery): Promise<OutgoingTransferLookup> => {
        const want = [
          { toAddress: q.toAddress, microAmount: q.microAmount },
          ...(q.alsoLegs ?? []),
        ];
        const hits = landed.filter(
          (t) =>
            !(q.excludeSignatures ?? []).includes(t.sig) &&
            t.legs.length === want.length &&
            want.every((w) =>
              t.legs.some((l) => l.toAddress === w.toAddress && l.microAmount === w.microAmount),
            ),
        );
        return Promise.resolve(
          hits.length === 1
            ? { status: "found", signature: hits[0]!.sig }
            : { status: "not_found" },
        );
      }),
    };
    const { SolanaWalletRail } = await import("@motebit/wallet-solana");
    const runtime = new MotebitRuntime(
      { motebitId: ME, tickRateHz: 0, solanaWallet: new SolanaWalletRail(adapter) },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    return { runtime, sendUsdcBatch, landed };
  }

  it("invokeCapability (the user-tap door): a lost send that landed is submitted with that tx — one broadcast", async () => {
    const r = relay(["201"]);
    const { runtime, sendUsdcBatch, landed } = await lostSendRuntime();
    runtime.enableInvokeCapability({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
    });
    vi.useFakeTimers();
    const chunks: Array<{ type: string; code?: string }> = [];
    const run = (async () => {
      for await (const c of runtime.invokeCapability("web_search", "research X", {
        acknowledgeNoHistoryRisk: true,
      })) {
        chunks.push(c as { type: string; code?: string });
      }
    })();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(chunks.find((c) => c.type === "invoke_error")).toBeUndefined();
    expect(sendUsdcBatch).toHaveBeenCalledTimes(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([landed[0]!.sig]);
  });

  it("delegate_to_agent (the AI-loop door): same — the landed tx is submitted, never a second broadcast", async () => {
    const r = relay(["201"]);
    const { runtime, sendUsdcBatch, landed } = await lostSendRuntime();
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
      acknowledgeNoHistoryRisk: true,
    });
    vi.useFakeTimers();
    const pending = runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(sendUsdcBatch).toHaveBeenCalledTimes(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([landed[0]!.sig]);
  });
});
