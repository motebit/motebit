/**
 * Motebit Web Search Service
 *
 * A pure tool server — no LLM reasoning. Exposes web_search and read_url
 * via MCP, with signed execution receipts proving provenance.
 *
 * Protocol loop: discover → verify identity → delegate tool call → signed receipt
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import {
  InMemoryToolRegistry,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  FallbackSearchProvider,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
} from "@motebit/tools";
import type { SearchProvider } from "@motebit/tools";
import {
  wireServerDeps,
  startServiceServer,
  buildServiceReceipt,
  bootstrapAndEmitIdentity,
} from "@motebit/mcp-server";
import { McpClientAdapter } from "@motebit/mcp-client";
import { parseRiskLevel } from "@motebit/identity-file";
import type { ExecutionReceipt } from "@motebit/sdk";
import { embedText } from "@motebit/memory-graph";
import { loadConfig, canonicalizeResults } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Sub-delegate a task to another motebit service via the protocol-layer
 * primitive — `McpClientAdapter` from `@motebit/mcp-client`. Returns the
 * signed `ExecutionReceipt` from the remote service, or null on failure.
 *
 * The receipt capture happens automatically inside `McpClientAdapter` — any
 * motebit_task call whose response is a valid signed receipt is pushed onto
 * the adapter's `_delegationReceipts` queue, drained here via
 * `getAndResetDelegationReceipts()`. Nothing motebit-protocol-shaped is
 * reinvented — see CLAUDE.md "Protocol primitives belong in packages, never
 * inline in services" for the doctrine.
 */
