/**
 * Motebit Summarize Service
 *
 * A delegating service that connects as MCP client to web-search and
 * delegates search tasks. Proves multi-hop delegation with nested
 * receipts.
 *
 * Pure tool server (no LLM). Exposes summarize_search via MCP.
 *
 * Flow: caller → motebit_task(summarize) → summarize_search →
 *       motebit_task(web-search) → web_search tool →
 *       receipt(web-search) nested in receipt(summarize)
 *
 * Boot plumbing (identity, DB, runtime, MCP server) lives in
 * `@motebit/molecule-runner`. This file owns the env-derived config,
 * the upstream MCP client connection to web-search, and the
 * handleAgentTask that invokes summarize_search and nests the
 * delegation receipts.
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolResult, ExecutionReceipt } from "@motebit/sdk";
import { McpClientAdapter } from "@motebit/mcp-client";
import { summarizeSearchDefinition, createSummarizeSearchHandler } from "./tool.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3201", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/summarize.db",
    // Persistent volume root. On Fly this is `/data`; locally, ./data.
    // Identity (motebit.json, motebit.key, motebit.md) is generated
    // here on first boot and reloaded on every subsequent boot.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    /** Externally-reachable URL the relay advertises for routing. Must be
     *  set to the Fly hostname in production. */
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    webSearchUrl: process.env["WEB_SEARCH_URL"] ?? "http://localhost:3200",
    // Bearer token for upstream web-search MCP endpoint.
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

  // Upstream MCP client connects BEFORE the runner boots so handler
  // registration can close over the adapter. Connection is cheap and
  // failure should be loud (the service cannot function without
  // web-search reachable).
  const webSearchAdapter = new McpClientAdapter({
    name: "web-search",
    transport: "http",
    url: `${config.webSearchUrl}/mcp`,
    ...(config.webSearchAuthToken ? { authToken: config.webSearchAuthToken } : {}),
  });
  await webSearchAdapter.connect();
  log(`Connected to web-search at ${config.webSearchUrl}`);

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-summarize",
      displayName: "Summarize",
      serviceDescription: "Multi-hop delegating service: summarize_search delegates to web-search",
      capabilities: ["summarize_search"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, publicKey, privateKey } = identity;

      const registry = new InMemoryToolRegistry();
      registry.register(summarizeSearchDefinition, createSummarizeSearchHandler(webSearchAdapter));

      const handleAgentTask = async function* (
        prompt: string,
        _options?: { delegatedScope?: string },
      ) {
        const taskId = crypto.randomUUID();
        const submittedAt = Date.now();

        let result: ToolResult;
        try {
          result = await registry.execute("summarize_search", { query: prompt });
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
        yield {
          type: "task_result" as const,
          receipt: signed as unknown as Record<string, unknown>,
        };
      };

      return {
        toolRegistry: registry,
        handleAgentTask,
        // summarize_search is read-only — no R3 approval default needed.
        // Minimal policy preserves original semantics (the previous
        // hand-rolled boot passed {} as policy overrides).
        policyOverrides: {},
        onStop: () => {
          void webSearchAdapter.disconnect().catch(() => {
            /* best-effort cleanup */
          });
        },
      };
    },
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
