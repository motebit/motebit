/**
 * Integration test — proves the full motebit protocol loop:
 * discover → verify identity → delegate tool call → signed receipt
 *
 * Uses in-memory storage and real MCP server/client over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import {
  InMemoryToolRegistry,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
} from "@motebit/tools";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifySignedToken,
  hash as sha256,
} from "@motebit/crypto";
import { generate as generateIdentity, verify as verifyIdentityFile } from "@motebit/identity-file";

// Deterministic test ID
const TEST_MOTEBIT_ID = "01961234-5678-7abc-def0-123456789abc";
const TEST_PORT = 39201; // High port to avoid conflicts

let server: McpServerAdapter;
let client: Client;
let runtime: MotebitRuntime;
let publicKeyHex: string;
let privateKey: Uint8Array;
let identityContent: string;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Strip the identity tag appended by formatResult: \n[motebit:... key:...] */
function stripIdentityTag(text: string): string {
  return text.replace(/\n\[motebit:[^\]]+\]$/, "");
}

beforeAll(async () => {
  // 1. Generate Ed25519 keypair
  const keypair = await generateKeypair();
  privateKey = keypair.privateKey;
  publicKeyHex = toHex(keypair.publicKey);

  // 2. Generate service identity file
  identityContent = await generateIdentity(
    {
      motebitId: TEST_MOTEBIT_ID,
      ownerId: "test-owner",
      publicKeyHex,
      service: {
        type: "service",
        service_name: "web-search-test",
        service_description: "Integration test search service",
        capabilities: ["web_search", "read_url"],
      },
    },
    privateKey,
  );

  // Verify the generated identity
  const verifyResult = await verifyIdentityFile(identityContent);
  expect(verifyResult.valid).toBe(true);

  // 3. Build tool registry
  const registry = new InMemoryToolRegistry();
  registry.register(webSearchDefinition, createWebSearchHandler());
  registry.register(readUrlDefinition, createReadUrlHandler());

  // 4. Create runtime with in-memory storage (no SQLite needed)
  const storage = createInMemoryStorage();
  runtime = new MotebitRuntime(
    { motebitId: TEST_MOTEBIT_ID },
    {
      storage,
      renderer: new NullRenderer(),
      tools: registry,
    },
  );
  await runtime.init();

  // 5. Wire MotebitServerDeps
  const deps: MotebitServerDeps = {
    motebitId: TEST_MOTEBIT_ID,
    publicKeyHex,

    listTools: () => runtime.getToolRegistry().list(),
    filterTools: (tools) => runtime.policy.filterTools(tools),
    validateTool: (tool, args) =>
      runtime.policy.validate(tool, args, runtime.policy.createTurnContext()),
    executeTool: (name, args) => runtime.getToolRegistry().execute(name, args),

    getState: () => runtime.getState() as unknown as Record<string, unknown>,

    getMemories: async (limit = 50) => {
      const data = await runtime.memory.exportAll();
      return data.nodes
        .filter((n) => !n.tombstoned)
        .map((n) => ({
          content: n.content,
          confidence: n.confidence,
          sensitivity: n.sensitivity,
          created_at: n.created_at,
        }))
        .slice(0, limit);
    },

    logToolCall: (name, _args, _result) => {
      void name; // logged but not asserted
    },

    verifySignedToken: async (token, publicKey) => {
      return verifySignedToken(token, publicKey);
    },

    identityFileContent: identityContent,

    // Wire handleAgentTask — direct tool execution with signed receipt
    handleAgentTask: async function* (prompt: string) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();

      let result: { ok: boolean; data?: unknown; error?: string };
      try {
        result = await runtime.getToolRegistry().execute("web_search", { query: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();

      const resultStr = result.ok
        ? (typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null))
        : (result.error ?? "error");

      const enc = new TextEncoder();
      const promptHash = await sha256(enc.encode(prompt));
      const resultHash = await sha256(enc.encode(resultStr));

      const receipt = {
        task_id: taskId,
        motebit_id: TEST_MOTEBIT_ID,
        device_id: "test-service",
        submitted_at: submittedAt,
        completed_at: completedAt,
        status: result.ok ? ("completed" as const) : ("failed" as const),
        result: resultStr,
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
      };

      const signed = await signExecutionReceipt(receipt, privateKey);
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    },
  };

  // 6. Start MCP server
  server = new McpServerAdapter(
    {
      name: "test-web-search",
      transport: "http",
      port: TEST_PORT,
      motebitType: "service",
    },
    deps,
  );
  await server.start();

  // 7. Connect MCP client
  client = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${TEST_PORT}/mcp`));
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  try { await client.close(); } catch { /* ignore */ }
  try { await server.stop(); } catch { /* ignore */ }
  try { runtime.stop(); } catch { /* ignore */ }
});

describe("Web Search Service — Protocol Loop", () => {
  it("motebit_identity: returns identity with motebit_id and public_key", async () => {
    const result = await client.callTool({ name: "motebit_identity", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain(TEST_MOTEBIT_ID);
    expect(text).toContain(publicKeyHex);
  });

  it("motebit_tools: lists web_search and read_url", async () => {
    const result = await client.callTool({ name: "motebit_tools", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("web_search");
    expect(text).toContain("read_url");
  });

  it("web_search: executes and returns results", async () => {
    const result = await client.callTool({
      name: "web_search",
      arguments: { query: "motebit agent protocol" },
    });
    // Tool should execute (may return empty results without API key, but shouldn't throw)
    expect(result.content).toBeDefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    // Results are identity-tagged (tag uses first 8 chars of motebit_id)
    expect(text).toContain(`motebit:${TEST_MOTEBIT_ID.slice(0, 8)}`);
  });

  it("motebit_task: returns signed ExecutionReceipt", async () => {
    const result = await client.callTool({
      name: "motebit_task",
      arguments: { prompt: "test search query" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as Record<string, unknown>;

    expect(receipt["task_id"]).toBeDefined();
    expect(receipt["motebit_id"]).toBe(TEST_MOTEBIT_ID);
    expect(receipt["signature"]).toBeDefined();
    expect(receipt["status"]).toMatch(/completed|failed/);
    expect(receipt["tools_used"]).toEqual(["web_search"]);
    expect(receipt["prompt_hash"]).toBeDefined();
    expect(receipt["result_hash"]).toBeDefined();
  });

  it("receipt verification: signature is valid with public key", async () => {
    const result = await client.callTool({
      name: "motebit_task",
      arguments: { prompt: "verify me" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const receipt = JSON.parse(stripIdentityTag(text)) as Record<string, unknown>;

    // Verify using the public key
    const pubKeyBytes = new Uint8Array((publicKeyHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
    const valid = await verifyExecutionReceipt(
      receipt as unknown as { task_id: string; motebit_id: string; device_id: string; submitted_at: number; completed_at: number; status: string; result: string; tools_used: string[]; memories_formed: number; prompt_hash: string; result_hash: string; signature: string },
      pubKeyBytes,
    );
    expect(valid).toBe(true);
  });
});
