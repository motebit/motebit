// --- CLI subcommand handlers (non-REPL) ---
//
// This file is being progressively extracted into `./subcommands/{topic}.ts`
// files, following the same leaves-first pattern used for the desktop,
// mobile, spatial, and runtime extractions. Each extracted topic is
// re-exported from the block at the top of this file so the one
// importer (`./index.ts`) doesn't need to change. When extraction is
// complete this file becomes a ~30-line barrel.

// Extracted topics (re-export barrel)
export { handleDoctor } from "./subcommands/doctor.js";
export { handleExport } from "./subcommands/export.js";
export {
  handleGoalAdd,
  handleGoalList,
  handleGoalOutcomes,
  handleGoalRemove,
  handleGoalSetEnabled,
} from "./subcommands/goals.js";
export {
  handleApprovalList,
  handleApprovalShow,
  handleApprovalApprove,
  handleApprovalDeny,
} from "./subcommands/approvals.js";
export { handleId } from "./subcommands/id.js";
export { handleLedger } from "./subcommands/ledger.js";
export { handleCredentials } from "./subcommands/credentials.js";
export { handleVerify } from "./subcommands/verify.js";
export { handleRegister } from "./subcommands/register.js";
export {
  handleFederationStatus,
  handleFederationPeers,
  handleFederationPeer,
} from "./subcommands/federation.js";
export { handleRotate } from "./subcommands/rotate.js";

// Shared helpers used by handlers that haven't been extracted yet
// (federation, rotate, market, delegate). Will become unused once
// T10–T13 land.
import { fetchRelayJson, getRelayUrl, getRelayAuthHeaders } from "./subcommands/_helpers.js";

import { openMotebitDatabase } from "@motebit/persistence";
import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { StepDelegationAdapter } from "@motebit/planner";
import type { CliConfig } from "./args.js";
import { loadFullConfig } from "./config.js";
import { getDbPath } from "./runtime-factory.js";
import { formatTimeAgo } from "./utils.js";
// ---------------------------------------------------------------------------
// motebit balance — show virtual account balance and recent transactions
// ---------------------------------------------------------------------------

