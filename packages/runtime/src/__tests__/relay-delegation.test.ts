/**
 * classifyRelayError — relay error envelope → closed DelegationErrorCode.
 *
 * Focused on the Arc 3.5 boundary: a paid cross-agent delegation rejected by the
 * P2P-by-default gate returns 402 with `code: "TASK_P2P_PROOF_REQUIRED"`, and the
 * client must report `payment_proof_required` (honest: "this path settles P2P"),
 * NOT `insufficient_balance` (misleading: implies a funding shortfall). The
 * gate-code branch sits before the generic 402 branch; this locks that order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { P2pPaymentProof } from "@motebit/protocol";
import { classifyRelayError, submitP2pDelegation } from "../relay-delegation.js";

const envelope = (code: string, error = "rejected") => JSON.stringify({ code, error });

describe("classifyRelayError — Arc 3.5 402 disambiguation", () => {
  it("maps 402 TASK_P2P_PROOF_REQUIRED → payment_proof_required (not insufficient_balance)", () => {
    const result = classifyRelayError(402, envelope("TASK_P2P_PROOF_REQUIRED"));
    expect(result.code).toBe("payment_proof_required");
    expect(result.status).toBe(402);
  });

  it("maps 402 INSUFFICIENT_FUNDS → insufficient_balance", () => {
    expect(classifyRelayError(402, envelope("INSUFFICIENT_FUNDS")).code).toBe(
      "insufficient_balance",
    );
  });

  it("maps a bare 402 (no code) → insufficient_balance", () => {
    expect(classifyRelayError(402, "Payment Required").code).toBe("insufficient_balance");
  });

  it("preserves the relay's error message for the gate code", () => {
    const result = classifyRelayError(402, envelope("TASK_P2P_PROOF_REQUIRED", "needs a proof"));
    expect(result.message).toBe("needs a proof");
  });
});

// ── submitP2pDelegation — the paid pinned-worker P2P transport core ──────

const PROOF: P2pPaymentProof = {
  tx_hash: "tx-abc",
  chain: "solana",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  to_address: "Worker1111111111111111111111111111111111111",
  amount_micro: 500_000,
  fee_to_address: "Treasury11111111111111111111111111111111111",
  fee_amount_micro: 26_316,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (k: string) => headers[k] ?? null },
  } as unknown as Response;
}

function baseParams() {
  return {
    motebitId: "alice",
    syncUrl: "https://relay.test",
    authToken: vi.fn(async (aud?: string) => `tok-${aud}`),
    prompt: "summarize this",
    targetWorkerId: "bob",
    paymentProof: PROOF,
    logger: { warn: vi.fn() },
  };
}

describe("submitP2pDelegation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("submits a pinned p2p body (target_agent + settlement_mode + proof) keyed on the tx_hash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { task_id: "task-1" }));
    // A pre-aborted signal makes the poll return immediately — we only assert
    // the submit shape here, not the (timer-bound) poll.
    const controller = new AbortController();
    controller.abort();

    const result = await submitP2pDelegation({ ...baseParams(), signal: controller.signal });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.test/agent/alice/task");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.target_agent).toBe("bob");
    expect(body.settlement_mode).toBe("p2p");
    expect(body.submitted_by).toBe("alice");
    expect((body.p2p_payment_proof as P2pPaymentProof).tx_hash).toBe("tx-abc");
    // Idempotency keyed on the onchain tx so a re-submit dedupes, never re-pays.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("tx-abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });

  it("maps a relay proof rejection (400) → malformed_request and never polls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH", error: "fee mismatch" }),
    );
    const result = await submitP2pDelegation(baseParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed_request");
      expect(result.error.status).toBe(400);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns auth_expired when token minting fails (no submit attempted)", async () => {
    const result = await submitP2pDelegation({
      ...baseParams(),
      authToken: vi.fn(async () => {
        throw new Error("no keys");
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("auth_expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns network_unreachable when the submit fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await submitP2pDelegation(baseParams());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("network_unreachable");
  });

  it("returns the verified receipt on a successful submit + poll", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { task_id: "task-2" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { task: { status: "completed" }, receipt: { result_hash: "rh" } }),
      );

    const promise = submitP2pDelegation(baseParams());
    // Flush microtasks (auth + submit) and fire the first poll interval.
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe("task-2");
      expect(result.receipt).toMatchObject({ result_hash: "rh" });
    }
  });
});
