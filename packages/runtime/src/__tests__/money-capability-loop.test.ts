/**
 * The AI loop's money doors under the runtime capability.
 *
 * The loop (ai-core) never holds a minter: the runtime's view of the policy
 * gate records each money decision for the exact call, and the loop's
 * registry wrapper mints the capability only for a call the gate allowed
 * under a grant `verifyGrantForTurn` PRODUCED and the meter passed — or, for
 * a paused call, the approval resume mints once after a human approves.
 * A `verifiedGrant` merely shaped like one (the brand is type-only) mints
 * nothing, and a paused call cannot be executed raw before or after approval.
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

const ID = "owner-loop-money";
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
  const keys = await generateKeypair();
  const runtime = new MotebitRuntime(
    {
      motebitId: ID,
      tickRateHz: 0,
      signingKeys: keys,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        // R4 pauses for the R4 block (no grant), or clears under a verified one.
        requireApprovalAbove: RiskLevel.R3_EXECUTE,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: scriptedProvider() },
  );
  const moved = vi.fn(async () => ({ ok: true, data: "moved" }));
  runtime.getToolRegistry().register(TRANSFER, moved as never);
  const loopTools = () => runtime.getLoopDeps()!.tools!;
  return { runtime, keys, moved, loopTools };
}

async function selfGrant(keys: { publicKey: Uint8Array; privateKey: Uint8Array }) {
  const now = Date.now();
  const pub = bytesToHex(keys.publicKey);
  const grant: StandingDelegation = await signStandingDelegation(
    {
      grant_id: `grant-loop-${crypto.randomUUID()}`,
      delegator_id: ID,
      delegator_public_key: pub,
      delegate_id: ID,
      delegate_public_key: pub,
      scope: "transfer_funds",
      subject: "billing:vendor=acme",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 7 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5_000_000 },
    },
    keys.privateKey,
  );
  const token: DelegationToken = await signDelegation(
    {
      delegator_id: ID,
      delegator_public_key: pub,
      delegate_id: ID,
      delegate_public_key: pub,
      scope: grant.scope,
      issued_at: now,
      expires_at: now + HOUR,
      grant_id: grant.grant_id,
    },
    keys.privateKey,
  );
  return { grant, token };
}

describe("loop money doors", () => {
  it("a paused money call runs only through the approval resume, once", async () => {
    const { runtime, moved, loopTools } = await setup();
    const chunks = await drain(runtime.sendMessageStreaming("pay acme"));
    expect(chunks.some((c) => c.type === "approval_request")).toBe(true);
    expect(moved).not.toHaveBeenCalled();

    // Before the human decides: the loop's own registry will not run it raw.
    expect((await loopTools().execute("transfer_funds", { ...ARGS })).ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();

    await drain(runtime.resumeAfterApproval(true));
    expect(moved).toHaveBeenCalledTimes(1);

    // Single use: the approval does not leave a door open behind it.
    expect((await loopTools().execute("transfer_funds", { ...ARGS })).ok).toBe(false);
    await expect(
      runtime.getToolRegistry().execute("transfer_funds", { ...ARGS }),
    ).resolves.toMatchObject({ ok: false });
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("a denied approval leaves nothing to mint", async () => {
    const { runtime, moved } = await setup();
    await drain(runtime.sendMessageStreaming("pay acme"));
    await drain(runtime.resumeAfterApproval(false));
    const deps = (
      runtime as unknown as {
        streaming: { deps: { approvedCallCapability(n: string, a: object): unknown } };
      }
    ).streaming.deps;
    expect(deps.approvedCallCapability("transfer_funds", { ...ARGS })).toBeUndefined();
    expect(moved).not.toHaveBeenCalled();
  });

  it("a verifiedGrant SHAPED like one (not produced by verifyGrantForTurn) moves nothing", async () => {
    const { runtime, moved } = await setup();
    const forged = {
      grant_id: "forged",
      verified_at: Date.now(),
      token_issued_at: Date.now(),
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1e12 },
    };
    const out = await drain(
      runtime.sendMessageStreaming("pay acme", undefined, {
        verifiedGrant: forged as never,
        delegationScope: "transfer_funds",
      }),
    );
    // The policy gate only sees "a grant is present" and lets it through —
    // the refusal is the runtime's (meter view + capability), not a pause.
    expect(out.some((c) => c.type === "approval_request")).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });

  it("a presented self-grant clears, meters and executes the loop's call exactly once", async () => {
    const { runtime, keys, moved, loopTools } = await setup();
    const g = await selfGrant(keys);
    const out = await drain(
      runtime.sendMessageStreaming("pay acme", undefined, {
        delegation: { token: g.token, grant: g.grant, revocations: [] },
      }),
    );
    expect(out.some((c) => c.type === "approval_request")).toBe(false);
    expect(moved).toHaveBeenCalledTimes(1);
    expect((await loopTools().execute("transfer_funds", { ...ARGS })).ok).toBe(false);
    expect(moved).toHaveBeenCalledTimes(1);
  });
});
