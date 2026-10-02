/**
 * #887 — a delivery-uncertain outcome never becomes a new payment.
 *
 * The pay-forward adapter moves money BEFORE it presents the task, so every
 * retry after a payment is a candidate double-pay. Each case below fixes the
 * world (a wallet whose `send` lies or tells the truth, a worker that times
 * out, answers garbage, or signs a failure) and counts the payments that
 * actually LANDED. Two workers are always discoverable, so a retry that pays
 * again has somewhere to go and shows up in the count.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SovereignDelegationAdapter } from "../sovereign-delegation-adapter.js";
import { isDelegationUndetermined } from "../delegation-adapter.js";
import type {
  SovereignDelegationConfig,
  SovereignPaidEntry,
  SovereignPaidLedger,
  SovereignSendConfirmation,
} from "../sovereign-delegation-adapter.js";
import type { PlanStep, ExecutionReceipt } from "@motebit/sdk";
import { StepStatus, asPlanId } from "@motebit/sdk";

const A = { id: "worker-a", addr: "AddrA", url: "https://a.test/mcp" };
const B = { id: "worker-b", addr: "AddrB", url: "https://b.test/mcp" };

function step(): PlanStep {
  return {
    step_id: "step-1",
    plan_id: asPlanId("plan-1"),
    ordinal: 0,
    description: "research",
    prompt: "find the thing",
    depends_on: [],
    optional: false,
    status: StepStatus.Pending,
    required_capabilities: ["web_search"] as unknown as PlanStep["required_capabilities"],
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: 0,
  };
}

function receipt(workerId: string, overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    task_id: "t",
    motebit_id: workerId,
    public_key: "ab".repeat(32),
    device_id: "d",
    submitted_at: 0,
    completed_at: 1,
    status: "completed",
    result: `done by ${workerId}`,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
    ...overrides,
  } as ExecutionReceipt;
}

/** What a worker does when `motebit_task` reaches it. */
type WorkerBehavior =
  | { kind: "receipt"; receipt: ExecutionReceipt }
  // never answers until aborted — a timeout. `sessionDelayMs` holds the
  // session handshake back so the abort lands BEFORE `motebit_task` is sent.
  | { kind: "hang"; sessionDelayMs?: number }
  | { kind: "text"; text: string } // an answer that is not a receipt
  | { kind: "no_result" } // a JSON-RPC answer with no result
  | { kind: "throw" }; // transport error on tools/call

interface World {
  fetchLog: string[];
  toolCalls: string[];
}

/**
 * A request that never answers, settled only by its abort signal — the way a
 * real `fetch` behaves. An ALREADY-aborted signal rejects at once: its
 * `abort` event has fired and will not fire again, so a listener alone would
 * wait forever. The adapter arms its task timeout before it mints the token
 * and opens the session, so under load the abort can land first.
 */
function pendingUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new Error("aborted"));
    if (signal?.aborted === true) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function stubNetwork(workers: Record<string, WorkerBehavior>, world: World): void {
  const json = (body: unknown, headers?: Record<string, string>): Response =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(headers ?? {}),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      world.fetchLog.push(url);
      if (url.includes("/api/v1/market/candidates")) {
        return Promise.resolve(
          json({
            candidates: [A, B].map((w) => ({
              motebit_id: w.id,
              composite: 0.9,
              endpoint_url: w.url,
              pay_to_address: w.addr,
              pricing: [
                { capability: "web_search", unit_cost: 250_000, currency: "USD", per: "task" },
              ],
              is_online: true,
            })),
          }),
        );
      }
      const worker = [A, B].find((w) => w.url === url)!;
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        method?: string;
        id?: number;
      };
      if (body.method === "initialize") {
        const answer = json({ id: body.id, result: {} }, { "mcp-session-id": "s" });
        const behavior = workers[worker.id]!;
        const delay = behavior.kind === "hang" ? (behavior.sessionDelayMs ?? 0) : 0;
        return delay > 0
          ? new Promise((r) => setTimeout(() => r(answer), delay))
          : Promise.resolve(answer);
      }
      if (body.method === "notifications/initialized") return Promise.resolve(json({}));
      // tools/call
      world.toolCalls.push(worker.id);
      const behavior = workers[worker.id]!;
      switch (behavior.kind) {
        case "receipt":
          return Promise.resolve(
            json({
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(behavior.receipt) }] },
            }),
          );
        case "text":
          return Promise.resolve(
            json({ id: body.id, result: { content: [{ type: "text", text: behavior.text }] } }),
          );
        case "no_result":
          return Promise.resolve(json({ id: body.id }));
        case "throw":
          return Promise.reject(new Error("socket hang up"));
        case "hang":
          return pendingUntilAborted(init?.signal);
      }
    }),
  );
}

