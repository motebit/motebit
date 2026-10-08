/**
 * #885 — a payment that may have left the wallet is never followed by a
 * fresh broadcast for the same intent, and a hire's payment is always ITS
 * OWN transaction.
 *
 * Relay-mediated P2P delegation pays the worker + fee in one onchain tx,
 * then submits the task with that proof. The law, as built:
 *
 *   1. The builder SIGNS, reports the signature (`beforeBroadcast`), the
 *      hire RECORDS `p2p-payment:<sig>` in the ledger, and only then is the
 *      tx sent. A record that cannot be written stops the send.
 *   2. A failed submit is retried with the SAME proof; one that never
 *      succeeds leaves the payment outstanding, refusing a re-hire here and
 *      in every later session. The terminal wording distinguishes a relay
 *      refusal from an admission that is merely unconfirmed.
 *   3. A builder throw is resolved by asking the chain about THIS hire's own
 *      signatures — never by matching transfers. landed ⇒ proceed with that
 *      tx; dead (expired / failed) ⇒ `payment_broadcast_failed`; anything
 *      else ⇒ `payment_status_unknown`, recorded, never sent again.
 *
 * The chain here is modelled under the REAL `SolanaWalletRail` (fake RPC
 * adapter), so the runtime's own-signature binding and the rail's status
 * read are exercised together. The adapter also implements the legacy
 * leg-matching `findOutgoingTransfer`, so a regression back to "confirm by
 * legs" has something to (wrongly) match.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";
import type {
  BroadcastHooks,
  OutgoingTransferLookup,
  OutgoingTransferQuery,
  SendUsdcArgs,
  SignedTransactionRef,
  SolanaRpcAdapter,
} from "@motebit/wallet-solana";
import { SolanaWalletRail } from "@motebit/wallet-solana";
import {
  InMemoryPaidIntentStore,
  MotebitRuntime,
  NullRenderer,
  PaidIntentLedger,
  createInMemoryStorage,
  p2pPaymentConfirmerOf,
  resolveAndSubmitP2pDelegation,
  retrieveDelegationResult,
  selectAndRunDelegation,
} from "../index";
import {
  SIGNING_PINNED_HEX,
  advanceAfterRealAsync,
  isRelayMetadataUrl,
  relayMetadataResponse,
} from "./helpers/signed-relay-metadata.js";
// delegate_to_agent is R4_MONEY: the registry refuses it without the runtime's
// money capability, so these handler tests drive the handler directly.
import { runToolHandler } from "./helpers/money-tool-handler.js";

const RELAY = "https://mock-relay.test";
const ME = "alice-885";
const WORKER = "bob-worker-885";
const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";
const PINNED_HEX = SIGNING_PINNED_HEX;
const OWN = "Delegator1111111111111111111111111111111111";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// The relay: discovery/eligibility/listing normal; task POST keyed by the
// Idempotency-Key like the real relay (a known key REPLAYS its task — which
// is exactly how one hire submitting another's tx hijacks its task); the
// receipt answers "answer to: <prompt>".
// ---------------------------------------------------------------------------

type SubmitAnswer =
  "201" | "503" | "throw" | "400" | "409" | "409replayed" | "409admitted" | "409admittedMine";

interface RelayStub {
  submits: Array<{ txHash: string; prompt: string }>;
  /** txs whose submissions always get this answer (default "201"). */
  failing: Map<string, SubmitAnswer>;
}

