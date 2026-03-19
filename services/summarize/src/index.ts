/**
 * Motebit Summarize Service
 *
 * A delegating service that connects as MCP client to web-search and
 * delegates search tasks. Proves multi-hop delegation with nested receipts.
 *
 * Pure tool server (no LLM). Exposes summarize_search via MCP.
 *
 * Flow: caller → motebit_task(summarize) → summarize_search → motebit_task(web-search)
 *       → web_search tool → receipt(web-search) nested in receipt(summarize)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolResult, ExecutionReceipt } from "@motebit/sdk";
import { wireServerDeps, startServiceServer } from "@motebit/mcp-server";
import { McpClientAdapter } from "@motebit/mcp-client";
import { verifyIdentityFile, governanceToPolicyConfig } from "@motebit/identity-file";
import { verifySignedToken, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { embedText } from "@motebit/memory-graph";
import { summarizeSearchDefinition, createSummarizeSearchHandler } from "./tool.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3201", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/summarize.db",
    identityPath: process.env["MOTEBIT_IDENTITY_PATH"] ?? "./motebit.md",
    privateKeyHex: process.env["MOTEBIT_PRIVATE_KEY_HEX"],
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    webSearchUrl: process.env["WEB_SEARCH_URL"] ?? "http://localhost:3200",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Re-export for external consumers
export { summarizeSearchDefinition, createSummarizeSearchHandler } from "./tool.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Load and verify identity
  const identityPath = path.resolve(config.identityPath);
  if (!fs.existsSync(identityPath)) {
    console.error(
      `No identity file found at ${identityPath}. Generate one: npx create-motebit . --service`,
    );
    process.exit(1);
  }
  const identityContent = fs.readFileSync(identityPath, "utf-8");
  const verifyResult = await verifyIdentityFile(identityContent);
  if (!verifyResult.valid || !verifyResult.identity) {
    console.error(`Identity verification failed: ${verifyResult.error ?? "unknown error"}`);
    process.exit(1);
  }
  const identity = verifyResult.identity;
  const motebitId = identity.motebit_id;
  const publicKeyHex = identity.identity.public_key;
  log(`Identity verified: ${motebitId}`);

  // 2. Open database + create runtime
  const dbDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const moteDb = await openMotebitDatabase(path.resolve(config.dbPath));

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
    agentTrustStore: moteDb.agentTrustStore,
  };

  const policyOverrides =
    identity.governance != null ? governanceToPolicyConfig(identity.governance) : {};

  // 3. Build tool registry with summarize_search
  const registry = new InMemoryToolRegistry();

  // 4. Connect to web-search as MCP client
  const webSearchAdapter = new McpClientAdapter({
    name: "web-search",
    transport: "http",
    url: `${config.webSearchUrl}/mcp`,
  });
  await webSearchAdapter.connect();
  log(`Connected to web-search at ${config.webSearchUrl}`);

  // Register our tool now that we have the adapter
  registry.register(summarizeSearchDefinition, createSummarizeSearchHandler(webSearchAdapter));

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (delegating tool server — no LLM)");

  // 5. Wire handleAgentTask — execute summarize_search, nest delegation receipts
  let handleAgentTask:
    | ((
        prompt: string,
        options?: { delegatedScope?: string },
      ) => AsyncGenerator<
        | { type: "text"; text: string }
        | { type: "task_result"; receipt: Record<string, unknown> }
        | { type: string; [key: string]: unknown }
      >)
    | undefined;

  if (config.privateKeyHex) {
    const privateKey = fromHex(config.privateKeyHex);
    handleAgentTask = async function* (prompt: string, _options?: { delegatedScope?: string }) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();

      let result: ToolResult;
      try {
        result = await runtime.getToolRegistry().execute("summarize_search", { query: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();

      // Drain delegation receipts from web-search adapter
      const delegationReceipts: ExecutionReceipt[] = [];
      if (webSearchAdapter.getAndResetDelegationReceipts != null) {
        delegationReceipts.push(...webSearchAdapter.getAndResetDelegationReceipts());
      }

      const resultStr = result.ok
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data ?? null)
        : (result.error ?? "error");

      const enc = new TextEncoder();
      const promptHash = await sha256(enc.encode(prompt));
      const resultHash = await sha256(enc.encode(resultStr));

      const receiptBody: Record<string, unknown> = {
        task_id: taskId,
        motebit_id: motebitId,
        device_id: "summarize-service",
        submitted_at: submittedAt,
        completed_at: completedAt,
        status: result.ok ? "completed" : "failed",
        result: resultStr,
        tools_used: ["summarize_search"],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
      };
      if (delegationReceipts.length > 0) {
        receiptBody["delegation_receipts"] = delegationReceipts;
      }

      const signed = await signExecutionReceipt(
        receiptBody as Omit<ExecutionReceipt, "signature">,
        privateKey,
      );
      log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    };
    log("Agent task handler enabled (receipts will be signed, delegation receipts nested)");
  }

  // 6. Wire deps + start server
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    verifySignedToken,
    handleAgentTask,
  });

  await startServiceServer(deps, {
    name: `motebit-summarize-${motebitId.slice(0, 8)}`,
    port: config.port,
    authToken: config.authToken,
    motebitType: "service",
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    onStart: (port, toolCount) => {
      log(`MCP server running on http://localhost:${port}. ${toolCount} tools exposed.`);
    },
    onStop: () => {
      log("Shutting down...");
      void webSearchAdapter.disconnect().catch(() => {});
      runtime.stop();
      moteDb.close();
    },
    log,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
