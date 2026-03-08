/**
 * Integration test — proves multi-hop delegation:
 * caller → summarize (motebit_task) → web-search (motebit_task) → web_search tool
 *
 * Verifies nested receipt chains: summarize receipt contains web-search receipt.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import {
  InMemoryToolRegistry,
  webSearchDefinition,
  readUrlDefinition,
} from "@motebit/tools";
import type { ToolResult, ExecutionReceipt } from "@motebit/sdk";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { McpClientAdapter } from "@motebit/mcp-client";
import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifyReceiptChain,
  verifySignedToken,
  hash as sha256,
} from "@motebit/crypto";
import { generate as generateIdentity } from "@motebit/identity-file";
import { createSummarizeSearchHandler, summarizeSearchDefinition } from "../tool.js";

// Deterministic test IDs
const WS_MOTEBIT_ID = "01961234-0001-7abc-def0-111111111111";
const SUM_MOTEBIT_ID = "01961234-0002-7abc-def0-222222222222";
const WS_PORT = 39210;
const SUM_PORT = 39211;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stripIdentityTag(text: string): string {
  return text.replace(/\n\[motebit:[^\]]+\]$/, "");
}

// Static search results for deterministic testing
const STATIC_RESULTS = JSON.stringify([
  { title: "Result 1", url: "https://example.com/1", snippet: "First result" },
  { title: "Result 2", url: "https://example.com/2", snippet: "Second result" },
  { title: "Result 3", url: "https://example.com/3", snippet: "Third result" },
  { title: "Result 4", url: "https://example.com/4", snippet: "Fourth result" },
]);

let wsServer: McpServerAdapter;
let sumServer: McpServerAdapter;
let sumClient: Client;
let wsRuntime: MotebitRuntime;
let sumRuntime: MotebitRuntime;
let wsPublicKeyHex: string;
let sumPublicKeyHex: string;
let wsPrivateKey: Uint8Array;
let sumPrivateKey: Uint8Array;
let webSearchAdapter: McpClientAdapter;

beforeAll(async () => {
  // --- Web-search service setup ---
  const wsKeypair = await generateKeypair();
  wsPrivateKey = wsKeypair.privateKey;
  wsPublicKeyHex = toHex(wsKeypair.publicKey);

  const wsIdentityContent = await generateIdentity(
    {
      motebitId: WS_MOTEBIT_ID,
      ownerId: "test-owner",
      publicKeyHex: wsPublicKeyHex,
      service: {
        type: "service",
        service_name: "web-search-test",
        service_description: "Test web search",
        capabilities: ["web_search"],
      },
    },
    wsKeypair.privateKey,
  );

  const wsRegistry = new InMemoryToolRegistry();
  // Mock web_search to return static data
  wsRegistry.register(webSearchDefinition, async (_args) => ({
    ok: true,
    data: STATIC_RESULTS,
  }));
  wsRegistry.register(readUrlDefinition, async (_args) => ({
    ok: true,
    data: "page content",
  }));

  wsRuntime = new MotebitRuntime(
    { motebitId: WS_MOTEBIT_ID },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), tools: wsRegistry },
  );
  await wsRuntime.init();

  const wsDeps: MotebitServerDeps = {
    motebitId: WS_MOTEBIT_ID,
    publicKeyHex: wsPublicKeyHex,
    listTools: () => wsRuntime.getToolRegistry().list(),
    filterTools: (tools) => wsRuntime.policy.filterTools(tools),
    validateTool: (tool, args) =>
      wsRuntime.policy.validate(tool, args, wsRuntime.policy.createTurnContext()),
    executeTool: (name, args) => wsRuntime.getToolRegistry().execute(name, args),
    getState: () => wsRuntime.getState() as unknown as Record<string, unknown>,
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: async (token, pk) => verifySignedToken(token, pk),
    identityFileContent: wsIdentityContent,
    handleAgentTask: async function* (prompt: string) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();
      let result: ToolResult;
      try {
        result = await wsRuntime.getToolRegistry().execute("web_search", { query: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();
      const resultStr = result.ok
        ? (typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null))
        : (result.error ?? "error");
      const enc = new TextEncoder();
      const receipt = await signExecutionReceipt(
        {
          task_id: taskId,
          motebit_id: WS_MOTEBIT_ID,
          device_id: "ws-test",
          submitted_at: submittedAt,
          completed_at: completedAt,
          status: result.ok ? "completed" : "failed",
          result: resultStr,
          tools_used: ["web_search"],
          memories_formed: 0,
          prompt_hash: await sha256(enc.encode(prompt)),
          result_hash: await sha256(enc.encode(resultStr)),
        },
        wsPrivateKey,
      );
      yield { type: "task_result" as const, receipt: receipt as unknown as Record<string, unknown> };
    },
  };

  wsServer = new McpServerAdapter(
    { name: "test-web-search", transport: "http", port: WS_PORT, motebitType: "service" },
    wsDeps,
  );
  await wsServer.start();

  // --- Summarize service setup ---
  const sumKeypair = await generateKeypair();
  sumPrivateKey = sumKeypair.privateKey;
  sumPublicKeyHex = toHex(sumKeypair.publicKey);

  // Connect to web-search as MCP client (motebit: true triggers identity verification + receipt capture)
  webSearchAdapter = new McpClientAdapter({
    name: "web-search",
    transport: "http",
    url: `http://localhost:${WS_PORT}/mcp`,
    motebit: true,
  });
  await webSearchAdapter.connect();

  const sumRegistry = new InMemoryToolRegistry();
  sumRegistry.register(
    summarizeSearchDefinition,
    createSummarizeSearchHandler(webSearchAdapter),
  );

  sumRuntime = new MotebitRuntime(
    { motebitId: SUM_MOTEBIT_ID },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), tools: sumRegistry },
  );
  await sumRuntime.init();

  const sumIdentityContent = await generateIdentity(
    {
      motebitId: SUM_MOTEBIT_ID,
      ownerId: "test-owner",
      publicKeyHex: sumPublicKeyHex,
      service: {
        type: "service",
        service_name: "summarize-test",
        service_description: "Test summarize service",
        capabilities: ["summarize_search"],
      },
    },
    sumKeypair.privateKey,
  );

  const sumDeps: MotebitServerDeps = {
    motebitId: SUM_MOTEBIT_ID,
    publicKeyHex: sumPublicKeyHex,
    listTools: () => sumRuntime.getToolRegistry().list(),
    filterTools: (tools) => sumRuntime.policy.filterTools(tools),
    validateTool: (tool, args) =>
      sumRuntime.policy.validate(tool, args, sumRuntime.policy.createTurnContext()),
    executeTool: (name, args) => sumRuntime.getToolRegistry().execute(name, args),
    getState: () => sumRuntime.getState() as unknown as Record<string, unknown>,
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: async (token, pk) => verifySignedToken(token, pk),
    identityFileContent: sumIdentityContent,
    handleAgentTask: async function* (prompt: string) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();
      let result: ToolResult;
      try {
        result = await sumRuntime.getToolRegistry().execute("summarize_search", { query: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();

      // Drain delegation receipts
      const delegationReceipts: ExecutionReceipt[] = [];
      if (webSearchAdapter.getAndResetDelegationReceipts) {
        delegationReceipts.push(...webSearchAdapter.getAndResetDelegationReceipts());
      }

      const resultStr = result.ok
        ? (typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null))
        : (result.error ?? "error");
      const enc = new TextEncoder();
      const receiptBody: Record<string, unknown> = {
        task_id: taskId,
        motebit_id: SUM_MOTEBIT_ID,
        device_id: "sum-test",
        submitted_at: submittedAt,
        completed_at: completedAt,
        status: result.ok ? "completed" : "failed",
        result: resultStr,
        tools_used: ["summarize_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode(prompt)),
        result_hash: await sha256(enc.encode(resultStr)),
      };
      if (delegationReceipts.length > 0) {
        receiptBody["delegation_receipts"] = delegationReceipts;
      }
      const signed = await signExecutionReceipt(
        receiptBody as Omit<ExecutionReceipt, "signature">,
        sumPrivateKey,
      );
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    },
  };

  sumServer = new McpServerAdapter(
    { name: "test-summarize", transport: "http", port: SUM_PORT, motebitType: "service" },
    sumDeps,
  );
  await sumServer.start();

  // Connect client to summarize service
  sumClient = new Client(
    { name: "test-caller", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${SUM_PORT}/mcp`));
  await sumClient.connect(transport);
}, 30_000);

afterAll(async () => {
  try { await sumClient.close(); } catch { /* ignore */ }
  try { await webSearchAdapter.disconnect(); } catch { /* ignore */ }
  try { await sumServer.stop(); } catch { /* ignore */ }
  try { await wsServer.stop(); } catch { /* ignore */ }
  try { sumRuntime.stop(); } catch { /* ignore */ }
  try { wsRuntime.stop(); } catch { /* ignore */ }
});

