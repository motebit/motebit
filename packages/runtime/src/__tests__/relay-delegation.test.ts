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
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";
import {
  base58Encode,
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
  toMicro,
  PLATFORM_FEE_RATE,
} from "@motebit/protocol";
import {
  classifyRelayError,
  submitP2pDelegation,
  resolveAndSubmitP2pDelegation,
  selectAndRunDelegation,
} from "../relay-delegation.js";

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
    // Wire key MUST be `payment_proof` — the key the relay's task handler reads
    // (tasks.ts). A prior version sent `p2p_payment_proof` (the relay's internal
    // field name), so the relay saw no proof and 402'd every paid delegation.
    expect((body.payment_proof as P2pPaymentProof).tx_hash).toBe("tx-abc");
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

// ── resolveAndSubmitP2pDelegation — discover → price → pay → submit ───────

const PINNED_BYTES = new Uint8Array(32).fill(7);
const PINNED_HEX = Array.from(PINNED_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");
const EXPECTED_TREASURY = base58Encode(PINNED_BYTES);

function routedFetch(handlers: {
  discover?: () => Response;
  eligibility?: () => Response;
  listing?: () => Response;
  submit?: () => Response;
  poll?: () => Response;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/v1/agents/discover")) return handlers.discover!();
    // Pre-flight eligibility (single-op LOCAL branch). Default eligible so the
    // existing pricing/broadcast tests aren't blocked; override to test denial.
    if (url.includes("/p2p-eligibility"))
      return (handlers.eligibility ?? (() => jsonResponse(200, { allowed: true })))();
    if (url.includes("/listing")) return handlers.listing!();
    if (url.endsWith("/task") && init?.method === "POST") return handlers.submit!();
    if (url.includes("/task/")) return handlers.poll!();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const discoverOk = (agents: unknown[]) => () => jsonResponse(200, { agents });
const listingOk = (pricing: unknown[]) => () => jsonResponse(200, { pricing });

function resolveParams(over: Record<string, unknown> = {}) {
  return {
    motebitId: "alice",
    syncUrl: "https://relay.test",
    authToken: vi.fn(async (aud?: string) => `tok-${aud}`),
    prompt: "summarize",
    capability: "web_search",
    relayPublicKeyHex: PINNED_HEX,
    buildP2pPayment: vi.fn(
      async (req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => ({
        tx_hash: "p2p-tx",
        chain: "solana",
        network: "solana:x",
        to_address: req.workerAddress,
        amount_micro: req.amountMicro,
        fee_to_address: req.treasuryAddress,
        fee_amount_micro: req.feeAmountMicro,
      }),
    ),
    logger: { warn: vi.fn() },
    ...over,
  };
}

describe("resolveAndSubmitP2pDelegation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns no_sovereign_rail when no rail can build a payment (no fetch, no broadcast)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveAndSubmitP2pDelegation(
      resolveParams({ buildP2pPayment: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_sovereign_rail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns malformed_request on an invalid pinned relay key", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await resolveAndSubmitP2pDelegation(
      resolveParams({ relayPublicKeyHex: "nothex" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_request");
  });

  it("returns no_routing when no P2P-capable worker advertises the capability", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_modes: "relay" }, // advertises relay only, no addr
          { motebit_id: "alice", settlement_address: "self", settlement_modes: "p2p" }, // self
        ]),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(resolveParams());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_routing");
  });

  it("returns worker_not_payable when the worker has no listing (404)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p,relay" },
        ]),
        listing: () => jsonResponse(404, { message: "no listing" }),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(resolveParams());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("worker_not_payable");
  });

  it("builds the payment with the PINNED treasury + canonical fee, then submits the pinned proof", async () => {
    const params = resolveParams();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p,relay" },
        ]),
        listing: listingOk([{ capability: "web_search", unit_cost: 0.5 }]),
        // Submit 400 stops us before the timer-bound poll — we assert the build
        // legs + that the pinned proof reached the submit.
        submit: () => jsonResponse(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH" }),
      }),
    );

    const result = await resolveAndSubmitP2pDelegation(params);

    const build = params.buildP2pPayment as ReturnType<typeof vi.fn>;
    expect(build).toHaveBeenCalledTimes(1);
    const req = build.mock.calls[0]![0] as SovereignP2pPaymentRequest;
    expect(req.workerAddress).toBe("BobAddr");
    // Treasury derived from the PINNED key — never a fetched value.
    expect(req.treasuryAddress).toBe(EXPECTED_TREASURY);
    expect(req.amountMicro).toBe(toMicro(0.5));
    expect(req.feeAmountMicro).toBe(computeP2pFeeMicro(toMicro(0.5), PLATFORM_FEE_RATE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_request");
  });

  it("maps an insufficient USDC balance to insufficient_balance (nothing submitted)", async () => {
    const buildP2pPayment = vi.fn(async () => {
      throw Object.assign(new Error("need more"), { name: "InsufficientUsdcBalanceError" });
    });
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" },
        ]),
        listing: listingOk([{ capability: "web_search", unit_cost: 0.5 }]),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(resolveParams({ buildP2pPayment }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("insufficient_balance");
  });

  it("maps a broadcast failure to payment_broadcast_failed (nothing settled)", async () => {
    const buildP2pPayment = vi.fn(async () => {
      throw new Error("rpc down");
    });
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" },
        ]),
        listing: listingOk([{ capability: "web_search", unit_cost: 0.5 }]),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(resolveParams({ buildP2pPayment }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_broadcast_failed");
  });

  it("pre-flight ineligible → p2p_ineligible WITHOUT broadcasting (no funds move)", async () => {
    // The money-safety guard: the relay's /p2p-eligibility read (BEFORE the
    // broadcast) reports the pair ineligible (e.g. cold-start without the ack),
    // so the client returns p2p_ineligible and NEVER calls buildP2pPayment —
    // closing the broadcast-then-403 fund-loss window. p2p_ineligible is in
    // selectAndRunDelegation's pre-broadcast fallback set (separately tested).
    const params = resolveParams();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          { motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" },
        ]),
        eligibility: () => jsonResponse(200, { allowed: false, reason: "cold-start, no ack" }),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("p2p_ineligible");
    expect(params.buildP2pPayment, "irreversible payment must NOT be built").not.toHaveBeenCalled();
  });

  // ── FEDERATED (PR-fed-3): worker on a direct peer — 3-leg fee-from-budget ──

  // A 32-byte peer relay key the origin surfaced in discovery. The executor (B)
  // treasury the client must pay is `base58Encode` of these bytes — identical to
  // the `deriveSolanaAddress` the origin recomputes when validating the forward.
  const PEER_KEY_BYTES = new Uint8Array(32).fill(9);
  const PEER_KEY_HEX = Array.from(PEER_KEY_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");
  const EXPECTED_B_TREASURY = base58Encode(PEER_KEY_BYTES);

  /** A rail builder that echoes ALL six legs (incl. the executor-fee leg). */
  const buildFederatedProof = vi.fn(
    async (req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => ({
      tx_hash: "fed-p2p-tx",
      chain: "solana",
      network: "solana:x",
      to_address: req.workerAddress,
      amount_micro: req.amountMicro,
      fee_to_address: req.treasuryAddress,
      fee_amount_micro: req.feeAmountMicro,
      ...(req.executorTreasuryAddress != null
        ? { b_fee_to_address: req.executorTreasuryAddress }
        : {}),
      ...(req.executorFeeAmountMicro != null
        ? { b_fee_amount_micro: req.executorFeeAmountMicro }
        : {}),
    }),
  );

  it("federated: prices from discovery + builds the §7.1 3-leg split with the peer-derived B treasury", async () => {
    const params = resolveParams({ buildP2pPayment: buildFederatedProof });
    vi.stubGlobal(
      "fetch",
      routedFetch({
        // A direct-peer candidate: discovery carries the peer relay key AND the
        // pricing (no /listing fetch — the origin can't serve a remote listing).
        discover: discoverOk([
          {
            motebit_id: "remote-bob",
            settlement_address: "RemoteBobAddr",
            settlement_modes: "p2p",
            source_relay_public_key: PEER_KEY_HEX,
            pricing: [{ capability: "web_search", unit_cost: 1 }],
          },
        ]),
        // Submit 400 stops us before the timer-bound poll — we assert the legs.
        submit: () => jsonResponse(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH" }),
      }),
    );

    const result = await resolveAndSubmitP2pDelegation(params);

    const build = params.buildP2pPayment as ReturnType<typeof vi.fn>;
    expect(build).toHaveBeenCalledTimes(1);
    const req = build.mock.calls[0]![0] as SovereignP2pPaymentRequest;
    const split = computeFederatedFeeSplit(toMicro(1), PLATFORM_FEE_RATE);
    expect(req.workerAddress).toBe("RemoteBobAddr");
    // Worker nets the budget minus BOTH fees — not unit_cost (that's the budget).
    expect(req.amountMicro).toBe(split.workerNetMicro);
    // Origin (A) fee → the PINNED treasury; executor (B) fee → the peer-derived one.
    expect(req.treasuryAddress).toBe(EXPECTED_TREASURY);
    expect(req.feeAmountMicro).toBe(split.originFeeMicro);
    expect(req.executorTreasuryAddress).toBe(EXPECTED_B_TREASURY);
    expect(req.executorFeeAmountMicro).toBe(split.executorFeeMicro);
    // Conservation: the three legs sum to the budget exactly.
    expect(req.amountMicro + req.feeAmountMicro + req.executorFeeAmountMicro!).toBe(toMicro(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_request");
  });

  it("federated: no separate /listing fetch (origin can't serve a remote worker's listing)", async () => {
    const listing = vi.fn(() => jsonResponse(200, { pricing: [] }));
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          {
            motebit_id: "remote-bob",
            settlement_address: "RemoteBobAddr",
            settlement_modes: "p2p",
            source_relay_public_key: PEER_KEY_HEX,
            pricing: [{ capability: "web_search", unit_cost: 1 }],
          },
        ]),
        listing,
        submit: () => jsonResponse(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH" }),
      }),
    );
    await resolveAndSubmitP2pDelegation(resolveParams({ buildP2pPayment: buildFederatedProof }));
    expect(listing).not.toHaveBeenCalled();
  });

  it("federated: worker_not_payable when the discovered remote candidate carries no price", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          {
            motebit_id: "remote-bob",
            settlement_address: "RemoteBobAddr",
            settlement_modes: "p2p",
            source_relay_public_key: PEER_KEY_HEX,
            pricing: null,
          },
        ]),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(
      resolveParams({ buildP2pPayment: buildFederatedProof }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("worker_not_payable");
  });

  it("federated: malformed_request on a non-hex peer relay key (no broadcast)", async () => {
    const build = vi.fn();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        discover: discoverOk([
          {
            motebit_id: "remote-bob",
            settlement_address: "RemoteBobAddr",
            settlement_modes: "p2p",
            source_relay_public_key: "nothex",
            pricing: [{ capability: "web_search", unit_cost: 1 }],
          },
        ]),
      }),
    );
    const result = await resolveAndSubmitP2pDelegation(resolveParams({ buildP2pPayment: build }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_request");
    expect(build).not.toHaveBeenCalled();
  });
});

