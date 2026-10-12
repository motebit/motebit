/**
 * M2 — the provenance half of the target invariant, pinned.
 *
 *   "No money-moving execution exists without an owner-rooted,
 *    policy-authorized, single-use capability."
 *
 * A capability to move this runtime's money must descend from authority
 * rooted in this runtime's owner. `verifyGrantForTurn` enforces it with
 * `grantDelegatorIs`: the grant's IMMEDIATE delegator must be this runtime's
 * own identity (id AND key).
 *
 * Pinned here:
 *   1. CHAIN CHECK — a two-hop chain whose ROOT is this owner (owner → B) but
 *      whose immediate delegator is another identity (B → C) is REFUSED.
 *      `StandingDelegation` carries no parent link and `verifyGrantForTurn`
 *      takes exactly one (token, grant) pair, so the root cannot even be
 *      presented: spending authority derives from the immediate issuer only.
 *      Whether owner-rooted chains should be accepted is an open design
 *      decision (it needs a parent-linked grant shape); this test pins the
 *      current behaviour so any change to it is deliberate.
 *   2. NARROWING — an operator-issued grant naming this motebit as delegate
 *      (delegator ≠ delegate) no longer clears R4 on an owner turn: the call
 *      pauses for the human. No production issuer signs that shape.
 *   3. DEFENSE IN DEPTH — `executeToolGated` refuses an R4 call that reaches
 *      it with no verified grant even when the policy gate (simulated
 *      regression) allowed it, before any capability could be minted.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage, verifyGrantForTurn } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type {
  AIResponse,
  ContextPack,
  DelegationToken,
  StandingDelegation,
  ToolDefinition,
} from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
} from "@motebit/crypto";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const OWNER_ID = "owner-0000-0000-0000-0000000000c1";
const B_ID = "agent-b-0000-0000-0000-00000000c2";
const C_ID = "agent-c-0000-0000-0000-00000000c3";
const OPERATOR_ID = "operator-0000-0000-0000-000000c4";
const HOUR = 3_600_000;
const ARGS = { counterparty: "vendor-acme", amount_micro: 1_000_000 };
const TRANSFER: ToolDefinition = {
  name: "transfer_funds",
  mode: "api",
  description: "Transfer USDC to an address",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R4_MONEY },
};

function scriptedProvider(): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    const seenResult = history.includes("tool_result") || history.includes('"role":"tool"');
    return seenResult
      ? { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} }
      : {
          text: "",
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
          tool_calls: [{ id: "c1", name: "transfer_funds", args: { ...ARGS } }],
        };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      yield { type: "done" as const, response: gen(ctx) };
    },
  };
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function setup() {
  const owner = await generateKeypair();
  const runtime = new MotebitRuntime(
    {
      motebitId: OWNER_ID,
      tickRateHz: 0,
      signingKeys: owner,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R3_EXECUTE,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: scriptedProvider() },
  );
  const probe = { handlerRan: 0 };
  runtime.getToolRegistry().register(TRANSFER, async () => {
    probe.handlerRan++;
    return { ok: true, data: "moved" };
  });
  return { runtime, owner, probe };
}

async function grantFrom(
  delegator: Kp,
  delegatorId: string,
  delegate: Kp,
  delegateId: string,
): Promise<{ grant: StandingDelegation; token: DelegationToken }> {
  const now = Date.now();
  const grant = await signStandingDelegation(
    {
      grant_id: `grant-prov-${crypto.randomUUID()}`,
      delegator_id: delegatorId,
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: delegateId,
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "transfer_funds",
      subject: "billing:vendor=acme",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 7 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5_000_000 },
    },
    delegator.privateKey,
  );
  const token = await signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: grant.scope,
      issued_at: now,
      expires_at: now + HOUR,
      grant_id: grant.grant_id,
    },
    delegator.privateKey,
  );
  return { grant, token };
}

const id = (motebitId: string, kp: Kp) => ({ motebitId, publicKeyHex: bytesToHex(kp.publicKey) });

describe("chain check: an owner-rooted chain whose immediate delegator is another identity", () => {
  it("is REFUSED — spending authority derives from the immediate issuer, never from a chain root", async () => {
    const { runtime, owner, probe } = await setup();
    const b = await generateKeypair();
    const c = await generateKeypair();
    // Hop 1: the owner delegates to B. Valid on its own.
    const hop1 = await grantFrom(owner, OWNER_ID, b, B_ID);
    // Hop 2: B delegates (within hop 1's scope) to C.
    const hop2 = await grantFrom(b, B_ID, c, C_ID);

    // The verifier has one (token, grant) slot; hop 1 cannot be presented
    // alongside hop 2, and hop 2's immediate delegator is B, not the owner.
    expect(
      await verifyGrantForTurn(hop2.token, hop2.grant, [], {
        presenter: id(C_ID, c),
        delegator: id(OWNER_ID, owner),
      }),
    ).toBeNull();

    // End to end on the foreign task path, C presenting hop 2 as itself.
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "foreign", identity: id(C_ID, c) },
      delegation: { token: hop2.token, grant: hop2.grant, revocations: [] },
    });
    expect(result.ok).toBe(false);
    expect(probe.handlerRan).toBe(0);

    // Control: hop 1 (the owner's direct grant) does verify for its delegate.
    expect(
      await verifyGrantForTurn(hop1.token, hop1.grant, [], {
        presenter: id(B_ID, b),
        delegator: id(OWNER_ID, owner),
      }),
    ).not.toBeNull();
  });

  it("control: the owner's DIRECT grant to C moves money for C exactly once", async () => {
    const { runtime, owner, probe } = await setup();
    const c = await generateKeypair();
    const direct = await grantFrom(owner, OWNER_ID, c, C_ID);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "foreign", identity: id(C_ID, c) },
      delegation: { token: direct.token, grant: direct.grant, revocations: [] },
    });
    expect(result.ok).toBe(true);
    expect(probe.handlerRan).toBe(1);
  });
});

describe("narrowing: an OPERATOR-issued grant (delegator ≠ delegate) no longer moves money", () => {
  it("an operator's grant naming this motebit as delegate pauses the owner's R4 call for approval", async () => {
    const { runtime, owner, probe } = await setup();
    const operator = await generateKeypair();
    const g = await grantFrom(operator, OPERATOR_ID, owner, OWNER_ID);
    const out = await drain(
      runtime.sendMessageStreaming("pay acme", undefined, {
        delegation: { token: g.token, grant: g.grant, revocations: [] },
      }),
    );
    expect(out.some((c) => c.type === "approval_request")).toBe(true);
    expect(probe.handlerRan).toBe(0);
  });
});

describe("executeToolGated: an R4 call with no verified grant is refused before any mint", () => {
  it("refuses even when the policy gate (simulated regression) allowed it", async () => {
    const { runtime, probe } = await setup();
    // A gate regression that lets R4 through without a grant. The invariant
    // must not rest on the gate alone: the gated path refuses here, and the
    // registry's capability check would refuse after it.
    vi.spyOn(runtime.policy, "validate").mockReturnValue({
      allowed: true,
      requiresApproval: false,
    } as ReturnType<typeof runtime.policy.validate>);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires a verified standing grant/);
    expect(probe.handlerRan).toBe(0);
  });
});
