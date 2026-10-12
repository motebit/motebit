/**
 * M2 probe — an R4_MONEY tool reached through either `serve --direct` task
 * door must never run its handler without the policy gate.
 *
 * Target invariant: no money-moving execution exists without an owner-rooted,
 * policy-authorized, single-use capability
 * (docs/doctrine/memory-never-confers-authority.md).
 *
 * Both doors land on the one direct handler (`direct-task-handler.ts`):
 *   - relay WebSocket dispatch: `handleTask(task.prompt, { relayTaskId })`,
 *     no caller identity (daemon.ts, `serveWsAdapter.onTask`);
 *   - MCP `motebit_task`: the adapter's tool calls `deps.handleAgentTask`.
 * The MCP door is driven end to end over the HTTP transport.
 *
 * The runtime is under the operator preset (approval band up to R4,
 * `denyAbove` R4) — the most permissive configuration, where only the R4
 * invariant stands between a stranger's task and the owner's money. The
 * counter `handlerRan` is the probe: an R4 handler that runs is money moved.
 */
import { describe, it, expect, afterEach } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { McpServerAdapter, AgentTrustLevel } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { RiskLevel } from "@motebit/sdk";
import type { ToolDefinition } from "@motebit/sdk";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createDirectTaskHandler } from "../direct-task-handler.js";

const WORKER_ID = "worker-0000-0000-0000-0000000000p1";
const CALLER_ID = "caller-0000-0000-0000-0000000000p2";

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

async function serving(tool: ToolDefinition) {
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
  const probe = { handlerRan: 0 };
  runtime.getToolRegistry().register(tool, async () => {
    probe.handlerRan++;
    return { ok: true, data: tool === TRANSFER ? "moved 5 USDC" : "echoed" };
  });
  const handler = createDirectTaskHandler({
    runtime,
    motebitId: WORKER_ID,
    deviceId: "dev-probe",
    publicKeyHex: bytesToHex(worker.publicKey),
    privateKey: worker.privateKey,
    preferExternalTools: false,
    log: () => {},
  });
  return { runtime, handler, probe };
}

/** The relay WebSocket door, exactly as daemon.ts calls it. */
async function relayDoor(
  handler: Awaited<ReturnType<typeof serving>>["handler"],
  prompt: string,
): Promise<Record<string, unknown> | undefined> {
  let receipt: Record<string, unknown> | undefined;
  for await (const chunk of handler(prompt, { relayTaskId: "relay-task-probe" })) {
    if (chunk.type === "task_result") receipt = chunk.receipt;
  }
  return receipt;
}

// --- MCP HTTP door -----------------------------------------------------------

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

async function post(port: number, body: unknown, sid?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearerFor(CALLER_ID)}`,
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

/** The MCP `motebit_task` door, over the HTTP transport with a verified caller. */
async function mcpDoor(
  handler: Awaited<ReturnType<typeof serving>>["handler"],
  prompt: string,
): Promise<string> {
  const caller = await generateKeypair();
  const deps: MotebitServerDeps = {
    motebitId: WORKER_ID,
    listTools: () => [],
    filterTools: (t) => t,
    // The adapter admits the `motebit_task` call itself; whatever runs after
    // that is the direct handler's (and so the runtime's) decision.
    validateTool: (tool) => ({ allowed: tool.name === "motebit_task", requiresApproval: false }),
    executeTool: async () => ({ ok: false, error: "unused" }),
    getState: () => ({}),
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: async (token: string) =>
      JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString()) as {
        mid: string;
        did: string;
        iat: number;
        exp: number;
      },
    handleAgentTask: handler,
  };
  adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      knownCallers: new Map([
        [
          CALLER_ID,
          { publicKey: bytesToHex(caller.publicKey), trustLevel: AgentTrustLevel.Verified },
        ],
      ]),
    },
    deps,
  );
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  await adapter.start();
  const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
  const port = (server.address() as AddressInfo).port;
  const init = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "p", version: "1" },
    },
  });
  const sid = init.res.headers.get("mcp-session-id")!;
  await post(port, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const call = await post(
    port,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "motebit_task", arguments: { prompt } },
    },
    sid,
  );
  return call.text;
}

describe("M2 probe: R4 through the serve --direct task doors", () => {
  it("relay WebSocket door: an R4_MONEY task never runs the handler (no grant, operator preset)", async () => {
    const { handler, probe } = await serving(TRANSFER);
    const receipt = await relayDoor(handler, "AttackerAddr9999999999999999999999999999999");
    expect(probe.handlerRan).toBe(0);
    expect(receipt?.["status"]).toBe("failed");
  });

  it("MCP motebit_task door: an R4_MONEY task never runs the handler (no grant, operator preset)", async () => {
    const { handler, probe } = await serving(TRANSFER);
    await mcpDoor(handler, "AttackerAddr9999999999999999999999999999999");
    expect(probe.handlerRan).toBe(0);
  });

  it("control: an R0 tool still runs through the relay WebSocket door", async () => {
    const { handler, probe } = await serving(ECHO);
    const receipt = await relayDoor(handler, "hello");
    expect(probe.handlerRan).toBe(1);
    expect(receipt?.["status"]).toBe("completed");
  });

  it("control: an R0 tool still runs through the MCP motebit_task door", async () => {
    const { handler, probe } = await serving(ECHO);
    await mcpDoor(handler, "hello");
    expect(probe.handlerRan).toBe(1);
  });
});