/**
 * A wallet with an onchain truth. `send` behaviours:
 *   ok         — lands, returns the signature
 *   lost       — LANDS, then throws (the response was lost)
 *   not_sent   — throws, nothing landed
 * `confirm` answers the read-only lookup; "truth" answers from what landed.
 */
function makeWallet(
  sendPlan: Array<"ok" | "lost" | "not_sent">,
  confirm: "truth" | SovereignSendConfirmation | SovereignSendConfirmation[] | "none",
) {
  const landed: Array<{ to: string; amount: bigint; sig: string }> = [];
  let n = 0;
  const scripted = Array.isArray(confirm) ? [...confirm] : null;
  const rail = {
    chain: "solana",
    asset: "USDC",
    send: vi.fn((to: string, amount: bigint) => {
      const mode = sendPlan[n] ?? "ok";
      const sig = `sig-${++n}`;
      if (mode === "not_sent") return Promise.reject(new Error("RPC 503"));
      landed.push({ to, amount, sig });
      if (mode === "lost") return Promise.reject(new Error("confirmation timed out"));
      return Promise.resolve({ signature: sig });
    }),
    ...(confirm === "none"
      ? {}
      : {
          confirmSend: vi.fn(
            (q: {
              toAddress: string;
              microAmount: bigint;
              excludeSignatures?: readonly string[];
            }): Promise<SovereignSendConfirmation> => {
              if (scripted != null) return Promise.resolve(scripted.shift()!);
              if (confirm !== "truth") return Promise.resolve(confirm as SovereignSendConfirmation);
              const hits = landed.filter(
                (l) =>
                  l.to === q.toAddress &&
                  l.amount === q.microAmount &&
                  !(q.excludeSignatures ?? []).includes(l.sig),
              );
              return Promise.resolve(
                hits.length === 1
                  ? { status: "landed", signature: hits[0]!.sig }
                  : { status: "absent" },
              );
            },
          ),
        }),
  };
  return { rail, landed };
}

function makeLedger() {
  const events: string[] = [];
  const entries = new Map<string, SovereignPaidEntry & { state: string }>();
  const ledger: SovereignPaidLedger = {
    check: vi.fn(() => ({ locked: false as const })),
    recordInFlight: vi.fn((e: SovereignPaidEntry) => {
      events.push(`in_flight:${e.txHash}`);
      entries.set(e.taskId, { ...e, state: "in_flight" });
    }),
    recordSettledUnretrieved: vi.fn((e: SovereignPaidEntry) => {
      events.push(`unretrieved:${e.txHash}`);
      entries.set(e.taskId, { ...e, state: "unretrieved" });
    }),
    resolve: vi.fn((taskId: string) => {
      events.push(`resolve:${taskId}`);
      return entries.delete(taskId);
    }),
  };
  return { ledger, events, entries };
}

