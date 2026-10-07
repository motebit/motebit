/**
 * Finding 1 — on `motebit serve --direct` the task submitter is a FOREIGN
 * principal, and the owner's grant never authorizes a foreign caller.
 *
 * `serve --direct --grant <id>` presented the OWNER's stored grant to every
 * task, and the direct handler mapped the task's prompt onto the served
 * tool's first string argument. So any task submitter chose the destination
 * — `transfer_funds({ destination: <prompt> })` — and spent up to the grant's
 * ceiling, executing as the owner (`principal.foreign === false`).
 *
 * The rule: a task arriving over serve --direct (MCP `motebit_task` or relay
 * WebSocket dispatch) runs as a foreign principal. R4 on a foreign call is
 * refused unless the presented grant's delegate IS the verified caller (the
 * caller identity the transport authenticated — never the prompt) and the
 * call is inside that grant's scope/ceiling.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { RiskLevel } from "@motebit/sdk";
import type { DelegationToken, StandingDelegation, ToolDefinition } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
} from "@motebit/encryption";
import { createDirectTaskHandler } from "../direct-task-handler.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;
const WORKER_ID = "worker-foreign";
const CALLER_DEST = "CallerChosenAddr11111111111111111111111111111";

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

async function setup() {
  const worker = await generateKeypair();
  const runtime = new MotebitRuntime(
    {
      motebitId: WORKER_ID,
      tickRateHz: 0,
      signingKeys: worker,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R3_EXECUTE,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  const calls: Array<{ args: Record<string, unknown>; foreign: boolean | undefined }> = [];
  const moved = vi.fn(
    async (args: Record<string, unknown>, call?: { principal?: { foreign?: boolean } }) => {
      calls.push({ args, foreign: call?.principal?.foreign });
      return { ok: true, data: "moved 5 USDC" };
    },
  );
  runtime.getToolRegistry().register(TRANSFER, moved as never);
  return { runtime, worker, moved, calls };
}

/** A grant signed by the worker (the owner's key) to `delegateId`/`delegate`. */
async function grantFrom(owner: Kp, delegateId: string, delegate: Kp, scope = "transfer_funds") {
  const now = Date.now();
  const grant: StandingDelegation = await signStandingDelegation(
    {
      grant_id: `grant-f-${crypto.randomUUID()}`,
      delegator_id: WORKER_ID,
      delegator_public_key: bytesToHex(owner.publicKey),
      delegate_id: delegateId,
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
    owner.privateKey,
  );
  const token: DelegationToken = await signDelegation(
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
    owner.privateKey,
  );
  return { grant, token };
}

async function runTask(
  ctx: Awaited<ReturnType<typeof setup>>,
  presented: { grant: StandingDelegation; token: DelegationToken } | null,
  caller: { motebitId: string; publicKeyHex: string } | undefined,
): Promise<Record<string, unknown>> {
  const handler = createDirectTaskHandler({
    runtime: ctx.runtime,
    motebitId: WORKER_ID,
    deviceId: "dev-f",
    publicKeyHex: bytesToHex(ctx.worker.publicKey),
    privateKey: ctx.worker.privateKey,
    preferExternalTools: false,
    log: () => {},
    ...(presented != null
      ? {
          delegationForTask: () => ({
            delegation: { token: presented.token, grant: presented.grant, revocations: [] },
          }),
        }
      : {}),
  });
  let receipt: Record<string, unknown> | undefined;
  for await (const chunk of handler(CALLER_DEST, {
    relayTaskId: "relay-task-f",
    ...(caller != null ? { caller } : {}),
  } as never)) {
    if (chunk.type === "task_result") receipt = chunk.receipt;
  }
  expect(receipt).toBeDefined();
  return receipt!;
}

describe("finding 1: serve --direct task submitter is a foreign principal", () => {
  it("a verified remote caller cannot ride the owner's self-grant to a destination it chose", async () => {
    const ctx = await setup();
    const ownerSelfGrant = await grantFrom(ctx.worker, WORKER_ID, ctx.worker);
    const stranger = await generateKeypair();
    const receipt = await runTask(ctx, ownerSelfGrant, {
      motebitId: "stranger-b",
      publicKeyHex: bytesToHex(stranger.publicKey),
    });
    expect(ctx.moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
    expect(String(receipt.result)).toMatch(/foreign|delegate/i);
  });

  it("a relay-dispatched task (no verified caller identity) cannot ride the owner's grant", async () => {
    const ctx = await setup();
    const ownerSelfGrant = await grantFrom(ctx.worker, WORKER_ID, ctx.worker);
    const receipt = await runTask(ctx, ownerSelfGrant, undefined);
    expect(ctx.moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });

  it("a caller claiming the delegate's id without its key is refused", async () => {
    const ctx = await setup();
    const b = await generateKeypair();
    const imposter = await generateKeypair();
    const grantToB = await grantFrom(ctx.worker, "caller-b", b);
    const receipt = await runTask(ctx, grantToB, {
      motebitId: "caller-b",
      publicKeyHex: bytesToHex(imposter.publicKey),
    });
    expect(ctx.moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });

  it("a grant whose delegate IS the verified caller authorizes — and the call runs foreign", async () => {
    const ctx = await setup();
    const b = await generateKeypair();
    const grantToB = await grantFrom(ctx.worker, "caller-b", b);
    const receipt = await runTask(ctx, grantToB, {
      motebitId: "caller-b",
      publicKeyHex: bytesToHex(b.publicKey),
    });
    expect(receipt.status).toBe("completed");
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.args).toEqual({ destination: CALLER_DEST });
    expect(ctx.calls[0]!.foreign).toBe(true);
  });

  it("the caller's grant outside its signed scope is refused", async () => {
    const ctx = await setup();
    const b = await generateKeypair();
    const grantToB = await grantFrom(ctx.worker, "caller-b", b, "web_search");
    const receipt = await runTask(ctx, grantToB, {
      motebitId: "caller-b",
      publicKeyHex: bytesToHex(b.publicKey),
    });
    expect(ctx.moved).not.toHaveBeenCalled();
    expect(receipt.status).toBe("failed");
  });
});