async function subDelegate(
  mcpUrl: string,
  prompt: string,
  callerMotebitId: string,
  callerDeviceId: string,
  callerPrivateKey: Uint8Array,
  /** Relay URL for budget allocation (optional). */
  syncUrl?: string,
  /** API token for relay calls. */
  apiToken?: string,
  /** Target motebit ID for relay task submission. */
  targetMotebitId?: string,
): Promise<ExecutionReceipt | null> {
  // Optional relay budget binding — best-effort, failures don't block the chain
  let subRelayTaskId: string | undefined;
  if (syncUrl != null && syncUrl !== "" && apiToken != null && targetMotebitId != null) {
    try {
      const taskResp = await fetch(`${syncUrl}/agent/${targetMotebitId}/task`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          prompt,
          submitted_by: callerMotebitId,
          required_capabilities: ["read_url"],
        }),
      });
      if (taskResp.ok) {
        const taskBody = (await taskResp.json()) as { task_id: string };
        subRelayTaskId = taskBody.task_id;
        log(`sub-delegation relay task: ${subRelayTaskId.slice(0, 12)}…`);
      } else {
        log(`sub-delegation relay task failed: ${taskResp.status}`);
      }
    } catch (relayErr: unknown) {
      const msg = relayErr instanceof Error ? relayErr.message : String(relayErr);
      log(`sub-delegation relay task error: ${msg}`);
    }
  }

  const adapter = new McpClientAdapter({
    name: "read-url",
    transport: "http",
    url: mcpUrl,
    motebit: true,
    motebitType: "service",
    callerMotebitId,
    callerDeviceId,
    callerPrivateKey,
  });

  try {
    await adapter.connect();
    const args: Record<string, unknown> = { prompt };
    if (subRelayTaskId != null) args.relay_task_id = subRelayTaskId;
    await adapter.executeTool("read-url__motebit_task", args);
    const receipts = adapter.getAndResetDelegationReceipts();
    return receipts[0] ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`sub-delegation failed: ${msg}`);
    return null;
  } finally {
    await adapter.disconnect().catch(() => {
      /* best-effort cleanup */
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const serviceName = "motebit-web-search";

  // 1-2. Bootstrap identity + emit signed motebit.md in one call.
  const identity = await bootstrapAndEmitIdentity({
    dataDir: config.dataDir,
    serviceName,
    displayName: "Web Search",
    serviceDescription: "Brave/DuckDuckGo web search + multi-hop delegation to read-url",
    capabilities: ["web_search", "read_url"],
  });
  const { motebitId, publicKeyHex, publicKey, privateKey, identityContent } = identity;
  log(
    `Identity ${identity.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 2. Build tool registry — two tools only (read-only, R0)
  const registry = new InMemoryToolRegistry();
  let searchProvider: SearchProvider | undefined;
  if (config.braveApiKey) {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(config.braveApiKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }
  registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());

  // 3. Open database + create runtime (no AI provider — pure tool server)
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
    planStore: moteDb.planStore,
    gradientStore: moteDb.gradientStore as unknown as StorageAdapters["gradientStore"],
    agentTrustStore: moteDb.agentTrustStore,
    serviceListingStore: moteDb.serviceListingStore,
    budgetAllocationStore: moteDb.budgetAllocationStore,
    settlementStore: moteDb.settlementStore,
    latencyStatsStore: moteDb.latencyStatsStore,
    credentialStore: moteDb.credentialStore,
    approvalStore: moteDb.approvalStore,
  };

  // Service motebit: auto-allow up to R3_EXECUTE for its own tools
  // (web_search, read_url, motebit_task). Bands path requires BOTH
  // thresholds set; the previous form had a typoed `maxRiskAuto` field
  // PolicyConfig does not define, falling through to the legacy path with
  // maxRiskLevel undefined → default R1_DRAFT → every R3+ tool denied.
  // Sibling drift fixed in code-review, read-url, and research.
  const policyOverrides = {
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
    denyAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (tool server mode — no LLM)");

  // 4. Wire handleAgentTask — direct tool execution with signed receipts.
  //    privateKey is unconditional (every service bootstrapped identity has one).
  const handleAgentTask = async function* (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) {
    const taskId = crypto.randomUUID();
    const submittedAt = Date.now();

    let result: { ok: boolean; data?: unknown; error?: string };
    try {
      // The prompt from delegation is often a full sentence ("Search for the current
      // Bitcoin price in USD"). Brave Search works best with keywords, not natural
      // language. Strip common filler to extract the core query.
      const query = prompt
        .replace(
          /\b(search\s+(for|the)?|find\s+(me\s+)?|look\s+up|what\s+is\s+(the\s+)?|tell\s+me\s+(about\s+)?|get\s+(me\s+)?|can\s+you|please|right\s+now|currently?|latest|return\s+the\s+result)\b/gi,
          " ",
        )
        .replace(/\s{2,}/g, " ")
        .trim();
      result = await runtime.getToolRegistry().execute("web_search", { query: query || prompt });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: msg };
    }
    const searchCompletedAt = Date.now();

    // Use data on success, error message on failure — never undefined
    const resultStr = result.ok
      ? typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data ?? null)
      : (result.error ?? "error");
    const canonical = canonicalizeResults(resultStr);

    // Multi-hop: sub-delegate URL reading to Charlie if configured
    let delegationReceipts: ExecutionReceipt[] | undefined;
    if (config.delegateReadUrl && result.ok) {
      try {
        // Extract a URL to sub-delegate: from search results, or from the prompt itself
        let firstUrl: string | undefined;
        try {
          const parsed = JSON.parse(resultStr) as Array<{ url?: string; link?: string }>;
          firstUrl = parsed[0]?.url ?? parsed[0]?.link;
        } catch {
          // Results aren't JSON — try extracting URL from prompt or result
          const urlMatch = (prompt + " " + resultStr).match(/https?:\/\/[^\s"<>]+/);
          if (urlMatch) firstUrl = urlMatch[0];
        }
        if (firstUrl) {
          log(`sub-delegating read_url to ${config.delegateReadUrl}: ${firstUrl.slice(0, 60)}`);
          const charlieReceipt = await subDelegate(
            config.delegateReadUrl,
            firstUrl,
            motebitId,
            "web-search-service",
            privateKey,
            config.syncUrl,
            config.apiToken,
            config.delegateTargetId,
          );
          if (charlieReceipt) {
            delegationReceipts = [charlieReceipt];
            log(`sub-delegation receipt: ${charlieReceipt.signature?.slice(0, 12)}…`);
          }
        }
      } catch (subErr: unknown) {
        // Sub-delegation is best-effort — don't block the main receipt
        const subMsg = subErr instanceof Error ? subErr.message : String(subErr);
        log(`sub-delegation skipped: ${subMsg}`);
      }
    }

    const signed = await buildServiceReceipt({
      motebitId,
      deviceId: "web-search-service",
      privateKey,
      publicKey,
      prompt,
      taskId,
      submittedAt,
      completedAt: delegationReceipts ? Date.now() : searchCompletedAt,
      // Receipt result + result_hash are over the canonical form, not the raw.
      // buildServiceReceipt hashes whatever we pass as `result`, so passing
      // canonical preserves the pre-existing behavior.
      result: canonical,
      ok: result.ok,
      toolsUsed: ["web_search", ...(delegationReceipts ? ["read_url(delegated)"] : [])],
      relayTaskId: options?.relayTaskId,
      delegatedScope: options?.delegatedScope,
      delegationReceipts,
    });
    log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 5. Wire deps + start server (scaffold handles MCP, relay, shutdown)
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.05");
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    handleAgentTask,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
  });

  // Publish service listing with pricing so the relay allocates budget and settles real money
  deps.getServiceListing = () =>
    Promise.resolve({
      capabilities: ["web_search", "read_url"],
      pricing: [
        { capability: "web_search", unit_cost: unitCost, currency: "USD", per: "request" },
        { capability: "read_url", unit_cost: unitCost, currency: "USD", per: "request" },
      ],
      sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
      description: `motebit-web-search-${motebitId.slice(0, 8)}`,
    });

  // REST search provider — same instance the MCP tool uses
  const restSearchProvider = searchProvider ?? new DuckDuckGoSearchProvider();

  const SEARCH_CORS_ORIGINS = new Set([
    "https://motebit.com",
    "https://www.motebit.com",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
  ]);

  await startServiceServer(deps, {
    name: `motebit-web-search-${motebitId.slice(0, 8)}`,
    port: config.port,
    authToken: config.authToken,
    motebitType: "service",
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    publicEndpointUrl: config.publicUrl,
    customRoutes: async (
      req: import("http").IncomingMessage,
      res: import("http").ServerResponse,
      url: URL,
    ) => {
      const origin = req.headers.origin ?? "";
      const cors: Record<string, string> = SEARCH_CORS_ORIGINS.has(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          }
        : {};

      // CORS preflight
      if (url.pathname === "/search" && req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return true;
      }

      // POST /search — structured web search results
      if (url.pathname === "/search" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const { query, maxResults } = JSON.parse(body) as {
            query?: string;
            maxResults?: number;
          };
          if (!query) {
            res.writeHead(400, { ...cors, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "missing query" }));
            return true;
          }
          const results = await restSearchProvider.search(query, Math.min(maxResults ?? 5, 10));
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, results }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
        return true;
      }

      return false;
    },
    onStart: (port, toolCount) => {
      log(`MCP server running on http://localhost:${port} (SSE). ${toolCount} tools exposed.`);
      log(`REST search: http://localhost:${port}/search`);
      log(`Health endpoint: http://localhost:${port}/health`);
    },
    onStop: () => {
      log("Shutting down...");
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
