/**
 * Motebit Auditor Service — "The Auditor" archetype
 * (docs/doctrine/agent-archetypes.md).
 *
 * An LLM-free molecule that measures another agent's PUBLIC verification
 * surface — identity binding, key succession, operator revocation,
 * delegator-supplied receipt spot-checks, bond integrity — and signs the
 * measurements as an EvalAttestation (subject ≠ signer;
 * spec/eval-attestation-v1.md; docs/doctrine/evals-as-attestations.md).
 *
 * Composition semantics: the ExecutionReceipt this service yields is the
 * FIRST-PERSON act ("I performed this audit task"); the attestation inside
 * its result payload is the THIRD-PARTY measurement, independently
 * verifiable via verifyEvalAttestation after JSON.parse. Two artifacts,
 * two categories, one hand-off.
 *
 * Boundary discipline: the entire evidence catalog is the relay's
 * UNAUTHENTICATED public endpoint surface, fetched through a fetcher
 * structurally pinned to one relay origin — the archetype cannot have
 * privileged access even by accident (agent-archetypes.md §1). Laws come
 * only from @motebit/verifier + @motebit/state-export-client
 * (check-service-primitives).
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import { signEvalAttestation } from "@motebit/verifier";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
import { loadConfig } from "./helpers.js";
import { runAudit, parseAuditPrompt, AuditRefusal, type AuditDeps } from "./audit.js";
import { createRelayFetcher } from "./evidence.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const auditDefinition: ToolDefinition = {
  name: "audit_agent",
  description:
    "Measure another agent's public verification surface (identity binding, key succession, operator revocation, supplied-receipt spot-checks, bond integrity) and return a signed EvalAttestation whose every measurement is a per-axis verdict",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "The motebit_id of the agent to audit" },
      checks: {
        type: "array",
        items: { type: "string" },
        description:
          "Check names to run (identity_binding, succession, revocation, bond, receipt_spot_check); defaults to all applicable",
      },
      receipts: {
        type: "array",
        items: { type: "object" },
        description: "Signed ExecutionReceipts of the target to spot-check (delegator-supplied)",
      },
    },
    required: ["target"],
  },
  riskHint: { risk: 1 }, // R1_DRAFT — public network reads only
};

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.relayUrl) {
    console.error(
      "MOTEBIT_RELAY_URL (or MOTEBIT_SYNC_URL) is required — the relay's public endpoints are the audit evidence source.",
    );
    process.exit(1);
  }

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-auditor",
      displayName: "The Auditor",
      serviceDescription:
        "Audits agents against the public verification surface — identity binding, key succession, operator revocation, receipt spot-checks, bond integrity — and returns a signed eval attestation whose every measurement is a per-axis verdict you can re-check yourself. No LLM; pure verification.",
      capabilities: ["audit_agent"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, deviceId, publicKey, privateKey } = identity;
      const issuerKeyHex = bytesToHexLocal(publicKey);
      const fetchRelay = createRelayFetcher(config.relayUrl!);

      const baseDeps = (invocation?: AuditDeps["invocation"]): AuditDeps => ({
        fetchRelay,
        ...(config.relayPublicKey != null ? { pinnedRelayKey: config.relayPublicKey } : {}),
        now: () => Date.now(),
        receiptSampleN: config.receiptSampleN,
        issuer: { motebitId, publicKeyHex: issuerKeyHex },
        ...(invocation ? { invocation } : {}),
      });

      const auditHandler: ToolHandler = async (args: Record<string, unknown>) => {
        try {
          const rawTarget = args["target"];
          const req = {
            target: typeof rawTarget === "string" ? rawTarget : "",
            ...(Array.isArray(args["checks"]) ? { checks: args["checks"].map(String) } : {}),
            ...(Array.isArray(args["receipts"]) ? { receipts: args["receipts"] } : {}),
          };
          const outcome = await runAudit(req, baseDeps());
          const attestation = await signEvalAttestation(outcome.body, privateKey);
          log(`audit complete: ${outcome.summary}`);
          return { ok: true, data: JSON.stringify({ attestation, summary: outcome.summary }) };
        } catch (err: unknown) {
          if (err instanceof AuditRefusal) {
            log(`audit refused: [${err.code}] ${err.message}`);
            return { ok: false, error: `[${err.code}] ${err.message}` };
          }
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg };
        }
      };

      const registry = new InMemoryToolRegistry();
      registry.register(auditDefinition, auditHandler);

      const handleAgentTask = async function* (
        prompt: string,
        options?: { delegatedScope?: string; relayTaskId?: string },
      ) {
        const taskId = crypto.randomUUID();
        const submittedAt = Date.now();
        let resultStr: string;
        let ok = true;

        try {
          const req = parseAuditPrompt(prompt);
          const outcome = await runAudit(
            req,
            baseDeps({
              task_id: taskId,
              ...(options?.relayTaskId != null ? { relay_task_id: options.relayTaskId } : {}),
            }),
          );
          const attestation = await signEvalAttestation(outcome.body, privateKey);
          resultStr = JSON.stringify({ attestation, summary: outcome.summary });
          log(`audit complete: ${outcome.summary}`);
        } catch (err: unknown) {
          // Refusal path: ok:false receipt, NO attestation — the refusal is
          // itself signed (the receipt), but no measurement is minted.
          ok = false;
          if (err instanceof AuditRefusal) {
            resultStr = `[${err.code}] ${err.message}`;
            log(`audit refused: ${resultStr}`);
          } else {
            resultStr = err instanceof Error ? err.message : String(err);
            log(`audit failed: ${resultStr}`);
          }
        }

        const completedAt = Date.now();
        const signed = await buildServiceReceipt({
          motebitId,
          deviceId,
          privateKey,
          publicKey,
          prompt,
          taskId,
          submittedAt,
          completedAt,
          result: resultStr,
          ok,
          toolsUsed: ["audit_agent"],
          relayTaskId: options?.relayTaskId,
          delegatedScope: options?.delegatedScope,
          delegationReceipts: [],
        });
        log(`receipt=${signed.signature.slice(0, 12)}… target="${prompt.slice(0, 60)}"`);
        yield {
          type: "task_result" as const,
          receipt: signed as unknown as Record<string, unknown>,
        };
      };

      return {
        toolRegistry: registry,
        handleAgentTask,
        // audit_agent is read-only — public network reads, no side effects.
        policyOverrides: {},
        getServiceListing: () =>
          Promise.resolve({
            capabilities: ["audit_agent"],
            pricing: [
              {
                capability: "audit_agent",
                unit_cost: config.unitCost,
                currency: "USD",
                per: "task",
              },
            ],
            sla: { max_latency_ms: 30_000, availability_guarantee: 0.95 },
            description:
              "Audits agents against the public verification surface — identity binding, key succession, operator revocation, receipt spot-checks, bond integrity — and returns a signed eval attestation whose every measurement is a per-axis verdict you can re-check yourself. No LLM; pure verification.",
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
