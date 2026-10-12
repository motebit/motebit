/**
 * A stranger's SELF-ISSUED standing grant authorizes nothing on this motebit.
 *
 * The presenter binding (a grant authorizes only its delegate) left one
 * question unasked: whose money is it? A stranger can sign a grant with
 * delegator = delegate = itself, present it as itself over a verified
 * transport, and the chain verified — signature, tick, presenter all check
 * out — so the stranger's own signature cleared R4 on THIS motebit's rail.
 * The verifier now requires the grant's delegator to be this runtime's own
 * identity (id AND key): only the owner can delegate the owner's money.
 *
 * Exercised over both serve --direct entries: the direct handler as the relay
 * / MCP `motebit_task` reaches it, and the MCP HTTP transport end to end with
 * a verified caller.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { McpServerAdapter, AgentTrustLevel } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
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
const WORKER_ID = "worker-0000-0000-0000-00000000aa01";
const STRANGER_ID = "stranger-0000-0000-0000-0000000000s1";

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
  // Metered at its rail seam: every refusal below is the delegator binding's,
  // never the blast-radius meter's (which would price an early-binding call).
  moneyBinding: "late",
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
  const moved = vi.fn(async () => ({ ok: true, data: "moved 5 USDC" }));
  runtime.getToolRegistry().register(TRANSFER, moved as never);
  return { runtime, worker, moved };
}

async function grantFrom(delegator: Kp, delegatorId: string, delegate: Kp, delegateId: string) {
  const now = Date.now();
  const grant: StandingDelegation = await signStandingDelegation(
    {
      grant_id: `grant-s-${crypto.randomUUID()}`,
      delegator_id: delegatorId,
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: delegateId,
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope: "transfer_funds",
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
    delegator.privateKey,
  );
  return { grant, token };
}

function handlerFor(
  ctx: Awaited<ReturnType<typeof setup>>,
  presented: { grant: StandingDelegation; token: DelegationToken },
) {
  return createDirectTaskHandler({
    runtime: ctx.runtime,
    motebitId: WORKER_ID,
    deviceId: "dev-s",
    publicKeyHex: bytesToHex(ctx.worker.publicKey),
    privateKey: ctx.worker.privateKey,
    preferExternalTools: false,
    log: () => {},
    delegationForTask: () => ({
      delegation: { token: presented.token, grant: presented.grant, revocations: [] },
    }),
  });
}

describe("serve --direct: a stranger's self-issued grant", () => {
  it("is refused — the handler never runs", async () => {
    const ctx = await setup();
    const stranger = await generateKeypair();
    const selfIssued = await grantFrom(stranger, STRANGER_ID, stranger, STRANGER_ID);
    let receipt: Record<string, unknown> | undefined;
    for await (const chunk of handlerFor(ctx, selfIssued)("CallerChosenAddr", {
      relayTaskId: "relay-task-s",
      caller: { motebitId: STRANGER_ID, publicKeyHex: bytesToHex(stranger.publicKey) },
    } as never)) {
      if (chunk.type === "task_result") receipt = chunk.receipt;
    }
    expect(receipt?.["status"]).not.toBe("completed");
    expect(ctx.moved).not.toHaveBeenCalled();
  });

  it("control: the owner's grant to that same caller runs", async () => {
    const ctx = await setup();
    const stranger = await generateKeypair();
    const ownerIssued = await grantFrom(ctx.worker, WORKER_ID, stranger, STRANGER_ID);
    let receipt: Record<string, unknown> | undefined;
    for await (const chunk of handlerFor(ctx, ownerIssued)("CallerChosenAddr", {
      relayTaskId: "relay-task-s2",
      caller: { motebitId: STRANGER_ID, publicKeyHex: bytesToHex(stranger.publicKey) },
    } as never)) {
      if (chunk.type === "task_result") receipt = chunk.receipt;
    }
    expect(receipt?.["status"]).toBe("completed");
    expect(ctx.moved).toHaveBeenCalledTimes(1);
  });
});

// --- MCP HTTP end to end -----------------------------------------------------

function bearerFor(mid: string): string {
  const now = Date.now();
  const claims = {
    mid,
    did: `${mid}-device`,
    iat: now,
    exp: now + 60_000,
    jti: crypto.randomUUID(),
    aud: "mcp:call",
    sub: WORKER_ID,
  };
  return `motebit:${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function post(port: number, bearer: string, body: unknown, sid?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...HEADERS,
      Authorization: `Bearer ${bearer}`,
      ...(sid != null ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

async function mcpTask(
  ctx: Awaited<ReturnType<typeof setup>>,
  presented: { grant: StandingDelegation; token: DelegationToken },
  stranger: Kp,
): Promise<string> {
  const deps: MotebitServerDeps = {
    motebitId: WORKER_ID,
    listTools: () => [],
    filterTools: (t) => t,
    // The adapter admits the `motebit_task` call itself; the money decision
    // is the runtime's (executeToolGated), reached through the direct handler.
    validateTool: (tool) => ({ allowed: tool.name === "motebit_task", requiresApproval: false }),
    executeTool: async () => ({ ok: false, error: "unused" }),
    getState: () => ({}),
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: vi.fn(
      async (token: string) =>
        JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString()) as {
          mid: string;
          did: string;
          iat: number;
          exp: number;
        },
    ),
    handleAgentTask: handlerFor(ctx, presented),
  };
  adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      knownCallers: new Map([
        [
          STRANGER_ID,
          { publicKey: bytesToHex(stranger.publicKey), trustLevel: AgentTrustLevel.Verified },
        ],
      ]),
    },
    deps,
  );
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  await adapter.start();
  const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
  const port = (server.address() as AddressInfo).port;
  const init = await post(port, bearerFor(STRANGER_ID), {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  const sid = init.res.headers.get("mcp-session-id")!;
  await post(
    port,
    bearerFor(STRANGER_ID),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sid,
  );
  const call = await post(
    port,
    bearerFor(STRANGER_ID),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "motebit_task", arguments: { prompt: "CallerChosenAddr" } },
    },
    sid,
  );
  return call.text;
}

describe("MCP motebit_task: a stranger's self-issued grant", () => {
  it("is refused over a verified MCP caller — the handler never runs", async () => {
    const ctx = await setup();
    const stranger = await generateKeypair();
    const selfIssued = await grantFrom(stranger, STRANGER_ID, stranger, STRANGER_ID);
    await mcpTask(ctx, selfIssued, stranger);
    expect(ctx.moved).not.toHaveBeenCalled();
  });

  it("control: the owner's grant to that verified caller runs over MCP", async () => {
    const ctx = await setup();
    const stranger = await generateKeypair();
    const ownerIssued = await grantFrom(ctx.worker, WORKER_ID, stranger, STRANGER_ID);
    await mcpTask(ctx, ownerIssued, stranger);
    expect(ctx.moved).toHaveBeenCalledTimes(1);
  });
});
