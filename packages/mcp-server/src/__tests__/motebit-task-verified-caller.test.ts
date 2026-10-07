/**
 * `motebit_task` hands its handler the caller the transport VERIFIED — the
 * caller-signed bearer's `mid` and the key its signature verified under — so
 * a handler acting on standing authority (`motebit serve --direct --grant`)
 * binds the grant to that caller, never to task content. A request whose
 * transport verified no caller identity hands over none.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServerAdapter, AgentTrustLevel } from "../index.js";
import type { MotebitServerDeps } from "../index.js";

const WORKER = "worker-0000-0000-0000-00000000f0f1";
const KEY_A = "aa".repeat(32);

function bearerFor(mid: string): string {
  const now = Date.now();
  const claims = {
    mid,
    did: `${mid}-device`,
    iat: now,
    exp: now + 60_000,
    jti: crypto.randomUUID(),
    aud: "mcp:call",
    sub: WORKER,
  };
  return `motebit:${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

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
  await res.text();
  return res;
}

describe("motebit_task — verified caller reaches the handler", () => {
  it("passes the caller-signed bearer's mid and verified key", async () => {
    const seen: unknown[] = [];
    const deps: MotebitServerDeps = {
      motebitId: WORKER,
      listTools: () => [],
      filterTools: (t) => t,
      validateTool: () => ({ allowed: true, requiresApproval: false }),
      executeTool: async () => ({ ok: true, data: "ok" }),
      getState: () => ({}),
      getMemories: async () => [],
      logToolCall: () => {},
      verifySignedToken: vi.fn(async (token: string) => {
        return JSON.parse(
          Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString(),
        ) as { mid: string; did: string; iat: number; exp: number };
      }),
      handleAgentTask: async function* (_prompt, options) {
        seen.push(options?.caller);
        yield { type: "task_result" as const, receipt: { status: "completed" } };
      },
    };
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: 0,
        knownCallers: new Map([
          ["caller-a", { publicKey: KEY_A, trustLevel: AgentTrustLevel.Verified }],
        ]),
      },
      deps,
    );
    process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
    await adapter.start();
    const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
    const port = (server.address() as AddressInfo).port;

    const init = await post(port, bearerFor("caller-a"), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const sid = init.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    await post(
      port,
      bearerFor("caller-a"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
    );
    await post(
      port,
      bearerFor("caller-a"),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "motebit_task", arguments: { prompt: "pay CallerChosenAddr" } },
      },
      sid,
    );
    expect(seen).toEqual([{ motebitId: "caller-a", publicKeyHex: KEY_A }]);
  });
});
