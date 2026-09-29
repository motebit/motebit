/**
 * #943 round 10 (owner decision) — a stdio `motebit_query` is the OWNER's.
 *
 * `servedPrincipal` defines the local stdio session as the owner, and
 * `motebit_recall` is served to it; answering the owner's own query without
 * the owner's memory was inconsistent. The served principal now travels from
 * the `motebit_query` handler into the turn: stdio ⇒ an owner turn, HTTP
 * (any credential) ⇒ a foreign turn.
 *
 * End to end: the real `McpServerAdapter`, the CLI's `servePrincipalDeps`
 * and a real `MotebitRuntime` holding an owner memory. Over stdio the
 * model's context carries the owner's memory; over HTTP it does not.
 *
 * Tampers: make the handler pass `"owner"` always (the HTTP cell goes red),
 * or make `servePrincipalDeps` force `foreignPrincipal: true` again (the
 * stdio cell goes red).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { StreamingProvider } from "@motebit/ai-core";
import { embedTextHash } from "@motebit/memory-graph";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";
import { servePrincipalDeps } from "../serve-deps.js";

const MARK = "OWNERMEMORY943Q";
const QUESTION = `what is the ${MARK} launch plan`;

function recordingProvider(contexts: ContextPack[]): StreamingProvider {
  const response: AIResponse = {
    text: "answered",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => {
      contexts.push(ctx);
      return response;
    }),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      contexts.push(ctx);
      yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

async function ownerRuntime() {
  const contexts: ContextPack[] = [];
  const runtime = new MotebitRuntime(
    { motebitId: "owner-mote-q", tickRateHz: 0 },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: recordingProvider(contexts),
    },
  );
  await runtime.memory.formMemory(
    {
      content: QUESTION,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      source: "user_stated",
    },
    embedTextHash(QUESTION),
  );
  const deps: MotebitServerDeps = {
    motebitId: "owner-mote-q",
    listTools: () => [],
    filterTools: (t) => t,
    executeTool: async () => ({ ok: true, data: "ok" }),
    logToolCall: () => {},
    getState: () => ({}),
    getMemories: async () => [],
    ...servePrincipalDeps(runtime),
    // Policy is not under test here (the default gate caps at R1); the
    // served principal is.
    validateTool: () => ({ allowed: true, requiresApproval: false }),
  };
  return { runtime, contexts, deps };
}

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

const seen = (contexts: ContextPack[]) => JSON.stringify(contexts);

describe("#943 round 10 — motebit_query: stdio is the owner's turn, HTTP a caller's", () => {
  it("stdio: the owner's query is answered with the owner's memory in context", async () => {
    const { contexts, deps } = await ownerRuntime();
    adapter = new McpServerAdapter({ transport: "stdio" }, deps);
    const server = await (
      adapter as unknown as {
        createServer(): Promise<{ connect(t: unknown): Promise<void>; close(): Promise<void> }>;
      }
    ).createServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "owner-host", version: "1" });
    await client.connect(clientSide);
    try {
      await client.callTool({ name: "motebit_query", arguments: { message: QUESTION } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(contexts.length).toBeGreaterThan(0);
    expect(seen(contexts)).toContain(`${MARK} launch plan`);
    // The recalled memory rides in relevant_memories, not only the echoed question.
    expect(contexts.some((c) => (c.relevant_memories ?? []).length > 0)).toBe(true);
  });

  it("HTTP: a caller's query recalls none of the owner's memory", async () => {
    const { contexts, deps } = await ownerRuntime();
    adapter = new McpServerAdapter(
      { transport: "http", port: 0, authToken: "shared-secret" },
      deps,
    );
    process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
    await adapter.start();
    const port = (
      (adapter as unknown as { httpServer: http.Server }).httpServer.address() as AddressInfo
    ).port;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer shared-secret",
    };
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      }),
    });
    await init.text();
    const sid = init.headers.get("mcp-session-id") ?? "";
    await (
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      })
    ).text();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "motebit_query", arguments: { message: QUESTION } },
      }),
    });
    const body = await res.text();
    expect(body).toContain("answered");
    expect(contexts.length).toBeGreaterThan(0);
    for (const c of contexts) expect(c.relevant_memories ?? []).toEqual([]);
  });
});