function adapterWith(
  rail: SovereignDelegationConfig["walletRail"],
  extra?: Partial<SovereignDelegationConfig>,
): SovereignDelegationAdapter {
  return new SovereignDelegationAdapter({
    discoveryUrl: "https://relay.test",
    motebitId: "delegator",
    deviceId: "dev",
    signingKeys: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) },
    walletRail: rail,
    mintAudienceToken: vi.fn().mockResolvedValue({ token: "tok" }),
    verifyReceipt: vi.fn().mockResolvedValue(true),
    hexToBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
    hash: vi.fn().mockResolvedValue("h"),
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#887 payment — a thrown send is confirmed onchain before it counts as unpaid", () => {
  it("send throws after the transfer LANDED ⇒ proceeds with that tx; exactly one payment", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const { rail, landed } = makeWallet(["lost"], "truth");
    const { ledger, events } = makeLedger();

    const result = await adapterWith(rail, { paidLedger: ledger }).delegateStep(step(), 5_000);

    expect(landed).toHaveLength(1);
    expect(rail.send).toHaveBeenCalledTimes(1);
    expect(result.task_id).toBe(`sovereign:${A.id}:sig-1`);
    expect(world.toolCalls).toEqual([A.id]);
    expect(events).toEqual(["in_flight:sig-1", `resolve:sovereign:${A.id}:sig-1`]);
  });

  it("send throws and the wallet confirms nothing moved ⇒ the next worker may be paid", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [B.id]: { kind: "receipt", receipt: receipt(B.id) } }, world);
    const { rail, landed } = makeWallet(["not_sent", "ok"], "truth");

    const result = await adapterWith(rail).delegateStep(step(), 5_000);

    expect(landed).toEqual([{ to: B.addr, amount: 250_000n, sig: "sig-2" }]);
    expect(result.receipt.motebit_id).toBe(B.id);
  });

  it("confirmation is pending while the tx could still land ⇒ waits, then decides", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const sleep = vi.fn(() => Promise.resolve());
    const { rail, landed } = makeWallet(
      ["lost"],
      [
        { status: "pending", recheckAtMs: 1_000 },
        { status: "landed", signature: "sig-1" },
      ],
    );

    const result = await adapterWith(rail, { sleep, now: () => 0 }).delegateStep(step(), 5_000);

    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(landed).toHaveLength(1);
    expect(result.task_id).toBe(`sovereign:${A.id}:sig-1`);
  });

  it.each([
    ["the wallet cannot decide", { status: "unknown", reason: "RPC down" } as const],
    ["the confirmation window runs out", { status: "pending", recheckAtMs: 10_000_000 } as const],
  ])("%s ⇒ stops with 'payment status unknown'; never pays again", async (_label, verdict) => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [B.id]: { kind: "receipt", receipt: receipt(B.id) } }, world);
    const { rail, landed } = makeWallet(["lost", "ok"], verdict);

    const err = await adapterWith(rail, { now: () => 0 })
      .delegateStep(step(), 5_000)
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/Payment status unknown/);
    // #890: money may have moved — the plan engine must hold, not fail.
    expect(isDelegationUndetermined(err)).toBe(true);
    expect(rail.send).toHaveBeenCalledTimes(1);
    expect(landed).toHaveLength(1);
    expect(world.toolCalls).toEqual([]);
  });

  it("a wallet without confirmSend ⇒ every send error is 'payment status unknown' (fail-closed)", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [B.id]: { kind: "receipt", receipt: receipt(B.id) } }, world);
    const { rail } = makeWallet(["lost", "ok"], "none");

    await expect(adapterWith(rail).delegateStep(step(), 5_000)).rejects.toThrow(
      /Payment status unknown/,
    );
    expect(rail.send).toHaveBeenCalledTimes(1);
  });

  it("the lookup excludes this adapter's own earlier payments", async () => {
    // Step 1 pays A (sig-1) and completes. Step 2's send to A throws and
    // nothing lands: the lookup must not mistake sig-1 for the new payment.
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: { kind: "receipt", receipt: receipt(A.id) },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail, landed } = makeWallet(["ok", "not_sent", "ok"], "truth");
    const adapter = adapterWith(rail);

    await adapter.delegateStep(step(), 5_000);
    const second = await adapter.delegateStep(step(), 5_000);

    expect(second.receipt.motebit_id).toBe(B.id);
    expect(landed.map((l) => l.to)).toEqual([A.addr, B.addr]);
  });
});

