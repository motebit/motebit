/**
 * #874 — a paid delegation's result must be retrievable by task id, for
 * free, after the session that paid for it is gone.
 *
 * The live run: one 0.25 USDC payment settled, the result poll failed, the
 * process restarted, and the user asked for "the result of task ed665235 —
 * I already paid for it". The model's only route was `delegate_to_agent`:
 * a second MONEY · IRREVERSIBLE prompt, stopped only by a human "n".
 *
 * These tests lock the three halves of the fix:
 *   1. `retrieveDelegationResult` — ONE authenticated task:query GET that
 *      returns the result or a typed status, and never submits or pays;
 *   2. the runtime surfaces it (`retrieve_task_result` tool, `result`
 *      command) and resolves the paid-unretrieved entry on delivery;
 *   3. the ledger is as durable as its store, so a NEW runtime over the
 *      same store still refuses the re-hire and still lists the payment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReceipt, P2pPaymentProof } from "@motebit/sdk";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryPaidIntentStore,
  PaidIntentLedger,
  InvokeCapabilityManager,
  retrieveDelegationResult,
  executeCommand,
  paidResultsNotice,
  servedToolNames,
  resolveAttachedRead,
  resolveAttachedAct,
  selectAndRunDelegation,
} from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import { FOREIGN_CALL, executeWithCall } from "./helpers/foreign-call";
import { RiskLevel, SideEffect } from "@motebit/protocol";
import {
  SIGNING_PINNED_HEX,
  advanceAfterRealAsync,
  isRelayMetadataUrl,
  relayMetadataResponse,
} from "./helpers/signed-relay-metadata.js";

const RELAY = "https://mock-relay.test";
const ME = "alice-001";
const TASK = "ed665235-0341-4086-bd77-72c0d9396fe6";
const WORKER = "bob-worker";

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    task_id: TASK,
    motebit_id: WORKER,
    device_id: "bob-device",
    submitted_at: Date.now() - 5000,
    completed_at: Date.now(),
    status: "completed",
    result: "The paid research answer.",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig",
    ...overrides,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
}

/** Install a fetch that records every call and answers the task GET with `answer`. */
function stubTaskRead(answer: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, method, auth });
    if (method === "GET" && url.includes("/task/")) return answer();
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  return calls;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. The primitive
// ---------------------------------------------------------------------------

