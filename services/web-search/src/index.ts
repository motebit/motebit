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
import { verifySignedToken, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { embedText } from "@motebit/memory-graph";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3200", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/web-search.db",
    identityPath: process.env["MOTEBIT_IDENTITY_PATH"] ?? "./motebit.md",
    privateKeyHex: process.env["MOTEBIT_PRIVATE_KEY_HEX"],
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    braveApiKey: process.env["BRAVE_SEARCH_API_KEY"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
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

/**
 * Canonicalize search results for deterministic receipt hashing.
 * Strips tracking params, normalizes URLs, sorts by URL, takes top N.
 */
function canonicalizeResults(raw: string, maxResults = 5): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;

    const normalized = parsed
      .slice(0, maxResults)
      .map((r: Record<string, unknown>) => {
        const rawUrl = r["url"] ?? r["link"];
        let url = typeof rawUrl === "string" ? rawUrl : "";
        try {
          const u = new URL(url);
          for (const p of [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_content",
            "ref",
            "fbclid",
            "gclid",
          ]) {
            u.searchParams.delete(p);
          }
          url = u.toString();
        } catch {
          // Not a valid URL — keep as-is
        }
        const rawTitle = r["title"];
        const rawSnippet = r["snippet"] ?? r["description"];
        return {
          title: typeof rawTitle === "string" ? rawTitle : "",
          url,
          snippet: typeof rawSnippet === "string" ? rawSnippet : "",
        };
      })
      .sort((a, b) => a.url.localeCompare(b.url));

    return JSON.stringify(normalized);
  } catch {
    return raw;
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
    agentTrustStore: moteDb.agentTrustStore,
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
        result = await runtime.getToolRegistry().execute("web_search", { query: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();

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

      const receipt: Record<string, unknown> = {
        task_id: taskId,
        motebit_id: motebitId,
        device_id: "web-search-service",
        submitted_at: submittedAt,
        completed_at: completedAt,
        status: result.ok ? ("completed" as const) : ("failed" as const),
        result: canonical,
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
        // Cryptographic binding to the relay's economic identity for this task.
        // Included in the signed receipt — prevents cross-task replay attacks.
        ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
      };

      const signed = await signExecutionReceipt(
        receipt as Parameters<typeof signExecutionReceipt>[0],
        privateKey,
      );
      log(`receipt=${signed.signature.slice(0, 12)}… query="${prompt.slice(0, 60)}"`);
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    };
    log("Agent task handler enabled (receipts will be signed)");
  }

  // 5. Wire deps + start server (scaffold handles MCP, relay, shutdown)
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
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
