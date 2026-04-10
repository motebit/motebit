/**
 * Motebit Code Review Service
 *
 * An LLM-powered code review agent. Fetches PR diffs from GitHub,
 * analyzes them with Claude, and returns structured reviews with
 * signed execution receipts proving provenance.
 *
 * This is the first motebit service worth paying for — it delivers
 * judgment, not just retrieval.
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
import { verifySignedToken, signExecutionReceipt, hash as sha256 } from "@motebit/encryption";
import { embedText } from "@motebit/memory-graph";
import { loadConfig, fromHex } from "./helpers.js";
import { parsePrReference, fetchPullRequest } from "./github.js";
import { reviewPullRequest } from "./review.js";
import { OAuthCredentialSource, GitHubOAuthTokenProvider } from "@motebit/mcp-client";

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

function createReviewPrHandler(
  anthropicApiKey: string,
  resolveToken: () => Promise<string | undefined>,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const owner = args["owner"] as string;
    const repo = args["repo"] as string;
    const prNumber = args["pr_number"] as number;

    if (!owner || !repo || !prNumber) {
      return { ok: false, error: "Missing required parameters: owner, repo, pr_number" };
    }

    try {
      const token = await resolveToken();
      const pr = await fetchPullRequest(owner, repo, prNumber, token);
      log(
        `fetched PR ${owner}/${repo}#${prNumber}: "${pr.title}" (${pr.changed_files} files, +${pr.additions} -${pr.deletions})`,
      );

      const review = await reviewPullRequest(pr, anthropicApiKey);
      log(`review complete: ${review.length} chars`);

      return {
        ok: true,
        data: JSON.stringify({
          pr: { owner, repo, number: prNumber, title: pr.title, author: pr.author },
          review,
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

  // GitHub token resolver: OAuth (auto-refresh) takes precedence over static token.
  let resolveGithubToken: () => Promise<string | undefined>;
  if (
    config.githubOAuthClientId &&
    config.githubOAuthClientSecret &&
    config.githubOAuthRefreshToken
  ) {
    const oauthSource = new OAuthCredentialSource(
      new GitHubOAuthTokenProvider({
        clientId: config.githubOAuthClientId,
        clientSecret: config.githubOAuthClientSecret,
        initialRefreshToken: config.githubOAuthRefreshToken,
      }),
    );
    resolveGithubToken = async () => {
      const token = await oauthSource.getCredential({ serverUrl: "https://api.github.com" });
      return token ?? undefined;
    };
    log("GitHub auth: OAuth (auto-refresh)");
  } else if (config.githubToken) {
    const staticToken = config.githubToken;
    resolveGithubToken = () => Promise.resolve(staticToken);
    log("GitHub auth: static token");
  } else {
    resolveGithubToken = () => Promise.resolve(undefined);
    log("GitHub auth: none (public rate limit)");
  }

  // 1. Bootstrap identity from the persistent data dir (generates on
  //    first boot, reloads on subsequent boots). Shared protocol —
  //    same bootstrap path every other surface uses.
  const serviceName = "motebit-code-review";
  const bootstrap = await bootstrapServiceIdentity({
    dataDir: path.resolve(config.dataDir),
    serviceName,
  });
  const { motebitId, deviceId, publicKeyHex, privateKeyHex } = bootstrap;
  log(
    `Identity ${bootstrap.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 2. Emit the canonical signed motebit.md from the bootstrapped state.
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
        service_name: "Code Review",
        service_description: "LLM-powered GitHub PR review with signed execution receipts",
        capabilities: ["review_pr"],
      },
    },
    privateKey,
  );
  fs.writeFileSync(bootstrap.suggestedIdentityPath, identityContent, "utf-8");

  // 2. Build tool registry
  const registry = new InMemoryToolRegistry();
  registry.register(
    reviewPrDefinition,
    createReviewPrHandler(config.anthropicApiKey, resolveGithubToken),
  );

  // 3. Open database + create runtime (no AI provider — LLM used directly in tool handler)
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

  // 4. Wire handleAgentTask — fetch PR, analyze with Claude, sign receipt.
  //    privateKey is unconditional (every bootstrapped service has one).
  const handleAgentTask = async function* (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) {
    const taskId = crypto.randomUUID();
    const submittedAt = Date.now();

    const prRef = parsePrReference(prompt);
    let result: { ok: boolean; data?: string; error?: string };

    if (!prRef) {
      result = {
        ok: false,
        error:
          "Could not parse PR reference. Use: owner/repo#123 or https://github.com/owner/repo/pull/123",
      };
    } else {
      try {
        const token = await resolveGithubToken();
        const pr = await fetchPullRequest(prRef.owner, prRef.repo, prRef.number, token);
        log(
          `PR ${prRef.owner}/${prRef.repo}#${prRef.number}: "${pr.title}" (${pr.changed_files} files)`,
        );

        const review = await reviewPullRequest(pr, config.anthropicApiKey!);
        log(`review complete: ${review.length} chars`);

        result = { ok: true, data: review };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
    }

    const resultStr = result.ok ? (result.data ?? "") : (result.error ?? "error");
    const enc = new TextEncoder();
    const promptHash = await sha256(enc.encode(prompt));
    const resultHash = await sha256(enc.encode(resultStr));

    const receipt: Record<string, unknown> = {
      task_id: taskId,
      motebit_id: motebitId,
      device_id: "code-review-service",
      submitted_at: submittedAt,
      completed_at: Date.now(),
      status: result.ok ? ("completed" as const) : ("failed" as const),
      result: resultStr,
      tools_used: ["review_pr"],
      memories_formed: 0,
      prompt_hash: promptHash,
      result_hash: resultHash,
      ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
      ...(options?.delegatedScope ? { delegated_scope: options.delegatedScope } : {}),
    };

    const signed = await signExecutionReceipt(
      receipt as Parameters<typeof signExecutionReceipt>[0],
      privateKey,
      fromHex(publicKeyHex),
    );
    log(
      `receipt=${signed.signature.slice(0, 12)}… pr=${prRef ? `${prRef.owner}/${prRef.repo}#${prRef.number}` : "none"}`,
    );
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 5. Wire deps + start server
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.50");
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