describe("retrieveDelegationResult — one free, read-only task:query read", () => {
  const audiences: Array<string | undefined> = [];
  const authToken = async (aud?: string): Promise<string> => {
    audiences.push(aud);
    return "query-token";
  };
  beforeEach(() => {
    audiences.length = 0;
  });

  it("returns the signed result of a completed paid task — exactly one GET, task:query-scoped", async () => {
    const calls = stubTaskRead(() =>
      json(200, { task: { status: "completed" }, receipt: receipt() }),
    );
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r.status).toBe("delivered");
    if (r.status === "delivered") expect(r.receipt.result).toBe("The paid research answer.");
    expect(calls).toEqual([
      { url: `${RELAY}/agent/${ME}/task/${TASK}`, method: "GET", auth: "Bearer query-token" },
    ]);
    expect(audiences).toEqual(["task:query"]);
  });

  it("is typed not_found after the relay reaped the task (404) — not a generic failure", async () => {
    stubTaskRead(() =>
      json(404, { error: "Task not found — it may have expired", code: "TASK_NOT_FOUND" }),
    );
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r.status).toBe("not_found");
    if (r.status === "not_found") expect(r.message).toContain("expired");
  });

  it("is typed pending while the worker has not posted a receipt", async () => {
    stubTaskRead(() => json(200, { task: { status: "running" }, receipt: null }));
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r).toEqual({ status: "pending", taskId: TASK, taskStatus: "running" });
  });

  it("is typed failed when the relay marked the task failed without a receipt", async () => {
    stubTaskRead(() => json(200, { task: { status: "failed" }, receipt: null }));
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r.status).toBe("failed");
  });

  it.each([401, 403])("is typed auth_error on HTTP %i", async (code) => {
    stubTaskRead(() => json(code, { error: "Device not authorized" }));
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r.status).toBe("auth_error");
  });

  it("is typed auth_error — and sends nothing — when the token cannot be minted", async () => {
    const calls = stubTaskRead(() => json(200, {}));
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => {
        throw new Error("no key");
      },
      taskId: TASK,
    });
    expect(r.status).toBe("auth_error");
    expect(calls).toHaveLength(0);
  });

  it("is typed unreachable on a relay 5xx and on a network failure", async () => {
    stubTaskRead(() => new Response("down", { status: 503 }));
    const r1 = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r1.status).toBe("unreachable");
    stubTaskRead(() => {
      throw new TypeError("fetch failed");
    });
    const r2 = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(r2.status).toBe("unreachable");
  });

  it("refuses a receipt bound to a different relay task (malformed), accepts a matching one", async () => {
    stubTaskRead(() =>
      json(200, {
        task: { status: "completed" },
        receipt: { ...receipt(), relay_task_id: "some-other-task" },
      }),
    );
    const bad = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(bad.status).toBe("malformed");
    stubTaskRead(() =>
      json(200, { task: { status: "completed" }, receipt: { ...receipt(), relay_task_id: TASK } }),
    );
    const good = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
    });
    expect(good.status).toBe("delivered");
  });

  it("refuses a non-id without sending anything (no path smuggling)", async () => {
    const calls = stubTaskRead(() => json(200, {}));
    for (const bad of ["", "../../admin", "a/b", "x?y=1"]) {
      const r = await retrieveDelegationResult({
        motebitId: ME,
        syncUrl: RELAY,
        authToken,
        taskId: bad,
      });
      expect(r.status, bad).toBe("invalid_task_id");
    }
    expect(calls).toHaveLength(0);
  });

  it("reads under the task's owner when one is named (motebit delegate's relay-mode filing)", async () => {
    const calls = stubTaskRead(() =>
      json(200, { task: { status: "completed" }, receipt: receipt() }),
    );
    await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken,
      taskId: TASK,
      taskOwnerId: WORKER,
    });
    expect(calls[0]!.url).toBe(`${RELAY}/agent/${WORKER}/task/${TASK}`);
  });
});

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function makeRuntime(store: InMemoryPaidIntentStore, motebitId = ME): MotebitRuntime {
  const adapters: PlatformAdapters = {
    storage: { ...createInMemoryStorage(), paidIntentStore: store },
    renderer: new NullRenderer(),
  };
  return new MotebitRuntime({ motebitId, tickRateHz: 0 }, adapters);
}

function seedPaid(store: InMemoryPaidIntentStore, motebitId = ME): void {
  new PaidIntentLedger(store, motebitId).recordSettledUnretrieved({
    workerMotebitId: WORKER,
    capability: "web_search",
    taskId: TASK,
    txHash: "XaMuKuMCtx",
    paidMicro: 250_000,
    feeMicro: 13_158,
    recordedAt: 1000,
  });
}

const proof: P2pPaymentProof = {
  tx_hash: "XaMuKuMCtx",
  chain: "solana",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  to_address: "BobWorkerAddr1111111111111111111111111111111",
  amount_micro: 250_000,
  fee_to_address: "Treasury1111111111111111111111111111111111",
  fee_amount_micro: 13_158,
};

/**
 * A stub relay that serves the whole paid P2P flow. `poll` decides what the
 * delegator's result read sees; `submits` counts task submissions — the
 * number that must stay at 1 for "never pay twice".
 */
function stubRelay(poll: () => Response): { submits: () => number; methods: string[] } {
  let submits = 0;
  const methods: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
    const method = init?.method ?? "GET";
    methods.push(`${method} ${new URL(url).pathname}`);
    if (url.includes("/api/v1/agents/discover")) {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            settlement_address: proof.to_address,
            settlement_modes: "relay,p2p",
            pricing: [{ capability: "web_search", unit_cost: 0.25 }],
          },
        ],
      });
    }
    if (url.includes("/p2p-eligibility")) return json(200, { allowed: true });
    if (url.includes(`/api/v1/agents/${WORKER}/listing`)) {
      return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.25 }] });
    }
    if (method === "POST" && url.endsWith(`/agent/${ME}/task`)) {
      submits++;
      return json(201, { task_id: TASK });
    }
    if (method === "GET" && url.endsWith(`/agent/${ME}/task/${TASK}`)) return poll();
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  return { submits: () => submits, methods };
}