describe("#887 execution — paid, then no verifiable result ⇒ stop, never pay another worker", () => {
  it.each<[string, WorkerBehavior]>([
    ["the MCP call times out", { kind: "hang" }],
    // The 30 ms task timeout fires during a 60 ms session handshake, so the
    // abort lands before `motebit_task` is sent (a loaded machine's order).
    ["the task times out before motebit_task is sent", { kind: "hang", sessionDelayMs: 60 }],
    ["the worker answers with no result", { kind: "no_result" }],
    [
      "the worker answers text that is not a receipt",
      { kind: "text", text: "Denied: no admission" },
    ],
    ["the worker's answer is a malformed receipt", { kind: "text", text: '{"foo":"bar"}' }],
    ["the MCP transport throws", { kind: "throw" }],
  ])(
    "%s ⇒ 'paid, result not retrieved'; exactly one payment; ledger unretrieved",
    async (_l, behavior) => {
      const world: World = { fetchLog: [], toolCalls: [] };
      stubNetwork({ [A.id]: behavior, [B.id]: { kind: "receipt", receipt: receipt(B.id) } }, world);
      const { rail, landed } = makeWallet(["ok", "ok"], "truth");
      const { ledger, events, entries } = makeLedger();
      const onFailure = vi.fn();

      const err = (await adapterWith(rail, { paidLedger: ledger, onDelegationFailure: onFailure })
        .delegateStep(step(), 30)
        .catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^Paid, result not retrieved \(tx sig-1, worker worker-a\)/);
      // #890: paid, outcome unknown — the plan engine must hold, not fail.
      expect(isDelegationUndetermined(err)).toBe(true);
      expect(landed).toHaveLength(1);
      expect(world.toolCalls).toEqual([A.id]);
      expect(events).toEqual(["in_flight:sig-1", "unretrieved:sig-1"]);
      expect(entries.get(`sovereign:${A.id}:sig-1`)?.state).toBe("unretrieved");
      // A delivery blip is not a worker failure: no trust demotion target.
      expect(onFailure).toHaveBeenCalledWith(expect.anything(), 0, expect.any(String), undefined);
    },
  );

  it("a receipt whose signature does not verify ⇒ stop (a forged failure must not buy a re-hire)", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: { kind: "receipt", receipt: receipt(A.id, { status: "failed" }) },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail, landed } = makeWallet(["ok", "ok"], "truth");

    await expect(
      adapterWith(rail, { verifyReceipt: vi.fn().mockResolvedValue(false) }).delegateStep(
        step(),
        5_000,
      ),
    ).rejects.toThrow(/Paid, result not retrieved .*signature verification failed/);
    expect(landed).toHaveLength(1);
  });

  it("a failed receipt with no key to verify ⇒ stop", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: {
          kind: "receipt",
          receipt: receipt(A.id, { status: "failed", public_key: undefined }),
        },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail, landed } = makeWallet(["ok", "ok"], "truth");

    await expect(adapterWith(rail).delegateStep(step(), 5_000)).rejects.toThrow(
      /Paid, result not retrieved/,
    );
    expect(landed).toHaveLength(1);
  });

  it("a verified failed receipt signed by someone other than the paid worker ⇒ stop", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: { kind: "receipt", receipt: receipt("someone-else", { status: "failed" }) },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail, landed } = makeWallet(["ok", "ok"], "truth");

    await expect(adapterWith(rail).delegateStep(step(), 5_000)).rejects.toThrow(
      /Paid, result not retrieved/,
    );
    expect(landed).toHaveLength(1);
  });

  it("a verified failed receipt signed by the paid worker ⇒ a real failure; the next worker may be paid (as before), both recorded", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: { kind: "receipt", receipt: receipt(A.id, { status: "failed", result: "boom" }) },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail, landed } = makeWallet(["ok", "ok"], "truth");
    const { ledger, events } = makeLedger();

    const result = await adapterWith(rail, { paidLedger: ledger }).delegateStep(step(), 5_000);

    expect(result.receipt.motebit_id).toBe(B.id);
    expect(landed.map((l) => l.to)).toEqual([A.addr, B.addr]);
    expect(events).toEqual([
      "in_flight:sig-1",
      `resolve:sovereign:${A.id}:sig-1`,
      "in_flight:sig-2",
      `resolve:sovereign:${B.id}:sig-2`,
    ]);
  });
});

