/**
 * Motebit Research Service — an agent that takes a research question,
 * delegates to motebit's web-search/ and read-url/ atoms via the
 * standard task-submission protocol, accumulates their signed
 * `ExecutionReceipt`s, and emits a top-level receipt whose
 * `delegation_receipts` field is the signed citation chain.
 *
 * Synthesis logic and citation-chain doctrine live in `research.ts`.
 * This file owns what's specific to research — the env-derived config,
 * the research tool definition, the handleAgentTask synthesis turn —
 * and defers every piece of boot plumbing (identity, database, runtime,
 * MCP server wiring) to `@motebit/molecule-runner`.
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import type { ExecutionReceipt } from "@motebit/molecule-runner";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
import { loadConfig } from "./helpers.js";
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

  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.25");

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-research",
      displayName: "Research",
      serviceDescription:
        "Web research agent — investigates a question via motebit's web-search and read-url atoms, returns a synthesized report with a verifiable citation chain (signed delegation_receipts)",
      capabilities: ["research"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, deviceId, publicKey, privateKey } = identity;

      // Build the ResearchConfig the handler/research turn will use.
      // Closes over the bootstrapped identity (this agent signs the
      // bearer tokens sent to web-search and read-url) and the
      // env-configured atom URLs.
      const researchConfig: ResearchConfig = {
        anthropicApiKey: config.anthropicApiKey!,
        webSearchUrl: config.webSearchUrl!,
        readUrlUrl: config.readUrlUrl!,
        callerMotebitId: motebitId,
        callerDeviceId: deviceId,
        callerPrivateKey: privateKey,
        maxToolCalls: config.maxToolCalls,
        ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
        ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
        ...(config.webSearchTargetId != null
          ? { webSearchTargetId: config.webSearchTargetId }
          : {}),
        ...(config.readUrlTargetId != null ? { readUrlTargetId: config.readUrlTargetId } : {}),
      };

      const registry = new InMemoryToolRegistry();
      registry.register(
        researchDefinition,
        createResearchHandler(() => researchConfig),
      );

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
            `research complete: ${r.report.length} chars, ${r.recall_self_count} interior, ${r.search_count} searches, ${r.fetch_count} fetches, ${r.citations.length} citations`,
          );
          delegationReceipts = r.delegation_receipts as unknown as Record<string, unknown>[];
          // The wire payload now carries the citation list. Interior
          // citations are self-attested (no receipt_task_id); web
          // citations bind to the atom receipt already in
          // delegation_receipts via receipt_task_id. Callers build a
          // `CitedAnswer` by pairing `result.data.report` +
          // `result.data.citations` with the outer signed receipt this
          // handler returns — the data is shaped so that assembly is a
          // zero-copy map.
          result = {
            ok: true,
            data: JSON.stringify({
              report: r.report,
              citations: r.citations,
              recall_self_count: r.recall_self_count,
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
          publicKey,
          prompt,
          taskId,
          submittedAt,
          result: resultStr,
          ok: result.ok,
          toolsUsed: ["research"],
          relayTaskId: options?.relayTaskId,
          delegatedScope: options?.delegatedScope,
          // The verifiable citation chain — every search and fetch is a
          // signed ExecutionReceipt from the corresponding atom service.
          delegationReceipts: delegationReceipts as unknown as ExecutionReceipt[],
        });
        log(
          `receipt=${signed.signature.slice(0, 12)}… chain=${delegationReceipts.length} question="${prompt.slice(0, 60)}"`,
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
            capabilities: ["research"],
            pricing: [
              { capability: "research", unit_cost: unitCost, currency: "USD", per: "report" },
            ],
            sla: { max_latency_ms: 120_000, availability_guarantee: 0.95 },
            description: `motebit-research-${motebitId.slice(0, 8)}`,
          }),
      };
    },
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