const delivered = (): Response => json(200, { task: { status: "completed" }, receipt: receipt() });
const reaped = (): Response =>
  json(404, { error: "Task not found — it may have expired", code: "TASK_NOT_FOUND" });

// ---------------------------------------------------------------------------
// 2. The runtime surface
// ---------------------------------------------------------------------------

describe("runtime.retrieveDelegationResult", () => {
  it("is not_connected — and sends nothing — before any relay is enabled", async () => {
    const calls = stubTaskRead(delivered);
    const runtime = makeRuntime(new InMemoryPaidIntentStore());
    const r = await runtime.retrieveDelegationResult(TASK);
    expect(r.status).toBe("not_connected");
    expect(calls).toHaveLength(0);
  });

  it("resolves the paid-unretrieved entry on delivery — and only on delivery", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });

    stubTaskRead(() => json(200, { task: { status: "running" }, receipt: null }));
    expect((await runtime.retrieveDelegationResult(TASK)).status).toBe("pending");
    expect(runtime.outstandingPaidResults()).toHaveLength(1);

    stubTaskRead(reaped);
    expect((await runtime.retrieveDelegationResult(TASK)).status).toBe("not_found");
    // A 404 is never proof the result is gone (#433: 503 then 404) — the
    // entry stays until retrieval or an explicit owner dismissal.
    expect(runtime.outstandingPaidResults()).toHaveLength(1);

    stubTaskRead(delivered);
    expect((await runtime.retrieveDelegationResult(TASK, { acknowledge: false })).status).toBe(
      "delivered",
    );
    expect(runtime.outstandingPaidResults()).toHaveLength(1);

    expect((await runtime.retrieveDelegationResult(TASK)).status).toBe("delivered");
    expect(runtime.outstandingPaidResults()).toHaveLength(0);
  });

  it("MONEY INVARIANT: retrieval by every door never submits and never builds a payment", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    const buildP2pPayment = vi.fn(async () => proof);
    const relay = stubRelay(delivered);
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment,
    });

    await runtime.retrieveDelegationResult(TASK, { acknowledge: false });
    await runtime.getToolRegistry().execute("retrieve_task_result", { task_id: TASK });
    await runtime.getToolRegistry().execute("retrieve_task_result", {});
    await executeCommand(runtime, "result", TASK);
    await executeCommand(runtime, "result", "");

    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(relay.submits()).toBe(0);
    // Every request the retrieval doors made was a GET of the task itself.
    expect(relay.methods.every((m) => m === `GET /agent/${ME}/task/${TASK}`)).toBe(true);
    expect(relay.methods.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The model tool
// ---------------------------------------------------------------------------

describe("retrieve_task_result — the model's free route to a paid result", () => {
  it("is registered beside delegate_to_agent as an api-tier, read-class tool", () => {
    const runtime = makeRuntime(new InMemoryPaidIntentStore());
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const def = runtime
      .getToolRegistry()
      .list()
      .find((t) => t.name === "retrieve_task_result");
    expect(def).toBeDefined();
    expect(def?.mode).toBe("api");
    expect(def?.riskHint).toEqual({ risk: RiskLevel.R0_READ, sideEffect: SideEffect.NONE });
    // The description makes it the obvious choice over hiring again.
    expect(def?.description).toContain("ALWAYS prefer this over delegate_to_agent");
    expect(def?.description).toContain("never pays");
    // And delegate_to_agent points back at it.
    const delegate = runtime
      .getToolRegistry()
      .list()
      .find((t) => t.name === "delegate_to_agent");
    expect(delegate?.description).toContain("use retrieve_task_result");
  });

  it("is never offered to another principal — by any serve path the runtime owns", async () => {
    const runtime = makeRuntime(new InMemoryPaidIntentStore());
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const owned = ["retrieve_task_result", "delegate_to_agent", "discover_agents"];
    const defs = runtime.getToolRegistry().list();
    for (const name of owned) {
      expect(defs.find((t) => t.name === name)?.localOnly, name).toBe(true);
    }

    // 1. What web / desktop / mobile advertise when serving.
    const advertised = servedToolNames(defs);
    for (const name of owned) expect(advertised, name).not.toContain(name);

    // 2. What an attached MCP frontend (`motebit serve` attached) lists…
    const filtered = (await resolveAttachedRead(runtime, "tools_filtered")) as Array<{
      name: string;
    }>;
    for (const name of owned)
      expect(
        filtered.map((t) => t.name),
        name,
      ).not.toContain(name);
    // …and what it may execute on the coordinator.
    const calls = stubTaskRead(delivered);
    const refused = (await resolveAttachedAct(runtime, "tool_execute", {
      name: "retrieve_task_result",
      args: {},
    })) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses while the loop runs another principal's task (a customer cannot read the ledger)", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const calls = stubTaskRead(delivered);
    const r = await executeWithCall(runtime, "retrieve_task_result", {}, FOREIGN_CALL);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("owner-only");
    expect(JSON.stringify(r)).not.toContain("XaMuKuMCtx");
    expect(calls).toHaveLength(0);
    expect(runtime.outstandingPaidResults()).toHaveLength(1);
  });

  it("delivers a paid result by short id with typed fields (already_paid, status, free)", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    stubTaskRead(delivered);

    const r = await runtime
      .getToolRegistry()
      .execute("retrieve_task_result", { task_id: TASK.slice(0, 8) });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.data as string) as Record<string, unknown>;
    expect(out.task_id).toBe(TASK);
    expect(out.status).toBe("delivered");
    expect(out.already_paid).toBe(true);
    expect(out.retrieval_cost).toMatch(/^free/);
    expect(out.result).toBe("The paid research answer.");
    expect((out.payment as Record<string, unknown>).tx_hash).toBe("XaMuKuMCtx");
    expect(runtime.outstandingPaidResults()).toHaveLength(0);
  });

  it("with no id, lists the paid results still owed", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const r = await runtime.getToolRegistry().execute("retrieve_task_result", {});
    const out = JSON.parse(r.data as string) as {
      outstanding_paid_results: Array<{ task_id: string }>;
    };
    expect(out.outstanding_paid_results.map((e) => e.task_id)).toEqual([TASK]);
  });

  it("on a reaped task says so, keeps the payment on record, and tells the model not to re-hire", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    stubTaskRead(reaped);
    const r = await runtime.getToolRegistry().execute("retrieve_task_result", { task_id: TASK });
    const out = JSON.parse(r.data as string) as Record<string, unknown>;
    expect(out.status).toBe("not_found");
    expect(out.already_paid).toBe(true);
    expect(out.guidance).toContain("Do NOT re-delegate");
    expect(runtime.outstandingPaidResults()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The shared `result` command + startup notice
// ---------------------------------------------------------------------------

describe("result command + paidResultsNotice", () => {
  it("the notice is one calm line, or nothing", () => {
    expect(paidResultsNotice([])).toBeNull();
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const one = new PaidIntentLedger(store, ME).outstanding();
    expect(paidResultsNotice(one)).toBe("1 paid result not retrieved — /result ed665235");
    expect(paidResultsNotice([...one, { ...one[0]!, taskId: "t2" }])).toBe(
      "2 paid results not retrieved — /result to list them",
    );
  });

  it("lists, retrieves, and dismisses", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });

    const list = await executeCommand(runtime, "result", "");
    expect(list?.summary).toContain("1 paid result not retrieved");
    expect(list?.detail).toContain("ed665235");

    stubTaskRead(reaped);
    const gone = await executeCommand(runtime, "result", "ed665235");
    expect(gone?.summary).toContain("no longer holds task ed665235");
    expect(gone?.detail).toContain("/result dismiss ed665235");

    stubTaskRead(delivered);
    const got = await executeCommand(runtime, "result", "ed665235");
    expect(got?.summary).toContain("Free read");
    expect(got?.detail).toContain("The paid research answer.");
    expect((await executeCommand(runtime, "result", ""))?.summary).toBe(
      "No paid result is known on this device.",
    );

    seedPaid(store); // idempotent on task id — already resolved, stays resolved
    expect(runtime.outstandingPaidResults()).toHaveLength(0);
  });

  it("dismiss clears an entry locally; a remote frame can neither read the text nor clear it", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    stubTaskRead(delivered);

    const remoteRead = await executeCommand(runtime, "result", TASK, undefined, {
      origin: "remote",
    });
    expect(remoteRead?.summary).toContain("result delivered by the relay");
    expect(remoteRead?.detail).toBeUndefined();
    expect(JSON.stringify(remoteRead)).not.toContain("The paid research answer.");
    expect(runtime.outstandingPaidResults()).toHaveLength(1);

    const remoteDismiss = await executeCommand(runtime, "result", `dismiss ${TASK}`, undefined, {
      origin: "remote",
    });
    expect(remoteDismiss?.summary).toContain("not remotely");
    expect(runtime.outstandingPaidResults()).toHaveLength(1);

    const local = await executeCommand(runtime, "result", "dismiss ed665235");
    expect(local?.summary).toContain("Dismissed task ed665235");
    expect(runtime.outstandingPaidResults()).toHaveLength(0);
  });
});

