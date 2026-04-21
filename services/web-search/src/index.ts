/**
 * Motebit Web Search Service
 *
 * A pure tool server — no LLM reasoning. Exposes web_search and
 * read_url via MCP, with signed execution receipts proving provenance.
 *
 * Protocol loop: discover → verify identity → delegate tool call →
 * signed receipt
 *
 * Boot plumbing (identity, DB, runtime, MCP server) lives in
 * `@motebit/molecule-runner`. This file owns the web-search-specific
 * provider stack, the REST /search custom route, and the
 * handleAgentTask that runs web_search and optionally sub-delegates
 * read_url to a downstream atom.
 */

import {
  InMemoryToolRegistry,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  FallbackSearchProvider,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
  BiasedSearchProvider,
  TavilySearchProvider,
} from "@motebit/tools";
import type { SearchProvider } from "@motebit/tools";
import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import type { ExecutionReceipt } from "@motebit/molecule-runner";
import { McpClientAdapter } from "@motebit/mcp-client";
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
 * primitive — `McpClientAdapter` from `@motebit/mcp-client`. Returns
 * the signed `ExecutionReceipt` from the remote service, or null on
 * failure.
 *
 * The receipt capture happens automatically inside `McpClientAdapter` —
 * any motebit_task call whose response is a valid signed receipt is
 * pushed onto the adapter's `_delegationReceipts` queue, drained here
 * via `getAndResetDelegationReceipts()`. Nothing motebit-protocol-shaped
 * is reinvented — see CLAUDE.md "Protocol primitives belong in
 * packages, never inline in services" for the doctrine.
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
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.05");

  // Provider stack (outer → inner):
  //   BiasedSearchProvider     — rewrites first-party queries to include
  //                              site: operators before hitting the index.
  //   FallbackSearchProvider   — chain, stop-on-first-non-empty.
  //     ├─ Tavily (if key)     — primary. Agent-tuned ranking, structured
  //     │                        JSON, higher recall on niche/new domains.
  //     ├─ Brave (if key)      — fallback. Independent open-web index.
  //     └─ DuckDuckGo          — last resort. HTML scraping, no auth.
  //
  // Each tier is opt-in by env var; a deploy with neither Tavily nor
  // Brave key runs DuckDuckGo-only. Ordering Tavily first addresses the
  // "what is Motebit?" UX: generic indexes return Motobilt (Jeep parts)
  // for a bare "motebit" query because first-party content has near-zero
  // open-web signal yet; Tavily's ranking is less dominated by backlink
  // density.
  const chain: SearchProvider[] = [];
  if (config.tavilyApiKey) chain.push(new TavilySearchProvider(config.tavilyApiKey));
  if (config.braveApiKey) chain.push(new BraveSearchProvider(config.braveApiKey));
  chain.push(new DuckDuckGoSearchProvider());

  const searchProvider: SearchProvider = new BiasedSearchProvider(
    new FallbackSearchProvider(chain),
  );

  const SEARCH_CORS_ORIGINS = new Set([
    "https://motebit.com",
    "https://www.motebit.com",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
  ]);

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-web-search",
      displayName: "Web Search",
      serviceDescription: "Brave/DuckDuckGo web search + multi-hop delegation to read-url",
      capabilities: ["web_search", "read_url"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, publicKey, privateKey } = identity;

      const registry = new InMemoryToolRegistry();
      registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
      registry.register(readUrlDefinition, createReadUrlHandler());

      const handleAgentTask = async function* (
        prompt: string,
        options?: { delegatedScope?: string; relayTaskId?: string },
      ) {
        const taskId = crypto.randomUUID();
        const submittedAt = Date.now();

        let result: { ok: boolean; data?: unknown; error?: string };
        try {
          // The prompt from delegation is often a full sentence
          // ("Search for the current Bitcoin price in USD"). Brave
          // Search works best with keywords, not natural language.
          // Strip common filler to extract the core query.
          const query = prompt
            .replace(
              /\b(search\s+(for|the)?|find\s+(me\s+)?|look\s+up|what\s+is\s+(the\s+)?|tell\s+me\s+(about\s+)?|get\s+(me\s+)?|can\s+you|please|right\s+now|currently?|latest|return\s+the\s+result)\b/gi,
              " ",
            )
            .replace(/\s{2,}/g, " ")
            .trim();
          result = await registry.execute("web_search", { query: query || prompt });
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
          // Receipt result + result_hash are over the canonical form,
          // not the raw. buildServiceReceipt hashes whatever we pass as
          // `result`, so passing canonical preserves pre-existing
          // behavior.
          result: canonical,
          ok: result.ok,
          toolsUsed: ["web_search", ...(delegationReceipts ? ["read_url(delegated)"] : [])],
          relayTaskId: options?.relayTaskId,
          delegatedScope: options?.delegatedScope,
          delegationReceipts,
        });
        log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
        yield {
          type: "task_result" as const,
          receipt: signed as unknown as Record<string, unknown>,
        };
      };

      // REST /search route — same provider instance as the MCP tool
      const customRoutes = async (
        req: import("http").IncomingMessage,
        res: import("http").ServerResponse,
        url: URL,
      ): Promise<boolean> => {
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
            const results = await searchProvider.search(query, Math.min(maxResults ?? 5, 10));
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
      };

      return {
        toolRegistry: registry,
        handleAgentTask,
        customRoutes,
        getServiceListing: () =>
          Promise.resolve({
            capabilities: ["web_search", "read_url"],
            pricing: [
              { capability: "web_search", unit_cost: unitCost, currency: "USD", per: "request" },
              { capability: "read_url", unit_cost: unitCost, currency: "USD", per: "request" },
            ],
            sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
            description: `motebit-web-search-${motebitId.slice(0, 8)}`,
          }),
      };
    },
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
