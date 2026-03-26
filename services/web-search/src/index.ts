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
import { wireServerDeps, startServiceServer } from "@motebit/mcp-server";
import {
  verifyIdentityFile,
  governanceToPolicyConfig,
  parseRiskLevel,
} from "@motebit/identity-file";
import {
  verifySignedToken,
  signExecutionReceipt,
  hash as sha256,
  createSignedToken,
} from "@motebit/crypto";
import { embedText } from "@motebit/memory-graph";
import { loadConfig, fromHex, canonicalizeResults } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Sub-delegate a task to another service via raw MCP StreamableHTTP.
 * Returns the parsed receipt from the remote service, or null on failure.
 */
async function subDelegate(
  mcpUrl: string,
  prompt: string,
  callerMotebitId: string,
  callerDeviceId: string,
  callerPrivateKey: Uint8Array,
  /** Relay URL for budget allocation (optional — sub-delegates without budget if omitted). */
  syncUrl?: string,
  /** API token for relay calls. */
  apiToken?: string,
  /** Target motebit ID for relay task submission. */
  targetMotebitId?: string,
): Promise<Record<string, unknown> | null> {
  try {
    // Budget allocation: submit relay task for the sub-delegate (if relay configured)
    let subRelayTaskId: string | undefined;
    if (syncUrl && apiToken && targetMotebitId) {
      try {
        const relayHeaders: Record<string, string> = {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        };
        const taskResp = await fetch(`${syncUrl}/agent/${targetMotebitId}/task`, {
          method: "POST",
          headers: relayHeaders,
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

    // Create signed auth token for the remote service
    const token = await createSignedToken(
      {
        mid: callerMotebitId,
        did: callerDeviceId,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "task:submit",
      },
      callerPrivateKey,
    );

    const headers = (sid?: string): Record<string, string> => ({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer motebit:${token}`,
      ...(sid ? { "Mcp-Session-Id": sid } : {}),
    });

    let sessionId: string | undefined;
    let reqId = 0;

    // Helper: send MCP request, parse response (JSON or SSE)
    const mcpCall = async (method: string, params: unknown): Promise<unknown> => {
      const id = ++reqId;
      const resp = await fetch(mcpUrl, {
        method: "POST",
        headers: headers(sessionId),
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
      });
      const sid = resp.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const text = await resp.text();
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6)) as { id?: number; result?: unknown };
              if (parsed.id === id) return parsed;
            } catch {
              /* skip */
            }
          }
        }
        return null;
      }
      if (!resp.ok) return null;
      return resp.json();
    };

    // Initialize MCP session
    const init = (await mcpCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "bob-subdelegation", version: "0.1.0" },
    })) as { result?: unknown } | null;
    if (init == null || !("result" in (init as Record<string, unknown>))) return null;

    // Send initialized notification
    await fetch(mcpUrl, {
      method: "POST",
      headers: headers(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    // Call motebit_task (with relay_task_id for budget binding if available)
    const taskResult = (await mcpCall("tools/call", {
      name: "motebit_task",
      arguments: { prompt, ...(subRelayTaskId ? { relay_task_id: subRelayTaskId } : {}) },
    })) as { result?: { content?: Array<{ type: string; text?: string }> } } | null;

    if (!taskResult?.result?.content) return null;

    const text = taskResult.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const cleaned = text.replace(/\n?\[motebit:[^\]]+\]\s*$/, "");
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`sub-delegation failed: ${msg}`);
    return null;
  }
}

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

  const govConfig =
    identity.governance != null ? governanceToPolicyConfig(identity.governance) : null;

  // Service motebit: auto-approve its own tools (web_search, read_url, motebit_task)
  // The identity file may have conservative personal governance defaults — override
  // for service mode where all registered tools are pre-approved read-only operations.
  const policyOverrides = {
    ...(govConfig ?? {}),
    maxRiskAuto: parseRiskLevel("R3_EXECUTE"),
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (tool server mode — no LLM)");

  // 4. Wire handleAgentTask — direct tool execution with signed receipts
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
    handleAgentTask = async function* (
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
      const enc = new TextEncoder();
      const promptHash = await sha256(enc.encode(prompt));
      const resultHash = await sha256(enc.encode(canonical));

      // Multi-hop: sub-delegate URL reading to Charlie if configured
      let delegationReceipts: Record<string, unknown>[] | undefined;
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
              log(`sub-delegation receipt: ${(charlieReceipt.signature as string)?.slice(0, 12)}…`);
            }
          }
        } catch (subErr: unknown) {
          // Sub-delegation is best-effort — don't block the main receipt
          const subMsg = subErr instanceof Error ? subErr.message : String(subErr);
          log(`sub-delegation skipped: ${subMsg}`);
        }
      }

      const receipt: Record<string, unknown> = {
        task_id: taskId,
        motebit_id: motebitId,
        device_id: "web-search-service",
        submitted_at: submittedAt,
        completed_at: delegationReceipts ? Date.now() : searchCompletedAt,
        status: result.ok ? ("completed" as const) : ("failed" as const),
        result: canonical,
        tools_used: ["web_search", ...(delegationReceipts ? ["read_url(delegated)"] : [])],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
        // Cryptographic binding to the relay's economic identity for this task.
        ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
        // Delegated scope — must be included before signing so it's in the canonical form
        ...(options?.delegatedScope ? { delegated_scope: options.delegatedScope } : {}),
        // Nested receipts from sub-delegated work — chain of custody proof
        ...(delegationReceipts ? { delegation_receipts: delegationReceipts } : {}),
      };

      const signed = await signExecutionReceipt(
        receipt as Parameters<typeof signExecutionReceipt>[0],
        privateKey,
        fromHex(publicKeyHex),
      );
      log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    };
    log("Agent task handler enabled (receipts will be signed)");
  }

  // 5. Wire deps + start server (scaffold handles MCP, relay, shutdown)
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.10");
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    verifySignedToken,
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

  await startServiceServer(deps, {
    name: `motebit-web-search-${motebitId.slice(0, 8)}`,
    port: config.port,
    authToken: config.authToken,
    motebitType: "service",
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    publicEndpointUrl: config.publicUrl,
    onStart: (port, toolCount) => {
      log(`MCP server running on http://localhost:${port} (SSE). ${toolCount} tools exposed.`);
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
