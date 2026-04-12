/**
 * Motebit Research Service
 *
 * The first **molecule** in the marketplace: an agent that takes a research
 * question, delegates to motebit's web-search/ and read-url/ atoms via the
 * standard task-submission protocol, accumulates their signed
 * ExecutionReceipts, and emits a top-level receipt whose
 * `delegation_receipts` field IS the verifiable citation chain.
 *
 * Anyone with @motebit/crypto and the relevant public keys can re-derive the
 * provenance graph offline — no relay dependency.
 *
 * Doctrine: the citation IS the receipt — not a label next to one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
import { wireServerDeps, startServiceServer } from "@motebit/mcp-server";
import { bootstrapServiceIdentity } from "@motebit/core-identity/node";
import { generate, parseRiskLevel } from "@motebit/identity-file";
import { verifySignedToken } from "@motebit/encryption";
import { buildServiceReceipt } from "@motebit/mcp-server";
import type { ExecutionReceipt } from "@motebit/sdk";
import { embedText } from "@motebit/memory-graph";
import { loadConfig, fromHex } from "./helpers.js";
import { research } from "./research.js";
import type { ResearchConfig } from "./research.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// --- Tool definition ---

const researchDefinition: ToolDefinition = {
  name: "research",
  description:
    "Investigate a question via motebit web-search + read-url, return a synthesized report with a cryptographic citation chain (delegation_receipts)",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The research question or topic to investigate" },
    },
    required: ["question"],
  },
  riskHint: { risk: 1 }, // R1_DRAFT — network reads only, no side effects
};

function createResearchHandler(getResearchConfig: () => ResearchConfig): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const question = args["question"] as string;
    if (!question || question.trim().length === 0) {
      return { ok: false, error: "Missing required parameter: question" };
    }

    try {
      const result = await research(question, getResearchConfig());
      log(
        `research complete: ${result.report.length} chars, ${result.search_count} searches, ${result.fetch_count} fetches, ${result.delegation_receipts.length} receipts`,
      );
      return {
        ok: true,
        data: JSON.stringify({
          question,
          report: result.report,
          delegation_receipts: result.delegation_receipts,
          search_count: result.search_count,
          fetch_count: result.fetch_count,
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };
}

// --- Main ---

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is required for the research service.");
    process.exit(1);
  }
  if (!config.webSearchUrl || !config.readUrlUrl) {
    console.error(
      "MOTEBIT_WEB_SEARCH_URL and MOTEBIT_READ_URL_URL are required — research delegates citations to those atoms.",
    );
    process.exit(1);
  }

  // 1. Bootstrap identity from the persistent data dir (generates on first
  //    boot, reloads on subsequent boots). Same path every other surface uses.
  const serviceName = "motebit-research";
  const bootstrap = await bootstrapServiceIdentity({
    dataDir: path.resolve(config.dataDir),
    serviceName,
  });
  const { motebitId, deviceId, publicKeyHex, privateKeyHex } = bootstrap;
  log(
    `Identity ${bootstrap.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 2. Emit the canonical signed motebit.md
  const privateKey = fromHex(privateKeyHex);
  const identityContent = await generate(
    {
      motebitId,
      ownerId: serviceName,
      publicKeyHex,
      devices: [
        {
          device_id: deviceId,
          name: serviceName,
          public_key: publicKeyHex,
          registered_at: new Date().toISOString(),
        },
      ],
      service: {
        type: "service",
        service_name: "Research",
        service_description:
          "Web research agent — investigates a question via motebit's web-search and read-url atoms, returns a synthesized report with a verifiable citation chain (signed delegation_receipts)",
        capabilities: ["research"],
      },
    },
    privateKey,
  );
  fs.writeFileSync(bootstrap.suggestedIdentityPath, identityContent, "utf-8");

  // 3. Build the ResearchConfig the handler/research turn will use. Closes
  //    over the bootstrapped identity (this agent signs the bearer tokens
  //    sent to web-search and read-url) and the env-configured atom URLs.
  const researchConfig: ResearchConfig = {
    anthropicApiKey: config.anthropicApiKey,
    webSearchUrl: config.webSearchUrl,
    readUrlUrl: config.readUrlUrl,
    callerMotebitId: motebitId,
    callerDeviceId: deviceId,
    callerPrivateKey: privateKey,
    maxToolCalls: config.maxToolCalls,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    webSearchTargetId: config.webSearchTargetId,
    readUrlTargetId: config.readUrlTargetId,
  };

  // 4. Build tool registry
  const registry = new InMemoryToolRegistry();
  registry.register(
    researchDefinition,
    createResearchHandler(() => researchConfig),
  );

  // 5. Open database + create runtime
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

  // Service motebit: auto-approve its own tool — research is a pre-approved
  // network-read with no side effects.
  const policyOverrides = {
    maxRiskAuto: parseRiskLevel("R3_EXECUTE"),
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (research service)");

  // 6. Wire handleAgentTask — interpret the prompt as a research question,
  //    run the synthesis turn, sign the receipt with the citation chain.
  const handleAgentTask = async function* (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) {
    const taskId = crypto.randomUUID();
    const submittedAt = Date.now();

    let result: { ok: boolean; data?: string; error?: string };
    let delegationReceipts: Record<string, unknown>[] = [];
    try {
      const r = await research(prompt, researchConfig);
      log(
        `research complete: ${r.report.length} chars, ${r.search_count} searches, ${r.fetch_count} fetches`,
      );
      delegationReceipts = r.delegation_receipts as unknown as Record<string, unknown>[];
      result = {
        ok: true,
        data: JSON.stringify({
          report: r.report,
          search_count: r.search_count,
          fetch_count: r.fetch_count,
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: msg };
    }

    const resultStr = result.ok ? (result.data ?? "") : (result.error ?? "error");
    const signed = await buildServiceReceipt({
      motebitId,
      deviceId: "research-service",
      privateKey,
      publicKey: fromHex(publicKeyHex),
      prompt,
      taskId,
      submittedAt,
      result: resultStr,
      ok: result.ok,
      toolsUsed: ["research"],
      relayTaskId: options?.relayTaskId,
      delegatedScope: options?.delegatedScope,
      // The verifiable citation chain — every search and fetch is a signed
      // ExecutionReceipt from the corresponding atom service.
      delegationReceipts: delegationReceipts as unknown as ExecutionReceipt[],
    });
    log(
      `receipt=${signed.signature.slice(0, 12)}… chain=${delegationReceipts.length} question="${prompt.slice(0, 60)}"`,
    );
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 7. Wire deps + start server
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.25");
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

  deps.getServiceListing = () =>
    Promise.resolve({
      capabilities: ["research"],
      pricing: [{ capability: "research", unit_cost: unitCost, currency: "USD", per: "report" }],
      sla: { max_latency_ms: 120_000, availability_guarantee: 0.95 },
      description: `motebit-research-${motebitId.slice(0, 8)}`,
    });

  await startServiceServer(deps, {
    name: `motebit-research-${motebitId.slice(0, 8)}`,
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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