export async function handleBalance(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config);

  const result = await fetchRelayJson(`${relayUrl}/api/v1/agents/${motebitId}/balance`, headers);
  if (!result.ok) {
    console.error(`Failed to get balance: ${result.error}`);
    process.exit(1);
  }

  const data = result.data as {
    balance: number;
    currency: string;
    transactions: Array<{
      type: string;
      amount: number;
      created_at: string;
    }>;
  };

  if (config.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\nBalance: $${data.balance.toFixed(2)} ${data.currency}`);
  const recent = (data.transactions ?? []).slice(0, 5);
  if (recent.length > 0) {
    console.log("Recent:");
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? "+" : "";
      const ago = formatTimeAgo(Date.now() - new Date(tx.created_at).getTime());
      console.log(`  ${sign}$${Math.abs(tx.amount).toFixed(2)}  ${tx.type.padEnd(20)} ${ago}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// motebit withdraw <amount> [--destination <addr>]
// ---------------------------------------------------------------------------

export async function handleWithdraw(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit withdraw <amount> [--destination <addr>]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error("Error: amount must be a positive number.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { json: true });

  const body: Record<string, unknown> = { amount };
  if (config.destination) body["destination"] = config.destination;

  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    if (res.status === 402) {
      console.error("Insufficient balance.");
      process.exit(1);
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`Withdrawal failed (${res.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const data = (await res.json()) as { withdrawal_id?: string };
    console.log(`Withdrawal of $${amount.toFixed(2)} submitted.`);
    if (data.withdrawal_id != null && data.withdrawal_id !== "") {
      console.log(`  ID: ${data.withdrawal_id}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// motebit fund <amount> — deposit via Stripe Checkout
// ---------------------------------------------------------------------------

export async function handleFund(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit fund <amount>");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 0.5) {
    console.error("Error: minimum amount is $0.50.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { json: true });

  // Create Stripe Checkout session
  let checkoutUrl: string;
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Checkout failed (${res.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const data = (await res.json()) as { checkout_url: string; session_id: string };
    checkoutUrl = data.checkout_url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }

  // Open in browser
  console.log(`\nOpening Stripe Checkout for $${amount.toFixed(2)}...\n`);
  console.log(`  ${checkoutUrl}\n`);
  try {
    const { execSync } = await import("node:child_process");
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${openCmd} "${checkoutUrl}"`, { stdio: "ignore" });
  } catch {
    console.log("Could not open browser. Please visit the URL above to complete payment.");
  }

  // Poll for deposit confirmation (120s max, 3s intervals)
  console.log("Waiting for payment confirmation...");
  const startBalance = await getBalanceAmount(relayUrl, motebitId, headers);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    const currentBalance = await getBalanceAmount(relayUrl, motebitId, headers);
    if (currentBalance !== null && startBalance !== null && currentBalance > startBalance) {
      console.log(`\nDeposit confirmed! Balance: $${currentBalance.toFixed(2)}`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nPayment not yet confirmed. Check `motebit balance` after completing checkout.");
}

async function getBalanceAmount(
  relayUrl: string,
  motebitId: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/balance`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { balance: number };
    return data.balance;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// motebit delegate --plan — multi-agent orchestration via PlanEngine
// ---------------------------------------------------------------------------

async function handleDelegatePlan(
  config: CliConfig,
  motebitId: string,
  prompt: string,
): Promise<void> {
  const relayUrl = getRelayUrl(config);

  // Build auth headers for relay calls
  const authHeaders = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  // Initialize runtime with AI provider for plan decomposition
  const { createProvider, buildToolRegistry, buildStorageAdapters, deriveGovernanceForRuntime } =
    await import("./runtime-factory.js");
  const { MotebitRuntime, NullRenderer, PLANNING_TASK_ROUTER } = await import("@motebit/runtime");
  const { loadFullConfig } = await import("./config.js");

  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  const runtimeRef: { current: InstanceType<typeof MotebitRuntime> | null } = { current: null };
  const provider = createProvider(config);
  const registry = buildToolRegistry(config, runtimeRef, motebitId);
  const storage = buildStorageAdapters(moteDb);
  const governance = deriveGovernanceForRuntime(loadFullConfig().governance);

  const runtime = new MotebitRuntime(
    {
      motebitId,
      policy: {
        maxRiskLevel: governance.policyApproval.maxRiskLevel,
        requireApprovalAbove: governance.policyApproval.requireApprovalAbove,
        denyAbove: governance.policyApproval.denyAbove,
        budget: governance.policyBudget,
      },
      memoryGovernance: governance.memoryGovernance,
      taskRouter: PLANNING_TASK_ROUTER,
    },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  runtimeRef.current = runtime;
  await runtime.init();
  runtime.setProvider(provider);

  // HTTP-polling delegation adapter (no WebSocket needed for one-shot)
  // HTTP-polling delegation adapter with retry logic matching RelayDelegationAdapter
  const MAX_RETRIES = 2;
  const httpDelegationAdapter: StepDelegationAdapter = {
    async delegateStep(
      step: PlanStep,
      timeoutMs: number,
      onTaskSubmitted?: (taskId: string) => void,
    ): Promise<DelegatedStepResult> {
      const excludeAgents: string[] = [];
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await attemptDelegation(
            step,
            timeoutMs,
            excludeAgents,
            attempt === 0 ? onTaskSubmitted : undefined,
          );
          return result;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Extract failed agent ID from receipt if available
          const failedId = (lastError as { failedAgentId?: string }).failedAgentId;
          if (failedId) excludeAgents.push(failedId);
          // Don't retry non-retryable errors (submission failures, payment required)
          if (
            lastError.message.includes("Relay task submission failed") ||
            lastError.message.includes("HTTP 402")
          ) {
            break;
          }
          if (attempt < MAX_RETRIES) {
            console.log(
              `  ↻ Retrying step "${step.description}" (attempt ${attempt + 2}/${MAX_RETRIES + 1})`,
            );
          }
        }
      }
      throw new Error(
        `Delegation failed after ${Math.min(excludeAgents.length, MAX_RETRIES) + 1} attempt(s): ${lastError?.message ?? "unknown"}`,
        { cause: lastError },
      );
    },
  };

  async function attemptDelegation(
    step: PlanStep,
    timeoutMs: number,
    excludeAgents: string[],
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const body: Record<string, unknown> = {
      prompt: step.prompt,
      submitted_by: motebitId,
      required_capabilities: step.required_capabilities,
      step_id: step.step_id,
      routing_strategy: config.routingStrategy,
    };
    if (excludeAgents.length > 0) body.exclude_agents = excludeAgents;

    const resp = await fetch(`${relayUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });

    if (resp.status === 402) throw new Error("Insufficient balance (HTTP 402)");
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Relay task submission failed (${resp.status}): ${text.slice(0, 200)}`);
    }

    const taskResp = (await resp.json()) as { task_id: string };
    const taskId = taskResp.task_id;
    onTaskSubmitted?.(taskId);

    // Poll for result
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      try {
        const pollResp = await fetch(`${relayUrl}/agent/${motebitId}/task/${taskId}`, {
          headers: authHeaders,
        });
        if (!pollResp.ok) continue;
        const data = (await pollResp.json()) as {
          receipt: ExecutionReceipt | null;
        };
        if (data.receipt) {
          if (data.receipt.status !== "completed") {
            const err = new Error(`Delegated step ${data.receipt.status}: ${data.receipt.result}`);
            (err as { failedAgentId?: string }).failedAgentId = data.receipt.motebit_id;
            throw err;
          }
          return {
            step_id: step.step_id,
            task_id: taskId,
            receipt: data.receipt,
            result_text: data.receipt.result,
          };
        }
      } catch (err) {
        if (err instanceof Error && (err as { failedAgentId?: string }).failedAgentId) throw err;
        // Network error — keep polling
      }
    }
    throw new Error(`Delegation timed out after ${timeoutMs}ms for step "${step.description}"`);
  }

  // Wire delegation: empty local capabilities forces all steps to delegate to the network
  runtime.setLocalCapabilities([]);
  runtime.setDelegationAdapter(httpDelegationAdapter);

  // Execute plan
  const goalId = crypto.randomUUID();
  console.log(`\nDecomposing: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"\n`);

  let stepCount = 0;
  let completedCount = 0;

  try {
    for await (const chunk of runtime.executePlan(goalId, prompt)) {
      switch (chunk.type) {
        case "plan_created":
          stepCount = chunk.steps.length;
          console.log(`Plan: ${chunk.plan.title}`);
          console.log(`  ${stepCount} steps\n`);
          break;

        case "step_started":
          console.log(
            `Step ${chunk.step.ordinal + 1}/${stepCount}: ${chunk.step.description}` +
              (chunk.step.required_capabilities?.length
                ? ` (${chunk.step.required_capabilities.join(", ")})`
                : ""),
          );
          break;

        case "step_delegated":
          console.log(
            `  → Delegated${chunk.routing_choice?.selected_agent ? ` to ${chunk.routing_choice.selected_agent.slice(0, 12)}...` : ""} (task: ${chunk.task_id.slice(0, 12)}...)`,
          );
          break;

        case "step_completed": {
          completedCount++;
          const summary = chunk.step.result_summary ?? "";
          const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
          console.log(`  ✓ ${preview || "completed"}\n`);
          break;
        }

        case "step_failed":
          console.log(`  ✗ ${chunk.error}\n`);
          break;

        case "plan_completed":
          console.log(`\nPlan complete. ${completedCount}/${stepCount} steps executed.`);
          break;

        case "plan_failed":
          console.error(`\nPlan failed: ${chunk.reason}`);
          break;
      }
    }
  } finally {
    runtime.stop();
    moteDb.close();
  }
}

// ---------------------------------------------------------------------------
// motebit delegate "<prompt>" — delegate a task to a worker agent
// ---------------------------------------------------------------------------

export async function handleDelegate(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("Error: no motebit identity found. Run `motebit` first to create an identity.");
    process.exit(1);
  }

  const prompt = config.positionals.slice(1).join(" ");
  if (!prompt) {
    console.error('Usage: motebit delegate "<prompt>" [--capability web_search] [--target <id>]');
    process.exit(1);
  }

  // --plan: multi-agent orchestration via PlanEngine
  if (config.plan) {
    await handleDelegatePlan(config, motebitId, prompt);
    return;
  }

  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config, { aud: "task:submit", json: true });

  const capability = config.capability ?? "web_search";
  let targetMotebitId = config.target;

  // Discover a worker if no target specified
  if (!targetMotebitId) {
    try {
      const maxBudget = config.budget ? parseFloat(config.budget) : 10;
      const discoverRes = await fetch(
        `${relayUrl}/api/v1/market/candidates?capability=${encodeURIComponent(capability)}&max_budget=${maxBudget}&limit=5`,
        { headers },
      );
      if (!discoverRes.ok) {
        const text = await discoverRes.text();
        console.error(`Discovery failed (${discoverRes.status}): ${text.slice(0, 200)}`);
        process.exit(1);
      }
      const discoverData = (await discoverRes.json()) as {
        candidates: Array<{
          motebit_id: string;
          composite: number;
          pricing?: Array<{ capability: string; unit_cost: number }>;
          description?: string;
          selected?: boolean;
        }>;
      };
      const candidates = discoverData.candidates ?? [];
      if (candidates.length === 0) {
        console.error(`No agents found with capability "${capability}". Is a worker running?`);
        process.exit(1);
      }
      const best = candidates.find((c) => c.selected) ?? candidates[0]!;
      targetMotebitId = best.motebit_id;
      const price = best.pricing?.find((p) => p.capability === capability)?.unit_cost;
      console.log(
        `Found worker: ${targetMotebitId.slice(0, 12)}...` +
          (price != null ? ` ($${price.toFixed(4)}/request)` : "") +
          (best.description ? ` — ${best.description}` : ""),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Discovery error: ${msg}`);
      process.exit(1);
    }
  }

  // Submit task
  let taskId: string;
  try {
    console.log(`Delegating to ${targetMotebitId.slice(0, 12)}...`);
    const submitRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        prompt,
        submitted_by: motebitId,
        required_capabilities: [capability],
      }),
    });
    if (submitRes.status === 402) {
      console.error("Insufficient balance. Run `motebit fund <amount>` to deposit.");
      process.exit(1);
    }
    if (!submitRes.ok) {
      const text = await submitRes.text();
      console.error(`Task submission failed (${submitRes.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const submitData = (await submitRes.json()) as { task_id: string };
    taskId = submitData.task_id;
    console.log(`Task submitted: ${taskId.slice(0, 12)}...`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Task submission error: ${msg}`);
    process.exit(1);
  }

  // Poll for result (60s max, 2s intervals)
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 30;
  process.stdout.write("Waiting");

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const pollRes = await fetch(`${relayUrl}/agent/${targetMotebitId}/task/${taskId}`, {
        headers,
      });
      if (!pollRes.ok) {
        process.stdout.write(".");
        continue;
      }
      const pollData = (await pollRes.json()) as {
        task: { status: string };
        receipt: {
          status: string;
          result: string;
          motebit_id: string;
          tools_used?: string[];
          completed_at?: number;
          submitted_at?: number;
        } | null;
      };
      if (pollData.receipt != null) {
        console.log(); // newline after dots
        const r = pollData.receipt;
        if (r.status === "completed") {
          console.log(`\n--- Result ---\n`);
          console.log(r.result);
          console.log();
          if (r.tools_used && r.tools_used.length > 0) {
            console.log(`Tools: ${r.tools_used.join(", ")}`);
          }
          if (r.submitted_at && r.completed_at) {
            const latency = r.completed_at - r.submitted_at;
            console.log(`Latency: ${latency}ms`);
          }
        } else {
          console.log(`Task ${r.status}: ${r.result || "(no result)"}`);
        }
        return;
      }
      process.stdout.write(".");
    } catch {
      process.stdout.write(".");
    }
  }
  console.log("\nTask timed out after 60s. The worker may still be running.");
  console.log(`Check status: curl ${relayUrl}/agent/${targetMotebitId}/task/${taskId}`);
}