// ── selectAndRunDelegation — the shared P2P-vs-relay path selector ────────

describe("selectAndRunDelegation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const buildProof = () =>
    vi.fn(
      async (req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => ({
        tx_hash: "p2p-tx",
        chain: "solana",
        network: "solana:x",
        to_address: req.workerAddress,
        amount_micro: req.amountMicro,
        fee_to_address: req.treasuryAddress,
        fee_amount_micro: req.feeAmountMicro,
      }),
    );

  const baseSelect = () => ({
    motebitId: "alice",
    syncUrl: "https://relay.test",
    authToken: vi.fn(async (aud?: string) => `tok-${aud}`),
    prompt: "do it",
    logger: { warn: vi.fn() },
  });

  it("routes to P2P when rail + pinned key + a capability are all present", async () => {
    const buildP2pPayment = buildProof();
    let discovered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/v1/agents/discover")) {
          discovered = true;
          return jsonResponse(200, {
            agents: [{ motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" }],
          });
        }
        if (url.includes("/listing"))
          return jsonResponse(200, { pricing: [{ capability: "review_pr", unit_cost: 0.5 }] });
        if (url.endsWith("/task") && init?.method === "POST")
          return jsonResponse(400, { code: "TASK_P2P_FEE_AMOUNT_MISMATCH" }); // stop before poll
        return jsonResponse(404, {});
      }),
    );

    await selectAndRunDelegation({
      ...baseSelect(),
      requiredCapabilities: ["review_pr"],
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
    });

    expect(discovered).toBe(true);
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
  });

  it("falls back to relay-mode when the pre-flight reports the pair P2P-ineligible (no broadcast)", async () => {
    // p2p_ineligible is a PRE-BROADCAST code: the relay's /p2p-eligibility read
    // said no BEFORE any payment, so it's safe to degrade to relay-mode rather
    // than surface a hard error or (the old bug) pay-then-get-403.
    const buildP2pPayment = buildProof();
    let submitBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse(200, {
            agents: [{ motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" }],
          });
        if (url.includes("/p2p-eligibility"))
          return jsonResponse(200, { allowed: false, reason: "cold-start, no ack" });
        if (url.endsWith("/task") && init?.method === "POST") {
          submitBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return jsonResponse(400, { code: "BAD" }); // stop before the poll
        }
        return jsonResponse(404, {});
      }),
    );

    await selectAndRunDelegation({
      ...baseSelect(),
      requiredCapabilities: ["review_pr"],
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
    });

    // No broadcast (pre-flight blocked it), and the fallback is relay-mode — its
    // body carries no target_agent / payment_proof.
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(submitBody!.target_agent).toBeUndefined();
    expect(submitBody!.payment_proof).toBeUndefined();
  });

  it("uses relay-mode (no P2P, no discovery) when no rail is configured", async () => {
    let submitBody: Record<string, unknown> | null = null;
    let discovered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/v1/agents/discover")) discovered = true;
        if (url.endsWith("/task") && init?.method === "POST") {
          submitBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return jsonResponse(400, { code: "BAD" });
        }
        return jsonResponse(404, {});
      }),
    );

    // relayPublicKey present but NO buildP2pPayment → relay-mode.
    await selectAndRunDelegation({
      ...baseSelect(),
      requiredCapabilities: ["review_pr"],
      relayPublicKey: PINNED_HEX,
    });

    expect(discovered).toBe(false);
    expect(submitBody!.required_capabilities).toEqual(["review_pr"]);
    expect(submitBody!.target_agent).toBeUndefined();
  });

  it("uses relay-mode when there is no capability to discover by, even if rail+key present", async () => {
    const buildP2pPayment = buildProof();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/task") && init?.method === "POST")
          return jsonResponse(400, { code: "BAD" });
        return jsonResponse(404, {});
      }),
    );

    await selectAndRunDelegation({
      ...baseSelect(),
      requiredCapabilities: [], // nothing to discover by
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
    });

    expect(buildP2pPayment).not.toHaveBeenCalled();
  });
});
