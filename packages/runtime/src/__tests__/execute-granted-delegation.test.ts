/**
 * `MotebitRuntime.executeGrantedDelegation` — the DETERMINISTIC (human-absent)
 * granted-spend path that the Clerk archetype drives. The principal-engineer
 * review of the Clerk arc found the danger precisely here: a deterministic path
 * inherits ONLY the rail-seam meter (which fail-OPENS on a null grant), not the
 * policy gate the AI loop composes with it. So this suite pins that the
 * primitive re-composes the FULL R4 AND, fail-CLOSED at every layer, and that
 * dry-run exercises the meter WITHOUT poisoning the live ceiling or broadcasting.
 *
 * Doctrine: docs/doctrine/agent-archetypes.md §6,
 * docs/doctrine/memory-never-confers-authority.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
} from "@motebit/crypto";
import { RiskLevel } from "@motebit/protocol";
import type {
  DelegationToken,
  StandingDelegation,
  SovereignWalletRail,
  SovereignP2pPaymentRequest,
  P2pPaymentProof,
} from "@motebit/protocol";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;
const NOW = Date.now();
const PINNED_HEX = "07".repeat(32);
const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";

// === Harness ===

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "unused",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: createMockProvider(),
  };
}

/** A signed grant authorizing `delegate_to_agent` with a given lifetime ceiling. */
async function makeGrant(
  delegator: Kp,
  delegate: Kp,
  opts?: { scope?: string; lifetimeMicro?: number },
): Promise<StandingDelegation> {
  return signStandingDelegation(
    {
      grant_id: "grant-clerk-1",
      delegator_id: "did:motebit:operator",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: "did:motebit:clerk",
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: opts?.scope ?? "delegate_to_agent",
      subject: "market:capability=research",
      cadence_ms: 24 * HOUR,
      issued_at: NOW,
      not_before: null,
      expires_at: NOW + 90 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: {
        schema: "motebit.spend-ceiling.v1",
        lifetime_limit_micro: opts?.lifetimeMicro ?? 10_000_000,
      },
    },
    delegator.privateKey,
  );
}

async function mintTick(grant: StandingDelegation, delegator: Kp): Promise<DelegationToken> {
  return signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: grant.scope,
      issued_at: NOW,
      expires_at: NOW + HOUR,
      grant_id: grant.grant_id,
    },
    delegator.privateKey,
  );
}

