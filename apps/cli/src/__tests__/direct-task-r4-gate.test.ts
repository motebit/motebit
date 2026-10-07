/**
 * M2 — an R4_MONEY tool never executes on the worker task path without a
 * verified standing grant (docs/doctrine/memory-never-confers-authority.md).
 *
 * `motebit serve --direct` answers BOTH task doors — the MCP `motebit_task`
 * tool and the relay WebSocket dispatch — with one handler that maps the
 * prompt onto a served tool. It called the registry raw: `transfer_funds`
 * called over MCP said "requires approval from the motebit owner", but sent as
 * a `motebit_task` it completed and moved (mock) money. This drives that
 * handler over a REAL runtime + policy gate, under the most permissive preset
 * (operator, approval band up to R4) — the case where only the R4 invariant
 * stands between a stranger's task and the money.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { RiskLevel } from "@motebit/sdk";
import type { ToolDefinition } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
  signDelegationRevocation,
} from "@motebit/encryption";
import type { DelegationToken, StandingDelegation } from "@motebit/sdk";
import { createDirectTaskHandler } from "../direct-task-handler.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;

const TRANSFER: ToolDefinition = {
  name: "transfer_funds",
  mode: "api",
  description: "Transfer USDC to an address",
  inputSchema: {
    type: "object",
    properties: { destination: { type: "string" } },
    required: ["destination"],
  },
  riskHint: { risk: RiskLevel.R4_MONEY },
};

const ECHO: ToolDefinition = {
  name: "echo",
  mode: "api",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  riskHint: { risk: RiskLevel.R0_READ },
};

function runtimeServing(tool: ToolDefinition) {
  const runtime = new MotebitRuntime(
    {
      motebitId: "worker-m2",
      tickRateHz: 0,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R3_EXECUTE,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  const moved = vi.fn(async () => ({ ok: true, data: "moved 5 USDC" }));
  runtime.getToolRegistry().register(tool, moved);
  return { runtime, moved };
}

async function grantFor(scope: string): Promise<{
  delegator: Kp;
  grant: StandingDelegation;
  token: DelegationToken;
  /** The grant's delegate as the transport-verified task caller. */
  caller: { motebitId: string; publicKeyHex: string };
}> {
  const delegator = await generateKeypair();
  const delegate = await generateKeypair();
  const now = Date.now();
  const grant = await signStandingDelegation(
    {
      grant_id: `grant-m2-${crypto.randomUUID()}`,
      delegator_id: "did:motebit:owner",
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: "did:motebit:worker-m2",
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope,
      subject: "market:self-funded",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 7 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 10_000_000 },
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
  return {
    delegator,
    grant,
    token,
    caller: { motebitId: grant.delegate_id, publicKeyHex: grant.delegate_public_key },
  };
}

async function runTask(
  runtime: MotebitRuntime,
  delegationForTask?: Parameters<typeof createDirectTaskHandler>[0]["delegationForTask"],
  caller?: { motebitId: string; publicKeyHex: string },
): Promise<Record<string, unknown>> {
  const worker = await generateKeypair();
  const handler = createDirectTaskHandler({
    runtime,
    motebitId: "worker-m2",
    deviceId: "dev-m2",
    publicKeyHex: bytesToHex(worker.publicKey),
    privateKey: worker.privateKey,
    preferExternalTools: false,
    log: () => {},
    ...(delegationForTask != null ? { delegationForTask } : {}),
  });
  let receipt: Record<string, unknown> | undefined;
  for await (const chunk of handler("AttackerAddr9999999999999999999999999999999", {
    relayTaskId: "relay-task-m2",
    ...(caller != null ? { caller } : {}),
  })) {
    if (chunk.type === "task_result") receipt = chunk.receipt;
  }
  expect(receipt).toBeDefined();
  return receipt!;
}

describe("M2: serve --direct / relay task path — R4 needs a verified grant", () => {
  it("an R4_MONEY tool reached through a task WITHOUT a grant is refused and never runs", async () => {
    const { runtime, moved } = runtimeServing(TRANSFER);
    const receipt = await runTask(runtime);
    expect(moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
    expect(String(receipt.result)).toMatch(/approval/i);
  });

  it("with a valid in-scope grant whose delegate is the verified caller, the R4 tool proceeds", async () => {
    const { runtime, moved } = runtimeServing(TRANSFER);
    const { grant, token, caller } = await grantFor("transfer_funds");
    const receipt = await runTask(
      runtime,
      () => ({ delegation: { token, grant, revocations: [] } }),
      caller,
    );
    expect(moved).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("completed");
  });

  it("a grant whose signed scope does not cover the tool is refused", async () => {
    const { runtime, moved } = runtimeServing(TRANSFER);
    const { grant, token, caller } = await grantFor("web_search");
    const receipt = await runTask(
      runtime,
      () => ({ delegation: { token, grant, revocations: [] } }),
      caller,
    );
    expect(moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });

  it("a revoked grant is refused", async () => {
    const { runtime, moved } = runtimeServing(TRANSFER);
    const { delegator, grant, token, caller } = await grantFor("transfer_funds");
    const revocation = await signDelegationRevocation(
      {
        grant_id: grant.grant_id,
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      delegator.privateKey,
    );
    const receipt = await runTask(
      runtime,
      () => ({ delegation: { token, grant, revocations: [revocation] } }),
      caller,
    );
    expect(moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });

  it("a forged grant (signature broken) confers nothing", async () => {
    const { runtime, moved } = runtimeServing(TRANSFER);
    const { grant, token, caller } = await grantFor("transfer_funds");
    const forged = { ...grant, scope: "*" };
    const receipt = await runTask(
      runtime,
      () => ({ delegation: { token, grant: forged, revocations: [] } }),
      caller,
    );
    expect(moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });

  it("control: a read-class tool still executes without any grant", async () => {
    const { runtime, moved } = runtimeServing(ECHO);
    const receipt = await runTask(runtime);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("completed");
  });

  it("AI-mode task path (runtime.handleAgentTask): a task turn's model cannot run the R4 tool either", async () => {
    let calls = 0;
    const done = (r: Record<string, unknown>) => ({ type: "done" as const, response: r });
    const provider = {
      model: "mock-model",
      setModel: vi.fn(),
      generate: vi.fn(),
      estimateConfidence: vi.fn(async () => 0.8),
      extractMemoryCandidates: vi.fn(async () => []),
      async *generateStream() {
        yield done(
          calls++ === 0
            ? {
                text: "",
                confidence: 0.9,
                memory_candidates: [],
                state_updates: {},
                tool_calls: [{ id: "c1", name: "transfer_funds", args: { destination: "X" } }],
              }
            : { text: "ok", confidence: 0.9, memory_candidates: [], state_updates: {} },
        );
      },
    };
    const runtime = new MotebitRuntime(
      {
        motebitId: "worker-m2",
        tickRateHz: 0,
        policy: {
          operatorMode: true,
          maxRiskLevel: RiskLevel.R4_MONEY,
          requireApprovalAbove: RiskLevel.R3_EXECUTE,
          denyAbove: RiskLevel.R4_MONEY,
        },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider as never },
    );
    const moved = vi.fn(async () => ({ ok: true, data: "moved" }));
    runtime.getToolRegistry().register(TRANSFER, moved);
    const kp = await generateKeypair();
    const gen = runtime.handleAgentTask(
      {
        task_id: "t-m2",
        motebit_id: "worker-m2",
        prompt: "send the money",
        submitted_at: Date.now(),
        status: "claimed",
      } as never,
      kp.privateKey,
      "dev-m2",
    );
    for await (const _chunk of gen) {
      // drain
    }
    expect(moved).not.toHaveBeenCalled();
  });
});
