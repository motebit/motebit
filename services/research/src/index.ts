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

import {
  buildServiceReceipt,
  runMolecule,
  createProviderReadiness,
} from "@motebit/molecule-runner";
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
        `research complete: ${result.report.length} chars, ${result.search_count} searches, ${result.fetch_count} fetches, ${result.delegation_receipts.length} receipts, report_cost_estimate_usd=${result.cost_estimate_usd.toFixed(4)}`,
      );
      return {
        ok: true,
        data: JSON.stringify({
          question,
          report: result.report,
          delegation_receipts: result.delegation_receipts,
          sub_settlements: result.sub_settlements,
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

  // Default covers worst-case sonnet inference (~$0.26–0.42/report at the
  // 8-tool-call cap) — the per-report cost_estimate_usd log is the tuning
  // signal before any prod price change.
  const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.25");

  // Readiness: detected passively from real task failures (free), recovered
  // actively by the cheapest possible provider round-trip — one token, and only
  // while already dark, since no tasks arrive to prove recovery on their own.
  const readiness = createProviderReadiness({
    probe: async () => {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicApiKey ?? "",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return resp.ok;
    },
  });

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-research",
      displayName: "The Researcher",
      serviceDescription:
        "Web research agent — investigates a question via motebit's web-search and read-url atoms, returns a synthesized report with a verifiable citation chain (signed delegation_receipts)",
      capabilities: ["research"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
      // Inc 2b — paid sub-delegation seam, opt-in via env. When BOTH the Solana
      // RPC and the pinned relay key are set, the Researcher pays priced atoms
      // P2P from its own wallet under a self-issued grant; absent ⇒ no spend
      // handle ⇒ the free direct-MCP path (today). The atoms are still $0, so
      // even with this set the P2P attempt degrades to direct (worker_not_payable)
      // until Inc 3 prices them.
      ...(config.solanaRpcUrl != null && config.relayPublicKey != null
        ? {
            moneyExecution: {
              solanaRpcUrl: config.solanaRpcUrl,
              relayPublicKeyHex: config.relayPublicKey,
              // Match the wallet rail's USDC mint to the network behind the RPC
              // (devnet on staging) — else the balance pre-check reads the empty
              // mainnet-USDC ATA and every hop fails `insufficient_balance`.
              ...(config.solanaUsdcMint != null ? { usdcMint: config.solanaUsdcMint } : {}),
              spendCeiling: {
                schema: "motebit.spend-ceiling.v1" as const,
                lifetime_limit_micro: config.ceilingMicro,
              },
            },
          }
        : {}),
    },
    (identity, spend) => {
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
        // Inc 2b — thread the money runtime's spend handle as the paid
        // sub-delegation seam (present only when moneyExecution was wired above).
        // The research turn attempts P2P for priced atoms and reads the atom's
        // receipt from the granted-delegation result.
        ...(spend != null
          ? {
              paidSubDelegate: async (p: {
                capability: string;
                prompt: string;
                targetWorkerId?: string;
              }) => {
                const r = await spend.spend(p);
                if (!r.ok) return { ok: false as const, code: r.code };
                // The research turn never dry-runs, so the live variant carries
                // the atom's receipt; the dry-run variant is unreachable here.
                if (r.dryRun) return { ok: true as const };
                // Surface the money fact so the molecule can self-attest the paid
                // hop in its signed receipt (mode + onchain tx) — the runtime
                // populated it from the payment proof; dropping it here is what
                // left the multi-hop-P2P claim un-self-attesting.
                return {
                  ok: true as const,
                  receipt: r.receipt,
                  ...(r.settlement != null ? { settlement: r.settlement } : {}),
                  ...(r.routingTranscript != null
                    ? {
                        routingTranscript: r.routingTranscript as unknown as Record<
                          string,
                          unknown
                        >,
                      }
                    : {}),
                };
              },
            }
          : {}),
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
          // #479 backstop at the signing seam: research() already refuses an
          // empty synthesis, but the receipt is signed HERE — a completed
          // receipt over an empty body must be structurally impossible, not
          // a library courtesy (composition-preserves-enforcement).
          if (r.report.trim() === "") {
            throw new Error(
              "empty report body — refusing to sign a completed receipt over an empty artifact",
            );
          }
          // The reprice tuning signal (2026-08-01): cost was logged only on
          // the unused tool-registry path — the HIRE path priced blind.
          log(
            `research complete: ${r.report.length} chars, ${r.recall_self_count} interior, ${r.search_count} searches, ${r.fetch_count} fetches, ${r.citations.length} citations, report_cost_estimate_usd=${r.cost_estimate_usd.toFixed(4)}`,
          );
          // A completed research turn is the strongest readiness evidence there is.
          readiness.recordSuccess();
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
              // The self-attested money facts of the paid atom hops — signed into
              // this receipt so a verifier confirms the molecule paid its atoms
              // P2P (mode + onchain tx) from bytes alone, and the conformance
              // probe FAILS if external atom work happened for free.
              sub_settlements: r.sub_settlements,
              // The delegator-signed routing transcripts of the ranked paid
              // hops — the "why this worker won" record, verifiable on both
              // rungs by anyone holding this signed receipt.
              routing_transcripts: r.routing_transcripts,
              recall_self_count: r.recall_self_count,
              search_count: r.search_count,
              fetch_count: r.fetch_count,
            }),
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // The refusal is signed into the receipt either way — but a receipt
          // is read by the BUYER, not by the operator tailing these logs. With
          // no log here the success path printed "research complete: …" and the
          // failure path printed nothing at all, so a dead service looked like
          // a quiet one: six nights of staging conformance red (2026-08-27 →
          // 09-01) with the cause ("credit balance is too low") visible only to
          // whoever thought to fetch the stored receipt off the relay. An
          // honest failure must be as loud in the log as an honest success.
          log(`research FAILED: ${msg}`);
          // Feed the real failure to the readiness tracker. A durable operator
          // condition (exhausted credit, revoked key) stops this agent
          // advertising rather than letting it keep selling refusals (#610).
          readiness.recordFailure(msg);
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
        checkReadiness: () => readiness.check(),
        getServiceListing: () =>
          Promise.resolve({
            capabilities: ["research"],
            pricing: [
              { capability: "research", unit_cost: unitCost, currency: "USD", per: "task" },
            ],
            sla: { max_latency_ms: 120_000, availability_guarantee: 0.95 },
            description:
              "Research with receipts: composes web-search and read-url atoms, returns a cited report whose every web claim carries a content digest you can re-verify. The delegation chain arrives as nested signed receipts.",
          }),
      };
    },
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