describe("Multi-Hop Delegation — Summarize → Web-Search", () => {
  it("motebit_task returns a receipt with nested delegation_receipts", async () => {
    const result = await sumClient.callTool({
      name: "motebit_task",
      arguments: { prompt: "multi-hop test query" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;

    // Outer receipt is from summarize service
    expect(receipt.motebit_id).toBe(SUM_MOTEBIT_ID);
    expect(receipt.signature).toBeDefined();
    expect(receipt.tools_used).toContain("summarize_search");

    // Nested delegation receipt is from web-search service
    expect(receipt.delegation_receipts).toBeDefined();
    expect(receipt.delegation_receipts!.length).toBeGreaterThanOrEqual(1);
    expect(receipt.delegation_receipts![0]!.motebit_id).toBe(WS_MOTEBIT_ID);
    expect(receipt.delegation_receipts![0]!.signature).toBeDefined();
  });

  it("outer receipt signature is valid", async () => {
    const result = await sumClient.callTool({
      name: "motebit_task",
      arguments: { prompt: "verify outer" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;

    const sumPubKey = new Uint8Array(
      (sumPublicKeyHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
    );
    const valid = await verifyExecutionReceipt(receipt, sumPubKey);
    expect(valid).toBe(true);
  });

  it("inner delegation receipt signature is valid", async () => {
    const result = await sumClient.callTool({
      name: "motebit_task",
      arguments: { prompt: "verify inner" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;

    const innerReceipt = receipt.delegation_receipts![0]!;
    const wsPubKey = new Uint8Array(
      (wsPublicKeyHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
    );
    const valid = await verifyExecutionReceipt(innerReceipt, wsPubKey);
    expect(valid).toBe(true);
  });

  it("full chain verification succeeds with known keys", async () => {
    const result = await sumClient.callTool({
      name: "motebit_task",
      arguments: { prompt: "chain verify" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;

    const fromHex = (hex: string): Uint8Array =>
      new Uint8Array((hex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
    const knownKeys = new Map<string, Uint8Array>([
      [SUM_MOTEBIT_ID, fromHex(sumPublicKeyHex)],
      [WS_MOTEBIT_ID, fromHex(wsPublicKeyHex)],
    ]);
    const chainResult = await verifyReceiptChain(receipt, knownKeys);
    expect(chainResult.verified).toBe(true);
    expect(chainResult.delegations).toHaveLength(1);
    expect(chainResult.delegations[0]!.verified).toBe(true);
  });

  it("summarize_search tool returns transformed results", async () => {
    const result = await sumClient.callTool({
      name: "summarize_search",
      arguments: { query: "direct tool test" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    // The result should contain the search query
    expect(text).toContain("direct tool test");
  });
});
