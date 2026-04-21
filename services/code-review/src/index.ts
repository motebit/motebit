/**
 * Motebit Code Review Service
 *
 * An LLM-powered code review agent. Delegates the PR fetch to the
 * `read-url` atom (producing a signed delegation receipt), then reviews
 * the diff with Claude. The outer review receipt embeds the chain —
 * every delegation is cryptographically verifiable by anyone holding
 * `@motebit/crypto` and the participating agents' public keys.
 *
 * Boot plumbing (identity + DB + runtime + MCP server wiring) lives in
 * `@motebit/molecule-runner`. This file only owns what's specific to
 * code-review: the env-derived config, the review tool definition, and
 * the `handleAgentTask` generator that parses a PR reference from the
 * prompt.
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import type { ExecutionReceipt } from "@motebit/molecule-runner";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
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

  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.50");

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-code-review",
      displayName: "Code Review",
      serviceDescription:
        "LLM-powered GitHub PR review. Delegates diff fetching to the read-url atom and returns a review with a verifiable delegation chain (signed delegation_receipts).",
      capabilities: ["review_pr"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, deviceId, publicKey, privateKey } = identity;

      // Build the ReviewConfig closed over the bootstrapped identity —
      // this service signs the bearer tokens sent to read-url.
      const reviewConfig: ReviewConfig = {
        anthropicApiKey: config.anthropicApiKey!,
        readUrlUrl: config.readUrlUrl!,
        callerMotebitId: motebitId,
        callerDeviceId: deviceId,
        callerPrivateKey: privateKey,
        ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
        ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
        ...(config.readUrlTargetId != null ? { readUrlTargetId: config.readUrlTargetId } : {}),
      };

      const registry = new InMemoryToolRegistry();
      registry.register(
        reviewPrDefinition,
        createReviewPrHandler(() => reviewConfig),
      );

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
          // The verifiable delegation chain — the read-url fetch is a
          // signed ExecutionReceipt from that atom.
          delegationReceipts,
        });
        log(
          `receipt=${signed.signature.slice(0, 12)}… pr=${prRef ? `${prRef.owner}/${prRef.repo}#${prRef.number}` : "none"} chain=${delegationReceipts.length}`,
        );
        yield {
          type: "task_result" as const,
          receipt: signed as unknown as Record<string, unknown>,
        };
      };

      return {
        toolRegistry: registry,
        handleAgentTask,
        getServiceListing: () =>
          Promise.resolve({
            capabilities: ["review_pr"],
            pricing: [
              { capability: "review_pr", unit_cost: unitCost, currency: "USD", per: "review" },
            ],
            sla: { max_latency_ms: 60_000, availability_guarantee: 0.95 },
            description: `motebit-code-review-${motebitId.slice(0, 8)}`,
          }),
      };
    },
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