describe("result command — a payment with no confirmed relay task (#885)", () => {
  it("lists it under a unique short id, answers it without a relay read, and dismisses it", async () => {
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME);
    for (const tx of ["TxAAAAAAAA111", "TxBBBBBBBB222"]) {
      ledger.recordBroadcast({
        workerMotebitId: WORKER,
        capability: "web_search",
        txHash: tx,
        paidMicro: 250_000,
        feeMicro: 13_158,
        recordedAt: 1,
      });
      ledger.recordSettledUnretrieved({
        workerMotebitId: WORKER,
        capability: "web_search",
        taskId: `p2p-payment:${tx}`,
        txHash: tx,
        paidMicro: 250_000,
        feeMicro: 13_158,
        recordedAt: 1,
      });
    }
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const reads = vi.fn();
    globalThis.fetch = reads as unknown as typeof fetch;

    const list = await executeCommand(runtime, "result", "");
    // Two entries, two DISTINCT short ids — eight characters would name both.
    expect(list?.detail).toContain("p2p-payment:TxAAAAAA");
    expect(list?.detail).toContain("p2p-payment:TxBBBBBB");

    const one = await executeCommand(runtime, "result", "p2p-payment:TxAAAAAA");
    expect(one?.summary).toContain("No relay task is confirmed for this payment");
    expect(one?.detail).toContain("Hiring again would pay a second time");
    expect(one?.detail).toContain("tx TxAAAAAAAA111");
    expect(reads).not.toHaveBeenCalled();

    const gone = await executeCommand(runtime, "result", "dismiss p2p-payment:TxAAAAAA");
    expect(gone?.summary).toContain("Dismissed");
    expect(runtime.outstandingPaidResults().map((e) => e.txHash)).toEqual(["TxBBBBBBBB222"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Across a restart — the #874 shape end to end through delegate_to_agent
// ---------------------------------------------------------------------------

describe("paid, undelivered, restarted (#874 end to end)", () => {
  it("a new runtime over the same store refuses the re-hire, and the free fetch delivers — one payment, one submit", async () => {
    const store = new InMemoryPaidIntentStore();
    const buildP2pPayment = vi.fn(async () => proof);
    const cfg = {
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
      timeoutMs: 1,
    };

    // Session 1: the payment settles, every result poll 404s (the #433 shape).
    let answer = reaped;
    const relay = stubRelay(() => answer());
    vi.useFakeTimers();
    const session1 = makeRuntime(store);
    session1.enableInteractiveDelegation(cfg);
    const hire = session1.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    await advanceAfterRealAsync(5000);
    const first = await hire;
    vi.useRealTimers();
    expect(first.ok).toBe(false);
    expect(first.error).toContain("PAYMENT_ALREADY_SETTLED");
    expect(first.error).toContain("retrieve_task_result");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(relay.submits()).toBe(1);

    // Session 2: a NEW runtime (the restart) over the same store.
    const session2 = makeRuntime(store);
    session2.enableInteractiveDelegation(cfg);
    expect(paidResultsNotice(session2.outstandingPaidResults())).toBe(
      "1 paid result not retrieved — /result ed665235",
    );

    // "Hire again" is refused BEFORE broadcast, across the session boundary.
    const rehire = await session2.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    expect(rehire.ok).toBe(false);
    expect(rehire.error).toContain("INTENT_ALREADY_PAID");
    expect(rehire.error).toContain(`/result ${TASK}`);
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(relay.submits()).toBe(1);

    // The relay still holds the result; the free fetch delivers it.
    answer = delivered;
    const fetched = await session2
      .getToolRegistry()
      .execute("retrieve_task_result", { task_id: "ed665235" });
    const out = JSON.parse(fetched.data as string) as Record<string, unknown>;
    expect(out.status).toBe("delivered");
    expect(out.already_paid).toBe(true);
    expect(out.result).toBe("The paid research answer.");
    expect(session2.outstandingPaidResults()).toHaveLength(0);

    // One payment, one submission — the whole way through.
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(relay.submits()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5b. Recorded at SETTLE time — a quit mid-poll still leaves the entry
// ---------------------------------------------------------------------------

describe("paid, then killed mid-poll (#874 review: record at settle time)", () => {
  it("the entry exists before the first poll; a new runtime refuses the re-hire and lists it", async () => {
    const store = new InMemoryPaidIntentStore();
    const buildP2pPayment = vi.fn(async () => proof);
    // The relay accepted the paid task; the worker has not answered yet.
    const relay = stubRelay(() => json(200, { task: { status: "running" }, receipt: null }));
    const ledger = new PaidIntentLedger(store, ME);
    const controller = new AbortController();

    const inFlight = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      prompt: "research X",
      requiredCapabilities: ["web_search"],
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: ledger,
      timeoutMs: 60_000,
      logger: { warn: () => {} },
      signal: controller.signal,
    });
    // Wait until the submission landed, then "kill" the process mid-poll.
    await vi.waitFor(() => expect(relay.submits()).toBe(1));
    // Recorded before the first poll — as IN FLIGHT: owed nothing yet in
    // this session, so it locks nothing here.
    expect(ledger.inFlight().map((e) => e.taskId)).toEqual([TASK]);
    expect(ledger.outstanding()).toEqual([]);
    controller.abort();
    await inFlight;

    // A NEW runtime over the same store: the payment is on record…
    const next = makeRuntime(store);
    next.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });
    expect(next.outstandingPaidResults().map((e) => e.txHash)).toEqual(["XaMuKuMCtx"]);
    // …the re-hire is refused before broadcast…
    const rehire = await next.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    expect(rehire.error).toContain("INTENT_ALREADY_PAID");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(relay.submits()).toBe(1);
    // …and /result lists it.
    const list = await executeCommand(next, "result", "");
    expect(list?.detail).toContain("ed665235");
  });

  it("a delivered hire leaves nothing outstanding (resolved on delivery)", async () => {
    const store = new InMemoryPaidIntentStore();
    const ledger = new PaidIntentLedger(store, ME);
    stubRelay(delivered);
    vi.useFakeTimers();
    const hire = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      prompt: "research X",
      requiredCapabilities: ["web_search"],
      relayPublicKey: SIGNING_PINNED_HEX,
      buildP2pPayment: vi.fn(async () => proof),
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: ledger,
      timeoutMs: 10_000,
      logger: { warn: () => {} },
    });
    await advanceAfterRealAsync(5000);
    const r = await hire;
    expect(r.ok).toBe(true);
    expect(ledger.outstandingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The user-tap door carries the interlock too
// ---------------------------------------------------------------------------

describe("invokeCapability — the deterministic paid door consults the ledger (#874 sibling)", () => {
  async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it("refuses a tap that would re-buy an outstanding paid result, before broadcast", async () => {
    const store = new InMemoryPaidIntentStore();
    seedPaid(store);
    const buildP2pPayment = vi.fn(async () => proof);
    const relay = stubRelay(delivered);
    const manager = new InvokeCapabilityManager(
      {
        motebitId: ME,
        logger: { warn: () => {} },
        bumpTrustFromReceipt: async () => {},
        stashReceipt: () => {},
        buildP2pPayment,
        paidIntentLedger: new PaidIntentLedger(store, ME),
      },
      { syncUrl: RELAY, authToken: async () => "t", relayPublicKey: SIGNING_PINNED_HEX },
    );
    const chunks = await drain(
      manager.invokeCapability("web_search", "research X", { acknowledgeNoHistoryRisk: true }),
    );
    const err = chunks.find((c) => c.type === "invoke_error") as { code?: string } | undefined;
    expect(err?.code).toBe("intent_already_paid");
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(relay.submits()).toBe(0);
  });

  it("the runtime hands its ledger to the invokeCapability door", () => {
    const runtime = makeRuntime(new InMemoryPaidIntentStore());
    runtime.enableInvokeCapability({ syncUrl: RELAY, authToken: async () => "t" });
    const manager = (runtime as unknown as { invokeCapabilityManager: { deps: object } })
      .invokeCapabilityManager;
    expect((manager.deps as { paidIntentLedger?: unknown }).paidIntentLedger).toBeInstanceOf(
      PaidIntentLedger,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. One task, one body (cold review of 5e5b36a, N1): the relay's own verdict
//    on a granted task whose executor was lost is `undetermined` — the work
//    MAY have run. Never read as pending, never a timeout, never re-hired.
// ---------------------------------------------------------------------------

const undeterminedPoll = (): Response =>
  json(200, {
    task: { status: "claimed" },
    receipt: null,
    undetermined: {
      reason: "claimer_lost",
      detail: "The body that claimed this task stopped answering",
      since: 1,
    },
  });
const expiredPoll = (): Response =>
  json(200, {
    task: { status: "pending" },
    receipt: null,
    expired: {
      reason: "never_claimed",
      detail: "No body claimed this task before its TTL",
      since: 1,
    },
  });

describe("one task, one body — undetermined and expired are their own outcomes", () => {
  it("retrieveDelegationResult is typed undetermined (with the relay's reason), not pending", async () => {
    stubTaskRead(undeterminedPoll);
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      taskId: TASK,
    });
    expect(r.status).toBe("undetermined");
    if (r.status === "undetermined") expect(r.reason).toBe("claimer_lost");
  });

  it("retrieveDelegationResult is typed expired for a task no executor ever took", async () => {
    stubTaskRead(expiredPoll);
    const r = await retrieveDelegationResult({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "t",
      taskId: TASK,
    });
    expect(r.status).toBe("expired");
    if (r.status === "expired") expect(r.reason).toBe("never_claimed");
  });

  it("delegate_to_agent ends on the first undetermined poll and tells the model the work may have run — never re-hire", async () => {
    const store = new InMemoryPaidIntentStore();
    const relay = stubRelay(undeterminedPoll);
    vi.useFakeTimers();
    const runtime = makeRuntime(store);
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "t",
      relayPublicKey: "07".repeat(32),
      buildP2pPayment: vi.fn(async () => proof),
      acknowledgeNoHistoryRisk: true,
      timeoutMs: 10_000,
    });
    const hire = runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await hire;
    vi.useRealTimers();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("TASK_UNDETERMINED");
    expect(r.error).toContain("MAY have run");
    expect(r.error).toContain(TASK);
    expect(r.error).not.toContain("timeout");
    // One submit; the poll stopped at the relay's verdict.
    expect(relay.submits()).toBe(1);
    expect(relay.methods.filter((m) => m === `GET /agent/${ME}/task/${TASK}`)).toHaveLength(1);
  });

  it("the retrieve_task_result tool reads undetermined as 'may have run — do not re-delegate'", async () => {
    stubTaskRead(undeterminedPoll);
    const runtime = makeRuntime(new InMemoryPaidIntentStore());
    runtime.enableInteractiveDelegation({ syncUrl: RELAY, authToken: async () => "t" });
    const r = await runtime.getToolRegistry().execute("retrieve_task_result", { task_id: TASK });
    const out = JSON.parse(String(r.data)) as { status: string; guidance: string; reason?: string };
    expect(out.status).toBe("undetermined");
    expect(out.reason).toBe("claimer_lost");
    expect(out.guidance).toContain("MAY have run");
    expect(out.guidance).toContain("Do NOT re-delegate");
  });
});
