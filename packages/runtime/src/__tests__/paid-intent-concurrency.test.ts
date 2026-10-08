/**
 * #874 round-2 review: the settle-time record must not change what a LIVE
 * session may do, and a ledger write must never abort a paid flow.
 *
 * - IN FLIGHT ≠ UNRETRIEVED. A payment recorded while its own session is
 *   still polling locks nothing: concurrent hires (two customers of one
 *   molecule, or fan-out) behave exactly as before the ledger existed. It
 *   becomes unretrieved when its poll fails, or when a different session
 *   reads it (the process that owned it died mid-poll).
 * - A throwing store (SQLITE_BUSY, disk full) costs the note, never the
 *   poll, the result, or the settlement facts on a failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { P2pPaymentProof, PaidIntentRecord } from "@motebit/sdk";
import {
  InMemoryPaidIntentStore,
  MotebitRuntime,
  NullRenderer,
  PaidIntentLedger,
  createInMemoryStorage,
  selectAndRunDelegation,
} from "../index";
import { FOREIGN_CALL } from "./helpers/foreign-call";
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
const ME = "alice-001";
const WORKER = "bob-worker";
const CAPS = ["web_search", "summarize", "translate"];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let txn = 0;
const mkProof = (): P2pPaymentProof => ({
  tx_hash: `tx-${++txn}`,
  chain: "solana",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  to_address: "BobWorkerAddr1111111111111111111111111111111",
  amount_micro: 250_000,
  fee_to_address: "Treasury1111111111111111111111111111111111",
  fee_amount_micro: 13_158,
});

/** A relay whose tasks answer "running" until their id is put in `deliverable`. */
function stub(deliverable: Set<string>, failPolls = false): { submits: () => number } {
  let submits = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
    const method = init?.method ?? "GET";
    const pricing = CAPS.map((capability) => ({ capability, unit_cost: 0.25 }));
    if (url.includes("/api/v1/agents/discover")) {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            settlement_address: "BobWorkerAddr1111111111111111111111111111111",
            settlement_modes: "relay,p2p",
            pricing,
          },
        ],
      });
    }
    if (url.includes("/p2p-eligibility")) return json(200, { allowed: true });
    if (url.includes(`/api/v1/agents/${WORKER}/listing`)) return json(200, { pricing });
    if (method === "POST" && url.endsWith(`/agent/${ME}/task`)) {
      submits++;
      return json(201, { task_id: `task-${submits}` });
    }
    const m = /\/task\/(task-\d+)$/.exec(url);
    if (method === "GET" && m) {
      if (failPolls) return json(404, { error: "Task not found", code: "TASK_NOT_FOUND" });
      const id = m[1]!;
      if (deliverable.has(id)) {
        return json(200, {
          task: { status: "completed" },
          receipt: {
            task_id: id,
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
      return json(200, { task: { status: "running" }, receipt: null });
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  return { submits: () => submits };
}

function hire(
  ledger: PaidIntentLedger,
  pay: () => Promise<P2pPaymentProof>,
  cap = "web_search",
  logger: { warn: (m: string, c?: Record<string, unknown>) => void } = { warn: () => {} },
  timeoutMs = 60_000,
) {
  return selectAndRunDelegation({
    motebitId: ME,
    syncUrl: RELAY,
    authToken: async () => "t",
    prompt: "research X",
    requiredCapabilities: [cap],
    relayPublicKey: SIGNING_PINNED_HEX,
    buildP2pPayment: pay,
    acknowledgeNoHistoryRisk: true,
    paidIntentLedger: ledger,
    timeoutMs,
    logger,
  });
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.useRealTimers();
});

describe("in flight is not unretrieved (#874 round 2)", () => {
  it("two concurrent paid hires of the SAME worker+capability both pay and deliver", async () => {
    vi.useFakeTimers();
    const deliverable = new Set<string>();
    const relay = stub(deliverable);
    const ledger = new PaidIntentLedger();
    const pay = vi.fn(async () => mkProof());
    const a = hire(ledger, pay);
    await advanceAfterRealAsync(2500); // A is in flight, polled once
    const b = hire(ledger, pay);
    await advanceAfterRealAsync(2500);
    deliverable.add("task-1");
    deliverable.add("task-2");
    await advanceAfterRealAsync(6000);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(relay.submits()).toBe(2);
    expect(ledger.outstandingCount).toBe(0);
    expect(ledger.inFlight()).toEqual([]);
  });

  it("three concurrent fan-out hires all proceed — no false suspension", async () => {
    vi.useFakeTimers();
    const deliverable = new Set<string>();
    const relay = stub(deliverable);
    const ledger = new PaidIntentLedger();
    const pay = vi.fn(async () => mkProof());
    const hires = [];
    for (const cap of CAPS) {
      hires.push(hire(ledger, pay, cap));
      await advanceAfterRealAsync(2500);
    }
    for (let i = 1; i <= 3; i++) deliverable.add(`task-${i}`);
    await advanceAfterRealAsync(6000);
    const rs = await Promise.all(hires);
    expect(rs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(pay).toHaveBeenCalledTimes(3);
    expect(relay.submits()).toBe(3);
  });

  it("the suspend message fires only for genuinely unretrieved payments", async () => {
    vi.useFakeTimers();
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME, "live");
    stub(new Set(), true); // every poll 404s: results never arrive
    const pay = vi.fn(async () => mkProof());
    // Two hires on different capabilities whose polls FAIL → two unretrieved.
    for (const cap of ["web_search", "summarize"]) {
      const p = hire(ledger, pay, cap, undefined, 4_000);
      await advanceAfterRealAsync(10_000);
      const r = await p;
      expect(r.ok).toBe(false);
    }
    expect(ledger.outstandingCount).toBe(2);
    // The third hire is refused, and the message is true: they did settle
    // without delivering.
    const third = hire(ledger, pay, "translate");
    await advanceAfterRealAsync(1000);
    const r3 = await third;
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe("intent_already_paid");
      expect(r3.error.message).toMatch(/settled onchain without delivering/);
    }
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it("an in-flight entry from a DEAD session locks: refused and listed by a new session", () => {
    const store = new InMemoryPaidIntentStore();
    const dead = new PaidIntentLedger(store, ME, "dead-session");
    dead.recordInFlight({
      workerMotebitId: WORKER,
      capability: "web_search",
      taskId: "task-9",
      txHash: "tx-9",
      paidMicro: 250_000,
      feeMicro: 13_158,
      recordedAt: 1,
    });
    // The session that recorded it is still live: nothing locks there.
    expect(dead.check(WORKER, "web_search")).toEqual({ locked: false });
    // A new session (the restart) reads it as unretrieved.
    const next = new PaidIntentLedger(store, ME, "new-session");
    expect(next.outstanding().map((e) => e.taskId)).toEqual(["task-9"]);
    expect(next.check(WORKER, "web_search")).toMatchObject({ locked: true, scope: "pair" });
  });
});

// ---------------------------------------------------------------------------

class ThrowingStore extends InMemoryPaidIntentStore {
  constructor(private readonly on: { record?: boolean; resolve?: boolean }) {
    super();
  }
  override record(entry: Omit<PaidIntentRecord, "resolution" | "resolved_at">): void {
    if (this.on.record === true) throw new Error("SQLITE_BUSY: database is locked");
    super.record(entry);
  }
  override resolve(
    motebitId: string,
    taskId: string,
    resolution: "retrieved" | "dismissed",
    resolvedAt: number,
  ): boolean {
    if (this.on.resolve === true) throw new Error("SQLITE_READONLY: attempt to write");
    return super.resolve(motebitId, taskId, resolution, resolvedAt);
  }
}

describe("a ledger write never aborts a paid flow (#874 round 2)", () => {
  it("record throws → the poll still delivers the result, and the failure is logged with task + tx", async () => {
    vi.useFakeTimers();
    const relay = stub(new Set(["task-1"]));
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const ledger = new PaidIntentLedger(new ThrowingStore({ record: true }), ME);
    const pay = vi.fn(async () => mkProof());
    const p = hire(ledger, pay, "web_search", { warn: (m, c) => warns.push([m, c]) });
    await advanceAfterRealAsync(5000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(relay.submits()).toBe(1);
    // Every write failed and was logged: the broadcast-time record (#885) and
    // the admission hand-over, each with its handle and the tx.
    const failed = warns.filter(([m]) => m === "paid_intent_ledger.write_failed").map((w) => w[1]);
    expect(failed).toContainEqual(
      expect.objectContaining({
        op: "record_broadcast",
        taskId: expect.stringMatching(/^p2p-payment:tx-\d+$/),
      }),
    );
    expect(failed).toContainEqual(
      expect.objectContaining({ op: "record_in_flight", taskId: "task-1" }),
    );
    for (const f of failed) expect(String(f?.txHash)).toMatch(/^tx-/);
  });

  it("record throws and the poll fails → the error still carries the settlement (tx + task id)", async () => {
    vi.useFakeTimers();
    stub(new Set(), true);
    const ledger = new PaidIntentLedger(new ThrowingStore({ record: true }), ME);
    const pay = vi.fn(async () => mkProof());
    const p = hire(ledger, pay, "web_search", undefined, 4_000);
    await advanceAfterRealAsync(10_000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.settledPayment?.taskId).toBe("task-1");
      expect(r.error.settledPayment?.txHash).toMatch(/^tx-/);
    }
  });

  it("resolve throws → the delivered result is still returned (flow and runtime retrieval)", async () => {
    vi.useFakeTimers();
    stub(new Set(["task-1"]));
    const store = new ThrowingStore({ resolve: true });
    const p = hire(
      new PaidIntentLedger(store, ME),
      vi.fn(async () => mkProof()),
    );
    await advanceAfterRealAsync(5000);
    expect((await p).ok).toBe(true);
    vi.useRealTimers();

    const runtime = new MotebitRuntime(
      { motebitId: ME, tickRateHz: 0 },
      {
        storage: { ...createInMemoryStorage(), paidIntentStore: store },
        renderer: new NullRenderer(),
      },
    );
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const got = await runtime.retrieveDelegationResult("task-1");
    expect(got.status).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------

describe("inside another principal's task, the owner's prior payment is not disclosed (#874 round 2)", () => {
  it("delegate_to_agent's intent_already_paid refusal carries no owner task id, tx or /result", async () => {
    const store = new InMemoryPaidIntentStore();
    new PaidIntentLedger(store, ME, "earlier").recordSettledUnretrieved({
      workerMotebitId: WORKER,
      capability: "web_search",
      taskId: "owner-task-7",
      txHash: "OWNER_TX_HASH",
      paidMicro: 250_000,
      feeMicro: 13_158,
      recordedAt: 1,
    });
    stub(new Set());
    const runtime = new MotebitRuntime(
      { motebitId: ME, tickRateHz: 0 },
      {
        storage: { ...createInMemoryStorage(), paidIntentStore: store },
        renderer: new NullRenderer(),
      },
    );
    const pay = vi.fn(async () => mkProof());
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment: pay,
      acknowledgeNoHistoryRisk: true,
    });
    const args = { prompt: "research X", required_capabilities: ["web_search"] };

    // A foreign CALL (#943 round 9: whose call it is travels with it).
    const foreign = await runToolHandler(
      runtime.getToolRegistry(),
      "delegate_to_agent",
      args,
      FOREIGN_CALL,
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain("INTENT_ALREADY_PAID");
    for (const secret of ["owner-task-7", "OWNER_TX_HASH", "/result"]) {
      expect(foreign.error, secret).not.toContain(secret);
    }

    // The owner's own turn still gets the full, actionable refusal.
    const own = await runToolHandler(runtime.getToolRegistry(), "delegate_to_agent", args);
    expect(own.error).toContain("owner-task-7");
    expect(pay).not.toHaveBeenCalled();
  });
});
