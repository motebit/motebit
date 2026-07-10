/**
 * Motebit Clerk Service — "The Clerk" archetype
 * (docs/doctrine/agent-archetypes.md §6).
 *
 * A spending molecule: the money-execution pole opposite the Auditor's
 * zero-money verification. It holds a self-issued signed standing grant (a
 * signed, self-imposed spend ceiling — provisioned by the runner's
 * money-execution seam) and, on each delegated task, autonomously executes a
 * paid sub-delegation to a worker (the Researcher) within that ceiling.
 *
 * The spend is NOT an AI-loop tool the model chooses — it is a DETERMINISTIC
 * call into `MotebitRuntime.executeGrantedDelegation` (via the runner's `spend`
 * handle), which re-composes the full R4 AND fail-closed: verify the grant
 * (null ⇒ refuse), re-run the policy gate's scope check, and route the
 * broadcast through the meter-wrapped builder. The Clerk itself signs no money
 * artifact and imports no crypto — enforcement lives in the runtime primitive,
 * locked by `check-money-authority`. A refused spend yields an ok:false receipt
 * carrying only the denial CODE (never the overage — that residual is
 * owner-facing).
 *
 * Ships DRY-RUN-FIRST: `DRY_RUN` defaults true, so the entire metered spine
 * runs at hard-zero (no broadcast, live ceiling untouched). Flipping to live
 * money (`DRY_RUN=0`) is a deliberate operator step.
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ToolDefinition, ToolHandler } from "@motebit/tools";
import { loadConfig } from "./helpers.js";
import { parseClerkPrompt, ClerkRefusal, runClerkSpend, type SpendOutcome } from "./clerk.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console -- services log to stdout
  console.log(`[${ts}] ${msg}`);
}

const executeDefinition: ToolDefinition = {
  name: "execute_delegation",
  description:
    "Execute a paid sub-delegation to a worker under the Clerk's signed standing grant, within its self-imposed spend ceiling. Returns a signed receipt; an over-ceiling or out-of-scope spend is refused with a signed denial (no payment). Enforcement is the runtime's granted-spend AND (verify ∧ scope ∧ meter), not this tool.",
  inputSchema: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "The worker capability to hire (default: research)",
      },
      prompt: { type: "string", description: "The sub-task prompt handed to the worker" },
    },
    required: ["prompt"],
  },
  // R4_MONEY is HONEST: this entry can move money. But the tool registry is not
  // the enforcer — the deterministic primitive `executeGrantedDelegation` is
  // (check-money-authority). Declared so client-side policy renders the risk.
  riskHint: { risk: 4 },
};

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.solanaRpcUrl == null || config.relayPublicKey == null || config.syncUrl == null) {
    console.error(
      "The Clerk needs MOTEBIT_SOLANA_RPC_URL, MOTEBIT_RELAY_PUBLIC_KEY, and MOTEBIT_SYNC_URL — " +
        "the sovereign rail, the pinned P2P treasury root, and the relay to discover + settle through.",
    );
    process.exit(1);
  }

  log(
    `Boot: DRY_RUN=${config.dryRun ? "1 (no real money)" : "0 (LIVE MONEY)"} ceiling=${config.ceilingMicro}µ`,
  );

  await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-clerk",
      displayName: "The Clerk",
      serviceDescription:
        "Executes paid sub-delegations under a signed standing grant, within a self-imposed spend ceiling — the fail-closed proof of the R4 money spine. An over-ceiling or out-of-scope spend is refused with a signed denial; no payment. Dry-run-first.",
      capabilities: ["execute_delegation"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
      moneyExecution: {
        solanaRpcUrl: config.solanaRpcUrl,
        relayPublicKeyHex: config.relayPublicKey,
        spendCeiling: {
          schema: "motebit.spend-ceiling.v1",
          lifetime_limit_micro: config.ceilingMicro,
        },
      },
    },
    (identity, spend) => {
      if (spend == null) {
        // Unreachable: moneyExecution is always set above → the runner always
        // supplies the handle. Fail loudly if that invariant ever breaks.
        throw new Error("Clerk builder received no spend handle — moneyExecution seam not wired");
      }
      const { motebitId, deviceId, publicKey, privateKey } = identity;

      const executeHandler: ToolHandler = async (args: Record<string, unknown>) => {
        try {
          const task = parseClerkPrompt(
            JSON.stringify({
              ...(typeof args["capability"] === "string" ? { capability: args["capability"] } : {}),
              prompt: typeof args["prompt"] === "string" ? args["prompt"] : "",
            }),
            config.defaultCapability,
          );
          const outcome = await runClerkSpend(spend, task, config.dryRun);
          return outcome.ok
            ? { ok: true, data: outcome.result }
            : { ok: false, error: outcome.result };
        } catch (err: unknown) {
          if (err instanceof ClerkRefusal)
            return { ok: false, error: `[${err.code}] ${err.message}` };
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const registry = new InMemoryToolRegistry();
      registry.register(executeDefinition, executeHandler);

      const handleAgentTask = async function* (
        prompt: string,
        options?: { delegatedScope?: string; relayTaskId?: string },
      ) {
        const taskId = crypto.randomUUID();
        const submittedAt = Date.now();
        let outcome: SpendOutcome;
        try {
          const task = parseClerkPrompt(prompt, config.defaultCapability);
          outcome = await runClerkSpend(spend, task, config.dryRun);
        } catch (err: unknown) {
          const code = err instanceof ClerkRefusal ? err.code : "internal_error";
          const message = err instanceof Error ? err.message : String(err);
          log(`task refused: [${code}] ${message}`);
          outcome = {
            ok: false,
            result: JSON.stringify({ ok: false, code }),
            delegationReceipts: [],
          };
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
          result: outcome.result,
          ok: outcome.ok,
          toolsUsed: ["execute_delegation"],
          ...(options?.relayTaskId != null ? { relayTaskId: options.relayTaskId } : {}),
          ...(options?.delegatedScope != null ? { delegatedScope: options.delegatedScope } : {}),
          delegationReceipts: outcome.delegationReceipts,
        });
        log(`receipt=${signed.signature.slice(0, 12)}… ok=${outcome.ok}`);
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
            capabilities: ["execute_delegation"],
            pricing: [
              {
                capability: "execute_delegation",
                unit_cost: config.unitCost,
                currency: "USD",
                per: "task" as const,
              },
            ],
            sla: { max_latency_ms: 60_000, availability_guarantee: 0.95 },
            description:
              "Executes paid sub-delegations under a signed standing grant, within a self-imposed spend ceiling — the fail-closed proof of the R4 money spine. Over-ceiling or out-of-scope spends are refused with a signed denial; no payment.",
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
