/**
 * M2 probe — whose money does a standing grant authorize?
 *
 * Target invariant: no money-moving execution exists without an owner-rooted,
 * policy-authorized, single-use capability
 * (docs/doctrine/memory-never-confers-authority.md). This file pins the
 * PROVENANCE half: a capability to move this runtime's money must descend
 * from authority rooted in this runtime's owner.
 *
 * A stranger can sign a standing grant with delegator = delegate = itself.
 * Signature, tick and scope all verify — the grant is internally consistent —
 * but the stranger was never entitled to delegate THIS motebit's money. Presented
 * on an owner turn, it must clear nothing: the R4 call pauses for the human.
 *
 * Controls (the legitimate flows, which must stay byte-identical):
 *   - no grant: the R4 call pauses → the human approves → exactly one move;
 *   - the owner's OWN self-grant: exactly one move, no pause.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
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
const OWNER_ID = "owner-0000-0000-0000-0000000000o1";
const STRANGER_ID = "stranger-0000-0000-0000-00000000s9";
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
    if (!seenResult) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "c1", name: "transfer_funds", args: { ...ARGS } }],
      };
    }
    return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
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

/** A grant signed by `delegator` (as `delegatorId`) to `delegate` (as `delegateId`). */
async function grantFrom(
  delegator: Kp,
  delegatorId: string,
  delegate: Kp,
  delegateId: string,
): Promise<{ grant: StandingDelegation; token: DelegationToken }> {
  const now = Date.now();
  const grant = await signStandingDelegation(
    {
      grant_id: `grant-m2-${crypto.randomUUID()}`,
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

describe("M2 probe: a standing grant's provenance on an owner turn", () => {
  it("a STRANGER's self-issued grant (delegator = delegate = stranger) moves nothing — the R4 call pauses", async () => {
    const { runtime, probe } = await setup();
    const stranger = await generateKeypair();
    const g = await grantFrom(stranger, STRANGER_ID, stranger, STRANGER_ID);
    const out = await drain(
      runtime.sendMessageStreaming("pay acme", undefined, {
        delegation: { token: g.token, grant: g.grant, revocations: [] },
      }),
    );
    expect(probe.handlerRan).toBe(0);
    expect(out.some((c) => c.type === "approval_request")).toBe(true);
  });

  it("control: no grant — the R4 call pauses, the human approves, exactly one move", async () => {
    const { runtime, probe } = await setup();
    const out = await drain(runtime.sendMessageStreaming("pay acme"));
    expect(out.some((c) => c.type === "approval_request")).toBe(true);
    expect(probe.handlerRan).toBe(0);
    await drain(runtime.resumeAfterApproval(true));
    expect(probe.handlerRan).toBe(1);
  });

  it("control: the owner's OWN self-grant — exactly one move, no pause", async () => {
    const { runtime, owner, probe } = await setup();
    const g = await grantFrom(owner, OWNER_ID, owner, OWNER_ID);
    const out = await drain(
      runtime.sendMessageStreaming("pay acme", undefined, {
        delegation: { token: g.token, grant: g.grant, revocations: [] },
      }),
    );
    expect(out.some((c) => c.type === "approval_request")).toBe(false);
    expect(probe.handlerRan).toBe(1);
  });
});