function relay(script: SubmitAnswer[] = ["201"]): RelayStub {
  const stub: RelayStub = { submits: [], failing: new Map() };
  const byKey = new Map<string, string>();
  const prompts = new Map<string, string>();
  const pricing = [{ capability: "web_search", unit_cost: 0.25 }];
  let n = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
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
      const body = JSON.parse(init!.body as string) as {
        prompt: string;
        payment_proof: P2pPaymentProof;
      };
      const key = (init!.headers as Record<string, string>)["Idempotency-Key"]!;
      stub.submits.push({ txHash: body.payment_proof.tx_hash, prompt: body.prompt });
      const answer =
        stub.failing.get(key) ?? script[Math.min(stub.submits.length - 1, script.length - 1)]!;
      if (answer === "throw") throw new TypeError("fetch failed: ECONNRESET");
      if (answer === "503") return json(503, { error: "Service Unavailable" });
      if (answer === "409") {
        return json(409, { code: "TASK_CONFLICT", error: "already being processed" });
      }
      if (answer === "409replayed") {
        return json(409, {
          code: "TASK_P2P_PROOF_REPLAYED",
          error: "This payment proof (tx_hash) has already settled a task",
        });
      }
      if (answer === "409admitted") {
        return json(409, {
          code: "TASK_P2P_PROOF_ALREADY_ADMITTED",
          error: "This payment proof is already bound to an admitted task",
        });
      }
      if (answer === "409admittedMine") {
        // #918: the relay names the bound task only to its verified submitter.
        prompts.set("task-918", body.prompt);
        return json(409, {
          code: "TASK_P2P_PROOF_ALREADY_ADMITTED",
          error: "This payment proof (tx_hash) already funds task task-918",
          task_id: "task-918",
        });
      }
      if (answer === "400") {
        return json(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH", error: "fee mismatch" });
      }
      let taskId = byKey.get(key);
      if (taskId == null) {
        taskId = `task-${++n}`;
        byKey.set(key, taskId);
        prompts.set(taskId, body.prompt);
      }
      return json(201, { task_id: taskId });
    }
    const m = /\/task\/(task-\d+)$/.exec(url);
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
          result: `answer to: ${prompts.get(id)}`,
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

// ---------------------------------------------------------------------------
// The chain + a fake RPC adapter under the real SolanaWalletRail.
// ---------------------------------------------------------------------------

/**
 * How one `sendUsdcBatch` call behaves. Every SIGNING attempt reports its
 * own signature through the hook (like the real adapter), so a call that
 * re-signs reports two.
 *   ok      — lands, returns
 *   lost    — lands, then throws (the lost confirmation)
 *   dead    — never lands (its blockhash expires), throws
 *   late    — throws; lands only after the throw (first status read: pending)
 *   hold    — lands, then waits for `release()` before returning
 *   presign — throws before signing (nothing reported, nothing sent)
 *   resignBothLand  — signs A, A lands but the confirm is "lost", re-signs B,
 *                     B lands, returns B: the pre-fix adapter's double-pay
 *   resignFirstDead — signs A, A never lands, re-signs B, B lands, returns B
 */
type Behaviour =
  "ok" | "lost" | "dead" | "late" | "hold" | "presign" | "resignBothLand" | "resignFirstDead";

class Chain {
  readonly txs = new Map<string, { legs: SendUsdcArgs[]; state: "landed" | "pending" | "dead" }>();
  private n = 0;
  private calls = 0;
  private releaseHold: (() => void) | null = null;
  /** Every signed transaction, in signing order. */
  readonly sigs: string[] = [];
  /** Called between signing and sending — tests probe the ledger here. */
  onSigned: ((sig: string) => void) | null = null;

  constructor(
    private readonly script: Behaviour[],
    /** Does the adapter report each signed tx before sending (and say so)? */
    private readonly honorsHooks = true,
  ) {}

  release(): void {
    this.releaseHold?.();
  }

  private async sign(hooks: BroadcastHooks | undefined): Promise<string> {
    const sig = `sig${++this.n}`;
    this.sigs.push(sig);
    if (this.honorsHooks) {
      await hooks?.beforeBroadcast?.({ signature: sig, lastValidBlockHeight: 100 });
    }
    this.onSigned?.(sig);
    return sig;
  }

  adapter(): SolanaRpcAdapter {
    const legsMatch = (legs: SendUsdcArgs[], q: OutgoingTransferQuery) =>
      legs.some((l) => l.toAddress === q.toAddress && l.microAmount === q.microAmount);
    return {
      ...(this.honorsHooks ? { honorsBroadcastHooks: true } : {}),
      ownAddress: OWN,
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      sendUsdc: vi.fn(),
      sendUsdcBatch: async (items: readonly SendUsdcArgs[], hooks?: BroadcastHooks) => {
        const behaviour = this.script[Math.min(this.calls++, this.script.length - 1)]!;
        if (behaviour === "presign") throw new Error("RPC down before signing");
        const legs = [...items];
        const ok = (sig: string) =>
          legs.map(() => ({ ok: true as const, signature: sig, slot: 1, reason: null }));
        const sig = await this.sign(hooks);
        switch (behaviour) {
          case "ok":
            this.txs.set(sig, { legs, state: "landed" });
            return ok(sig);
          case "lost":
            this.txs.set(sig, { legs, state: "landed" });
            throw new Error("was not confirmed in 30.00 seconds");
          case "dead":
            this.txs.set(sig, { legs, state: "dead" });
            throw new Error("was not confirmed in 30.00 seconds");
          case "late":
            this.txs.set(sig, { legs, state: "pending" });
            throw new Error("was not confirmed in 30.00 seconds");
          case "hold":
            this.txs.set(sig, { legs, state: "landed" });
            await new Promise<void>((res) => (this.releaseHold = res));
            return ok(sig);
          case "resignBothLand":
          case "resignFirstDead": {
            this.txs.set(sig, { legs, state: behaviour === "resignBothLand" ? "landed" : "dead" });
            const second = await this.sign(hooks);
            this.txs.set(second, { legs, state: "landed" });
            return ok(second);
          }
        }
      },
      getTransaction: async (sig: string) => {
        const tx = this.txs.get(sig);
        if (tx == null || tx.state !== "landed") return { status: "not_found" as const };
        return {
          status: "confirmed" as const,
          from: OWN,
          transfers: tx.legs.map((l) => ({ to: l.toAddress, amountMicro: l.microAmount })),
          slot: 1,
          asset: "USDC",
        };
      },
      getSignatureOutcome: async (ref: SignedTransactionRef) => {
        const tx = this.txs.get(ref.signature);
        if (tx == null || tx.state === "dead") return { status: "expired" as const };
        if (tx.state === "pending") {
          tx.state = "landed"; // lands after the first look
          return { status: "pending" as const };
        }
        return { status: "landed" as const, slot: 1 };
      },
      // Legacy leg matching: present so a regression to "confirm by legs"
      // finds another hire's identical payment.
      findOutgoingTransfer: async (q: OutgoingTransferQuery): Promise<OutgoingTransferLookup> => {
        const hits = [...this.txs.entries()].filter(
          ([s, t]) =>
            t.state === "landed" &&
            legsMatch(t.legs, q) &&
            !(q.excludeSignatures ?? []).includes(s),
        );
        return hits.length === 1
          ? { status: "found", signature: hits[0]![0] }
          : { status: "not_found" };
      },
      isReachable: vi.fn().mockResolvedValue(true),
    };
  }
}

function railFor(chain: Chain) {
  const rail = new SolanaWalletRail(chain.adapter(), { now: () => 0 });
  const build = vi.fn(
    (req: SovereignP2pPaymentRequest, hooks?: BroadcastHooks): Promise<P2pPaymentProof> =>
      rail.buildP2pPayment(req, hooks),
  );
  return { rail, build, confirm: p2pPaymentConfirmerOf(rail) };
}

const noWait = vi.fn(async () => {});

function hire(
  ledger: PaidIntentLedger | undefined,
  pay: ReturnType<typeof railFor>,
  prompt: string,
  extra: Record<string, unknown> = {},
) {
  return resolveAndSubmitP2pDelegation({
    motebitId: ME,
    syncUrl: RELAY,
    authToken: async () => "t",
    prompt,
    capability: "web_search",
    relayPublicKeyHex: PINNED_HEX,
    buildP2pPayment: pay.build,
    ...(pay.confirm != null ? { confirmP2pPayment: pay.confirm } : {}),
    acknowledgeNoHistoryRisk: true,
    ...(ledger != null ? { paidIntentLedger: ledger } : {}),
    submitRetry: { sleep: noWait },
    sleep: noWait,
    logger: { warn: () => {} },
    ...extra,
  });
}

const receiptText = (r: Awaited<ReturnType<typeof hire>>): string | null =>
  r.ok ? (r.receipt.result ?? null) : null;

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.useRealTimers();
});

