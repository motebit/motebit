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
import {
  wireServerDeps,
  startServiceServer,
  buildServiceReceipt,
  bootstrapAndEmitIdentity,
} from "@motebit/mcp-server";
import { McpClientAdapter } from "@motebit/mcp-client";
import { embedText } from "@motebit/memory-graph";
import { summarizeSearchDefinition, createSummarizeSearchHandler } from "./tool.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3201", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/summarize.db",
    // Persistent volume root for bootstrapAndEmitIdentity(). On Fly
    // this is `/data`; locally, ./data. Identity (motebit.json,
    // motebit.key, motebit.md) is generated here on first boot and
    // reloaded on every subsequent boot. Survives deploys.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    /** Externally-reachable URL the relay advertises for routing to this
     * service. Falls back to `http://localhost:${port}` inside the mcp-server
     * library, which the relay accepts but no caller can reach. Must be set
     * to the Fly hostname in production. */
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    webSearchUrl: process.env["WEB_SEARCH_URL"] ?? "http://localhost:3200",
    // Bearer token for upstream web-search MCP endpoint. When set,
    // summarize authenticates as a static MCP client. Unset in local
    // dev where web-search has no inbound auth.
    webSearchAuthToken: process.env["WEB_SEARCH_AUTH_TOKEN"],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// Re-export for external consumers
export { summarizeSearchDefinition, createSummarizeSearchHandler } from "./tool.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const serviceName = "motebit-summarize";

  // 1-2. Bootstrap identity + emit signed motebit.md in one call.
  const identity = await bootstrapAndEmitIdentity({
    dataDir: config.dataDir,
    serviceName,
    displayName: "Summarize",
    serviceDescription: "Multi-hop delegating service: summarize_search delegates to web-search",
    capabilities: ["summarize_search"],
  });
  const { motebitId, publicKeyHex, publicKey, privateKey, identityContent } = identity;
  log(
    `Identity ${identity.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

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

  // Service motebit: minimal policy — summarize_search is read-only.
  const policyOverrides = {};

  // 3. Build tool registry with summarize_search
  const registry = new InMemoryToolRegistry();

  // 4. Connect to web-search as MCP client
  const webSearchAdapter = new McpClientAdapter({
    name: "web-search",
    transport: "http",
    url: `${config.webSearchUrl}/mcp`,
    ...(config.webSearchAuthToken ? { authToken: config.webSearchAuthToken } : {}),
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

  // 5. Wire handleAgentTask — execute summarize_search, nest delegation receipts.
  //    privateKey is unconditional (every bootstrapped service has one).
  const handleAgentTask = async function* (prompt: string, _options?: { delegatedScope?: string }) {
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

    const signed = await buildServiceReceipt({
      motebitId,
      deviceId: "summarize-service",
      privateKey,
      publicKey,
      prompt,
      taskId,
      submittedAt,
      completedAt,
      result: resultStr,
      ok: result.ok,
      toolsUsed: ["summarize_search"],
      delegationReceipts,
    });
    log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 6. Wire deps + start server
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    handleAgentTask,
  });

  await startServiceServer(deps, {
    name: `motebit-summarize-${motebitId.slice(0, 8)}`,
    port: config.port,
    authToken: config.authToken,
    motebitType: "service",
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    publicEndpointUrl: config.publicUrl,
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
