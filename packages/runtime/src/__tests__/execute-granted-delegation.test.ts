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
import { explorationStrengthForStakes } from "../motebit-runtime.js";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
  verifyRoutingTranscript,
} from "@motebit/crypto";
import { recomputeRoutingDecision } from "@motebit/semiring";
import { RiskLevel, AgentTrustLevel } from "@motebit/protocol";
import type {
  DelegationToken,
  StandingDelegation,
  SovereignWalletRail,
  SovereignP2pPaymentRequest,
  P2pPaymentProof,
  AgentTrustRecord,
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

  it("pins the sub-worker via targetWorkerId ⇒ discovery honors the pin (happy path)", async () => {
    // Inc 2: a delegating molecule (the Researcher) pins its atom by motebit_id
    // instead of letting discovery pick by capability. The pin narrows discovery;
    // grant / scope / meter are unchanged.
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
      targetWorkerId: "bob-worker", // matches the discovery mock
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.dryRun) {
      expect(result.settlement.paidMicro).toBe(50_000);
    }
  });

  it("live success ⇒ accumulates first-person trust in the hired worker, scoped to the capability", async () => {
    // The WRITE side of first-person routing: a completed paid sub-hop must feed
    // the molecule's OWN ledger so future hires can rank on it — otherwise the
    // selector reads a ledger nothing fills. Verify-before-bump: only a receipt
    // that self-verifies against its embedded public_key earns credit, and the
    // competence lands in the capability's bucket (not just the aggregate).
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const worker = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const { signExecutionReceipt } = await import("@motebit/encryption");

    // A REAL self-verifiable worker receipt (embeds public_key + a valid
    // signature), the shape buildServiceReceipt produces. Long result clears the
    // quality gate so it counts as a success.
    const workerReceipt = (await signExecutionReceipt(
      {
        task_id: "t1",
        motebit_id: "bob-worker",
        device_id: "d",
        submitted_at: NOW - 2000,
        completed_at: NOW,
        status: "completed",
        result: "A".repeat(400),
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: "b".repeat(64),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      worker.privateKey,
      worker.publicKey,
    )) as unknown as Record<string, unknown>;

    const { wallet } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));
    const runtime = clerkRuntime(wallet);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse({
            agents: [
              {
                motebit_id: "bob-worker",
                settlement_address: WORKER_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 0.05 }],
              },
            ],
          });
        if (url.includes("/p2p-eligibility")) return jsonResponse({ allowed: true });
        if (url.includes("/listing"))
          return jsonResponse({ pricing: [{ capability: "research", unit_cost: 0.05 }] });
        if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
        if (url.includes("/task/"))
          return jsonResponse({ task: { status: "completed" }, receipt: workerReceipt });
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: false,
      targetWorkerId: "bob-worker",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    const trust = await runtime.getAgentTrust("bob-worker");
    expect(trust).not.toBeNull();
    expect(trust!.successful_tasks).toBe(1); // aggregate accrues
    // ...and the competence lands in the `research` bucket, not smeared across all.
    expect(trust!.capability_stats).toEqual({
      research: { successful_tasks: 1, failed_tasks: 0 },
    });
  });

  it("live success with an UNVERIFIABLE receipt (no embedded key) earns NO trust credit", async () => {
    // Honesty gate: a receipt we cannot verify against its own key must not
    // fabricate a trust edge. fakeReceipt() has signature:"sig" and no
    // public_key ⇒ the bump is skipped, the ledger stays empty.
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const { wallet } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));
    const runtime = clerkRuntime(wallet);
    vi.stubGlobal("fetch", vi.fn(relayFetch()));

    const result = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: false,
      targetWorkerId: "bob-worker",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    expect(await runtime.getAgentTrust("bob-worker")).toBeNull();
  });

  it("a targetWorkerId discovery cannot match ⇒ fail-closed, no settlement", async () => {
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
      targetWorkerId: "ghost-worker", // discovery only knows bob-worker
    });

    // The pinned worker is not discoverable/eligible → fail-closed, never pays.
    expect(result.ok).toBe(false);
  });

  it("unpinned HIGH-STAKES ⇒ pure-exploit ranks by the molecule's OWN trust ledger, hires the trusted worker", async () => {
    // First-person worker routing (docs/doctrine/first-person-worker-routing.md):
    // with NO pin, the molecule chooses among admissible candidates using its own
    // agent_trust records — the accumulated interior drawn upon. Alice is listed
    // SECOND (so first-in-discovery-order would pick Bob), but this molecule has
    // completed 20/20 tasks with her, so she wins. Proves the real runtime closure
    // (trust store → selectWorker), not just the injected-seam unit tests.
    //
    // Priced at $1.50/hop — ABOVE the exploration stakes ceiling — so exploration
    // is off (strength 0) and this is a DETERMINISTIC pure-exploit hire. The
    // low-stakes exploration path is covered separately below.
    const ALICE_ADDR = "AliceWorkerAddr2222222222222222222222222222";
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);

    const storage = createInMemoryStorage();
    await (
      storage.agentTrustStore as { setAgentTrust: (r: AgentTrustRecord) => Promise<void> }
    ).setAgentTrust({
      motebit_id: "clerk-001",
      remote_motebit_id: "alice-worker",
      trust_level: AgentTrustLevel.Trusted,
      first_seen_at: NOW - 100 * HOUR,
      last_seen_at: NOW,
      interaction_count: 20,
      successful_tasks: 20,
      failed_tasks: 0,
    });

    const { wallet, buildP2pPayment } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));

    const runtime = new MotebitRuntime(
      {
        motebitId: "clerk-001",
        tickRateHz: 0,
        policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
        solanaWallet: wallet,
      },
      { ...createAdapters(), storage },
    );
    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse({
            agents: [
              // Bob is listed FIRST but unknown to this molecule.
              {
                motebit_id: "bob-worker",
                settlement_address: WORKER_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
              // Alice is listed SECOND but trusted (20/20 completed).
              {
                motebit_id: "alice-worker",
                settlement_address: ALICE_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
            ],
          });
        if (url.includes("/p2p-eligibility")) return jsonResponse({ allowed: true });
        if (url.includes("/listing"))
          return jsonResponse({ pricing: [{ capability: "research", unit_cost: 1.5 }] });
        if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
        if (url.includes("/task/"))
          return jsonResponse({ task: { status: "completed" }, receipt: fakeReceipt() });
        return new Response("not found", { status: 404 });
      }),
    );

    await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: false,
    });

    // The broadcast paid ALICE (trusted, listed second) — not first-listed Bob.
    expect(buildP2pPayment).toHaveBeenCalled();
    expect(buildP2pPayment.mock.calls[0]![0].workerAddress).toBe(ALICE_ADDR);
    vi.unstubAllGlobals();
  });

  it("a ranked paid hire MINTS a signed routing-decision transcript that verifies on both rungs", async () => {
    // Inc 3 of docs/doctrine/routing-decision-transcript.md: the producer at
    // the WorkerSelector seam. Same deterministic two-candidate hire as above,
    // with the delegator's signing keys wired — the runtime must freeze the
    // basis from the REAL ranking pass, sign it, and retain it. Both rungs are
    // then checked: integrity (verifyRoutingTranscript) and faithfulness
    // (recomputeRoutingDecision) — the accept-on-proof loop closed end to end.
    const ALICE_ADDR = "AliceWorkerAddr2222222222222222222222222222";
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);

    const storage = createInMemoryStorage();
    await (
      storage.agentTrustStore as { setAgentTrust: (r: AgentTrustRecord) => Promise<void> }
    ).setAgentTrust({
      motebit_id: "clerk-001",
      remote_motebit_id: "alice-worker",
      trust_level: AgentTrustLevel.Trusted,
      first_seen_at: NOW - 100 * HOUR,
      last_seen_at: NOW,
      interaction_count: 20,
      successful_tasks: 20,
      failed_tasks: 0,
    });

    const { wallet, buildP2pPayment } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));

    const runtime = new MotebitRuntime(
      {
        motebitId: "clerk-001",
        tickRateHz: 0,
        policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
        solanaWallet: wallet,
        signingKeys: { privateKey: clerk.privateKey, publicKey: clerk.publicKey },
      },
      { ...createAdapters(), storage },
    );
    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse({
            agents: [
              {
                motebit_id: "bob-worker",
                settlement_address: WORKER_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
              {
                motebit_id: "alice-worker",
                settlement_address: ALICE_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
            ],
          });
        if (url.includes("/p2p-eligibility")) return jsonResponse({ allowed: true });
        if (url.includes("/listing"))
          return jsonResponse({ pricing: [{ capability: "research", unit_cost: 1.5 }] });
        if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
        if (url.includes("/task/"))
          return jsonResponse({ task: { status: "completed" }, receipt: fakeReceipt() });
        return new Response("not found", { status: 404 });
      }),
    );

    const execResult = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: false,
    });
    vi.unstubAllGlobals();

    // Inc 4 egress: the RESULT carries the transcript (what a molecule
    // self-attests from) — not just the session buffer.
    expect(execResult.ok).toBe(true);
    if (execResult.ok && !execResult.dryRun) {
      expect(execResult.routingTranscript?.winner_motebit_id).toBe("alice-worker");
    }

    const transcripts = runtime.getRecentRoutingTranscripts();
    expect(transcripts).toHaveLength(1);
    const t = transcripts[0]!;
    expect(t.winner_motebit_id).toBe("alice-worker");
    expect(t.capability).toBe("research");
    expect(t.delegator_motebit_id).toBe("clerk-001");
    expect(t.seed).toBe(token.signature); // seed provenance = the signed tick
    expect(t.candidates).toHaveLength(2);
    // Rung 1 — integrity: the delegator committed to this decision record.
    expect(await verifyRoutingTranscript(t)).toEqual({ valid: true });
    // Rung 2 — faithfulness: the recorded winner follows from the frozen inputs.
    expect(recomputeRoutingDecision(t)).toEqual({
      consistent: true,
      recomputed_winner: "alice-worker",
    });
    // Tamper — the record is not editable after the fact.
    expect(await verifyRoutingTranscript({ ...t, explored: !t.explored })).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("SEVERING (reintroduces #357): the SAME paid hire WITHOUT delegator signing keys settles but mints NO transcript — proving the assertion above catches a dormant producer", async () => {
    // docs/doctrine/composition-preserves-enforcement.md — the severing test.
    // The happy-path case above asserts the transcript is PRESENT; that only
    // proves enforcement if the assertion goes red when the guarantee is
    // severed. #357 was exactly this: defaultCreateMoneyRuntime never passed
    // signingKeys, so `_signingKeys` was null in every deployed molecule and
    // the Inc 3 producer skipped minting — honestly (reveals-never-authorizes)
    // but everywhere. Here we reproduce that condition (omit `signingKeys` from
    // the runtime) and prove the paid hire STILL succeeds while the transcript
    // is absent from BOTH the result and the buffer. If a future change made
    // the producer mint without keys, or made the happy-path assertion pass
    // vacuously, THIS test would fail — that is its whole job.
    const ALICE_ADDR = "AliceWorkerAddr2222222222222222222222222222";
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);

    const storage = createInMemoryStorage();
    await (
      storage.agentTrustStore as { setAgentTrust: (r: AgentTrustRecord) => Promise<void> }
    ).setAgentTrust({
      motebit_id: "clerk-001",
      remote_motebit_id: "alice-worker",
      trust_level: AgentTrustLevel.Trusted,
      first_seen_at: NOW - 100 * HOUR,
      last_seen_at: NOW,
      interaction_count: 20,
      successful_tasks: 20,
      failed_tasks: 0,
    });

    const { wallet, buildP2pPayment } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));

    const runtime = new MotebitRuntime(
      {
        motebitId: "clerk-001",
        tickRateHz: 0,
        policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
        solanaWallet: wallet,
        // signingKeys DELIBERATELY OMITTED — this is the #357 dormancy condition.
      },
      { ...createAdapters(), storage },
    );
    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse({
            agents: [
              {
                motebit_id: "bob-worker",
                settlement_address: WORKER_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
              {
                motebit_id: "alice-worker",
                settlement_address: ALICE_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 1.5 }],
              },
            ],
          });
        if (url.includes("/p2p-eligibility")) return jsonResponse({ allowed: true });
        if (url.includes("/listing"))
          return jsonResponse({ pricing: [{ capability: "research", unit_cost: 1.5 }] });
        if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
        if (url.includes("/task/"))
          return jsonResponse({ task: { status: "completed" }, receipt: fakeReceipt() });
        return new Response("not found", { status: 404 });
      }),
    );

    const execResult = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey the topic",
      delegation: { token, grant },
      dryRun: false,
    });
    vi.unstubAllGlobals();

    // The hire STILL settles — the transcript reveals, it never authorizes, so
    // its absence must not break the money path.
    expect(execResult.ok).toBe(true);
    // …but the transcript is absent from the RESULT seam a molecule consumes…
    if (execResult.ok && !execResult.dryRun) {
      expect(execResult.routingTranscript).toBeUndefined();
    }
    // …and from the session buffer. Dormant producer, exactly as #357.
    expect(runtime.getRecentRoutingTranscripts()).toHaveLength(0);
  });

  it("unpinned LOW-STAKES ⇒ exploration engaged at full strength (the newcomer on-ramp is live)", async () => {
    // docs/doctrine/exploration-as-market-vitality.md: a cheap hop ($0.003, below
    // the stakes floor) explores at full strength — a newcomer can earn a first
    // shot. We don't assert WHO wins (a seeded Thompson draw, covered
    // deterministically in @motebit/semiring); we assert the runtime WIRED
    // exploration — the routing decision is surfaced with strength 1 over BOTH
    // candidates, seeded from the signed tick token.
    const ALICE_ADDR = "AliceWorkerAddr2222222222222222222222222222";
    const operator = await generateKeypair();
    const clerk = await generateKeypair();
    const grant = await makeGrant(operator, clerk);
    const token = await mintTick(grant, operator);
    const logger = { warn: vi.fn() };

    const storage = createInMemoryStorage();
    await (
      storage.agentTrustStore as { setAgentTrust: (r: AgentTrustRecord) => Promise<void> }
    ).setAgentTrust({
      motebit_id: "clerk-001",
      remote_motebit_id: "alice-worker",
      trust_level: AgentTrustLevel.Trusted,
      first_seen_at: NOW - 100 * HOUR,
      last_seen_at: NOW,
      interaction_count: 20,
      successful_tasks: 20,
      failed_tasks: 0,
    });

    const { wallet, buildP2pPayment } = mockWallet(async (r) => ({
      tx_hash: "tx",
      chain: "solana",
      network: "solana:x",
      to_address: r.workerAddress,
      amount_micro: r.amountMicro,
      fee_to_address: r.treasuryAddress,
      fee_amount_micro: r.feeAmountMicro,
    }));

    const runtime = new MotebitRuntime(
      {
        motebitId: "clerk-001",
        tickRateHz: 0,
        policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
        solanaWallet: wallet,
        logger,
      },
      { ...createAdapters(), storage },
    );
    runtime.enableInteractiveDelegation({
      syncUrl: "https://mock-relay.test",
      authToken: async () => "test-token",
      relayPublicKey: PINNED_HEX,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/v1/agents/discover"))
          return jsonResponse({
            agents: [
              {
                motebit_id: "bob-worker",
                settlement_address: WORKER_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 0.003 }],
              },
              {
                motebit_id: "alice-worker",
                settlement_address: ALICE_ADDR,
                settlement_modes: "p2p",
                pricing: [{ capability: "research", unit_cost: 0.003 }],
              },
            ],
          });
        if (url.includes("/p2p-eligibility")) return jsonResponse({ allowed: true });
        if (url.includes("/listing"))
          return jsonResponse({ pricing: [{ capability: "research", unit_cost: 0.003 }] });
        if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
        if (url.includes("/task/"))
          return jsonResponse({ task: { status: "completed" }, receipt: fakeReceipt() });
        return new Response("not found", { status: 404 });
      }),
    );

    await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: false,
    });

    const decision = logger.warn.mock.calls.find((c) => c[0] === "routing.worker_selected");
    expect(decision).toBeDefined();
    expect(decision![1]).toMatchObject({ candidates: 2, strength: 1 });
    vi.unstubAllGlobals();
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

describe("explorationStrengthForStakes — explore where mistakes are cheap", () => {
  it("full exploration at/below the floor (micro-priced hops)", () => {
    expect(explorationStrengthForStakes(0)).toBe(1);
    expect(explorationStrengthForStakes(0.003)).toBe(1);
    expect(explorationStrengthForStakes(0.1)).toBe(1); // at the floor
  });

  it("pure exploit at/above the ceiling (dollar-scale hops)", () => {
    expect(explorationStrengthForStakes(1.0)).toBe(0); // at the ceiling
    expect(explorationStrengthForStakes(2.5)).toBe(0);
  });

  it("ramps linearly between floor and ceiling", () => {
    expect(explorationStrengthForStakes(0.55)).toBeCloseTo(0.5, 5); // midpoint
    expect(explorationStrengthForStakes(0.325)).toBeCloseTo(0.75, 5);
  });

  it("degenerate inputs (NaN / negative) fail safe to full exploration", () => {
    expect(explorationStrengthForStakes(Number.NaN)).toBe(1);
    expect(explorationStrengthForStakes(-5)).toBe(1);
  });
});

// Keep the StreamChunk import meaningful for the type-only harness surface.
export type _Chunk = StreamChunk;