const settle = () => new Promise((res) => setTimeout(res, 5));

// ---------------------------------------------------------------------------
// The reviewer's probes (round 2)
// ---------------------------------------------------------------------------

describe("#885 — a hire's payment is its OWN transaction (reviewer probes)", () => {
  it("concurrent same-pair hires: B's landed tx is never adopted by A; each gets its own outcome", async () => {
    const r = relay();
    // Call 1 = hire B (lands, holds before returning); call 2 = hire A (dies).
    const chain = new Chain(["hold", "dead"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");

    const b = hire(ledger, pay, "prompt B");
    await settle(); // txB has landed; B's builder is still awaiting
    const a = await hire(ledger, pay, "prompt A");
    chain.release();
    const bResult = await b;

    const [txB, txA] = chain.sigs;
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("payment_broadcast_failed"); // its OWN tx died
    expect(receiptText(bResult)).toBe("answer to: prompt B");
    if (bResult.ok) expect(bResult.settlement?.txHash).toBe(txB);
    // Nothing was ever submitted under A's name with B's payment.
    expect(r.submits).toEqual([{ txHash: txB, prompt: "prompt B" }]);
    expect(txA).toBeDefined();
    // txA is dead: its entry is voided, so no session reads it as owed.
    expect(new PaidIntentLedger(store, ME, "later").outstanding()).toEqual([]);
  });

  it("lost-record variant: A's own tx lands AFTER its throw ⇒ A proceeds with txA, and txA is on record", async () => {
    const r = relay();
    const chain = new Chain(["hold", "late"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");

    const b = hire(ledger, pay, "prompt B");
    await settle();
    // A's submission is refused by the relay, so its entry must stay on record.
    r.failing.set("sig2", "400");
    const a = await hire(ledger, pay, "prompt A");
    chain.release();
    const bResult = await b;

    const [, txA] = chain.sigs;
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.error.code).toBe("payment_not_admitted");
      expect(a.error.settledPayment?.txHash).toBe(txA); // its own, never txB
    }
    expect(receiptText(bResult)).toBe("answer to: prompt B");
    expect(r.submits.filter((s) => s.prompt === "prompt A").map((s) => s.txHash)).toEqual([txA]);
    expect(new PaidIntentLedger(store, ME, "later").outstanding().map((e) => e.txHash)).toEqual([
      txA,
    ]);
  });

  it("sequential variant: B pays and delivers during A's pending wait ⇒ A never adopts txB", async () => {
    const r = relay();
    // Call 1 = A (its tx never lands: pending, then expires); call 2 = B (ok).
    const chain = new Chain(["late", "ok"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    let bResult: Awaited<ReturnType<typeof hire>> | null = null;
    const sleep = vi.fn(async () => {
      if (bResult == null) {
        // While A waits: B runs a whole hire; A's tx then expires unsent.
        bResult = await hire(ledger, pay, "prompt B");
        chain.txs.get(chain.sigs[0]!)!.state = "dead";
      }
    });
    const a = await hire(ledger, pay, "prompt A", { sleep });

    const [txA, txB] = chain.sigs;
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("payment_broadcast_failed");
    expect(receiptText(bResult!)).toBe("answer to: prompt B");
    expect(r.submits).toEqual([{ txHash: txB, prompt: "prompt B" }]);
    expect(txA).not.toBe(txB);
    expect(new PaidIntentLedger(store, ME, "later").outstanding()).toEqual([]);
  });

  it("the payment is on record BEFORE it is sent (another session already refuses the pair)", async () => {
    relay();
    const chain = new Chain(["ok"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    const seenAtSend: boolean[] = [];
    chain.onSigned = () => {
      seenAtSend.push(new PaidIntentLedger(store, ME, "other").check(WORKER, "web_search").locked);
    };
    const r = await hire(ledger, pay, "research X");
    expect(r.ok).toBe(true);
    expect(seenAtSend).toEqual([true]);
  });

  it("a record that cannot be written stops the send — nothing moves", async () => {
    relay();
    const chain = new Chain(["ok"]);
    const pay = railFor(chain);
    class Busy extends InMemoryPaidIntentStore {
      override record(): void {
        throw new Error("SQLITE_BUSY");
      }
    }
    const ledger = new PaidIntentLedger(new Busy(), ME, "s1");
    const r = await hire(ledger, pay, "research X");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("payment_broadcast_failed");
      expect(r.error.message).toMatch(/could not be recorded/);
    }
    expect(chain.txs.size).toBe(0);
  });

  it("a throw before signing ⇒ nothing was sent, said so", async () => {
    const r = relay();
    const pay = railFor(new Chain(["presign"]));
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_broadcast_failed");
      expect(res.error.message).toMatch(/before any transaction was signed/);
    }
    expect(r.submits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Builder throws — own-signature confirmation
// ---------------------------------------------------------------------------

describe("#885 — the builder throws", () => {
  it("own tx landed ⇒ submitted with THAT tx, one broadcast, delivered", async () => {
    const r = relay();
    const chain = new Chain(["lost"]);
    const pay = railFor(chain);
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const res = await hire(ledger, pay, "research X");
    expect(res.ok).toBe(true);
    expect(pay.build).toHaveBeenCalledTimes(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([chain.sigs[0]]);
    expect(ledger.outstanding()).toEqual([]);
  });

  it("status unknown ⇒ no submit, no second broadcast, recorded; refused here and in a new session", async () => {
    const r = relay();
    const chain = new Chain(["lost"]);
    const pay = railFor(chain);
    const unknownConfirm = vi.fn(async () => ({ status: "unknown" as const, reason: "429" }));
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    const res = await hire(ledger, pay, "x", { confirmP2pPayment: unknownConfirm });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_status_unknown");
      expect(res.error.unconfirmedPayment?.ledgerId).toBe(`p2p-payment:${chain.sigs[0]}`);
    }
    expect(r.submits).toHaveLength(0);
    const again = await hire(ledger, pay, "x", { confirmP2pPayment: unknownConfirm });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("intent_already_paid");
    const later = await hire(new PaidIntentLedger(store, ME, "s2"), pay, "x");
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.code).toBe("intent_already_paid");
    expect(pay.build).toHaveBeenCalledTimes(1);
  });

  it("a rail without a confirmer ⇒ unknown (fail-closed), recorded, never re-sent", async () => {
    relay();
    const pay = railFor(new Chain(["lost"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const noConfirm = { ...pay, confirm: undefined };
    const res = await resolveAndSubmitP2pDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      prompt: "x",
      capability: "web_search",
      relayPublicKeyHex: PINNED_HEX,
      buildP2pPayment: noConfirm.build,
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: ledger,
      logger: { warn: () => {} },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_status_unknown");
    expect(ledger.outstandingCount).toBe(1);
  });

  it("sticky pending: once a look SAW the tx in a block, a later 'absent' is never believed ⇒ unknown, kept on record", async () => {
    const r = relay();
    const pay = railFor(new Chain(["dead"]));
    let look = 0;
    const flipFlop = vi.fn(async () =>
      look++ === 0
        ? ({ status: "pending", recheckAtMs: 0, seen: true } as const)
        : ({ status: "absent" } as const),
    );
    const store = new InMemoryPaidIntentStore();
    const res = await hire(new PaidIntentLedger(store, ME, "s1"), pay, "x", {
      confirmP2pPayment: flipFlop,
      paymentConfirmMaxWaitMs: 60_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_status_unknown");
    expect(r.submits).toHaveLength(0);
    expect(new PaidIntentLedger(store, ME, "later").outstandingCount).toBe(1);
  });

  it("still pending when the wait ends ⇒ unknown, never read as absent", async () => {
    relay();
    const pay = railFor(new Chain(["dead"]));
    const pending = vi.fn(async () => ({ status: "pending" as const, recheckAtMs: 10_000_000 }));
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x", {
      confirmP2pPayment: pending,
      paymentConfirmMaxWaitMs: 1_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_status_unknown");
  });

  it("a 'landed' verdict for a different tx or different legs is unknown, never submitted", async () => {
    const r = relay();
    const pay = railFor(new Chain(["dead"]));
    const wrong = vi.fn(async (q: { request: SovereignP2pPaymentRequest }) => ({
      status: "landed" as const,
      proof: {
        tx_hash: "someoneElsesSig",
        chain: "solana",
        network: "solana:x",
        to_address: q.request.workerAddress,
        amount_micro: q.request.amountMicro,
        fee_to_address: q.request.treasuryAddress,
        fee_amount_micro: q.request.feeAmountMicro,
      },
    }));
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x", {
      confirmP2pPayment: wrong,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_status_unknown");
    expect(r.submits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Broadcast, then the submit fails
// ---------------------------------------------------------------------------

describe("#885 — broadcast, then the submit fails", () => {
  it("503 once → the SAME proof is resubmitted, one broadcast, delivered, ledger clean", async () => {
    const r = relay(["503", "201"]);
    const pay = railFor(new Chain(["ok"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME, "s1");
    const res = await hire(ledger, pay, "research X");
    expect(res.ok).toBe(true);
    expect(pay.build).toHaveBeenCalledTimes(1);
    expect(r.submits).toHaveLength(2);
    expect(new Set(r.submits.map((s) => s.txHash)).size).toBe(1);
    expect(ledger.outstanding()).toEqual([]);
    expect(ledger.inFlight()).toEqual([]);
  });

  it("a network throw once → resubmitted with the same proof, delivered", async () => {
    const r = relay(["throw", "201"]);
    const pay = railFor(new Chain(["ok"]));
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x");
    expect(res.ok).toBe(true);
    expect(r.submits).toHaveLength(2);
    expect(new Set(r.submits.map((s) => s.txHash)).size).toBe(1);
  });

  it("persistent 503 → one broadcast, 'admission unconfirmed', outstanding; re-hire refused here AND in a new session", async () => {
    const r = relay(["503"]);
    const chain = new Chain(["ok"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    const first = await hire(ledger, pay, "x");
    expect(first.ok).toBe(false);
    if (!first.ok) {
      // A 503 may have come after the relay admitted it: never "refused".
      expect(first.error.code).toBe("payment_admission_unconfirmed");
      expect(first.error.settledPayment?.taskId).toBe(`p2p-payment:${chain.sigs[0]}`);
      expect(first.error.message).toMatch(/not confirmed admitting/);
    }
    expect(r.submits).toHaveLength(4);
    const again = await hire(ledger, pay, "x");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("intent_already_paid");
    const later = await hire(new PaidIntentLedger(store, ME, "s2"), pay, "x");
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.error.code).toBe("intent_already_paid");
    expect(pay.build).toHaveBeenCalledTimes(1);
  });

  it("a 409 TASK_CONFLICT to the end (the relay still handling the first POST) ⇒ admission unconfirmed, not 'refused'", async () => {
    relay(["throw", "409"]);
    const pay = railFor(new Chain(["ok"]));
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_admission_unconfirmed");
  });

  it("a definitive 400 is not retried ⇒ payment_not_admitted, still outstanding", async () => {
    const r = relay(["400"]);
    const pay = railFor(new Chain(["ok"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME);
    const res = await hire(ledger, pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_not_admitted");
      expect(res.error.submitError?.code).toBe("malformed_request");
    }
    expect(r.submits).toHaveLength(1);
    expect(ledger.outstandingCount).toBe(1);
  });

  it("selectAndRunDelegation never falls back to relay-mode after a paid, unadmitted hire", async () => {
    const r = relay(["503"]);
    const pay = railFor(new Chain(["ok"]));
    vi.useFakeTimers();
    const p = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      prompt: "x",
      requiredCapabilities: ["web_search"],
      relayPublicKey: PINNED_HEX,
      buildP2pPayment: pay.build,
      ...(pay.confirm != null ? { confirmP2pPayment: pay.confirm } : {}),
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: new PaidIntentLedger(new InMemoryPaidIntentStore(), ME),
      logger: { warn: () => {} },
    });
    await advanceAfterRealAsync(20_000);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_admission_unconfirmed");
    expect(r.submits).toHaveLength(4);
    expect(r.submits.every((s) => s.txHash.startsWith("sig"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 3: re-signs, a non-honouring adapter, fail-closed owed records
// ---------------------------------------------------------------------------

describe("#885 round 3", () => {
  it("REVIEWER PROBE: a re-sign whose FIRST tx also landed ⇒ both on record, the extra never voided, and the caller is told", async () => {
    const r = relay();
    const chain = new Chain(["resignBothLand"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "s1");
    const res = await hire(ledger, pay, "research X");

    const [sigA, sigB] = chain.sigs;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settlement?.txHash).toBe(sigB);
      expect(res.settlement?.extraPayments).toEqual([{ txHash: sigA, status: "landed" }]);
      expect(res.settlement?.notice).toContain(`tx ${sigA}`);
      expect(res.settlement?.notice).toMatch(/reconcile/);
    }
    expect(r.submits.map((x) => x.txHash)).toEqual([sigB]);
    // sigA moved money with no task behind it: owed, in every session.
    expect(new PaidIntentLedger(store, ME, "later").outstanding().map((e) => e.txHash)).toEqual([
      sigA,
    ]);
  });

  it("a re-sign whose first tx is dead ⇒ the first entry is voided, nothing extra reported", async () => {
    relay();
    const chain = new Chain(["resignFirstDead"]);
    const pay = railFor(chain);
    const store = new InMemoryPaidIntentStore();
    const res = await hire(new PaidIntentLedger(store, ME, "s1"), pay, "x");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settlement?.extraPayments).toBeUndefined();
      expect(res.settlement?.notice).toBeUndefined();
    }
    expect(new PaidIntentLedger(store, ME, "later").outstanding()).toEqual([]);
  });

  it("an adapter that sends but ignores the hooks ⇒ no confirmer, and a throw is NEVER 'nothing was sent'", async () => {
    const r = relay();
    const chain = new Chain(["lost"], /* honorsHooks */ false);
    const pay = railFor(chain);
    expect(pay.confirm).toBeUndefined();
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_status_unknown");
      expect(res.error.message).not.toMatch(/nothing was sent|no funds moved/i);
    }
    expect(r.submits).toHaveLength(0);
    expect(chain.txs.size).toBe(1); // it DID send
  });

  it("a confirmer's 'landed' proof for THIS tx but other amounts ⇒ unknown (proofMatchesRequest)", async () => {
    const r = relay();
    const chain = new Chain(["dead"]);
    const pay = railFor(chain);
    const wrongAmount = vi.fn(
      async (q: { request: SovereignP2pPaymentRequest; transaction: { signature: string } }) => ({
        status: "landed" as const,
        proof: {
          tx_hash: q.transaction.signature, // its OWN signature — only the legs are wrong
          chain: "solana",
          network: "solana:x",
          to_address: q.request.workerAddress,
          amount_micro: q.request.amountMicro + 1,
          fee_to_address: q.request.treasuryAddress,
          fee_amount_micro: q.request.feeAmountMicro,
        },
      }),
    );
    const res = await hire(new PaidIntentLedger(new InMemoryPaidIntentStore(), ME), pay, "x", {
      confirmP2pPayment: wrongAmount,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_status_unknown");
    expect(r.submits).toHaveLength(0);
  });

  it("status unknown AND the owed record cannot be written ⇒ held in memory (same session refused) and said so", async () => {
    relay();
    const chain = new Chain(["lost"]);
    const pay = railFor(chain);
    /** Accepts the in-flight write at signing; fails the durable "owed" write. */
    class OwedWriteFails extends InMemoryPaidIntentStore {
      override record(entry: Parameters<InMemoryPaidIntentStore["record"]>[0]): void {
        if (entry.state === "unretrieved") throw new Error("SQLITE_FULL");
        super.record(entry);
      }
    }
    const ledger = new PaidIntentLedger(new OwedWriteFails(), ME, "s1");
    const unknown = vi.fn(async () => ({ status: "unknown" as const, reason: "429" }));
    const res = await hire(ledger, pay, "x", { confirmP2pPayment: unknown });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_status_unknown");
      expect(res.error.ledgerWriteFailed).toBe(true);
      expect(res.error.message).toMatch(/could NOT be written/);
    }
    // The only durable row is this session's own in-flight one, which locks
    // nothing here — the in-memory hold is what refuses the re-hire.
    const again = await hire(ledger, pay, "x", { confirmP2pPayment: unknown });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("intent_already_paid");
    expect(pay.build).toHaveBeenCalledTimes(1);
  });

  it("a 409 TASK_P2P_PROOF_REPLAYED is never 'refused': admission unconfirmed, lock kept", async () => {
    relay(["409replayed"]);
    const pay = railFor(new Chain(["ok"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME);
    const res = await hire(ledger, pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("payment_admission_unconfirmed");
      expect(res.error.message).toMatch(/already settled a task/);
    }
    expect(ledger.outstandingCount).toBe(1);
  });

  it("a 409 TASK_P2P_PROOF_ALREADY_ADMITTED (#918) is final: submitted once, never retried, admission unconfirmed, lock kept", async () => {
    const stub = relay(["409admitted"]);
    const pay = railFor(new Chain(["ok"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME);
    const res = await hire(ledger, pay, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("payment_admission_unconfirmed");
    expect(stub.submits).toHaveLength(1);
    expect(ledger.outstandingCount).toBe(1);
  });
});

describe("#918 — a proof already admitted, named to its own submitter", () => {
  it("a 409 TASK_P2P_PROOF_ALREADY_ADMITTED carrying task_id hands over to that task: delivered, submitted once, ledger clean", async () => {
    const stub = relay(["409admittedMine"]);
    const pay = railFor(new Chain(["ok"]));
    const ledger = new PaidIntentLedger(new InMemoryPaidIntentStore(), ME);
    const res = await hire(ledger, pay, "handover");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(JSON.stringify(res)).toContain("task-918");
    expect(stub.submits).toHaveLength(1);
    expect(pay.build).toHaveBeenCalledTimes(1);
    expect(ledger.outstanding()).toEqual([]);
  });
});

describe("#885 — a payment with no confirmed relay task is answered locally", () => {
  it("retrieveDelegationResult never reads the relay for a p2p-payment / p2p-unconfirmed id", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const base = { motebitId: ME, syncUrl: RELAY, authToken: async () => "t" };
    await expect(
      retrieveDelegationResult({ ...base, taskId: "p2p-payment:sig9" }),
    ).resolves.toEqual({ status: "not_admitted", taskId: "p2p-payment:sig9" });
    await expect(
      retrieveDelegationResult({ ...base, taskId: "p2p-unconfirmed:abc-def" }),
    ).resolves.toEqual({ status: "not_admitted", taskId: "p2p-unconfirmed:abc-def" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Composition: the runtime's own doors wire the REAL rail's confirmer.
// ---------------------------------------------------------------------------

describe("#885 composition — the runtime wires the rail's own-transaction confirmer", () => {
  function lostSendRuntime(script: Behaviour[] = ["lost"]) {
    const chain = new Chain(script);
    const rail = new SolanaWalletRail(chain.adapter());
    const runtime = new MotebitRuntime(
      { motebitId: ME, tickRateHz: 0, solanaWallet: rail },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    return { runtime, chain };
  }

  it("invokeCapability (the user-tap door)", async () => {
    const r = relay();
    const { runtime, chain } = lostSendRuntime();
    runtime.enableInvokeCapability({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
    });
    vi.useFakeTimers();
    const chunks: Array<{ type: string }> = [];
    const run = (async () => {
      for await (const c of runtime.invokeCapability("web_search", "research X", {
        acknowledgeNoHistoryRisk: true,
      })) {
        chunks.push(c as { type: string });
      }
    })();
    await advanceAfterRealAsync(10_000);
    await run;
    expect(chunks.find((c) => c.type === "invoke_error")).toBeUndefined();
    expect(chain.sigs).toHaveLength(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([chain.sigs[0]]);
  });

  it("delegate_to_agent (the AI-loop door)", async () => {
    const r = relay();
    const { runtime, chain } = lostSendRuntime();
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
      acknowledgeNoHistoryRisk: true,
    });
    vi.useFakeTimers();
    const pending = runToolHandler(runtime.getToolRegistry(), "delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    await advanceAfterRealAsync(10_000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(chain.sigs).toHaveLength(1);
    expect(r.submits.map((s) => s.txHash)).toEqual([chain.sigs[0]]);
  });

  it("invokeCapability: an extra landed payment reaches the owner as a payment_notice chunk", async () => {
    relay();
    const { runtime, chain } = lostSendRuntime(["resignBothLand"]);
    runtime.enableInvokeCapability({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
    });
    vi.useFakeTimers();
    const chunks: Array<{ type: string; notice?: string }> = [];
    const run = (async () => {
      for await (const c of runtime.invokeCapability("web_search", "research X", {
        acknowledgeNoHistoryRisk: true,
      })) {
        chunks.push(c as { type: string; notice?: string });
      }
    })();
    await advanceAfterRealAsync(10_000);
    await run;
    const notice = chunks.find((c) => c.type === "payment_notice");
    expect(notice?.notice).toContain(`tx ${chain.sigs[0]}`);
  });

  it("delegate_to_agent: an extra landed payment is stashed for the stream (payment_notice)", async () => {
    relay();
    const { runtime, chain } = lostSendRuntime(["resignBothLand"]);
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: PINNED_HEX,
      acknowledgeNoHistoryRisk: true,
    });
    vi.useFakeTimers();
    const pending = runToolHandler(runtime.getToolRegistry(), "delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    await advanceAfterRealAsync(10_000);
    await pending;
    const notices = (
      runtime as unknown as {
        interactiveDelegation: { drainPaymentNotices(): Array<{ notice: string }> };
      }
    ).interactiveDelegation.drainPaymentNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.notice).toContain(`tx ${chain.sigs[0]}`);
  });
});
