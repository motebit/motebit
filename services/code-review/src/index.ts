/**
 * Motebit Code Review Service
 *
 * An LLM-powered code review agent. Delegates the PR fetch to the
 * `read-url` atom (producing a signed delegation receipt), then reviews
 * the diff with Claude. The outer review receipt embeds the chain —
 * every delegation is cryptographically verifiable by anyone holding
 * `@motebit/crypto` and the participating agents' public keys.
 *
 * This is the first motebit molecule worth paying for — it delivers
 * judgment layered on verifiable retrieval, not a black box.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
import {
  wireServerDeps,
  startServiceServer,
  buildServiceReceipt,
  bootstrapAndEmitIdentity,
} from "@motebit/mcp-server";
import { parseRiskLevel } from "@motebit/identity-file";
import type { ExecutionReceipt } from "@motebit/sdk";
import { embedText } from "@motebit/memory-graph";
import { loadConfig } from "./helpers.js";
import { parsePrReference, prUrl } from "./github.js";
import { reviewPrViaMotebit } from "./review-via-motebit.js";
import type { ReviewConfig } from "./review-via-motebit.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// --- Tool definition ---

const reviewPrDefinition: ToolDefinition = {
  name: "review_pr",
  description: "Review a GitHub pull request and provide structured code feedback",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (e.g. 'motebit')" },
      repo: { type: "string", description: "Repository name (e.g. 'motebit')" },
      pr_number: { type: "number", description: "Pull request number" },
    },
    required: ["owner", "repo", "pr_number"],
  },
  riskHint: { risk: 1 }, // R1_DRAFT — network read, no side effects
};

function createReviewPrHandler(getReviewConfig: () => ReviewConfig): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const owner = args["owner"] as string;
    const repo = args["repo"] as string;
    const prNumber = args["pr_number"] as number;

    if (!owner || !repo || !prNumber) {
      return { ok: false, error: "Missing required parameters: owner, repo, pr_number" };
    }

    try {
      const url = prUrl({ owner, repo, number: prNumber });
      const r = await reviewPrViaMotebit(url, getReviewConfig());
      log(
        `review ${owner}/${repo}#${prNumber}: "${r.pr.title}" — ${r.review.length} chars, ${r.delegation_receipts.length} receipts`,
      );
      return {
        ok: true,
        data: JSON.stringify({
          pr: { owner, repo, number: prNumber, title: r.pr.title, author: r.pr.author },
          review: r.review,
          delegation_receipts: r.delegation_receipts,
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
    console.error("ANTHROPIC_API_KEY is required for the code review service.");
    process.exit(1);
  }
  if (!config.readUrlUrl) {
    console.error(
      "MOTEBIT_READ_URL_URL is required — code-review delegates PR fetching to the read-url atom.",
    );
    process.exit(1);
  }

  // 1-2. Bootstrap identity + emit signed motebit.md in one call.
  const serviceName = "motebit-code-review";
  const identity = await bootstrapAndEmitIdentity({
    dataDir: config.dataDir,
    serviceName,
    displayName: "Code Review",
    serviceDescription:
      "LLM-powered GitHub PR review. Delegates diff fetching to the read-url atom and returns a review with a verifiable delegation chain (signed delegation_receipts).",
    capabilities: ["review_pr"],
  });
  const { motebitId, deviceId, publicKey, privateKey, identityContent } = identity;
  const publicKeyHex = identity.publicKeyHex;
  log(
    `Identity ${identity.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 3. Build the ReviewConfig closed over the bootstrapped identity — this
  //    service signs the bearer tokens sent to read-url.
  const reviewConfig: ReviewConfig = {
    anthropicApiKey: config.anthropicApiKey,
    readUrlUrl: config.readUrlUrl,
    callerMotebitId: motebitId,
    callerDeviceId: deviceId,
    callerPrivateKey: privateKey,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    readUrlTargetId: config.readUrlTargetId,
  };

  // 4. Build tool registry
  const registry = new InMemoryToolRegistry();
  registry.register(
    reviewPrDefinition,
    createReviewPrHandler(() => reviewConfig),
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

  // Service motebit: auto-approve its own tools — review_pr is a
  // pre-approved network read with no side effects.
  const policyOverrides = {
    maxRiskAuto: parseRiskLevel("R3_EXECUTE"),
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (code review service)");

  // 6. Wire handleAgentTask — parse prompt, delegate fetch, review, sign receipt
  //    with the delegation chain.
  const handleAgentTask = async function* (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) {
    const taskId = crypto.randomUUID();
    const submittedAt = Date.now();

    const prRef = parsePrReference(prompt);
    let result: { ok: boolean; data?: string; error?: string };
    let delegationReceipts: ExecutionReceipt[] = [];

    if (!prRef) {
      result = {
        ok: false,
        error:
          "Could not parse PR reference. Use: owner/repo#123 or https://github.com/owner/repo/pull/123",
      };
    } else {
      try {
        const url = prUrl(prRef);
        const r = await reviewPrViaMotebit(url, reviewConfig);
        log(
          `PR ${prRef.owner}/${prRef.repo}#${prRef.number}: "${r.pr.title}" — ${r.review.length} chars, ${r.delegation_receipts.length} receipts`,
        );
        delegationReceipts = r.delegation_receipts;
        result = { ok: true, data: r.review };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
    }

    const resultStr = result.ok ? (result.data ?? "") : (result.error ?? "error");
    const signed = await buildServiceReceipt({
      motebitId,
      deviceId: "code-review-service",
      privateKey,
      publicKey,
      prompt,
      taskId,
      submittedAt,
      result: resultStr,
      ok: result.ok,
      toolsUsed: ["review_pr"],
      relayTaskId: options?.relayTaskId,
      delegatedScope: options?.delegatedScope,
      // The verifiable delegation chain — the read-url fetch is a signed
      // ExecutionReceipt from that atom.
      delegationReceipts,
    });
    log(
      `receipt=${signed.signature.slice(0, 12)}… pr=${prRef ? `${prRef.owner}/${prRef.repo}#${prRef.number}` : "none"} chain=${delegationReceipts.length}`,
    );
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 7. Wire deps + start server
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.50");
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    handleAgentTask,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
  });

  deps.getServiceListing = () =>
    Promise.resolve({
      capabilities: ["review_pr"],
      pricing: [{ capability: "review_pr", unit_cost: unitCost, currency: "USD", per: "review" }],
      sla: { max_latency_ms: 60_000, availability_guarantee: 0.95 },
      description: `motebit-code-review-${motebitId.slice(0, 8)}`,
    });

  await startServiceServer(deps, {
    name: `motebit-code-review-${motebitId.slice(0, 8)}`,
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