/** Mock sovereign rail — only `buildP2pPayment` is read by the live path. */
function mockWallet(build: (r: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>) {
  const buildP2pPayment = vi.fn(build);
  const wallet = { buildP2pPayment } as unknown as SovereignWalletRail;
  return { wallet, buildP2pPayment };
}

const originalFetch = globalThis.fetch;

/** Discovery + eligibility + listing for a single-operator P2P worker at $0.05. */
function relayFetch(unitCost = 0.05) {
  return async (url: string) => {
    if (url.includes("/api/v1/agents/discover")) {
      return jsonResponse({
        agents: [
          {
            motebit_id: "bob-worker",
            settlement_address: WORKER_ADDR,
            settlement_modes: "relay,p2p",
            pricing: [{ capability: "research", unit_cost: unitCost }],
          },
        ],
      });
    }
    // COLD-START GATE: a no-history pair is eligible ONLY when the caller sends
    // the ack query — mirrors the relay's real single-op eligibility fence. If
    // executeGrantedDelegation drops acknowledgeNoHistoryRisk, this returns
    // allowed:false and the spend fail-closes p2p_ineligible.
    if (url.includes("/p2p-eligibility")) {
      return jsonResponse({ allowed: url.includes("acknowledge_no_history_risk=true") });
    }
    if (url.includes("/listing"))
      return jsonResponse({ pricing: [{ capability: "research", unit_cost: unitCost }] });
    if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
    if (url.includes("/task/"))
      return jsonResponse({ task: { status: "completed" }, receipt: fakeReceipt() });
    return new Response("not found", { status: 404 });
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeReceipt() {
  return {
    task_id: "t1",
    motebit_id: "bob-worker",
    device_id: "d",
    submitted_at: NOW,
    completed_at: NOW,
    status: "completed",
    result: "done",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

/** A Clerk-shaped runtime: R4-permitting policy, injected wallet, pinned relay. */
function clerkRuntime(wallet?: SovereignWalletRail, opts?: { ack?: boolean }) {
  const ack = opts?.ack ?? true;
  const runtime = new MotebitRuntime(
    {
      motebitId: "clerk-001",
      tickRateHz: 0,
      policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
      ...(wallet ? { solanaWallet: wallet } : {}),
    },
    createAdapters(),
  );
  runtime.enableInteractiveDelegation({
    syncUrl: "https://mock-relay.test",
    authToken: async () => "test-token",
    relayPublicKey: PINNED_HEX,
    ...(wallet ? { buildP2pPayment: wallet.buildP2pPayment } : {}),
    ...(ack ? { acknowledgeNoHistoryRisk: true } : {}),
  });
  return runtime;
}

describe("executeGrantedDelegation — deterministic granted spend, fail-closed", () => {
  beforeEach(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("mock-relay.test")) return relayFetch()(url);
      return originalFetch(input as string);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("dry-run happy path: verified in-scope grant under ceiling ⇒ metered, no broadcast", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const runtime = clerkRuntime();

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.dryRun) {
      expect(result.settlement.mode).toBe("p2p");
      expect(result.settlement.paidMicro).toBe(50_000); // $0.05
    }
  });

  it("null grant (revoked) ⇒ fail-closed, requires_verified_grant, no broadcast", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const revocation = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: NOW,
      },
      operator.privateKey,
    );
    const { wallet, buildP2pPayment } = mockWallet(async () => {
      throw new Error("must not broadcast");
    });
    const runtime = clerkRuntime(wallet);

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant, revocations: [revocation] },
    });

    expect(result).toEqual({ ok: false, code: "requires_verified_grant" });
    expect(buildP2pPayment).not.toHaveBeenCalled();
  });

  it("out-of-scope grant ⇒ missing_scope, no broadcast", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk, { scope: "pay_invoice" }); // NOT delegate_to_agent
    const token = await mintTick(grant, operator);
    const { wallet, buildP2pPayment } = mockWallet(async () => {
      throw new Error("must not broadcast");
    });
    const runtime = clerkRuntime(wallet);

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
    });

    expect(result).toEqual({ ok: false, code: "missing_scope" });
    expect(buildP2pPayment).not.toHaveBeenCalled();
  });

  it("dry-run over-ceiling ⇒ refuses with the BlastRadius code, live store untouched", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk, { lifetimeMicro: 1 }); // $0.000001
    const token = await mintTick(grant, operator);
    const runtime = clerkRuntime();

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("lifetime_exceeded");
      // Owner-safe: the refusal carries a CODE, never the overage quantity.
      expect(result.code).not.toContain("micro");
    }
  });

  it("dry-run does NOT consume the live ceiling: a same-amount live spend after still settles", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    // Ceiling admits exactly ONE $0.05-plus-fee spend, not two.
    const grant = await makeGrant(operator, clerk, { lifetimeMicro: 60_000 });
    const runtime = (() => {
      const { wallet } = mockWallet(async (r) => ({
        tx_hash: "tx",
        chain: "solana",
        network: "solana:devnet",
        to_address: r.workerAddress,
        amount_micro: r.amountMicro,
        fee_to_address: r.treasuryAddress,
        fee_amount_micro: r.feeAmountMicro,
      }));
      return clerkRuntime(wallet);
    })();

    // First: a DRY run (would-be over? no — under 60k with fee). It must NOT
    // consume the live Sqlite/in-memory ceiling.
    const dry = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token: await mintTick(grant, operator), grant },
      dryRun: true,
    });
    expect(dry.ok).toBe(true);

    // Then a LIVE spend of the same amount still fits — proving the dry run
    // left the live accumulator at zero (else the second would over-ceiling).
    const live = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token: await mintTick(grant, operator), grant },
    });
    expect(live.ok).toBe(true);
    if (live.ok && !live.dryRun) expect(live.receipt).toBeDefined();
  });

  it("live over-ceiling ⇒ money_meter_denied surfaces the code, submit never reached", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk, { lifetimeMicro: 1 });
    const token = await mintTick(grant, operator);
    const { wallet, buildP2pPayment } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:devnet",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));
    const runtime = clerkRuntime(wallet);

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("lifetime_exceeded");
    // The meter threw BEFORE broadcast — the wrapped builder never produced a proof.
    expect(buildP2pPayment).not.toHaveBeenCalled();
  });

  it("threads acknowledgeNoHistoryRisk ⇒ cold-start pair is eligible (happy path reachable)", async () => {
    // The eligibility mock allows ONLY when the ack query is present. This
    // dry-run succeeds ⇒ executeGrantedDelegation sent the ack (Finding #1).
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const result = await clerkRuntime(undefined, { ack: true }).executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: true,
    });
    expect(result.ok).toBe(true);
  });

  it("WITHOUT the ack ⇒ a no-history worker fail-closes p2p_ineligible (never silently pays)", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const result = await clerkRuntime(undefined, { ack: false }).executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: true,
    });
    expect(result).toEqual({ ok: false, code: "p2p_ineligible" });
  });

  it("no relay coordinates ⇒ sync_not_enabled (fail-closed wiring)", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    // enableInteractiveDelegation NOT called → no coords stashed.
    const runtime = new MotebitRuntime({ motebitId: "clerk-x", tickRateHz: 0 }, createAdapters());

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: true,
    });
    expect(result).toEqual({ ok: false, code: "sync_not_enabled" });
  });

  it("serializes: a second granted spend while one is in flight throws", async () => {
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const runtime = clerkRuntime();

    const first = runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token: await mintTick(grant, operator), grant },
      dryRun: true,
    });
    const second = runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token: await mintTick(grant, operator), grant },
      dryRun: true,
    });

    const settled = await Promise.allSettled([first, second]);
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected.length).toBe(1);
  });
});

// Keep the StreamChunk import meaningful for the type-only harness surface.
export type _Chunk = StreamChunk;