describe("#887 ledger — recorded before presenting, consulted before paying", () => {
  it("records the payment BEFORE the task reaches the worker", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    const order: string[] = [];
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const inner = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const raw = (init?.body as string | undefined) ?? "";
        if (raw.includes('"tools/call"')) order.push("tools/call");
        return inner(url, init);
      }),
    );
    const { rail } = makeWallet(["ok"], "truth");
    const { ledger } = makeLedger();
    vi.mocked(ledger.recordInFlight).mockImplementation(() => {
      order.push("record");
    });

    await adapterWith(rail, { paidLedger: ledger }).delegateStep(step(), 5_000);

    expect(order).toEqual(["record", "tools/call"]);
  });

  it("a worker already holding a paid, unretrieved result is refused before any money moves", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const { rail } = makeWallet(["ok"], "truth");
    const { ledger } = makeLedger();
    vi.mocked(ledger.check).mockReturnValue({
      locked: true,
      scope: "pair",
      prior: { taskId: "sovereign:worker-a:old", txHash: "old", capability: "web_search" },
    });

    const err = await adapterWith(rail, { paidLedger: ledger })
      .delegateStep(step(), 5_000)
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/Refused before payment.*tx old/);
    expect(rail.send).not.toHaveBeenCalled();
    // Nothing moved: a refusal is a conclusive outcome, not an unknown one.
    expect(isDelegationUndetermined(err)).toBe(false);
  });

  it("a ledger that cannot be read refuses before paying", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const { rail } = makeWallet(["ok"], "truth");
    const { ledger } = makeLedger();
    vi.mocked(ledger.check).mockImplementation(() => {
      throw new Error("db locked");
    });

    await expect(
      adapterWith(rail, { paidLedger: ledger }).delegateStep(step(), 5_000),
    ).rejects.toThrow(/Refused before payment/);
    expect(rail.send).not.toHaveBeenCalled();
  });

  it("a failed ledger WRITE never aborts a paid flow", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork({ [A.id]: { kind: "receipt", receipt: receipt(A.id) } }, world);
    const { rail } = makeWallet(["ok"], "truth");
    const { ledger } = makeLedger();
    vi.mocked(ledger.recordInFlight).mockImplementation(() => {
      throw new Error("disk full");
    });
    const warn = vi.fn();

    const result = await adapterWith(rail, { paidLedger: ledger, logger: { warn } }).delegateStep(
      step(),
      5_000,
    );

    expect(result.receipt.motebit_id).toBe(A.id);
    expect(warn).toHaveBeenCalledWith(
      "paid_intent_ledger.write_failed",
      expect.objectContaining({ op: "record_in_flight", txHash: "sig-1" }),
    );
  });

  it("every paid attempt's task id reaches the plan store, not only the first", async () => {
    const world: World = { fetchLog: [], toolCalls: [] };
    stubNetwork(
      {
        [A.id]: { kind: "receipt", receipt: receipt(A.id, { status: "failed" }) },
        [B.id]: { kind: "receipt", receipt: receipt(B.id) },
      },
      world,
    );
    const { rail } = makeWallet(["ok", "ok"], "truth");
    const submitted: string[] = [];

    await adapterWith(rail).delegateStep(step(), 5_000, (id) => submitted.push(id));

    expect(submitted).toEqual([`sovereign:${A.id}:sig-1`, `sovereign:${B.id}:sig-2`]);
  });
});
